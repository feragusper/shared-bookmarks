// Background service worker — sync of nested Chrome bookmark tree ↔ Firestore
import {
  addBookmark,
  deleteBookmark,
  listBookmarks,
  addFolder,
  deleteFolder,
  listFolders
} from "../firebase/firestore.js";

const CHROME_FOLDER_NAME = "Shared Bookmark Folder";
const POLL_ALARM = "shared-bookmarks-poll";
const POLL_PERIOD_MIN = 0.25; // 15s

chrome.runtime.onInstalled.addListener(() => {
  console.log("Shared Bookmarks installed.");
  ensurePollAlarm();
});

chrome.runtime.onStartup.addListener(() => ensurePollAlarm());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_CURRENT_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      sendResponse({
        url: tab?.url || "",
        title: tab?.title || "",
        favicon: tab?.favIconUrl || ""
      });
    });
    return true;
  }
  if (message.type === "FORCE_SYNC") {
    pullAndReconcile().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

function ensurePollAlarm() {
  chrome.alarms.get(POLL_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN, delayInMinutes: 0 });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pullAndReconcile().catch(err => console.warn("Poll error:", err));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.user || changes.roomId) {
    ensurePollAlarm();
    pullAndReconcile().catch(() => {});
  }
});

// ─── Chrome helpers ─────────────────────────────────────────────────────────

function getNode(id) {
  return new Promise((resolve) => {
    chrome.bookmarks.get(id, (nodes) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(nodes?.[0] || null);
    });
  });
}

function getChildren(id) {
  return new Promise((resolve) =>
    chrome.bookmarks.getChildren(id, (kids) => resolve(kids || []))
  );
}

function getSubTree(id) {
  return new Promise((resolve) =>
    chrome.bookmarks.getSubTree(id, (tree) => resolve(tree?.[0] || null))
  );
}

async function getSharedFolderId(create = false) {
  return new Promise((resolve) => {
    chrome.bookmarks.search({ title: CHROME_FOLDER_NAME }, (results) => {
      const folder = (results || []).find(r => !r.url);
      if (folder) return resolve(folder.id);
      if (!create) return resolve(null);
      chrome.bookmarks.create({ title: CHROME_FOLDER_NAME }, (created) => resolve(created.id));
    });
  });
}

async function getCtx() {
  const { user, roomId } = await chrome.storage.local.get(["user", "roomId"]);
  if (!user?.idToken || !roomId) return null;
  return { user, roomId };
}

/**
 * Returns array of folder names from the shared root down to (and including) this node,
 * or null if the node is not inside the shared subtree.
 * For shared folder itself returns [].
 */
async function pathOf(nodeId) {
  const sharedId = await getSharedFolderId();
  if (!sharedId) return null;
  if (nodeId === sharedId) return [];

  const titles = [];
  let cur = await getNode(nodeId);
  if (!cur) return null;
  titles.unshift(cur.title);
  while (cur && cur.parentId) {
    if (cur.parentId === sharedId) return titles;
    cur = await getNode(cur.parentId);
    if (!cur) return null;
    titles.unshift(cur.title);
  }
  return null;
}

function joinPath(parts) { return (parts || []).join("/"); }

// ─── Recursive walk of the local shared subtree ─────────────────────────────

async function walkSharedTree() {
  const sharedId = await getSharedFolderId();
  if (!sharedId) return { folders: [], bookmarks: [] };
  const tree = await getSubTree(sharedId);
  const folders = []; // [{ path: "a/b", name: "b", id }]
  const bookmarks = []; // [{ url, title, parentPath: "a/b", id }]

  function recur(node, parentParts) {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.url) {
        bookmarks.push({
          url: child.url,
          title: child.title || child.url,
          parentPath: joinPath(parentParts),
          id: child.id
        });
      } else {
        const myParts = [...parentParts, child.title];
        folders.push({
          path: joinPath(myParts),
          name: child.title,
          id: child.id
        });
        recur(child, myParts);
      }
    }
  }
  recur(tree, []);
  return { folders, bookmarks };
}

// ─── Push: create local folder hierarchy from a list of folder paths ────────

async function ensureLocalFolderPath(pathStr) {
  const sharedId = await getSharedFolderId(true);
  if (!pathStr) return sharedId;
  const parts = pathStr.split("/").filter(Boolean);
  let parentId = sharedId;
  for (const name of parts) {
    const kids = await getChildren(parentId);
    let match = kids.find(k => !k.url && k.title === name);
    if (!match) {
      match = await new Promise(r =>
        chrome.bookmarks.create({ parentId, title: name }, r)
      );
    }
    parentId = match.id;
  }
  return parentId;
}

// ─── Pull + reconcile ───────────────────────────────────────────────────────

let pulling = false;

async function pullAndReconcile() {
  if (pulling) return;
  pulling = true;
  try {
    const ctx = await getCtx();
    if (!ctx) return;

    await getSharedFolderId(true);

    const [remoteBookmarks, remoteFolders, local] = await Promise.all([
      listBookmarks(ctx.roomId, ctx.user.idToken),
      listFolders(ctx.roomId, ctx.user.idToken),
      walkSharedTree()
    ]);

    // 1) Ensure remote folders exist locally (shortest path first)
    const sortedFolders = [...remoteFolders].sort((a, b) => (a.path || "").length - (b.path || "").length);
    for (const f of sortedFolders) {
      if (!f.path) continue;
      await ensureLocalFolderPath(f.path);
    }

    // Re-walk local after folder creation
    const localAfterFolders = await walkSharedTree();
    const localBookmarkKey = (b) => `${b.parentPath}|${b.url}`;
    const localByKey = new Map(localAfterFolders.bookmarks.map(b => [localBookmarkKey(b), b]));

    // 2) Ensure remote bookmarks exist locally
    for (const rb of remoteBookmarks) {
      const key = `${rb.path || ""}|${rb.url}`;
      if (localByKey.has(key)) continue;
      const parentId = await ensureLocalFolderPath(rb.path || "");
      await new Promise(r => chrome.bookmarks.create(
        { parentId, title: rb.title || rb.url, url: rb.url }, r
      )).catch(() => {});
    }

    // 3) Re-read local once more for cleanup phase
    const finalLocal = await walkSharedTree();

    const remoteBookmarkKeys = new Set(remoteBookmarks.map(b => `${b.path || ""}|${b.url}`));
    const remoteFolderPaths = new Set(remoteFolders.map(f => f.path).filter(Boolean));

    const { lastSyncedKeys = [], lastSyncedFolderPaths = [] } =
      await chrome.storage.local.get(["lastSyncedKeys", "lastSyncedFolderPaths"]);
    const lastSyncedKeySet = new Set(lastSyncedKeys);
    const lastSyncedFolderSet = new Set(lastSyncedFolderPaths);

    // 4a) Local bookmarks not in remote: if previously synced -> remote-deleted -> remove locally
    for (const lb of finalLocal.bookmarks) {
      const key = localBookmarkKey(lb);
      if (remoteBookmarkKeys.has(key)) continue;
      if (lastSyncedKeySet.has(key)) {
        await new Promise(r => chrome.bookmarks.remove(lb.id, r)).catch(() => {});
      }
      // else: user added locally — onCreated/walk-push will handle
    }

    // 4b) Local folders not in remote: if previously synced -> remove locally (recursive)
    for (const lf of finalLocal.folders) {
      if (remoteFolderPaths.has(lf.path)) continue;
      if (lastSyncedFolderSet.has(lf.path)) {
        await new Promise(r => chrome.bookmarks.removeTree(lf.id, r)).catch(() => {});
      }
    }

    // 5) Push local-only items to remote
    const local2 = await walkSharedTree();

    for (const lf of local2.folders) {
      if (!remoteFolderPaths.has(lf.path) && !lastSyncedFolderSet.has(lf.path)) {
        try {
          await addFolder(ctx.roomId, {
            path: lf.path,
            name: lf.name,
            createdBy: ctx.user.uid
          }, ctx.user.idToken);
          remoteFolderPaths.add(lf.path);
        } catch (err) { console.warn("addFolder failed:", err); }
      }
    }

    for (const lb of local2.bookmarks) {
      const key = localBookmarkKey(lb);
      if (remoteBookmarkKeys.has(key) || lastSyncedKeySet.has(key)) continue;
      try {
        await addBookmark(ctx.roomId, {
          url: lb.url,
          title: lb.title,
          favicon: "",
          path: lb.parentPath || "",
          addedBy: ctx.user.uid,
          addedByName: ctx.user.displayName || "",
          tags: []
        }, ctx.user.idToken);
        remoteBookmarkKeys.add(key);
      } catch (err) { console.warn("addBookmark failed:", err); }
    }

    // 6) Persist new sync state
    await chrome.storage.local.set({
      lastSyncedKeys: [...remoteBookmarkKeys],
      lastSyncedFolderPaths: [...remoteFolderPaths]
    });
  } catch (err) {
    console.warn("pullAndReconcile error:", err);
  } finally {
    pulling = false;
  }
}

// ─── Local bookmark events: incremental push ────────────────────────────────

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  const path = await pathOf(id);
  if (path === null) return; // outside shared subtree
  const ctx = await getCtx();
  if (!ctx) return;

  try {
    if (node.url) {
      // It's a bookmark — parent's path is path without the leaf (but pathOf returned [...parents, node.title? no, for URL the title isn't a folder]).
      // For URL nodes, pathOf returns: parents... + node.title at the end. We don't want title in path. Strip last.
      const parentPathParts = path.slice(0, -1);
      const parentPath = joinPath(parentPathParts);
      await addBookmark(ctx.roomId, {
        url: node.url,
        title: node.title || node.url,
        favicon: "",
        path: parentPath,
        addedBy: ctx.user.uid,
        addedByName: ctx.user.displayName || "",
        tags: []
      }, ctx.user.idToken);

      const { lastSyncedKeys = [] } = await chrome.storage.local.get("lastSyncedKeys");
      const set = new Set(lastSyncedKeys);
      set.add(`${parentPath}|${node.url}`);
      await chrome.storage.local.set({ lastSyncedKeys: [...set] });
    } else {
      // It's a folder
      const folderPath = joinPath(path);
      await addFolder(ctx.roomId, {
        path: folderPath,
        name: node.title || "",
        createdBy: ctx.user.uid
      }, ctx.user.idToken);

      const { lastSyncedFolderPaths = [] } = await chrome.storage.local.get("lastSyncedFolderPaths");
      const set = new Set(lastSyncedFolderPaths);
      set.add(folderPath);
      await chrome.storage.local.set({ lastSyncedFolderPaths: [...set] });
    }
  } catch (err) {
    console.warn("BG onCreated push failed:", err);
  }
});

chrome.bookmarks.onRemoved.addListener(async (_id, info) => {
  const node = info?.node;
  if (!node) return;

  // Was the parent inside the shared subtree?
  const parentPath = await pathOf(info.parentId);
  if (parentPath === null && info.parentId !== (await getSharedFolderId())) return;

  const ctx = await getCtx();
  if (!ctx) return;

  try {
    if (node.url) {
      const parentPathStr = info.parentId === (await getSharedFolderId()) ? "" : joinPath(parentPath || []);
      const remoteBookmarks = await listBookmarks(ctx.roomId, ctx.user.idToken);
      const match = remoteBookmarks.find(b => b.url === node.url && (b.path || "") === parentPathStr);
      if (match?._id) await deleteBookmark(ctx.roomId, match._id, ctx.user.idToken);

      const { lastSyncedKeys = [] } = await chrome.storage.local.get("lastSyncedKeys");
      const set = new Set(lastSyncedKeys);
      set.delete(`${parentPathStr}|${node.url}`);
      await chrome.storage.local.set({ lastSyncedKeys: [...set] });
    } else {
      // Folder removed — figure out its path from info.node walk by reconstructing through parent path + title
      const parentPathStr = info.parentId === (await getSharedFolderId()) ? "" : joinPath(parentPath || []);
      const folderPath = parentPathStr ? `${parentPathStr}/${node.title}` : node.title;

      const remoteFolders = await listFolders(ctx.roomId, ctx.user.idToken);
      const remoteBookmarks = await listBookmarks(ctx.roomId, ctx.user.idToken);

      // Delete this folder and any descendants (folders + bookmarks under this path)
      const prefix = folderPath + "/";
      const toDeleteFolders = remoteFolders.filter(f => f.path === folderPath || (f.path || "").startsWith(prefix));
      for (const f of toDeleteFolders) {
        try { await deleteFolder(ctx.roomId, f._id, ctx.user.idToken); } catch (_) {}
      }
      const toDeleteBookmarks = remoteBookmarks.filter(b => (b.path || "") === folderPath || (b.path || "").startsWith(prefix));
      for (const b of toDeleteBookmarks) {
        try { await deleteBookmark(ctx.roomId, b._id, ctx.user.idToken); } catch (_) {}
      }

      // Update synced sets
      const stored = await chrome.storage.local.get(["lastSyncedKeys", "lastSyncedFolderPaths"]);
      const folderSet = new Set(stored.lastSyncedFolderPaths || []);
      for (const f of toDeleteFolders) folderSet.delete(f.path);
      const keySet = new Set(stored.lastSyncedKeys || []);
      for (const b of toDeleteBookmarks) keySet.delete(`${b.path || ""}|${b.url}`);
      await chrome.storage.local.set({
        lastSyncedKeys: [...keySet],
        lastSyncedFolderPaths: [...folderSet]
      });
    }
  } catch (err) {
    console.warn("BG onRemoved push failed:", err);
  }
});

chrome.bookmarks.onChanged.addListener(async (id, _changeInfo) => {
  const path = await pathOf(id);
  if (path === null) return;
  // Easiest: trigger full reconcile — handles renames by add+remove behavior loosely
  pullAndReconcile().catch(() => {});
});

chrome.bookmarks.onMoved.addListener(async (id, _info) => {
  const path = await pathOf(id);
  // Either moved into or within shared subtree -> reconcile to fix paths
  if (path !== null) pullAndReconcile().catch(() => {});
});


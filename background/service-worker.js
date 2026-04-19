// ─────────────────────────────────────────────────────────────────────────────
// service-worker.js — MV3 I/O shell over background/sync-core.js
//
// Responsibilities:
//   - listen to chrome.bookmarks.* events and push deltas to Firestore
//   - poll Firestore via chrome.alarms and reconcile the local tree
//   - persist bookkeeping state (lastSynced sets, lock, recently-applied)
//   - suppress echoes between local creates triggered by reconcile and the
//     onCreated listener that fires for them
//   - refresh the Firebase ID token transparently on 401
// ─────────────────────────────────────────────────────────────────────────────

import {
  addBookmark,
  deleteBookmark,
  listBookmarks,
  addFolder,
  deleteFolder,
  listFolders,
  refreshIdToken
} from "../firebase/firestore.js";

import {
  walkTreeToEntities,
  planReconcile,
  bookmarkKey,
  folderKey,
  joinSegments,
  encodeSegment,
  splitPath,
  pruneExpired
} from "./sync-core.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHROME_FOLDER_NAME = "Shared Bookmark Folder";
const POLL_ALARM = "shared-bookmarks-poll";
const POLL_PERIOD_MIN = 0.5;          // 30 s
const RECONCILE_LOCK_TTL_MS = 30_000; // 30 s — short enough that crashed runs auto-recover
const ECHO_TTL_MS = 60_000;

console.log("[SW] service-worker.js loaded at", new Date().toISOString());

// ─── Alarm registration (idempotent, runs on every SW wake) ────────────────

function ensurePollAlarm() {
  // chrome.alarms.create is fully synchronous and idempotent: re-creating
  // with the same name replaces the previous one. Safe to call on every wake.
  chrome.alarms.create(POLL_ALARM, {
    periodInMinutes: POLL_PERIOD_MIN,
    delayInMinutes: 0.1
  });
  console.log("[SW] alarm scheduled, period=", POLL_PERIOD_MIN, "min");
}

// IMPORTANT: call at top level so the alarm is guaranteed to exist on every
// SW wake, not only on install/startup events (which can be missed).
ensurePollAlarm();

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[SW] onInstalled:", details.reason);
  ensurePollAlarm();
  pullAndReconcile().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[SW] onStartup");
  ensurePollAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    console.log("[SW] alarm fired");
    pullAndReconcile().catch(err => console.warn("[SW] poll error:", err));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CURRENT_TAB") {
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
  if (message?.type === "FORCE_SYNC") {
    console.log("[SW] FORCE_SYNC requested");
    // Clear any stale lock first so manual sync always runs.
    chrome.storage.local.remove("reconcileLock")
      .then(() => pullAndReconcile())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.warn("[SW] FORCE_SYNC failed:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }
  if (message?.type === "SW_PING") {
    sendResponse({ ok: true, at: Date.now() });
    return true;
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.user || changes.roomId) {
    ensurePollAlarm();
    if (changes.roomId) {
      console.log("[SW] roomId changed, switching to seed mode");
      await chrome.storage.local.set({
        lastSyncedKeys: [],
        lastSyncedFolderPaths: [],
        seedFromRemote: true
      });
    }
    pullAndReconcile().catch(() => {});
  }
});

// ─── Chrome API promise wrappers ────────────────────────────────────────────

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

function bmCreate(args) {
  return new Promise((resolve, reject) =>
    chrome.bookmarks.create(args, (node) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(node);
    })
  );
}

function bmRemove(id) {
  return new Promise((resolve) => chrome.bookmarks.remove(id, () => resolve()));
}

function bmRemoveTree(id) {
  return new Promise((resolve) => chrome.bookmarks.removeTree(id, () => resolve()));
}

// ─── Shared folder & paths ──────────────────────────────────────────────────

async function getSharedFolderId(create = false) {
  const { sharedFolderId } = await chrome.storage.local.get("sharedFolderId");
  if (sharedFolderId) {
    const node = await getNode(sharedFolderId);
    if (node && !node.url) return sharedFolderId;
  }
  const found = await new Promise((resolve) =>
    chrome.bookmarks.search({ title: CHROME_FOLDER_NAME }, (results) =>
      resolve((results || []).find(r => !r.url) || null)
    )
  );
  if (found) {
    await chrome.storage.local.set({ sharedFolderId: found.id });
    return found.id;
  }
  if (!create) return null;
  const created = await bmCreate({ title: CHROME_FOLDER_NAME });
  await chrome.storage.local.set({ sharedFolderId: created.id });
  return created.id;
}

async function getCtx() {
  const { user, roomId } = await chrome.storage.local.get(["user", "roomId"]);
  if (!user?.idToken || !roomId) return null;
  return { user, roomId };
}

async function pathOfNode(nodeId) {
  const sharedId = await getSharedFolderId();
  if (!sharedId) return null;
  if (nodeId === sharedId) return "";
  const node = await getNode(nodeId);
  if (!node) return null;

  const segments = [];
  let cur = node;
  if (!cur.url) segments.unshift(cur.title || "");
  while (cur && cur.parentId) {
    if (cur.parentId === sharedId) return joinSegments(segments);
    cur = await getNode(cur.parentId);
    if (!cur) return null;
    segments.unshift(cur.title || "");
  }
  return null;
}

async function parentPathOfNode(parentId) {
  const sharedId = await getSharedFolderId();
  if (!sharedId) return null;
  if (parentId === sharedId) return "";
  return pathOfNode(parentId);
}

// ─── Token refresh ──────────────────────────────────────────────────────────

function isAuthError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("401") || msg.includes("unauthenticated") ||
         msg.includes("invalid_token") || msg.includes("expired") ||
         msg.includes("invalid id token");
}

async function refreshUserToken() {
  const { user } = await chrome.storage.local.get("user");
  if (!user?.refreshToken) throw new Error("No refresh token");
  const fresh = await refreshIdToken(user.refreshToken);
  const newUser = { ...user, idToken: fresh.idToken, refreshToken: fresh.refreshToken };
  await chrome.storage.local.set({ user: newUser });
  console.log("[SW] refreshed Firebase ID token");
  return newUser;
}

/** Execute fn(user) with current token; on auth failure, refresh and retry once. */
async function withAuth(fn) {
  let { user } = await chrome.storage.local.get("user");
  if (!user?.idToken) throw new Error("Not authenticated");
  try {
    return await fn(user);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    user = await refreshUserToken();
    return fn(user);
  }
}

// ─── Echo suppression ───────────────────────────────────────────────────────

const inMemoryRecentlyApplied = new Set();

async function markEcho(key) {
  const now = Date.now();
  const { recentlyApplied = {} } = await chrome.storage.local.get("recentlyApplied");
  const pruned = pruneExpired(recentlyApplied, now, ECHO_TTL_MS);
  pruned[key] = now;
  await chrome.storage.local.set({ recentlyApplied: pruned });
}

async function isEcho(key) {
  const { recentlyApplied = {} } = await chrome.storage.local.get("recentlyApplied");
  const t = recentlyApplied[key];
  return typeof t === "number" && Date.now() - t < ECHO_TTL_MS;
}

async function isEchoNode(nodeId) {
  if (inMemoryRecentlyApplied.has(nodeId)) {
    inMemoryRecentlyApplied.delete(nodeId);
    return true;
  }
  return isEcho(`node:${nodeId}`);
}

// ─── Reconcile lock ─────────────────────────────────────────────────────────

async function tryAcquireLock() {
  const now = Date.now();
  const { reconcileLock = 0 } = await chrome.storage.local.get("reconcileLock");
  if (reconcileLock && now - reconcileLock < RECONCILE_LOCK_TTL_MS) return false;
  await chrome.storage.local.set({ reconcileLock: now });
  return true;
}
async function releaseLock() { await chrome.storage.local.remove("reconcileLock"); }
async function isLocked() {
  const now = Date.now();
  const { reconcileLock = 0 } = await chrome.storage.local.get("reconcileLock");
  return reconcileLock && now - reconcileLock < RECONCILE_LOCK_TTL_MS;
}
async function setDirty() { await chrome.storage.local.set({ reconcileDirty: true }); }
async function consumeDirty() {
  const { reconcileDirty } = await chrome.storage.local.get("reconcileDirty");
  if (reconcileDirty) {
    await chrome.storage.local.remove("reconcileDirty");
    return true;
  }
  return false;
}

// ─── Local folder ensure path ───────────────────────────────────────────────

async function ensureLocalFolderPath(pathStr) {
  const sharedId = await getSharedFolderId(true);
  if (!pathStr) return sharedId;
  const segments = splitPath(pathStr);
  let parentId = sharedId;
  let cumulative = [];
  for (const segment of segments) {
    cumulative.push(segment);
    const kids = await getChildren(parentId);
    let match = kids.find(k => !k.url && (k.title || "") === segment);
    if (!match) {
      match = await bmCreate({ parentId, title: segment });
      const builtPath = joinSegments(cumulative);
      await markEcho(`folder:${builtPath}`);
      await markEcho(`node:${match.id}`);
      inMemoryRecentlyApplied.add(match.id);
    }
    parentId = match.id;
  }
  return parentId;
}

// ─── Pull + reconcile (the core loop) ───────────────────────────────────────

async function pullAndReconcile() {
  if (!(await tryAcquireLock())) {
    console.log("[SW] reconcile already running, marking dirty");
    await setDirty();
    return;
  }
  try {
    let runAgain = true;
    let iterations = 0;
    while (runAgain && iterations < 3) {
      iterations++;
      runAgain = false;
      await runOneReconcileIteration();
      if (await consumeDirty()) runAgain = true;
    }
  } catch (err) {
    console.warn("[SW] pullAndReconcile error:", err);
  } finally {
    await releaseLock();
  }
}

async function runOneReconcileIteration() {
  const ctx = await getCtx();
  if (!ctx) {
    console.log("[SW] reconcile skipped: no auth or no room");
    return;
  }

  const sharedId = await getSharedFolderId(true);

  let remoteBookmarks, remoteFolders;
  try {
    [remoteBookmarks, remoteFolders] = await withAuth(async (user) => {
      return Promise.all([
        listBookmarks(ctx.roomId, user.idToken),
        listFolders(ctx.roomId, user.idToken)
      ]);
    });
  } catch (err) {
    console.warn("[SW] failed to fetch remote state:", err);
    return;
  }

  const subtree = await getSubTree(sharedId);
  const { folders: localFolders, bookmarks: localBookmarks } = walkTreeToEntities(subtree);

  const stored = await chrome.storage.local.get([
    "lastSyncedKeys",
    "lastSyncedFolderPaths",
    "seedFromRemote"
  ]);
  const mode = stored.seedFromRemote ? "seed-from-remote" : "normal";

  const plan = planReconcile({
    remoteBookmarks,
    remoteFolders,
    localBookmarks,
    localFolders,
    lastSyncedKeys: stored.lastSyncedKeys || [],
    lastSyncedFolderPaths: stored.lastSyncedFolderPaths || [],
    mode
  });

  console.log("[SW] reconcile mode=", mode,
    "remote(b=", remoteBookmarks.length, ", f=", remoteFolders.length, ")",
    "local(b=", localBookmarks.length, ", f=", localFolders.length, ")",
    "plan: +Lf=", plan.folder.foldersToCreateLocal.length,
    "+Lb=", plan.bookmark.bookmarksToCreateLocal.length,
    "-Lb=", plan.bookmark.bookmarksToDeleteLocal.length,
    "-Lf=", plan.folder.foldersToDeleteLocal.length,
    "+Rf=", plan.folder.foldersToCreateRemote.length,
    "+Rb=", plan.bookmark.bookmarksToCreateRemote.length,
    "-Rb=", plan.bookmark.bookmarksToDeleteRemote.length,
    "-Rf=", plan.folder.foldersToDeleteRemote.length
  );

  // 1. Local folder creates
  for (const f of plan.folder.foldersToCreateLocal) {
    await ensureLocalFolderPath(f.path);
  }

  const subtree2 = await getSubTree(sharedId);
  const folderByPath = new Map();
  walkTreeToEntities(subtree2).folders.forEach(f => folderByPath.set(f.path, f.id));
  folderByPath.set("", sharedId);

  // 2. Local bookmark creates
  for (const b of plan.bookmark.bookmarksToCreateLocal) {
    const parentId = folderByPath.get(b.path) || (await ensureLocalFolderPath(b.path));
    try {
      const node = await bmCreate({ parentId, title: b.title || b.url, url: b.url });
      await markEcho(`bookmark:${bookmarkKey(b)}`);
      await markEcho(`node:${node.id}`);
      inMemoryRecentlyApplied.add(node.id);
    } catch (_) {}
  }

  // 3. Local bookmark deletes
  for (const b of plan.bookmark.bookmarksToDeleteLocal) {
    if (!b.localId) continue;
    await markEcho(`bookmark:${bookmarkKey(b)}`);
    await markEcho(`node:${b.localId}`);
    inMemoryRecentlyApplied.add(b.localId);
    await bmRemove(b.localId);
  }

  // 4. Local folder deletes (longest-first)
  for (const f of plan.folder.foldersToDeleteLocal) {
    if (!f.localId) continue;
    await markEcho(`folder:${folderKey(f)}`);
    await markEcho(`node:${f.localId}`);
    inMemoryRecentlyApplied.add(f.localId);
    await bmRemoveTree(f.localId);
  }

  // 5/6/7/8. Remote ops with incremental persistence + token refresh
  const newSyncedFolders = new Set(plan.folder.newLastSyncedFolderPaths);
  const newSyncedKeys = new Set(plan.bookmark.newLastSyncedKeys);

  for (const f of plan.folder.foldersToCreateRemote) {
    try {
      await withAuth((user) => addFolder(ctx.roomId, { path: f.path, name: f.name, createdBy: user.uid }, user.idToken));
      newSyncedFolders.add(f.path);
      await persistSets(newSyncedKeys, newSyncedFolders);
    } catch (e) { console.warn("[SW] addFolder failed:", e); }
  }

  for (const b of plan.bookmark.bookmarksToCreateRemote) {
    try {
      await withAuth((user) => addBookmark(ctx.roomId, {
        url: b.url,
        title: b.title || b.url,
        favicon: "",
        path: b.path || "",
        addedBy: user.uid,
        addedByName: user.displayName || "",
        tags: []
      }, user.idToken));
      newSyncedKeys.add(bookmarkKey(b));
      await persistSets(newSyncedKeys, newSyncedFolders);
    } catch (e) { console.warn("[SW] addBookmark failed:", e); }
  }

  for (const b of plan.bookmark.bookmarksToDeleteRemote) {
    if (!b._id) continue;
    try {
      await withAuth((user) => deleteBookmark(ctx.roomId, b._id, user.idToken));
      newSyncedKeys.delete(bookmarkKey(b));
      await persistSets(newSyncedKeys, newSyncedFolders);
    } catch (e) { console.warn("[SW] deleteBookmark failed:", e); }
  }

  for (const f of plan.folder.foldersToDeleteRemote) {
    if (!f._id) continue;
    try {
      await withAuth((user) => deleteFolder(ctx.roomId, f._id, user.idToken));
      newSyncedFolders.delete(f.path);
      await persistSets(newSyncedKeys, newSyncedFolders);
    } catch (e) { console.warn("[SW] deleteFolder failed:", e); }
  }

  await persistSets(newSyncedKeys, newSyncedFolders);
  if (mode === "seed-from-remote") await chrome.storage.local.remove("seedFromRemote");
}

async function persistSets(keysSet, foldersSet) {
  await chrome.storage.local.set({
    lastSyncedKeys: [...keysSet],
    lastSyncedFolderPaths: [...foldersSet]
  });
}

// ─── Listener push helpers ──────────────────────────────────────────────────

async function pushBookmarkAdd(parentPath, node) {
  const ctx = await getCtx();
  if (!ctx) return;
  const key = `${parentPath}|${node.url}`;
  if (await isEcho(`bookmark:${key}`) || await isEchoNode(node.id)) return;

  const { lastSyncedKeys = [] } = await chrome.storage.local.get("lastSyncedKeys");
  if (lastSyncedKeys.includes(key)) return;

  try {
    await withAuth((user) => addBookmark(ctx.roomId, {
      url: node.url,
      title: node.title || node.url,
      favicon: "",
      path: parentPath,
      addedBy: user.uid,
      addedByName: user.displayName || "",
      tags: []
    }, user.idToken));
    const set = new Set(lastSyncedKeys);
    set.add(key);
    await chrome.storage.local.set({ lastSyncedKeys: [...set] });
  } catch (e) { console.warn("[SW] pushBookmarkAdd failed:", e); }
}

async function pushFolderAdd(folderPath, node) {
  const ctx = await getCtx();
  if (!ctx) return;
  if (!folderPath) return;
  if (await isEcho(`folder:${folderPath}`) || await isEchoNode(node.id)) return;

  const { lastSyncedFolderPaths = [] } = await chrome.storage.local.get("lastSyncedFolderPaths");
  if (lastSyncedFolderPaths.includes(folderPath)) return;

  try {
    await withAuth((user) => addFolder(ctx.roomId, {
      path: folderPath,
      name: node.title || "",
      createdBy: user.uid
    }, user.idToken));
    const set = new Set(lastSyncedFolderPaths);
    set.add(folderPath);
    await chrome.storage.local.set({ lastSyncedFolderPaths: [...set] });
  } catch (e) { console.warn("[SW] pushFolderAdd failed:", e); }
}

async function pushBookmarkDelete(parentPath, node) {
  const ctx = await getCtx();
  if (!ctx) return;
  const key = `${parentPath}|${node.url}`;
  if (await isEcho(`bookmark:${key}`)) return;

  try {
    const remote = await withAuth((user) => listBookmarks(ctx.roomId, user.idToken));
    const matches = remote.filter(b => b.url === node.url && (b.path || "") === parentPath);
    for (const m of matches) {
      if (m._id) await withAuth((user) => deleteBookmark(ctx.roomId, m._id, user.idToken));
    }
    const { lastSyncedKeys = [] } = await chrome.storage.local.get("lastSyncedKeys");
    const set = new Set(lastSyncedKeys);
    set.delete(key);
    await chrome.storage.local.set({ lastSyncedKeys: [...set] });
  } catch (e) { console.warn("[SW] pushBookmarkDelete failed:", e); }
}

async function pushFolderDelete(folderPath) {
  const ctx = await getCtx();
  if (!ctx) return;
  if (!folderPath) return;
  if (await isEcho(`folder:${folderPath}`)) return;

  try {
    const [folders, bookmarks] = await withAuth((user) => Promise.all([
      listFolders(ctx.roomId, user.idToken),
      listBookmarks(ctx.roomId, user.idToken)
    ]));
    const prefix = folderPath + "/";
    const fDel = folders.filter(f => f.path === folderPath || (f.path || "").startsWith(prefix));
    const bDel = bookmarks.filter(b => (b.path || "") === folderPath || (b.path || "").startsWith(prefix));

    for (const b of bDel) if (b._id) await withAuth((user) => deleteBookmark(ctx.roomId, b._id, user.idToken)).catch(() => {});
    for (const f of fDel) if (f._id) await withAuth((user) => deleteFolder(ctx.roomId, f._id, user.idToken)).catch(() => {});

    const stored = await chrome.storage.local.get(["lastSyncedKeys", "lastSyncedFolderPaths"]);
    const keySet = new Set(stored.lastSyncedKeys || []);
    const folderSet = new Set(stored.lastSyncedFolderPaths || []);
    for (const f of fDel) folderSet.delete(f.path);
    for (const b of bDel) keySet.delete(`${b.path || ""}|${b.url}`);
    await chrome.storage.local.set({
      lastSyncedKeys: [...keySet],
      lastSyncedFolderPaths: [...folderSet]
    });
  } catch (e) { console.warn("[SW] pushFolderDelete failed:", e); }
}

// ─── Bookmark event listeners ───────────────────────────────────────────────

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  try {
    if (await isLocked()) { await setDirty(); return; }
    if (await isEchoNode(id)) return;

    const sharedId = await getSharedFolderId();
    if (!sharedId) return;

    if (node.url) {
      const parentPath = await parentPathOfNode(node.parentId);
      if (parentPath === null) return;
      await pushBookmarkAdd(parentPath || "", node);
    } else {
      const folderPath = await pathOfNode(id);
      if (!folderPath) return;
      await pushFolderAdd(folderPath, node);
    }
  } catch (e) { console.warn("[SW] onCreated handler failed:", e); }
});

chrome.bookmarks.onRemoved.addListener(async (id, info) => {
  try {
    if (await isLocked()) { await setDirty(); return; }
    if (await isEchoNode(id)) return;

    const node = info?.node;
    if (!node) return;

    const sharedId = await getSharedFolderId();
    if (!sharedId) return;

    let parentPath = "";
    if (info.parentId !== sharedId) {
      const p = await pathOfNode(info.parentId);
      if (p === null) return;
      parentPath = p;
    }

    if (node.url) {
      await pushBookmarkDelete(parentPath, node);
    } else {
      const folderPath = parentPath
        ? `${parentPath}/${encodeSegment(node.title || "")}`
        : encodeSegment(node.title || "");
      await pushFolderDelete(folderPath);
    }
  } catch (e) { console.warn("[SW] onRemoved handler failed:", e); }
});

chrome.bookmarks.onChanged.addListener(async (id) => {
  try {
    if (await isLocked()) { await setDirty(); return; }
    const path = await pathOfNode(id);
    if (path === null) return;
    pullAndReconcile().catch(() => {});
  } catch (_) {}
});

chrome.bookmarks.onMoved.addListener(async (id) => {
  try {
    if (await isLocked()) { await setDirty(); return; }
    const path = await pathOfNode(id);
    if (path === null) return;
    pullAndReconcile().catch(() => {});
  } catch (_) {}
});


// ─────────────────────────────────────────────────────────────────────────────
// service-worker.js — MV3 I/O shell over background/sync-core.js
//
// Oplog-based sync engine:
//   - On local bookmark events: write ops to Firestore + update tree-state
//   - On pull (FORCE_SYNC / popup open / startup): read partner's pending ops,
//     apply them locally, mark as applied, cleanup
//   - NO polling — all sync is event-driven
//   - Echo suppression by Chrome node ID only
// ─────────────────────────────────────────────────────────────────────────────

import {
  addBookmark,
  deleteBookmark,
  listBookmarks,
  addFolder,
  deleteFolder,
  listFolders,
  writeOp,
  listPendingOps,
  markOpApplied,
  deleteAppliedOps,
  refreshIdToken
} from "../firebase/firestore.js";

import {
  walkTreeToEntities,
  localEventToOps,
  planOpApplication,
  joinSegments,
  encodeSegment,
  splitPath,
  pruneExpired
} from "./sync-core.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHROME_FOLDER_NAME = "Shared Bookmark Folder";
const RECONCILE_LOCK_TTL_MS = 30_000;
const ECHO_TTL_MS = 60_000;

console.log("[SW] service-worker.js loaded at", new Date().toISOString());

// ─── Lifecycle events ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[SW] onInstalled:", details.reason);
  pullAndApplyOps().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[SW] onStartup");
  pullAndApplyOps().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CURRENT_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      sendResponse({ url: tab?.url || "", title: tab?.title || "", favicon: tab?.favIconUrl || "" });
    });
    return true;
  }
  if (message?.type === "FORCE_SYNC") {
    console.log("[SW] FORCE_SYNC requested");
    chrome.storage.local.remove("reconcileLock")
      .then(() => pullAndApplyOps())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        const errMsg = formatSyncError(err);
        console.warn("[SW] FORCE_SYNC failed:", errMsg);
        sendResponse({ ok: false, error: errMsg });
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
    if (changes.roomId) {
      console.log("[SW] roomId changed, will seed on next sync");
    }
    pullAndApplyOps().catch(() => {});
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

// ─── Error classification ───────────────────────────────────────────────────

function isQuotaError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("429") || msg.includes("resource_exhausted") || msg.includes("quota");
}

function isAuthError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (isQuotaError(err)) return false;
  return msg.includes("401") || msg.includes("403") ||
         msg.includes("unauthenticated") || msg.includes("permission_denied") ||
         msg.includes("invalid_token") || msg.includes("expired") ||
         msg.includes("invalid id token");
}

function formatSyncError(err) {
  if (isQuotaError(err)) {
    return "Firebase quota exceeded — daily free-tier limit reached. " +
           "Sync will resume when the quota resets (midnight US/Pacific).";
  }
  if (isAuthError(err)) {
    return "Authentication expired. Please sign out and sign back in.";
  }
  return String(err?.message || err || "Unknown sync error");
}

// ─── Token refresh ──────────────────────────────────────────────────────────

async function refreshUserToken() {
  const { user } = await chrome.storage.local.get("user");
  if (!user?.refreshToken) throw new Error("No refresh token");
  const fresh = await refreshIdToken(user.refreshToken);
  const newUser = { ...user, idToken: fresh.idToken, refreshToken: fresh.refreshToken };
  await chrome.storage.local.set({ user: newUser });
  console.log("[SW] refreshed Firebase ID token");
  return newUser;
}

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

// ─── Echo suppression (by Chrome node ID only) ─────────────────────────────

const echoNodeIds = new Set();

async function markEchoNode(nodeId) {
  echoNodeIds.add(nodeId);
  // Also persist for cross-wake survival
  const now = Date.now();
  const { echoNodes = {} } = await chrome.storage.local.get("echoNodes");
  const pruned = pruneExpired(echoNodes, now, ECHO_TTL_MS);
  pruned[nodeId] = now;
  await chrome.storage.local.set({ echoNodes: pruned });
}

async function isEchoNode(nodeId) {
  if (echoNodeIds.has(nodeId)) {
    echoNodeIds.delete(nodeId);
    return true;
  }
  const { echoNodes = {} } = await chrome.storage.local.get("echoNodes");
  const t = echoNodes[nodeId];
  if (typeof t === "number" && Date.now() - t < ECHO_TTL_MS) {
    // Consume the entry so subsequent events (e.g. user-initiated delete
    // of a node that was created by pull) are NOT suppressed.
    delete echoNodes[nodeId];
    await chrome.storage.local.set({ echoNodes });
    return true;
  }
  return false;
}

// ─── Lock ───────────────────────────────────────────────────────────────────

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
      await markEchoNode(match.id);
    }
    parentId = match.id;
  }
  return parentId;
}

// ─── Push: local event → write op + update tree-state ───────────────────────

async function pushOps(ops) {
  const ctx = await getCtx();
  if (!ctx) return;

  for (const op of ops) {
    try {
      // Write the op to the oplog
      await withAuth((user) => writeOp(ctx.roomId, { ...op, author: user.uid }, user.idToken));

      // Also update the tree-state collections for seeding / display
      const p = op.payload;
      await withAuth(async (user) => {
        switch (op.type) {
          case "ADD_BOOKMARK":
            await addBookmark(ctx.roomId, {
              url: p.url, title: p.title || p.url, favicon: "",
              path: p.path || "", addedBy: user.uid,
              addedByName: user.displayName || "", tags: []
            }, user.idToken);
            break;
          case "DEL_BOOKMARK": {
            const remote = await listBookmarks(ctx.roomId, user.idToken);
            const match = remote.find(b => b.url === p.url && (b.path || "") === (p.path || ""));
            if (match?._id) await deleteBookmark(ctx.roomId, match._id, user.idToken);
            break;
          }
          case "ADD_FOLDER":
            await addFolder(ctx.roomId, { path: p.path, name: p.name || "", createdBy: user.uid }, user.idToken);
            break;
          case "DEL_FOLDER": {
            const folders = await listFolders(ctx.roomId, user.idToken);
            const match = folders.find(f => f.path === p.path);
            if (match?._id) await deleteFolder(ctx.roomId, match._id, user.idToken);
            break;
          }
        }
      });
    } catch (e) {
      console.warn("[SW] pushOp failed:", op.type, formatSyncError(e));
    }
  }
}

// ─── Pull: read partner ops → apply locally → mark applied ─────────────────

async function pullAndApplyOps() {
  if (!(await tryAcquireLock())) {
    console.log("[SW] pull already running, skipping");
    return;
  }
  try {
    const ctx = await getCtx();
    if (!ctx) {
      console.log("[SW] pull skipped: no auth or no room");
      return;
    }

    const sharedId = await getSharedFolderId(true);

    // 1. Fetch pending ops from partner
    let pendingOps;
    try {
      pendingOps = await withAuth((user) =>
        listPendingOps(ctx.roomId, user.uid, user.idToken)
      );
    } catch (err) {
      const friendly = formatSyncError(err);
      console.warn("[SW] failed to fetch ops:", friendly);
      if (isQuotaError(err)) {
        await chrome.storage.local.set({ lastSyncError: friendly });
        throw err;
      }
      return;
    }

    await chrome.storage.local.remove("lastSyncError");

    if (!pendingOps.length) {
      console.log("[SW] no pending ops from partner");
      return;
    }

    console.log("[SW] applying", pendingOps.length, "ops from partner");

    // 2. Get local tree state
    const subtree = await getSubTree(sharedId);
    const localTree = walkTreeToEntities(subtree);

    // 3. Plan mutations
    const mutations = planOpApplication(pendingOps, localTree);

    // 4. Apply each mutation + mark the op as applied
    for (const mut of mutations) {
      try {
        switch (mut.action) {
          case "create_folder": {
            const folderId = await ensureLocalFolderPath(mut.path);
            // The ensureLocalFolderPath already marks echo for created nodes
            break;
          }
          case "create_bookmark": {
            const parentId = await ensureLocalFolderPath(mut.path);
            const node = await bmCreate({ parentId, title: mut.title || mut.url, url: mut.url });
            await markEchoNode(node.id);
            break;
          }
          case "delete_bookmark": {
            await markEchoNode(mut.localId);
            await bmRemove(mut.localId).catch(() => {});
            break;
          }
          case "delete_folder": {
            await markEchoNode(mut.localId);
            await bmRemoveTree(mut.localId).catch(() => {});
            break;
          }
          case "skip":
            console.log("[SW] skip op", mut.opId, ":", mut.reason);
            break;
        }
      } catch (e) {
        console.warn("[SW] failed to apply mutation:", mut.action, e);
      }

      // Mark this op as applied regardless (idempotent)
      if (mut.opId) {
        try {
          await withAuth((user) =>
            markOpApplied(ctx.roomId, mut.opId, user.uid, user.idToken)
          );
        } catch (e) {
          console.warn("[SW] failed to mark op applied:", mut.opId, e);
        }
      }
    }

    // 5. Cleanup applied ops
    try {
      await withAuth((user) => deleteAppliedOps(ctx.roomId, user.idToken));
    } catch (_) { /* best-effort */ }

  } catch (err) {
    console.warn("[SW] pullAndApplyOps error:", err);
  } finally {
    await releaseLock();
  }
}

// ─── Bookmark event listeners ───────────────────────────────────────────────

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  try {
    if (await isLocked()) return;
    if (await isEchoNode(id)) return;

    const sharedId = await getSharedFolderId();
    if (!sharedId) return;

    if (node.url) {
      const parentPath = await parentPathOfNode(node.parentId);
      if (parentPath === null) return;
      const ops = localEventToOps("add_bookmark", {
        url: node.url, title: node.title || node.url, path: parentPath || ""
      });
      await pushOps(ops);
    } else {
      const folderPath = await pathOfNode(id);
      if (!folderPath) return;
      const ops = localEventToOps("add_folder", {
        path: folderPath, name: node.title || ""
      });
      await pushOps(ops);
    }
  } catch (e) { console.warn("[SW] onCreated failed:", e); }
});

chrome.bookmarks.onRemoved.addListener(async (id, info) => {
  try {
    if (await isLocked()) return;
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
      const ops = localEventToOps("del_bookmark", {
        url: node.url, path: parentPath
      });
      await pushOps(ops);
    } else {
      const folderPath = parentPath
        ? `${parentPath}/${encodeSegment(node.title || "")}`
        : encodeSegment(node.title || "");
      const ops = localEventToOps("del_folder", { path: folderPath }, node);
      await pushOps(ops);
    }
  } catch (e) { console.warn("[SW] onRemoved failed:", e); }
});

chrome.bookmarks.onChanged.addListener(async (id) => {
  try {
    if (await isLocked()) return;
    // Title/URL changes: for now, treat as a full resync trigger
    const path = await pathOfNode(id);
    if (path === null) return;
    // Future: could generate RENAME ops
  } catch (_) {}
});

chrome.bookmarks.onMoved.addListener(async (id) => {
  try {
    if (await isLocked()) return;
    // Moves: for now, treat as a full resync trigger
    const path = await pathOfNode(id);
    if (path === null) return;
    // Future: could generate MOVE ops (del from old + add at new)
  } catch (_) {}
});


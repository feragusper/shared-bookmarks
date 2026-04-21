// ─────────────────────────────────────────────────────────────────────────────
// sync-core.js — pure logic for bookmark/folder reconciliation
//
// No `chrome.*`, no `fetch`, no globals. Inputs and outputs are plain objects.
// This module is the single source of truth for "what the sync should do
// given the current state". The service worker is the I/O shell that gathers
// state, calls into this module, and applies the resulting plan.
//
// Identity:
//   - Bookmark identity:    `${path}|${url}`     (folder containing it + URL)
//   - Folder identity:      `${path}`            (slash-separated from shared root)
//
// Path encoding: we percent-encode "/" inside individual segments BEFORE
// joining, so that a folder titled "A/B" doesn't collide with the path
// "A/B" (folder A containing folder B). Decoding happens on the way back
// to a Chrome title.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Path helpers ───────────────────────────────────────────────────────────

export function encodeSegment(segment) {
  return String(segment ?? "").replace(/%/g, "%25").replace(/\//g, "%2F");
}

export function decodeSegment(segment) {
  return String(segment ?? "").replace(/%2F/gi, "/").replace(/%25/g, "%");
}

export function joinSegments(segments) {
  return (segments || []).filter(s => s !== undefined && s !== null && s !== "").map(encodeSegment).join("/");
}

export function splitPath(path) {
  if (!path) return [];
  return String(path).split("/").map(decodeSegment);
}

export function pathDepth(path) {
  if (!path) return 0;
  return String(path).split("/").filter(Boolean).length;
}

export function parentPathOf(path) {
  const parts = String(path || "").split("/");
  parts.pop();
  return parts.join("/");
}

export function joinPath(parent, leafSegment) {
  const enc = encodeSegment(leafSegment);
  if (!parent) return enc;
  if (!enc) return parent;
  return `${parent}/${enc}`;
}

// ─── Identity ───────────────────────────────────────────────────────────────

export function bookmarkKey(b) {
  return `${b.path || ""}|${b.url}`;
}

export function folderKey(f) {
  return f.path || "";
}

// ─── Tree walk (pure) ───────────────────────────────────────────────────────

/**
 * Walk a Chrome bookmark subtree object (already fetched via getSubTree)
 * and produce flat lists of folders and bookmarks with computed paths.
 * @param {object} rootNode  Chrome subtree node with optional .children
 * @returns {{folders: Array, bookmarks: Array}}
 */
export function walkTreeToEntities(rootNode) {
  const folders = [];
  const bookmarks = [];

  function recur(node, parentSegments) {
    const kids = node?.children || [];
    for (const child of kids) {
      if (child.url) {
        bookmarks.push({
          url: child.url,
          title: child.title || child.url,
          path: joinSegments(parentSegments),
          id: child.id
        });
      } else {
        const myParts = [...parentSegments, child.title || ""];
        folders.push({
          path: joinSegments(myParts),
          name: child.title || "",
          id: child.id
        });
        recur(child, myParts);
      }
    }
  }
  recur(rootNode || {}, []);
  return { folders, bookmarks };
}

// ─── Dedup of remote duplicates ─────────────────────────────────────────────

function _dedupBy(items, keyFn, ageFieldCandidates) {
  const winners = new Map();
  const duplicates = [];
  const ageOf = (it) => {
    for (const f of ageFieldCandidates) {
      const v = it?.[f];
      if (v) return +new Date(v);
    }
    return 0;
  };
  for (const it of items) {
    const k = keyFn(it);
    const cur = winners.get(k);
    if (!cur) { winners.set(k, it); continue; }
    if (ageOf(it) < ageOf(cur) || (ageOf(it) === ageOf(cur) && (it._id || "") < (cur._id || ""))) {
      duplicates.push(cur);
      winners.set(k, it);
    } else {
      duplicates.push(it);
    }
  }
  return { unique: [...winners.values()], duplicates };
}

export function dedupeRemoteBookmarks(remote) {
  return _dedupBy(remote || [], bookmarkKey, ["addedAt", "createdAt"]);
}

export function dedupeRemoteFolders(remote) {
  return _dedupBy(remote || [], folderKey, ["createdAt"]);
}

// ─── Diff & plan ────────────────────────────────────────────────────────────

/**
 * Given the current state of a sync (remote, local, last-synced sets),
 * compute the minimum set of operations to converge.
 *
 * Decision matrix (per bookmark identity = `path|url`):
 *
 *   local | remote | lastSynced | pendDel | action
 *   ------+--------+------------+---------+----------------------------
 *     ✓   |   ✗    |     ✓      |    *    | partner deleted → delete local
 *     ✓   |   ✗    |     ✗      |    *    | new local add → push to remote
 *     ✗   |   ✓    |     *      |    ✓    | user deleted → delete remote
 *     ✗   |   ✓    |     ✓      |    ✗    | we deleted locally → delete remote
 *     ✗   |   ✓    |     ✗      |    ✗    | new remote add → create local
 *     ✓   |   ✓    |     *      |    *    | no-op, ensure key in newLastSynced
 *     ✗   |   ✗    |     ✓      |    *    | drop from newLastSynced
 *
 * `pendingLocalDeleteKeys` overrides the normal logic: if the user explicitly
 * deleted an item locally (recorded immediately in onRemoved), it is NEVER
 * recreated locally — even if lastSynced is incomplete/empty.
 *
 * In `mode: "seed-from-remote"` (e.g. first reconcile after a room change),
 * lastSynced is ignored and the diff is forced to MERGE: missing-on-one-side
 * items are propagated, never deleted. Pending deletes still win over seed.
 */
export function computeBookmarkDiff({ remoteBookmarks = [], localBookmarks = [], lastSyncedKeys = [], pendingLocalDeleteKeys = [], mode = "normal" }) {
  const lastSynced = new Set(lastSyncedKeys);
  const pendingDeletes = new Set(pendingLocalDeleteKeys);

  const { unique: remote, duplicates: dupRemote } = dedupeRemoteBookmarks(remoteBookmarks);

  const remoteByKey = new Map(remote.map(b => [bookmarkKey(b), b]));
  const localByKey = new Map(localBookmarks.map(b => [bookmarkKey(b), b]));

  const allKeys = new Set([...remoteByKey.keys(), ...localByKey.keys(), ...lastSynced]);

  const bookmarksToCreateLocal = [];
  const bookmarksToDeleteLocal = [];
  const bookmarksToCreateRemote = [];
  // Always schedule duplicates for deletion regardless of mode.
  const bookmarksToDeleteRemote = dupRemote.map(b => ({ path: b.path || "", url: b.url, _id: b._id }));
  const newLastSynced = new Set();

  for (const k of allKeys) {
    if (!k.includes("|")) continue;
    const l = localByKey.get(k);
    const r = remoteByKey.get(k);
    const wasSynced = lastSynced.has(k);
    const wasPendingDelete = pendingDeletes.has(k);

    if (l && r) {
      newLastSynced.add(k);
    } else if (l && !r) {
      if (mode === "seed-from-remote" || !wasSynced) {
        bookmarksToCreateRemote.push({ path: l.path, url: l.url, title: l.title });
        newLastSynced.add(k);
      } else {
        bookmarksToDeleteLocal.push({ path: l.path, url: l.url, localId: l.id });
      }
    } else if (!l && r) {
      // If user explicitly deleted this locally (pending delete), always
      // push the remote delete — never recreate it locally.
      if (wasPendingDelete) {
        bookmarksToDeleteRemote.push({ path: r.path || "", url: r.url, _id: r._id });
      } else if (mode === "seed-from-remote" || !wasSynced) {
        bookmarksToCreateLocal.push({ path: r.path, url: r.url, title: r.title });
        newLastSynced.add(k);
      } else {
        bookmarksToDeleteRemote.push({ path: r.path || "", url: r.url, _id: r._id });
      }
    }
    // !l && !r → drop from lastSynced (do nothing)
  }

  return {
    bookmarksToCreateLocal,
    bookmarksToDeleteLocal,
    bookmarksToCreateRemote,
    bookmarksToDeleteRemote,
    newLastSyncedKeys: [...newLastSynced]
  };
}

/**
 * Same decision matrix as `computeBookmarkDiff`, but for folders (identity = path).
 * Output ops are sorted: creates shortest-first (parents before children),
 * deletes longest-first (children before parents).
 */
export function computeFolderDiff({ remoteFolders = [], localFolders = [], lastSyncedFolderPaths = [], pendingLocalDeletePaths = [], mode = "normal" }) {
  const lastSynced = new Set(lastSyncedFolderPaths);
  const pendingDeletes = new Set(pendingLocalDeletePaths);

  const { unique: remote, duplicates: dupRemote } = dedupeRemoteFolders(remoteFolders);

  const remoteByPath = new Map(remote.map(f => [folderKey(f), f]));
  const localByPath = new Map(localFolders.map(f => [folderKey(f), f]));

  const allKeys = new Set([...remoteByPath.keys(), ...localByPath.keys(), ...lastSynced]);

  const foldersToCreateLocal = [];
  const foldersToDeleteLocal = [];
  const foldersToCreateRemote = [];
  const foldersToDeleteRemote = dupRemote.map(f => ({ path: f.path || "", _id: f._id }));
  const newLastSynced = new Set();

  for (const k of allKeys) {
    if (!k) continue;
    const l = localByPath.get(k);
    const r = remoteByPath.get(k);
    const wasSynced = lastSynced.has(k);
    // Check if this path or any parent was pending-deleted
    const wasPendingDelete = pendingDeletes.has(k) ||
      [...pendingDeletes].some(pd => k.startsWith(pd + "/"));

    if (l && r) {
      newLastSynced.add(k);
    } else if (l && !r) {
      if (mode === "seed-from-remote" || !wasSynced) {
        foldersToCreateRemote.push({ path: l.path, name: l.name });
        newLastSynced.add(k);
      } else {
        foldersToDeleteLocal.push({ path: l.path, localId: l.id });
      }
    } else if (!l && r) {
      if (wasPendingDelete) {
        foldersToDeleteRemote.push({ path: r.path, _id: r._id });
      } else if (mode === "seed-from-remote" || !wasSynced) {
        foldersToCreateLocal.push({ path: r.path, name: r.name });
        newLastSynced.add(k);
      } else {
        foldersToDeleteRemote.push({ path: r.path, _id: r._id });
      }
    }
  }

  // Order matters for tree operations.
  foldersToCreateLocal.sort((a, b) => pathDepth(a.path) - pathDepth(b.path));
  foldersToCreateRemote.sort((a, b) => pathDepth(a.path) - pathDepth(b.path));
  foldersToDeleteLocal.sort((a, b) => pathDepth(b.path) - pathDepth(a.path));
  foldersToDeleteRemote.sort((a, b) => pathDepth(b.path) - pathDepth(a.path));

  return {
    foldersToCreateLocal,
    foldersToDeleteLocal,
    foldersToCreateRemote,
    foldersToDeleteRemote,
    newLastSyncedFolderPaths: [...newLastSynced]
  };
}

/**
 * Convenience: combine folder + bookmark diffs into a single plan.
 */
export function planReconcile(input) {
  return {
    folder: computeFolderDiff(input),
    bookmark: computeBookmarkDiff(input)
  };
}

// ─── Echo-suppression bookkeeping ───────────────────────────────────────────

/**
 * Prune entries older than `ttlMs` from a `{ key: timestamp }` map.
 * Returns a new object — does not mutate.
 */
export function pruneExpired(record, now, ttlMs) {
  const out = {};
  for (const [k, t] of Object.entries(record || {})) {
    if (typeof t === "number" && now - t < ttlMs) out[k] = t;
  }
  return out;
}

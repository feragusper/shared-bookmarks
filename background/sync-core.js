// ─────────────────────────────────────────────────────────────────────────────
// sync-core.js — pure logic for oplog-based bookmark/folder sync
//
// No `chrome.*`, no `fetch`, no globals. Inputs and outputs are plain objects.
// This module converts Chrome bookmark events into Firestore ops and
// converts incoming partner ops into local Chrome mutations.
//
// Identity:
//   - Bookmark identity:    `${path}|${url}`     (folder containing it + URL)
//   - Folder identity:      `${path}`            (slash-separated from shared root)
//
// Op types:
//   - ADD_BOOKMARK   { url, title, path }
//   - DEL_BOOKMARK   { url, path }
//   - ADD_FOLDER     { path, name }
//   - DEL_FOLDER     { path }
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
 * Walk a Chrome bookmark subtree and produce flat lists of folders and bookmarks.
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

// ─── Local event → ops ──────────────────────────────────────────────────────

/**
 * Convert a local Chrome bookmark event into one or more Firestore ops.
 *
 * For a single bookmark add/delete, returns 1 op.
 * For a folder delete, returns N ops (one DEL_BOOKMARK per contained bookmark,
 * one DEL_FOLDER per contained subfolder, plus the folder itself).
 *
 * @param {"add_bookmark"|"del_bookmark"|"add_folder"|"del_folder"} eventType
 * @param {object} payload  - { url, title, path, name } as applicable
 * @param {object} [subtree] - for del_folder: the Chrome subtree that was removed
 * @returns {Array<{ type: string, payload: object }>}
 */
export function localEventToOps(eventType, payload, subtree) {
  switch (eventType) {
    case "add_bookmark":
      return [{ type: "ADD_BOOKMARK", payload: { url: payload.url, title: payload.title || payload.url, path: payload.path || "" } }];

    case "del_bookmark":
      return [{ type: "DEL_BOOKMARK", payload: { url: payload.url, path: payload.path || "" } }];

    case "add_folder":
      return [{ type: "ADD_FOLDER", payload: { path: payload.path, name: payload.name || "" } }];

    case "del_folder": {
      // A single DEL_FOLDER op is sufficient — the receiver uses
      // bmRemoveTree which cascades. No need for per-bookmark ops.
      return [{ type: "DEL_FOLDER", payload: { path: payload.path } }];
    }

    default:
      return [];
  }
}

// ─── Incoming ops → local mutations ─────────────────────────────────────────

/**
 * Given a list of pending ops from the partner and the current local tree,
 * produce a plan of Chrome bookmark mutations to apply.
 *
 * Each mutation is: { action, ...params }
 *   - { action: "create_folder", path }
 *   - { action: "create_bookmark", path, url, title }
 *   - { action: "delete_bookmark", localId, path, url }
 *   - { action: "delete_folder", localId, path }
 *   - { action: "skip", opId, reason }
 *
 * @param {Array} ops         - pending ops from partner
 * @param {object} localTree  - { folders: [...], bookmarks: [...] } from walkTreeToEntities
 * @returns {Array<{ opId, action, ... }>}
 */
export function planOpApplication(ops, localTree) {
  const localBookmarksByKey = new Map(
    localTree.bookmarks.map(b => [bookmarkKey(b), b])
  );
  const localFoldersByPath = new Map(
    localTree.folders.map(f => [f.path, f])
  );

  const mutations = [];

  for (const op of ops) {
    const p = op.payload || {};
    const opId = op._id;

    switch (op.type) {
      case "ADD_BOOKMARK": {
        const key = `${p.path || ""}|${p.url}`;
        if (localBookmarksByKey.has(key)) {
          mutations.push({ opId, action: "skip", reason: "already exists locally" });
        } else {
          mutations.push({ opId, action: "create_bookmark", path: p.path || "", url: p.url, title: p.title || p.url });
          localBookmarksByKey.set(key, { path: p.path || "", url: p.url, title: p.title });
        }
        break;
      }

      case "DEL_BOOKMARK": {
        const key = `${p.path || ""}|${p.url}`;
        const local = localBookmarksByKey.get(key);
        if (local?.id) {
          mutations.push({ opId, action: "delete_bookmark", localId: local.id, path: p.path || "", url: p.url });
          localBookmarksByKey.delete(key);
        } else {
          mutations.push({ opId, action: "skip", reason: "not found locally" });
        }
        break;
      }

      case "ADD_FOLDER": {
        if (localFoldersByPath.has(p.path)) {
          mutations.push({ opId, action: "skip", reason: "folder already exists" });
        } else {
          mutations.push({ opId, action: "create_folder", path: p.path, name: p.name || "" });
          localFoldersByPath.set(p.path, { path: p.path, name: p.name });
        }
        break;
      }

      case "DEL_FOLDER": {
        const local = localFoldersByPath.get(p.path);
        if (local?.id) {
          mutations.push({ opId, action: "delete_folder", localId: local.id, path: p.path });
          localFoldersByPath.delete(p.path);
          for (const [key, b] of localBookmarksByKey) {
            if ((b.path || "").startsWith(p.path + "/") || b.path === p.path) {
              localBookmarksByKey.delete(key);
            }
          }
          for (const [fpath] of localFoldersByPath) {
            if (fpath.startsWith(p.path + "/")) {
              localFoldersByPath.delete(fpath);
            }
          }
        } else {
          mutations.push({ opId, action: "skip", reason: "folder not found locally" });
        }
        break;
      }

      default:
        mutations.push({ opId, action: "skip", reason: `unknown op type: ${op.type}` });
    }
  }

  return mutations;
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function pruneExpired(record, now, ttlMs) {
  const out = {};
  for (const [k, t] of Object.entries(record || {})) {
    if (typeof t === "number" && now - t < ttlMs) out[k] = t;
  }
  return out;
}

// Exhaustive unit tests for the pure sync-core module.
// Run with: `node --test test/`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  encodeSegment,
  decodeSegment,
  joinSegments,
  splitPath,
  pathDepth,
  parentPathOf,
  joinPath,
  bookmarkKey,
  folderKey,
  walkTreeToEntities,
  dedupeRemoteBookmarks,
  dedupeRemoteFolders,
  computeBookmarkDiff,
  computeFolderDiff,
  planReconcile,
  pruneExpired
} from "../background/sync-core.js";

// ─── Path helpers ───────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("encodes and decodes a slash inside a segment", () => {
    assert.equal(encodeSegment("A/B"), "A%2FB");
    assert.equal(decodeSegment("A%2FB"), "A/B");
  });

  it("round-trips percent and slash", () => {
    const s = "Cool 100% of / things";
    assert.equal(decodeSegment(encodeSegment(s)), s);
  });

  it("joinSegments encodes each segment then joins with /", () => {
    assert.equal(joinSegments(["Travel", "Japan/2025"]), "Travel/Japan%2F2025");
  });

  it("joinSegments drops empty segments", () => {
    assert.equal(joinSegments(["", "A", null, undefined, "B"]), "A/B");
  });

  it("splitPath decodes each segment", () => {
    assert.deepEqual(splitPath("Travel/Japan%2F2025"), ["Travel", "Japan/2025"]);
  });

  it("pathDepth handles empty and nested", () => {
    assert.equal(pathDepth(""), 0);
    assert.equal(pathDepth("a"), 1);
    assert.equal(pathDepth("a/b/c"), 3);
  });

  it("parentPathOf strips last segment", () => {
    assert.equal(parentPathOf("a/b/c"), "a/b");
    assert.equal(parentPathOf("a"), "");
    assert.equal(parentPathOf(""), "");
  });

  it("joinPath appends an encoded leaf to a parent", () => {
    assert.equal(joinPath("", "A"), "A");
    assert.equal(joinPath("a/b", "C/D"), "a/b/C%2FD");
    assert.equal(joinPath("a", ""), "a");
  });

  it("bookmarkKey is path|url", () => {
    assert.equal(bookmarkKey({ path: "x/y", url: "http://e.com" }), "x/y|http://e.com");
    assert.equal(bookmarkKey({ path: "", url: "http://e.com" }), "|http://e.com");
  });

  it("folderKey is the path", () => {
    assert.equal(folderKey({ path: "x/y" }), "x/y");
    assert.equal(folderKey({ path: "" }), "");
  });
});

// ─── walkTreeToEntities ─────────────────────────────────────────────────────

describe("walkTreeToEntities", () => {
  it("flattens a nested tree into folders + bookmarks", () => {
    const tree = {
      id: "root", title: "Shared", children: [
        { id: "1", title: "google", url: "https://google.com" },
        {
          id: "2", title: "Travel", children: [
            { id: "3", title: "kyoto", url: "https://kyoto.com" },
            {
              id: "4", title: "Japan", children: [
                { id: "5", title: "shrine", url: "https://shrine.com" }
              ]
            }
          ]
        }
      ]
    };
    const { folders, bookmarks } = walkTreeToEntities(tree);
    assert.deepEqual(folders.map(f => f.path), ["Travel", "Travel/Japan"]);
    assert.deepEqual(bookmarks.map(b => b.path), ["", "Travel", "Travel/Japan"]);
  });

  it("encodes folder titles with slashes", () => {
    const tree = {
      children: [
        {
          id: "f", title: "A/B", children: [
            { id: "b", title: "x", url: "http://x" }
          ]
        }
      ]
    };
    const { folders, bookmarks } = walkTreeToEntities(tree);
    assert.equal(folders[0].path, "A%2FB");
    assert.equal(bookmarks[0].path, "A%2FB");
  });

  it("returns empty when there are no children", () => {
    assert.deepEqual(walkTreeToEntities({}), { folders: [], bookmarks: [] });
    assert.deepEqual(walkTreeToEntities(null), { folders: [], bookmarks: [] });
  });

  it("handles deep nesting and special chars", () => {
    const tree = {
      children: [
        { id: "1", title: "a%b", children: [
          { id: "2", title: "c d", children: [
            { id: "3", title: "uniπ", url: "http://u" }
          ]}
        ]}
      ]
    };
    const { folders, bookmarks } = walkTreeToEntities(tree);
    assert.deepEqual(folders.map(f => f.path), ["a%25b", "a%25b/c d"]);
    assert.equal(bookmarks[0].url, "http://u");
    assert.equal(bookmarks[0].path, "a%25b/c d");
  });
});

// ─── Dedup ──────────────────────────────────────────────────────────────────

describe("dedupeRemoteBookmarks", () => {
  it("collapses duplicates by (path,url) keeping the oldest", () => {
    const remote = [
      { _id: "newer", path: "a", url: "http://x", addedAt: "2026-04-19T10:00:00Z" },
      { _id: "older", path: "a", url: "http://x", addedAt: "2026-04-18T10:00:00Z" },
      { _id: "different", path: "b", url: "http://x" }
    ];
    const { unique, duplicates } = dedupeRemoteBookmarks(remote);
    assert.equal(unique.length, 2);
    assert.ok(unique.some(u => u._id === "older"));
    assert.ok(unique.some(u => u._id === "different"));
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]._id, "newer");
  });

  it("returns empty arrays for empty input", () => {
    assert.deepEqual(dedupeRemoteBookmarks([]), { unique: [], duplicates: [] });
    assert.deepEqual(dedupeRemoteBookmarks(undefined), { unique: [], duplicates: [] });
  });
});

describe("dedupeRemoteFolders", () => {
  it("collapses duplicate folders by path keeping oldest createdAt", () => {
    const remote = [
      { _id: "a1", path: "Travel", createdAt: "2026-01-01" },
      { _id: "a2", path: "Travel", createdAt: "2026-04-01" }
    ];
    const { unique, duplicates } = dedupeRemoteFolders(remote);
    assert.equal(unique.length, 1);
    assert.equal(unique[0]._id, "a1");
    assert.equal(duplicates[0]._id, "a2");
  });
});

// ─── computeBookmarkDiff — decision matrix ──────────────────────────────────

const sb = (path, url, extras = {}) => ({ path, url, title: extras.title || url, ...extras });

describe("computeBookmarkDiff (decision matrix)", () => {
  it("a) local add, no remote, not in synced → push to remote", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [],
      localBookmarks: [sb("", "http://x", { id: "L1" })],
      lastSyncedKeys: []
    });
    assert.deepEqual(out.bookmarksToCreateRemote, [{ path: "", url: "http://x", title: "http://x" }]);
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.bookmarksToDeleteLocal, []);
    assert.deepEqual(out.bookmarksToDeleteRemote, []);
    assert.deepEqual(out.newLastSyncedKeys, ["|http://x"]);
  });

  it("b) remote add, not local, not in synced → create local, no push back", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://x"), _id: "R1" }],
      localBookmarks: [],
      lastSyncedKeys: []
    });
    assert.deepEqual(out.bookmarksToCreateLocal, [{ path: "", url: "http://x", title: "http://x" }]);
    assert.deepEqual(out.bookmarksToCreateRemote, []);
    assert.deepEqual(out.newLastSyncedKeys, ["|http://x"]);
  });

  it("c) local delete of previously synced → push remote delete", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("a", "http://x"), _id: "R1" }],
      localBookmarks: [],
      lastSyncedKeys: ["a|http://x"]
    });
    assert.deepEqual(out.bookmarksToDeleteRemote, [{ path: "a", url: "http://x", _id: "R1" }]);
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.newLastSyncedKeys, []);
  });

  it("d) local delete that was never synced → no remote action", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [],
      localBookmarks: [],
      lastSyncedKeys: []
    });
    assert.deepEqual(out.bookmarksToDeleteRemote, []);
    assert.deepEqual(out.bookmarksToCreateRemote, []);
  });

  it("e) remote delete of synced → remove locally, no push", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [],
      localBookmarks: [sb("a", "http://x", { id: "L1" })],
      lastSyncedKeys: ["a|http://x"]
    });
    assert.deepEqual(out.bookmarksToDeleteLocal, [{ path: "a", url: "http://x", localId: "L1" }]);
    assert.deepEqual(out.bookmarksToCreateRemote, []);
    assert.deepEqual(out.newLastSyncedKeys, []);
  });

  it("f) ghost prevention: local-only X not in lastSynced → keep + push, NOT delete", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [],
      localBookmarks: [sb("", "http://new", { id: "L1" })],
      lastSyncedKeys: []
    });
    assert.deepEqual(out.bookmarksToDeleteLocal, []);
    assert.deepEqual(out.bookmarksToCreateRemote, [{ path: "", url: "http://new", title: "http://new" }]);
  });

  it("g) remote-only X in lastSynced means we deleted locally → push remote delete", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://x"), _id: "R1" }],
      localBookmarks: [],
      lastSyncedKeys: ["|http://x"]
    });
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.bookmarksToDeleteRemote, [{ path: "", url: "http://x", _id: "R1" }]);
  });

  it("local + remote both present: no ops, key stays in newLastSynced", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://x"), _id: "R1" }],
      localBookmarks: [sb("", "http://x", { id: "L1" })],
      lastSyncedKeys: ["|http://x"]
    });
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.bookmarksToCreateRemote, []);
    assert.deepEqual(out.bookmarksToDeleteLocal, []);
    assert.deepEqual(out.bookmarksToDeleteRemote, []);
    assert.deepEqual(out.newLastSyncedKeys, ["|http://x"]);
  });

  it("k) idempotent: empty everywhere = empty plan", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [], localBookmarks: [], lastSyncedKeys: []
    });
    assert.deepEqual(out, {
      bookmarksToCreateLocal: [],
      bookmarksToDeleteLocal: [],
      bookmarksToCreateRemote: [],
      bookmarksToDeleteRemote: [],
      newLastSyncedKeys: []
    });
  });

  it("duplicate remote docs: collapse and schedule extras for delete", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [
        { ...sb("", "http://x"), _id: "old", addedAt: "2026-01-01" },
        { ...sb("", "http://x"), _id: "new", addedAt: "2026-04-01" }
      ],
      localBookmarks: [sb("", "http://x", { id: "L" })],
      lastSyncedKeys: ["|http://x"]
    });
    // The newer duplicate is scheduled for deletion.
    assert.equal(out.bookmarksToDeleteRemote.length, 1);
    assert.equal(out.bookmarksToDeleteRemote[0]._id, "new");
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.bookmarksToCreateRemote, []);
  });

  it("m) initial seed: pulls AND pushes everything, no deletes", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("a", "http://r"), _id: "R" }],
      localBookmarks: [sb("b", "http://l", { id: "L" })],
      lastSyncedKeys: [],
      mode: "seed-from-remote"
    });
    assert.deepEqual(out.bookmarksToCreateLocal, [{ path: "a", url: "http://r", title: "http://r" }]);
    assert.deepEqual(out.bookmarksToCreateRemote, [{ path: "b", url: "http://l", title: "http://l" }]);
    assert.deepEqual(out.bookmarksToDeleteLocal, []);
    assert.deepEqual(out.bookmarksToDeleteRemote, []);
    assert.deepEqual(out.newLastSyncedKeys.sort(), ["a|http://r", "b|http://l"].sort());
  });
});

// ─── computeFolderDiff ──────────────────────────────────────────────────────

const sf = (path, name, extras = {}) => ({ path, name, ...extras });

describe("computeFolderDiff", () => {
  it("creates local folders shortest-first", () => {
    const out = computeFolderDiff({
      remoteFolders: [
        sf("a/b/c", "c", { _id: "3" }),
        sf("a", "a", { _id: "1" }),
        sf("a/b", "b", { _id: "2" })
      ],
      localFolders: [],
      lastSyncedFolderPaths: []
    });
    assert.deepEqual(out.foldersToCreateLocal.map(f => f.path), ["a", "a/b", "a/b/c"]);
  });

  it("deletes local folders longest-first (children before parents)", () => {
    const out = computeFolderDiff({
      remoteFolders: [],
      localFolders: [
        sf("a", "a", { id: "L1" }),
        sf("a/b", "b", { id: "L2" }),
        sf("a/b/c", "c", { id: "L3" })
      ],
      lastSyncedFolderPaths: ["a", "a/b", "a/b/c"]
    });
    assert.deepEqual(out.foldersToDeleteLocal.map(f => f.path), ["a/b/c", "a/b", "a"]);
  });

  it("sibling folders with the same title remain distinct (different paths)", () => {
    const out = computeFolderDiff({
      remoteFolders: [
        sf("Travel/Tips", "Tips", { _id: "R1" }),
        sf("Work/Tips", "Tips", { _id: "R2" })
      ],
      localFolders: [],
      lastSyncedFolderPaths: []
    });
    assert.equal(out.foldersToCreateLocal.length, 2);
    assert.deepEqual(out.foldersToCreateLocal.map(f => f.path).sort(), ["Travel/Tips", "Work/Tips"]);
  });

  it("seed mode merges instead of deleting", () => {
    const out = computeFolderDiff({
      remoteFolders: [sf("X", "X", { _id: "R" })],
      localFolders: [sf("Y", "Y", { id: "L" })],
      lastSyncedFolderPaths: [],
      mode: "seed-from-remote"
    });
    assert.deepEqual(out.foldersToCreateLocal.map(f => f.path), ["X"]);
    assert.deepEqual(out.foldersToCreateRemote.map(f => f.path), ["Y"]);
    assert.deepEqual(out.foldersToDeleteLocal, []);
    assert.deepEqual(out.foldersToDeleteRemote, []);
  });
});

// ─── planReconcile combines folder + bookmark plans ─────────────────────────

describe("planReconcile", () => {
  it("returns both folder and bookmark plans", () => {
    const out = planReconcile({
      remoteFolders: [sf("Travel", "Travel", { _id: "F" })],
      localFolders: [],
      remoteBookmarks: [{ ...sb("Travel", "http://k"), _id: "B" }],
      localBookmarks: [],
      lastSyncedFolderPaths: [],
      lastSyncedKeys: []
    });
    assert.equal(out.folder.foldersToCreateLocal.length, 1);
    assert.equal(out.bookmark.bookmarksToCreateLocal.length, 1);
  });

  it("paste subtree pushes folders AND bookmarks (folders before bookmarks via order)", () => {
    const out = planReconcile({
      remoteFolders: [],
      localFolders: [
        sf("Travel", "Travel", { id: "L1" }),
        sf("Travel/Japan", "Japan", { id: "L2" })
      ],
      remoteBookmarks: [],
      localBookmarks: [
        sb("Travel/Japan", "http://k", { id: "L3" }),
        sb("Travel", "http://t", { id: "L4" })
      ],
      lastSyncedFolderPaths: [],
      lastSyncedKeys: []
    });
    assert.deepEqual(out.folder.foldersToCreateRemote.map(f => f.path), ["Travel", "Travel/Japan"]);
    assert.equal(out.bookmark.bookmarksToCreateRemote.length, 2);
  });
});

// ─── pruneExpired ───────────────────────────────────────────────────────────

describe("pruneExpired", () => {
  it("removes entries older than ttl", () => {
    const now = 100_000;
    const out = pruneExpired({ a: 50_000, b: 99_500, c: 100_000 }, now, 1000);
    assert.deepEqual(out, { b: 99_500, c: 100_000 });
  });

  it("returns empty for null/undefined input", () => {
    assert.deepEqual(pruneExpired(null, 0, 1000), {});
    assert.deepEqual(pruneExpired(undefined, 0, 1000), {});
  });
});

// ─── End-to-end-ish stability scenarios ─────────────────────────────────────

describe("stability scenarios (the user's bug report)", () => {
  it("scenario: user deletes a bookmark; reconcile must not re-create it as a 'remote-only' ghost", () => {
    // After local delete, lastSynced still holds the key. Remote still has the doc
    // (we haven't pushed delete yet). The diff says: push remote delete; do NOT
    // create it locally again.
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://x"), _id: "R1" }],
      localBookmarks: [],
      lastSyncedKeys: ["|http://x"]
    });
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.bookmarksToDeleteRemote, [{ path: "", url: "http://x", _id: "R1" }]);
  });

  it("scenario: partner adds a bookmark; we pull and create local but NEVER push back as duplicate", () => {
    // First reconcile: remote has it, local doesn't, not in synced → create local.
    // After we apply the local create, the next reconcile sees local has it,
    // remote has it → no-op (as long as the listener-driven push was suppressed
    // by echo-suppression in the shell).
    const r1 = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://partner"), _id: "R" }],
      localBookmarks: [],
      lastSyncedKeys: []
    });
    assert.deepEqual(r1.bookmarksToCreateLocal, [{ path: "", url: "http://partner", title: "http://partner" }]);
    assert.deepEqual(r1.bookmarksToCreateRemote, []);
    assert.deepEqual(r1.newLastSyncedKeys, ["|http://partner"]);

    const r2 = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://partner"), _id: "R" }],
      localBookmarks: [sb("", "http://partner", { id: "L" })],
      lastSyncedKeys: ["|http://partner"]
    });
    assert.deepEqual(r2.bookmarksToCreateLocal, []);
    assert.deepEqual(r2.bookmarksToCreateRemote, []);
  });

  it("scenario: SW dies between push and lastSynced.set; next reconcile reconciles cleanly without dup", () => {
    // We pushed bookmark X to remote, but lastSynced wasn't persisted.
    // After SW respawn, remote has X, local has X, lastSynced does NOT.
    // The diff sees local==remote → no-op, AND adds key to newLastSynced.
    // No duplicate is created.
    const out = computeBookmarkDiff({
      remoteBookmarks: [{ ...sb("", "http://x"), _id: "R" }],
      localBookmarks: [sb("", "http://x", { id: "L" })],
      lastSyncedKeys: []
    });
    assert.deepEqual(out.bookmarksToCreateLocal, []);
    assert.deepEqual(out.bookmarksToCreateRemote, []);
    assert.deepEqual(out.newLastSyncedKeys, ["|http://x"]);
  });

  it("scenario: duplicate Firestore docs are collapsed automatically", () => {
    const out = computeBookmarkDiff({
      remoteBookmarks: [
        { ...sb("a", "http://x"), _id: "old", addedAt: "2026-01-01" },
        { ...sb("a", "http://x"), _id: "dup1", addedAt: "2026-02-01" },
        { ...sb("a", "http://x"), _id: "dup2", addedAt: "2026-03-01" }
      ],
      localBookmarks: [sb("a", "http://x", { id: "L" })],
      lastSyncedKeys: ["a|http://x"]
    });
    assert.equal(out.bookmarksToDeleteRemote.length, 2);
    const ids = out.bookmarksToDeleteRemote.map(d => d._id).sort();
    assert.deepEqual(ids, ["dup1", "dup2"]);
  });
});


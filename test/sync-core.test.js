// Exhaustive unit tests for the oplog-based sync-core module.
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
  localEventToOps,
  planOpApplication,
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
  });

  it("folderKey is the path", () => {
    assert.equal(folderKey({ path: "x/y" }), "x/y");
  });
});

// ─── walkTreeToEntities ─────────────────────────────────────────────────────

describe("walkTreeToEntities", () => {
  it("flattens a nested tree into folders + bookmarks", () => {
    const tree = {
      id: "root", title: "Shared", children: [
        { id: "1", title: "google", url: "https://google.com" },
        { id: "2", title: "Travel", children: [
          { id: "3", title: "kyoto", url: "https://kyoto.com" },
          { id: "4", title: "Japan", children: [
            { id: "5", title: "shrine", url: "https://shrine.com" }
          ]}
        ]}
      ]
    };
    const { folders, bookmarks } = walkTreeToEntities(tree);
    assert.deepEqual(folders.map(f => f.path), ["Travel", "Travel/Japan"]);
    assert.deepEqual(bookmarks.map(b => b.path), ["", "Travel", "Travel/Japan"]);
  });

  it("returns empty when there are no children", () => {
    assert.deepEqual(walkTreeToEntities({}), { folders: [], bookmarks: [] });
    assert.deepEqual(walkTreeToEntities(null), { folders: [], bookmarks: [] });
  });
});

// ─── localEventToOps ────────────────────────────────────────────────────────

describe("localEventToOps", () => {
  it("add_bookmark produces one ADD_BOOKMARK op", () => {
    const ops = localEventToOps("add_bookmark", { url: "http://x", title: "X", path: "Travel" });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, "ADD_BOOKMARK");
    assert.deepEqual(ops[0].payload, { url: "http://x", title: "X", path: "Travel" });
  });

  it("del_bookmark produces one DEL_BOOKMARK op", () => {
    const ops = localEventToOps("del_bookmark", { url: "http://x", path: "" });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, "DEL_BOOKMARK");
  });

  it("add_folder produces one ADD_FOLDER op", () => {
    const ops = localEventToOps("add_folder", { path: "Travel", name: "Travel" });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, "ADD_FOLDER");
    assert.deepEqual(ops[0].payload, { path: "Travel", name: "Travel" });
  });

  it("del_folder with subtree produces ops for all contents + the folder", () => {
    const subtree = {
      title: "Travel",
      children: [
        { id: "b1", title: "google", url: "http://g" },
        { id: "f1", title: "Japan", children: [
          { id: "b2", title: "shrine", url: "http://s" }
        ]}
      ]
    };
    const ops = localEventToOps("del_folder", { path: "Travel" }, subtree);
    // Should have: DEL_BOOKMARK(Travel|http://g), DEL_BOOKMARK(Travel/Japan|http://s),
    //              DEL_FOLDER(Travel/Japan), DEL_FOLDER(Travel)
    assert.equal(ops.length, 4);
    assert.equal(ops.filter(o => o.type === "DEL_BOOKMARK").length, 2);
    assert.equal(ops.filter(o => o.type === "DEL_FOLDER").length, 2);
    // Last op should be the folder itself
    assert.equal(ops[ops.length - 1].payload.path, "Travel");
  });

  it("del_folder without subtree produces just the folder delete", () => {
    const ops = localEventToOps("del_folder", { path: "Travel" });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, "DEL_FOLDER");
  });

  it("unknown event type returns empty", () => {
    assert.deepEqual(localEventToOps("unknown", {}), []);
  });
});

// ─── planOpApplication ──────────────────────────────────────────────────────

describe("planOpApplication", () => {
  const makeOp = (type, payload, id) => ({ _id: id || "op1", type, payload });
  const emptyTree = { folders: [], bookmarks: [] };

  it("ADD_BOOKMARK creates locally when not present", () => {
    const ops = [makeOp("ADD_BOOKMARK", { url: "http://x", title: "X", path: "" })];
    const plan = planOpApplication(ops, emptyTree);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "create_bookmark");
    assert.equal(plan[0].url, "http://x");
  });

  it("ADD_BOOKMARK skips when already exists locally", () => {
    const tree = { folders: [], bookmarks: [{ url: "http://x", path: "", id: "L1" }] };
    const ops = [makeOp("ADD_BOOKMARK", { url: "http://x", path: "" })];
    const plan = planOpApplication(ops, tree);
    assert.equal(plan[0].action, "skip");
  });

  it("DEL_BOOKMARK deletes when found locally", () => {
    const tree = { folders: [], bookmarks: [{ url: "http://x", path: "a", id: "L1" }] };
    const ops = [makeOp("DEL_BOOKMARK", { url: "http://x", path: "a" })];
    const plan = planOpApplication(ops, tree);
    assert.equal(plan[0].action, "delete_bookmark");
    assert.equal(plan[0].localId, "L1");
  });

  it("DEL_BOOKMARK skips when not found locally (idempotent)", () => {
    const ops = [makeOp("DEL_BOOKMARK", { url: "http://x", path: "" })];
    const plan = planOpApplication(ops, emptyTree);
    assert.equal(plan[0].action, "skip");
  });

  it("ADD_FOLDER creates locally when not present", () => {
    const ops = [makeOp("ADD_FOLDER", { path: "Travel", name: "Travel" })];
    const plan = planOpApplication(ops, emptyTree);
    assert.equal(plan[0].action, "create_folder");
    assert.equal(plan[0].path, "Travel");
  });

  it("ADD_FOLDER skips when already exists", () => {
    const tree = { folders: [{ path: "Travel", name: "Travel", id: "F1" }], bookmarks: [] };
    const ops = [makeOp("ADD_FOLDER", { path: "Travel", name: "Travel" })];
    const plan = planOpApplication(ops, tree);
    assert.equal(plan[0].action, "skip");
  });

  it("DEL_FOLDER deletes and removes children from tracking", () => {
    const tree = {
      folders: [
        { path: "Travel", name: "Travel", id: "F1" },
        { path: "Travel/Japan", name: "Japan", id: "F2" }
      ],
      bookmarks: [
        { url: "http://x", path: "Travel", id: "B1" },
        { url: "http://y", path: "Travel/Japan", id: "B2" }
      ]
    };
    const ops = [makeOp("DEL_FOLDER", { path: "Travel" })];
    const plan = planOpApplication(ops, tree);
    assert.equal(plan[0].action, "delete_folder");
    assert.equal(plan[0].localId, "F1");
  });

  it("DEL_FOLDER is idempotent when not found", () => {
    const ops = [makeOp("DEL_FOLDER", { path: "X" })];
    const plan = planOpApplication(ops, emptyTree);
    assert.equal(plan[0].action, "skip");
  });

  it("multiple ops are applied in order, maintaining state", () => {
    const ops = [
      makeOp("ADD_FOLDER", { path: "News", name: "News" }, "op1"),
      makeOp("ADD_BOOKMARK", { url: "http://cnn.com", title: "CNN", path: "News" }, "op2"),
      makeOp("ADD_BOOKMARK", { url: "http://cnn.com", title: "CNN", path: "News" }, "op3"),  // dup
    ];
    const plan = planOpApplication(ops, emptyTree);
    assert.equal(plan[0].action, "create_folder");
    assert.equal(plan[1].action, "create_bookmark");
    assert.equal(plan[2].action, "skip"); // duplicate
  });

  it("both users delete same bookmark → second is skip (idempotent)", () => {
    const tree = { folders: [], bookmarks: [{ url: "http://x", path: "", id: "B1" }] };
    const ops = [
      makeOp("DEL_BOOKMARK", { url: "http://x", path: "" }, "op1"),
      makeOp("DEL_BOOKMARK", { url: "http://x", path: "" }, "op2"),
    ];
    const plan = planOpApplication(ops, tree);
    assert.equal(plan[0].action, "delete_bookmark");
    assert.equal(plan[1].action, "skip"); // already deleted
  });

  it("unknown op type is skipped", () => {
    const ops = [makeOp("UNKNOWN", {})];
    const plan = planOpApplication(ops, emptyTree);
    assert.equal(plan[0].action, "skip");
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
  });
});


// In-memory fakes for the subset of `chrome.*` APIs the SW touches.
// Used by tests; not loaded in the extension itself.

export function makeChromeMock() {
  // ── chrome.storage.local ──
  let store = {};
  const storage = {
    local: {
      get: async (keys) => {
        if (keys === undefined || keys === null) return { ...store };
        if (typeof keys === "string") return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        }
        // object with defaults
        const out = {};
        for (const [k, v] of Object.entries(keys)) out[k] = (k in store) ? store[k] : v;
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete store[k];
      },
      clear: async () => { store = {}; }
    }
  };

  // ── chrome.bookmarks ──
  const nodes = new Map(); // id → { id, parentId, title, url, children?: ids }
  let nextId = 1;
  function add(parentId, props) {
    const id = String(nextId++);
    const node = { id, parentId, title: props.title || "", ...(props.url ? { url: props.url } : {}) };
    nodes.set(id, node);
    return node;
  }
  function childrenOf(parentId) {
    const out = [];
    for (const n of nodes.values()) if (n.parentId === parentId) out.push(n);
    return out;
  }
  function subTree(rootId) {
    const root = nodes.get(rootId);
    if (!root) return null;
    function recur(id) {
      const n = { ...nodes.get(id) };
      if (!n.url) n.children = childrenOf(id).map(k => recur(k.id));
      return n;
    }
    return recur(rootId);
  }
  function removeNodeAndDescendants(id) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const k of childrenOf(cur)) stack.push(k.id);
      nodes.delete(cur);
    }
  }

  const bookmarks = {
    create: (props, cb) => {
      const node = add(props.parentId || "0", props);
      setTimeout(() => cb(node), 0);
    },
    get: (id, cb) => {
      const n = nodes.get(id);
      setTimeout(() => cb(n ? [n] : []), 0);
    },
    getChildren: (id, cb) => {
      setTimeout(() => cb(childrenOf(id)), 0);
    },
    getSubTree: (id, cb) => {
      setTimeout(() => cb(subTree(id) ? [subTree(id)] : []), 0);
    },
    remove: (id, cb) => {
      nodes.delete(id);
      setTimeout(() => cb && cb(), 0);
    },
    removeTree: (id, cb) => {
      removeNodeAndDescendants(id);
      setTimeout(() => cb && cb(), 0);
    },
    search: (query, cb) => {
      const results = [...nodes.values()].filter(n => !query.title || n.title === query.title);
      setTimeout(() => cb(results), 0);
    }
  };

  // Pre-create a fake "Other bookmarks" root so the SW has somewhere to put things
  add("0", { title: "Other Bookmarks" });

  return {
    chrome: {
      storage,
      bookmarks,
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, lastError: undefined },
      alarms: { create() {}, get(_n, cb) { setTimeout(() => cb(null), 0); }, onAlarm: { addListener() {} } },
      identity: { getAuthToken() {} },
      tabs: { query() {} }
    },
    // helpers for tests
    _internals: {
      nodes,
      add,
      childrenOf,
      subTree,
      reset: () => { nodes.clear(); nextId = 1; store = {}; add("0", { title: "Other Bookmarks" }); }
    }
  };
}


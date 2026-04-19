// Recording fetch stub.
// install(handlers) replaces globalThis.fetch with a stub that matches
// requests to one of the handlers; throws if no handler matches.
//
// handlers is an array of { match, respond }, where:
//   match(req): boolean   — req = { method, url, body }
//   respond(req): { status, body } | Promise<...>
//
// uninstall() restores the previous fetch.

let original = null;
let calls = [];

export function install(handlers) {
  original = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    let body;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    const req = { url, method, body, headers: init.headers || {} };
    calls.push(req);
    for (const h of handlers) {
      if (h.match(req)) {
        const r = await h.respond(req);
        const status = r.status ?? 200;
        const respBody = r.body ?? null;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => respBody,
          text: async () => JSON.stringify(respBody),
          body: null
        };
      }
    }
    throw new Error(`fetch-mock: no handler for ${method} ${url}`);
  };
}

export function uninstall() {
  if (original) { globalThis.fetch = original; original = null; }
  calls = [];
}

export function getCalls() { return [...calls]; }


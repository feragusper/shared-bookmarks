# GitHub Copilot custom instructions

This repository follows the **`AGENTS.md`** convention. The full set of
rules, conventions, data model, sync-engine details, CI workflow and
past-bug lessons live in [`AGENTS.md`](../AGENTS.md) at the repo root.

## TL;DR for code suggestions

- **Stack**: Chrome Extension MV3, plain ES2022 modules, no bundler, no
  Firebase SDK. All Firebase I/O is `fetch()` against REST endpoints in
  `firebase/firestore.js`.
b vcx   - **Sync engine** lives in `background/`:
  - `sync-core.js` is **pure** — no `chrome.*`, no `fetch`. All path
    math, identity, dedup, diff and plan logic. **Add new sync behavior
    here first**, with tests in `test/sync-core.test.js`.
  - `service-worker.js` is the I/O shell that calls into `sync-core.js`.
- **Tests** use only the built-in `node:test` runner. **Never add npm
  deps** — `package.json` must stay dependency-free.
- **Service worker** (`background/service-worker.js`) must be MV3-safe:
  no `setInterval`, no `window`/`document`. Periodic work uses
  `chrome.alarms`.
- **CSP** is `script-src 'self'; object-src 'self'`. Never suggest inline
  event handlers (`onclick="..."`, `onerror="..."`) or inline `<script>`.
  Use `addEventListener` after setting `innerHTML`.
- **Secrets**: `manifest.json` and `firebase/firebase-config.js` are
  git-ignored. Templates are `manifest.example.json` and
  `firebase/firebase-config.example.js`. Never suggest committing the
  real files or hardcoding API keys / OAuth client IDs.
- **Popup** is membership/invite UI only — do NOT render bookmarks in
  the popup (Chrome's native bookmark manager handles that).
- **Sync identity**: bookmarks are identified by `(path, url)`, folders
  by `path`. The `lastSyncedKeys` / `lastSyncedFolderPaths` sets in
  `chrome.storage.local` MUST be kept in sync to avoid echo loops and
  ghost re-creations.
- **Style**: 2-space indent, double quotes, semicolons. Wrap callback-
  style Chrome APIs in `new Promise(...)` and `await` them.
- **Versioning**: read from `chrome.runtime.getManifest().version`.
  CI in `.github/workflows/build.yml` stamps version
  `MAJOR.MINOR.<run_number>` per push.

## Validation after edits

```bash
node --check background/service-worker.js
node --check popup/popup.js
node --check firebase/firestore.js
```

When in doubt, defer to [`AGENTS.md`](../AGENTS.md).


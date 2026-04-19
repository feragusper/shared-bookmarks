# AGENTS.md

> Context file for AI coding agents (GitHub Copilot, Claude Code, Cursor,
> Codex, Aider, etc.) working on this repository. Humans, see `README.md`
> for setup; this file is the **source of truth for agent behavior**.

## 1. What this project is

A **Chrome Extension (Manifest V3)** that lets two Google-authenticated users
share a single bookmark folder in real time. The shared folder lives
natively under **Other bookmarks → Shared Bookmark Folder** in Chrome and
supports nested subfolders, drag-and-drop, copy-paste, etc.

Backend: **Firebase Firestore + Firebase Auth**, accessed via **REST**
(no Firebase JS SDK, no bundler, no transpiler — plain ES modules loaded
directly by Chrome).

## 2. Hard rules (do NOT break)

1. **No build system.** Do not introduce webpack, vite, rollup, esbuild,
   TypeScript, npm dependencies, or any preprocessor. The extension must be
   loadable in `chrome://extensions` → Load unpacked, as-is from the repo
   root (after the user has materialized `manifest.json` and
   `firebase/firebase-config.js` from the `*.example.*` templates).
2. **No Firebase SDK.** All Firestore/Auth I/O uses `fetch()` against the
   REST endpoints in `firebase/firestore.js`. Adding `firebase` /
   `@firebase/*` packages is forbidden.
3. **MV3 service-worker safe.** No `setInterval`, no long-lived `setTimeout`,
   no `XMLHttpRequest`, no `window`, no `document` in the service worker.
   Periodic work uses `chrome.alarms`. The SW can be killed at any time
   and must be idempotent on wake.
4. **Strict CSP.** `manifest.json` sets
   `script-src 'self'; object-src 'self'`. **Never** emit inline event
   handlers (`onclick="..."`, `onerror="..."`) or inline `<script>` blocks.
   Use `addEventListener` after setting `innerHTML`.
5. **Secrets stay out of git.** `manifest.json` and
   `firebase/firebase-config.js` are git-ignored on purpose because they
   contain a Firebase API key, project IDs, and an OAuth client ID bound to
   a specific Chrome Extension ID. Never commit them. Templates live in
   `manifest.example.json` and `firebase/firebase-config.example.js`.
6. **Don't render bookmarks in the popup.** The popup is intentionally
   limited to membership + invite UI. Chrome's native bookmark manager is
   the bookmark UI. Past attempts at rendering caused flicker on every
   poll cycle.

## 3. Repository layout

```
shared-bookmarks/
├── AGENTS.md                       ← this file
├── CLAUDE.md                       ← pointer to AGENTS.md
├── README.md                       ← human setup guide
├── .gitignore
├── .github/
│   ├── workflows/build.yml         ← CI: builds zip artifact per push
│   └── copilot-instructions.md     ← short instructions for GH Copilot
├── docs/
│   └── ARCHITECTURE.md             ← deep dive: sync engine + data model
├── manifest.example.json           ← TEMPLATE — copy to manifest.json
├── manifest.json                   ← LOCAL ONLY (git-ignored, has secrets)
├── firestore.rules                 ← Firestore security rules
├── firebase/
│   ├── firebase-config.example.js  ← TEMPLATE
│   ├── firebase-config.js          ← LOCAL ONLY (git-ignored, has secrets)
│   └── firestore.js                ← Auth + Firestore REST helpers
├── background/
│   └── service-worker.js           ← Sync engine + chrome.alarms polling
├── popup/
│   ├── popup.html
│   ├── popup.css                   ← Material 3 (Material You) tokens
│   └── popup.js                    ← Membership / invite UI only
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── create_icons.py                 ← optional helper to regenerate icons
```

## 4. Coding conventions

- Plain modern JS (ES2022). `import` / `export`, `async/await`, optional
  chaining, nullish coalescing — yes. JSX, TS, decorators — no.
- 2-space indent, double quotes for strings, semicolons, trailing commas
  where natural.
- Section headers in source files use the existing `// ─── Title ─── ` box
  style — match it when adding new sections.
- All Chrome callback APIs are wrapped in `new Promise(...)` and awaited.
  Do not mix raw callbacks with async code in new sections.
- Toasts (popup) and `console.log` prefixed with `[SW]` (service worker) are
  the standard ways to surface non-fatal info.
- User-facing strings are English. Error messages should be short and
  actionable.

## 5. Firestore data model

```
users/{uid}
  - email, displayName, photoURL
  - sharedRoomId: string | null

rooms/{roomId}
  - createdBy: uid
  - createdAt: timestamp
  - members:    [uid, ...]            (max 2)
  - inviteCode: string                (one-shot; deleted when full)

rooms/{roomId}/bookmarks/{bookmarkId}
  - url, title, favicon
  - path: ""                          ("" = folder root, otherwise "Sub/Deeper")
  - addedBy, addedByName, addedAt

rooms/{roomId}/folders/{folderId}
  - path: "Sub/Deeper"                (full path identity)
  - name: "Deeper"                    (leaf segment)
  - createdBy, createdAt

roomInvites/{INVITE_CODE}
  - roomId: string                    (lookup doc — world-readable,
                                       members-writable; auto-deleted
                                       when room reaches 2 members)
```

**Identity rules**
- Bookmark identity is the pair `(path, url)`, not the Firestore doc id.
- Folder identity is `path` (the full slash-separated path from the
  shared root).
- Two bookmarks with the same `(path, url)` are the same logical bookmark
  — deduplicate on push and skip on pull.

## 6. Sync engine (background/service-worker.js)

- **Outgoing (Chrome → Firestore)**: listeners on
  `chrome.bookmarks.onCreated`, `onRemoved`, `onChanged`, `onMoved` push
  deltas. Always recompute the path of the changed node before pushing.
- **Incoming (Firestore → Chrome)**: `chrome.alarms` named
  `sb-poll` fires every `POLL_PERIOD_MIN = 0.25` minutes (~15 s) and runs
  `pullAndReconcile()`. This walks the Chrome subtree under the shared
  folder, diffs it against Firestore, and applies the **minimum** set of
  `chrome.bookmarks.create` / `removeTree` calls to converge.
- **Conflict avoidance**: `chrome.storage.local` keeps the last-synced
  sets:
  - `lastSyncedKeys`: `Set<"path|url">` for bookmarks
  - `lastSyncedFolderPaths`: `Set<path>` for folders

  These let `pullAndReconcile` distinguish *"the partner just deleted X"*
  from *"the user just created X locally and we haven't pushed yet"*.
  Do not remove this tracking.
- **Loop suppression**: when the SW itself creates a bookmark/folder in
  response to a remote change, it must update `lastSyncedKeys` /
  `lastSyncedFolderPaths` **before** returning so the
  `chrome.bookmarks.onCreated` listener doesn't echo the change back to
  Firestore.

If you change anything in the sync engine, mentally run these scenarios:

1. User adds a bookmark locally → appears on partner within ~15 s.
2. Partner deletes a folder → vanishes locally on next alarm; bookmarks
   inside it are gone too (use `removeTree`, not `remove`).
3. User copy-pastes a whole folder tree in `chrome://bookmarks` →
   recursive walk picks it all up, pushes folders first then bookmarks.
4. SW is killed mid-sync → next alarm reconciles cleanly (idempotency).

## 7. Auth

- Sign-in flow: `chrome.identity.getAuthToken({ interactive: true })` →
  exchange for a Firebase ID token via
  `accounts:signInWithIdp` (REST, in `firebase/firestore.js`).
- The Firebase ID token is cached in `chrome.storage.local` along with its
  `expiresAt`. All REST helpers refresh on demand using the
  `securetoken.googleapis.com` refresh endpoint.
- The OAuth client in `manifest.json` is of type **Chrome Extension** and
  is bound to a specific Extension ID. If the Extension ID changes (e.g.
  someone reloads from a different path), auth will fail until a new
  OAuth client is created.

## 8. CI & versioning

- `.github/workflows/build.yml` runs on every push/PR to `main` and on
  `workflow_dispatch`.
- It computes version `MAJOR.MINOR.<github.run_number>` where `MAJOR.MINOR`
  is read from `manifest.example.json` (currently `1.0`).
- It materializes `firebase/firebase-config.js` and `manifest.json` from
  two repository secrets (`FIREBASE_CONFIG_JS`, `OAUTH_CLIENT_ID`),
  syntax-checks all JS, and uploads
  `dist/shared-bookmarks-<version>.zip` as a workflow artifact.
- The popup displays the live version in the bottom-right corner via
  `chrome.runtime.getManifest().version`. Don't hardcode versions
  anywhere else.

To bump major or minor, edit the `version` field in
**`manifest.example.json`** (not `manifest.json` — that one is local).

## 9. How to test locally

1. Make sure `manifest.json` and `firebase/firebase-config.js` exist
   (copy from the `*.example.*` files and fill them in).
2. Run the unit tests for the pure sync core:
   ```bash
   node --test 'test/*.test.js'
   ```
   No `npm install` needed — there are zero dependencies. The runner
   uses the built-in `node:test` module (Node 18+).
3. `chrome://extensions` → Developer mode → **Load unpacked** → pick the
   repo root.
4. After every code change, hit the reload icon on the extension card.
5. Inspect the service worker via the **Service worker** link on the
   extension card. `[SW]`-prefixed logs appear there.
6. To validate JS without loading the extension:
   ```bash
   node --check background/service-worker.js
   node --check background/sync-core.js
   node --check popup/popup.js
   node --check firebase/firestore.js
   node --check firebase/firebase-config.js
   ```

### Adding tests

- All tests live in `test/*.test.js` and use the standard `node:test` API
  (`describe`, `it`, `assert`).
- **Never add npm dependencies.** If you need a mock, hand-roll it in
  `test/_*.js` (see `_chrome-mock.js` and `_fetch-mock.js`).
- New behavior in `background/sync-core.js` MUST come with a test row
  in `test/sync-core.test.js`. The pure module is the contract — the
  shell must remain a thin adapter.

## 10. Past bugs / lessons learned

These scenarios all happened during development. If you re-introduce them,
the user will be unhappy.

- **Bookmarks getting deleted on popup open.** Caused by a one-way
  "sync to Chrome" that didn't know about local-only adds. Fixed by the
  `lastSyncedKeys` reconciliation pattern.
- **Toast: "Query failed" on Join.** Caused by a Firestore `runQuery` that
  required reading `rooms` the user wasn't a member of yet. Fixed by the
  `roomInvites/{CODE}` lookup collection.
- **CSP violation: "Executing inline event handler".** Triggered by
  `onerror="..."` attributes injected via `innerHTML`. Always use
  `addEventListener` after setting `innerHTML`.
- **Service worker registration failed (status 15).** Caused by a
  truncated source file. Always finish your edits and validate with
  `node --check`.
- **Popup flicker on each poll.** Caused by re-rendering bookmarks in the
  popup. Solution: don't render bookmarks in the popup at all — the
  popup is membership-only.
- **`bad client id` after loading from a different folder.** The OAuth
  client is bound to the Extension ID, which Chrome derives from the
  source-folder path unless `manifest.json` has a `"key"` field. We pin
  the ID via `"key"`; do not remove it. See `scripts/generate-extension-key.sh`.

## 11. When in doubt

- Prefer a small, surgical patch over a refactor.
- If your change touches the sync engine, also re-read
  `docs/ARCHITECTURE.md`.
- If your change touches secrets handling or CI, re-read
  `.github/workflows/build.yml` end-to-end before pushing.
- Never commit `manifest.json` or `firebase/firebase-config.js`. If
  `git status` shows them, your `.gitignore` is broken — fix it before
  doing anything else.


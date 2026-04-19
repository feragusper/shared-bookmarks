# Architecture

Deep dive into how Shared Bookmarks works under the hood. Read
[`AGENTS.md`](../AGENTS.md) first for the rules and conventions.

## High-level

```
┌─────────────────────────┐                ┌─────────────────────────┐
│        Browser A        │                │        Browser B        │
│                         │                │                         │
│  popup.{html,js,css} ◄──┼── membership   │  popup.{html,js,css}    │
│        │                │   info only    │        │                │
│        ▼                │                │        ▼                │
│  background/             │                │  background/            │
│   service-worker.js     │                │   service-worker.js     │
│        │  ▲             │                │        │  ▲             │
│  push  │  │  pull       │                │  push  │  │  pull       │
│  on    │  │  every      │                │  on    │  │  every      │
│  bookmark │  ~15s via   │                │  bookmark │  ~15s via   │
│  events│  │ chrome.     │                │  events│  │ chrome.     │
│        │  │ alarms      │                │        │  │ alarms      │
│        ▼  │             │                │        ▼  │             │
│   firebase/firestore.js │                │   firebase/firestore.js │
└────────┬────────────────┘                └────────┬────────────────┘
         │                                          │
         │      REST (fetch) — no Firebase SDK      │
         └─────────────►  Firestore  ◄──────────────┘
                          Cloud Auth
```

## Data flow

### 1. Sign-in

1. `chrome.identity.getAuthToken({ interactive: true })` → Google OAuth
   access token (uses the Chrome Extension OAuth client ID in
   `manifest.json`).
2. POST to `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp`
   exchanges the Google token for a **Firebase ID token + refresh token**.
3. Tokens are cached in `chrome.storage.local`:
   ```
   { idToken, refreshToken, expiresAt, uid }
   ```
4. All subsequent REST calls call `getValidIdToken()` which refreshes via
   `securetoken.googleapis.com` if `expiresAt` has passed.

### 2. Room creation / join

- **Create**: write `rooms/{auto}` with `members: [uid]`, generate a
  6-char `inviteCode`, write `roomInvites/{CODE}` pointing at the room,
  set `users/{uid}.sharedRoomId`.
- **Join**: read `roomInvites/{CODE}` → get `roomId` → patch
  `rooms/{roomId}.members` to add the joining uid → set
  `users/{uid}.sharedRoomId` → if `members.length === 2`, delete
  `roomInvites/{CODE}` (one-shot codes).

### 3. Bookmark / folder identity

- `path` is the **slash-separated path from the shared root**, e.g.
  `""` (root), `"Travel"`, `"Travel/Japan/Kyoto"`.
- A bookmark's logical identity is `(path, url)`. The Firestore document
  ID is irrelevant for sync correctness.
- A folder's logical identity is `path`.

This decouples Chrome's local bookmark IDs (which differ across browsers)
from the cross-device shared identity.

### 4. Outgoing sync (Chrome → Firestore)

Listeners in `service-worker.js`:

| Chrome event           | Action                                           |
| ---------------------- | ------------------------------------------------ |
| `onCreated` (folder)   | `addFolder({ path, name })` → update `lastSyncedFolderPaths` |
| `onCreated` (bookmark) | `addBookmark({ path, url, title, favicon })` → update `lastSyncedKeys` |
| `onRemoved` (any)      | recursively `deleteBookmark` and `deleteFolder` for everything that was under the removed node |
| `onChanged`            | rename folder / re-title bookmark — same identity, just title update |
| `onMoved`              | treated as remove from old path + create at new path |

Each listener:
1. Skips if the change happened **outside** the shared folder.
2. Recomputes paths from the current Chrome tree (don't trust event payload paths after moves).
3. Pushes the delta and **updates the `lastSynced*` set** before returning.

### 5. Incoming sync (Firestore → Chrome)

`chrome.alarms.onAlarm` fires every ~15 s and calls `pullAndReconcile()`:

1. Fetch all `folders` and `bookmarks` for the room.
2. Walk the local tree under the shared root → produce
   `localFolders: Set<path>` and `localBookmarks: Set<"path|url">`.
3. **Folders**: for every remote `path` not in `localFolders`,
   `ensureLocalFolderPath(path)` walks it segment by segment, creating
   missing folders. For every `path` in `lastSyncedFolderPaths` but not
   in remote, `removeTree` it locally.
4. **Bookmarks**: for every remote `(path, url)` not local, create.
   For every local key in `lastSyncedKeys` but not remote, remove.
5. Update `lastSyncedFolderPaths` / `lastSyncedKeys` to the new
   reconciled state.

### 6. Why `lastSynced*` is critical

Without it, `pullAndReconcile` cannot distinguish:

- "user just added X locally, and we haven't pushed it to Firestore yet"
  → must KEEP it
- "X used to be shared, partner just deleted it remotely"
  → must REMOVE it locally

Both cases look like *"local has X, remote doesn't"*. The `lastSynced*`
sets remember "what we successfully had in sync last cycle", which lets
us tell the two apart.

## MV3 service-worker lifecycle

The SW can be terminated by Chrome at any time when idle, and re-spawned
on the next event. This means:

- **No globals to rely on across wakes.** Persist anything important in
  `chrome.storage.local`.
- **No `setInterval`.** Use `chrome.alarms` (created on `onInstalled`
  and on `onStartup`, idempotent).
- **`pullAndReconcile()` must be idempotent.** Running it twice in a
  row should be a no-op.
- **No `XMLHttpRequest`.** Use `fetch()` only.

## Security model

`firestore.rules` enforces:

- A user may only read/write `rooms/{R}` if `request.auth.uid in
  resource.data.members` (or, on create, in `request.resource.data.members`).
- Subcollections `bookmarks` and `folders` inherit member-only access via
  a `get(/databases/$(db)/documents/rooms/$(roomId))` check.
- `roomInvites/{CODE}` is **publicly readable** (so a not-yet-member can
  resolve a code to a `roomId` before joining), but writable only by
  members of the referenced room.
- Per-room invariants enforced in rules:
  - `members.size() <= 2`
  - new members can only be appended (no replacement)
  - `members[0]` (creator) cannot be removed by anyone but themselves

If you change rules, update both this doc and `firestore.rules`, then
republish them in the Firebase Console.

## Build pipeline (CI)

`.github/workflows/build.yml`:

1. Checkout.
2. Compute `VERSION = ${MAJOR.MINOR from manifest.example.json}.${run_number}`.
3. Verify `FIREBASE_CONFIG_JS` and `OAUTH_CLIENT_ID` secrets exist.
4. Write `firebase/firebase-config.js` from the secret as-is.
5. Build `manifest.json` by:
   - parsing `manifest.example.json`,
   - setting `.version = VERSION`,
   - setting `.oauth2.client_id = OAUTH_CLIENT_ID`.
6. `node --check` every JS file.
7. `rsync` the loadable subset to a staging dir, excluding repo-only
   files (`*.example.*`, `README.md`, `firestore.rules`, `.git`,
   `.github`, `create_icons.py`, etc.).
8. `zip -r dist/shared-bookmarks-<VERSION>.zip` the staging dir.
9. `actions/upload-artifact@v4` makes it downloadable from the run page
   for 30 days.

The popup reads `chrome.runtime.getManifest().version` at runtime and
displays it as `vX.Y.Z` in the bottom-right corner.


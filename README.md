# Shared Bookmarks

A Chrome extension (Manifest V3) that lets two people **share a bookmark folder
in real time**, fully integrated with Chrome's native bookmark manager.

The shared folder lives at **Other bookmarks → Shared Bookmark Folder**.
Add, rename, move, drag-and-drop or copy-paste entire folder trees just like
any normal Chrome bookmark — changes appear on your partner's browser within
seconds. Nested subfolders are supported.

Backend is Firebase (Firestore + Google Auth) accessed directly via REST,
so the extension ships with **no bundler and no Firebase SDK**.

---

## Features

- 🔐 Sign in with Google (`chrome.identity` + `signInWithIdp`)
- 👥 One-shot invite codes — rooms are capped at 2 members
- 📁 Native Chrome bookmark integration (folders, nesting, drag & drop)
- 🔄 Bidirectional sync with conflict-safe reconciliation
- ⏱ Near-real-time updates via `chrome.alarms` (~15 s polling, MV3-friendly)
- 🎨 Material 3 popup UI

---

## Project structure

```
shared-bookmarks/
├── manifest.example.json            ← template (copy to manifest.json)
├── firestore.rules                  ← Firestore security rules
├── firebase/
│   ├── firebase-config.example.js   ← template (copy to firebase-config.js)
│   └── firestore.js                 ← Auth + Firestore REST helpers
├── background/
│   └── service-worker.js            ← Sync engine + alarms-based polling
├── popup/
│   ├── popup.html
│   ├── popup.css                    ← Material 3 styling
│   └── popup.js                     ← Membership / invite UI
├── icons/                           ← 16 / 48 / 128 px
└── create_icons.py                  ← Optional helper to regenerate icons
```

`manifest.json` and `firebase/firebase-config.js` are **git-ignored** because
they contain your project's API keys and the OAuth client ID bound to your
own Chrome Extension ID. Templates with the same structure live next to them.

---

## Setup

### 1. Clone and create your local config files

```bash
git clone https://github.com/feragusper/shared-bookmarks.git
cd shared-bookmarks
cp manifest.example.json manifest.json
cp firebase/firebase-config.example.js firebase/firebase-config.js
```

### 2. Create a Firebase project

1. https://console.firebase.google.com → **Add project**.
2. **Build → Firestore Database → Create database** (production mode).
3. **Build → Authentication → Sign-in method → Google → Enable**.
4. **Project settings → General → Your apps → Web (`</>`)** to register a web
   app, then copy the `firebaseConfig` values into
   `firebase/firebase-config.js`.

### 3. Publish the Firestore rules

Either paste the contents of `firestore.rules` into
**Firestore → Rules → Publish**, or use the CLI:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore
firebase deploy --only firestore:rules
```

### 4. Load the extension once to get its ID

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Copy the generated **Extension ID**.

### 5. Create the OAuth Chrome Extension client

1. https://console.cloud.google.com → select the same project.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
3. Application type: **Chrome Extension**, paste the Extension ID.
4. Copy the resulting **Client ID** into `manifest.json` under
   `oauth2.client_id`.
5. Reload the extension in `chrome://extensions`.

---

## Usage

### Owner
1. Click the extension icon → **Continue with Google**.
2. A room is created automatically and you get a 6-character invite code.
3. Open the share panel and copy the code to your partner.

### Partner
1. Install the extension and sign in with Google.
2. Open the share panel, paste the code, hit **Join**.
3. The folder **Other bookmarks → Shared Bookmark Folder** now syncs both ways.

Use Chrome's bookmark manager (`chrome://bookmarks`) like normal: create
subfolders, drag bookmarks, copy-paste whole trees — everything propagates.

---

## How sync works

- **Outgoing**: `chrome.bookmarks.onCreated/onRemoved/onChanged/onMoved`
  listeners in the service worker push deltas to Firestore using a
  `path|url` identity for bookmarks and `path` identity for folders.
- **Incoming**: `chrome.alarms` fires every ~15 s and runs a full
  reconciliation pass that walks the local tree, diffs it against Firestore,
  and applies the minimal set of `bookmarks.create` / `bookmarks.removeTree`
  calls to converge.
- **Conflict avoidance**: `chrome.storage.local` keeps the last-synced set of
  paths/URLs so a remote deletion is distinguishable from a brand-new local
  addition.

The popup never renders bookmarks — it only shows membership and the invite
panel — so there's no UI flicker while sync runs.

---

## Security notes

- Never commit `manifest.json` or `firebase/firebase-config.js`. They are in
  `.gitignore`.
- Firestore access is gated by `firestore.rules`: only room members can read
  or write room documents; invite codes live in a tiny `roomInvites/{CODE}`
  lookup collection that is world-readable but only writable by members.
- Invite codes are deleted automatically once a room reaches 2 members.

---

## Continuous Integration

Every push and PR to `main` triggers
[`.github/workflows/build.yml`](.github/workflows/build.yml), which:

1. Computes a build version of the form `MAJOR.MINOR.<run_number>`
   (the `MAJOR.MINOR` part is read from `manifest.example.json`).
2. Materializes the two git-ignored files from repository secrets:
   - `firebase/firebase-config.js` ← secret **`FIREBASE_CONFIG_JS`**
   - `manifest.json` ← built from `manifest.example.json` with the version
     stamped in and the OAuth client ID replaced from secret
     **`OAUTH_CLIENT_ID`**.
3. Syntax-checks all JS files.
4. Packages the extension into `shared-bookmarks-<version>.zip` (excluding
   `.git`, `.github`, `*.example.*`, `README.md`, `firestore.rules`,
   `create_icons.py`, etc.).
5. Uploads the zip as a workflow artifact (downloadable from the run page,
   30-day retention).

The popup shows the running version in the bottom-right corner via
`chrome.runtime.getManifest().version`, so locally you'll see the version from
your `manifest.json` and CI builds will show e.g. `v1.0.42`.

### Required GitHub Secrets

Create these under **Repo → Settings → Secrets and variables → Actions →
New repository secret**:

| Secret               | Value                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| `FIREBASE_CONFIG_JS` | The full contents of your local `firebase/firebase-config.js` file (the entire ES module, exactly as it is on disk). |
| `OAUTH_CLIENT_ID`    | Just the OAuth Chrome-extension client ID, e.g. `123456789012-abcdefghijklmnopqrstuvwx.apps.googleusercontent.com`. |

Quick way to copy the firebase config into your clipboard (macOS):

```bash
pbcopy < firebase/firebase-config.js
```

Then paste it as the value of `FIREBASE_CONFIG_JS`.

### Downloading a build

1. Open the repo on GitHub → **Actions** tab.
2. Pick the latest green run on `main`.
3. Scroll to **Artifacts** → download `shared-bookmarks-<version>.zip`.
4. Unzip it and load it in `chrome://extensions` via **Load unpacked**.

---

## License

MIT.


import {
  signInWithGoogle,
  signOut,
  upsertUser,
  getUser,
  createRoom,
  joinRoomByCode,
  getRoom
} from "../firebase/firestore.js";

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  user: null,
  room: null, // { roomId, inviteCode, memberCount }
  membersTimer: null
};

const CHROME_FOLDER_NAME = "Shared Bookmark Folder";

// ─── Screen Router ────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ─── Talk to the service worker ──────────────────────────────────────────────
// All bookmark/folder sync lives in background/service-worker.js. The popup is
// membership/invite UI only and never touches chrome.bookmarks directly.
function requestSync() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "FORCE_SYNC" }, (resp) => {
        // ignore any lastError; the SW will run anyway
        resolve(resp || { ok: false });
      });
    } catch (_) { resolve({ ok: false }); }
  });
}

async function openSharedFolderInChrome() {
  const { sharedFolderId } = await chrome.storage.local.get("sharedFolderId");
  if (sharedFolderId) {
    chrome.tabs.create({ url: `chrome://bookmarks/?id=${sharedFolderId}` });
    return;
  }
  // Fallback: search by title
  chrome.bookmarks.search({ title: CHROME_FOLDER_NAME }, (results) => {
    const folder = (results || []).find(r => !r.url);
    if (folder) chrome.tabs.create({ url: `chrome://bookmarks/?id=${folder.id}` });
    else chrome.tabs.create({ url: "chrome://bookmarks/" });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get(["user", "roomId"]);

  if (!stored.user) {
    showScreen("screen-login");
    return;
  }

  state.user = stored.user;
  populateUserUI(state.user);

  if (stored.roomId) {
    state.room = { roomId: stored.roomId };
  } else {
    // Defense in depth: never blindly auto-create a room from init() — that's
    // how a transient hiccup could orphan the user from their existing shared
    // folder. First try to restore sharedRoomId from the user's Firestore doc.
    try {
      const userDoc = await getUser(state.user.uid, state.user.idToken);
      if (userDoc?.sharedRoomId) {
        state.room = { roomId: userDoc.sharedRoomId };
        await chrome.storage.local.set({ roomId: userDoc.sharedRoomId });
      } else {
        await autoCreateRoom();
      }
    } catch (err) {
      console.warn("[popup] could not restore room from Firestore:", err);
      // Don't auto-create on network failure — leave it for the user to retry.
    }
  }

  await enterMainScreen();
}

async function autoCreateRoom() {
  try {
    const { roomId, inviteCode } = await createRoom(state.user.uid, state.user.idToken, {
      email: state.user.email,
      displayName: state.user.displayName,
      photoURL: state.user.photoURL
    });
    state.room = { roomId, inviteCode };
    await chrome.storage.local.set({ roomId });
  } catch (err) {
    console.error("Room creation failed:", err);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
document.getElementById("btn-google-login").addEventListener("click", async () => {
  try {
    const user = await signInWithGoogle();
    state.user = user;

    await upsertUser(user.uid, {
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL
    }, user.idToken);

    await chrome.storage.local.set({ user });
    populateUserUI(user);

    const userDoc = await getUser(user.uid, user.idToken);
    if (userDoc?.sharedRoomId) {
      state.room = { roomId: userDoc.sharedRoomId };
      await chrome.storage.local.set({ roomId: userDoc.sharedRoomId });
    } else {
      await autoCreateRoom();
    }

    await enterMainScreen();
  } catch (err) {
    toast("Sign-in failed: " + err.message);
    console.error(err);
  }
});

async function handleLogout() {
  clearInterval(state.membersTimer);
  await signOut();
  state = { user: null, room: null, membersTimer: null };
  showScreen("screen-login");
}

document.getElementById("btn-logout-main").addEventListener("click", handleLogout);

function populateUserUI(user) {
  const avatar = document.getElementById("user-avatar-main");
  avatar.src = user.photoURL || "";
  avatar.addEventListener("error", () => { avatar.style.display = "none"; });
  document.getElementById("user-name-main").textContent = user.displayName;
}

// ─── Share Panel ──────────────────────────────────────────────────────────────
document.getElementById("btn-share").addEventListener("click", async () => {
  const panel = document.getElementById("share-panel");
  const shareBtn = document.getElementById("btn-share");
  const isOpen = panel.classList.contains("open");
  panel.classList.toggle("open", !isOpen);
  shareBtn.classList.toggle("active", !isOpen);

  if (!isOpen) {
    let code = state.room?.inviteCode;
    if (!code && state.room?.roomId) {
      try {
        const room = await getRoom(state.room.roomId, state.user.idToken);
        code = room.inviteCode;
        state.room.inviteCode = code;
      } catch (_) {}
    }
    document.getElementById("share-code-display").textContent = code || "—";
  }
});

document.getElementById("btn-copy-invite").addEventListener("click", () => {
  const code = document.getElementById("share-code-display").textContent;
  if (code && code !== "—") {
    navigator.clipboard.writeText(code).then(() => toast("Code copied!"));
  }
});

document.getElementById("btn-join-share").addEventListener("click", async () => {
  const code = document.getElementById("input-share-code").value.trim().toUpperCase();
  if (!code || code.length < 4) { toast("Enter a valid invite code"); return; }

  try {
    const { roomId } = await joinRoomByCode(state.user.uid, code, state.user.idToken, {
      email: state.user.email,
      displayName: state.user.displayName,
      photoURL: state.user.photoURL
    });
    state.room = { roomId };
    await chrome.storage.local.set({ roomId });
    // The SW's storage.onChanged listener will reset lastSynced* and run a
    // seed-from-remote reconcile, which merges instead of deleting.

    document.getElementById("share-panel").classList.remove("open");
    document.getElementById("btn-share").classList.remove("active");
    document.getElementById("input-share-code").value = "";
    toast("✓ Joined shared folder!");

    await enterMainScreen();
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById("input-share-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join-share").click();
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
async function enterMainScreen() {
  showScreen("screen-bookmarks");

  const folderNameEl = document.getElementById("folder-name");
  if (folderNameEl) folderNameEl.textContent = CHROME_FOLDER_NAME;

  if (!state.room?.roomId) return;

  await refreshRoomInfo();
  // Ask the SW to sync once on popup open. The SW also polls every ~30s in
  // the background via chrome.alarms, so this is just for instant feedback.
  requestSync();

  // Soft refresh of members every 8s while popup is open.
  clearInterval(state.membersTimer);
  state.membersTimer = setInterval(refreshRoomInfo, 8000);
}

async function refreshRoomInfo() {
  try {
    const room = await getRoom(state.room.roomId, state.user.idToken);
    state.room.memberCount = (room.members || []).length;
    state.room.inviteCode = room.inviteCode;
    document.getElementById("partner-status").textContent =
      state.room.memberCount >= 2 ? "Shared with partner" : "Only you";
    renderMembers(room);
  } catch (_) {}
}

function renderMembers(room) {
  const container = document.getElementById("member-list");
  if (!container) return;

  const members = room?.members || [];
  const profiles = room?.memberProfiles || {};
  if (!members.length) { container.innerHTML = ""; return; }

  // Build only if changed (avoid flicker).
  const signature = members.map(uid => `${uid}:${profiles[uid]?.displayName || ""}`).join("|");
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;

  container.innerHTML = members.map((uid) => {
    const profile = profiles[uid] || {};
    const isMe = uid === state.user?.uid;
    const displayName = profile.displayName || (isMe ? (state.user?.displayName || "You") : "Member");
    const photoURL = profile.photoURL || (isMe ? (state.user?.photoURL || "") : "");
    const safeName = escapeHtml(isMe ? `${displayName} (you)` : displayName);
    const safePhoto = escapeHtml(photoURL);
    return `
      <div class="member-chip" title="${safeName}">
        <img src="${safePhoto}" alt="" data-fallback="hide" />
        <span>${safeName}</span>
      </div>
    `;
  }).join("");

  container.querySelectorAll('img[data-fallback="hide"]').forEach((img) => {
    img.addEventListener("error", () => { img.style.display = "none"; });
  });
}

// ─── Open Chrome Bookmarks Manager on the shared folder ─────────────────────
document.getElementById("btn-open-manager").addEventListener("click", () => {
  openSharedFolderInChrome();
});

// ─── Manual "Sync now" button ───────────────────────────────────────────────
document.getElementById("btn-sync-now").addEventListener("click", async () => {
  const btn = document.getElementById("btn-sync-now");
  btn.disabled = true;
  btn.classList.add("syncing");
  try {
    const resp = await requestSync();
    toast(resp?.ok ? "✓ Synced" : "Sync queued");
  } finally {
    btn.disabled = false;
    btn.classList.remove("syncing");
  }
});


function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Start ────────────────────────────────────────────────────────────────────
// Show extension version in the corner of the popup
try {
  const v = chrome.runtime.getManifest().version;
  const el = document.getElementById("version-badge");
  if (el) el.textContent = "v" + v;
} catch (_) { /* noop */ }

init();


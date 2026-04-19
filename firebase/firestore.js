import { firebaseConfig } from "./firebase-config.js";

// ─── Minimal Firebase SDK via CDN-compatible ESM (loaded as importmap in popup) ───
// We use the REST API directly to avoid bundling issues in MV3 service workers.
// Auth is handled via chrome.identity + Firebase REST Auth API.

const BASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1";
const BASE_FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

// ─── AUTH ─────────────────────────────────────────────────────────────────────

/**
 * Sign in with Google using chrome.identity and exchange the token
 * with Firebase REST Auth to get a Firebase ID token + user info.
 * @returns {{ idToken, refreshToken, uid, email, displayName, photoURL }}
 */
export async function signInWithGoogle() {
  // 1. Get Google OAuth token via chrome.identity
  const googleToken = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });

  // 2. Exchange Google token for Firebase ID token
  const resp = await fetch(
    `${BASE_AUTH_URL}/accounts:signInWithIdp?key=${firebaseConfig.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `access_token=${googleToken}&providerId=google.com`,
        requestUri: `https://${firebaseConfig.authDomain}`,
        returnSecureToken: true,
        returnIdpCredential: true
      })
    }
  );

  if (!resp.ok) throw new Error("Firebase auth failed: " + (await resp.text()));
  const data = await resp.json();

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
    displayName: data.displayName || data.email.split("@")[0],
    photoURL: data.photoUrl || ""
  };
}

/**
 * Refresh an expired Firebase ID token using the refresh token.
 */
export async function refreshIdToken(refreshToken) {
  const resp = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken })
    }
  );
  if (!resp.ok) throw new Error("Token refresh failed");
  const data = await resp.json();
  return { idToken: data.id_token, refreshToken: data.refresh_token };
}

/**
 * Sign out — revoke the Google token and clear local storage.
 */
export async function signOut(googleToken) {
  if (googleToken) {
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token: googleToken }, resolve));
  }
  await chrome.storage.local.clear();
}

// ─── FIRESTORE REST HELPERS ───────────────────────────────────────────────────

function firestoreValue(val) {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "number") return { integerValue: String(val) };
  if (typeof val === "boolean") return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(firestoreValue) } };
  if (val === null) return { nullValue: null };
  // object
  const fields = {};
  for (const [k, v] of Object.entries(val)) fields[k] = firestoreValue(v);
  return { mapValue: { fields } };
}

function fromFirestoreValue(val) {
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return Number(val.integerValue);
  if (val.doubleValue !== undefined) return Number(val.doubleValue);
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.timestampValue !== undefined) return new Date(val.timestampValue);
  if (val.nullValue !== undefined) return null;
  if (val.arrayValue) return (val.arrayValue.values || []).map(fromFirestoreValue);
  if (val.mapValue) return fromFirestoreFields(val.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = fromFirestoreValue(v);
  return obj;
}

function docToObject(doc) {
  if (!doc || !doc.fields) return null;
  const obj = fromFirestoreFields(doc.fields);
  // Extract the document ID from the name path
  obj._id = doc.name.split("/").pop();
  return obj;
}

async function firestoreRequest(method, path, body, idToken) {
  const url = `${BASE_FIRESTORE_URL}/${path}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Firestore error ${resp.status}`);
  }
  // 204 No Content (DELETE)
  if (resp.status === 204) return null;
  return resp.json();
}

// ─── USER DOCUMENT ────────────────────────────────────────────────────────────

export async function upsertUser(uid, data, idToken) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = firestoreValue(v);
  await firestoreRequest(
    "PATCH",
    `users/${uid}`,
    { fields },
    idToken
  );
}

export async function getUser(uid, idToken) {
  const doc = await firestoreRequest("GET", `users/${uid}`, null, idToken);
  return docToObject(doc);
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────

function generateInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export async function createRoom(uid, idToken, profile = {}) {
  const inviteCode = generateInviteCode();
  const ownerName = profile.displayName || profile.email || "You";
  const fields = {
    createdBy: firestoreValue(uid),
    createdAt: firestoreValue(new Date()),
    members: firestoreValue([uid]),
    inviteCode: firestoreValue(inviteCode),
    memberProfiles: firestoreValue({
      [uid]: {
        displayName: ownerName,
        photoURL: profile.photoURL || ""
      }
    })
  };
  const doc = await firestoreRequest("POST", "rooms", { fields }, idToken);
  const roomId = doc.name.split("/").pop();

  // Store invite code lookup as its own document to avoid query-permission issues.
  await firestoreRequest(
    "PATCH",
    `roomInvites/${inviteCode}`,
    {
      fields: {
        roomId: firestoreValue(roomId),
        createdBy: firestoreValue(uid),
        createdAt: firestoreValue(new Date())
      }
    },
    idToken
  );

  // Update user with roomId
  await upsertUser(uid, { sharedRoomId: roomId }, idToken);

  return { roomId, inviteCode };
}

export async function joinRoomByCode(uid, code, idToken, profile = {}) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) throw new Error("Invalid invite code");

  let inviteDoc;
  try {
    inviteDoc = await firestoreRequest("GET", `roomInvites/${normalizedCode}`, null, idToken);
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (msg.includes("not_found") || msg.includes("not found")) {
      throw new Error("Invalid or expired invite code. Ask your partner to generate a new code.");
    }
    throw err;
  }

  const invite = docToObject(inviteDoc);
  const roomId = invite?.roomId;
  if (!roomId) throw new Error("Invalid invite code");

  let roomData;
  try {
    const roomDoc = await firestoreRequest("GET", `rooms/${roomId}`, null, idToken);
    roomData = docToObject(roomDoc);
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (msg.includes("not_found") || msg.includes("not found")) {
      throw new Error("Invite no longer valid");
    }
    throw err;
  }

  // Prevent joining your own room as the second member
  if (roomData.members?.includes(uid)) throw new Error("You are already in this room");
  if (roomData.members?.length >= 2) throw new Error("Room is full");

  // Add uid to members array
  const newMembers = [...(roomData.members || []), uid];
  const newMemberProfiles = {
    ...(roomData.memberProfiles || {}),
    [uid]: {
      displayName: profile.displayName || profile.email || "Partner",
      photoURL: profile.photoURL || ""
    }
  };

  await firestoreRequest(
    "PATCH",
    `rooms/${roomId}?updateMask.fieldPaths=members&updateMask.fieldPaths=memberProfiles`,
    {
      fields: {
        members: firestoreValue(newMembers),
        memberProfiles: firestoreValue(newMemberProfiles)
      }
    },
    idToken
  );

  // Update user
  await upsertUser(uid, { sharedRoomId: roomId }, idToken);

  // One-time invite: once full, remove lookup document.
  if (newMembers.length >= 2) {
    await firestoreRequest("DELETE", `roomInvites/${normalizedCode}`, null, idToken).catch(() => {});
  }

  return { roomId };
}

export async function getRoom(roomId, idToken) {
  const doc = await firestoreRequest("GET", `rooms/${roomId}`, null, idToken);
  return docToObject(doc);
}

// ─── BOOKMARKS ────────────────────────────────────────────────────────────────

export async function addBookmark(roomId, bookmark, idToken) {
  // bookmark: { url, title, favicon, addedBy, addedByName, tags }
  const fields = {};
  const data = {
    ...bookmark,
    addedAt: new Date()
  };
  for (const [k, v] of Object.entries(data)) fields[k] = firestoreValue(v);

  const doc = await firestoreRequest(
    "POST",
    `rooms/${roomId}/bookmarks`,
    { fields },
    idToken
  );
  return doc.name.split("/").pop();
}

export async function deleteBookmark(roomId, bookmarkId, idToken) {
  await firestoreRequest("DELETE", `rooms/${roomId}/bookmarks/${bookmarkId}`, null, idToken);
}

export async function listBookmarks(roomId, idToken) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/rooms/${roomId}/bookmarks?orderBy=addedAt%20desc&pageSize=100`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!resp.ok) throw new Error("Failed to list bookmarks");
  const data = await resp.json();
  if (!data.documents) return [];
  return data.documents.map(docToObject).filter(Boolean);
}

// ─── FOLDERS (nested folder structure mirror) ─────────────────────────────────

export async function addFolder(roomId, { path, name, createdBy }, idToken) {
  const fields = {
    path: firestoreValue(path || ""),
    name: firestoreValue(name || ""),
    createdBy: firestoreValue(createdBy || ""),
    createdAt: firestoreValue(new Date())
  };
  const doc = await firestoreRequest("POST", `rooms/${roomId}/folders`, { fields }, idToken);
  return doc.name.split("/").pop();
}

export async function deleteFolder(roomId, folderId, idToken) {
  await firestoreRequest("DELETE", `rooms/${roomId}/folders/${folderId}`, null, idToken);
}

export async function listFolders(roomId, idToken) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/rooms/${roomId}/folders?pageSize=200`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!resp.ok) throw new Error("Failed to list folders");
  const data = await resp.json();
  if (!data.documents) return [];
  return data.documents.map(docToObject).filter(Boolean);
}

// ─── REAL-TIME LISTENER (Firestore Listen API) ────────────────────────────────

/**
 * Opens a persistent HTTP stream to Firestore's Listen endpoint.
 * Calls onSnapshot(bookmarks[]) whenever something changes.
 * Returns a cancel function.
 */
export function listenToBookmarks(roomId, idToken, onSnapshot, onError) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:listen`;

  const body = JSON.stringify({
    addTarget: {
      query: {
        parent: `projects/${projectId}/databases/(default)/documents/rooms/${roomId}`,
        structuredQuery: {
          from: [{ collectionId: "bookmarks" }],
          orderBy: [{ field: { fieldPath: "addedAt" }, direction: "DESCENDING" }]
        }
      },
      targetId: 1
    }
  });

  let cancelled = false;
  const bookmarkMap = new Map();

  async function startStream() {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`
        },
        body
      });

      if (!resp.ok || !resp.body) throw new Error("Stream failed");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop(); // keep incomplete last line

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "[" || trimmed === "]" || trimmed === ",") continue;
          // Each line is a JSON object (possibly prefixed with comma from array wrapper)
          const jsonStr = trimmed.startsWith(",") ? trimmed.slice(1) : trimmed;
          try {
            const msg = JSON.parse(jsonStr);
            if (msg.targetChange) continue; // connection/heartbeat message

            if (msg.documentChange) {
              const doc = msg.documentChange.document;
              const id = doc.name.split("/").pop();
              const obj = { _id: id, ...fromFirestoreFields(doc.fields) };
              bookmarkMap.set(id, obj);
              onSnapshot([...bookmarkMap.values()].sort((a, b) =>
                new Date(b.addedAt) - new Date(a.addedAt)
              ));
            }

            if (msg.documentDelete || msg.documentRemove) {
              const name = (msg.documentDelete || msg.documentRemove).document;
              const id = name.split("/").pop();
              bookmarkMap.delete(id);
              onSnapshot([...bookmarkMap.values()].sort((a, b) =>
                new Date(b.addedAt) - new Date(a.addedAt)
              ));
            }
          } catch (_) {
            // Partial JSON — will be handled next chunk
          }
        }
      }
    } catch (err) {
      if (!cancelled) onError(err);
    }
  }

  startStream();
  return () => { cancelled = true; };
}

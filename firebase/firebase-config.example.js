// Copy this file to `firebase-config.js` and fill in the values from
// your own Firebase project:
//   Firebase Console → Project settings → General → Your apps → SDK setup
//
// `firebase-config.js` is git-ignored on purpose. Never commit it.

export const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// ── Firestore data model ────────────────────────────────────────────
//
// users/{uid}
//   - email, displayName, photoURL
//   - sharedRoomId: string | null
//
// rooms/{roomId}
//   - createdBy: uid
//   - createdAt: timestamp
//   - members:   [uid, ...]            (max 2)
//   - inviteCode: string               (one-shot, deleted when room is full)
//
// rooms/{roomId}/bookmarks/{bookmarkId}
//   - url, title, favicon
//   - path: ""                         ("" = root, or "Sub/Deeper")
//   - addedBy, addedByName, addedAt
//
// rooms/{roomId}/folders/{folderId}
//   - path: "Sub/Deeper"               (full path identity)
//   - name: "Deeper"                   (leaf name)
//   - createdBy, createdAt
//
// roomInvites/{INVITE_CODE}
//   - roomId: string                   (lookup doc; world-readable, members-writable)


// ─────────────────────────────────────────────────────────────────────────────
// service-worker.js — MV3 I/O shell over background/sync-core.js
//
// Responsibilities:
//   - listen to chrome.bookmarks.* events and push deltas to Firestore
//   - poll Firestore via chrome.alarms and reconcile the local tree
//   - persist bookkeeping state (lastSynced sets, lock, recently-applied)
//   - suppress echoes between local creates triggered by reconcile and the
//     onCreated listener that fires for them
// ─────────────────────────────────────────────────────────────────────────────


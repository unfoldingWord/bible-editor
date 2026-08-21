// Pure boundary filter for the tn/tq/twl history endpoint (rows.ts). Split
// out (mirrors verseHistory.ts's standalone-module pattern) so it's directly
// regression-testable without pulling in Hono/auth/D1 — see
// rowHistoryBoundary.test.mjs.
//
// A row's (kind, book, id) primary key can outlive more than one LOGICAL row:
// issue #427 option 1 reclaims a tombstoned slot for a completely unrelated
// row master reissued that id to, writing a fresh 'create' entry at whatever
// version the reclaim landed at (NOT version 1 — the tombstoned row's own
// version carries forward). Every entry before that later 'create' is the
// OLD, dead row's history and must never reach the history endpoint: it feeds
// the "switch to vN" restore flow, and surfacing the old row's content would
// let a translator restore it into the unrelated row now occupying the slot.
//
// Every 'create' entry logged anywhere in this codebase before the reclaim
// path existed landed at version 1 (the two `logEdit(..., 1, "create", ...)`
// call sites in bookReimport.ts), so this is a no-op for every non-reclaimed
// row: bounding to "the last create onward" only ever discards something when
// a LATER create exists, which happens precisely — and only — at a reclaim
// boundary.
export function boundHistoryToLastCreate<T extends { version: number; action: string }>(
  entries: T[],
): T[] {
  const lastCreateVersion = entries.reduce(
    (max, e) => (e.action === "create" ? Math.max(max, e.version) : max),
    0,
  );
  return lastCreateVersion > 0 ? entries.filter((e) => e.version >= lastCreateVersion) : entries;
}

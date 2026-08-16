// Synchronous pin of the verse content/version an edit session diffs and
// saves against. Set from the FIRST keystroke of a session and held fixed —
// never overwritten by a later, fresher `base` — until the draft clears.
//
// Without this, a version bump that lands mid-edit (a WebSocket
// verse.updated from another tab, or the nightly source-attr reconcile)
// would rebase every subsequent keystroke's diff baseline onto content the
// user never saw. Their still-in-DOM stale text would then read as "added
// back" against the new baseline and get saved under the NEW (valid, so
// If-Match passes) version — a stale-content/fresh-version save that can
// silently resurrect deleted text. See issue #474.
//
// Split out of drafts.ts (which is side-effecting at import time — it opens
// an IndexedDB connection and registers an outbox-result listener) so this
// pure logic stays importable from a plain Node test.

export interface PinnedVerseBase {
  version: number;
  content: unknown;
}

const pinnedVerseBase = new Map<string, PinnedVerseBase>();

// Returns the pinned baseline for `key`, pinning `base` now if this is the
// first call for a new edit session (no existing pin). Callers pass the
// live/current base every time; only the first call in a session "wins" —
// later calls with a different `base` are ignored until unpinVerseBase.
export function pinVerseBase(key: string, base: PinnedVerseBase): PinnedVerseBase {
  const existing = pinnedVerseBase.get(key);
  if (existing) return existing;
  const pinned: PinnedVerseBase = { version: base.version, content: base.content };
  pinnedVerseBase.set(key, pinned);
  return pinned;
}

export function unpinVerseBase(key: string): void {
  pinnedVerseBase.delete(key);
}

export function peekPinnedVerseBase(key: string): PinnedVerseBase | undefined {
  return pinnedVerseBase.get(key);
}

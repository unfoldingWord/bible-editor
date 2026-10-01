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

// ---------- holds by draftless editors (#1060) ----------
//
// A keystroke-draft session marks itself live in drafts.ts's pendingKeys, and
// the "release if idle" paths check that set. The dual aligner's reading line
// writes no draft, so it used to pin only inside its save — by then a server
// change that landed while the translator typed in the focused box had moved
// the verse, and the save pinned the NEW version and diffed the stale
// on-screen text against it (a valid If-Match, so the other change was
// silently reverted). A hold is the reading line's stand-in for pendingKeys:
// taken on the line's first dirty keystroke, it pins the base the box was last
// synced from, and keeps the idle-release paths off the pin while the line is
// dirty.
//
// Ownership, so a hold never releases a pin something else depends on:
// - A hold that PINNED (no pin existed) owns the pin: when the last hold on the
//   key ends with release(), the pin goes, unless `canUnpin` says a draft
//   session now shares it.
// - A hold that JOINED an existing pin (a queued save's, which that op's outbox
//   exit releases, or a draft session's) leaves it alone on release(), unless
//   the owner tried to release it while the hold was live (deferUnpinToHolds),
//   which hands the release to the holds.
// - handOff() ends a hold whose edit was just queued: the queued op's outbox
//   exit (or a no-op save's own unpin) releases the pin, as for any save.
// Both are synchronous: an async release lets a keystroke land in the gap and
// lose its pin, or pulls a pin from under a save queued meanwhile.

export interface VerseBaseHold {
  // The editor went clean with nothing queued (Undo, discard, typed back,
  // resynced from the server, unmounted). Idempotent.
  release(): void;
  // The editor's edit was queued; the pin now belongs to that save. Idempotent.
  handOff(): void;
}

interface HoldState {
  holders: Set<object>;
  // The holds own the pin's release: one of them pinned it, or its owner
  // deferred an unpin to them.
  releaseOnLastLeave: boolean;
}

const holds = new Map<string, HoldState>();

export function holdVerseBase(
  key: string,
  base: PinnedVerseBase,
  canUnpin: (key: string) => boolean = () => true,
): VerseBaseHold {
  let state = holds.get(key);
  if (!state) {
    state = { holders: new Set(), releaseOnLastLeave: false };
    holds.set(key, state);
  }
  if (!pinnedVerseBase.has(key)) state.releaseOnLastLeave = true;
  pinVerseBase(key, base);
  const token = {};
  state.holders.add(token);
  const leave = (unpin: boolean) => {
    const cur = holds.get(key);
    if (!cur || !cur.holders.delete(token)) return;
    if (cur.holders.size > 0) return;
    holds.delete(key);
    if (unpin && cur.releaseOnLastLeave && canUnpin(key)) unpinVerseBase(key);
  };
  return { release: () => leave(true), handOff: () => leave(false) };
}

// An owner (a queued save's outbox exit, a no-op save) wants the pin released
// "if idle". A live draft session (drafts.ts's pendingKeys, passed in) keeps
// it. So does a live hold — its editor still shows an edit made against the
// pin — and the hold then takes over the release.
export function unpinVerseBaseIfIdleWith(key: string, draftSessionLive: boolean): void {
  if (draftSessionLive) return;
  const state = holds.get(key);
  if (state) {
    state.releaseOnLastLeave = true;
    return;
  }
  unpinVerseBase(key);
}

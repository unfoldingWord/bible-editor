// verseStructure — pure reducer for the per-chapter verse map under
// out-of-order WebSocket delivery. Framework-free so the strip-types test
// runner can fold every permutation of event order through it
// (verseStructure.test.mjs).
//
// WHY THIS EXISTS (#729). The ChapterRoom Durable Object is a plain fan-out
// with no sequence: events from different Worker requests reach a tab in
// arbitrary order. Two structural events — `verse.bridged` (deletes the
// absorbed row) and `verse.split` (recreates rows) — used to apply their
// key-set change unconditionally, and `verse.updated` applied to any verse
// with no local row. Two corruptions followed, both lasting until reload:
//
//   1. bridge then immediate split: the split event lands first and shows
//      verse 2 at its new version; the older bridge event then deletes it.
//   2. save on verse 2, then bridge: the bridge event lands first and deletes
//      2; the delayed verse.updated for 2 resurrects it beside the `1-2`
//      bridge, and its next save 404s.
//
// THE CLOCK. A verse number's row versions are strictly increasing across
// delete/recreate (PR #721: split seeds the recreated row at
// MAX(historical max, bridge version) + 1), so a deleted row's final version
// is a usable tombstone: any later event for that verse number carrying a
// version <= the tombstone is a stale echo of the dead row; anything higher
// is a genuine recreation. A DO sequence number would NOT help — it would
// faithfully preserve the wrong arrival order.
//
// RULES (per bible_version):
//   applyBridged  tombstones[removed] = max(existing, removedVersion); delete
//                 the local row only if local.version <= removedVersion; the
//                 start row is newer-wins (strictly; never below a tombstone).
//   applySplit    each recreated verse (and the start row) applies only if
//                 version > local.version (or no local) AND
//                 version > tombstones[verse] (or no tombstone).
//   applyUpdated  same gate as a split-created verse. `force` skips the
//                 newer-than-local check (the tab's own optimistic edit
//                 legitimately carries the unchanged version) but still
//                 refuses to resurrect a tombstoned verse.
//
// Tombstones are chapter-local, in-memory state that dies with a refetch:
// the server payload carries none, and after a refetch the verse map itself
// is authoritative again.

import type { ChapterPayload, VerseDto } from "../sync/api";

export interface VerseLike {
  verse: number;
  version: number;
}

/**
 * The chapter payload as held in hook state: the server's ChapterPayload plus
 * the client-only tombstone map. The server never sends `verseTombstones`, so
 * every refetch / chapter load naturally starts with none — that IS the
 * "tombstones are cleared on chapter refetch" rule.
 */
export type ChapterData = ChapterPayload & { verseTombstones?: VerseTombstones };

/**
 * Run one reducer step against a single bible_version's slice of a chapter
 * payload and write the result back. Returns `prev` itself when the step was
 * a no-op so a React setState updater can return the same object and skip
 * the render.
 */
export function reduceVerses(
  prev: ChapterData,
  bibleVersion: string,
  step: (s: VerseStructureState<VerseDto>) => VerseStructureState<VerseDto>,
): ChapterData {
  const before: VerseStructureState<VerseDto> = {
    verses: prev.verses[bibleVersion] ?? {},
    tombstones: prev.verseTombstones?.[bibleVersion] ?? {},
  };
  const after = step(before);
  if (after === before) return prev;
  const next: ChapterData = { ...prev, verses: { ...prev.verses, [bibleVersion]: after.verses } };
  if (after.tombstones !== before.tombstones) {
    next.verseTombstones = { ...(prev.verseTombstones ?? {}), [bibleVersion]: after.tombstones };
  }
  return next;
}

/** bible_version → verse number → version the row had when it was deleted. */
export type VerseTombstones = Record<string, Record<number, number>>;

export interface VerseStructureState<V extends VerseLike = VerseLike> {
  verses: Record<number, V>;
  /** verse number → version at deletion. */
  tombstones: Record<number, number>;
}

export interface ApplyUpdatedOptions {
  /**
   * Skip the newer-than-local check. For the tab's own optimistic edits, whose
   * DTO carries the pre-save version by design; the tombstone check still
   * applies so a pending local edit cannot resurrect a verse another tab has
   * already bridged away.
   */
  force?: boolean;
}

function isTombstoned(tombstones: Record<number, number>, verse: number, version: number): boolean {
  const t = tombstones[verse];
  return t != null && version <= t;
}

/**
 * Accept `incoming` for its verse slot? Newer than the local row (or no local
 * row) and newer than any tombstone for that verse number.
 */
function accepts<V extends VerseLike>(
  state: VerseStructureState<V>,
  incoming: V,
  opts?: ApplyUpdatedOptions,
): boolean {
  if (isTombstoned(state.tombstones, incoming.verse, incoming.version)) return false;
  if (opts?.force) return true;
  const local = state.verses[incoming.verse];
  return !local || incoming.version > local.version;
}

/**
 * A verse row changed content (verse.updated / PATCH result / optimistic
 * edit). Returns the same state object when nothing changes, so callers can
 * skip a re-render.
 */
export function applyUpdated<V extends VerseLike>(
  state: VerseStructureState<V>,
  incoming: V,
  opts?: ApplyUpdatedOptions,
): VerseStructureState<V> {
  if (!accepts(state, incoming, opts)) return state;
  return { verses: { ...state.verses, [incoming.verse]: incoming }, tombstones: state.tombstones };
}

/**
 * Two rows were combined: `bridge` is the start row (now carrying verse_end),
 * `removedVerse` the absorbed row's key, `removedVersion` the version that row
 * had when the server deleted it. `removedVersion` is optional only for an
 * event from an older server; without it the delete is unconditional and no
 * tombstone is recorded (today's behaviour), so the reorder protection is
 * simply absent rather than wrong.
 */
export function applyBridged<V extends VerseLike>(
  state: VerseStructureState<V>,
  bridge: V,
  removedVerse: number,
  removedVersion: number | undefined,
): VerseStructureState<V> {
  let verses = state.verses;
  let tombstones = state.tombstones;
  let changed = false;

  const local = verses[removedVerse];
  if (removedVersion == null) {
    if (local) {
      verses = { ...verses };
      delete verses[removedVerse];
      changed = true;
    }
  } else {
    const prior = tombstones[removedVerse];
    if (prior == null || removedVersion > prior) {
      tombstones = { ...tombstones, [removedVerse]: removedVersion };
      changed = true;
    }
    // A local row NEWER than the deleted one is a recreation that already
    // landed (a split event overtook this bridge event) — keep it.
    if (local && local.version <= removedVersion) {
      verses = { ...verses };
      delete verses[removedVerse];
      changed = true;
    }
  }

  // Start row: newer-wins, as before, never below a tombstone. Strictly newer:
  // a same-version row is the WS echo of a result this tab already holds (a
  // row's content never changes without a version bump), so skipping it keeps
  // the echo a no-op instead of a re-render.
  const existingStart = verses[bridge.verse];
  if (
    (!existingStart || bridge.version > existingStart.version) &&
    !isTombstoned(tombstones, bridge.verse, bridge.version)
  ) {
    verses = { ...verses, [bridge.verse]: bridge };
    changed = true;
  }

  return changed ? { verses, tombstones } : state;
}

/**
 * A bridge was broken: `start` is the de-bridged start row, `newVerses` the
 * freshly (re)created singleton rows. Each slot is gated exactly like an
 * update: strictly newer than local, strictly above any tombstone.
 */
export function applySplit<V extends VerseLike>(
  state: VerseStructureState<V>,
  start: V,
  newVerses: V[],
): VerseStructureState<V> {
  let verses = state.verses;
  let changed = false;

  const existingStart = verses[start.verse];
  if (
    (!existingStart || start.version > existingStart.version) &&
    !isTombstoned(state.tombstones, start.verse, start.version)
  ) {
    verses = { ...verses, [start.verse]: start };
    changed = true;
  }
  for (const nv of newVerses) {
    const local = verses[nv.verse];
    if (isTombstoned(state.tombstones, nv.verse, nv.version)) continue;
    if (local && nv.version <= local.version) continue;
    verses = { ...verses, [nv.verse]: nv };
    changed = true;
  }

  return changed ? { verses, tombstones: state.tombstones } : state;
}

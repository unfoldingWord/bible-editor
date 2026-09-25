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

import type { ChapterPayload, RowKind, TnRow, TqRow, TwlRow, VerseDto, VerseStatus } from "../sync/api";

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

/**
 * One reducer application, as data. The same discriminated union whichever
 * way it reaches the hook (WS event, outbox result, the tab's own bridge /
 * split result), so a step can be recorded while a refetch is in flight and
 * re-applied by `replaySteps` after the fetched payload lands. Every arm is
 * version-gated and monotone (see the RULES above), so re-applying a step
 * that already applied is a no-op, and applying it to a state that has moved
 * past it is also a no-op — replay is idempotent and safe.
 *
 * `updated` steps are always strict (never `force`): a forced optimistic edit
 * carries the pre-save version by design, and replaying it over a merged map
 * would overwrite the newer row its own PATCH just produced. The tab's
 * optimistic content is protected by `mergeRefetched` instead (equal version
 * keeps the local row), so force steps are simply not recorded.
 *
 * The remaining arms are the chapter's non-verse state (#974). The merge
 * takes tn / tq / twl membership and verse statuses from the fetch, so without
 * replay a row created while the GET was in flight vanished, one deleted in
 * that window came back, and a done toggle was reverted on screen. They are
 * recorded by useChapter for replay only (the live update stays in its own
 * updaters), and the rule is: a replayed step never overrides the fetched
 * snapshot unless it is provably newer than it.
 *   - `rowInsert` / `rowReplace` over a row the fetch already has apply only
 *     when STRICTLY newer by version. Same-version server changes (preserve /
 *     hint / trash toggles, reorder-only sort_order) cannot be ordered against
 *     the snapshot, so the fetch wins; a same-version toggle made during the
 *     window can still be reverted on screen, as before #974. `rowInsert` adds
 *     a row the fetch lacks; `rowReplace` never does (a row the server deleted
 *     must not be resurrected by an older event). A row of another chapter (a
 *     late createRow response after navigation) is never inserted. Row ids are
 *     never reused, so `rowDelete` is final. An optimistic
 *     `applyLocalRowPatch` is not recorded (like a forced verse edit).
 *   - `verseStatus` carries the server's `updated_at` and applies only when
 *     strictly newer than the fetched entry, or when the fetch has no entry
 *     for a verse that still has a row (statuses are only ever deleted by a
 *     bridge, which removes the row too). Only server-stamped statuses are
 *     recorded; a status equal-to-the-second loses to the fetch.
 *   - Lane checks and TWL order locks are NOT replayed: an unchecked lane or a
 *     cleared lock leaves no timestamp, so a delayed event cannot be proven
 *     newer than the snapshot. The fetch wins for them, as before #974.
 */
export type StructureStep =
  | {
      type: "bridged";
      bibleVersion: string;
      bridge: VerseDto;
      removedVerse: number;
      removedVersion: number | undefined;
      /** Verses whose per-verse status / lane-checks are pruned once the bridge applies. */
      absorbedVerses: number[];
    }
  | { type: "split"; bibleVersion: string; start: VerseDto; newVerses: VerseDto[] }
  | { type: "updated"; bibleVersion: string; verse: VerseDto }
  | { type: "rowInsert"; kind: RowKind; row: ChapterRow; afterId?: string }
  | { type: "rowReplace"; kind: RowKind; row: ChapterRow }
  | { type: "rowDelete"; kind: RowKind; id: string }
  | { type: "verseStatus"; verse: number; done: boolean; updatedAt: number };

type ChapterRow = TnRow | TqRow | TwlRow;

/** Verse structure steps; the rest are chapter data steps (rows, statuses). */
export function isStructureStep(step: StructureStep): boolean {
  return step.type === "bridged" || step.type === "split" || step.type === "updated";
}

/**
 * Apply one `StructureStep` to a chapter payload. Returns `prev` itself when
 * the step was a no-op (identity), so a React updater can skip the render.
 *
 * The `bridged` arm also prunes the absorbed verses' status / lane-checks —
 * they no longer exist as rows, and stale checkoffs would mislead if the
 * bridge is later split. The prune is gated on the absorbed ROW being absent
 * from the map AFTER the step, not on "state changed": `applyBridged` also
 * changes state by merely recording the tombstone while RETAINING a local row
 * newer than `removedVersion` (a recreation that overtook a reordered or
 * replayed stale bridge), and pruning there emptied a live verse's status /
 * lane-checks (review finding on #731). A retained row is never pruned. A row
 * absent both before and after (a stale echo against a freshly loaded bridge,
 * or a replay over a merge that already dropped the tombstoned fetched row)
 * still prunes: those statuses are orphans of a row that no longer exists —
 * the server deletes them post-confirm too — and would mislead on a later
 * split. When pruning, every number in `absorbedVerses` goes — the absorbed
 * row may itself have been a bridge (`3-4`, key 3, absorbed [3, 4]), so
 * numbers past the key never were row keys. verse_statuses /
 * verse_lane_checks are not bible_version scoped, so the prune is by number.
 */
export function applyStep(prev: ChapterData, step: StructureStep): ChapterData {
  switch (step.type) {
    case "updated":
      return reduceVerses(prev, step.bibleVersion, (s) => applyUpdated(s, step.verse));
    case "split":
      return reduceVerses(prev, step.bibleVersion, (s) => applySplit(s, step.start, step.newVerses));
    case "bridged": {
      const next = reduceVerses(prev, step.bibleVersion, (s) =>
        applyBridged(s, step.bridge, step.removedVerse, step.removedVersion),
      );
      if (next === prev) return prev;
      if (next.verses[step.bibleVersion]?.[step.removedVerse] != null) return next;
      const absorbed = new Set(step.absorbedVerses);
      return {
        ...next,
        verseStatuses: next.verseStatuses.filter((s) => !absorbed.has(s.verse)),
        verseLaneChecks: next.verseLaneChecks.filter((c) => !absorbed.has(c.verse)),
      };
    }
    case "rowInsert":
    case "rowReplace": {
      if (step.row.book !== prev.book || step.row.chapter !== prev.chapter) return prev;
      const list = prev[step.kind] as ChapterRow[];
      const idx = list.findIndex((r) => r.id === step.row.id);
      if (idx >= 0) {
        if (step.row.version <= list[idx].version) return prev;
        const next = list.slice();
        next[idx] = step.row;
        return { ...prev, [step.kind]: next };
      }
      if (step.type === "rowReplace") return prev;
      const after = step.afterId ? list.findIndex((r) => r.id === step.afterId) : -1;
      const next = after >= 0 ? [...list.slice(0, after + 1), step.row, ...list.slice(after + 1)] : [...list, step.row];
      return { ...prev, [step.kind]: next };
    }
    case "rowDelete": {
      const list = prev[step.kind] as ChapterRow[];
      if (!list.some((r) => r.id === step.id)) return prev;
      return { ...prev, [step.kind]: list.filter((r) => r.id !== step.id) };
    }
    case "verseStatus": {
      const existing = prev.verseStatuses.find((s) => s.verse === step.verse);
      if (existing ? step.updatedAt <= existing.updated_at : !verseHasRow(prev, step.verse)) return prev;
      const updated: VerseStatus = {
        book: prev.book,
        chapter: prev.chapter,
        verse: step.verse,
        done: step.done ? 1 : 0,
        updated_at: step.updatedAt,
      };
      const verseStatuses = existing
        ? prev.verseStatuses.map((s) => (s === existing ? updated : s))
        : [...prev.verseStatuses, updated];
      return { ...prev, verseStatuses };
    }
  }
}

// A verse number that is a row key in some bible_version (not absorbed into
// another verse's bridge).
function verseHasRow(data: ChapterData, verse: number): boolean {
  return Object.values(data.verses).some((rows) => rows[verse] != null);
}

/**
 * Re-apply, in arrival order, the steps that reached the tab while a refetch
 * was in flight. Run over `mergeRefetched(prev, fetched)`.
 *
 * WHY. `mergeRefetched` starts from the fetched map and can only judge verses
 * the server's snapshot contains. If the GET snapshotted the old `1-2` bridge
 * and a `verse.split` then created local verse 2 (v8) before the response
 * landed, verse 2 is absent from the response and the merge drops it, while
 * the split's start row 1 (v8, verse_end null) is kept as newer — an
 * impossible unbridged verse 1 with a gap until the next refresh. Replaying
 * the split restores 2 (v8): its slot is empty in the merged map and v8 is
 * above any tombstone. A phantom verse from a bridge missed while
 * DISCONNECTED has no queued step and is still dropped by the merge; replay
 * only concerns events the tab actually received during the fetch.
 *
 * An empty queue returns `state` itself.
 */
export function replaySteps(state: ChapterData, steps: readonly StructureStep[]): ChapterData {
  let s = state;
  for (const step of steps) s = applyStep(s, step);
  return s;
}

/**
 * Reconcile a refetched chapter payload with what the tab already holds.
 *
 * WHY. The WS open refetch (Shell's `onOpen`, every open incl. the first)
 * in its reconnect case fires on the same
 * `online` moment that drains the outbox, so `GET chapter` and a pending
 * `PATCH verse` are in flight together. D1 can serve the GET before the PATCH
 * commits while the PATCH's 200 (v6) still reaches the tab before the GET's
 * body (v5): an unconditional replace would then regress the verse to v5, and
 * the tab's next edit would carry `If-Match: 5` into a 409 against the user's
 * own save. Even without that jitter, a same-version fetched row would
 * overwrite the tab's force-applied optimistic content until the PATCH lands.
 *
 * RULES (per bible_version, per verse):
 *   - Start from `fetched`: a verse the server no longer has is dropped (the
 *     whole point of the reconnect refetch — a missed verse.bridged must not
 *     leave a phantom) and statuses / lane checks / locks (unversioned) are
 *     the fetched ones (provably newer row / status changes from the GET's
 *     window are replayed, #974; lane checks and locks are not).
 *   - A verse present in both keeps the LOCAL row when
 *     `local.version >= fetched.version`: equal means identical or an
 *     optimistic same-version edit whose PATCH is pending; higher means the
 *     PATCH already landed and the GET is stale. Strictly newer fetched wins.
 *   - A fetched row at or below a tombstone this tab holds is the deleted row
 *     seen through a stale read (same clock argument as `applyUpdated`) and is
 *     dropped rather than resurrected.
 *   - tn / tq / twl rows keep the local row only when it is STRICTLY newer
 *     (`mergeRowList`): with the first-open merge deferred behind the mount
 *     GET (#902) the chapter is editable while the merging GET is in flight,
 *     so a row PATCH's 200 can beat the GET's older body. Equal version takes
 *     the fetched row, unlike verses, because several server paths change a
 *     row without bumping its version (see `mergeRowList`). Rows have no
 *     tombstone: a row created or deleted after the GET's snapshot is put
 *     right by the replayed `rowInsert` / `rowDelete` step (#974).
 *   - Tombstones are cleared: the merged map is authoritative again, exactly
 *     as after a plain refetch.
 *   - The merge can only judge verses the snapshot contains. Events that
 *     arrived while the GET was in flight are re-applied over the result by
 *     `replaySteps` (see there for the mid-GET split this covers).
 *
 * Returns `fetched` itself when no local verse or row is kept (a null `prev`, or one
 * for another chapter, is a plain replace) — the refetch caller always wants
 * the fresh non-verse data, so identity-with-`prev` is never the right no-op.
 */
export function mergeRefetched(prev: ChapterData | null, fetched: ChapterPayload): ChapterData {
  if (!prev || prev.book !== fetched.book || prev.chapter !== fetched.chapter) return fetched;
  let verses: ChapterPayload["verses"] | undefined;
  for (const bibleVersion of Object.keys(fetched.verses)) {
    const fetchedRows = fetched.verses[bibleVersion];
    const localRows = prev.verses[bibleVersion];
    const tombstones = prev.verseTombstones?.[bibleVersion];
    if (!localRows && !tombstones) continue;
    let rows: Record<number, VerseDto> | undefined;
    for (const key of Object.keys(fetchedRows)) {
      const n = Number(key);
      const incoming = fetchedRows[n];
      const local = localRows?.[n];
      let keep: VerseDto | null = incoming;
      if (local && local.version >= incoming.version) keep = local;
      else if (tombstones && isTombstoned(tombstones, n, incoming.version)) keep = null;
      if (keep === incoming) continue;
      rows ??= { ...fetchedRows };
      if (keep) rows[n] = keep;
      else delete rows[n];
    }
    if (rows) {
      verses ??= { ...fetched.verses };
      verses[bibleVersion] = rows;
    }
  }
  const tn = mergeRowList(prev.tn, fetched.tn);
  const tq = mergeRowList(prev.tq, fetched.tq);
  const twl = mergeRowList(prev.twl, fetched.twl);
  if (!verses && tn === fetched.tn && tq === fetched.tq && twl === fetched.twl) return fetched;
  return { ...fetched, verses: verses ?? fetched.verses, tn, tq, twl };
}

// tn / tq / twl rows: a row present in both keeps the local object only when
// `local.version > incoming.version` — the tab's own PATCH landed (the outbox
// 200 replaced the row with the server's newer copy) and the GET is stale.
// Equal version takes the fetched row, as a plain replace always did: tn
// trash/restore, preserve/hint toggles, the reorder-only sort_order path, the
// review-flag clear (api/src/rows.ts) and nightly TWL order canonicalization
// (api/src/twlSortOrderApply.ts) change a row without bumping its version, so
// at equal version the fetched row may carry changes the tab lacks (the same
// carve-out as components/rowUpsertGuard.ts, #671). This makes the merge
// never worse than a plain replace. Fetched order and membership win: a row
// the server no longer has is dropped, and a local-only row is not kept (row
// events from the GET's window are replayed over this by `replaySteps`).
// Returns `fetched` itself when nothing local is kept.
function mergeRowList<R extends { id: string; version: number }>(local: readonly R[], fetched: R[]): R[] {
  const byId = new Map(local.map((r) => [r.id, r]));
  let out: R[] | undefined;
  fetched.forEach((incoming, i) => {
    const mine = byId.get(incoming.id);
    if (mine && mine !== incoming && mine.version > incoming.version) (out ??= fetched.slice())[i] = mine;
  });
  return out ?? fetched;
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

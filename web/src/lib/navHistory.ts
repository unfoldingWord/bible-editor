// Navigation history for the editor: where the translator was, down to the note.
//
// The point is to make leaving a spot safe. People stay put because wandering
// off (scrolling, changing chapter, opening another note) loses their place, so
// this keeps a short list of places they were and lets them jump to any in one
// click.
//
// The list is a general history, not a stack. Jumping to an entry does not
// throw away the entries after it: the spot you left joins the list and the
// "you are here" marker moves, so you can go forward again as well as back.
//
// A place is only recorded once the person has *settled* there for a moment.
// Scrolling through ten verses must not bury the spot they were working on
// under ten entries, so a spot that was passed through quickly never becomes an
// entry; the one they had been sitting on does.

export type NavRowKind = "tn" | "tq" | "twl";

export interface NavSpot {
  book: string;
  chapter: number;
  verse: number;
  // Set when a resource row (note / question / word link) was the focus.
  kind?: NavRowKind;
  rowId?: string;
  // Short text shown in the menu so entries are recognisable ("Fear not…").
  hint?: string;
}

// How long a spot must be held before leaving it records it.
export const SETTLE_MS = 2500;
// The list never grows past this.
export const MAX_ENTRIES = 10;
// At most this many entries share one chapter. Within a chapter the ones kept
// are the newest plus the ones farthest apart in verse (1 and 17 beat 15, 16
// and 17), because neighbouring verses are easy to scroll between anyway.
export const MAX_PER_CHAPTER = 3;
// How long after a jump its own transitional positions are still ignored.
// Generous: a chapter or book can take a while to load (or a tab sit in the
// background) before the jump lands.
const RESTORE_MS = 20000;

export function sameSpot(a: NavSpot, b: NavSpot): boolean {
  return (
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.verse === b.verse &&
    (a.kind ?? null) === (b.kind ?? null) &&
    (a.rowId ?? null) === (b.rowId ?? null)
  );
}

export interface NavView {
  // Oldest → newest.
  entries: readonly NavSpot[];
  // Where "you are here" sits: entries[0..here) are back, entries[here..] are
  // forward. Equal to entries.length when there is nothing ahead.
  here: number;
}

// Trim to the per-chapter and overall limits, keeping `here` pointing at the
// same gap. Pure, so the choice of what to keep is testable.
export function prune(entries: readonly NavSpot[], here: number): NavView {
  const drop = new Set<number>();

  const byChapter = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const k = `${e.book}:${e.chapter}`;
    byChapter.set(k, [...(byChapter.get(k) ?? []), i]);
  });
  for (const idxs of byChapter.values()) {
    if (idxs.length <= MAX_PER_CHAPTER) continue;
    const kept = [idxs[idxs.length - 1]];
    const rest = idxs.slice(0, -1);
    while (kept.length < MAX_PER_CHAPTER) {
      let best = -1;
      let bestGap = -1;
      for (const i of rest) {
        if (kept.includes(i)) continue;
        const gap = Math.min(...kept.map((k) => Math.abs(entries[k].verse - entries[i].verse)));
        // Larger gap wins; on a tie the more recent entry (higher index).
        if (gap > bestGap || (gap === bestGap && i > best)) {
          best = i;
          bestGap = gap;
        }
      }
      kept.push(best);
    }
    for (const i of idxs) if (!kept.includes(i)) drop.add(i);
  }

  const live = entries.map((_, i) => i).filter((i) => !drop.has(i));
  for (const i of live.slice(0, Math.max(0, live.length - MAX_ENTRIES))) drop.add(i);

  const out: NavSpot[] = [];
  let newHere = 0;
  entries.forEach((e, i) => {
    if (drop.has(i)) return;
    if (i < here) newHere++;
    out.push(e);
  });
  return { entries: out, here: newHere };
}

export interface NavHistory {
  // Report where the person is now. Call on every change of position.
  observe(spot: NavSpot): void;
  // The list plus the "you are here" marker. Same object until something changes.
  view(): NavView;
  // Jump to entry `index` (oldest-first index into view().entries). The spot
  // being left joins the list and the marker moves to where the target was.
  // Returns the target, or undefined for a bad index.
  takeAt(index: number): NavSpot | undefined;
  subscribe(fn: () => void): () => void;
}

// Where the list is kept between page loads. sessionStorage fits: it survives
// a reload and the browser's own back/forward, but stays per tab, so two tabs
// don't trample each other's trail.
export interface NavStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "bible-editor.navHistory.v2";
const OLD_STORAGE_KEY = "bible-editor.navHistory.v1";

function isSpot(x: unknown): x is NavSpot {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.book === "string" &&
    /^[A-Za-z0-9]{3}$/.test(s.book) &&
    Number.isInteger(s.chapter) &&
    (s.chapter as number) >= 0 &&
    Number.isInteger(s.verse) &&
    (s.verse as number) >= 0 &&
    (s.kind === undefined || s.kind === "tn" || s.kind === "tq" || s.kind === "twl") &&
    (s.rowId === undefined || typeof s.rowId === "string") &&
    (s.hint === undefined || typeof s.hint === "string")
  );
}

function load(storage: NavStorage | undefined): NavView {
  const empty: NavView = { entries: [], here: 0 };
  if (!storage) return empty;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed) {
      // A tab that saved its history before the marker existed (v1: a bare
      // array, everything behind you).
      const old: unknown = JSON.parse(storage.getItem(OLD_STORAGE_KEY) ?? "null");
      if (!Array.isArray(old)) return empty;
      const entries = old.filter(isSpot);
      return prune(entries, entries.length);
    }
    if (typeof parsed !== "object") return empty;
    const raw = (parsed as { entries?: unknown; here?: unknown });
    if (!Array.isArray(raw.entries)) return empty;
    const entries = raw.entries.filter(isSpot);
    const here = Number.isInteger(raw.here) ? Math.min(Math.max(raw.here as number, 0), entries.length) : entries.length;
    return prune(entries, here);
  } catch {
    return empty;
  }
}

export function createNavHistory(
  now: () => number = Date.now,
  storage?: NavStorage,
): NavHistory {
  let state: NavView = load(storage);
  let current: NavSpot | null = null;
  let since = 0;
  // After a jump: where we expect to land. Positions seen on the way there
  // (a chapter loading with the old verse) are not real departures.
  let restoring: { spot: NavSpot; at: number } | null = null;
  // The spot a jump landed on is worth recording even if left within SETTLE_MS.
  let landed: NavSpot | null = null;
  const listeners = new Set<() => void>();

  const set = (next: NavView) => {
    state = next;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ entries: next.entries, here: next.here }));
    } catch {
      // Storage full or blocked: the in-memory history still works.
    }
    listeners.forEach((fn) => fn());
  };

  return {
    observe(spot) {
      const t = now();
      if (restoring && t - restoring.at < RESTORE_MS) {
        // The row may be gone by now (Shell then lands on its verse), so the
        // verse is what counts as arriving.
        const r = restoring.spot;
        const arrived = spot.book === r.book && spot.chapter === r.chapter && spot.verse === r.verse;
        if (arrived) {
          landed = spot;
          restoring = null;
        }
        current = spot;
        since = t;
        return;
      }
      restoring = null;

      if (current && sameSpot(current, spot)) {
        // Same place, maybe a refreshed hint (the note's text changed).
        current = { ...current, hint: spot.hint ?? current.hint };
        if (landed) landed = current;
        return;
      }
      // Opening a note inside the verse you were on narrows that spot rather
      // than leaving it, so the bare verse is not worth an entry of its own.
      const narrowed =
        current !== null &&
        !current.kind &&
        !!spot.kind &&
        current.book === spot.book &&
        current.chapter === spot.chapter &&
        current.verse === spot.verse;
      let entries = [...state.entries];
      const settled = current !== null && (t - since >= SETTLE_MS || (landed !== null && sameSpot(landed, current)));
      if (current && settled && !narrowed) {
        entries = entries.filter((e) => !sameSpot(e, current!));
        entries.push(current);
      }
      // Arriving at a place the list already holds (got there by hand)
      // retires that entry: the list never offers the place you stand on.
      entries = entries.filter((e) => !sameSpot(e, spot));
      landed = narrowed && landed ? spot : null;
      const firstSight = current === null;
      current = spot;
      since = t;
      // Moving on by hand puts the marker back at the newest end; whatever was
      // ahead of it stays in the list as ordinary recent places.
      // The first position seen after a page load is not a move: leave the
      // restored marker where it was (minus any entry it just retired).
      const next = prune(
        entries,
        firstSight
          ? state.entries.slice(0, state.here).filter((e) => !sameSpot(e, spot)).length
          : entries.length,
      );
      const same =
        next.here === state.here &&
        next.entries.length === state.entries.length &&
        next.entries.every((e, i) => e === state.entries[i]);
      if (!same) set(next);
    },
    view: () => state,
    takeAt(index) {
      const target = state.entries[index];
      if (!target) return undefined;
      // A second jump before the first has landed leaves from where the first
      // was going, not from a position seen on the way.
      const t = now();
      const leaving = restoring && t - restoring.at < RESTORE_MS ? restoring.spot : current;
      const items = state.entries.map((spot, i) => ({ spot, target: i === index, cur: false }));
      if (leaving) items.splice(state.here, 0, { spot: leaving, target: false, cur: true });
      // The target leaves the list (it is where we are now); an older copy of
      // the spot we are leaving goes too, the fresh one is kept.
      const entries: NavSpot[] = [];
      let here = 0;
      let passedTarget = false;
      for (const it of items) {
        if (it.target) {
          passedTarget = true;
          continue;
        }
        if (!it.cur && leaving && sameSpot(it.spot, leaving)) continue;
        entries.push(it.spot);
        if (!passedTarget) here++;
      }
      const next = prune(entries, here);
      restoring = { spot: target, at: t };
      landed = null;
      set(next);
      return target;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

// One history for the whole app: Shell remounts when the book changes, and the
// history has to outlive that.
export const navHistory: NavHistory = createNavHistory(
  Date.now,
  (() => {
    try {
      return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
    } catch {
      return undefined;
    }
  })(),
);

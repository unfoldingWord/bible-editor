// "Back" history for the editor: where the translator was, down to the note.
//
// The point is to make leaving a spot safe. People stay put because wandering
// off (scrolling, changing chapter, opening another note) loses their place, so
// this keeps a stack of places they were and lets them jump back in one click.
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
// Oldest entries fall off past this.
export const MAX_ENTRIES = 25;
// How long after a Back its own departure is still ignored.
const SUPPRESS_MS = 5000;

export function sameSpot(a: NavSpot, b: NavSpot): boolean {
  return (
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.verse === b.verse &&
    (a.kind ?? null) === (b.kind ?? null) &&
    (a.rowId ?? null) === (b.rowId ?? null)
  );
}

export interface NavHistory {
  // Report where the person is now. Call on every change of position.
  observe(spot: NavSpot): void;
  // Entries oldest → newest; the last one is what plain "Back" goes to.
  entries(): readonly NavSpot[];
  // Take entry `index` (default: newest), dropping it and everything after it.
  // The departure from the current spot is NOT recorded, so pressing Back twice
  // walks further back instead of ping-ponging between two places.
  takeBack(index?: number): NavSpot | undefined;
  subscribe(fn: () => void): () => void;
}

export function createNavHistory(now: () => number = Date.now): NavHistory {
  let stack: NavSpot[] = [];
  let current: NavSpot | null = null;
  let since = 0;
  // Set by takeBack: the next departure belongs to the Back jump itself.
  let suppressDeparture = false;
  let suppressedAt = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

  return {
    observe(spot) {
      if (current && sameSpot(current, spot)) {
        // Same place, maybe a refreshed hint (the note's text changed).
        current = { ...current, hint: spot.hint ?? current.hint };
        return;
      }
      const t = now();
      let changed = false;
      // Opening a note inside the verse you were on narrows that spot rather
      // than leaving it, so the bare verse is not worth an entry of its own.
      const narrowed =
        current !== null &&
        !current.kind &&
        !!spot.kind &&
        current.book === spot.book &&
        current.chapter === spot.chapter &&
        current.verse === spot.verse;
      // The flag expires: a Back that lands where nothing changes never calls
      // observe, and must not swallow some later, unrelated departure.
      const suppressed = suppressDeparture && t - suppressedAt < SUPPRESS_MS;
      if (current && !narrowed && !suppressed && t - since >= SETTLE_MS) {
        const top = stack[stack.length - 1];
        if (!top || !sameSpot(top, current)) {
          stack = [...stack, current].slice(-MAX_ENTRIES);
          changed = true;
        }
      }
      suppressDeparture = false;
      // Arriving at a place the stack already points to (walked back by hand)
      // retires that entry: Back should never offer the place you stand on.
      const kept = stack.filter((e) => !sameSpot(e, spot));
      if (kept.length !== stack.length) {
        stack = kept;
        changed = true;
      }
      current = spot;
      since = t;
      if (changed) emit();
    },
    entries: () => stack,
    takeBack(index) {
      const i = index ?? stack.length - 1;
      const target = stack[i];
      if (!target) return undefined;
      stack = stack.slice(0, i);
      suppressDeparture = true;
      suppressedAt = now();
      emit();
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
export const navHistory: NavHistory = createNavHistory();

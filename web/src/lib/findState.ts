// Persisted Find-overlay state so a Find session survives the ScriptureColumn
// remount that a chapter change forces.
//
// Background (the bug this fixes): useChapter nulls its payload on every
// (book, chapter) change — the #531 stale-content guard — which trips Shell's
// `!data` gate and unmounts ScriptureColumn, and with it the whole Find
// overlay. So clicking "next" across a chapter boundary (or any manual chapter
// move with Find open) used to drop BOTH the bar and the typed query, forcing
// the user to retype after every couple of matches. We can't keep the payload
// (that would reopen #531), so instead we reseed the open flag and the query
// from storage when ScriptureColumn/the overlay remount.
//
// sessionStorage (not localStorage): a Find session is tab-scoped and should
// not resurrect days later. Scoped to a single book — switching books starts
// fresh — since the disappearance only spans chapters within one book.

const OPEN_KEY = "be:find-open";
const DRAFT_KEY = "be:find-draft";

export interface FindDraft {
  find: string;
  replace: string;
  regex: boolean;
  caseSensitive: boolean;
  strongs: boolean;
}

const EMPTY_DRAFT: FindDraft = {
  find: "",
  replace: "",
  regex: false,
  caseSensitive: false,
  strongs: false,
};

// The typed query for `book`, or an empty draft when nothing is stored / the
// stored draft belongs to a different book.
export function loadFindDraft(book: string): FindDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { book?: string } & Partial<FindDraft>;
      if (p.book === book) {
        return {
          find: typeof p.find === "string" ? p.find : "",
          replace: typeof p.replace === "string" ? p.replace : "",
          regex: !!p.regex,
          caseSensitive: !!p.caseSensitive,
          strongs: !!p.strongs,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { ...EMPTY_DRAFT };
}

export function saveFindDraft(book: string, draft: FindDraft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ book, ...draft }));
  } catch {
    /* ignore */
  }
}

// Whether the Find bar was open for `book` when ScriptureColumn last unmounted.
// A deliberate close clears it; an involuntary remount (chapter change) leaves
// it set so the bar reopens on its own.
export function loadFindOpen(book: string): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === book;
  } catch {
    return false;
  }
}

export function saveFindOpen(book: string, open: boolean) {
  try {
    if (open) sessionStorage.setItem(OPEN_KEY, book);
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* ignore */
  }
}

// Deliberate close: forget both the open flag and the typed query so the next
// Ctrl/Cmd+F starts fresh.
export function clearFindState() {
  try {
    sessionStorage.removeItem(OPEN_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

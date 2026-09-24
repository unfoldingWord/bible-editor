// useBookLocks — fetches the full book list (with lock state) once on mount
// so the Shell can gate the currently-open book read-only and the
// BookLocksDialog can list/toggle every book's lock. One fetch covers both
// consumers; `refresh` lets the dialog re-pull after a lock/unlock mutation.

import { useCallback, useEffect, useState } from "react";
import { api, type BookListEntry } from "../sync/api";

export interface UseBookLocksReturn {
  books: BookListEntry[];
  canManageLocks: boolean;
  lockedSet: Set<string>;
  refresh: () => void;
}

// How long a re-focus/visibility trigger must wait after the last load before
// it's allowed to fire another one. Module-level (not a ref) so it survives
// this hook remounting on book navigation (Shell is keyed by book). Distinct
// from a "poll" — this hook has no interval; it only refetches on
// authReady/focus, so the throttle exists purely to collapse a rapid
// alt-tab flurry into one request instead of one per refocus.
const FOCUS_RELOAD_THROTTLE_MS = 60_000;
let lastLoadAt = 0;

function sameBooks(a: BookListEntry[], b: BookListEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.book !== y.book ||
      x.locked !== y.locked ||
      x.lockReason !== y.lockReason ||
      x.lockSource !== y.lockSource ||
      x.imported_at !== y.imported_at
    ) {
      return false;
    }
  }
  return true;
}

export function useBookLocks(authReady: boolean): UseBookLocksReturn {
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [canManageLocks, setCanManageLocks] = useState(false);

  const load = useCallback(() => {
    lastLoadAt = Date.now();
    api
      .getBooks()
      .then((r) => {
        setBooks((prev) => (sameBooks(prev, r.books) ? prev : r.books));
        setCanManageLocks((prev) => (prev === r.canManageLocks ? prev : r.canManageLocks));
      })
      .catch(() => {
        // Fail open on the client: an unknown list must not make the whole
        // app read-only. The server is the sole authority on locks (any
        // write to a locked book still 423s there), so a failed fetch here
        // only means the UI can't pre-emptively gray out an input — not
        // that anything actually becomes unsafe to write.
        setBooks((prev) => (prev.length === 0 ? prev : []));
        setCanManageLocks((prev) => (prev === false ? prev : false));
      });
  }, []);

  // Gated on authReady, same reasoning as useAlerts: GET /api/books has no
  // auth middleware, so firing it before the auth cookie/token is actually
  // set succeeds with canManageLocks: false (no error, so .catch never sees
  // it) instead of failing loudly. That latched a real lock admin into
  // "Only Benjamin, Rich, or Perry can change book locks" until the next
  // focus/reload. Waiting for authReady and refetching when it flips true
  // (e.g. after a silent token refresh) fixes both the dev first-load race
  // and the prod expired-cookie case.
  useEffect(() => {
    if (!authReady) return;
    load();
  }, [authReady, load]);

  // Re-pull when the tab regains focus. Without this, a lock set by SOMEONE
  // ELSE never reaches an already-open session: a lock applied after mount
  // stays invisible until the next fetch, and the editor keeps offering edits
  // that the server then refuses with 423. Verified in a browser: locking via
  // the API with the tab open left the verse editable until reload.
  //
  // (Book navigation happens to re-fetch anyway — App renders <Shell
  // key={book}>, so changing book remounts Shell and this hook with it. That
  // is incidental, not something to rely on: the fetch returns every book's
  // lock state, so correctness here doesn't depend on remounting.)
  //
  // Focus is the cheap 90% fix (lock, switch tab, come back). The remaining
  // gap is a lock landing while the translator is actively working in the same
  // tab, where the server's 423 is the backstop.
  useEffect(() => {
    if (!authReady) return;
    const onFocus = () => {
      if (Date.now() - lastLoadAt < FOCUS_RELOAD_THROTTLE_MS) return;
      load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [authReady, load]);

  // Empty when the list is unknown (see the catch above) — never assume a
  // book is locked just because we don't know.
  const lockedSet = new Set(books.filter((b) => b.locked).map((b) => b.book));

  return { books, canManageLocks, lockedSet, refresh: load };
}

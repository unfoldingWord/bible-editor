// useBookLocks — fetches the full book list (with lock state) once on mount
// so the Shell can gate the currently-open book read-only and the
// BookLocksDialog can list/toggle every book's lock. One fetch covers both
// consumers; `refresh` lets the dialog re-pull after a lock/unlock mutation.

import { useCallback, useEffect, useState } from "react";
import { api, type BookListEntry } from "../sync/api";
import { createRefocusThrottle } from "../sync/refocusThrottle";

export interface UseBookLocksReturn {
  books: BookListEntry[];
  canManageLocks: boolean;
  lockedSet: Set<string>;
  refresh: () => void;
}

// A window refocus refetches only when no fetch has succeeded in this window
// (#897). Deliberately shorter than the 60 s the polled hooks use: this hook
// has no poll, so focus is its only way to learn about a lock someone else
// set, and a 60 s window could hide that lock for a minute after a quick
// alt-tab. 15 s still collapses a burst of alt-tabs; the server's 423 on a
// write to a locked book stays the backstop either way.
const refocusThrottle = createRefocusThrottle(15_000);

function sameBooks(a: BookListEntry[], b: BookListEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.book === b[i].book &&
        x.imported_at === b[i].imported_at &&
        x.locked === b[i].locked &&
        x.lockReason === b[i].lockReason &&
        x.lockSource === b[i].lockSource,
    )
  );
}

export function useBookLocks(authReady: boolean): UseBookLocksReturn {
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [canManageLocks, setCanManageLocks] = useState(false);

  // Keeps the previous array when the list is unchanged, so a refocus that
  // learns nothing new does not re-render Shell (#897).
  const load = useCallback(() => {
    api
      .getBooks()
      .then((r) => {
        refocusThrottle.markSuccess();
        setBooks((prev) => (sameBooks(prev, r.books) ? prev : r.books));
        setCanManageLocks(r.canManageLocks);
      })
      .catch(() => {
        // Fail open on the client: an unknown list must not make the whole
        // app read-only. The server is the sole authority on locks (any
        // write to a locked book still 423s there), so a failed fetch here
        // only means the UI can't pre-emptively gray out an input — not
        // that anything actually becomes unsafe to write.
        setBooks((prev) => (prev.length === 0 ? prev : []));
        setCanManageLocks(false);
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
      if (refocusThrottle.shouldRun()) load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [authReady, load]);

  // Empty when the list is unknown (see the catch above) — never assume a
  // book is locked just because we don't know.
  const lockedSet = new Set(books.filter((b) => b.locked).map((b) => b.book));

  return { books, canManageLocks, lockedSet, refresh: load };
}

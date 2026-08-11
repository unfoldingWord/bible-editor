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
  loading: boolean;
}

export function useBookLocks(): UseBookLocksReturn {
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [canManageLocks, setCanManageLocks] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getBooks()
      .then((r) => {
        setBooks(r.books);
        setCanManageLocks(r.canManageLocks);
      })
      .catch(() => {
        // Fail open on the client: an unknown list must not make the whole
        // app read-only. The server is the sole authority on locks (any
        // write to a locked book still 423s there), so a failed fetch here
        // only means the UI can't pre-emptively gray out an input — not
        // that anything actually becomes unsafe to write.
        setBooks([]);
        setCanManageLocks(false);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Re-pull when the tab regains focus. Without this, a lock set by SOMEONE
  // ELSE never reaches an already-open session: the mount fetch covers every
  // book at once (so ordinary book navigation needs no re-fetch), but a lock
  // applied after mount stays invisible until a reload — the editor keeps
  // offering edits that the server then refuses with 423. Verified in a
  // browser: locking via the API with the tab open left the verse editable
  // until reload. Focus is the cheap 90% fix (lock, switch tab, come back);
  // the remaining gap is a lock landing while the translator is actively
  // typing in the same tab, where the 423 + failed-op drawer is the backstop.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // Empty when the list is unknown (see the catch above) — never assume a
  // book is locked just because we don't know.
  const lockedSet = new Set(books.filter((b) => b.locked).map((b) => b.book));

  return { books, canManageLocks, lockedSet, refresh: load, loading };
}

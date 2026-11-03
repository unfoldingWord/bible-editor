import { useCallback, useEffect, useState } from "react";
import { fetchT4tUsfm, type VerseDto } from "../sync/api";
import { parseT4tBook } from "../lib/t4t";
import { createT4tLoader } from "../lib/t4tLoader";

export type T4tBook = Map<number, Record<number, VerseDto>>;

const loadT4t = createT4tLoader(fetchT4tUsfm, parseT4tBook);

export type T4tState = {
  // The read-only T4T book, or null while disabled / loading / failed.
  verses: T4tBook | null;
  // True when the last load for this book failed (shown as "T4T unavailable").
  failed: boolean;
  retry: () => void;
};

// Fetches only when `enabled` (the user turned T4T on in the version picker).
export function useT4t(book: string, enabled: boolean): T4tState {
  const [data, setData] = useState<{ book: string; verses: T4tBook } | null>(null);
  const [failedBook, setFailedBook] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !book) return;
    let cancelled = false;
    setFailedBook(null);
    loadT4t(book).then(
      (verses) => {
        if (!cancelled) setData({ book, verses });
      },
      (err) => {
        console.warn("T4T load failed", book, err);
        if (!cancelled) setFailedBook(book);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [book, enabled, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    verses: enabled && data?.book === book ? data.verses : null,
    failed: enabled && failedBook === book,
    retry,
  };
}

import { useEffect, useState } from "react";
import { fetchT4tUsfm, type VerseDto } from "../sync/api";
import { parseT4tBook } from "../lib/t4t";

export type T4tBook = Map<number, Record<number, VerseDto>>;

// Parsed T4T books, cached per book for the session (the text is static).
const cache = new Map<string, T4tBook>();
const inflight = new Map<string, Promise<T4tBook>>();

function loadT4t(book: string): Promise<T4tBook> {
  const hit = cache.get(book);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(book);
  if (!p) {
    p = fetchT4tUsfm(book)
      .then((text) => {
        const parsed = parseT4tBook(book, text);
        cache.set(book, parsed);
        return parsed;
      })
      .finally(() => inflight.delete(book));
    inflight.set(book, p);
  }
  return p;
}

// The read-only T4T book, or null while disabled / loading / unavailable.
// Fetches only when `enabled` (the user turned T4T on in the version picker).
export function useT4t(book: string, enabled: boolean): T4tBook | null {
  const [data, setData] = useState<{ book: string; verses: T4tBook } | null>(null);
  useEffect(() => {
    if (!enabled || !book) return;
    let cancelled = false;
    loadT4t(book).then(
      (verses) => {
        if (!cancelled) setData({ book, verses });
      },
      (err) => {
        console.warn("T4T load failed", book, err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [book, enabled]);
  return enabled && data?.book === book ? data.verses : null;
}

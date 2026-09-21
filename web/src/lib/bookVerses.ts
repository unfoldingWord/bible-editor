// Whole-book verse fetch for client-side renders (USFM export, print
// preview). There is no book-level verses endpoint, so every chapter is
// fetched with bounded concurrency and the requested version's rows are
// concatenated in chapter order.

import { api, type VerseDto } from "../sync/api.ts";

// Cap on concurrent chapter fetches so a large book (e.g. Psalms, 150
// chapters) doesn't dispatch every request in one burst.
const FETCH_CONCURRENCY = 6;

// Run `task` over `items` with a bounded number in flight at once, preserving
// input order in the results.
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    // Stop pulling new work once any task has failed — otherwise the sibling
    // workers keep fetching the rest of the book after the caller already failed.
    while (next < items.length && !aborted) {
      const i = next++;
      try {
        results[i] = await task(items[i]);
      } catch (e) {
        aborted = true;
        throw e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function fetchBookVerses(book: string, version: string): Promise<VerseDto[]> {
  const summary = await api.getBookSummary(book);
  // The summary can list chapter 0 (book-intro notes live there), but the
  // verses table has no chapter-0 scripture, so skip it — no verse rows to
  // fetch and it would never contribute.
  const chapters = summary.chapters.filter((c) => c.chapter > 0);
  const payloads = await mapLimit(chapters, FETCH_CONCURRENCY, (c) => api.getChapter(book, c.chapter));
  const out: VerseDto[] = [];
  for (const p of payloads) {
    const byVerse = p.verses[version];
    if (byVerse) out.push(...Object.values(byVerse));
  }
  return out;
}

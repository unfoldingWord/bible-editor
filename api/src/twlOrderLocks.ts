// Per-verse TWL order locks (twl_order_locks) — which verses have had their TWL
// link order set manually and must be excluded from canonical (ULT-position)
// reordering everywhere: nightly export, reimport post-pass, and (client-side)
// the add-suggestion slot. twlCanonicalOrder.ts is deliberately a pure leaf
// module with no D1 dependency (see twTitles.ts for the same reasoning), so the
// D1 read lives here and callers load the set once per book and hand it in.
//
// A failed/unreadable lock table must not fail an export or reimport — it just
// means canonical ordering runs for every verse, which is today's (pre-lock)
// behaviour. So this is best-effort: log and return an empty Set on error.

export function twlLockKey(chapter: number, verse: number): string {
  return `${chapter}:${verse}`;
}

export async function loadTwlOrderLocks(db: D1Database, book: string): Promise<Set<string>> {
  try {
    const rs = await db
      .prepare(`SELECT chapter, verse FROM twl_order_locks WHERE book = ?1`)
      .bind(book)
      .all<{ chapter: number; verse: number }>();

    const locked = new Set<string>();
    for (const r of rs.results) locked.add(twlLockKey(r.chapter, r.verse));
    return locked;
  } catch (err) {
    console.error(`loadTwlOrderLocks failed for ${book}:`, err);
    return new Set();
  }
}

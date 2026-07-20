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

// The key format is owned by the CONSUMER (twlCanonicalOrder.ts builds the same
// key for each verse bucket and looks it up here). Defining it there and
// importing it means the two are one expression, not two string literals in two
// files that happen to agree — this gate fails OPEN, so a drifted key would
// silently reorder locked verses again with no type error and no test failure.
export { twlLockKey } from "./twlCanonicalOrder.ts";
import { twlLockKey } from "./twlCanonicalOrder.ts";

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

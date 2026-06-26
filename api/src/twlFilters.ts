// TWL suggestion deny-lists (migration 0033), served to the client so the
// per-verse Suggestions UI can suppress links translators already rejected.
//
// Filtering is CLIENT-side: both tables key on the original-language quote, and
// only the browser resolves a suggestion's ULT English span to an OL quote
// (web/src/lib/twlResolve.ts). This route just ships the raw deny-lists; the
// hook (useTwlFilters) folds them to bare consonants (hebrew.ts twlFilterKey)
// and the Shell compares. Read-only + open like twlSuggest (no write here).

import { Hono } from "hono";
import type { Env } from "./index";

export const twlFilters = new Hono<{ Bindings: Env }>();

export interface TwlUnlinkedEntry {
  normOrigWords: string;
  twLink: string;
}
export interface TwlDeletedEntry {
  reference: string; // "chapter:verse"
  normOrigWords: string;
}

// Cache the global unlinked list and per-book deleted lists at module scope.
// Signatures are COUNT(*)+MAX(last_synced) of each table (mirror twlSuggest
// getTrie): the isolate is reused across requests so most calls hit the cache,
// and a re-import busts it. NOT MAX(rowid) — the importer does DELETE-then-
// reinsert, and SQLite reuses rowids after a table is emptied, so a same-sized
// re-import would keep an unchanged rowid signature and serve stale filters.
// last_synced is stamped fresh (unixepoch()) on every import, so it always moves.
let unlinkedCache: { sig: string; rows: TwlUnlinkedEntry[] } | null = null;
const deletedCache = new Map<string, { sig: string; rows: TwlDeletedEntry[] }>();

async function tableSig(env: Env, table: string): Promise<string> {
  const meta = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COALESCE(MAX(last_synced), 0) AS m FROM ${table}`,
  ).first<{ c: number; m: number }>();
  return `${meta?.c ?? 0}:${meta?.m ?? 0}`;
}

twlFilters.get("/:book", async (c) => {
  const book = c.req.param("book").toUpperCase();

  const unlinkedSig = await tableSig(c.env, "twl_unlinked_words");
  if (!unlinkedCache || unlinkedCache.sig !== unlinkedSig) {
    const r = await c.env.DB.prepare(
      `SELECT norm_orig_words, tw_link FROM twl_unlinked_words`,
    ).all<{ norm_orig_words: string; tw_link: string }>();
    unlinkedCache = {
      sig: unlinkedSig,
      rows: r.results.map((x) => ({ normOrigWords: x.norm_orig_words, twLink: x.tw_link })),
    };
  }

  const deletedSig = await tableSig(c.env, "twl_deleted_rows");
  let dCached = deletedCache.get(book);
  if (!dCached || dCached.sig !== deletedSig) {
    const r = await c.env.DB.prepare(
      `SELECT reference, norm_orig_words FROM twl_deleted_rows WHERE book = ?`,
    )
      .bind(book)
      .all<{ reference: string; norm_orig_words: string }>();
    dCached = {
      sig: deletedSig,
      rows: r.results.map((x) => ({ reference: x.reference, normOrigWords: x.norm_orig_words })),
    };
    deletedCache.set(book, dCached);
  }

  return c.json({ unlinked: unlinkedCache.rows, deleted: dCached.rows });
});

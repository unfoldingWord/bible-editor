// Per-verse TWL suggestions. Scans the verse's ULT English with the ported
// headword matcher (twlMatcher.ts, built from the canonical en_tw catalog in
// tw_articles) and returns candidate links the verse doesn't already carry.
// The editor turns each suggestion's English span into an original-language
// quote + occurrence in the browser via web/src/lib/twlResolve.ts (the in-app
// equivalent of node-twl-generator's tsv-quote-converters step), then promotes
// it with the normal createRow("twl") path. Read-only + open like chapters/
// catalogs (global attachAuth stamps userId; no write here).

import { Hono } from "hono";
import type { Env } from "./index";
import {
  buildTermMapFromArticles,
  buildTermTrie,
  scanVerseMatches,
  type TwArticleLite,
} from "./twlMatcher";

export const twlSuggest = new Hono<{ Bindings: Env }>();

// Building the trie over ~950 articles + variants is non-trivial, so cache it
// at module scope and rebuild only when the catalog changes (count or newest
// last_synced). The Worker isolate is reused across requests, so most calls hit
// the cache.
let trieCache: { sig: string; trie: ReturnType<typeof buildTermTrie> } | null = null;

async function getTrie(env: Env) {
  const meta = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COALESCE(MAX(last_synced), 0) AS m FROM tw_articles`,
  ).first<{ c: number; m: number }>();
  const sig = `${meta?.c ?? 0}:${meta?.m ?? 0}`;
  if (trieCache && trieCache.sig === sig) return trieCache.trie;
  const rows = await env.DB.prepare(`SELECT id, title FROM tw_articles`).all<TwArticleLite>();
  const trie = buildTermTrie(buildTermMapFromArticles(rows.results));
  trieCache = { sig, trie };
  return trie;
}

// Article path prefix -> the TWL Tags column value uW uses.
const TAG_BY_CATEGORY: Record<string, string> = { kt: "keyterm", names: "name", other: "" };

export interface TwlSuggestion {
  /** The English ULT span that matched (case preserved; may carry {supplied} braces). */
  matchedText: string;
  /** 1-based index of this exact (case-insensitive) span among all its occurrences in the verse. */
  glOccurrence: number;
  /** Primary article id ("kt/god"); preferredArticle for the God/falsegod case, else the first. */
  articleId: string;
  /** rc:// link for the primary article. */
  twLink: string;
  /** "keyterm" | "name" | "" — the TWL Tags value. */
  tag: string;
  /** All candidate article ids (incl. primary) — drives the disambiguation picker. */
  disambiguation: string[];
}

twlSuggest.get("/:book/:chapter/:verse", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) {
    return c.json({ error: "bad_ref" }, 400);
  }

  // ULT plain text for the verse — the matcher scans English.
  const row = await c.env.DB.prepare(
    `SELECT plain_text FROM verses WHERE book = ? AND chapter = ? AND verse = ? AND bible_version = 'ULT'`,
  )
    .bind(book, chapter, verse)
    .first<{ plain_text: string | null }>();
  const text = row?.plain_text ?? "";
  if (!text.trim()) return c.json({ suggestions: [] });

  const trie = await getTrie(c.env);
  const matches = scanVerseMatches(text, trie);

  // Links already on this verse — never re-suggest them. Counted (not just a
  // set) so a term that occurs N times but is only linked M<N times still gets
  // its remaining N−M occurrences suggested (uW writes one TWL row per
  // occurrence). We "spend" one existing link per matched occurrence in
  // document order, then suggest the rest.
  const existing = await c.env.DB.prepare(
    `SELECT tw_link, COUNT(*) AS n FROM twl_rows WHERE book = ? AND chapter = ? AND verse = ? AND deleted_at IS NULL AND tw_link IS NOT NULL GROUP BY tw_link`,
  )
    .bind(book, chapter, verse)
    .all<{ tw_link: string; n: number }>();
  const remainingExisting = new Map<string, number>();
  for (const r of existing.results) remainingExisting.set(r.tw_link, r.n);

  // GL occurrence counts every match of an exact span (case-insensitive) in
  // document order — incremented before the exclude check so it stays the true
  // Nth occurrence in the verse (what the client resolver needs to pick the
  // right instance), regardless of which occurrences are already linked.
  const occCount = new Map<string, number>();
  const suggestions: TwlSuggestion[] = [];
  for (const m of matches) {
    const key = m.matchedText.toLowerCase();
    const glOccurrence = (occCount.get(key) ?? 0) + 1;
    occCount.set(key, glOccurrence);

    const primary = m.preferredArticle ?? m.articles[0];
    if (!primary) continue;
    const twLink = `rc://*/tw/dict/bible/${primary}`;
    const covered = remainingExisting.get(twLink) ?? 0;
    if (covered > 0) {
      remainingExisting.set(twLink, covered - 1); // this occurrence is already linked
      continue;
    }

    const category = primary.split("/")[0] ?? "";
    suggestions.push({
      matchedText: m.matchedText,
      glOccurrence,
      articleId: primary,
      twLink,
      tag: TAG_BY_CATEGORY[category] ?? "",
      disambiguation: m.articles,
    });
  }

  return c.json({ suggestions });
});

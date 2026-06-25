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

  // glOccurrence: the 1-based index of each exact (case-insensitive) span among
  // its occurrences in the verse, in document order. The client resolver uses it
  // to pick the right instance.
  //
  // Excluding links the verse already has is done CLIENT-side (Shell
  // isTwlSuggestionExcluded), not here: an existing TWL row stores the
  // ORIGINAL-language occurrence, which can't be mapped to this English-text
  // occurrence on the server without the alignment. A server-side count would
  // mis-identify which occurrence is covered and could re-suggest an
  // already-linked one (or hide an unlinked occurrence). So the route returns
  // every match and the client filters by resolved (tw_link, orig_words, occurrence).
  const occCount = new Map<string, number>();
  const suggestions: TwlSuggestion[] = [];
  for (const m of matches) {
    const key = m.matchedText.toLowerCase();
    const glOccurrence = (occCount.get(key) ?? 0) + 1;
    occCount.set(key, glOccurrence);

    const primary = m.preferredArticle ?? m.articles[0];
    if (!primary) continue;
    const category = primary.split("/")[0] ?? "";
    suggestions.push({
      matchedText: m.matchedText,
      glOccurrence,
      articleId: primary,
      twLink: `rc://*/tw/dict/bible/${primary}`,
      tag: TAG_BY_CATEGORY[category] ?? "",
      disambiguation: m.articles,
    });
  }

  return c.json({ suggestions });
});

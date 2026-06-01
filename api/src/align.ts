import { Hono } from "hono";
import type { Env } from "./index";

// Alignment suggestions over the precomputed alignment-memory frequency table
// (align_freq, populated offline by scripts/train-aligner.mjs from the gold
// `\zaln-s` alignments in the published ULT/UST). The engine ("wordMAP") never
// runs in the Worker — at request time we do a single indexed D1 lookup and
// rank by corpus frequency, with a lexicon gloss/definition fallback for
// source Strong's the canonical corpus never aligned.
//
// Stateless + verse-agnostic on purpose: the client sends the unaligned source
// Strong's, gets ranked candidate target surfaces back, and does the
// word-bank intersection itself. That keeps unsaved edits client-side and lets
// the response cache by (bible, strongs).

export const align = new Hono<{ Bindings: Env }>();

// Same normalization as lexicon.ts / web normalizeStrong: pull the first
// [HG]\d+[a-z]? token (drops clitic prefixes like "b:" / "l:"), strip leading
// zeros, and offer the alpha-stripped base as a fallback key ("H2148a" ->
// ["H2148a","H2148"]).
function strongLookupKeys(raw: string): string[] {
  if (!raw) return [];
  const m = raw.match(/[HG]\d+[a-z]?/i);
  if (!m) return [];
  const exact = m[0].toUpperCase().replace(/^([HG])0+/, "$1");
  const base = exact.replace(/[A-Z]$/, "");
  return exact === base ? [exact] : [exact, base];
}

// Map an align_freq Strong's key to candidate lexicon_entries keys. Hebrew and
// classic Greek resolve directly; unfoldingWord Greek is Strong's-Plus
// (classic × 10, 5+ digits — e.g. G23160 = θεός = classic G2316), but
// lexicon_entries is keyed by classic Strong's, so also offer the /10 form.
function lexiconKeysFor(strong: string): string[] {
  const out = [strong];
  const m = strong.match(/^G(\d{5,})$/);
  if (m) {
    const classic = Math.floor(parseInt(m[1], 10) / 10);
    if (classic > 0) out.push(`G${classic}`);
  }
  return out;
}

interface Candidate {
  surface: string;
  confidence: number; // 0..1
  source: "memory" | "lexicon";
  count?: number; // corpus frequency (memory only)
}

interface Phrase {
  phrase: string; // e.g. "the earth"
  tokens: string[]; // ["the","earth"]
  confidence: number; // 0..1, share among this strong's phrases
  count: number;
}

// Per-strong response: single-word candidates plus the multi-word gold phrases
// that strong aligns to. The client prefers a phrase when its tokens appear as
// a contiguous unaligned run in the verse, else falls back to the top word.
interface Suggestion {
  words: Candidate[];
  phrases: Phrase[];
}

// Function words that pollute lexicon-definition tokenization. The frequency
// (memory) path doesn't need this — it learns that, say, the article maps to
// "the" with high confidence — but raw definition prose is full of glue words.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "at", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "that", "this", "these",
  "those", "it", "its", "as", "by", "from", "into", "out", "up", "down", "who",
  "whom", "which", "what", "when", "where", "while", "than", "then", "so", "such",
  "not", "no", "nor", "but", "if", "etc", "eg", "ie", "used", "use",
  // Structural labels that leak from the bundled Strong's definition prose
  // ("Meaning:", "Usage:", "Source:", part-of-speech words). They never match
  // real target text, but drop them so the fallback list stays clean.
  "meaning", "usage", "source", "speech", "aramaic", "hebrew", "greek",
  "transliteration", "corresponding", "compare", "figuratively", "literally",
  "properly", "primitive", "denominative",
]);

// Tokenize gloss (weighted higher) + definition into candidate surfaces. Words
// shorter than 3 chars and stopwords are dropped; first occurrence wins.
function lexiconCandidates(gloss: string | null, definition: string | null): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (text: string | null, conf: number) => {
    if (!text) return;
    for (const tokRaw of text.toLowerCase().split(/[^a-z']+/)) {
      const tok = tokRaw.replace(/^'+|'+$/g, "");
      if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      out.push({ surface: tok, confidence: conf, source: "lexicon" });
    }
  };
  add(gloss, 0.3);
  add(definition, 0.18);
  return out.slice(0, 12);
}

const MAX_CANDIDATES = 8;
const MAX_PHRASES = 6;
const HAS_SPACE = /\s/; // phrase surfaces contain a space; single words don't
// D1 caps prepared statements at 100 bind variables. The memory query also
// binds `bible` at ?1, so keep strong chunks under that.
const STRONG_CHUNK = 90;

align.get("/suggest", async (c) => {
  const bible = (c.req.query("bible") ?? "ult").toLowerCase();
  const raw = c.req.query("strongs") ?? "";
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) return c.json({ bible, suggestions: {} });

  // normalized key -> the raw strong(s) the client asked with, so we can key
  // the response back by exactly what the caller sent.
  const keyToRaws = new Map<string, string[]>();
  for (const r of requested) {
    for (const k of strongLookupKeys(r)) {
      if (!keyToRaws.has(k)) keyToRaws.set(k, []);
      keyToRaws.get(k)!.push(r);
    }
  }
  const keys = [...keyToRaws.keys()];
  if (keys.length === 0) return c.json({ bible, suggestions: {} });

  // 1) Alignment memory: per strong, its aligned target surfaces + counts.
  const memByKey = new Map<string, { surface: string; count: number }[]>();
  for (let i = 0; i < keys.length; i += STRONG_CHUNK) {
    const chunk = keys.slice(i, i + STRONG_CHUNK);
    const placeholders = chunk.map((_v, j) => `?${j + 2}`).join(",");
    const rs = await c.env.DB.prepare(
      `SELECT strong, surface, count FROM align_freq WHERE bible = ?1 AND strong IN (${placeholders})`,
    )
      .bind(bible, ...chunk)
      .all<{ strong: string; surface: string; count: number }>();
    for (const row of rs.results ?? []) {
      const list = memByKey.get(row.strong) ?? [];
      list.push({ surface: row.surface, count: row.count });
      memByKey.set(row.strong, list);
    }
  }

  // 2) Lexicon fallback for strongs the corpus never aligned. Map each missing
  // key to its lexicon form(s) first (Greek Strong's-Plus -> classic), keeping
  // a back-reference so results re-key to what the caller asked with.
  const missing = keys.filter((k) => !memByKey.has(k));
  const lexKeyToOrig = new Map<string, string>();
  for (const k of missing) {
    for (const lk of lexiconKeysFor(k)) {
      if (!lexKeyToOrig.has(lk)) lexKeyToOrig.set(lk, k);
    }
  }
  const lexKeys = [...lexKeyToOrig.keys()];
  const lexByKey = new Map<string, Candidate[]>();
  for (let i = 0; i < lexKeys.length; i += STRONG_CHUNK) {
    const chunk = lexKeys.slice(i, i + STRONG_CHUNK);
    if (chunk.length === 0) break;
    const placeholders = chunk.map((_v, j) => `?${j + 1}`).join(",");
    const rs = await c.env.DB.prepare(
      `SELECT strong, gloss, definition FROM lexicon_entries WHERE strong IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ strong: string; gloss: string | null; definition: string | null }>();
    for (const row of rs.results ?? []) {
      const orig = lexKeyToOrig.get(row.strong);
      if (!orig || lexByKey.has(orig)) continue;
      const cands = lexiconCandidates(row.gloss, row.definition);
      if (cands.length > 0) lexByKey.set(orig, cands);
    }
  }

  // 3) Rank per key. Memory splits into single words and multi-word phrases,
  // each scored as a share within its own kind; otherwise lexicon words.
  const perKey = new Map<string, Suggestion>();
  for (const k of keys) {
    const mem = memByKey.get(k);
    if (mem && mem.length > 0) {
      const wordRows = mem.filter((m) => !HAS_SPACE.test(m.surface));
      const phraseRows = mem.filter((m) => HAS_SPACE.test(m.surface));
      const wordTotal = wordRows.reduce((a, b) => a + b.count, 0) || 1;
      const phraseTotal = phraseRows.reduce((a, b) => a + b.count, 0) || 1;
      const words = wordRows
        .map((m): Candidate => ({
          surface: m.surface,
          count: m.count,
          confidence: m.count / wordTotal,
          source: "memory",
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_CANDIDATES);
      const phrases = phraseRows
        .map((m): Phrase => ({
          phrase: m.surface,
          tokens: m.surface.split(/\s+/),
          confidence: m.count / phraseTotal,
          count: m.count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_PHRASES);
      perKey.set(k, { words, phrases });
    } else if (lexByKey.has(k)) {
      perKey.set(k, { words: lexByKey.get(k)!.slice(0, MAX_CANDIDATES), phrases: [] });
    }
  }

  const suggestions: Record<string, Suggestion> = {};
  for (const [k, raws] of keyToRaws) {
    const sugg = perKey.get(k);
    if (!sugg || (sugg.words.length === 0 && sugg.phrases.length === 0)) continue;
    for (const rw of raws) {
      if (!suggestions[rw]) suggestions[rw] = sugg;
    }
  }
  return c.json({ bible, suggestions });
});

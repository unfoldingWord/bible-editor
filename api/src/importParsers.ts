// Pure parsing helpers shared between the inbound AI-pipeline importer
// (api/src/pipelineImport.ts) and the future inbound-from-DCS path. The
// existing one-shot scripts/import-book.mjs is the historical reference;
// these helpers are now the canonical Worker-side source.

import usfm from "usfm-js";

export interface VerseExtract {
  chapter: number;
  verse: number;
  // Inclusive end of a multi-verse block (e.g. `\v 6-9` → verse=6, verseEnd=9).
  // null for singleton verses and the chapter-front pseudo-verse.
  verseEnd: number | null;
  contentJson: string;       // JSON-stringified verseObj suitable for verses.content_json
  plainText: string;
}

// Strip leading / trailing non-letter characters off a `\w` token's text,
// emitting them as adjacent text nodes. Interior content is preserved —
// `\w of the LORD\w*` (a deliberately multi-word target, see the
// Selah / Yahweh cases in docs/usfm-alignment-audit.md) stays one token;
// only the outer punctuation comes off. Without this, source USFM that
// writes `\w "What\w*` (punctuation inside the marker) produces draggable
// alignment chips labelled `"What`, `seeing?"`, etc. — see PR #47.
//
// `\w`-internal apostrophes / hyphens are NOT stripped (the algorithm
// only trims from the outside), so `don't`, `hello-world`, `LORD’s`
// stay one token.
//
// Walks recursively into children (zaln-s milestones, \qs wrappers).
// Returns a new verseObjects array; the input is left untouched so
// caller-held references stay valid.
export function normalizeWordPunctuation(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  return verseObjects.flatMap((n) => normalizeNode(n));
}

function normalizeNode(node: unknown): unknown[] {
  if (!node || typeof node !== "object") return [node];
  const o = node as Record<string, unknown>;
  if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
    const text = o["text"];
    const split = splitWordPunctuation(text);
    if (split.leading === "" && split.trailing === "") return [node];
    const out: unknown[] = [];
    if (split.leading) out.push({ type: "text", text: split.leading });
    if (split.core) out.push({ ...o, text: split.core });
    // A `\w` containing only punctuation (split.core === "") is treated
    // as plain text — the bare token had no semantic word content to
    // align anyway.
    if (split.trailing) out.push({ type: "text", text: split.trailing });
    return out;
  }
  if (Array.isArray(o["children"])) {
    return [{ ...o, children: (o["children"] as unknown[]).flatMap((c) => normalizeNode(c)) }];
  }
  return [node];
}

// Letters / marks / numbers count as "core" word content. Numbers
// matter because the UST writes literal counts (`\w 30\w*`, `\w 15\w*`)
// for measurements — treating them as punctuation would demote the
// digit tokens to plain text and break alignment to the source.
const LETTER_RE = /[\p{L}\p{M}\p{N}]/u;

function splitWordPunctuation(text: string): { leading: string; core: string; trailing: string } {
  const first = text.search(LETTER_RE);
  if (first < 0) return { leading: text, core: "", trailing: "" };
  let last = first;
  for (let i = text.length - 1; i >= first; i--) {
    if (LETTER_RE.test(text[i])) {
      last = i;
      break;
    }
  }
  return {
    leading: text.slice(0, first),
    core: text.slice(first, last + 1),
    trailing: text.slice(last + 1),
  };
}

// ─── De-glue AI-introduced punctuation-spanning word tokens ──────────────
//
// The AI/tC aligner sometimes emits a single `\w` that swallowed boundary
// punctuation AND the next clause's first word, nested inside the PREVIOUS
// source word's `\zaln-s` — e.g. `\w out”—the\w*` (aligned to הוֹצֵאתִיהָ in
// ZEC 5:4) or `\w Armies—“and\w*`. normalizeWordPunctuation deliberately
// can't touch these (both ends are letters, so its outer-strip is a no-op,
// and interior content is preserved to keep legit multi-word targets like
// `\w of the LORD\w*` intact). This is the sibling defect to the malformed
// `x-occurrence` handled by effectiveOccurrence() in web/src/lib/alignment.ts.
//
// We split such a token on its interior boundary punctuation and lift every
// fragment out of its `\zaln-s`, so the words fall into the word bank as
// UNALIGNED for a human to re-align (matching gatewayEdit); the rest of each
// group keeps its alignment. Runs at import (extractVersesForRange) so
// AI-drafted and DCS content lands clean; the one-time cleanup script in
// scripts/normalize-verse-punctuation.mjs imports this same function. The
// lift / strip helpers below mirror the originals in web/src/lib/replace.ts —
// keep them in sync.

// Boundary punctuation that marks a clause break when it sits INSIDE a `\w`
// flanked by word content: double quotes (straight + curly), guillemets, and
// em / en dashes. NOT apostrophes / hyphens (intra-word: don't, hello-world)
// and NOT spaces (legit multi-word targets). A run of these is a split point.
const BOUNDARY_RUN_RE = /["“”«»—–]+/g;
const WORD_CONTENT_RE = /[\p{L}\p{M}]/u;

// Split a `\w` text into [word][punct-run][word]… segments, each emitted as a
// node marked `__edited` so liftEditedOutOfZaln pops it out of the enclosing
// `\zaln-s`. Returns null when the token is not glued (fewer than two
// letter-bearing word segments) so callers leave it untouched — dash/quote
// runs between digit-only segments (number ranges like "1914–1918") yield <2
// letter-bearing segments → null. Marking the punct text `__edited` too avoids
// leaving a degenerate punctuation-only milestone between the lifted words.
function splitGluedNode(node: Record<string, unknown>): unknown[] | null {
  const text = String(node["text"] ?? "");
  const segments: Array<{ word: boolean; text: string }> = [];
  let last = 0;
  const re = new RegExp(BOUNDARY_RUN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ word: true, text: text.slice(last, m.index) });
    segments.push({ word: false, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ word: true, text: text.slice(last) });
  const letterSegs = segments.filter((s) => s.word && WORD_CONTENT_RE.test(s.text));
  if (letterSegs.length < 2) return null;
  const out: unknown[] = [];
  for (const s of segments) {
    if (s.text === "") continue;
    if (s.word && WORD_CONTENT_RE.test(s.text)) {
      out.push({ ...node, text: s.text, __edited: true });
    } else {
      out.push({ type: "text", text: s.text, __edited: true });
    }
  }
  return out;
}

// Walk the tree, replacing each glued `\w` with its split fragments. Reports
// whether anything split so the caller can skip the lift / recompute passes on
// clean verses (no occurrence churn there).
function markGluedSplits(verseObjects: unknown[]): { result: unknown[]; didSplit: boolean } {
  let didSplit = false;
  const walk = (nodes: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const node of nodes) {
      if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
          const split = splitGluedNode(o);
          if (split) {
            didSplit = true;
            out.push(...split);
            continue;
          }
        } else if (Array.isArray(o["children"])) {
          out.push({ ...o, children: walk(o["children"] as unknown[]) });
          continue;
        }
      }
      out.push(node);
    }
    return out;
  };
  return { result: walk(verseObjects), didSplit };
}

// Lift any node marked `__edited` out of every enclosing `\zaln-s` ancestor:
// the marked node becomes a bare (unaligned) sibling at the milestone's old
// position, the milestone splitting into pre/post halves around it. Mirror of
// web/src/lib/replace.ts:liftEditedOutOfZaln — keep in sync.
function liftEditedOutOfZaln(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      out.push(node);
      continue;
    }
    const o = node as Record<string, unknown>;
    if (o["__edited"]) {
      const { __edited: _drop, ...rest } = o as Record<string, unknown> & { __edited?: unknown };
      (rest as Record<string, unknown>)["__lifted"] = true;
      out.push(rest);
      continue;
    }
    if (Array.isArray(o["children"])) {
      const processed = liftEditedOutOfZaln(o["children"] as unknown[]);
      if (o["tag"] === "zaln") {
        let segment: unknown[] = [];
        const flush = () => {
          if (segment.length > 0) {
            out.push({ ...o, children: segment });
            segment = [];
          }
        };
        for (const child of processed) {
          if (child && typeof child === "object" && (child as Record<string, unknown>)["__lifted"]) {
            flush();
            out.push(child);
          } else {
            segment.push(child);
          }
        }
        flush();
      } else {
        out.push({ ...o, children: processed });
      }
    } else {
      out.push(node);
    }
  }
  return out;
}

// Strip leftover `__lifted` markers from a fully-processed tree. Mirror of
// web/src/lib/replace.ts:stripLiftedMarkers — keep in sync.
function stripLiftedMarkers(nodes: unknown[]): unknown[] {
  return nodes.map((n) => {
    if (!n || typeof n !== "object") return n;
    const { __lifted: _drop, ...rest } = n as Record<string, unknown> & { __lifted?: unknown };
    if (Array.isArray((rest as Record<string, unknown>)["children"])) {
      (rest as Record<string, unknown>)["children"] = stripLiftedMarkers(
        (rest as Record<string, unknown>)["children"] as unknown[],
      );
    }
    return rest;
  });
}

// Renumber every target `\w`'s occurrence / occurrences across the verse in
// document order. A split creates a fresh instance of an existing word (e.g. a
// 7th "the"); without this the freed token keeps the glued token's bogus 1/1
// and collides with the real occurrences on export / re-alignment. Source
// `\zaln-s` x-occurrence attributes live on the milestone, not on `\w`, so
// they're never touched here.
//
// Also used as a defensive normalizer on the verse read/write boundaries
// (chapters.ts, verses.ts, pipelineImport.ts): malformed AI/imported alignment
// can stamp every `\w` `occurrences="1"` and collide `(text, occurrence)` pairs
// (e.g. two "is" both occurrence=2), which breaks every feature that keys words
// by `${text}|${occurrence}` (note-quote highlight, chip colors, quote builder).
// Recomputing from document position makes the keys unique and correct. A no-op
// on already-correct verses, so round-trip fidelity on clean data is preserved.
// Mutates `verseObjects` in place and returns it.
export function recomputeTargetOccurrences(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const words: Array<Record<string, unknown>> = [];
  const collect = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        words.push(o);
      } else if (Array.isArray(o["children"])) {
        collect(o["children"] as unknown[]);
      }
    }
  };
  collect(verseObjects);
  const totals = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const running = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    const n = (running.get(key) ?? 0) + 1;
    running.set(key, n);
    w["occurrence"] = String(n);
    w["occurrences"] = String(totals.get(key) ?? 1);
  }
  return verseObjects;
}

// Split AI-glued `\w` tokens and drop their fragments to unaligned. No-op when
// nothing is glued — clean verses (and Hebrew / Greek source text, which has
// no Latin boundary punctuation) pass through untouched, no occurrence churn.
export function splitGluedAlignmentWords(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const { result, didSplit } = markGluedSplits(verseObjects);
  if (!didSplit) return verseObjects;
  const lifted = stripLiftedMarkers(liftEditedOutOfZaln(result));
  // Clone before the in-place occurrence renumber so we never mutate caller
  // state (cloneVerseObjects pattern from web/src/lib/replace.ts).
  return recomputeTargetOccurrences(JSON.parse(JSON.stringify(lifted)) as unknown[]);
}

// ─── Collapse doubled leading poetry / paragraph markers ─────────────────────
//
// unfoldingWord ULT/UST USFM puts a verse's leading in-flow marker BEFORE its
// `\v` (`\q1 \v 17 \zaln-s …`), so usfm-js parks that marker as a TRAILING node
// on the PREVIOUS verse. When the AI emits a DOUBLED marker — `\q1 \v 17 \q1 …`
// — the importer faithfully splits it into a trailing `\q1` on verse 16 PLUS a
// LEADING `\q1` stored as the first node of verse 17; on export both re-emit
// (`\q1 \v 17 \q1` again) and a uW checker has to hand-remove the extra. The
// interactive editor never creates these (drifted markers render as read-only
// bands and never enter the saved text) — the defect is purely AI-output
// faithfully imported, so we absorb it here, mirroring splitGluedAlignmentWords.
//
// Mirror of isInFlowMarker in web/src/lib/usfm.ts — keep in sync. usfm-js stores
// poetry markers (\q1, \q2, \qa, …) as {type:"quote", tag} and plain-paragraph
// markers (\p, \m, \nb, \b, …) as {type:"paragraph", tag}.
function isInFlowMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if ((t === "paragraph" || t === "quote") && typeof o["tag"] === "string") return true;
  if (o["tag"] === "ts" && o["content"] === "\\*") return true;
  return false;
}

function markerTag(node: unknown): unknown {
  return (node as Record<string, unknown> | null)?.["tag"];
}

// Normalised text fused onto a marker node, for the heading-vs-body test below.
function markerText(node: unknown): string {
  const t = (node as Record<string, unknown> | null)?.["text"];
  return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
}

// The run of in-flow markers at the END of a verse's objects, in document order
// (oldest-first). Skips trailing whitespace-only text so an empty `\n` node
// between the last word and the marker doesn't hide it. Mirror of
// extractTrailingMarkers in web/src/lib/usfm.ts.
function trailingMarkerRun(verseObjects: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = verseObjects.length - 1; i >= 0; i--) {
    const node = verseObjects[i];
    if (isInFlowMarker(node)) {
      out.unshift(node);
      continue;
    }
    const o = node as Record<string, unknown> | null;
    const txt = typeof o?.["text"] === "string" ? (o["text"] as string) : null;
    if (txt !== null && /^[\s​]*$/.test(txt)) continue;
    break;
  }
  return out;
}

// Drop the leading in-flow marker(s) of verse N when they duplicate the trailing
// marker run of verse N-1 — the `\qX(trailing N-1) + \qX(leading N)` doubling.
// `prev` is the (already-normalised) verseObjects of the immediately preceding
// verse in the SAME chapter, or null for the first verse / chapter-front, which
// never de-dup: their leading marker may be the only legitimate copy (chapter
// fronts open with a real `\p` / `\q1`). Returns `curr` unchanged (identity)
// when nothing matches; otherwise a trimmed copy. Neither input is mutated.
//
// A verse can stack several leading markers (`\qa LETTER` + `\q1`); we de-dup
// each that lines up, in order, against the tail of N-1's trailing run.
//
// usfm-js fuses text that follows a marker on the same line onto the marker
// node's `text`. When we drop a leading marker we KEEP that text as a plain text
// node if it is verse body (the AI bare-text shape `\q1 \v 17 \q1 In the
// beginning`), and DROP it only when it just repeats the matching trailing
// marker's own text (the acrostic letter on `\qa ALEPH`, which already rides on
// verse N-1) — so the letter is never doubled into the verse body.
export function dropDoubledLeadingMarkers(prev: unknown[] | null, curr: unknown[]): unknown[] {
  if (!prev || !Array.isArray(curr) || curr.length === 0) return curr;
  const trailing = trailingMarkerRun(prev);
  if (trailing.length === 0) return curr;
  let leadCount = 0;
  while (leadCount < curr.length && isInFlowMarker(curr[leadCount])) leadCount++;
  if (leadCount === 0) return curr;
  // Largest k where the last k trailing tags equal curr's first k leading tags —
  // the verbatim doubled run. Search from the longest candidate down so the
  // maximal de-dup wins; a leading marker that doesn't line up is left alone.
  let k = 0;
  for (let cand = Math.min(trailing.length, leadCount); cand >= 1; cand--) {
    let match = true;
    for (let i = 0; i < cand; i++) {
      if (markerTag(trailing[trailing.length - cand + i]) !== markerTag(curr[i])) {
        match = false;
        break;
      }
    }
    if (match) {
      k = cand;
      break;
    }
  }
  if (k === 0) return curr;
  const out: unknown[] = [];
  for (let i = 0; i < k; i++) {
    const lead = curr[i] as Record<string, unknown>;
    const text = typeof lead["text"] === "string" ? (lead["text"] as string) : "";
    const trail = trailing[trailing.length - k + i];
    if (text !== "" && markerText(lead) !== markerText(trail)) {
      out.push({ type: "text", text });
    }
  }
  for (let i = k; i < curr.length; i++) out.push(curr[i]);
  return out;
}

// Walk verse-objects and concatenate all text. Same shape and behaviour
// as the client-side `extractPlainText` in web/src/lib/usfm.ts — kept
// duplicated because the Worker bundle and the web bundle are built
// separately and cross-package imports are non-trivial. Any change
// here must be mirrored there.
//   { type: 'text', text: '...' }
//   { type: 'word', text: '...', occurrence, ... }
//   { type: 'milestone', tag: 'zaln-s', children: [...] }
//   { type: 'paragraph', tag: 'p' }
function extractPlainText(verseObj: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos || []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as { text?: unknown; children?: unknown[] };
      if (typeof v.text === "string") parts.push(v.text);
      if (Array.isArray(v.children)) walk(v.children);
    }
  };
  const top = verseObj as { verseObjects?: unknown[] };
  walk(top.verseObjects ?? []);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// Whole-book USFM headers (\id, \h, \toc*, \mt1, …) as the usfm-js
// `headers` array. Stashed in book_usfm_meta so the nightly export can
// emit them verbatim instead of synthesizing a minimum set.
export function extractUsfmHeaders(rawUsfm: string): unknown[] | null {
  const json = usfm.toJSON(rawUsfm);
  return Array.isArray(json.headers) && json.headers.length > 0 ? json.headers : null;
}

// Extract every verse in [startChapter, endChapter] from a whole-book USFM
// blob. Verse keys can be numeric ("3"), hyphenated ranges ("12-13" — kept
// as a single row with verse=12, verseEnd=13 so export round-trips `\v 12-13`),
// or the "front" pseudo-verse (where usfm-js puts a chapter-level `\d` Psalm
// title — stored as verse 0). Book-level `intro` keys are still skipped.
export function extractVersesForRange(
  rawUsfm: string,
  startChapter: number,
  endChapter: number,
): VerseExtract[] {
  const json = usfm.toJSON(rawUsfm);
  const out: VerseExtract[] = [];
  const chapters = json.chapters ?? {};
  for (const chapterKey of Object.keys(chapters)) {
    const chNum = parseInt(chapterKey, 10);
    if (!Number.isFinite(chNum)) continue;
    if (chNum < startChapter || chNum > endChapter) continue;
    const chapterObj = chapters[chapterKey] as Record<string, unknown>;

    // Resolve verse keys to document order (chapter-front, then verses ascending)
    // before the cross-verse marker de-dup walks the chapter. JS object-key order
    // floats "front" and hyphenated ranges ("8-9") past the integer keys, which
    // would pair a verse with the wrong predecessor. Each row is keyed by
    // chapter+verse downstream, so the emit order itself is immaterial.
    const entries: Array<{ vNum: number; vEnd: number | null; verseObj: { verseObjects?: unknown[] } }> = [];
    for (const verseKey of Object.keys(chapterObj)) {
      let vNum: number;
      let vEnd: number | null = null;
      if (verseKey === "front") {
        // Chapter-front pseudo-verse — Psalm titles (\d), descriptive
        // titles, etc. Store as verse 0 so the chapter view's "intro"
        // row picks them up.
        vNum = 0;
      } else {
        const m = verseKey.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) continue;
        vNum = parseInt(m[1], 10);
        if (m[2]) {
          const end = parseInt(m[2], 10);
          // Inverted ranges (e.g. "9-8") are nonsense — collapse to singleton.
          vEnd = end > vNum ? end : null;
        }
      }
      if (!Number.isFinite(vNum)) continue;
      entries.push({ vNum, vEnd, verseObj: chapterObj[verseKey] as { verseObjects?: unknown[] } });
    }
    entries.sort((a, b) => a.vNum - b.vNum);

    // Trailing markers of verse N-1 are what verse N's leading copy duplicates.
    // Chapter-front (verse 0) never seeds this — its trailing markers legitimately
    // lead verse 1, whose copy we must keep — so it leaves prev null.
    let prevVerseObjects: unknown[] | null = null;
    for (const { vNum, vEnd, verseObj } of entries) {
      // Strip outer punctuation, de-glue any AI-introduced punctuation-spanning
      // `\w` (the freed words fall out to unaligned), then drop any leading marker
      // that merely doubles the previous verse's trailing one.
      let verseObjects = splitGluedAlignmentWords(
        normalizeWordPunctuation(verseObj.verseObjects ?? []),
      );
      verseObjects = dropDoubledLeadingMarkers(prevVerseObjects, verseObjects);
      prevVerseObjects = vNum >= 1 ? verseObjects : null;
      const normalized = { ...verseObj, verseObjects };
      out.push({
        chapter: chNum,
        verse: vNum,
        verseEnd: vEnd,
        contentJson: JSON.stringify(normalized),
        plainText: extractPlainText(normalized),
      });
    }
  }
  return out;
}

// 'front:intro' -> [0, 0]
// '1:intro'     -> [1, 0]
// '1:1'         -> [1, 1]
// '1:1-3'       -> [1, 1] (range collapses to first verse for indexing)
export function refParts(refRaw: string | null | undefined): [number, number] {
  if (!refRaw) return [0, 0];
  const [ch, vs] = refRaw.split(":");
  const chNum = ch === "front" ? 0 : parseInt(ch, 10) || 0;
  const vsNum =
    !vs || vs === "intro" ? 0 : parseInt(vs.split("-")[0], 10) || 0;
  return [chNum, vsNum];
}

export interface ParsedTsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

// Naive split-by-tab parser matching scripts/import-book.mjs. The
// unfoldingWord TSVs don't quote tabs inside cells, so this is sufficient.
export function parseTsv(raw: string): ParsedTsv {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = cells[i] ?? "";
    });
    return o;
  });
  return { headers, rows };
}

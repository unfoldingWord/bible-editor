// Curl straight quotes in a verse tree on save (#1273).
//
// Mirror of api/src/importParsers.ts curlifyVerseObjects (with its helpers
// isOpeningQuoteContext / curlifyChar / curlifyTextWithContext) — keep behavior
// in sync. Duplicated rather than imported for the same cross-bundle reason as
// the other web/src/lib mirrors (alignmentDelta.ts, canonizeQuote.ts).
//
// Why it exists: curlyQuotes.ts curls a quote as it is typed, but only for a
// single-character `insertText`. Multi-character inserts (predictive text,
// autocorrect, dictation, extensions), IME composition, drag-and-drop and the
// Copy T4T to UST button all reach saveVerseDraft with straight quotes, and
// those were saved as typed.
//
// Why AFTER smartEditVerse and on the tree, not on the typed string: the edit
// engine reuses an untouched aligned word only when its surface text matches
// exactly. Curling the typed string first would turn an untouched `baby's`
// into `baby’s`, the engine would treat it as an edited word and drop its
// alignment, and the save guard would not notice. Curling the result tree
// changes only `.text` strings, and the tokenizer treats ' and ’ alike, so
// word counts and alignment are unchanged. The one move afterwards is the
// engine's own opening-quote hoist (#1278): no \w word or milestone changes.

import { renumberTargetOccurrences } from "./replace.ts";
import { hoistOpeningPunctuation } from "./openingPunct.ts";

const CURLY_LDQUO = "“";
const CURLY_RDQUO = "”";
const CURLY_LSQUO = "‘";
const CURLY_RSQUO = "’";

function isOpeningQuoteContext(prev: string | undefined, prevPrev?: string | undefined): boolean {
  if (!prev) return true;
  if (/\s/.test(prev)) return true;
  // The literal two-character `\n` escape (TSV prose convention) opens.
  // Verse trees never carry it; kept so the mirror stays exact.
  if (prev === "n" && prevPrev === "\\") return true;
  return /[(\[{<\-–—/“‘]/.test(prev);
}

// Two of the same straight quote back to back alternate (`""` → “”), since the
// context rule alone would open twice. Otherwise the context rule decides.
function curlifyChar(
  ch: '"' | "'",
  prevRaw: string | undefined,
  prevCurled: string | undefined,
  prevCurled2?: string | undefined,
): string {
  if (prevRaw === ch) {
    if (ch === '"') return prevCurled === CURLY_LDQUO ? CURLY_RDQUO : CURLY_LDQUO;
    return prevCurled === CURLY_LSQUO ? CURLY_RSQUO : CURLY_LSQUO;
  }
  if (ch === '"') return isOpeningQuoteContext(prevCurled, prevCurled2) ? CURLY_LDQUO : CURLY_RDQUO;
  return isOpeningQuoteContext(prevCurled, prevCurled2) ? CURLY_LSQUO : CURLY_RSQUO;
}

function curlifyTextWithContext(
  text: string,
  prevCurled: string | undefined,
  prevRaw: string | undefined,
): { text: string; changed: boolean } {
  let out = "";
  let changed = false;
  let curled = prevCurled;
  let curled2: string | undefined = undefined;
  let raw = prevRaw;
  for (const ch of text) {
    if (ch === '"' || ch === "'") {
      const curly = curlifyChar(ch, raw, curled, curled2);
      out += curly;
      if (curly !== ch) changed = true;
      curled2 = curled;
      curled = curly;
    } else {
      out += ch;
      curled2 = curled;
      curled = ch;
    }
    raw = ch;
  }
  return { text: out, changed };
}

// usfm-js also types these INLINE character markers "quote" (\qs Selah\qs*,
// \qac, \qt, \qt1-\qt5, nested \+qt, and the \qt-s ... \qt-e\* milestones;
// every type "quote" entry with an endTag in usfm-js's USFM.js). They sit
// inside a line, so they must not reset the context: `Yahweh\qs 's\qs*`
// curls to ’s, not ‘s (#1281). Matched by tag, not endTag, because a \qs can
// arrive unclosed ({tag:"qs", endTag:""}). Same set in both copies.
const INLINE_QUOTE_TAGS: ReadonlySet<string> = new Set([
  "qs", "qac", "qt", "qt1", "qt2", "qt3", "qt4", "qt5", "+qt",
  "qt-s", "qt1-s", "qt2-s", "qt3-s", "qt4-s", "qt5-s",
]);

// Mutates in place. Walks every node's own `.text` in document order, except
// `\zaln-s` milestones (source-owned attributes, never touched); milestone
// children (the aligned target words) are walked normally.
//
// Like the API copy: a `\p`/`\q#` line marker (not one of the
// INLINE_QUOTE_TAGS above) starts a new line, so a quote
// right after it opens even when the text before the marker ends in a letter
// or comma ("said,\q1 'Turn" → ‘Turn, not ’Turn).
function curlifyVerseObjectsInPlace(verseObjects: unknown[]): void {
  let prevCurled: string | undefined;
  let prevRaw: string | undefined;
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const isLineMarker =
        o["type"] === "paragraph" ||
        (o["type"] === "quote" && !(typeof o["tag"] === "string" && INLINE_QUOTE_TAGS.has(o["tag"])));
      if (isLineMarker) {
        prevCurled = "\n";
        prevRaw = "\n";
      }
      const isSourceMilestone = o["type"] === "milestone" && o["tag"] === "zaln";
      const text = o["text"];
      if (!isSourceMilestone && typeof text === "string" && text.length > 0) {
        if (/['"]/.test(text)) {
          const result = curlifyTextWithContext(text, prevCurled, prevRaw);
          if (result.changed) o["text"] = result.text;
          prevCurled = result.text[result.text.length - 1];
        } else {
          prevCurled = text[text.length - 1];
        }
        prevRaw = text[text.length - 1];
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(verseObjects);
}

function hasStraightQuoteText(nodes: unknown[]): boolean {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;
    const isSourceMilestone = o["type"] === "milestone" && o["tag"] === "zaln";
    if (!isSourceMilestone && typeof o["text"] === "string" && /['"]/.test(o["text"])) return true;
    if (Array.isArray(o["children"]) && hasStraightQuoteText(o["children"] as unknown[])) return true;
  }
  return false;
}

const STRAIGHT_FORM: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"' };

function sameOrStraightened(baseCh: string, typedCh: string): boolean {
  return baseCh === typedCh || STRAIGHT_FORM[baseCh] === typedCh;
}

// Where the typed text has a straight quote at a spot the saved verse already
// has curled, use the saved curly form, so the edit engine sees no change
// there. Three passes: the unchanged lead and tail (the same common
// prefix/suffix the engine diffs on); then, between the first and last real
// edit, every whitespace-separated word that matches a saved word except for
// straight-for-curly quotes (#1290); then the same at the engine's own word
// granularity, so a retype inside a word that also gained punctuation
// (`Yahweh's,` for `Yahweh’s`, or a new opener before it) is caught too
// (#1293). Anything else is kept as typed and curled after the engine runs.
//
// Needed because the save curls every straight quote anyway, so ' for ’ is
// not a real edit, but the engine matches words by exact text: a stored
// `Yahweh’s` retyped as `Yahweh's` (seen live on ZEC 6:15 UST) read as an
// edited word and silently lost its alignment, and with only a far-end edit
// the engine also rewrote everything in between. The lead/tail pass alone
// missed a retype with real edits on both sides of it (#1290). The same
// applies to an editor that still shows a ' the save has already curled.
// Only straight-for-curly counts as unchanged: a deliberate ’ → ‘ change is
// still a change.
export function adoptBaseQuotes(base: string, typed: string): string {
  if (!/['"]/.test(typed)) return typed;
  const n = Math.min(base.length, typed.length);
  let p = 0;
  while (p < n && sameOrStraightened(base[p], typed[p])) p++;
  let s = 0;
  while (s < n - p && sameOrStraightened(base[base.length - 1 - s], typed[typed.length - 1 - s])) s++;
  const leadTail = base.slice(0, p) + typed.slice(p, typed.length - s) + base.slice(base.length - s);
  if (!/['"]/.test(leadTail) || !/[‘’“”]/.test(base)) return leadTail;
  const words = adoptBaseQuoteWords(base, leadTail, /\S+/g);
  if (!/'/.test(words)) return words;
  return adoptBaseQuoteWords(base, words, WORD_RUN_RE);
}

// The edit engine's word run, kept identical to replace.ts WORD_CHAR /
// WORD_RUN_RE (not exported there; alignmentReassembly.ts keeps the same
// copy). A ' or ’ between letters is part of the word, so `Yahweh's,` holds
// the run `Yahweh's`; ‘ is not, so a deliberate ’ → ‘ never pairs up.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}\\u200d\\u2060]";
const WORD_RUN_RE = new RegExp(`${WORD_CHAR}+(?:[-'\u2019]${WORD_CHAR}+|(?<=\\p{N}),\\p{N}+)*`, "gu");

const MAX_LCS_CELLS = 10_000_000;

const foldQuotes = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Word-level pass of adoptBaseQuotes: matches typed words to saved words in
// order (longest common subsequence, compared with quotes folded) and swaps in
// the saved word where the only difference is a straight quote typed for its
// curly one. `wordRe` (global) says what a word is: whitespace-separated, or
// the engine's word run. Curly and straight quotes are one UTF-16 unit each,
// so a swap never shifts offsets and everything between words stays as typed.
function adoptBaseQuoteWords(base: string, typed: string, wordRe: RegExp): string {
  const baseWords = base.match(wordRe) ?? [];
  const typedSpans = [...typed.matchAll(wordRe)].map((m) => ({ start: m.index ?? 0, text: m[0] }));
  const bf = baseWords.map(foldQuotes);
  const tf = typedSpans.map((t) => foldQuotes(t.text));
  // Words equal after folding at both ends pair up in order; the LCS only
  // runs on what is left between them.
  let lo = 0;
  while (lo < bf.length && lo < tf.length && bf[lo] === tf[lo]) lo++;
  let hi = 0;
  while (hi < bf.length - lo && hi < tf.length - lo && bf[bf.length - 1 - hi] === tf[tf.length - 1 - hi]) hi++;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < lo; i++) pairs.push([i, i]);
  for (let k = 1; k <= hi; k++) pairs.push([bf.length - k, tf.length - k]);
  const bm = bf.length - lo - hi;
  const tm = tf.length - lo - hi;
  // Only the unmatched middle needs the table, and only when a word there
  // holds a straight quote. Cap the table (~40 MB) so a pasted wall of text
  // can't exhaust memory on save; past the cap the lead/tail result stands.
  let middleHasStraight = false;
  for (let j = lo; j < tf.length - hi && !middleHasStraight; j++) middleHasStraight = /['"]/.test(typedSpans[j].text);
  if (bm > 0 && tm > 0 && middleHasStraight && (bm + 1) * (tm + 1) <= MAX_LCS_CELLS) {
    // len[i][j] = LCS length of bf[lo+i..] and tf[lo+j..], flattened.
    const w = tm + 1;
    const len = new Uint32Array((bm + 1) * w);
    for (let i = bm - 1; i >= 0; i--) {
      for (let j = tm - 1; j >= 0; j--) {
        len[i * w + j] =
          bf[lo + i] === tf[lo + j]
            ? len[(i + 1) * w + j + 1] + 1
            : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < bm && j < tm) {
      if (bf[lo + i] === tf[lo + j]) {
        pairs.push([lo + i, lo + j]);
        i++;
        j++;
      } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++;
      else j++;
    }
  }
  let out = typed;
  for (const [bi, ti] of pairs) {
    const b = baseWords[bi];
    const { start, text } = typedSpans[ti];
    if (b === text || !/['"]/.test(text)) continue;
    let straightened = true;
    for (let c = 0; c < b.length && straightened; c++) straightened = sameOrStraightened(b[c], text[c]);
    if (straightened) out = out.slice(0, start) + b + out.slice(start + b.length);
  }
  return out;
}

// Returns verse content with every straight quote in its text curled. Never
// mutates `content`: the engine's result shares untouched nodes with the
// pinned base and the chapter cache, so a curled copy is built instead. Returns
// `content` itself (same reference) when there is nothing to curl.
//
// Occurrences are renumbered afterwards: the engine numbers them before the
// curl, so `don’t` plus a typed `don't` would otherwise stay two "don’t 1/1",
// and the aligner keys target tokens by text|occurrence (the EZK 12:3 bug).
//
// The opening-quote hoist runs again on the curled tree (#1278). The engine
// hoists an opener out of the preceding word's \zaln milestone (#777), but it
// only recognizes curly openers, and a pasted `"` reaches it straight: a
// straight `"` pasted before an aligned word whose milestone ends in its own
// comma stayed there as `, "` and was curled in place to `, “`, which Door43
// renders with a space after the quote. The hoist keeps its own rules (never
// across a \q/\p marker) and is idempotent, so content the engine already
// laid out is unchanged.
export function curlifyVerseContent<T>(content: T): T {
  const vo = (content as { verseObjects?: unknown } | null)?.verseObjects;
  if (!Array.isArray(vo) || !hasStraightQuoteText(vo)) return content;
  const copy = structuredClone(content) as T & { verseObjects: unknown[] };
  curlifyVerseObjectsInPlace(copy.verseObjects);
  copy.verseObjects = renumberTargetOccurrences(hoistOpeningPunctuation(copy.verseObjects));
  return copy;
}

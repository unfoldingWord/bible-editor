// Smart verse-content rewriter for find/replace and inline text edits.
//
// The naive rewrite path collapses the whole verse to a single text token —
// which destroys every `\w` word AND every `\zaln-s` alignment milestone, so
// the aligner ends up with neither targets to drag nor any alignment to
// re-use. This module tries harder, in two tiers:
//
//   1. Preserve path. When the change spans full words and the find/replace
//      strings have matching word counts, rewrite each affected `\w` leaf's
//      text in place. Surrounding (and even containing) `\zaln-s` milestones
//      are untouched.
//   2. Localized rewrite. When the preserve conditions don't hold, drop
//      ONLY the top-level nodes (milestones / bare words / text segments)
//      whose raw text overlaps the change range. Milestones outside the
//      range round-trip verbatim; affected milestones are split into
//      before/after halves around the change, so even partially-preserved
//      milestones keep their source alignment for the surviving children.
//
// Pure insertions (oldLen === 0) and pure deletions (newSubstring === "")
// flow through the localized rewrite path too.

import { normalizeEditable, isInFlowMarker, isCharacterWrapper, liftMarkerText } from "./usfm.ts";

export interface SmartReplaceResult {
  content: unknown;
  plainText: string;
  preservedAlignment: boolean;
}

interface Leaf {
  node: Record<string, unknown>;
  start: number;
  end: number;
  // 0 = top-level child of verseObjects. > 0 = nested inside a milestone /
  // wrapper. Top-level text leaves can be split mid-character by the
  // localized rewrite; nested leaves are dropped whole, so a partial
  // overlap on a nested leaf loses text.
  depth: number;
}

function walkLeaves(verseObjects: unknown[]): { raw: string; leaves: Leaf[] } {
  const leaves: Leaf[] = [];
  let pos = 0;
  const walk = (nodes: unknown[], depth: number) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      const text = o["text"];
      if (typeof text === "string") {
        leaves.push({ node: o, start: pos, end: pos + text.length, depth });
        pos += text.length;
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children, depth + 1);
    }
  };
  walk(verseObjects, 0);
  return { raw: leaves.map((l) => String(l.node["text"])).join(""), leaves };
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function rebuildRaw(verseObjects: unknown[]): string {
  const parts: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      const text = o["text"];
      if (typeof text === "string") parts.push(text);
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(verseObjects);
  return parts.join("");
}

function isWordLeaf(node: Record<string, unknown>): boolean {
  return node["type"] === "word" && node["tag"] === "w";
}

// Word characters: Unicode letters/marks/numbers plus the zero-width joiner
// (U+200D) and word-joiner (U+2060) that ride inside some Hebrew/Greek tokens.
// Defined once so WORD_RUN_RE and WORD_CORE_RE can't drift apart.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}\\u200d\\u2060]";
// A word run plus its intra-word connectors. \p{N} is required because the UST
// writes literal counts (`\w 30\w*`) for measurements — "30" must be a
// draggable chip. Connectors bind two runs into ONE token: hyphen, straight /
// curly apostrophe (don't, hello-world, Isaiah's), and — ONLY between digits —
// the grouping comma, so "300,000" aligns as one chip instead of splitting like
// the legacy tools (string-punctuation-tokenizer / tCreate) did. A comma not
// flanked by digits ("a, b") stays a separator.
const WORD_RUN_RE = new RegExp(
  `${WORD_CHAR}+(?:[-'\u2019]${WORD_CHAR}+|(?<=\\p{N}),\\p{N}+)*`,
  "gu",
);

// Re-tokenize a plain string into a flat verseObjects-style array. Each
// word run becomes a `\w` node so the aligner has draggable targets;
// whitespace AND punctuation ride along as `text` nodes. Without
// excluding punctuation, inserting a bare `{` (or any non-letter char)
// between two existing words produces a `\w {\w*` token that shows up
// as a draggable alignment chip. Used only when the smart path bails.
export function tokenizePlainText(text: string): unknown[] {
  const out: unknown[] = [];
  const occByWord = new Map<string, number>();
  let last = 0;
  for (const m of text.matchAll(WORD_RUN_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      out.push({ type: "text", text: text.slice(last, start) });
    }
    const word = m[0];
    const occ = (occByWord.get(word) ?? 0) + 1;
    occByWord.set(word, occ);
    out.push({
      type: "word",
      tag: "w",
      text: word,
      occurrence: String(occ),
      occurrences: "1",
    });
    last = start + word.length;
  }
  if (last < text.length) {
    out.push({ type: "text", text: text.slice(last) });
  }
  return out;
}

// Inline paragraph / poetry / blank / chunk markers, surfaced as visible
// literal "\p" / "\q1" / "\ts\*" tokens in the active-verse contenteditable
// AND recognized in bare text by the aligner. Two alternation branches:
//
//   1. Digit-bearing forms (`pi1-3`, `q1-4`, `qm1-3`): a numeric suffix makes
//      the marker unambiguous — no longer marker can extend it — so it's
//      recognized even when typed glued to the next word (`\q2destroy` →
//      marker `\q2` + "destroy"). This is the gap that left a hand-typed,
//      button-less marker sitting as literal text.
//   2. Bare forms (`p`, `m`, `mi`, `nb`, `pi`, `pc`, `q`, `qm`, `b`, `ts\*`):
//      these keep the `(?=\s|$|[^a-z0-9])` boundary, because several are a
//      PREFIX of a longer marker — bare `\q` must NOT bite into `\qa`/`\qr`
//      (acrostic/right-aligned, not in this set) nor `\qm`, `\p` into `\pi`/
//      `\pc`, `\m` into `\mi`. Longest-first ordering (`mi` before `m`, `pi`/
//      `pc` before `p`, `qm` before `q`) keeps the boundary picking the full
//      marker. `ts\\\*` matches the literal `\ts\*` chunk milestone.
//
// The optional trailing \s is consumed (both branches) so the marker token
// doesn't leave a stranded space between marker and following text.
const MARKER_TOKEN_RE =
  /\\((?:pi[1-3]|q[1-4]|qm[1-3])|(?:mi|nb|pc|pi|qm|p|m|q|b|ts\\\*)(?=\s|$|[^a-z0-9]))\s?/g;

// usfm-js distinguishes "paragraph" markers (\p, \m, \mi, \nb, \pi*,
// \pc, \b) from "quote" markers (\q, \q1..q4, \qm*) using different
// `type` fields on the parsed node. `\ts\*` is parsed as `{tag:"ts",
// content:"\\*"}` with no `type` field. Mirror those shapes here so
// re-emitted markers round-trip through usfm.toUSFM in their original
// form.
function nodeForMarker(tag: string): unknown {
  if (tag === "ts\\*") {
    return { tag: "ts", content: "\\*" };
  }
  const type =
    tag === "q" || /^q[1-4]$/.test(tag) || /^qm[1-3]?$/.test(tag) ? "quote" : "paragraph";
  return { type, tag };
}

// Tokenize editable text that may contain inline marker tokens (\p, \q1,
// \b ...) into a flat verseObjects-style array. Each marker becomes a
// `{type, tag}` node with the right type for its USFM class — the same
// shape the importer / usfm-js produce — so localized rewrites that
// consume this output keep markers in document position. Between
// markers, the segment is fed through tokenizePlainText so word runs
// become `\w` leaves and the aligner still has draggable targets. When
// the input has no markers, the behavior is identical to
// tokenizePlainText.
export function tokenizeEditableText(text: string): unknown[] {
  // Strip zero-width spaces (U+200B). The active-verse editor uses them
  // as caret placeholders in empty marker-led blocks (renderEditableHTML
  // emits `&#8203;`), but they're rendering artifacts, not content —
  // capturing them into the saved verseObjects would accumulate junk on
  // every save and (worse) block marker drift to the next verse.
  const cleaned = text.replace(/​/g, "");
  const out: unknown[] = [];
  let last = 0;
  const re = new RegExp(MARKER_TOKEN_RE.source, MARKER_TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const start = m.index;
    if (start > last) {
      for (const node of tokenizePlainText(cleaned.slice(last, start))) out.push(node);
    }
    const tag = m[1];
    out.push(nodeForMarker(tag));
    last = start + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < cleaned.length) {
    for (const node of tokenizePlainText(cleaned.slice(last))) out.push(node);
  }
  return out;
}

// Strip USFM marker tokens from a string so positions in editable text
// can be mapped to positions in raw verseObjects text (which has no
// markers — they're position-anchor nodes with no text payload). Used
// in localizedRewriteVerse to remap pure-insertion positions when
// markers are present in the baseline. Same regex as tokenizeEditableText
// without the trailing-whitespace consume so we count only the marker
// chars themselves.
function stripMarkerTokens(text: string): string {
  return text.replace(MARKER_TOKEN_RE, "");
}

// Letters / marks / numbers count as "core" word content — mirrors
// api/src/importParsers.ts:LETTER_RE so the client-side normalize pass
// agrees with the server importer about which trailing chars belong
// inside a `\w` token. Numbers matter because the UST writes literal
// counts (`\w 30\w*`) for measurements.
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

// Strip leading / trailing non-letter characters off a `\w` token's text,
// emitting them as adjacent text nodes. Mirrors the server-side
// `normalizeWordPunctuation` in api/src/importParsers.ts so the client
// produces the same shape the importer would have. Runs at the end of
// `smartEditVerse` as defense-in-depth — even if every code path here
// stays punct-clean by construction, this guarantees no `\w` carrying a
// leading quote or trailing dash ever lands in D1 via the save path.
// Also rehabilitates legacy rows that pre-date the import-time fix:
// the user's next save normalizes them.
//
// Walks recursively into children (zaln-s milestones, \qs wrappers).
function normalizeWordPunctuation(verseObjects: unknown[]): unknown[] {
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
    if (split.trailing) out.push({ type: "text", text: split.trailing });
    return out;
  }
  if (Array.isArray(o["children"])) {
    return [{ ...o, children: (o["children"] as unknown[]).flatMap((c) => normalizeNode(c)) }];
  }
  return [node];
}

// Lift any node marked with `__edited` out of every enclosing `\zaln-s`
// ancestor. The marked word becomes a bare `\w` (unaligned) at the
// position the surrounding milestone used to occupy, with the milestone
// split into pre/post halves around it. Non-`\zaln-s` wrappers (`\qs`,
// `\f`, `\p`, etc.) are NOT split — a bare `\w` inside `\qs` but outside
// `\zaln-s` is already unaligned in alignment.ts' state model. The
// `__edited` sentinel is replaced with `__lifted` so outer-level
// `\zaln-s` ancestors keep splitting around the same node; both
// markers are stripped by `stripLiftedMarkers` at the end.
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
        // Split processed children around any node marked __lifted; each
        // such node pops up to our level. Surrounding spans become
        // separate copies of this milestone.
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
            out.push(child); // keep __lifted so an outer \zaln-s also splits
          } else {
            segment.push(child);
          }
        }
        flush();
      } else {
        // Non-\zaln-s wrapper — children stay nested. Any __lifted child
        // inside a non-zaln wrapper is already structurally unaligned;
        // the marker is no longer load-bearing and stripLiftedMarkers
        // will clear it.
        out.push({ ...o, children: processed });
      }
    } else {
      out.push(node);
    }
  }
  return out;
}

// Strip leftover `__lifted` markers from a fully-processed tree.
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

// Rewrite a regex so literal-space chars in the source match `\s+`. Used
// when re-running a plain-text-derived regex against the unnormalized
// `raw` concatenation of leaf text, which may contain `\n` (e.g. before
// `{...}` word-additions) where plain text has a single space.
function relaxWhitespace(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  try {
    return new RegExp(regex.source.replace(/ /g, "\\s+"), flags);
  } catch {
    // Raw user patterns (regex-mode Find & Replace) flow through here too,
    // and the blind space rewrite can produce an invalid pattern (`son {2}of`
    // → `son\s+{2}of`, "nothing to repeat"). Fall back to the original; if
    // it then misses in raw, the caller's no-match path tokenizes flat.
    return new RegExp(regex.source, flags);
  }
}

// Find the Nth (1-based) occurrence of `regex` in `text`. Returns null if
// fewer than `n` matches exist.
function nthMatchIn(text: string, regex: RegExp, n: number): { index: number; length: number } | null {
  const local = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = local.exec(text)) !== null) {
    count++;
    if (count === n) return { index: m.index, length: m[0].length };
    if (m[0].length === 0) local.lastIndex++;
  }
  return null;
}

// Count how many matches of `regex` appear in `text` strictly before
// position `before`. The active match's plain-text position lets us derive
// "this is the Nth occurrence" without re-running the entire verse search.
function countMatchesBefore(text: string, regex: RegExp, before: number): number {
  const local = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    if (m.index >= before) break;
    n++;
    if (m[0].length === 0) local.lastIndex++;
  }
  return n;
}

// Deep-clone the verseObjects tree so callers can swap content without
// mutating shared state.
function cloneVerseObjects(verseObjects: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(verseObjects)) as unknown[];
}

interface ParentLeaf {
  node: Record<string, unknown>;
  parent: unknown[];
  index: number;
  start: number;
  end: number;
}

// Like walkLeaves, but records each text leaf's parent array + index so the
// caller can splice new siblings in. Position is the running raw-text offset,
// matching walkLeaves / rebuildRaw ordering.
function walkLeavesWithParents(verseObjects: unknown[]): ParentLeaf[] {
  const leaves: ParentLeaf[] = [];
  let pos = 0;
  const walk = (nodes: unknown[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const o = nodes[i] as Record<string, unknown> | null;
      if (!o) continue;
      const text = o["text"];
      if (typeof text === "string") {
        leaves.push({ node: o, parent: nodes, index: i, start: pos, end: pos + text.length });
        pos += text.length;
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(verseObjects);
  return leaves;
}

// Split a string into the runs of non-word text surrounding each word run.
// For N words returns N+1 gaps: gap[0] leads the first word, gap[i] sits
// between word i-1 and word i, gap[N] trails the last word. Pairs with
// WORD_RUN_RE so the gaps are exactly the punctuation/whitespace the aligner
// does NOT treat as draggable.
function nonWordGaps(text: string): string[] {
  const gaps: string[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RUN_RE)) {
    gaps.push(text.slice(last, m.index ?? 0));
    last = (m.index ?? 0) + m[0].length;
  }
  gaps.push(text.slice(last));
  return gaps;
}

// Drop pure empty-text leaves (`{type:"text", text:""}`) the relayout may have
// left behind when one gap absorbed several original text leaves.
function pruneEmptyText(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const n of nodes) {
    const o = n as Record<string, unknown> | null;
    if (o && o["type"] === "text" && o["text"] === "" && !o["children"]) continue;
    if (o && Array.isArray(o["children"])) out.push({ ...o, children: pruneEmptyText(o["children"] as unknown[]) });
    else out.push(n);
  }
  return out;
}

// Punctuation-only relayout. Precondition: within [rawStart, rawEnd] the `\w`
// words are UNCHANGED (same texts, 1:1) and only the surrounding punctuation /
// whitespace differs — a translator wrapping an already-aligned phrase in
// brackets / parentheses / quotes (MIC 5:14 `the {poles … goddess} Asherah`).
// Keep every `\w` leaf (and therefore every enclosing `\zaln` milestone) exactly
// where it is, and re-lay the new punctuation: write each gap's text into the
// first existing text leaf of that gap (emptying any extras), and splice a new
// text node beside the boundary word for a leading / trailing gap that has no
// text leaf inside the range. The words never move, so their alignment survives.
function relayoutPunctuation(
  verseObjects: unknown[],
  rawStart: number,
  rawEnd: number,
  replaceText: string,
): SmartReplaceResult {
  const leaves = walkLeavesWithParents(verseObjects);
  const affected = leaves.filter((l) => l.start < rawEnd && l.end > rawStart);
  const wordLeaves = affected.filter((l) => isWordLeaf(l.node));
  const gaps = nonWordGaps(replaceText);
  const textNode = (text: string) => ({ type: "text", text });
  const insertions: { parent: unknown[]; index: number; node: unknown }[] = [];

  let wi = 0; // words consumed so far → gaps[wi] is the gap before the next word
  let gapHasLeaf = false; // a text leaf has already carried gaps[wi]
  for (const leaf of affected) {
    if (isWordLeaf(leaf.node)) {
      // Leading gap for this word had no text leaf in range — splice it before
      // the word (covers the range-edge gap, e.g. the opening "{").
      if (!gapHasLeaf && gaps[wi]) {
        insertions.push({ parent: leaf.parent, index: leaf.index, node: textNode(gaps[wi]) });
      }
      wi++;
      gapHasLeaf = false;
    } else {
      leaf.node["text"] = gapHasLeaf ? "" : (gaps[wi] ?? "");
      gapHasLeaf = true;
    }
  }
  // Trailing gap after the last word (e.g. the closing "}").
  if (!gapHasLeaf && gaps[wi] && wordLeaves.length > 0) {
    const lastWord = wordLeaves[wordLeaves.length - 1];
    insertions.push({ parent: lastWord.parent, index: lastWord.index + 1, node: textNode(gaps[wi]) });
  }

  // Apply splices grouped by array, highest index first so earlier indices in
  // the SAME array stay valid (e.g. "}" after the last word then "{" before the
  // first, both children of one milestone).
  const byArray = new Map<unknown[], { index: number; node: unknown }[]>();
  for (const ins of insertions) {
    const list = byArray.get(ins.parent) ?? [];
    list.push({ index: ins.index, node: ins.node });
    byArray.set(ins.parent, list);
  }
  for (const [arr, list] of byArray) {
    list.sort((a, b) => b.index - a.index);
    for (const ins of list) arr.splice(ins.index, 0, ins.node);
  }

  const pruned = pruneEmptyText(verseObjects);
  const newRaw = rebuildRaw(pruned);
  return { content: { verseObjects: pruned }, plainText: normalize(newRaw), preservedAlignment: true };
}

// Index of the top-level node whose subtree contains `target`. Used to splice a
// verse-leading gap OUTSIDE the first milestone (top level), matching the uW
// form `\v N “\zaln-s …` rather than burying the opening quote inside the first
// \zaln. Returns 0 if not found (splice at the very front).
function topLevelIndexOf(verseObjects: unknown[], target: unknown): number {
  const contains = (node: unknown): boolean => {
    if (node === target) return true;
    const ch = (node as { children?: unknown })?.children;
    return Array.isArray(ch) && ch.some(contains);
  };
  for (let i = 0; i < verseObjects.length; i++) {
    if (contains(verseObjects[i])) return i;
  }
  return 0;
}

// Whole-verse punctuation relayout for a PURE punctuation / whitespace edit —
// the word sequence is completely unchanged and only the surrounding
// punctuation / spacing differs. The diff tiers can't always handle this: two
// disjoint edits at the verse edges (adding an opening `‘` before the first
// word AND a closing `’` after the last, ZEC 7:14) collapse via
// diffSingleChange into ONE bounding change spanning the whole verse, whose
// right edge lands mid trailing-punctuation leaf. That fails the
// startsAtBoundary/endsAtBoundary gate on the preserve / relayout / rebuild
// tiers, so the edit drops to localizedRewriteVerse, which flattens every
// \zaln. But the alignment never needs to change here: keep every \w (and its
// milestone) exactly and re-lay the new punctuation across the whole verse.
// Returns null when the words AREN'T identical 1:1 (caller uses the diff tiers)
// or the self-check fails — so a real word edit can never reach this path.
function relayoutUnchangedWords(
  input: unknown[],
  newStripped: string,
): SmartReplaceResult | null {
  // Inline markers (\q1, \p, editable \ts\*) are zero-width position anchors
  // between words; a single gap can SPAN one (`says: \q1 "Behold` — the typed
  // `"` belongs AFTER the marker, on the new poetic line). Splitting such a gap
  // correctly is reconcileMarkers' job, not this naive first-leaf relayout, so
  // bail when any in-flow marker is present and let the diff tiers handle it.
  // (The imported trailing `\ts\*` node — tag `ts\*`, not `ts` — is NOT an
  // in-flow marker, so prose verses like ZEC 7:14 still qualify.)
  const hasMarker = (nodes: unknown[]): boolean =>
    nodes.some((n) => {
      if (isInFlowMarker(n)) return true;
      const ch = (n as { children?: unknown } | null)?.children;
      return Array.isArray(ch) && hasMarker(ch);
    });
  if (hasMarker(input)) return null;

  const verseObjects = cloneVerseObjects(input);
  const leaves = walkLeavesWithParents(verseObjects);
  const wordLeaves = leaves.filter((l) => isWordLeaf(l.node));
  const newWords = [...newStripped.matchAll(WORD_RUN_RE)].map((m) => m[0]);
  if (wordLeaves.length === 0 || newWords.length === 0) return null;

  const gaps = nonWordGaps(newStripped); // N+1 gaps around the N word UNITS
  // extractEditableText whitespace-normalizes, dropping structural whitespace
  // (the `\n\n` before a trailing `\ts\*` / the next verse). The in-place
  // preserve path keeps the trailing text leaf verbatim, so mirror it: re-
  // attach the original leading / trailing whitespace to the boundary gaps.
  const raw = rebuildRaw(verseObjects);
  gaps[0] = (raw.match(/^\s*/)?.[0] ?? "") + gaps[0];
  gaps[gaps.length - 1] = gaps[gaps.length - 1] + (raw.match(/\s*$/)?.[0] ?? "");

  const textNode = (text: string) => ({ type: "text", text });
  const insertions: { parent: unknown[]; index: number; node: unknown }[] = [];
  // Walk leaves, grouping consecutive `\w` leaves (plus the intra-token
  // connector text leaves between them) into UNITS that each equal one
  // WORD_RUN_RE token — so a split possessive (`warrior` + `’` + `s` =
  // "warrior’s") or hyphenated name (`Regem` + `-` + `Melek`) counts as ONE
  // word, matching newWords. Each inter-unit gap is re-laid from the new text;
  // intra-unit connectors stay untouched. Any divergence from a clean
  // punctuation-only edit returns null (→ diff tiers).
  let ti = 0; // unit index → gaps[ti] is the gap before the next unit
  let inUnit = false; // currently consuming a multi-leaf word unit
  let acc = ""; // accumulated text of the current unit
  let gapHasLeaf = false; // a text leaf has already carried gaps[ti]
  for (const leaf of leaves) {
    const text = String(leaf.node["text"]);
    if (isWordLeaf(leaf.node)) {
      if (!inUnit) {
        if (ti >= newWords.length) return null; // more word units than tokens
        if (!gapHasLeaf && gaps[ti]) {
          if (ti === 0) {
            // Verse-leading gap with no existing text leaf → splice OUTSIDE the
            // first milestone at top level (uW `\v N “\zaln-s …` form), not inside.
            insertions.push({ parent: verseObjects, index: topLevelIndexOf(verseObjects, leaf.node), node: textNode(gaps[ti]) });
          } else {
            insertions.push({ parent: leaf.parent, index: leaf.index, node: textNode(gaps[ti]) });
          }
        }
        inUnit = true;
        acc = text;
      } else {
        acc += text; // continuation half (the "s" of "warrior’s")
      }
      if (acc === newWords[ti]) { inUnit = false; ti++; gapHasLeaf = false; }
      else if (!newWords[ti].startsWith(acc)) return null; // diverged from token
    } else if (inUnit) {
      // intra-unit connector (the `’` / `-` between split halves) — keep as-is.
      acc += text;
      if (!newWords[ti].startsWith(acc)) return null;
    } else {
      // inter-unit gap leaf
      leaf.node["text"] = gapHasLeaf ? "" : (gaps[ti] ?? "");
      gapHasLeaf = true;
    }
  }
  if (inUnit || ti !== newWords.length) return null; // didn't map every token cleanly
  // Trailing gap after the last unit with no following text leaf.
  if (!gapHasLeaf && gaps[ti]) {
    const lastWord = wordLeaves[wordLeaves.length - 1];
    insertions.push({ parent: lastWord.parent, index: lastWord.index + 1, node: textNode(gaps[ti]) });
  }

  const byArray = new Map<unknown[], { index: number; node: unknown }[]>();
  for (const ins of insertions) {
    const list = byArray.get(ins.parent) ?? [];
    list.push({ index: ins.index, node: ins.node });
    byArray.set(ins.parent, list);
  }
  for (const [arr, list] of byArray) {
    list.sort((a, b) => b.index - a.index);
    for (const ins of list) arr.splice(ins.index, 0, ins.node);
  }

  const pruned = pruneEmptyText(verseObjects);
  const newRaw = rebuildRaw(pruned);
  // Self-check: the rebuilt verse (markers carry no raw text) must normalize to
  // the new stripped text. Any divergence — exotic node shapes, marker-carried
  // text — bails to the diff tiers rather than risk a wrong tree.
  if (normalize(newRaw) !== normalize(newStripped)) return null;
  return { content: { verseObjects: pruned }, plainText: normalize(newRaw), preservedAlignment: true };
}

// LCS over word surface text. Returns link[j] = the index in `oldWords` that
// `newWords[j]` reuses, or -1 when newWords[j] is a genuinely new word. Each old
// word is claimed at most once, order-preserving (leftmost on ties). LCS (not
// greedy-by-occurrence) is mandatory: greedy silently transplants the WRONG
// source word onto a survivor when a duplicate is deleted from between two equal
// words or words are reordered — unaligning is acceptable, mis-aligning is not.
function lcsLink(oldWords: string[], newWords: string[]): number[] {
  const n = oldWords.length, m = newWords.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oldWords[i] === newWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const link = new Array<number>(m).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldWords[i] === newWords[j]) { link[j] = i; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return link;
}

// An inert line-break marker: an in-flow `\q*`/`\p`/`\b` quote/paragraph node
// (NOT a `\qs`/`\f` content wrapper) with zero raw width — no `text`, no
// `children`, no `endTag`. These sit BETWEEN content nodes as pure position
// anchors. smartRebuildRange can re-lay a range that spans them (it splits any
// straddling gap so closing punctuation lands BEFORE the marker), so the range
// rebuild may include them; anything else markerish (a wrapper, a marker
// carrying text/children) must still bail.
function isInertLineBreakMarker(node: unknown): boolean {
  if (!isInFlowMarker(node) || isCharacterWrapper(node)) return false;
  const o = node as Record<string, unknown>;
  if (typeof o["text"] === "string" && o["text"] !== "") return false;
  if (Array.isArray(o["children"]) && o["children"].length > 0) return false;
  if (typeof o["endTag"] === "string" && o["endTag"] !== "") return false;
  return true;
}

// True when [rawStart,rawEnd) contains ONLY \w words, plain text, \zaln
// milestones, and inert line-break markers (\q/\p/\b) — no \qs/\f content
// wrappers, no markers carrying text/children. The range rebuild rewrites the
// region wholesale; it can pass an inert marker through in document position and
// split any gap that straddles it, but anything it can't safely reconstruct
// means: don't fire, fall back.
function rangeIsClean(nodes: unknown[], rawStart: number, rawEnd: number): boolean {
  let pos = 0;
  let clean = true;
  const walk = (arr: unknown[]) => {
    for (const n of arr) {
      if (!clean) return;
      const o = n as Record<string, unknown> | null;
      const startPos = pos;
      if (o && typeof o["text"] === "string") pos += (o["text"] as string).length;
      if (o && Array.isArray(o["children"])) walk(o["children"] as unknown[]);
      const endPos = pos;
      if (!o) continue;
      if (endPos <= rawStart || startPos >= rawEnd) continue; // outside range
      const isWord = o["type"] === "word" && o["tag"] === "w";
      const isText = o["type"] === "text" && typeof o["text"] === "string" && !Array.isArray(o["children"]);
      const isZaln = o["tag"] === "zaln" && Array.isArray(o["children"]);
      // An inert line-break marker is OK (handled by the gap-split below); any
      // OTHER in-flow marker (wrapper / text-bearing) still bails.
      if (isInertLineBreakMarker(n)) continue;
      if (isInFlowMarker(n) || (!isWord && !isText && !isZaln)) { clean = false; return; }
    }
  };
  walk(nodes);
  return clean;
}

// Drop \zaln milestones that, after the rebuild, contain no \w descendant (e.g.
// a milestone whose only word was deleted): promote their remaining children
// (stray punctuation) up a level so no empty alignment wrapper survives.
function pruneDeadMilestones(nodes: unknown[]): unknown[] {
  const hasWord = (arr: unknown[]): boolean =>
    arr.some((n) => {
      const o = n as Record<string, unknown> | null;
      if (!o) return false;
      if (o["type"] === "word" && o["tag"] === "w") return true;
      return Array.isArray(o["children"]) ? hasWord(o["children"] as unknown[]) : false;
    });
  const out: unknown[] = [];
  for (const n of nodes) {
    const o = n as Record<string, unknown> | null;
    if (o && Array.isArray(o["children"])) {
      const kids = pruneDeadMilestones(o["children"] as unknown[]);
      if (o["tag"] === "zaln" && !hasWord(kids)) for (const k of kids) out.push(k);
      else out.push({ ...o, children: kids });
    } else out.push(n);
  }
  return out;
}

// Strip the transient rebuild marks off a node, returning a shallow copy.
function stripRebuildMarks(o: Record<string, unknown>): Record<string, unknown> {
  const { __planned: _p, __gapBefore: _gb, __gapAfter: _ga, __insBefore: _ib, __insAfter: _ia, __drop: _d, __markerClosing: _mc, ...rest } =
    o as Record<string, unknown> & Record<string, unknown>;
  return rest;
}

// Whitespace + CLOSING punctuation that hugs a word's RIGHT edge — the run that
// belongs to the line BEFORE a `\q`/`\p` line break. Shared verbatim with
// reconcileMarkers (its placement loop uses the same class) so smartRebuildRange
// splits a marker-straddling gap on exactly the convention reconcileMarkers will
// re-confirm in step 2. The em-dash is deliberately excluded: it leads as often
// as it trails (ZEC 13:7 `companion” \q1 —the`).
const MARKER_CLOSING_RE = /[\s,.;:!?)\]}”’…]/;

// Split a gap string into the CLOSING run that trails the previous word (belongs
// BEFORE a line-break marker) and the remainder that leads the next word
// (belongs AFTER it). Mirrors reconcileMarkers' "skip whitespace+closing, drop
// the marker at the first opening-punct/word" rule.
function splitGapAtMarker(gap: string): { closing: string; rest: string } {
  let i = 0;
  while (i < gap.length && MARKER_CLOSING_RE.test(gap[i])) i++;
  return { closing: gap.slice(0, i), rest: gap.slice(i) };
}

// Combined word+punctuation rebuild for a boundary-aligned, marker-free range
// where the word COUNT or word IDENTITIES changed (insert / delete / replace)
// AND/OR punctuation changed — the "fix the whole verse at once" case the four
// tiers above all miss. Survivors (words present unchanged) keep their exact
// milestone ancestry by STAYING IN the cloned tree; new words are spliced in as
// bare `__edited` \w next to a survivor so the existing liftEditedOutOfZaln pops
// them out and splits the milestone around them (handles nesting for free);
// deleted survivors are dropped; the new punctuation is re-laid as gap text.
// A reconstruction self-check guarantees no text is ever lost: on ANY mismatch
// (or any failed gate) it returns null and the caller falls back to the exact
// localizedRewriteVerse that runs today, so a verse is never made worse.
function smartRebuildRange(
  cloned: unknown[],
  raw: string,
  rawStart: number,
  rawEnd: number,
  matchWords: string[],
  replaceText: string,
  replaceWords: string[],
): SmartReplaceResult | null {
  if (!rangeIsClean(cloned, rawStart, rawEnd)) return null;
  if (matchWords.length === 0 || replaceWords.length === 0) return null;

  const leaves = walkLeavesWithParents(cloned);
  const inRange = leaves.filter((l) => l.start < rawEnd && l.end > rawStart);

  // Group in-range \w leaves into WORD UNITS. WORD_RUN_RE can bind several \w
  // leaves into ONE token while the tree stores them apart: a connector splits
  // them (Yahweh’s = \w "Yahweh" + text "’" + \w "s") or they sit adjacent
  // across a milestone boundary (Asherahs = \w "Asherah" + \w "s" in two
  // milestones). Map each matchWord token to the \w leaves whose raw offset
  // falls in its span, so a survivor is reused as a whole unit (all its leaves
  // + interior connector text stay put). Without this, a possessive anywhere in
  // the range defeats the 1:1 leaf↔word assumption and the whole edit unaligns.
  const tokens = [...raw.slice(rawStart, rawEnd).matchAll(WORD_RUN_RE)].map((m) => {
    const s = rawStart + (m.index ?? 0);
    return { start: s, end: s + m[0].length };
  });
  if (tokens.length !== matchWords.length) return null;
  const units: { leaves: ParentLeaf[] }[] = tokens.map(() => ({ leaves: [] }));
  for (const l of inRange) {
    if (!isWordLeaf(l.node)) continue;
    const k = tokens.findIndex((t) => l.start >= t.start && l.start < t.end);
    if (k < 0) return null; // a \w leaf outside every token span — unexpected
    units[k].leaves.push(l);
  }
  if (units.some((u) => u.leaves.length === 0)) return null; // a word with no \w leaf

  const link = lcsLink(matchWords, replaceWords);
  if (!link.some((x) => x >= 0)) return null; // no survivor → fall back
  const consumed = new Set<number>(link.filter((x) => x >= 0));
  const gaps = nonWordGaps(replaceText); // m+1 gaps; gaps[j] precedes word j

  // Plan: tag each survivor unit (gapBefore on its first leaf), collect new words.
  const newWords: { j: number; node: Record<string, unknown> }[] = [];
  const trailNode: (Record<string, unknown>)[] = new Array(replaceWords.length);
  for (let j = 0; j < replaceWords.length; j++) {
    if (link[j] >= 0) {
      const u = units[link[j]];
      u.leaves[0].node["__planned"] = true;
      u.leaves[0].node["__gapBefore"] = gaps[j];
      trailNode[j] = u.leaves[u.leaves.length - 1].node;
    } else {
      const node: Record<string, unknown> = { type: "word", tag: "w", text: replaceWords[j], occurrence: "1", occurrences: "1", __edited: true, __gapBefore: gaps[j] };
      newWords.push({ j, node });
      trailNode[j] = node;
    }
  }
  trailNode[replaceWords.length - 1]["__gapAfter"] = gaps[replaceWords.length];

  // Deleted units → drop all their \w leaves. In-range text → dropped (gaps are
  // re-laid fresh) EXCEPT text interior to a SURVIVING unit (its connectors).
  for (let k = 0; k < units.length; k++) if (!consumed.has(k)) for (const l of units[k].leaves) l.node["__drop"] = true;
  const survivorInterior = (l: ParentLeaf): boolean =>
    tokens.some((t, k) => consumed.has(k) && l.start >= t.start && l.end <= t.end);
  for (const l of inRange) if (!isWordLeaf(l.node) && !survivorInterior(l)) l.node["__drop"] = true;

  // Anchor each new word to the nearest survivor unit edge (left unit's LAST leaf
  // → insert after; else right unit's FIRST leaf → insert before), so it lands
  // INSIDE that milestone and liftEditedOutOfZaln splits the milestone around it.
  for (const nw of newWords) {
    let anchor: Record<string, unknown> | null = null;
    let key = "__insAfter";
    for (let j2 = nw.j - 1; j2 >= 0; j2--) if (link[j2] >= 0) { const u = units[link[j2]]; anchor = u.leaves[u.leaves.length - 1].node; key = "__insAfter"; break; }
    if (!anchor) for (let j2 = nw.j + 1; j2 < replaceWords.length; j2++) if (link[j2] >= 0) { const u = units[link[j2]]; anchor = u.leaves[0].node; key = "__insBefore"; break; }
    if (!anchor) return null; // unreachable (survivor exists) — be safe
    const list = (anchor[key] as unknown[] | undefined) ?? [];
    list.push(nw.node);
    anchor[key] = list;
  }

  // Marker-straddling gap split. An inert line-break marker (\q/\p/\b) sits at
  // top level BETWEEN two words. The gap between those words was re-laid fresh as
  // the next word's __gapBefore — which is emitted INSIDE that word's milestone,
  // i.e. AFTER the marker, trapping a trailing comma on the wrong side of the
  // line break. Split each such gap on the closing/opening boundary: the CLOSING
  // run (belongs to the previous line) is stashed on the marker as __markerClosing
  // and emitted as a bare text node BEFORE it; the remainder stays __gapBefore and
  // leads the next word AFTER the marker. This is the same rule reconcileMarkers
  // applies in step 2, so the output is a fixed point under it. Walk the top-level
  // nodes in document order (markers only ever sit at top level in aligned source)
  // and, for each marker, find the next word-bearing node carrying __gapBefore.
  const firstGapLeafAfter = (fromIdx: number): Record<string, unknown> | null => {
    for (let i = fromIdx; i < cloned.length; i++) {
      const found = findGapBearer(cloned[i]);
      if (found) return found;
    }
    return null;
  };
  function findGapBearer(node: unknown): Record<string, unknown> | null {
    const o = node as Record<string, unknown> | null;
    if (!o || o["__drop"]) return null;
    // A new word spliced before/after this node carries the leading gap.
    if (Array.isArray(o["__insBefore"]) && (o["__insBefore"] as Record<string, unknown>[])[0]?.["__gapBefore"] !== undefined)
      return (o["__insBefore"] as Record<string, unknown>[])[0];
    if (Object.prototype.hasOwnProperty.call(o, "__gapBefore")) return o;
    if (Array.isArray(o["children"])) {
      for (const c of o["children"] as unknown[]) {
        const found = findGapBearer(c);
        if (found) return found;
      }
    }
    if (Array.isArray(o["__insAfter"]) && (o["__insAfter"] as Record<string, unknown>[])[0]?.["__gapBefore"] !== undefined)
      return (o["__insAfter"] as Record<string, unknown>[])[0];
    return null;
  }
  for (let i = 0; i < cloned.length; i++) {
    const o = cloned[i] as Record<string, unknown> | null;
    if (!o || !isInertLineBreakMarker(o)) continue;
    const bearer = firstGapLeafAfter(i + 1);
    if (!bearer) continue; // trailing marker — its preceding word's __gapAfter
                            // already emits before it; nothing to split.
    const gap = String(bearer["__gapBefore"] ?? "");
    const { closing, rest } = splitGapAtMarker(gap);
    o["__markerClosing"] = closing;
    bearer["__gapBefore"] = rest;
  }

  const pushWord = (out: unknown[], nw: Record<string, unknown>) => {
    if (nw["__gapBefore"]) out.push({ type: "text", text: nw["__gapBefore"] });
    out.push({ type: "word", tag: "w", text: nw["text"], occurrence: "1", occurrences: "1", __edited: true });
    if (nw["__gapAfter"]) out.push({ type: "text", text: nw["__gapAfter"] });
  };
  const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const pushNode = (out: unknown[], n: unknown) => {
    const o = n as Record<string, unknown> | null;
    // A survivor \w leaf carrying gap marks (a unit's first leaf has __gapBefore;
    // the range's last word carries __gapAfter — which may be a non-first leaf of
    // a multi-leaf unit). Mid-unit leaves carry no marks → emitted verbatim.
    if (o && (o["__planned"] || has(o, "__gapBefore") || has(o, "__gapAfter"))) {
      if (o["__gapBefore"]) out.push({ type: "text", text: o["__gapBefore"] });
      out.push(stripRebuildMarks(o));
      if (o["__gapAfter"]) out.push({ type: "text", text: o["__gapAfter"] });
    } else if (o && Array.isArray(o["children"])) {
      out.push({ ...stripRebuildMarks(o), children: rebuild(o["children"] as unknown[]) });
    } else {
      out.push(n);
    }
  };
  function rebuild(nodes: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const n of nodes) {
      const o = n as Record<string, unknown> | null;
      if (o && o["__drop"]) continue;
      // An inert line-break marker: emit its stashed CLOSING punctuation as a
      // bare text node BEFORE it (so a trailing comma stays on the previous
      // line), then the marker verbatim. Its trailing gap leads the next word.
      if (o && isInertLineBreakMarker(o)) {
        if (o["__markerClosing"]) out.push({ type: "text", text: o["__markerClosing"] });
        out.push(stripRebuildMarks(o));
        continue;
      }
      if (o && Array.isArray(o["__insBefore"])) for (const nw of o["__insBefore"] as Record<string, unknown>[]) pushWord(out, nw);
      pushNode(out, n);
      if (o && Array.isArray(o["__insAfter"])) for (const nw of o["__insAfter"] as Record<string, unknown>[]) pushWord(out, nw);
    }
    return out;
  }

  let outVOs = rebuild(cloned);
  outVOs = stripLiftedMarkers(liftEditedOutOfZaln(outVOs));
  outVOs = pruneDeadMilestones(outVOs);
  outVOs = pruneEmptyText(outVOs);

  // Self-check: the rebuilt raw text must equal exactly what the user typed for
  // this range. Whitespace-collapse is allowed; anything else means a splice bug
  // — discard and let the caller fall back to localizedRewriteVerse.
  const newRaw = rebuildRaw(outVOs);
  const expected = raw.slice(0, rawStart) + replaceText + raw.slice(rawEnd);
  if (normalize(newRaw) !== normalize(expected)) return null;
  return { content: { verseObjects: outVOs }, plainText: normalize(newRaw), preservedAlignment: true };
}

// Smart replace: given the verse content, the plain text the match was
// found in, the regex used, and the literal active-match info, produce a
// new content + plain text. Tries to keep alignment when possible.
export function smartReplaceVerse(
  content: unknown,
  plainText: string,
  regex: RegExp,
  matchStartInPlain: number,
  matchLenInPlain: number,
  replaceText: string,
): SmartReplaceResult {
  const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  // No verseObjects to work with — just rebuild the verse from the new
  // plain text, tokenized.
  if (!Array.isArray(verseObjects)) {
    const before = plainText.slice(0, matchStartInPlain);
    const after = plainText.slice(matchStartInPlain + matchLenInPlain);
    const newPlain = normalize(before + replaceText + after);
    return {
      content: { verseObjects: tokenizeEditableText(newPlain) },
      plainText: newPlain,
      preservedAlignment: false,
    };
  }

  // Determine which occurrence (1-based) the active match is, then find
  // the corresponding occurrence in the raw verseObjects concatenation.
  const occurrenceNum = countMatchesBefore(plainText, regex, matchStartInPlain) + 1;
  const cloned = cloneVerseObjects(verseObjects);
  const { raw, leaves } = walkLeaves(cloned);
  // Raw can contain `\n` (or multi-space) where plainText has a single space —
  // notably around `{...}` word-addition markers and across line-broken
  // `\w` tokens. The strict regex was derived from normalized plainText, so
  // when we search raw, treat each literal space as `\s+` so the same
  // structural match anchors regardless of internal whitespace.
  const rawRegex = relaxWhitespace(regex);
  const rawMatch = nthMatchIn(raw, rawRegex, occurrenceNum);

  // If the raw search yields nothing (normalization wiped a match, or
  // the match text spans an inline marker token like "\p " that has no
  // counterpart in raw), fall back to the flat tokenized path so we at
  // least produce \w nodes and any embedded markers stay as paragraph
  // nodes.
  if (!rawMatch) {
    const before = plainText.slice(0, matchStartInPlain);
    const after = plainText.slice(matchStartInPlain + matchLenInPlain);
    const newPlain = normalize(before + replaceText + after);
    return {
      content: { verseObjects: tokenizeEditableText(newPlain) },
      plainText: newPlain,
      preservedAlignment: false,
    };
  }

  const rawStart = rawMatch.index;
  const rawEnd = rawStart + rawMatch.length;
  const rawMatchText = raw.slice(rawStart, rawEnd);

  // Smart in-place path requires:
  //   (a) match boundaries align with leaf boundaries — no mid-leaf splits;
  //   (b) word-count parity between find and replace strings;
  //   (c) same number of \w leaves in the affected range as words on
  //       either side, so the 1:1 mapping is unambiguous;
  //   (d) every \w leaf's existing text equals the corresponding word
  //       extracted from rawMatchText — guards against attached punctuation
  //       (e.g. raw `"good,"` parses as text "good" inside a \w then a
  //       sibling text node ",". A naive `split(/\s+/)` would group those
  //       as one token "good," and we'd write "," back into the word leaf.)
  //   (e) at least one word in the match — a zero-word (whitespace /
  //       punctuation-only) change has nothing for the in-place loop to
  //       rewrite, so the edit would be silently discarded; route it to
  //       the localized rewrite instead.
  const affected = leaves.filter((l) => l.start < rawEnd && l.end > rawStart);
  const startsAtBoundary = affected.length > 0 && affected[0].start === rawStart;
  const endsAtBoundary = affected.length > 0 && affected[affected.length - 1].end === rawEnd;
  // Use the same word-run regex as tokenizePlainText so "word characters"
  // (letters / marks / numbers / intra-word `-` `'` `’`) define a word — punctuation
  // doesn't ride along.
  const matchWords = [...rawMatchText.matchAll(WORD_RUN_RE)].map((m) => m[0]);
  const replaceWords = [...replaceText.matchAll(WORD_RUN_RE)].map((m) => m[0]);
  const wordLeaves = affected.filter((l) => isWordLeaf(l.node));
  const wordsMatchLeaves =
    wordLeaves.length === matchWords.length &&
    wordLeaves.every((l, i) => String(l.node["text"]) === matchWords[i]);
  // (f) the NON-word characters (punctuation / inter-word spacing) match too.
  //     The preserve path only rewrites \w leaves and keeps the surrounding
  //     text leaves verbatim, so a punctuation-only difference (find `good`,
  //     replace `good,`) would be silently dropped — the words map 1:1 but the
  //     comma has nowhere to land. Compare the word-stripped skeletons; if they
  //     differ, fall through to the localized rewrite, which re-tokenizes the
  //     region and emits the new punctuation. Collapse whitespace runs first:
  //     `rawMatchText` is sliced from raw leaf text and can carry a `\n` (or a
  //     double space) where the normalized `replaceText` has a single space
  //     (line-broken \w tokens, word-addition `{...}` markers). Without the
  //     collapse a pure 1:1 word replacement spanning such a break fails the
  //     skeleton check and drops to the localized rewrite, which unaligns even
  //     the UNCHANGED words inside the match.
  const skeleton = (s: string): string => s.replace(WORD_RUN_RE, "").replace(/\s+/g, " ");
  const sameSkeleton = skeleton(rawMatchText) === skeleton(replaceText);
  const canPreserve =
    startsAtBoundary &&
    endsAtBoundary &&
    matchWords.length > 0 &&
    matchWords.length === replaceWords.length &&
    wordsMatchLeaves &&
    sameSkeleton;

  if (canPreserve) {
    // 1:1 word mapping. Whitespace text leaves between words stay as-is.
    // Each word leaf whose text actually changes is marked `__edited` so
    // the lift pass below can pop it out of its `\zaln-s` ancestor(s) —
    // a translator's edit invalidates the old alignment, so the new word
    // becomes a bare unaligned chip. Unchanged neighbors stay aligned.
    let anyChanged = false;
    for (let i = 0; i < wordLeaves.length; i++) {
      if (String(wordLeaves[i].node["text"]) !== replaceWords[i]) {
        wordLeaves[i].node["text"] = replaceWords[i];
        wordLeaves[i].node["__edited"] = true;
        anyChanged = true;
      }
    }
    const verseObjectsOut = anyChanged ? stripLiftedMarkers(liftEditedOutOfZaln(cloned)) : cloned;
    const newRaw = rebuildRaw(verseObjectsOut);
    return {
      content: { verseObjects: verseObjectsOut },
      plainText: normalize(newRaw),
      preservedAlignment: true,
    };
  }

  // Single-leaf in-place edit: the change starts and ends within ONE word
  // leaf (e.g. `Praise` → `Praising` types into the middle/end of a single
  // \w word). Splice the new chars directly into that leaf's text. Only
  // safe when the result is a single clean word (no whitespace, no
  // punctuation that would normally split it into multiple \w tokens).
  // Same unalign rule as the preserve path: the edited leaf gets lifted
  // out of its `\zaln-s` ancestor — sibling content like `\qs` / `\f`
  // and the OTHER half of a multi-word milestone survive intact.
  if (affected.length === 1 && isWordLeaf(affected[0].node)) {
    const leaf = affected[0];
    const leafText = String(leaf.node["text"]);
    const newLeafText =
      leafText.slice(0, rawStart - leaf.start) +
      replaceText +
      leafText.slice(rawEnd - leaf.start);
    // Use a local, non-global regex so we don't fight WORD_RUN_RE.lastIndex.
    const ONLY_WORD_RE = new RegExp(`^${WORD_RUN_RE.source}$`, "u");
    if (
      newLeafText.length > 0 &&
      !/\s/.test(newLeafText) &&
      ONLY_WORD_RE.test(newLeafText) &&
      newLeafText !== leafText
    ) {
      leaf.node["text"] = newLeafText;
      leaf.node["__edited"] = true;
      const verseObjectsOut = stripLiftedMarkers(liftEditedOutOfZaln(cloned));
      const newRaw = rebuildRaw(verseObjectsOut);
      return {
        content: { verseObjects: verseObjectsOut },
        plainText: normalize(newRaw),
        preservedAlignment: true,
      };
    }
  }

  // Punctuation-only relayout: the words map 1:1 AND their text is unchanged —
  // the ONLY difference is the surrounding punctuation/whitespace (the preserve
  // path above bailed solely because the skeleton differs). This is a
  // translator wrapping an aligned phrase in brackets / parentheses / quotes
  // (MIC 5:14 `the {poles … goddess} Asherah`). The localized rewrite would
  // re-tokenize the whole range UNALIGNED; instead keep every \w (and its
  // milestone) put and just re-lay the new punctuation around them.
  const wordsUnchanged =
    startsAtBoundary &&
    endsAtBoundary &&
    matchWords.length > 0 &&
    matchWords.length === replaceWords.length &&
    wordsMatchLeaves &&
    matchWords.every((mw, i) => mw === replaceWords[i]);
  if (wordsUnchanged) {
    return relayoutPunctuation(cloned, rawStart, rawEnd, replaceText);
  }

  // Combined word + punctuation edit (the "fix the whole verse at once" flow):
  // the word count / identities changed AND/OR punctuation changed, but the
  // surviving words still map 1:1 onto the old \w leaves. Keep every survivor's
  // alignment, unalign only the genuinely new/changed words, re-lay punctuation.
  // Gated + self-checked; returns null (→ localizedRewriteVerse) on any doubt.
  // No wordsMatchLeaves requirement here: smartRebuildRange forms its own word
  // UNITS (so split possessives like "Yahweh’s" / "Asherahs" are handled) and
  // bails internally if it can't map cleanly.
  if (startsAtBoundary && endsAtBoundary && matchWords.length > 0 && replaceWords.length > 0) {
    const rebuilt = smartRebuildRange(cloned, raw, rawStart, rawEnd, matchWords, replaceText, replaceWords);
    if (rebuilt) return rebuilt;
  }

  // Structural mismatch — fall through to the localized rewrite so only
  // the milestones overlapping the change are destroyed (rather than the
  // whole verse).
  return localizedRewriteVerse(content, plainText, matchStartInPlain, matchLenInPlain, replaceText);
}

// Plain-text diff: the smallest contiguous substring change that turns
// `oldText` into `newText`. Returns the start, the length of the deleted
// portion in `oldText`, and the inserted substring. Most user edits boil
// down to exactly one such change (typing into a selection, replacing a
// word, deleting a stretch); for arbitrary multi-region edits we still
// produce a single bounding change, which the localized rewrite handles by
// dropping anything inside that bounding range.
function diffSingleChange(
  oldText: string,
  newText: string,
): { start: number; oldLen: number; newSubstring: string } {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldText[oldSuffix - 1] === newText[newSuffix - 1]
  ) {
    oldSuffix--;
    newSuffix--;
  }
  return {
    start: prefix,
    oldLen: oldSuffix - prefix,
    newSubstring: newText.slice(prefix, newSuffix),
  };
}

// Letters / marks / numbers that count as the "core" of a word — the same character
// class WORD_RUN_RE builds words from (its intra-word connectors -'’ only
// bind between letters, so they don't matter for a boundary-adjacency test).
const WORD_CORE_RE = new RegExp(WORD_CHAR, "u");

// A minimal diff can report a word edit as a pure insertion: typing "Th"
// immediately before the word "is" diffs as `insert "Th" at offset N`, not
// `replace "is" with "This"`. Left as an insertion, localizedRewriteVerse
// tokenizes the inserted run on its own and emits a SEPARATE \w — so the verse
// ends up with two chips "Th" + "is" instead of one "This" (the ZEC 5:3 bug).
//
// When inserted text abuts existing word characters with no separator, those
// characters form ONE token. Snap the change region outward over the adjacent
// word run(s) so the edit becomes a word REPLACEMENT, which smartReplaceVerse
// rewrites in place on the existing \w leaf (and unaligns it, like any other
// word edit). Returns the diff unchanged when neither side merges — a genuine
// new word, flanked by spaces/punctuation, is left as an insertion.
function snapDiffToWordBoundaries(
  oldText: string,
  newText: string,
  diff: { start: number; oldLen: number; newSubstring: string },
): { start: number; oldLen: number; newSubstring: string } {
  const isCore = (c: string | undefined): boolean => c !== undefined && WORD_CORE_RE.test(c);
  // Intra-word connectors (apostrophe in can't / Isaiah's, hyphen in
  // hello-world, grouping comma in 300,000) bind two core runs into one
  // WORD_RUN_RE token — but ONLY when a core char sits on BOTH sides of the
  // connector. A connector with a core char on just ONE side is ordinary
  // boundary punctuation, not part of a token: a comma or possessive
  // apostrophe typed AFTER a word and before a space (`good,` / `Moses'`), or
  // a trailing grouping comma (`1,000,`). Snapping the match onto the
  // neighbouring word in those cases is wrong — it routes the unchanged word
  // through the localized rewrite, which unaligns it (and for `1,000,` snaps
  // mid-number and splits the token). So a run only "binds" toward a neighbour
  // when its boundary char is core, or is a connector whose OTHER side is core.
  const isConnector = (c: string | undefined): boolean =>
    c === "-" || c === "'" || c === "’" || c === ",";
  const sub = diff.newSubstring;
  if (sub.length === 0) return diff; // pure deletion — nothing to merge.
  const start0 = diff.start;
  const end0 = diff.start + diff.oldLen;
  let start = start0;
  let end = end0;
  // A boundary char binds outward if it's core, or a connector whose far side
  // (the next char further INTO the run, or — for a 1-char run — the char on
  // the far side of the change) is also core. Compute both before mutating
  // start/end so the right-edge snap can't disturb the left-edge's lookups.
  const first = sub[0];
  const last = sub[sub.length - 1];
  const bindsLeft =
    isCore(first) ||
    (isConnector(first) && isCore(sub.length > 1 ? sub[1] : oldText[end0]));
  const bindsRight =
    isCore(last) ||
    (isConnector(last) && isCore(sub.length > 1 ? sub[sub.length - 2] : oldText[start0 - 1]));
  // Right edge: inserted run ends in a word char / binding connector that runs
  // straight into the word char after the change → absorb the trailing word.
  if (bindsRight && isCore(oldText[end])) {
    while (end < oldText.length && isCore(oldText[end])) end++;
  }
  // Left edge: inserted run starts with a word char / binding connector that
  // runs straight out of the word char before the change → absorb the leading word.
  if (bindsLeft && isCore(oldText[start - 1])) {
    while (start > 0 && isCore(oldText[start - 1])) start--;
  }
  if (start === start0 && end === end0) return diff;
  // The expansion only ever covers characters shared by oldText / newText (the
  // diff's common prefix on the left, common suffix on the right), so the
  // matching newText window is the same span shifted by the length delta.
  const newEnd = newText.length - (oldText.length - end);
  return { start, oldLen: end - start, newSubstring: newText.slice(start, newEnd) };
}

// A pure insertion has a RANGE of equivalent positions: the inserted block can
// be slid left/right wherever its rotation leaves the result string unchanged.
// diffSingleChange always reports the rightmost such position (it maximizes the
// common prefix). When the inserted text shares a boundary letter with the next
// word, that rightmost position lands MID-word — e.g. inserting "truly " before
// "the" reports `insert "ruly t"` straddling "the" (both start with "t"). snap
// then absorbs the whole "the" into the change, so the localized rewrite re-
// tokenizes "the" UNALIGNED even though the translator only added a word in
// front of it. (Measured: the dominant collateral-unalign family.)
//
// Fix: for a pure insertion, slide the block across all its equivalent
// positions and prefer one where it does NOT straddle a token — using snap
// itself as the straddle oracle (snap leaves a non-straddling insertion
// unchanged). A genuine word-extension ("Th" before "is" → "This", a digit
// against a number, a grouping comma) has NO non-straddling position, so it
// falls through to the original diff and snap handles it exactly as before.
function canonicalizePureInsertion(
  oldText: string,
  newText: string,
  diff: { start: number; oldLen: number; newSubstring: string },
): { start: number; oldLen: number; newSubstring: string } {
  if (diff.oldLen !== 0 || diff.newSubstring.length === 0) return diff;
  const candidates: { start: number; oldLen: number; newSubstring: string }[] = [];
  // Slide left: valid while the block's last char equals the char before it.
  let s = diff.start;
  let b = diff.newSubstring;
  candidates.push({ start: s, oldLen: 0, newSubstring: b });
  while (s > 0 && b[b.length - 1] === oldText[s - 1]) {
    b = oldText[s - 1] + b.slice(0, -1);
    s--;
    candidates.push({ start: s, oldLen: 0, newSubstring: b });
  }
  // Slide right: valid while the block's first char equals the char after it.
  s = diff.start;
  b = diff.newSubstring;
  while (s < oldText.length && b[0] === oldText[s]) {
    b = b.slice(1) + oldText[s];
    s++;
    candidates.push({ start: s, oldLen: 0, newSubstring: b });
  }
  // A position is "clean" when snap finds no token to absorb on either side.
  for (const c of candidates) {
    const snapped = snapDiffToWordBoundaries(oldText, newText, c);
    if (snapped.oldLen === 0 && snapped.start === c.start) return c;
  }
  return diff;
}

// The deletion counterpart of canonicalizePureInsertion. diffSingleChange reports
// the CHARACTER-minimal deletion, which when the deleted word shares a boundary
// letter with a neighbour cuts MID-NEIGHBOUR — e.g. deleting "again" from
// "conceived again and" diffs as delete "gain a" (the "a" of "again" and of
// "and" alias), so localizedRewriteVerse splits the untouched "and" into "a"
// (left inside "again"'s milestone) + "nd". Slide the deleted block across its
// equivalent positions (a rotation that leaves the result unchanged) and pick
// one whose BOTH boundaries sit at word edges, so the range covers a whole word
// and no neighbour is shattered. A deletion with no word-clean position (rare)
// falls through unchanged. (Deletion analogue of the ZEC 5:3 insertion fix.)
function canonicalizePureDeletion(
  oldText: string,
  diff: { start: number; oldLen: number; newSubstring: string },
): { start: number; oldLen: number; newSubstring: string } {
  if (diff.oldLen === 0 || diff.newSubstring.length !== 0) return diff;
  const isCore = (c: string | undefined): boolean => c !== undefined && WORD_CORE_RE.test(c);
  const len = diff.oldLen;
  const straddles = (start: number): boolean =>
    (isCore(oldText[start - 1]) && isCore(oldText[start])) ||
    (isCore(oldText[start + len - 1]) && isCore(oldText[start + len]));
  const candidates: number[] = [diff.start];
  // Slide left: deleting one position earlier is equivalent while the char before
  // the block equals the block's last char.
  let s = diff.start;
  while (s > 0 && oldText[s - 1] === oldText[s + len - 1]) { s--; candidates.push(s); }
  // Slide right: equivalent while the char after the block equals its first char.
  s = diff.start;
  while (s + len < oldText.length && oldText[s + len] === oldText[s]) { s++; candidates.push(s); }
  for (const c of candidates) if (!straddles(c)) return { start: c, oldLen: len, newSubstring: "" };
  return diff;
}

// When two words that SHARE A BOUNDARY LETTER are swapped / reordered (or one is
// an affix of the other), diffSingleChange produces a CHARACTER-minimal bounding
// replacement that cuts MID-WORD — e.g. swapping 'their'/'the' in "their king the"
// diffs as replace "ir king the" → " king their" (the shared "the" stays in the
// common prefix), and 'net'/'dragnet' diffs as replace "net and drag" → "dragnet
// and " (the shared "net" suffix aliases). Left mid-word, smartReplaceVerse's
// boundary gates reject it and it drops to localizedRewriteVerse, which splits a
// milestone mid-word and leaves a FRAGMENT of the OLD word (now carrying the NEW
// word's text) INSIDE the foreign milestone — that fragment renders aligned to
// Hebrew it never belonged to (HOS 7:3, ZEC 7:7, HAB 1:16).
//
// Fix: for a REPLACEMENT whose range straddles a word boundary AND spans MORE
// THAN ONE word, expand both edges out to whole-word boundaries. localizedRewrite
// then drops WHOLE milestones in the range (the reordered words go bare —
// acceptable; reordering legitimately unaligns) instead of transplanting a
// fragment. A SINGLE-word mid-word replacement (Case 5 "that"→"this", or the
// mid-word single-word edits that diff as pure insertions in Cases 25/27) touches
// only one word, so it is left untouched and keeps its own alignment.
function snapReplacementToWordBoundaries(
  oldText: string,
  newText: string,
  diff: { start: number; oldLen: number; newSubstring: string },
): { start: number; oldLen: number; newSubstring: string } {
  if (diff.oldLen === 0 || diff.newSubstring.length === 0) return diff;
  const isCore = (c: string | undefined): boolean => c !== undefined && WORD_CORE_RE.test(c);
  const start0 = diff.start;
  const end0 = diff.start + diff.oldLen;
  const leftMidWord = isCore(oldText[start0 - 1]) && isCore(oldText[start0]);
  const rightMidWord = isCore(oldText[end0 - 1]) && isCore(oldText[end0]);
  if (!leftMidWord && !rightMidWord) return diff; // already on word edges
  // Count how many WORD_RUN_RE tokens the (unexpanded) range overlaps. A single
  // word is a genuine in-word edit — leave it for the in-place / split paths.
  let wordsTouched = 0;
  for (const m of oldText.matchAll(WORD_RUN_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (s < end0 && e > start0) wordsTouched++;
  }
  if (wordsTouched < 2) return diff;
  // Expand each mid-word edge outward over the rest of its word. These chars sit
  // in the diff's common prefix (left) / suffix (right), so they're identical in
  // oldText / newText — the matching newText window is the same span shifted by
  // the length delta, exactly as snapDiffToWordBoundaries computes it.
  let start = start0;
  let end = end0;
  while (start > 0 && isCore(oldText[start - 1])) start--;
  while (end < oldText.length && isCore(oldText[end])) end++;
  if (start === start0 && end === end0) return diff;
  const newEnd = newText.length - (oldText.length - end);
  return { start, oldLen: end - start, newSubstring: newText.slice(start, newEnd) };
}

// A punctuation-only edit BETWEEN unchanged words can leave the diff's right (or
// left) edge MID-GAP rather than on a word boundary: re-punctuating
// "Uzziah, Jotham, Ahaz," → "(Uzziah); Jotham — Ahaz," diffs as replace
// "Uzziah, Jotham," → "(Uzziah); Jotham —" — the right edge stops after the
// comma that follows "Jotham" (the " Ahaz" tail is common suffix), so it lands
// inside the `", "` text node that separates "Jotham" and "Ahaz". A mid-text-node
// edge fails smartReplaceVerse's `endsAtBoundary` gate, so the words-unchanged
// relayoutPunctuation path never fires and the edit drops to localizedRewrite,
// which unaligns the untouched "Uzziah"/"Jotham" (HOS 1:1).
//
// Fix: when the diff's word SEQUENCE is unchanged (pure punctuation move), expand
// each off-boundary edge to the nearest whole-word boundary — left to the start
// of a word the edge bisects, right to the end of a bisected word OR, when the
// right edge sits in a gap, forward over the next word so the inter-word
// punctuation change is captured as one whole-word range. The expanded chars are
// the diff's common prefix/suffix (identical in both strings), so the matching
// newText window is the same span grown by the same amounts. The range now ends
// on a word boundary and the words stay 1:1, so relayoutPunctuation keeps every
// \w (and its milestone) put. A no-op for anything but a words-unchanged edit, or
// one already on word boundaries.
function snapPunctuationOnlyToWordBoundaries(
  oldText: string,
  newText: string,
  diff: { start: number; oldLen: number; newSubstring: string },
): { start: number; oldLen: number; newSubstring: string } {
  if (diff.oldLen === 0 || diff.newSubstring.length === 0) return diff;
  const start0 = diff.start;
  const end0 = diff.start + diff.oldLen;
  const matchText = oldText.slice(start0, end0);
  const matchWords = [...matchText.matchAll(WORD_RUN_RE)].map((m) => m[0]);
  const replaceWords = [...diff.newSubstring.matchAll(WORD_RUN_RE)].map((m) => m[0]);
  if (matchWords.length === 0) return diff;
  if (matchWords.length !== replaceWords.length) return diff;
  if (!matchWords.every((mw, i) => mw === replaceWords[i])) return diff; // not punct-only
  const runs = [...oldText.matchAll(WORD_RUN_RE)].map((m) => ({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length }));
  let start = start0;
  let end = end0;
  const leftIn = runs.find((r) => r.s < start0 && r.e > start0);
  if (leftIn) start = leftIn.s;
  const rightIn = runs.find((r) => r.s < end0 && r.e > end0);
  if (rightIn) end = rightIn.e;
  else { const next = runs.find((r) => r.s >= end0); if (next) end = next.e; }
  if (start === start0 && end === end0) return diff;
  // Grown chars are common prefix (left) / suffix (right): identical in newText.
  const rightGrow = end - end0;
  const newStart = start; // left growth is shared prefix → same offset in newText
  const newEnd = (start0 + diff.newSubstring.length) + rightGrow;
  return { start: newStart, oldLen: end - start, newSubstring: newText.slice(newStart, newEnd) };
}

// A stable signature of the inline-marker layout: each marker's tag, the
// number of words that precede it (whitespace-robust), AND the run of
// punctuation that immediately precedes it (the trailing punctuation of the
// previous word). Equal signatures mean the markers weren't touched, so the
// marker reconcile can be skipped; a different signature means a marker was
// added, removed, moved, OR had punctuation moved across it.
//
// The trailing-punctuation term is what catches "move the period to the end of
// the line" edits: a trailing `.`/`,`/`”` on the far side of a `\q` line break
// from its word (`among you \q1 .`) carries the SAME word count before the
// marker whether it sits before or after the marker, so without it the move is
// invisible (markerSignature unchanged → reconcile skipped → the edit no-ops,
// the MIC 5:12 "refuses to move the period" report). Whitespace is trimmed
// first so the term stays whitespace-robust like the word count.
function markerSignature(plain: string): string {
  const re = new RegExp(MARKER_TOKEN_RE.source, MARKER_TOKEN_RE.flags);
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    const before = stripMarkerTokens(plain.slice(0, m.index));
    const wordsBefore = [...before.matchAll(WORD_RUN_RE)].length;
    const trailPunct = before.replace(/\s+$/u, "").match(/[^\p{L}\p{M}\p{N}\s]+$/u)?.[0] ?? "";
    parts.push(`${m[1]}@${wordsBefore}:${trailPunct}`);
    if (m[0].length === 0) re.lastIndex++;
  }
  return parts.join(",");
}

// Re-lay the inert position markers (\p, \q1, \q2, \ts\*) of a verse to match
// the edited text. Markers ARE text tokens in editable space but have NO raw
// text in the verse tree, so diffing them is what destroys alignment: removing
// the trailing \q1 kills the diff's common suffix, ballooning the change
// across the whole verse so localizedRewriteVerse flattens every \zaln
// milestone. Handle them structurally instead: keep every non-marker node
// (words, text, milestones — and thus all alignment) verbatim, drop the
// existing inert markers, and re-insert the edited verse's markers at their
// new positions. Position is anchored by the number of words that precede each
// marker, which is robust to whitespace differences between editable and raw
// text. A marker whose anchor falls inside a multi-word milestone lands just
// after that milestone rather than splitting it — a cosmetic line-break
// placement at worst, never a loss of alignment or text.
//
// Runs both for pure marker edits and as the second step of a combined
// word+marker edit (after the word change has already been applied to the
// tree); either way the tree's word sequence matches `newPlain`, so the
// word-count anchors line up.
function reconcileMarkers(content: unknown, newPlain: string): SmartReplaceResult {
  const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(verseObjects)) {
    return {
      content: { verseObjects: tokenizeEditableText(newPlain) },
      plainText: normalize(newPlain),
      preservedAlignment: false,
    };
  }
  const cloned = cloneVerseObjects(verseObjects);
  // Every node that isn't an inert in-flow marker is kept exactly — this is
  // where the \w words and \zaln milestones live. (Markers only ever sit at
  // top level in aligned source: they wrap milestones, never nest inside one.)
  // Character wrappers (`\qs Selah\qs*`) are `type:"quote"` too, so
  // isInFlowMarker matches them — but they hold aligned content, not a line
  // break; keep them as content nodes or their wrapped word is dropped.
  const contentNodes = cloned.filter((n) => !isInFlowMarker(n) || isCharacterWrapper(n));

  const countWords = (s: string): number => [...s.matchAll(WORD_RUN_RE)].length;

  // The edited verse's marker layout, each anchored by how many words precede it.
  const markers: { node: unknown; wordsBefore: number }[] = [];
  const re = new RegExp(MARKER_TOKEN_RE.source, MARKER_TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(newPlain)) !== null) {
    const wordsBefore = countWords(stripMarkerTokens(newPlain.slice(0, m.index)));
    markers.push({ node: nodeForMarker(m[1]), wordsBefore });
    if (m[0].length === 0) re.lastIndex++;
  }

  // Walk the content nodes, inserting each marker at the position where the
  // running word count reaches its anchor. The subtlety is WHERE within the
  // punctuation around that boundary the marker lands: a `\q`/`\p` is a line
  // break, so CLOSING punctuation that trails the anchor word (`,`, `.`, `:`,
  // `”`) belongs to the previous line and must stay BEFORE the marker, while
  // OPENING punctuation that leads the next word (`“`, `‘`, `—the`) belongs to
  // the new line and must stay AFTER it. Flushing greedily before every node
  // wedged the marker ahead of trailing punctuation (the ZEC 6:12 ULT
  // corruption: `saying \q1 :`, `sprout \q1 ,`, `Yahweh \q1 .`); skipping ALL
  // 0-word nodes would instead push it past a leading em-dash (ZEC 13:7's
  // `companion” \q1 —the declaration`). So: skip the run of whitespace + closing
  // punctuation that follows the anchor word, then drop the marker at the first
  // opening-punctuation / word character. CLOSING is everything that hugs a
  // word's right edge; the dash is deliberately excluded — it leads as often as
  // it trails, and the cases that put one next to a marker have it leading.
  const CLOSING = /[\s,.;:!?)\]}”’…]/;
  const isBareText = (n: unknown): n is { type: "text"; text: string } => {
    const o = n as Record<string, unknown> | null;
    return !!o && o["type"] === "text" && typeof o["text"] === "string";
  };
  const out: unknown[] = [];
  let wordCount = 0;
  let mi = 0;
  const flushable = (): boolean =>
    mi < markers.length && markers[mi].wordsBefore <= wordCount;
  let ni = 0;
  while (ni < contentNodes.length) {
    const node = contentNodes[ni];
    const nodeWords = countWords(rawTextOfNode(node));
    if (nodeWords > 0 || !isBareText(node)) {
      // Word-bearing node (or a wordless milestone) — a marker anchored here
      // breaks the line right before it.
      while (flushable()) out.push(markers[mi++].node);
      out.push(node);
      wordCount += nodeWords;
      ni++;
      continue;
    }
    // A run of consecutive 0-word text nodes sits between two words. If no
    // marker anchors in this gap, pass the nodes through untouched. Otherwise
    // split the combined run at the trailing-punctuation / leading-content
    // boundary and drop the pending marker(s) there.
    let combined = "";
    let nj = ni;
    for (; nj < contentNodes.length; nj++) {
      const cn = contentNodes[nj];
      if (!isBareText(cn) || countWords(cn.text) !== 0) break;
      combined += cn.text;
    }
    if (!flushable()) {
      for (let k = ni; k < nj; k++) out.push(contentNodes[k]);
    } else {
      let split = 0;
      while (split < combined.length && CLOSING.test(combined[split])) split++;
      const before = combined.slice(0, split);
      const after = combined.slice(split);
      if (before) out.push({ type: "text", text: before });
      while (flushable()) out.push(markers[mi++].node);
      if (after) out.push({ type: "text", text: after });
    }
    ni = nj;
  }
  while (mi < markers.length) {
    out.push(markers[mi].node);
    mi++;
  }

  const newRaw = rebuildRaw(out);
  return {
    content: { verseObjects: out },
    plainText: normalize(newRaw),
    preservedAlignment: true,
  };
}

// Top-level entry point for "the user just typed in a contentEditable
// representation of this verse's plain text — please update the
// verseObjects without nuking alignment for unchanged parts."
//
// First we try the preserve path via smartReplaceVerse on the diff; if the
// word counts don't line up, we drop to localizedRewriteVerse.
export function smartEditVerse(
  content: unknown,
  oldPlain: string,
  newPlain: string,
): SmartReplaceResult {
  // The diff is character-exact (diffSingleChange), but `oldPlain` is the
  // whitespace-collapsed extractEditableText baseline while `newPlain` is
  // the raw textContent / innerText captured from the contenteditable. A
  // single divergent tail char (trailing space, innerText block-newline,
  // toolbar `&nbsp;`, `&#8203;` placeholder) collapses the common suffix to
  // zero, so the change range balloons to the verse end and the localized
  // rewrite drops every \zaln-s after the edit. Normalize both sides
  // identically so the diff sees only the genuine edit. `oldPlain` already
  // arrives normalized, so this is a no-op on it.
  oldPlain = normalizeEditable(oldPlain);
  newPlain = normalizeEditable(newPlain);
  if (oldPlain === newPlain) {
    return { content, plainText: oldPlain, preservedAlignment: true };
  }

  // usfm-js parks the leading punctuation after a marker (`\q2 “…`) on the
  // marker node's `text`. extractEditableText surfaces it into oldPlain, so the
  // tree must agree or the diff offsets skew (the typed quote "pops" to the
  // wrong side) and reconcileMarkers — which rebuilds markers from the tag
  // alone — would drop it. Split it into a plain text node up front so every
  // tier below sees the same shape the baseline does. No-op once a verse has
  // been saved through here.
  {
    const vo = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (Array.isArray(vo)) content = { verseObjects: liftMarkerText(vo) };
  }

  // Inline markers (\p, \q1, \q2, \ts\*) are surfaced as text tokens in the
  // editable string but are inert position anchors with NO raw text in the
  // verse tree. Diffing them in editable space is what destroys alignment:
  // removing the trailing \q1 kills the diff's common suffix, ballooning the
  // change across the whole verse so localizedRewriteVerse flattens every
  // \zaln milestone. So split the edit into two independent steps:
  //   1. the word/punctuation change, diffed against the MARKER-STRIPPED text
  //      so markers can't move the anchors, applied by the tiers below;
  //   2. a marker-layout reconcile, run only when the markers actually moved.
  // The tree's raw text already excludes markers, so the stripped plain text
  // and the tree's raw coordinates line up, and markers pass through the word
  // tiers untouched (they're zero-width position anchors).
  const oldStripped = normalizeEditable(stripMarkerTokens(oldPlain));
  const newStripped = normalizeEditable(stripMarkerTokens(newPlain));
  const markersChanged = markerSignature(oldPlain) !== markerSignature(newPlain);

  // Step 1 — word/punctuation edit against the marker-stripped baseline.
  let result: SmartReplaceResult;
  // Pure punctuation / whitespace relayout: when the edit leaves the WHOLE word
  // sequence unchanged, re-lay punctuation over the entire verse with every \w
  // (and \zaln) intact, before the diff tiers run. Catches edits the single-
  // change diff can't localize — opening + closing quotes added at the verse
  // edges collapse into one verse-spanning range that fails the boundary gate
  // and would otherwise flatten every milestone (ZEC 7:14 `‘…’`). Returns null
  // (→ diff tiers) unless every word maps 1:1.
  const contentVo = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  const relaid =
    oldStripped !== newStripped && Array.isArray(contentVo)
      ? relayoutUnchangedWords(contentVo, newStripped)
      : null;
  if (oldStripped === newStripped) {
    // Pure marker edit — no word/punctuation change to apply.
    result = { content, plainText: oldStripped, preservedAlignment: true };
  } else if (relaid) {
    result = relaid;
  } else {
    const rawDiff = diffSingleChange(oldStripped, newStripped);
    if (rawDiff.oldLen === 0 && rawDiff.newSubstring === "") {
      result = { content, plainText: oldStripped, preservedAlignment: true };
    } else {
      // A word-extending insertion ("Th" typed before "is") diffs as a pure
      // insert; snap it to the adjacent word so it routes through the in-place
      // word-replace path instead of emitting a standalone \w. (ZEC 5:3.)
      // First canonicalize the insertion off any aliased mid-word position so
      // snap only fires for a TRUE word-extension — otherwise inserting a word
      // in front of an aligned neighbour ("truly " before "the") unaligns the
      // untouched neighbour.
      // Symmetrically, a word DELETION can diff mid-neighbour when the deleted
      // word shares a boundary letter with a neighbour (delete "again" from
      // "conceived again and" → delete "gain a", splitting "and"). Slide it to a
      // word-clean range first. Each canonicalizer is a no-op for the other's
      // shape (insertion vs deletion), so chaining is safe.
      // A REPLACEMENT can alias MID-WORD when two boundary-sharing words are
      // swapped/reordered (swap 'their'/'the', affix 'net'/'dragnet'); left
      // mid-word it drops to localizedRewriteVerse and transplants a fragment of
      // one word onto another's milestone. Snap such a multi-word replacement out
      // to whole-word edges so whole milestones drop (reordered words go bare)
      // instead. Single-word replacements (Case 5) and the insertion/deletion
      // shapes are no-ops here, so chaining with the other canonicalizers is safe.
      // A pure PUNCTUATION move between unchanged words can diff with an edge
      // mid-gap (HOS 1:1 "Uzziah, Jotham," → "(Uzziah); Jotham —"); grow it to
      // whole-word boundaries so the words-unchanged relayout path can fire
      // instead of localizedRewrite unaligning the untouched words. No-op for
      // any edit that changes a word, or already on word boundaries — so it
      // chains safely after the other canonicalizers.
      const canon = snapPunctuationOnlyToWordBoundaries(
        oldStripped,
        newStripped,
        snapReplacementToWordBoundaries(
          oldStripped,
          newStripped,
          canonicalizePureDeletion(
            oldStripped,
            canonicalizePureInsertion(oldStripped, newStripped, rawDiff),
          ),
        ),
      );
      const diff = snapDiffToWordBoundaries(oldStripped, newStripped, canon);
      // Word-count-match preserve path lives in smartReplaceVerse.
      if (diff.oldLen > 0) {
        const matchText = oldStripped.slice(diff.start, diff.start + diff.oldLen);
        const escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(escaped, "g");
        result = smartReplaceVerse(
          content,
          oldStripped,
          re,
          diff.start,
          diff.oldLen,
          diff.newSubstring,
        );
      } else {
        // Pure insertion — no matchText, can't do word-count preserve.
        result = localizedRewriteVerse(
          content,
          oldStripped,
          diff.start,
          0,
          diff.newSubstring,
        );
      }
    }
  }

  // Step 2 — re-place inline markers on the (possibly word-edited) tree when
  // their layout changed. The word tiers leave markers where they were, so
  // skip this when the markers weren't touched. Keep the word edit's
  // alignment verdict.
  if (markersChanged) {
    // Prune dead milestones BEFORE reconcile. If the word edit emptied a
    // milestone of its `\w` (e.g. deleting the clause-final word whose milestone
    // also held the trailing punctuation), the leftover punctuation must be a
    // BARE text node so reconcileMarkers' closing-punctuation rule keeps it on
    // the previous line. Left as a wordless milestone, reconcile treats it as a
    // content node and wedges the marker BEFORE it — pushing e.g. a clause-final
    // `;` onto the far side of the `\q` line break (the ZEC 6:12 corruption class).
    const rc = (result.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    const preReconcile = Array.isArray(rc) ? { verseObjects: pruneDeadMilestones(rc) } : result.content;
    const reconciled = reconcileMarkers(preReconcile, newPlain);
    result = {
      content: reconciled.content,
      plainText: reconciled.plainText,
      preservedAlignment: result.preservedAlignment,
    };
  }
  // Final defense-in-depth: strip any leading/trailing non-letter chars
  // off every `\w` text into adjacent text nodes. Mirrors the server-side
  // normalize on import. Catches legacy rows whose `\w "What\w*`-style
  // punctuation persisted through this edit (it wouldn't be cleaned by
  // the preserve / single-leaf paths since they only touch the changed
  // leaf), so the user's next save heals them.
  const verseObjects = (result.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (Array.isArray(verseObjects)) {
    // Drop any `\zaln` milestone that an edit emptied of `\w` words. Lifting an
    // edited/moved/deleted word out of a single-word milestone (the preserve,
    // single-leaf, relayout AND localizedRewrite paths all do this) can leave a
    // milestone wrapping only trailing punctuation/whitespace; usfm-js then
    // serializes a dangling `\zaln-s …\*,\zaln-e\*` around bare text — corrupt
    // alignment on disk. smartRebuildRange prunes its own output, but the other
    // tiers don't, so prune globally here. Then clear any empty text it exposes.
    const normalized = pruneEmptyText(pruneDeadMilestones(normalizeWordPunctuation(verseObjects)));
    return { ...result, content: { verseObjects: normalized } };
  }
  return result;
}

// Full raw text length of a verseObjects node, recursing into milestone
// children. Top-level node positions in raw text are the running sum of
// this across the verseObjects array.
function rawTextOfNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  let txt = "";
  if (typeof o["text"] === "string") txt += o["text"];
  const children = o["children"];
  if (Array.isArray(children)) {
    for (const c of children) txt += rawTextOfNode(c);
  }
  return txt;
}

// Walk a milestone's children once and partition them by their raw-text
// position relative to the change range. Children entirely before the
// range go into `before`, entirely after into `after`. An overlapping
// child that is itself a milestone / wrapper (nested \zaln-s compound
// alignment) recurses, splitting into before/after halves like the outer
// walk so its descendants outside the range keep their alignment. An
// overlapping leaf is SPLIT at the change boundary: the text before the
// change stays in `before`, the text after stays in `after`, each still
// inside this milestone so it keeps its source alignment (the replaced
// middle is dropped — the outer walk re-emits the new text there).
function partitionMilestoneChildren(
  milestoneNode: Record<string, unknown>,
  milestoneStart: number,
  rawStart: number,
  rawEnd: number,
): { before: unknown[]; after: unknown[] } {
  const before: unknown[] = [];
  const after: unknown[] = [];
  const children = (milestoneNode["children"] as unknown[] | undefined) ?? [];
  let pos = milestoneStart;
  for (const child of children) {
    const len = rawTextOfNode(child).length;
    const childStart = pos;
    const childEnd = pos + len;
    pos = childEnd;
    if (childEnd <= rawStart) {
      before.push(child);
    } else if (childStart >= rawEnd) {
      after.push(child);
    } else {
      const c = child as Record<string, unknown> | null;
      if (!c) continue;
      if (Array.isArray(c["children"]) && (c["children"] as unknown[]).length > 0) {
        const inner = partitionMilestoneChildren(c, childStart, rawStart, rawEnd);
        if (inner.before.length > 0) before.push({ ...c, children: inner.before });
        if (inner.after.length > 0) after.push({ ...c, children: inner.after });
      } else {
        // Overlapping leaf — split it instead of dropping the whole thing.
        // Keeping the unchanged fragments inside this milestone is what stops
        // a mid-word edit (a space / bracket typed inside an aligned word)
        // from flattening the WHOLE verse: only the touched word's milestone
        // is split; every other milestone survives. A \w fragment is re-
        // tokenized so it stays a word; a text fragment stays text. A leaf
        // wholly inside the range yields two empty fragments and is dropped.
        const text = String(c["text"] ?? "");
        const beforeText = text.slice(0, Math.max(0, rawStart - childStart));
        const afterText = text.slice(Math.max(0, rawEnd - childStart));
        const frag = (s: string): unknown[] =>
          c["type"] === "word" && c["tag"] === "w"
            ? tokenizePlainText(s)
            : [{ type: "text", text: s }];
        if (beforeText) for (const n of frag(beforeText)) before.push(n);
        if (afterText) for (const n of frag(afterText)) after.push(n);
      }
    }
  }
  return { before, after };
}

// Map a character position in the whitespace-NORMALIZED, marker-stripped plain
// text to the matching position in the verse's UN-normalized raw concatenation.
// The two diverge in whitespace WIDTH — raw keeps `\n` (line-broken `\w`),
// double spaces, and any leading whitespace that `normalizeEditable` trimmed off
// the plain side — so a pure-insertion offset taken as a raw char-length lands
// short by exactly the accumulated whitespace delta. Left uncorrected, the
// insertion splits the neighbouring word: inserting a bare word before a `\q`
// marker whose preceding `\w` shares the prefix's trailing letter migrates that
// letter onto the new word (HAB 1:12 "times"→"time"+"s", HAB 3:1
// "shigyonoth"→"shigyono"+"th"). Walk both strings in lockstep, matching
// non-whitespace chars by identity and collapsing each whitespace run on either
// side, so positions stay anchored to real content regardless of whitespace
// width. Returns -1 if the non-whitespace streams ever disagree (caller falls
// back to the prefix-length proxy).
function mapStrippedPosToRaw(plain: string, raw: string, pos: number): number {
  const isWS = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
  let pi = 0;
  let ri = 0;
  while (pi < pos) {
    if (isWS(plain[pi])) {
      while (pi < pos && isWS(plain[pi])) pi++;
      while (ri < raw.length && isWS(raw[ri])) ri++;
    } else {
      while (ri < raw.length && isWS(raw[ri])) ri++;
      if (raw[ri] !== plain[pi]) return -1;
      pi++;
      ri++;
    }
  }
  return ri;
}

// Localized rewrite: walk top-level nodes once, keep those entirely
// outside the change range untouched, split any text node that straddles
// a boundary, and split any milestone that straddles a boundary into a
// before-half + after-half (each wrapping just the children outside the
// range). Insert tokenizeEditableText(newSubstring) at the position of
// the change (so any inline \p / \q1 marker text becomes a paragraph
// node). Milestones that survive keep their source-alignment attributes,
// so any unchanged children continue to align to the same Hebrew word.
function localizedRewriteVerse(
  content: unknown,
  oldPlain: string,
  start: number,
  oldLen: number,
  newSubstring: string,
): SmartReplaceResult {
  const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(verseObjects)) {
    const newPlain = oldPlain.slice(0, start) + newSubstring + oldPlain.slice(start + oldLen);
    return {
      content: { verseObjects: tokenizeEditableText(newPlain) },
      plainText: normalize(newPlain),
      preservedAlignment: false,
    };
  }

  const cloned = cloneVerseObjects(verseObjects);
  const rawTotal = rebuildRaw(cloned);

  // Map plain-text positions to raw-text positions. For oldLen > 0 we find
  // the Nth occurrence of the matchText in raw, treating each literal space
  // in the pattern as `\s+` so we match across leaf-boundary newlines (e.g.
  // raw `"where\n{are} they"` for plain `"where {are} they"`). For pure
  // insertions (oldLen === 0) we'd use the plain position as a rough
  // proxy, but when oldPlain contains inline marker tokens (e.g. "\p ")
  // those chars don't appear in rawTotal — so strip markers from the
  // prefix and use that length instead.
  let rawStart = -1;
  let rawLen = oldLen;
  if (oldLen > 0) {
    const matchText = oldPlain.slice(start, start + oldLen);
    let occurrence = 1;
    let scan = oldPlain.indexOf(matchText);
    while (scan >= 0 && scan < start) {
      occurrence++;
      scan = oldPlain.indexOf(matchText, scan + 1);
    }
    const escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rawRegex = new RegExp(escaped.replace(/ /g, "\\s+"), "g");
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = rawRegex.exec(rawTotal)) !== null) {
      count++;
      if (count === occurrence) {
        rawStart = m.index;
        rawLen = m[0].length;
        break;
      }
      if (m[0].length === 0) rawRegex.lastIndex++;
    }
  } else {
    const prefixNoMarkers = stripMarkerTokens(oldPlain.slice(0, start));
    // Anchor by matching content, not raw char-length: raw whitespace width
    // (leading `\n`, line-broken `\w`, double spaces) diverges from the
    // normalized plain prefix, and a raw-length proxy lands short by that
    // delta — splitting the neighbouring word when the insertion abuts it
    // (the letter-migration corruption). Fall back to the length proxy only
    // if the content streams disagree (shouldn't happen for a clean edit).
    const mapped = mapStrippedPosToRaw(prefixNoMarkers, rawTotal, prefixNoMarkers.length);
    rawStart = mapped >= 0 ? mapped : Math.min(prefixNoMarkers.length, rawTotal.length);
  }
  if (rawStart < 0) {
    // Couldn't map — bail to flat tokenization so we at least emit \w
    // tokens for the aligner to work with and any embedded markers stay
    // as paragraph nodes.
    const newPlain = oldPlain.slice(0, start) + newSubstring + oldPlain.slice(start + oldLen);
    return {
      content: { verseObjects: tokenizeEditableText(newPlain) },
      plainText: normalize(newPlain),
      preservedAlignment: false,
    };
  }
  const rawEnd = rawStart + rawLen;

  // A nested leaf (a \w / text inside a milestone) that the change only
  // partially overlaps is no longer a problem: partitionMilestoneChildren
  // splits it at the boundary, so its unchanged text survives AND the
  // surrounding milestones keep their alignment. (This used to bail to a
  // whole-verse flat tokenize — "keep text, lose all alignment" — which is
  // exactly what made a mid-word space / bracket unalign the entire verse.)

  const out: unknown[] = [];
  let emittedChange = false;
  const emitChange = () => {
    if (emittedChange) return;
    emittedChange = true;
    if (newSubstring.length > 0) {
      for (const t of tokenizeEditableText(newSubstring)) out.push(t);
    }
  };

  let pos = 0;
  for (const node of cloned) {
    const len = rawTextOfNode(node).length;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    pos = nodeEnd;

    if (nodeEnd <= rawStart) {
      out.push(node);
      continue;
    }
    if (nodeStart >= rawEnd) {
      emitChange();
      out.push(node);
      continue;
    }

    const o = node as Record<string, unknown>;
    if (o["type"] === "text" && typeof o["text"] === "string") {
      const fullText = String(o["text"]);
      const before = fullText.slice(0, Math.max(0, rawStart - nodeStart));
      const after = fullText.slice(Math.max(0, rawEnd - nodeStart));
      if (before) out.push({ type: "text", text: before });
      emitChange();
      if (after) out.push({ type: "text", text: after });
    } else if (Array.isArray(o["children"]) && (o["children"] as unknown[]).length > 0) {
      // Milestone (\zaln) or content wrapper (\qs around \zaln, etc.).
      // Partition children by their raw-text position relative to the
      // change range; children that fall entirely outside survive,
      // overlapping children are dropped (their text gets re-emitted by
      // tokenizePlainText). Wrapper attributes are preserved on each
      // surviving half.
      const { before, after } = partitionMilestoneChildren(o, nodeStart, rawStart, rawEnd);
      if (before.length > 0) {
        out.push({ ...o, children: before });
      }
      emitChange();
      if (after.length > 0) {
        out.push({ ...o, children: after });
      }
    } else if (o["type"] === "word" && o["tag"] === "w") {
      // Bare \w at top level overlapping the change. Keep the word's text
      // OUTSIDE the change range — dropping the whole leaf would delete
      // characters the user didn't touch (inserting "'" into "cant" must not
      // lose "can"/"t"; inserting a space into "ab" must keep "a"/"b"). Re-
      // tokenize each surviving fragment around the emitted change.
      const wtext = String(o["text"] ?? "");
      const beforeFrag = wtext.slice(0, Math.max(0, rawStart - nodeStart));
      const afterFrag = wtext.slice(Math.max(0, rawEnd - nodeStart));
      for (const tok of tokenizePlainText(beforeFrag)) out.push(tok);
      emitChange();
      for (const tok of tokenizePlainText(afterFrag)) out.push(tok);
    } else if (typeof o["text"] === "string" && (o["text"] as string).length > 0) {
      // Single-text marker (`\q1 hello`, bare `\qs Selah\qs*` without
      // alignment children). If the change fully covers the marker's
      // text, drop the marker — the user is editing through it.
      // Otherwise preserve verbatim; splitting the marker's text into
      // two adjacent copies (`\qs Se\qs*` + `\qs lah\qs*`) would corrupt
      // the structure.
      if (rawStart <= nodeStart && rawEnd >= nodeEnd) {
        emitChange();
      } else {
        out.push(node);
        emitChange();
      }
    } else {
      // Structural marker with no raw text and no children (\b, \f
      // with `content` only, \ts*, empty \q1, \p). Position-anchor
      // only — preserve verbatim regardless of overlap. A long edit
      // that brackets a footnote should leave the footnote in place,
      // not silently delete it.
      out.push(node);
      emitChange();
    }
  }
  emitChange();

  const newRaw = rebuildRaw(out);
  return {
    content: { verseObjects: out },
    plainText: normalize(newRaw),
    preservedAlignment: false,
  };
}

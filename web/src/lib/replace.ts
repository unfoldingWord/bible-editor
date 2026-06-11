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

import { normalizeEditable, isInFlowMarker, liftMarkerText } from "./usfm.ts";

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
// literal "\p" / "\q1" / "\ts\*" tokens in the active-verse
// contenteditable. The regex matches the marker name followed by a word
// boundary so "\q1Hello" won't accidentally bite (markers always end
// with whitespace from the chip renderer's trailing space). The optional
// trailing \s is consumed so the marker token doesn't leave a stranded
// space between marker and following text. `ts\\\*` matches the literal
// `\ts\*` chunk milestone (translator's section delimiter).
const MARKER_TOKEN_RE = /\\(p|m|mi|nb|pi[1-3]?|pc|q[1-4]?|qm[1-3]?|b|ts\\\*)(?=\s|$|[^a-z0-9])\s?/g;

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

// A stable signature of the inline-marker layout: each marker's tag and the
// number of words that precede it (whitespace-robust). Equal signatures mean
// the markers weren't touched, so the marker reconcile can be skipped; a
// different signature means a marker was added, removed, or moved.
function markerSignature(plain: string): string {
  const re = new RegExp(MARKER_TOKEN_RE.source, MARKER_TOKEN_RE.flags);
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    const wordsBefore = [...stripMarkerTokens(plain.slice(0, m.index)).matchAll(WORD_RUN_RE)].length;
    parts.push(`${m[1]}@${wordsBefore}`);
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
  const contentNodes = cloned.filter((n) => !isInFlowMarker(n));

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
  if (oldStripped === newStripped) {
    // Pure marker edit — no word/punctuation change to apply.
    result = { content, plainText: oldStripped, preservedAlignment: true };
  } else {
    const rawDiff = diffSingleChange(oldStripped, newStripped);
    if (rawDiff.oldLen === 0 && rawDiff.newSubstring === "") {
      result = { content, plainText: oldStripped, preservedAlignment: true };
    } else {
      // A word-extending insertion ("Th" typed before "is") diffs as a pure
      // insert; snap it to the adjacent word so it routes through the in-place
      // word-replace path instead of emitting a standalone \w. (ZEC 5:3.)
      const diff = snapDiffToWordBoundaries(oldStripped, newStripped, rawDiff);
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
    const reconciled = reconcileMarkers(result.content, newPlain);
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
    const normalized = normalizeWordPunctuation(verseObjects);
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
// overlapping leaf is dropped (its content is replaced by the tokenized
// newSubstring in the outer walk) — the splitsNestedLeaf guard upstream
// guarantees it lies wholly inside the change range.
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
      if (c && Array.isArray(c["children"]) && (c["children"] as unknown[]).length > 0) {
        const inner = partitionMilestoneChildren(c, childStart, rawStart, rawEnd);
        if (inner.before.length > 0) before.push({ ...c, children: inner.before });
        if (inner.after.length > 0) after.push({ ...c, children: inner.after });
      }
      // Overlapping leaves are dropped — the change region replaces them.
    }
  }
  return { before, after };
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
    rawStart = Math.min(prefixNoMarkers.length, rawTotal.length);
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

  // Text-correctness guard. The partition walk recurses into overlapping
  // milestone children, but any LEAF whose extent overlaps the change is
  // dropped wholly, replaced by the tokenized newSubstring. If a NESTED
  // leaf (depth > 0, i.e. inside a milestone) is only PARTIALLY overlapped,
  // the unchanged half of that leaf's text would disappear from the saved
  // verse. Top-level text leaves are fine — the per-node walk splits them
  // at the boundary.
  // Losing alignment is bad; losing user text they just typed is worse.
  const { leaves } = walkLeaves(cloned);
  const splitsNestedLeaf = leaves.some((l) => {
    if (l.depth === 0) return false;
    const startsInside = l.start < rawStart && l.end > rawStart;
    const endsInside = l.start < rawEnd && l.end > rawEnd;
    return startsInside || endsInside;
  });
  if (splitsNestedLeaf) {
    const newPlain = oldPlain.slice(0, start) + newSubstring + oldPlain.slice(start + oldLen);
    return {
      content: { verseObjects: tokenizeEditableText(newPlain) },
      plainText: normalize(newPlain),
      preservedAlignment: false,
    };
  }

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

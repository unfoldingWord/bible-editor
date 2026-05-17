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

export interface SmartReplaceResult {
  content: unknown;
  plainText: string;
  preservedAlignment: boolean;
}

interface Leaf {
  node: Record<string, unknown>;
  start: number;
  end: number;
}

function walkLeaves(verseObjects: unknown[]): { raw: string; leaves: Leaf[] } {
  const leaves: Leaf[] = [];
  let pos = 0;
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      const text = o["text"];
      if (typeof text === "string") {
        leaves.push({ node: o, start: pos, end: pos + text.length });
        pos += text.length;
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(verseObjects);
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

// A word run — Unicode letters/marks (plus ZWJ / word-joiner for
// scripts that need them) with intra-word `-` / `'` / `’` allowed
// between letter runs (so "don't", "don’t", "hello-world" stay one
// `\w` token but flanking quotes / dashes ride as text). Mirrors
// `string-punctuation-tokenizer`'s greedy pattern, the package
// translationCore / gatewayEdit use for the same job.
const WORD_RUN_RE = /[\p{L}\p{M}‍⁠]+(?:[-'’][\p{L}\p{M}‍⁠]+)*/gu;

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
      content: { verseObjects: tokenizePlainText(newPlain) },
      plainText: newPlain,
      preservedAlignment: false,
    };
  }

  // Determine which occurrence (1-based) the active match is, then find
  // the corresponding occurrence in the raw verseObjects concatenation.
  const occurrenceNum = countMatchesBefore(plainText, regex, matchStartInPlain) + 1;
  const cloned = cloneVerseObjects(verseObjects);
  const { raw, leaves } = walkLeaves(cloned);
  const rawMatch = nthMatchIn(raw, regex, occurrenceNum);

  // If the raw search yields nothing (normalization wiped a match), fall
  // back to the flat tokenized path so we at least produce \w nodes.
  if (!rawMatch) {
    const before = plainText.slice(0, matchStartInPlain);
    const after = plainText.slice(matchStartInPlain + matchLenInPlain);
    const newPlain = normalize(before + replaceText + after);
    return {
      content: { verseObjects: tokenizePlainText(newPlain) },
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
  //       either side, so the 1:1 mapping is unambiguous.
  const affected = leaves.filter((l) => l.start < rawEnd && l.end > rawStart);
  const startsAtBoundary = affected.length > 0 && affected[0].start === rawStart;
  const endsAtBoundary = affected.length > 0 && affected[affected.length - 1].end === rawEnd;
  const matchWords = rawMatchText.split(/\s+/).filter(Boolean);
  const replaceWords = replaceText.split(/\s+/).filter(Boolean);
  const wordLeaves = affected.filter((l) => isWordLeaf(l.node));
  const canPreserve =
    startsAtBoundary &&
    endsAtBoundary &&
    matchWords.length === replaceWords.length &&
    wordLeaves.length === matchWords.length;

  if (canPreserve) {
    // 1:1 word mapping. Whitespace text leaves between words stay as-is.
    for (let i = 0; i < wordLeaves.length; i++) {
      wordLeaves[i].node["text"] = replaceWords[i];
    }
    const newRaw = rebuildRaw(cloned);
    return {
      content: { verseObjects: cloned },
      plainText: normalize(newRaw),
      preservedAlignment: true,
    };
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
  if (oldPlain === newPlain) {
    return { content, plainText: oldPlain, preservedAlignment: true };
  }
  const diff = diffSingleChange(oldPlain, newPlain);
  if (diff.oldLen === 0 && diff.newSubstring === "") {
    return { content, plainText: oldPlain, preservedAlignment: true };
  }
  // Word-count-match preserve path lives in smartReplaceVerse.
  if (diff.oldLen > 0) {
    const matchText = oldPlain.slice(diff.start, diff.start + diff.oldLen);
    const escaped = matchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    return smartReplaceVerse(
      content,
      oldPlain,
      re,
      diff.start,
      diff.oldLen,
      diff.newSubstring,
    );
  }
  // Pure insertion — no matchText, can't do word-count preserve.
  return localizedRewriteVerse(
    content,
    oldPlain,
    diff.start,
    0,
    diff.newSubstring,
  );
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
// range go into `before`, entirely after into `after`, anything that
// overlaps is dropped (its content is replaced by tokenizePlainText in the
// outer walk). Recurses into nested milestones at the top level only — a
// fully-contained nested milestone is treated as a single child.
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
    }
    // Overlapping children are dropped — the change region replaces them.
  }
  return { before, after };
}

// Localized rewrite: walk top-level nodes once, keep those entirely
// outside the change range untouched, split any text node that straddles
// a boundary, and split any milestone that straddles a boundary into a
// before-half + after-half (each wrapping just the children outside the
// range). Insert tokenizePlainText(newSubstring) at the position of the
// change. Milestones that survive keep their source-alignment attributes,
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
      content: { verseObjects: tokenizePlainText(newPlain) },
      plainText: normalize(newPlain),
      preservedAlignment: false,
    };
  }

  const cloned = cloneVerseObjects(verseObjects);
  const rawTotal = rebuildRaw(cloned);

  // Map plain-text positions to raw-text positions by counting occurrences
  // of the literal matchText. For pure insertions (oldLen === 0) we use
  // plain position as a rough proxy — works as long as whitespace
  // normalization didn't shift much, which is true for typical edits.
  let rawStart = -1;
  if (oldLen > 0) {
    const matchText = oldPlain.slice(start, start + oldLen);
    let occurrence = 1;
    let scan = oldPlain.indexOf(matchText);
    while (scan >= 0 && scan < start) {
      occurrence++;
      scan = oldPlain.indexOf(matchText, scan + 1);
    }
    let rawScan = rawTotal.indexOf(matchText);
    let count = 0;
    while (rawScan >= 0) {
      count++;
      if (count === occurrence) {
        rawStart = rawScan;
        break;
      }
      rawScan = rawTotal.indexOf(matchText, rawScan + 1);
    }
  } else {
    rawStart = Math.min(start, rawTotal.length);
  }
  if (rawStart < 0) {
    // Couldn't map — bail to flat tokenization so we at least emit \w
    // tokens for the aligner to work with.
    const newPlain = oldPlain.slice(0, start) + newSubstring + oldPlain.slice(start + oldLen);
    return {
      content: { verseObjects: tokenizePlainText(newPlain) },
      plainText: normalize(newPlain),
      preservedAlignment: false,
    };
  }
  const rawEnd = rawStart + oldLen;

  const out: unknown[] = [];
  let emittedChange = false;
  const emitChange = () => {
    if (emittedChange) return;
    emittedChange = true;
    if (newSubstring.length > 0) {
      for (const t of tokenizePlainText(newSubstring)) out.push(t);
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
      // Bare \w at top level overlapping the change — re-tokenized
      // inside the change region.
      emitChange();
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

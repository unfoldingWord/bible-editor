// Parse and serialize word alignments to/from the usfm-js verse-objects
// JSON tree.
//
// Internal model: target English (or other GL) text is a flat document-order
// stream of words, text segments, and opaque/wrapper marker brackets. Each
// word optionally carries an `alignedTo` tag pointing at a source group;
// the source groups themselves live in a separate list keyed by uid. This
// decouples target-text order from alignment metadata so an alignment edit
// never reorders the verse's natural reading order.
//
// The stream is the single source of truth for "where everything in the
// verse sits", including non-zaln inline markup. There is no prefix /
// passthroughTail: every node — paragraph markers, footnotes, Selah's
// `\qs` wrapper, etc. — has a defined position in the stream and survives
// a round-trip in place. See docs/usfm-alignment-audit.md §4.
//
// On parse, two `\zaln-s` pairs that wrap the same Hebrew/Greek source
// (e.g. Zec 3:4 "Take ... off" around "those filthy clothes") merge into
// one group. On serialize, a group whose tagged target words are
// non-contiguous in the stream splits back into multiple `\zaln-s` pairs
// — one per contiguous run — so the emitted USFM stays valid (milestones
// always wrap contiguous text).
//
// Public API exposes `state.groups` (with derived `targets[]` per group,
// in stream order) and `state.unaligned` (flat list of words with no
// alignment), unchanged for callers / UI.

import { nfc } from "./hebrew.ts";
import { extractPlainText } from "./usfm.ts";

export interface SourceWord {
  id: string;
  strong: string;
  // `undefined` means the original USFM had no `x-lemma`/`x-morph`/
  // `x-content` attribute; the empty string means the attribute was
  // present with an empty value (legitimate for clitic prepositions,
  // e.g. OBA's `\zaln-s |x-strong="l" x-lemma=""...`). Preserving the
  // distinction is required for byte-clean DCS round-trips.
  lemma?: string;
  morph?: string;
  occurrence: string;
  occurrences: string;
  content?: string;
}

export interface TargetWord {
  id: string;
  text: string;
  occurrence: string;
  occurrences: string;
}

export interface AlignmentGroup {
  id: string;
  source: SourceWord[];   // 1+ source words; 2+ = compound (nested milestones)
  targets: TargetWord[];  // derived view — stream words with alignedTo === this.id, in stream order
}

interface StreamWord {
  kind: "word";
  word: TargetWord;
  alignedTo: string | null; // group id, or null when unaligned
}
interface StreamText {
  kind: "text";
  text: string;
}
// A self-contained inline node with no alignment-bearing content:
// footnotes (\f), blank lines (\b), chunk milestones (\ts*), section
// headings (\ms), bare `\qs Selah\qs*` without an inner \zaln-s,
// paragraph markers (\p, \q1, \q2, \m). Preserved verbatim on serialize.
interface StreamMarker {
  kind: "marker";
  node: ParsedNode;
}
// Brackets around a wrapper whose children include alignment-bearing
// content — the production-ULT Selah shape, `\qs \zaln-s ...\w Selah\w*\zaln-e\* \qs*`.
// The walker descends through, the inner words / zalns become stream
// words and source groups, and the open/close brackets remember the
// wrapper so serialize can rebuild it.
interface StreamOpenMarker {
  kind: "openMarker";
  tag: string;
  node: ParsedNode;
}
interface StreamCloseMarker {
  kind: "closeMarker";
  tag: string;
}
type StreamItem =
  | StreamWord
  | StreamText
  | StreamMarker
  | StreamOpenMarker
  | StreamCloseMarker;

export interface AlignmentState {
  // Internal document-order stream of target text, words, and inline
  // markup brackets. The single source of truth for "where everything
  // in the verse sits" — both aligned content and passthrough markup.
  stream: StreamItem[];
  // Source-word groups, keyed by id, independent of stream order. UHB
  // display order is computed separately in the dialog.
  sourceGroups: AlignmentGroup[];
  // Derived views, refreshed on every mutation for UI compat.
  groups: AlignmentGroup[];
  unaligned: TargetWord[];
}

type ParsedNode = Record<string, unknown>;

// Whitelist (NOT "has text children" — that would walk \f footnote
// prose into the alignment stream and into plain_text). \qs is the
// only USFM 3 character-style wrapper unfoldingWord ULT/UST emits
// today (audit §3.1). Add new tags here as they appear in real
// corpora; misclassifying an unknown wrapper as opaque is visible
// (text doesn't appear for alignment), while the reverse is silent
// data loss into plain_text.
const ALIGNMENT_WRAPPER_TAGS = new Set<string>(["qs"]);

function nodeIsZaln(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "milestone" && n["tag"] === "zaln";
}
function nodeIsWord(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "word" && n["tag"] === "w";
}
function nodeIsText(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "text" && typeof n["text"] === "string";
}
function isAlignmentWrapper(n: ParsedNode | undefined): boolean {
  if (!n || typeof n !== "object") return false;
  if (n["type"] !== "quote") return false;
  const tag = n["tag"];
  if (typeof tag !== "string") return false;
  if (!ALIGNMENT_WRAPPER_TAGS.has(tag)) return false;
  const children = n["children"];
  return Array.isArray(children) && children.length > 0;
}
// \d (Psalm superscription) is `type:"section"` — not `type:"quote"`, so
// isAlignmentWrapper can't cover it — but its content IS alignable verse
// body (see highlight.ts's renderer special case). When it arrives with
// children, descend like a \qs wrapper so the inner zaln / word nodes
// enter the alignment stream; a childless \d (bare marker or text-only)
// stays opaque and rides along verbatim.
function isPsalmTitleWrapper(n: ParsedNode | undefined): boolean {
  if (!n || typeof n !== "object") return false;
  if (n["type"] !== "section" || n["tag"] !== "d") return false;
  const children = n["children"];
  return Array.isArray(children) && children.length > 0;
}

// Shallow-clone a node's own properties, dropping `children` (the
// serializer rebuilds those). Used for wrapper open-markers, whose
// inner content is rebuilt from the stream. Prevents the serializer
// from mutating verseObjects that React props still reference.
function cloneNodeShallow(n: ParsedNode): ParsedNode {
  const out: ParsedNode = {};
  for (const key of Object.keys(n)) {
    if (key === "children") continue;
    out[key] = n[key];
  }
  return out;
}

// Deep-clone a node verbatim — children included. Used for opaque
// markers (footnotes, paragraph markers, etc.) whose stored content
// IS the serialization. JSON-clone is sufficient: usfm-js verseObject
// nodes are plain JSON (strings / numbers / arrays / objects).
function cloneNodeOpaque(n: ParsedNode): ParsedNode {
  return JSON.parse(JSON.stringify(n)) as ParsedNode;
}

function sourceOf(node: ParsedNode): SourceWord {
  const out: SourceWord = {
    id: uid(),
    strong: String(node["strong"] ?? ""),
    occurrence: String(node["occurrence"] ?? "1"),
    occurrences: String(node["occurrences"] ?? "1"),
  };
  if (node["lemma"] !== undefined) out.lemma = String(node["lemma"]);
  if (node["morph"] !== undefined) out.morph = String(node["morph"]);
  if (node["content"] !== undefined) out.content = String(node["content"]);
  return out;
}

function targetOf(node: ParsedNode): TargetWord {
  return {
    id: uid(),
    text: String(node["text"] ?? ""),
    occurrence: String(node["occurrence"] ?? "1"),
    occurrences: String(node["occurrences"] ?? "1"),
  };
}

function uid(): string {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// `x-occurrence` is only meaningful relative to `x-occurrences`. A milestone
// claiming occurrence > occurrences is malformed source data: an AI/tC aligner
// sometimes stamps the *second* span of a non-contiguous split gloss as
// occurrence="2" while occurrences stays "1" (e.g. ZEC 5:5 וַיֵּצֵא → "And" …
// "went out"). Clamp into [1, occurrences] so both spans resolve to the same
// logical occurrence. This is a no-op for well-formed data (occurrence is
// always ≤ occurrences there), so genuinely-repeated words never false-merge.
function effectiveOccurrence(s: SourceWord): number {
  const occ = parseInt(s.occurrence, 10) || 1;
  const total = parseInt(s.occurrences, 10) || 1;
  return Math.min(Math.max(occ, 1), Math.max(total, 1));
}

// Two source chains identify the same alignment group when their source
// words match position-for-position on (strong, occurrence, content). Used
// to merge multiple `\zaln-s` pairs that wrap the same Hebrew/Greek token
// (non-contiguous alignment in the original USFM) into one logical group.
function sameSourceChain(a: SourceWord[], b: SourceWord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].strong !== b[i].strong) return false;
    if (effectiveOccurrence(a[i]) !== effectiveOccurrence(b[i])) return false;
    if (nfc(a[i].content ?? "") !== nfc(b[i].content ?? "")) return false;
  }
  return true;
}

function findExistingGroup(
  groups: AlignmentGroup[],
  chain: SourceWord[],
): string | null {
  for (const g of groups) {
    if (sameSourceChain(g.source, chain)) return g.id;
  }
  return null;
}

function walk(
  nodes: ParsedNode[],
  sourceChain: SourceWord[],
  stream: StreamItem[],
  sourceGroups: AlignmentGroup[],
  currentGroupId: string | null,
): void {
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    if (nodeIsZaln(node)) {
      const chain = [...sourceChain, sourceOf(node)];
      const children = (node["children"] as ParsedNode[] | undefined) ?? [];
      const hasDirectWord = children.some(nodeIsWord);
      let nextGroupId = currentGroupId;
      if (hasDirectWord) {
        const existing = findExistingGroup(sourceGroups, chain);
        if (existing) {
          nextGroupId = existing;
        } else {
          const id = uid();
          sourceGroups.push({ id, source: chain, targets: [] });
          nextGroupId = id;
        }
      }
      walk(children, chain, stream, sourceGroups, nextGroupId);
    } else if (nodeIsWord(node)) {
      stream.push({ kind: "word", word: targetOf(node), alignedTo: currentGroupId });
    } else if (nodeIsText(node)) {
      stream.push({ kind: "text", text: String(node["text"] ?? "") });
    } else if (isAlignmentWrapper(node) || isPsalmTitleWrapper(node)) {
      // Descend through a `\qs` (or similar whitelisted) wrapper — or a
      // `\d` Psalm superscription carrying children — whose children
      // include alignment-bearing content. The inner zaln / word / text
      // nodes enter the stream like any other content; the wrapper itself
      // is reconstructed at serialize time from these brackets.
      const tag = String(node["tag"] ?? "");
      stream.push({ kind: "openMarker", tag, node: cloneNodeShallow(node) });
      const children = (node["children"] as ParsedNode[] | undefined) ?? [];
      walk(children, sourceChain, stream, sourceGroups, currentGroupId);
      stream.push({ kind: "closeMarker", tag });
    } else {
      // Opaque inline node — footnotes (\f), blank lines (\b), chunk
      // milestones (\ts*), section headings (\ms), bare `\qs Selah\qs*`
      // without inner alignment, paragraph markers (\p, \q1, \q2, \m).
      // The whole node (attrs + children) rides along verbatim on the
      // marker; serializer emits it as-is. extractPlainText still
      // recursively concatenates `text` fields out of these children,
      // matching importer behaviour for Selah / Psalm titles / etc.
      stream.push({ kind: "marker", node: cloneNodeOpaque(node) });
    }
  }
}

function deriveViews(state: Omit<AlignmentState, "groups" | "unaligned">): {
  groups: AlignmentGroup[];
  unaligned: TargetWord[];
} {
  const byGroup = new Map<string, TargetWord[]>();
  const unaligned: TargetWord[] = [];
  for (const item of state.stream) {
    if (item.kind !== "word") continue;
    if (item.alignedTo) {
      const list = byGroup.get(item.alignedTo) ?? [];
      list.push(item.word);
      byGroup.set(item.alignedTo, list);
    } else {
      unaligned.push(item.word);
    }
  }
  const groups = state.sourceGroups.map((g) => ({
    ...g,
    targets: byGroup.get(g.id) ?? [],
  }));
  return { groups, unaligned };
}

function finalize(state: Omit<AlignmentState, "groups" | "unaligned">): AlignmentState {
  return { ...state, ...deriveViews(state) };
}

export function parseAlignment(
  verseObjects: unknown[],
  sourceVerseObjects?: unknown[] | null,
): AlignmentState {
  const inputs = (verseObjects ?? []) as ParsedNode[];
  const stream: StreamItem[] = [];
  const sourceGroups: AlignmentGroup[] = [];
  walk(inputs, [], stream, sourceGroups, null);

  const base = { stream, sourceGroups };
  if (!sourceVerseObjects) return finalize(base);
  return finalize(withSourceCoverage(base, sourceVerseObjects));
}

export function verseHasUnalignedWork(
  targetVerseObjects: unknown[] | null | undefined,
  sourceVerseObjects: unknown[] | null | undefined,
): boolean {
  if (!Array.isArray(targetVerseObjects)) return false;
  const state = parseAlignment(targetVerseObjects, sourceVerseObjects ?? null);
  if (state.unaligned.length > 0) return true;
  return state.groups.some((g) => g.targets.length === 0);
}

interface CollectedSourceWord {
  position: number;
  strong: string;
  lemma: string;
  morph: string;
  text: string;
  textKey: string;
  textOccurrence: number;
}

function collectSourceWords(verseObjects: unknown[]): CollectedSourceWord[] {
  const out: CollectedSourceWord[] = [];
  const textCounts = new Map<string, number>();
  let pos = 0;
  const walkSrc = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as ParsedNode | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const textKey = nfc(text);
        const tOcc = (textCounts.get(textKey) ?? 0) + 1;
        textCounts.set(textKey, tOcc);
        out.push({
          position: pos++,
          strong: String(o["strong"] ?? ""),
          lemma: String(o["lemma"] ?? ""),
          morph: String(o["morph"] ?? ""),
          text,
          textKey,
          textOccurrence: tOcc,
        });
      } else if (o["type"] === "milestone") {
        walkSrc((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walkSrc(verseObjects);
  return out;
}

function findSourcePosition(
  sourceWords: CollectedSourceWord[],
  s: SourceWord,
): number {
  const want = parseInt(s.occurrence, 10) || 1;
  if (s.content) {
    const wantKey = nfc(s.content);
    let count = 0;
    let firstPos = -1;
    for (const sw of sourceWords) {
      if (sw.textKey === wantKey) {
        count++;
        if (firstPos === -1) firstPos = sw.position;
        if (count === want) return sw.position;
      }
    }
    if (firstPos !== -1) return firstPos;
  }
  if (s.strong) {
    let count = 0;
    let firstPos = -1;
    for (const sw of sourceWords) {
      if (sw.strong === s.strong) {
        count++;
        if (firstPos === -1) firstPos = sw.position;
        if (count === want) return sw.position;
      }
    }
    if (firstPos !== -1) return firstPos;
  }
  return -1;
}

// Augment with synthetic source groups for any UHB/UGNT word the target
// USFM didn't reference, so the dialog can show empty drop slots. Empty
// groups don't emit anything; when populated, the chips emit at their
// stream positions wrapped in milestones tagged to the placeholder source.
function withSourceCoverage(
  base: Omit<AlignmentState, "groups" | "unaligned">,
  sourceVerseObjects: unknown[],
): Omit<AlignmentState, "groups" | "unaligned"> {
  const sourceWords = collectSourceWords(sourceVerseObjects);
  if (sourceWords.length === 0) return base;
  const covered = new Set<number>();
  for (const g of base.sourceGroups) {
    for (const s of g.source) {
      const p = findSourcePosition(sourceWords, s);
      if (p >= 0) covered.add(p);
    }
  }
  // Keyed by textKey (NFC) — textOccurrence was counted per textKey in
  // collectSourceWords, so totals must use the same key or two raw-different
  // / NFC-equal tokens get occurrence=2 with occurrences=1 (malformed).
  const textTotals = new Map<string, number>();
  for (const sw of sourceWords) {
    textTotals.set(sw.textKey, (textTotals.get(sw.textKey) ?? 0) + 1);
  }
  const placeholders: AlignmentGroup[] = [];
  for (const sw of sourceWords) {
    if (covered.has(sw.position)) continue;
    placeholders.push({
      id: uid(),
      source: [
        {
          id: uid(),
          strong: sw.strong,
          lemma: sw.lemma,
          morph: sw.morph,
          occurrence: String(sw.textOccurrence),
          occurrences: String(textTotals.get(sw.textKey) ?? 1),
          content: sw.text,
        },
      ],
      targets: [],
    });
  }
  return { ...base, sourceGroups: [...base.sourceGroups, ...placeholders] };
}

function buildMilestone(source: SourceWord, children: ParsedNode[]): ParsedNode {
  // Emit attributes that were present in the original (including
  // legitimate `x-lemma=""` for clitic prepositions like OBA's `l`,
  // `b`, `m`). Skip attrs that were absent — usfm-js otherwise emits
  // `x-foo=""` for any defined key, which would pollute the daily DCS
  // export diff for any milestone synthesised from a partially-known
  // SourceWord.
  const out: ParsedNode = { tag: "zaln", type: "milestone" };
  if (source.strong)               out["strong"] = source.strong;
  if (source.lemma !== undefined)  out["lemma"] = source.lemma;
  if (source.morph !== undefined)  out["morph"] = source.morph;
  if (source.occurrence)           out["occurrence"] = source.occurrence;
  if (source.occurrences)          out["occurrences"] = source.occurrences;
  if (source.content !== undefined) out["content"] = source.content;
  out["children"] = children;
  out["endTag"] = "zaln-e\\*";
  return out;
}

function buildNestedMilestone(chain: SourceWord[], children: ParsedNode[]): ParsedNode {
  // Innermost source wraps children directly; each outer source wraps the
  // resulting milestone, recreating the original `\zaln-s` nesting for
  // compounds (multiple source words → one alignment group).
  let node: ParsedNode = buildMilestone(chain[chain.length - 1], children);
  for (let i = chain.length - 2; i >= 0; i--) {
    node = buildMilestone(chain[i], [node]);
  }
  return node;
}

function wordNode(t: TargetWord): ParsedNode {
  return {
    text: t.text,
    tag: "w",
    type: "word",
    occurrence: t.occurrence,
    occurrences: t.occurrences,
  };
}

// Walk the document-order stream and rebuild the verseObjects tree. The
// output is a stack of frames: the bottom frame is the verse-level
// array; each `openMarker` pushes a new frame whose accumulated
// children become the wrapper node's content when its matching
// `closeMarker` arrives. Within any frame, words with the same
// `alignedTo` collapse into one `\zaln-s ... \zaln-e\*` milestone;
// text sandwiched between two words of the same alignment lives
// inside that milestone, text flanking an alignment change goes
// outside. Opaque markers (`\f`, `\b`, `\ts*`, etc.) emit verbatim.
//
// Invariant: a `\zaln-s` milestone is always closed before crossing
// an `openMarker`/`closeMarker` boundary. Matches the production
// ULT/UST encoding where `\zaln-e\*` precedes `\qs*`.
export function serializeAlignment(state: AlignmentState): unknown[] {
  const groupById = new Map(state.sourceGroups.map((g) => [g.id, g]));

  // Per-frame mutable state. The output-stack grows when we open a
  // wrapper and shrinks when we close one.
  interface Frame {
    out: ParsedNode[];
    wrapper: ParsedNode | null; // null for the verse-level frame
    current: string | null;
    openChildren: ParsedNode[] | null;
    pendingText: string;
  }

  const frames: Frame[] = [{
    out: [],
    wrapper: null,
    current: null,
    openChildren: null,
    pendingText: "",
  }];
  const top = (): Frame => frames[frames.length - 1];

  const closeMilestone = (f: Frame): void => {
    if (f.current === null || !f.openChildren) return;
    const group = groupById.get(f.current);
    if (group) f.out.push(buildNestedMilestone(group.source, f.openChildren));
    f.current = null;
    f.openChildren = null;
  };

  const flushPendingOutside = (f: Frame): void => {
    if (f.pendingText) {
      f.out.push({ type: "text", text: f.pendingText });
      f.pendingText = "";
    }
  };

  const flushPendingInside = (f: Frame): void => {
    if (f.pendingText && f.openChildren) {
      f.openChildren.push({ type: "text", text: f.pendingText });
      f.pendingText = "";
    }
  };

  for (const item of state.stream) {
    const f = top();
    if (item.kind === "text") {
      f.pendingText += item.text;
      continue;
    }
    if (item.kind === "marker") {
      // Close any open milestone in the current frame, then drop the
      // opaque marker into the frame's output verbatim.
      if (f.current !== null) closeMilestone(f);
      flushPendingOutside(f);
      f.out.push(item.node);
      continue;
    }
    if (item.kind === "openMarker") {
      // Close any open milestone in the parent frame; push a new
      // frame whose `wrapper` will be rebuilt on the matching close.
      if (f.current !== null) closeMilestone(f);
      flushPendingOutside(f);
      frames.push({
        out: [],
        wrapper: item.node,
        current: null,
        openChildren: null,
        pendingText: "",
      });
      continue;
    }
    if (item.kind === "closeMarker") {
      // Close any open milestone inside the current frame, build the
      // wrapper node from this frame's accumulated children, and push
      // the wrapper into the parent frame's output.
      if (f.current !== null) closeMilestone(f);
      flushPendingOutside(f);
      const finished = frames.pop()!;
      const parent = top();
      const wrapper = finished.wrapper ?? { tag: item.tag, type: "quote" };
      const wrapperNode: ParsedNode = { ...wrapper, children: finished.out };
      // Close any open milestone in the parent before splicing in the
      // wrapper — should already be closed by openMarker handling.
      if (parent.current !== null) closeMilestone(parent);
      flushPendingOutside(parent);
      parent.out.push(wrapperNode);
      continue;
    }
    // item.kind === "word"
    const next = item.alignedTo;
    if (next === f.current && f.current !== null) {
      flushPendingInside(f);
      f.openChildren!.push(wordNode(item.word));
      continue;
    }
    if (f.current !== null) {
      // Text accumulated while a milestone was open belongs OUTSIDE
      // that milestone when the next word breaks the run.
      closeMilestone(f);
    }
    flushPendingOutside(f);
    if (next !== null) {
      const group = groupById.get(next);
      if (!group) {
        // Word references a group that no longer exists — fall back
        // to emitting it as bare to avoid losing the text.
        f.out.push(wordNode(item.word));
        f.current = null;
        f.openChildren = null;
        continue;
      }
      f.current = next;
      f.openChildren = [wordNode(item.word)];
    } else {
      f.out.push(wordNode(item.word));
      f.current = null;
      f.openChildren = null;
    }
  }

  // Flush any open milestone / pending text at the verse-level frame.
  // openMarker/closeMarker pairs are required to be balanced; if a
  // closeMarker is missing the unfinished wrapper's contents stay in
  // the popped frame's output array and would be lost. We don't
  // expect unbalanced streams from `walk`, but guard by collapsing
  // any leftover frames into the verse frame.
  while (frames.length > 1) {
    const f = top();
    if (f.current !== null) closeMilestone(f);
    flushPendingOutside(f);
    const finished = frames.pop()!;
    const parent = top();
    const wrapper = finished.wrapper ?? null;
    if (wrapper) {
      parent.out.push({ ...wrapper, children: finished.out });
    } else {
      parent.out.push(...finished.out);
    }
  }
  const verse = top();
  if (verse.current !== null) closeMilestone(verse);
  flushPendingOutside(verse);

  return verse.out;
}

// Compute the plain text of an alignment state by serializing back to
// verseObjects and running the shared `extractPlainText`. Using the
// shared extractor keeps the save path byte-equal with the importer
// (api/src/importParsers.ts → extractPlainText), so Selah and other
// non-zaln content survive Save → reload without `plain_text` drift.
export function alignmentPlainText(state: AlignmentState): string {
  return extractPlainText(serializeAlignment(state));
}

// Clear every alignment in the verse — all stream words become unaligned,
// every compound source chain splits into singletons (matching clearGroup's
// behaviour). The whole-verse "start over" action.
export function clearAll(state: AlignmentState): AlignmentState {
  const sourceGroups: AlignmentGroup[] = [];
  for (const g of state.sourceGroups) {
    for (let i = 0; i < g.source.length; i++) {
      sourceGroups.push({
        id: i === 0 ? g.id : uid(),
        source: [g.source[i]],
        targets: [],
      });
    }
  }
  const stream = state.stream.map((item) =>
    item.kind === "word" ? { ...item, alignedTo: null } : item,
  );
  return finalize({ ...state, sourceGroups, stream });
}

// Clear all target words from `groupId` (back to unaligned). For compound
// source chains, split into singleton groups so the user can re-align
// each Hebrew word independently. The first singleton inherits the
// cleared group's id so stream items still resolve to a live group.
export function clearGroup(state: AlignmentState, groupId: string): AlignmentState {
  const idx = state.sourceGroups.findIndex((g) => g.id === groupId);
  if (idx < 0) return state;
  const target = state.sourceGroups[idx];
  const singletons: AlignmentGroup[] = target.source.map((s, i) => ({
    id: i === 0 ? target.id : uid(),
    source: [s],
    targets: [],
  }));
  const sourceGroups = [
    ...state.sourceGroups.slice(0, idx),
    ...singletons,
    ...state.sourceGroups.slice(idx + 1),
  ];
  // Any stream word that pointed at the cleared group becomes unaligned;
  // the first singleton owns the cleared id but starts with no targets.
  const stream = state.stream.map((item) =>
    item.kind === "word" && item.alignedTo === groupId
      ? { ...item, alignedTo: null }
      : item,
  );
  return finalize({ ...state, sourceGroups, stream });
}

// Pull a source word out of a compound group into its own new singleton
// group with empty targets. The previous group keeps its remaining source
// words AND its attached target chips — only the extracted source becomes
// detached. No-op when the source is already alone in its group.
export function extractSource(
  state: AlignmentState,
  sourceId: string,
): AlignmentState {
  const idx = state.sourceGroups.findIndex((g) =>
    g.source.some((s) => s.id === sourceId),
  );
  if (idx < 0) return state;
  const from = state.sourceGroups[idx];
  if (from.source.length <= 1) return state;
  const moving = from.source.find((s) => s.id === sourceId)!;
  const remaining = from.source.filter((s) => s.id !== sourceId);
  const newGroup: AlignmentGroup = {
    id: uid(),
    source: [moving],
    targets: [],
  };
  const sourceGroups = [
    ...state.sourceGroups.slice(0, idx),
    { ...from, source: remaining },
    ...state.sourceGroups.slice(idx + 1),
    newGroup,
  ];
  return finalize({ ...state, sourceGroups });
}

// Move a source word from its current group into `destGroupId`'s source
// chain, making that group compound. If the source group collapses (its
// last source word left), every stream word aligned to it re-points at
// the destination so previously-attached targets follow their source.
export function moveSource(
  state: AlignmentState,
  sourceId: string,
  destGroupId: string,
): AlignmentState {
  let moving: SourceWord | null = null;
  let fromGroupId: string | null = null;
  for (const g of state.sourceGroups) {
    const found = g.source.find((s) => s.id === sourceId);
    if (found) {
      moving = found;
      fromGroupId = g.id;
      break;
    }
  }
  if (!moving || !fromGroupId || fromGroupId === destGroupId) return state;
  let collapsed = false;
  const sourceGroups: AlignmentGroup[] = [];
  for (const g of state.sourceGroups) {
    if (g.id === fromGroupId) {
      const remaining = g.source.filter((s) => s.id !== sourceId);
      if (remaining.length === 0) {
        collapsed = true;
        continue;
      }
      sourceGroups.push({ ...g, source: remaining });
    } else if (g.id === destGroupId) {
      sourceGroups.push({ ...g, source: [...g.source, moving] });
    } else {
      sourceGroups.push(g);
    }
  }
  const stream = collapsed
    ? state.stream.map((item) =>
        item.kind === "word" && item.alignedTo === fromGroupId
          ? { ...item, alignedTo: destGroupId }
          : item,
      )
    : state.stream;
  return finalize({ ...state, sourceGroups, stream });
}

// Merge an entire alignment group (`eatenId`) into `survivorId`: the eaten
// group's source words are appended to the survivor's source chain (making it
// compound), and every target word aligned to the eaten group re-points to the
// survivor. The eaten group is then dropped. This is `moveSource`'s collapse
// branch generalised to all of a group's source words at once — a single-word
// group merged this way behaves exactly like dragging its lone Hebrew word via
// `moveSource` (the group collapses and its English follows).
//
// Reversible via `clearGroup`, which splits the compound back into singletons.
//
// Order: the merged source chain is `[...survivor.source, ...eaten.source]`.
// Targets re-derive in stream (document) order, so they need no sorting. For
// the merged Hebrew to read in verse order, callers should pass the
// earlier-positioned card as `survivorId` (the dialog already sorts cards by
// source position, so it knows which is earlier).
//
// No-op when the ids are equal, either group is missing, or the eaten group
// has no source words.
export function mergeGroups(
  state: AlignmentState,
  survivorId: string,
  eatenId: string,
): AlignmentState {
  if (survivorId === eatenId) return state;
  const survivor = state.sourceGroups.find((g) => g.id === survivorId);
  const eaten = state.sourceGroups.find((g) => g.id === eatenId);
  if (!survivor || !eaten || eaten.source.length === 0) return state;
  const sourceGroups = state.sourceGroups
    .filter((g) => g.id !== eatenId)
    .map((g) =>
      g.id === survivorId ? { ...g, source: [...g.source, ...eaten.source] } : g,
    );
  const stream = state.stream.map((item) =>
    item.kind === "word" && item.alignedTo === eatenId
      ? { ...item, alignedTo: survivorId }
      : item,
  );
  return finalize({ ...state, sourceGroups, stream });
}

// Apply moveTarget for multiple word ids. Used when the user shift-selects
// chips and drags the bundle onto one destination.
export function moveTargets(
  state: AlignmentState,
  wordIds: string[],
  dest: string,
): AlignmentState {
  let s = state;
  for (const id of wordIds) {
    s = moveTarget(s, id, dest);
  }
  return s;
}

// Move a target word identified by `wordId` to a destination ("g:<groupId>"
// or "u" for unaligned). Crucially, the word stays in its original stream
// position; only its `alignedTo` tag changes. The verse's plain text
// order is invariant across alignment edits.
//
// Rejects a destination group that doesn't exist — without that guard a
// drag landing on a group that was just cleared/collapsed would silently
// point at nothing, and the serializer would demote the word to unaligned
// on save. The user can't see the demotion until they re-open the verse,
// so a no-op is the safer behaviour.
export function moveTarget(state: AlignmentState, wordId: string, dest: string): AlignmentState {
  let newAlignment: string | null | undefined = undefined;
  if (dest === "u") {
    newAlignment = null;
  } else if (dest.startsWith("g:")) {
    const groupId = dest.slice(2);
    if (!state.groups.some((g) => g.id === groupId)) return state;
    newAlignment = groupId;
  }
  if (newAlignment === undefined) return state;

  let changed = false;
  const stream = state.stream.map((item) => {
    if (item.kind !== "word" || item.word.id !== wordId) return item;
    if (item.alignedTo === newAlignment) return item;
    changed = true;
    return { ...item, alignedTo: newAlignment };
  });
  if (!changed) return state;
  return finalize({ ...state, stream });
}

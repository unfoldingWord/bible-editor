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
import { tokenizeEditableText } from "./replace.ts";

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
// Poetry / paragraph LINE markers whose same-line trailing text (which usfm-js
// parks on the marker's own `text` field — `\q1 Some enemies watched` →
// {tag:"q1",text:"Some…"}) is alignable verse body. Deliberately EXCLUDES
// `\qa` (acrostic header label — not verse text, must not become a draggable
// word) and `\qs` (character wrapper around its content, e.g. bare Selah — its
// text is preserved verbatim, not tokenized).
const LINE_TEXT_MARKER_TAGS = new Set<string>([
  "q", "q1", "q2", "q3", "q4", "qm", "qm1", "qm2", "qm3",
  "p", "m", "mi", "pi", "pi1", "pi2", "pi3", "pc", "nb", "b",
]);
function nodeIsLineTextMarker(n: ParsedNode | undefined): boolean {
  if (!n) return false;
  if (n["type"] !== "quote" && n["type"] !== "paragraph") return false;
  const tag = n["tag"];
  return typeof tag === "string" && LINE_TEXT_MARKER_TAGS.has(tag)
    && typeof n["text"] === "string" && n["text"] !== "";
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
// An alignment wrapper (`\qs`) whose content usfm-js parked on its own `text`
// field instead of as children — the same-line `\qs Selah\qs*` shape parses to
// {tag:"qs", text:"Selah"} with NO children, whereas `\qs`\nSelah\n`\qs*`
// parses to a text CHILD (handled by isAlignmentWrapper). Without this, the
// same-line Selah is opaque and its word can't be aligned. (The newline shape
// already tokenizes via isAlignmentWrapper → nodeIsText.)
function isAlignmentWrapperWithText(n: ParsedNode | undefined): boolean {
  if (!n || typeof n !== "object") return false;
  if (n["type"] !== "quote") return false;
  const tag = n["tag"];
  if (typeof tag !== "string" || !ALIGNMENT_WRAPPER_TAGS.has(tag)) return false;
  const children = n["children"];
  const hasChildren = Array.isArray(children) && children.length > 0;
  return !hasChildren && typeof n["text"] === "string" && n["text"] !== "";
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

// Tokenize a bare target-text string into stream items. Most text nodes hold
// only inter-word whitespace / punctuation (zero word runs) or AI-drafted
// prose with no `\w` wrappers; either way word runs become draggable unaligned
// stream words and separators stay `text`. But a text node can also carry a
// literal USFM marker token — `\q2`, `\p`, `\ts\*` — left there by an AI draft
// or a hand-typed edit that never went through a marker button. Those must
// surface as the SAME opaque structural markers the parser builds elsewhere,
// NOT as the unalignable target words "q2"/"p" (the reported HOS 7:13 UST bug:
// a typed `\q2` showed up in the aligner as draggable text). So tokenize
// through the marker-aware tokenizeEditableText — the exact recognizer the
// save path uses — and route marker nodes to StreamMarkers, which serialize
// verbatim. That also heals the data: saving the alignment rewrites the literal
// `\q2` text as a real marker node. Normal aligned verses are unaffected — their
// text holds only separators, which tokenize identically to the old path.
function pushBareTextTokens(text: string, stream: StreamItem[]): void {
  for (const tok of tokenizeEditableText(text) as ParsedNode[]) {
    if (nodeIsWord(tok)) {
      stream.push({ kind: "word", word: targetOf(tok), alignedTo: null });
    } else if (nodeIsText(tok)) {
      stream.push({ kind: "text", text: String(tok["text"] ?? "") });
    } else {
      stream.push({ kind: "marker", node: tok });
    }
  }
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
      // Tokenize bare text into draggable words. The AI returns unaligned
      // ULT/UST as plain text (`\p \v 1 In the beginning...`) with no `\w`
      // wrappers; without this, those words are invisible to the aligner and
      // can never be aligned in-app (they also glue to a preceding marker on
      // export, e.g. `\q1Some`). Word runs become unaligned stream words
      // (alignedTo:null → the unaligned bag); punctuation / whitespace stays
      // `text`. Normal aligned verses are unaffected: their text nodes hold
      // only inter-word separators, which tokenize to zero word runs and
      // round-trip back to the identical text node. A literal `\q2` / `\p`
      // marker token embedded in the text becomes a structural marker, not a
      // draggable word — see pushBareTextTokens.
      pushBareTextTokens(String(node["text"] ?? ""), stream);
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
    } else if (isAlignmentWrapperWithText(node)) {
      // `\qs Selah\qs*` — Selah parked on the qs node's `text` (no children).
      // Open the wrapper, tokenize its text into alignable words INSIDE it,
      // then close — so Selah becomes a draggable unaligned word that
      // round-trips as `\qs <words>\qs*` (and aligns like the production
      // `\qs \zaln-s…\w Selah\w*\zaln-e\*\qs*` shape once a source is bound).
      const tag = String(node["tag"] ?? "");
      const { text, ...rest } = node;
      stream.push({ kind: "openMarker", tag, node: cloneNodeShallow(rest) });
      pushBareTextTokens(String(text), stream);
      stream.push({ kind: "closeMarker", tag });
    } else if (nodeIsLineTextMarker(node)) {
      // Poetry/paragraph line marker carrying same-line verse text that
      // usfm-js parked on its `text` field (`\q1 Some enemies watched`).
      // Emit the marker text-less, then tokenize the parked text into
      // alignable words — otherwise those words are invisible to the aligner
      // (and glue back as `\q1Some` on export). Excludes \qa / \qs (see
      // nodeIsLineTextMarker). The trailing newline rides along as text.
      const { text, ...rest } = node;
      stream.push({ kind: "marker", node: cloneNodeOpaque(rest) });
      pushBareTextTokens(String(text), stream);
    } else {
      // Opaque inline node — footnotes (\f), blank lines (\b), chunk
      // milestones (\ts*), section headings (\ms), bare `\qs Selah\qs*`
      // without inner alignment, acrostic headers (\qa ZAYIN), paragraph
      // markers (\p, \q1, \q2, \m) with no parked text. The whole node
      // (attrs + children) rides along verbatim on the marker; serializer
      // emits it as-is. extractPlainText still recursively concatenates
      // `text` fields out of these children, matching importer behaviour
      // for Selah / Psalm titles / etc.
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

// ─── display-group post-processing (shared with the panel) ──────────────────
// Pure transforms the aligner applies to `state.groups` before rendering:
// collapse a compound's redundant source words and fuse adjacent same-source
// groups. Live here (not in the component) so they're free of JSX and unit-
// testable.

// Identity of a single source word for overlap/merge purposes: NFC content +
// occurrence. Keying on content ALONE conflates genuinely-distinct repeats —
// e.g. ZEC 6:13 has two עַל (occ 1 and 2); a standalone עַל(1) would otherwise
// strip עַל(2) out of its compound and the second עַל silently vanishes from
// the cards (its source word stays bound — hover still bridges it — but no
// chip renders).
export function sourceWordKey(s: SourceWord): string {
  return `${nfc(s.content ?? "")}|${s.occurrence}`;
}

// Whole-chain key, used to fuse adjacent groups that wrap the same source.
export function sourceKey(g: AlignmentGroup): string {
  return g.source.map(sourceWordKey).join("~");
}

// Drop a compound's source word when an identical (content + occurrence)
// standalone group already owns it, so the token isn't double-represented.
// Occurrence-aware: a standalone occ-1 never strips a genuine occ-2 sibling.
export function stripCompoundOverlaps(groups: AlignmentGroup[]): AlignmentGroup[] {
  const standaloneKeys = new Set<string>();
  for (const g of groups) {
    if (g.source.length === 1) standaloneKeys.add(sourceWordKey(g.source[0]));
  }
  if (standaloneKeys.size === 0) return groups;
  return groups.map((g) => {
    if (g.source.length <= 1) return g;
    const kept = g.source.filter((s) => !standaloneKeys.has(sourceWordKey(s)));
    if (kept.length === g.source.length || kept.length === 0) return g;
    return { ...g, source: kept };
  });
}

// Stable React key for an alignment card. Group ids regenerate on every parse
// (crypto.randomUUID), so keying on them would remount the whole grid on any
// re-derive (e.g. a reading-text edit) — a jarring flash. Key instead on the
// FULL source chain: each source word's POSITION in the source verse plus its
// occurrence.
//
// Position ALONE is not unique. One source token split-aligned to two
// non-contiguous target runs produces two distinct groups whose FIRST source
// word resolves to the same position (JER 28:1 UST aligns the single אָמַר to
// both "spoke to me" phrases as occ 1/2 and 2/2; likewise לְעֵינֵי →
// "while"/"watched"). A `p{pos}`-only key collided across those siblings, and
// duplicate React keys made the cards pile up on every hover-driven re-render.
// Appending occurrence separates the split halves; keeping position separates
// same-Strong words with different pointing (three אֶל forms in ZEC 1:3 are all
// H0413|1). Unresolved positions (-1, malformed data) fall back to a
// strong|content|occurrence content key. `sourcePos` maps source-word id →
// position (the panel's posMaps.sourcePosById).
export function cardKey(g: AlignmentGroup, sourcePos: Map<string, number>): string {
  if (g.source.length === 0) return g.id;
  return (
    "src:" +
    g.source
      .map((s) => {
        const p = sourcePos.get(s.id) ?? -1;
        return p >= 0
          ? `p${p}.${s.occurrence}`
          : `${s.strong}|${nfc(s.content ?? "")}|${s.occurrence}`;
      })
      .join("~")
  );
}

export function mergeAdjacentSameSource(groups: AlignmentGroup[]): AlignmentGroup[] {
  const out: AlignmentGroup[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (last && sourceKey(last) === sourceKey(g)) {
      out[out.length - 1] = { ...last, targets: [...last.targets, ...g.targets] };
    } else {
      out.push(g);
    }
  }
  return out;
}

// Fuse display groups whose source words occupy the SAME source position(s).
// An AI aligner sometimes stamps a source token that appears ONCE in the
// UHB/UGNT with occurrences="2" — one per repeated target phrase — so JER 28:1
// UST yields two חֲנַנְיָה groups (occ 1/2 and 2/2), two אָמַר אֵלַי groups,
// and two לְעֵינֵי groups that each resolve to a SINGLE physical Hebrew token.
// They render as a "doubled" Hebrew card even though the source word appears
// once. occurrence is unreliable here, so identity is taken from POSITION: two
// groups with the same resolved position sequence are the same physical
// source and collapse into one card (targets concatenated). Genuine repeats
// (distinct physical tokens) carry different positions and are left alone.
//
// `positionKey` returns a stable key from a group's resolved source positions,
// or null when any position is unresolved (then the group never merges — we
// can't prove it's a duplicate). Display-only: callers pass display groups, so
// state.sourceGroups (and therefore serialize/export) is untouched.
export function mergeSamePositionGroups(
  groups: AlignmentGroup[],
  positionKey: (g: AlignmentGroup) => string | null,
): AlignmentGroup[] {
  const out: AlignmentGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const g of groups) {
    const k = positionKey(g);
    if (k !== null) {
      const existing = indexByKey.get(k);
      if (existing !== undefined) {
        out[existing] = { ...out[existing], targets: [...out[existing].targets, ...g.targets] };
        continue;
      }
      indexByKey.set(k, out.length);
    }
    out.push(g);
  }
  return out;
}

export function parseAlignment(
  verseObjects: unknown[],
  sourceVerseObjects?: unknown[] | null,
): AlignmentState {
  const inputs = (verseObjects ?? []) as ParsedNode[];
  // Re-anchor any AI-glued source milestones to the UHB/UGNT before walking, so
  // a maqqef-spanning token becomes per-word milestones (correct strongs, no
  // phantom duplicate, individually splittable). No-op when source is absent or
  // the verse is clean — clean verses round-trip byte-identical.
  const reformed = (sourceVerseObjects
    ? reformGluedMilestones(inputs, sourceVerseObjects)
    : inputs) as ParsedNode[];
  const stream: StreamItem[] = [];
  const sourceGroups: AlignmentGroup[] = [];
  walk(reformed, [], stream, sourceGroups, null);

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

// Count of unaligned TARGET words — the same metric the aligner's "N unaligned"
// badge shows (AlignmentPanel reads `state.unaligned.length`). Source-independent:
// it counts `\w` words with no enclosing `\zaln-s` milestone, so it needs no UHB/
// UGNT side. Used by the save path to tell the editor when an edit just left
// words unaligned (a text edit to a word drops that word's alignment by design).
export function countUnalignedTargetWords(
  targetVerseObjects: unknown[] | null | undefined,
): number {
  if (!Array.isArray(targetVerseObjects)) return 0;
  return parseAlignment(targetVerseObjects, null).unaligned.length;
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
      } else if (
        o["type"] === "milestone" ||
        // \d (Psalm superscription) is type:"section" but its content IS
        // alignable verse body — descend like a milestone so its \w tokens
        // are covered. Mirrors collectMilestoneRuns in highlight.ts.
        (o["type"] === "section" && o["tag"] === "d")
      ) {
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

// Hebrew source tokens an AI/tC aligner glued across a maqqef (U+05BE) or a
// minus/hyphen into ONE `\zaln-s` x-content — e.g. AMO 3:1 UST
// `x-content="אֶת־הַדָּבָר"` over the UHB pair אֶת(H0853) + הַדָּבָר(d:H1697),
// carrying only the first word's strong (3:3 even uses a U+2212 minus). Strip
// pointing/cantillation and every joiner so such an x-content can be matched
// against the run of separate UHB words it actually spans.
const SOURCE_JOINER_CODES = new Set<number>([
  0x05be, // maqqef (U+05BE)
  0x002d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, // hyphen-minus + dashes
  0x2212, // minus sign (U+2212)
  0x200b, 0x200c, 0x200d, 0x2060, // zero-width + word joiners
]);
function sourceFold(text: string): string {
  let out = "";
  for (const ch of nfc(text)) {
    if (/[\p{Mn}\s]/u.test(ch)) continue;
    if (SOURCE_JOINER_CODES.has(ch.codePointAt(0) ?? -1)) continue;
    out += ch;
  }
  return out;
}

// Every UHB/UGNT position an existing source word covers. Normally just the one
// `findSourcePosition` resolves. But a maqqef/minus-joined x-content (above)
// spans SEVERAL adjacent UHB words while resolving by strong to only the first —
// its neighbours would then look "uncovered" and `withSourceCoverage` would emit
// a phantom empty placeholder for each (the reported Amos duplication: the
// maqqef-joined word shows once inside the glued card and again as an empty
// card). When the content's consonant fold is longer than the matched word's and
// begins with it, greedily consume the following UHB words until the accumulated
// fold matches exactly, covering the whole spanned run. Falls back to the single
// position when there is no clean span match — so it never over-covers.
function coveredPositions(
  sourceWords: CollectedSourceWord[],
  s: SourceWord,
): number[] {
  const start = findSourcePosition(sourceWords, s);
  if (start < 0) return [];
  const wantFold = sourceFold(s.content ?? "");
  const startFold = sourceFold(sourceWords[start].text);
  if (!wantFold || !startFold || wantFold === startFold || !wantFold.startsWith(startFold)) {
    return [start];
  }
  const positions = [start];
  let acc = startFold;
  let p = start;
  while (acc.length < wantFold.length && p + 1 < sourceWords.length) {
    p += 1;
    const f = sourceFold(sourceWords[p].text);
    if (!f) break;
    acc += f;
    positions.push(p);
    if (acc === wantFold) return positions;
  }
  return [start];
}

export interface ReformReport {
  reformed: number;
  skipped: number;
  notes: string[];
}

// A cross-word GLUE joiner inside an x-content string — maqqef (U+05BE),
// minus (U+2212), or any hyphen/dash. Deliberately EXCLUDES the zero-width
// joiners (U+2060/U+200D) that appear INSIDE a single UHB word (e.g. the
// article in הַ⁠דָּבָר): those are intra-word, not a sign of two glued words.
function contentHasGlueJoiner(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? -1;
    if (cp === 0x05be || cp === 0x002d || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) return true;
  }
  return false;
}

// Reform AI-malformed source alignment off the UHB/UGNT. The upstream AI aligner
// sometimes stamps a `\zaln-s` whose x-content SPANS a maqqef/minus — gluing two
// separate UHB words into one source token that carries only the first word's
// (often wrong) strong (e.g. AMO 3:1 UST `x-content="אֶת־הַדָּבָר" x-strong="H0853"`
// over UHB אֶת(H0853) + הַדָּבָר(d:H1697)). Such a token can't be aligned per-word
// and trips a phantom placeholder for its neighbour. We re-anchor it to the UHB:
//
//   - Only milestones whose x-content CONTAINS a glue joiner are candidates
//     (`contentHasGlueJoiner`). Everything else is left byte-identical — a
//     consonant fold drops pointing, so fold-matching a normal single word could
//     "fix" attrs that are actually correct; we never do that.
//   - For a candidate, enumerate EVERY contiguous UHB run whose concatenated
//     `sourceFold` equals the content fold. Reform only when the run is UNIQUE;
//     >1 match (or none) ⇒ leave the milestone untouched (never guess) and count
//     it in `report`.
//   - On a unique run of N words, replace the one milestone with N nested
//     `\zaln-s` milestones (innermost wraps the original target `\w` children),
//     each carrying that UHB word's strong/lemma/morph/content and a per-exact-
//     surface occurrence (`collectSourceWords` textOccurrence). Every target word
//     stays under a `\zaln`, so a later export sees `changed_source`, not `lost`.
//
// Returns the SAME array reference when nothing reformed (clean verses round-trip
// untouched). Pure; never mutates the input. Reused by the aligner (at parse) and
// the backfill script, so the logic lives in exactly one place.
export function reformGluedMilestones(
  targetVerseObjects: unknown[],
  sourceVerseObjects: unknown[],
  report?: ReformReport,
): unknown[] {
  if (!Array.isArray(targetVerseObjects) || !Array.isArray(sourceVerseObjects)) {
    return targetVerseObjects;
  }
  const sourceWords = collectSourceWords(sourceVerseObjects);
  if (sourceWords.length === 0) return targetVerseObjects;
  const folds = sourceWords.map((sw) => sourceFold(sw.text));
  const totals = new Map<string, number>();
  for (const sw of sourceWords) totals.set(sw.textKey, (totals.get(sw.textKey) ?? 0) + 1);

  // Every contiguous UHB run whose concatenated fold equals `contentFold`; a
  // unique match disambiguates, anything else is refused.
  const findUniqueRun = (contentFold: string): { start: number; len: number } | null => {
    const matches: Array<{ start: number; len: number }> = [];
    for (let i = 0; i < folds.length; i++) {
      let acc = "";
      for (let j = i; j < folds.length && acc.length < contentFold.length; j++) {
        acc += folds[j];
        if (acc === contentFold) { matches.push({ start: i, len: j - i + 1 }); break; }
        if (!contentFold.startsWith(acc)) break;
      }
    }
    return matches.length === 1 ? matches[0] : null;
  };

  const transform = (nodes: unknown[]): unknown[] => {
    let localChanged = false;
    const out: unknown[] = [];
    for (const node of nodes ?? []) {
      const o = node as ParsedNode | null;
      if (o && o["type"] === "milestone" && o["tag"] === "zaln") {
        const origKids = (o["children"] as unknown[] | undefined) ?? [];
        const kids = transform(origKids);
        const content = String(o["content"] ?? "");
        if (contentHasGlueJoiner(content)) {
          const run = findUniqueRun(sourceFold(content));
          if (run) {
            const chain: SourceWord[] = [];
            for (let k = run.start; k < run.start + run.len; k++) {
              const sw = sourceWords[k];
              const reW: SourceWord = {
                id: uid(),
                strong: sw.strong,
                occurrence: String(sw.textOccurrence),
                occurrences: String(totals.get(sw.textKey) ?? 1),
                content: sw.text,
              };
              if (sw.lemma) reW.lemma = sw.lemma;
              if (sw.morph) reW.morph = sw.morph;
              chain.push(reW);
            }
            out.push(buildNestedMilestone(chain, kids as ParsedNode[]));
            localChanged = true;
            if (report) {
              report.reformed += 1;
              report.notes.push(`reformed "${content}" → ${run.len} UHB word(s)`);
            }
            continue;
          }
          if (report) {
            report.skipped += 1;
            report.notes.push(`skipped (no unique UHB run): "${content}"`);
          }
        }
        if (kids !== origKids) { out.push({ ...o, children: kids }); localChanged = true; }
        else out.push(node);
        continue;
      }
      if (o && Array.isArray(o["children"])) {
        const kids = transform(o["children"] as unknown[]);
        if (kids !== o["children"]) { out.push({ ...o, children: kids }); localChanged = true; }
        else out.push(node);
        continue;
      }
      out.push(node);
    }
    return localChanged ? out : nodes;
  };

  return transform(targetVerseObjects);
}

// ─── doubled-source detection ───────────────────────────────────────────────
// A DISTINCT AI/edit defect from the maqqef glue above: a single top-level
// `\zaln-s` compound card whose nested source chain references the SAME UHB
// word twice — e.g. JER 31:33 ULT stamped
//   \zaln-s H0853 "אֶת" › \zaln-s H0854 "אֶת" › \zaln-s H1004b "בֵּית"
// while the UHB has only ONE אֶת there (H0854, "with", before בֵּית); the
// object-marker אֶת (H0853) is a separate token later in the verse. The card
// renders the Hebrew doubled (`אֶת אֶת בֵּית`). The robust signature is
// UHB-anchored: resolve each source word in a card to its UHB position; a
// well-formed card covers a UNIQUE CONTIGUOUS run of UHB words in document
// order, so two source words landing on the SAME position (`duplicate`) — or a
// gap between them (`noncontiguous`) — means the card doesn't correspond to any
// real UHB span. This reuses `collectSourceWords` + `findSourcePosition` (the
// same resolver `coveredPositions`/`withSourceCoverage` use), so the detector
// can't drift from what the aligner actually renders.
//
// Legit patterns this deliberately does NOT flag:
//   - genuine Hebrew repetition (שָׁלוֹם שָׁלוֹם, הֵיכַל … הֵיכַל …) — the
//     repeated tokens are distinct UHB positions, so a card spanning them is a
//     contiguous run with no duplicate;
//   - the "one UHB word → N non-adjacent target runs = N milestones" split
//     (gatewayEdit Model a) — those are N separate SINGLE-source cards, never
//     two source words in one card.

export interface DoubledSourceIssue {
  reason: "duplicate" | "noncontiguous";
  // Source words in the card (chain order), each with its resolved UHB position
  // (-1 never appears — a card with any unresolved word is skipped).
  sources: { strong: string; content: string; occurrence: string; position: number }[];
  targets: string[];
}

// Collect each MAXIMAL `\zaln-s` subtree in the target as one card: its full
// nested source chain (outer→inner) plus the target words it wraps. Descends
// through non-zaln wrappers (\d, \qs, paragraph markers) to find card roots, but
// never treats a nested zaln as its own root.
function collectAlignmentCards(
  nodes: unknown[],
): Array<{ chain: SourceWord[]; targets: string[] }> {
  const cards: Array<{ chain: SourceWord[]; targets: string[] }> = [];
  const collectCard = (root: ParsedNode): void => {
    const chain: SourceWord[] = [];
    const targets: string[] = [];
    const rec = (node: ParsedNode): void => {
      if (nodeIsZaln(node)) chain.push(sourceOf(node));
      else if (nodeIsWord(node)) targets.push(String(node["text"] ?? ""));
      for (const k of (node["children"] as unknown[] | undefined) ?? []) {
        if (k && typeof k === "object") rec(k as ParsedNode);
      }
    };
    rec(root);
    cards.push({ chain, targets });
  };
  const walkForRoots = (list: unknown[]): void => {
    for (const n of list ?? []) {
      const o = n as ParsedNode | null;
      if (!o || typeof o !== "object") continue;
      if (nodeIsZaln(o)) {
        collectCard(o); // a card root — do NOT recurse for more roots inside it
      } else if (Array.isArray(o["children"])) {
        walkForRoots(o["children"] as unknown[]);
      }
    }
  };
  walkForRoots(nodes);
  return cards;
}

// Resolve a card source word to its UHB position by EXACT surface + occurrence —
// the Nth UHB word whose NFC text equals this milestone's x-content (the app's
// primary, cantillation-sensitive occurrence model; see `strong|occurrence NOT
// unique`). When the milestone carries no x-content, fall back to strong +
// occurrence. Returns -1 when it cannot resolve WITHOUT guessing — deliberately
// NO first-match fallback (that's what makes `findSourcePosition` collapse two
// distinct-surface same-strong words, e.g. 1SA 9:9 לְכָה vs נֵלְכָה, into one
// position and fabricate a false duplicate). A card with any unresolved word is
// skipped, so the detector never flags on a resolution it isn't sure of.
function resolveExactPosition(
  sourceWords: CollectedSourceWord[],
  s: SourceWord,
): number {
  const want = parseInt(s.occurrence, 10) || 1;
  const content = s.content;
  if (content) {
    const wantKey = nfc(content);
    let count = 0;
    for (const sw of sourceWords) {
      if (sw.textKey === wantKey && ++count === want) return sw.position;
    }
    return -1;
  }
  if (s.strong) {
    let count = 0;
    for (const sw of sourceWords) {
      if (sw.strong === s.strong && ++count === want) return sw.position;
    }
  }
  return -1;
}

// Pure. Returns one issue per malformed compound card; empty array when the
// verse is clean (or the source is absent). Only compound cards (≥2 source
// words) can trip either signature.
export function detectDoubledSourceMilestones(
  targetVerseObjects: unknown[],
  sourceVerseObjects: unknown[],
): DoubledSourceIssue[] {
  if (!Array.isArray(targetVerseObjects) || !Array.isArray(sourceVerseObjects)) return [];
  const sourceWords = collectSourceWords(sourceVerseObjects);
  if (sourceWords.length === 0) return [];
  const issues: DoubledSourceIssue[] = [];
  for (const card of collectAlignmentCards(targetVerseObjects)) {
    if (card.chain.length < 2) continue;
    const positions = card.chain.map((s) => resolveExactPosition(sourceWords, s));
    if (positions.some((p) => p < 0)) continue; // unresolved → can't verify, skip
    const sorted = [...positions].sort((a, b) => a - b);
    let duplicate = false;
    let contiguous = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) duplicate = true;
      else if (sorted[i] !== sorted[i - 1] + 1) contiguous = false;
    }
    if (!duplicate && contiguous) continue;
    issues.push({
      reason: duplicate ? "duplicate" : "noncontiguous",
      sources: card.chain.map((s, i) => ({
        strong: s.strong,
        content: nfc(s.content ?? ""),
        occurrence: s.occurrence,
        position: positions[i],
      })),
      targets: card.targets,
    });
  }
  return issues;
}

// Identity of a source milestone for doubled-source dedup: NFC x-content +
// x-occurrence. This uniquely names a physical UHB/UGNT token (the surface-
// occurrence model), so two milestones in ONE card sharing it can only be a
// duplicate. Deliberately NOT keyed on x-strong — the JER 31:33 defect stamps a
// spurious outer milestone with a DIFFERENT (wrong) strong but the same surface
// (`H0853 "אֶת"` over the real `H0854 "אֶת"`); keying on strong would miss it.
// Returns null when there's no x-content to identify the token — then the node
// is never treated as a duplicate (conservative).
function zalnDedupKey(node: ParsedNode): string | null {
  const content = node["content"];
  if (typeof content !== "string" || content === "") return null;
  return `${nfc(content)}|${String(node["occurrence"] ?? "1")}`;
}

function subtreeHasZalnKey(nodes: unknown[], key: string): boolean {
  for (const n of nodes ?? []) {
    const o = n as ParsedNode | null;
    if (!o || typeof o !== "object") continue;
    if (nodeIsZaln(o) && zalnDedupKey(o) === key) return true;
    if (Array.isArray(o["children"]) && subtreeHasZalnKey(o["children"] as unknown[], key)) return true;
  }
  return false;
}

// Collapse a `\zaln-s` compound that wraps the SAME source token twice — two
// milestones in one chain with identical (NFC x-content, x-occurrence). A card
// can never legitimately reference one UHB/UGNT word twice, so such a pair is an
// AI/edit artifact that renders the Hebrew doubled (JER 31:33 `אֶת אֶת בֵּית`).
// When a milestone has, anywhere in its own subtree, a nested milestone with the
// same key, DROP THE OUTER one (splice its children up one level) — the surviving
// inner milestone is the more specific one, which for the known shape carries the
// correct strong. Pure; returns the SAME array reference when nothing is doubled,
// so clean verses round-trip byte-identical. Genuine Hebrew repetition
// (שָׁלוֹם שָׁלוֹם) is untouched: those tokens carry distinct occurrences → distinct
// keys. Mirrored server-side in api/src/importParsers.ts.
export function dropDuplicateSourceMilestones(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const transform = (nodes: unknown[]): unknown[] => {
    let changed = false;
    const out: unknown[] = [];
    for (const node of nodes ?? []) {
      const o = node as ParsedNode | null;
      if (o && nodeIsZaln(o)) {
        const origKids = (o["children"] as unknown[] | undefined) ?? [];
        const kids = transform(origKids);
        const key = zalnDedupKey(o);
        if (key !== null && subtreeHasZalnKey(kids, key)) {
          // Outer duplicate — unwrap it, keeping the (deduped) inner subtree.
          out.push(...kids);
          changed = true;
          continue;
        }
        if (kids !== origKids) { out.push({ ...o, children: kids }); changed = true; }
        else out.push(node);
        continue;
      }
      if (o && Array.isArray(o["children"])) {
        const kids = transform(o["children"] as unknown[]);
        if (kids !== o["children"]) { out.push({ ...o, children: kids }); changed = true; }
        else out.push(node);
        continue;
      }
      out.push(node);
    }
    return changed ? out : nodes;
  };
  return transform(verseObjects);
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
  // Normalize each compound's source order to canonical (UHB/UGNT text) order.
  // The chain comes out of `walk` in milestone-NESTING order, which a few
  // AI-generated alignments stamp reversed (e.g. ZEC 6:13 UST nests הֵיכַל
  // before its אֵת direct-object marker). Sorting by source position fixes the
  // RTL card render AND the serialized nesting, so a touched verse exports the
  // corrected order. Well-formed data is already canonical, so this is a no-op
  // there (stable sort) — no export churn for legitimate alignments.
  const sortedGroups = base.sourceGroups.map((g) => {
    if (g.source.length < 2) return g;
    const withPos = g.source.map((s, i) => {
      const p = findSourcePosition(sourceWords, s);
      return { s, key: p >= 0 ? p : Number.MAX_SAFE_INTEGER, i };
    });
    withPos.sort((a, b) => a.key - b.key || a.i - b.i);
    if (withPos.every((x, idx) => x.i === idx)) return g; // already canonical
    return { ...g, source: withPos.map((x) => x.s) };
  });
  base = { ...base, sourceGroups: sortedGroups };
  const covered = new Set<number>();
  for (const g of base.sourceGroups) {
    for (const s of g.source) {
      for (const p of coveredPositions(sourceWords, s)) covered.add(p);
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

  // Never emit a compound that wraps the same source token twice (the doubled-
  // source defect, e.g. JER 31:33 `אֶת אֶת בֵּית`) — an aligner save re-serializing
  // already-doubled data would otherwise re-persist it. No-op on clean output.
  return dropDuplicateSourceMilestones(verse.out);
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

// Sort a group's source words into canonical UHB/UGNT verse order using the
// supplied position resolver (−1 = unresolved → sorts last, stable). Mirrors
// the parse-time canonicalisation in `withSourceCoverage` so a compound built
// live by dragging chips together (`moveSource`) or folding cards
// (`mergeGroups`) reads RTL and serialises in verse order regardless of drag
// direction — without it, appending the dragged word to the end reverses pairs
// like ZEC 7:2 `אֶת פְּנֵי` when the earlier word is dropped onto the later one.
function canonicalizeSource(
  source: SourceWord[],
  sourcePos: (s: SourceWord) => number,
): SourceWord[] {
  if (source.length < 2) return source;
  const withPos = source.map((s, i) => {
    const p = sourcePos(s);
    return { s, key: p >= 0 ? p : Number.MAX_SAFE_INTEGER, i };
  });
  withPos.sort((a, b) => a.key - b.key || a.i - b.i);
  return withPos.map((x) => x.s);
}

// Move a source word from its current group into `destGroupId`'s source
// chain, making that group compound. If the source group collapses (its
// last source word left), every stream word aligned to it re-points at
// the destination so previously-attached targets follow their source.
//
// `sourcePos`, when supplied, re-sorts the destination chain into canonical
// verse order so the merged Hebrew reads correctly no matter which chip was
// dragged onto which.
export function moveSource(
  state: AlignmentState,
  sourceId: string,
  destGroupId: string,
  sourcePos?: (s: SourceWord) => number,
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
      const combined = [...g.source, moving];
      sourceGroups.push({
        ...g,
        source: sourcePos ? canonicalizeSource(combined, sourcePos) : combined,
      });
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
// Order: the merged source chain is `[...survivor.source, ...eaten.source]`,
// then re-sorted into canonical verse order when `sourcePos` is supplied — so
// the merged Hebrew reads in verse order regardless of which card was dragged
// onto which. Targets re-derive in stream (document) order, so they need no
// sorting.
//
// No-op when the ids are equal, either group is missing, or the eaten group
// has no source words.
export function mergeGroups(
  state: AlignmentState,
  survivorId: string,
  eatenId: string,
  sourcePos?: (s: SourceWord) => number,
): AlignmentState {
  if (survivorId === eatenId) return state;
  const survivor = state.sourceGroups.find((g) => g.id === survivorId);
  const eaten = state.sourceGroups.find((g) => g.id === eatenId);
  if (!survivor || !eaten || eaten.source.length === 0) return state;
  const sourceGroups = state.sourceGroups
    .filter((g) => g.id !== eatenId)
    .map((g) => {
      if (g.id !== survivorId) return g;
      const combined = [...g.source, ...eaten.source];
      return {
        ...g,
        source: sourcePos ? canonicalizeSource(combined, sourcePos) : combined,
      };
    });
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

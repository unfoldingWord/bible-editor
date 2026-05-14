// Parse and serialize word alignments to/from the usfm-js verse-objects
// JSON tree.
//
// Internal model: target English (or other GL) text is a flat document-order
// stream of word + text items. Each word optionally carries an `alignedTo`
// tag pointing at a source group; the source groups themselves live in a
// separate list keyed by uid. This decouples target-text order from
// alignment metadata so an alignment edit never reorders the verse's
// natural reading order.
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

import { nfc } from "./hebrew";

export interface SourceWord {
  id: string;
  strong: string;
  lemma: string;
  morph: string;
  occurrence: string;
  occurrences: string;
  content: string;
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
type StreamItem = StreamWord | StreamText;

export interface AlignmentState {
  // Internal document-order stream of target text + words. The single
  // source of truth for "where each target word sits in the verse".
  stream: StreamItem[];
  // Source-word groups, keyed by id, independent of stream order. UHB
  // display order is computed separately in the dialog.
  sourceGroups: AlignmentGroup[];
  // Derived views, refreshed on every mutation for UI compat.
  groups: AlignmentGroup[];
  unaligned: TargetWord[];
  // Passthrough nodes that the alignment model doesn't touch.
  prefix: ParsedNode[];
  passthroughTail: ParsedNode[];
}

type ParsedNode = Record<string, unknown>;

function nodeIsZaln(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "milestone" && n["tag"] === "zaln";
}
function nodeIsWord(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "word" && n["tag"] === "w";
}
function nodeIsText(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "text" && typeof n["text"] === "string";
}

function sourceOf(node: ParsedNode): SourceWord {
  return {
    id: uid(),
    strong: String(node["strong"] ?? ""),
    lemma: String(node["lemma"] ?? ""),
    morph: String(node["morph"] ?? ""),
    occurrence: String(node["occurrence"] ?? "1"),
    occurrences: String(node["occurrences"] ?? "1"),
    content: String(node["content"] ?? ""),
  };
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

// Two source chains identify the same alignment group when their source
// words match position-for-position on (strong, occurrence, content). Used
// to merge multiple `\zaln-s` pairs that wrap the same Hebrew/Greek token
// (non-contiguous alignment in the original USFM) into one logical group.
function sameSourceChain(a: SourceWord[], b: SourceWord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].strong !== b[i].strong) return false;
    if (a[i].occurrence !== b[i].occurrence) return false;
    if (nfc(a[i].content) !== nfc(b[i].content)) return false;
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
  const prefix: ParsedNode[] = [];
  const passthroughTail: ParsedNode[] = [];

  // Split into prefix/tail (non-text passthrough markers like \p) and the
  // alignment stream (milestones, words, text in document order).
  let seenContent = false;
  for (const node of inputs) {
    if (!node || typeof node !== "object") continue;
    if (nodeIsZaln(node) || nodeIsWord(node)) {
      seenContent = true;
      continue;
    }
    if (nodeIsText(node)) continue;
    if (!seenContent) prefix.push(node);
    else passthroughTail.push(node);
  }

  const stream: StreamItem[] = [];
  const sourceGroups: AlignmentGroup[] = [];
  walk(
    inputs.filter((n) => nodeIsZaln(n) || nodeIsWord(n) || nodeIsText(n)),
    [],
    stream,
    sourceGroups,
    null,
  );

  const base = { stream, sourceGroups, prefix, passthroughTail };
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
  const textTotals = new Map<string, number>();
  for (const sw of sourceWords) {
    textTotals.set(sw.text, (textTotals.get(sw.text) ?? 0) + 1);
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
          occurrences: String(textTotals.get(sw.text) ?? 1),
          content: sw.text,
        },
      ],
      targets: [],
    });
  }
  return { ...base, sourceGroups: [...base.sourceGroups, ...placeholders] };
}

function buildMilestone(source: SourceWord, children: ParsedNode[]): ParsedNode {
  return {
    tag: "zaln",
    type: "milestone",
    strong: source.strong,
    lemma: source.lemma,
    morph: source.morph,
    occurrence: source.occurrence,
    occurrences: source.occurrences,
    content: source.content,
    children,
    endTag: "zaln-e\\*",
  };
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

// Walk the document-order stream. Open a milestone on entering an aligned
// run, close it on exit, and let unaligned words and text segments emit as
// bare top-level nodes between milestones. Text that sits between two
// stream words with the SAME alignment lives inside that milestone; text
// flanking an alignment change goes outside.
export function serializeAlignment(state: AlignmentState): unknown[] {
  const out: ParsedNode[] = [...state.prefix];
  const groupById = new Map(state.sourceGroups.map((g) => [g.id, g]));

  let current: string | null = null;
  let openChildren: ParsedNode[] | null = null;
  let pendingText = "";

  const closeMilestone = (): void => {
    if (current === null || !openChildren) return;
    const group = groupById.get(current);
    if (group) out.push(buildNestedMilestone(group.source, openChildren));
    current = null;
    openChildren = null;
  };

  const flushPendingOutside = (): void => {
    if (pendingText) {
      out.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  const flushPendingInside = (): void => {
    if (pendingText && openChildren) {
      openChildren.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  for (const item of state.stream) {
    if (item.kind === "text") {
      pendingText += item.text;
      continue;
    }
    const next = item.alignedTo;
    if (next === current && current !== null) {
      flushPendingInside();
      openChildren!.push(wordNode(item.word));
      continue;
    }
    if (current !== null) {
      // Text accumulated while a milestone was open belongs OUTSIDE that
      // milestone when the next word breaks the run — it was the gap
      // between two milestones, not internal whitespace.
      closeMilestone();
    }
    flushPendingOutside();
    if (next !== null) {
      const group = groupById.get(next);
      if (!group) {
        // Word references a group that no longer exists — fall back to
        // emitting it as bare to avoid losing the text.
        out.push(wordNode(item.word));
        current = null;
        openChildren = null;
        continue;
      }
      current = next;
      openChildren = [wordNode(item.word)];
    } else {
      out.push(wordNode(item.word));
      current = null;
      openChildren = null;
    }
  }
  if (current !== null) closeMilestone();
  flushPendingOutside();

  out.push(...state.passthroughTail);
  return out;
}

export function alignmentPlainText(state: AlignmentState): string {
  const parts: string[] = [];
  for (const item of state.stream) {
    if (item.kind === "text") parts.push(item.text);
    else parts.push(item.word.text);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
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

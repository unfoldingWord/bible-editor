// Parse and serialize word alignments to/from the usfm-js verse-objects
// JSON tree. Each `zaln` milestone is one alignment group: a single source
// word (Hebrew/Greek, via x-content + x-strong + x-lemma + x-morph) with N
// target-language `\w` children aligned to it. Target words that sit
// outside any milestone are "unaligned" — they exist in the verse but
// aren't tied to a source token yet.
//
// This file handles only the **flat** case (one source word per milestone,
// no nesting). Compound alignments where multiple source words map to a
// single phrase are a Phase 4 enhancement; for v1 we preserve them on read
// and round-trip them unchanged if the user doesn't touch them.

export interface SourceWord {
  id: string;             // local-only id for drag/drop between groups
  strong: string;
  lemma: string;
  morph: string;
  occurrence: string;
  occurrences: string;
  content: string;        // the actual Hebrew/Greek text
}

export interface TargetWord {
  id: string;             // local-only id for drag/drop
  text: string;
  occurrence: string;
  occurrences: string;
}

export interface AlignmentGroup {
  id: string;             // local-only id
  source: SourceWord[];   // 1+ source words; 2+ = compound (nested milestones)
  targets: TargetWord[];
}

export interface AlignmentState {
  groups: AlignmentGroup[];
  unaligned: TargetWord[];
  prefix: ParsedNode[];   // leading non-alignment content (paragraph markers, etc.)
  // Anything we don't recognize is preserved verbatim under `passthrough` —
  // we slot it back in at the end so we don't trash unrecognized USFM.
  passthroughTail: ParsedNode[];
}

type ParsedNode = Record<string, unknown>;

function nodeIsZaln(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "milestone" && n["tag"] === "zaln";
}

function nodeIsWord(n: ParsedNode | undefined): boolean {
  return !!n && n["type"] === "word" && n["tag"] === "w";
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

// Walk a list of nodes, accumulating alignment groups and unaligned words.
// `sourceChain` carries the stack of source words from outer milestones —
// when a (possibly nested) milestone has its own \w children, we emit a
// group whose `source` is the full chain. This handles compound alignments
// (one phrase mapped to multiple Hebrew/Greek words) correctly.
function walk(
  nodes: ParsedNode[],
  sourceChain: SourceWord[],
  groups: AlignmentGroup[],
  unaligned: TargetWord[],
): void {
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    if (nodeIsZaln(node)) {
      const chain = [...sourceChain, sourceOf(node)];
      const children = (node["children"] as ParsedNode[] | undefined) ?? [];
      const directTargets: TargetWord[] = [];
      const nestedMilestones: ParsedNode[] = [];
      for (const child of children) {
        if (nodeIsWord(child)) directTargets.push(targetOf(child));
        else if (nodeIsZaln(child)) nestedMilestones.push(child);
      }
      if (directTargets.length > 0) {
        groups.push({ id: uid(), source: chain, targets: directTargets });
      }
      if (nestedMilestones.length > 0) {
        walk(nestedMilestones, chain, groups, unaligned);
      }
    } else if (nodeIsWord(node) && sourceChain.length === 0) {
      unaligned.push(targetOf(node));
    }
  }
}

function uid(): string {
  // Browser + worker support crypto.randomUUID. Node 19+ does too.
  return (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseAlignment(verseObjects: unknown[]): AlignmentState {
  const groups: AlignmentGroup[] = [];
  const unaligned: TargetWord[] = [];
  const prefix: ParsedNode[] = [];
  const tail: ParsedNode[] = [];

  let seenContent = false;
  const inputs = (verseObjects ?? []) as ParsedNode[];

  for (const node of inputs) {
    if (!node || typeof node !== "object") continue;
    if (nodeIsZaln(node) || nodeIsWord(node)) {
      seenContent = true;
      continue;
    }
    if (!seenContent) prefix.push(node);
    else tail.push(node);
  }

  // Now do the alignment walk over only the milestone/word nodes.
  walk(inputs.filter((n) => nodeIsZaln(n) || nodeIsWord(n)), [], groups, unaligned);

  return { groups, unaligned, prefix, passthroughTail: tail };
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

export function serializeAlignment(state: AlignmentState): unknown[] {
  const out: ParsedNode[] = [...state.prefix];

  state.groups.forEach((group, idx) => {
    // Build the innermost children: \w word tokens with separators.
    const targetTokens: ParsedNode[] = [];
    group.targets.forEach((t, ti) => {
      if (ti > 0) targetTokens.push({ type: "text", text: " " });
      targetTokens.push({
        text: t.text,
        tag: "w",
        type: "word",
        occurrence: t.occurrence,
        occurrences: t.occurrences,
      });
    });

    // Nest from the innermost source outward.
    let node: ParsedNode = buildMilestone(
      group.source[group.source.length - 1],
      targetTokens,
    );
    for (let i = group.source.length - 2; i >= 0; i--) {
      node = buildMilestone(group.source[i], [node]);
    }
    out.push(node);
    if (idx < state.groups.length - 1) {
      out.push({ type: "text", text: " " });
    }
  });

  // Unaligned target words tail.
  if (state.unaligned.length > 0) {
    if (out[out.length - 1]?.["type"] !== "text") {
      out.push({ type: "text", text: " " });
    }
    state.unaligned.forEach((t, i) => {
      if (i > 0) out.push({ type: "text", text: " " });
      out.push({
        text: t.text,
        tag: "w",
        type: "word",
        occurrence: t.occurrence,
        occurrences: t.occurrences,
      });
    });
  }

  out.push(...state.passthroughTail);
  return out;
}

// Helper for the dialog: render the GL text strung together from groups +
// unaligned, in target-word order, with spaces.
export function alignmentPlainText(state: AlignmentState): string {
  const words: string[] = [];
  for (const g of state.groups) for (const t of g.targets) words.push(t.text);
  for (const t of state.unaligned) words.push(t.text);
  return words.join(" ");
}

// Clear all target words from `groupId` (back to unaligned) and split any
// compound source chain into singleton groups so the user can re-align each
// Hebrew word independently. The source words themselves are preserved.
export function clearGroup(state: AlignmentState, groupId: string): AlignmentState {
  const idx = state.groups.findIndex((g) => g.id === groupId);
  if (idx < 0) return state;
  const target = state.groups[idx];
  const orphanedTargets = target.targets;
  // Replace the group in-place with one singleton group per source word.
  const singletons: AlignmentGroup[] = target.source.map((s) => ({
    id: uid(),
    source: [s],
    targets: [],
  }));
  const groups = [...state.groups.slice(0, idx), ...singletons, ...state.groups.slice(idx + 1)];
  const unaligned = [...state.unaligned, ...orphanedTargets];
  return { ...state, groups, unaligned };
}

// Move a source word (identified by SourceWord.id) into `destGroupId`'s
// source chain, making that group compound. If the source's previous group
// becomes empty (no remaining sources), its targets merge into the
// destination group's targets — the user merged the source words, so their
// already-aligned GL words logically belong with the merged group.
export function moveSource(
  state: AlignmentState,
  sourceId: string,
  destGroupId: string,
): AlignmentState {
  let moving: SourceWord | null = null;
  let fromGroupId: string | null = null;
  for (const g of state.groups) {
    const found = g.source.find((s) => s.id === sourceId);
    if (found) {
      moving = found;
      fromGroupId = g.id;
      break;
    }
  }
  if (!moving || !fromGroupId || fromGroupId === destGroupId) return state;
  let mergedTargets: TargetWord[] = [];
  const intermediate: AlignmentGroup[] = [];
  for (const g of state.groups) {
    if (g.id === fromGroupId) {
      const remainingSources = g.source.filter((s) => s.id !== sourceId);
      if (remainingSources.length === 0) {
        mergedTargets = g.targets;
        continue;
      }
      intermediate.push({ ...g, source: remainingSources });
    } else {
      intermediate.push(g);
    }
  }
  const groups = intermediate.map((g) =>
    g.id === destGroupId
      ? {
          ...g,
          source: [...g.source, moving!],
          targets: [...g.targets, ...mergedTargets],
        }
      : g,
  );
  return { ...state, groups };
}

// Apply moveTarget for multiple word ids in document order. Used when the
// user shift-selects several chips in the unaligned bag and drags the bundle
// onto a single destination.
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
// or "u" for the unaligned bag). Returns a new AlignmentState.
export function moveTarget(state: AlignmentState, wordId: string, dest: string): AlignmentState {
  let moving: TargetWord | null = null;
  const groups = state.groups.map((g) => {
    const targets = g.targets.filter((t) => {
      if (t.id === wordId) {
        moving = t;
        return false;
      }
      return true;
    });
    return { ...g, targets };
  });
  let unaligned = state.unaligned.filter((t) => {
    if (t.id === wordId) {
      moving = t;
      return false;
    }
    return true;
  });
  if (!moving) return state;
  if (dest === "u") {
    unaligned = [...unaligned, moving];
  } else if (dest.startsWith("g:")) {
    const targetId = dest.slice(2);
    for (const g of groups) {
      if (g.id === targetId) {
        g.targets = [...g.targets, moving];
        break;
      }
    }
  }
  return { ...state, groups, unaligned };
}

// ─── aligner hover-highlight resolution ─────────────────────────────────────
// The pure logic behind the aligner's cross-language hover linking: source-token
// position resolution, the display-group derivation the cards render, the three
// hover maps, and the two highlight resolvers. Live here (not in
// AlignmentPanel) so they're free of JSX and unit-testable — same reason the
// display-group transforms in alignment.ts were moved out of the component.
//
// This surface has a history of regressions that only a test can catch (see
// alignmentHover.test.mjs): a hover fix that repaired fused cards broke stripped
// compounds, and neither was reachable from the test runner while the logic sat
// inside useMemo bodies.
//
// Positions: every map here is OWN-panel-relative (walk index within this
// panel's source verse). Positions carried in `hover` are UNION-relative in the
// side-by-side aligner, so every comparison translates via `posOffset` (see
// highlightTypes.ts).

import {
  stripCompoundOverlaps,
  mergeAdjacentSameSource,
  mergeSamePositionGroups,
  buildPositionOwners,
  positionOwnedBy,
  positionsShareOwner,
  findReusedSourceWordIds,
  sourceKey,
  type AlignmentGroup,
  type AlignmentState,
  type SourceWord,
} from "./alignment.ts";
import { nfc } from "./hebrew.ts";
import type { HoverHighlight, HighlightTone } from "./highlightTypes.ts";
import type { VerseDto } from "../sync/api.ts";

// Resolve a group source word to its token position in the panel's source
// verse: NFC content + occurrence first (exact), then content first-instance,
// then strong + occurrence, then strong first-instance. The fallback chain
// absorbs malformed occurrence data and cantillation drift between milestone
// x-content and the UHB \w text. -1 when nothing matches.
export function resolveSourcePos(s: SourceWord, indexMap: Map<string, number>): number {
  const c = nfc(s.content ?? "");
  return (
    indexMap.get(`t:${c}|${s.occurrence}`) ??
    indexMap.get(`t:${c}|1`) ??
    indexMap.get(`s:${s.strong}|${s.occurrence}`) ??
    indexMap.get(`s:${s.strong}|1`) ??
    -1
  );
}

// Position-sequence identity for a group: a stable key from its resolved source
// positions, or null when any source word is unresolved (then callers must not
// treat it as a duplicate — we can't prove it). Shared by buildDisplayGroups
// (which collapses same-position duplicate cards via mergeSamePositionGroups)
// and the panel's card-clear handler, which must unalign EVERY underlying group
// the card collapsed — not just the one whose id the card carries — so the two
// agree on what a single card owns.
export function groupPositionKey(g: AlignmentGroup, indexMap: Map<string, number>): string | null {
  if (g.source.length === 0) return null;
  const positions = g.source.map((s) => resolveSourcePos(s, indexMap));
  return positions.some((p) => p < 0) ? null : positions.join(".");
}

// Resolve a DISPLAY card id back to EVERY state group it collapsed — by
// sourceKey OR source position, the same identity AlignmentPanel's
// handleSourceDrop / handleClearGroup use. A card fuses groups by source
// identity (mergeAdjacentSameSource) AND by position (mergeSamePositionGroups
// → the occ 1/2 + 2/2 over-count), so the carried id alone under-counts it.
// The carried id stays first so it leads the returned list. Shared with
// scripts/scan-reused-token-visibility.mjs, which needs the same resolution
// to count the (display card, flagged token) unit rather than raw ids.
export function groupsForCard(
  groups: AlignmentGroup[],
  cardId: string,
  indexMap: Map<string, number>,
): string[] {
  const target = groups.find((g) => g.id === cardId);
  if (!target) return [cardId];
  const key = sourceKey(target);
  const posKey = groupPositionKey(target, indexMap);
  return [
    cardId,
    ...groups
      .filter(
        (g) =>
          g.id !== cardId &&
          (sourceKey(g) === key || (posKey !== null && groupPositionKey(g, indexMap) === posKey)),
      )
      .map((g) => g.id),
  ];
}

// The (display card, flagged token) unit for the census's `flaggedButUnrendered`
// signal (#424): for each DISPLAY card, resolve it back to every state group it
// fused (groupsForCard) and ask whether the card renders a chip for each
// flagged token those groups own. Returns the reusedTokenKey of every flagged
// token that never draws anywhere — empty when nothing is unrendered.
//
// Exported (not left as a script-local reimplementation in
// scripts/scan-reused-token-visibility.mjs) so a committed test proves the
// EXACT function the census runs, not a copy that can drift from it.
//
// Keys tokens via reusedTokenKey — the SAME identity the reused-source-token
// marker itself uses — not resolveSourcePos. reusedSourceIdsOf can flag a word
// whose claimed occurrence doesn't exist in the source verse (reusedTokenKey's
// content-fallback branch); resolveSourcePos resolves EVERY such word to -1,
// so two unrelated unresolved words would collide on the same -1 key and a
// genuinely-unrendered flagged token could misread as rendered by matching an
// unrelated word's -1. reusedTokenKey's content-based fallback differentiates
// by the word's own text, so this collision can't happen.
export function unrenderedFlaggedTokenKeys(
  state: AlignmentState,
  display: AlignmentGroup[],
  indexMap: Map<string, number>,
  flagged: ReadonlySet<string>,
): string[] {
  if (flagged.size === 0) return [];
  const unrendered = new Set<string>();
  for (const d of display) {
    const underlyingIds = groupsForCard(state.groups, d.id, indexMap);
    const flaggedTokenKeys = new Set<string>();
    for (const gid of underlyingIds) {
      const g = state.groups.find((sg) => sg.id === gid);
      if (!g) continue;
      for (const s of g.source) {
        if (!flagged.has(s.id)) continue;
        const key = reusedTokenKey(s, indexMap);
        if (key !== null) flaggedTokenKeys.add(key);
      }
    }
    if (flaggedTokenKeys.size === 0) continue;
    const renderedTokenKeys = new Set(
      d.source.map((s) => reusedTokenKey(s, indexMap)).filter((k): k is string => k !== null),
    );
    for (const k of flaggedTokenKeys) {
      if (!renderedTokenKeys.has(k)) unrendered.add(k);
    }
  }
  return [...unrendered];
}

// Walk-order index of the source verse's \w tokens, keyed both by NFC text +
// occurrence and by strong + occurrence so resolveSourcePos' fallback chain has
// something to hit. Positions must match the enumeration in UhbStrip /
// collectSourceWords — hence the \d descent below.
export function buildSourceIndexMap(sourceVerse: VerseDto | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!sourceVerse?.content) return map;
  const verseObjects = (sourceVerse.content as { verseObjects?: unknown[] }).verseObjects;
  if (!Array.isArray(verseObjects)) return map;
  let idx = 0;
  const textCount = new Map<string, number>();
  const strongCount = new Map<string, number>();
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = nfc(String(o["text"] ?? ""));
        const strong = String(o["strong"] ?? "");
        const tOcc = (textCount.get(text) ?? 0) + 1;
        const sOcc = (strongCount.get(strong) ?? 0) + 1;
        textCount.set(text, tOcc);
        strongCount.set(strong, sOcc);
        const textKey = `t:${text}|${tOcc}`;
        const strongKey = `s:${strong}|${sOcc}`;
        if (!map.has(textKey)) map.set(textKey, idx);
        if (!map.has(strongKey)) map.set(strongKey, idx);
        idx++;
      } else if (
        o["type"] === "milestone" ||
        // \d (Psalm superscription) is type:"section" but its content IS
        // alignable verse body — descend so its \w tokens get walk positions
        // matching SourceVerseTokens / collectAlignerSourceWords. Mirrors
        // collectMilestoneRuns in highlight.ts.
        (o["type"] === "section" && o["tag"] === "d")
      ) {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return map;
}

// Ids of source words claimed by 2+ distinct alignment groups — the
// reused-source-token defect the cards mark red rather than repair.
//
// ONE definition, called from both buildDisplayGroups and buildPosMaps: the
// display pipeline must not strip a word the marker is about to flag, so the two
// have to agree by construction. If they drift, a flagged chip stops rendering
// and the marker goes invisible again.
//
// Computed from `state.groups`, NOT display groups — stripCompoundOverlaps would
// already have erased the overlap, which is the circularity this helper exists
// to break. Keyed via reusedTokenKey, never resolveSourcePos (see both).
export function reusedSourceIdsOf(
  state: AlignmentState | null,
  sourceIndexMap: Map<string, number>,
): Set<string> {
  if (!state) return new Set<string>();
  return findReusedSourceWordIds(state.groups, (s) => reusedTokenKey(s, sourceIndexMap));
}

// The groups the cards actually render: source-position order, compound
// overlaps stripped, adjacent same-source groups fused, and same-position
// duplicates collapsed (one physical Hebrew token the AI stamped with
// occurrences > actual — see mergeSamePositionGroups).
//
// Flagged reused source words are exempt from the strip so the defect stays on
// screen — see stripCompoundOverlaps for the AMO 3:2 / 3:7 asymmetry that
// exemption fixes.
export function buildDisplayGroups(
  state: AlignmentState | null,
  sourceIndexMap: Map<string, number>,
): AlignmentGroup[] {
  if (!state) return [];
  const sortKey = (g: AlignmentGroup) => {
    if (g.source.length === 0) return Number.MAX_SAFE_INTEGER;
    const pos = resolveSourcePos(g.source[0], sourceIndexMap);
    return pos >= 0 ? pos : Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...state.groups].sort((a, b) => sortKey(a) - sortKey(b));
  const stripped = stripCompoundOverlaps(sorted, reusedSourceIdsOf(state, sourceIndexMap));
  const merged = mergeAdjacentSameSource(stripped);
  return mergeSamePositionGroups(merged, (g) => groupPositionKey(g, sourceIndexMap));
}

// Cross-language hover linking needs to know which alignment group each chip /
// Hebrew word belongs to. Built from displayGroups' targets, NOT from the
// stream's `alignedTo`: mergeAdjacentSameSource and mergeSamePositionGroups fold
// several state groups into one card and keep only the survivor's id, so a word
// whose `alignedTo` names an eaten group had a group id that appears nowhere in
// posOwners (which is display-derived) — hovering the Hebrew lit the card's
// chips but not that word's chip in the top inventory strip. Large
// split/discontiguous UST alignments are exactly the merged case, so the bigger
// the card the more of its inventory chips went dark. Keying off the rendered
// card's targets gives every aligned word the same canonical (display) id the
// cards use.
export function buildTargetIdToGroupId(displayGroups: AlignmentGroup[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of displayGroups) {
    for (const t of g.targets) map.set(t.id, g.id);
  }
  return map;
}

// Token identity for the reused-source-token marker: the EXACT source position
// (NFC x-content + occurrence, no fallback) when the word resolves, otherwise
// the word's own content+occurrence. Never Strong's — resolveSourcePos's
// strong|1 fallback collapses distinct same-Strong tokens onto one position and
// would accuse a clean verse. The second branch keeps a word whose claimed
// occurrence doesn't exist in the source verse (JER 36:30 UST) as evidence
// instead of dropping it. Null only when there is nothing to key on at all.
// See findReusedSourceWordIds.
export function reusedTokenKey(s: SourceWord, indexMap: Map<string, number>): string | null {
  const content = nfc(s.content ?? "");
  const pos = indexMap.get(`t:${content}|${s.occurrence}`);
  if (pos !== undefined) return `p${pos}`;
  return content === "" ? null : `c${content}|${s.occurrence}`;
}

export interface HoverPosMaps {
  // position → EVERY card that renders a source word there. More than one is
  // legitimate (see buildPositionOwners): a standalone card and a compound card
  // can both name the same physical token.
  posOwners: Map<number, Set<string>>;
  // source-word id → its own-relative walk position (-1 when unresolved).
  sourcePosById: Map<string, number>;
  // group id → the union of its source positions (state-derived; see below).
  groupPositions: Map<string, number[]>;
  // Ids of source words at a position claimed by 2+ distinct groups — an
  // upstream data defect the cards flag red rather than repair.
  reusedSourceIds: Set<string>;
}

export function buildPosMaps(
  state: AlignmentState | null,
  displayGroups: AlignmentGroup[],
  sourceIndexMap: Map<string, number>,
): HoverPosMaps {
  const sourcePosById = new Map<string, number>();
  const groupPositions = new Map<string, number[]>();
  if (!state)
    return {
      posOwners: new Map<number, Set<string>>(),
      sourcePosById,
      groupPositions,
      reusedSourceIds: new Set<string>(),
    };
  // sourcePosById + groupPositions cover EVERY state.groups source word so
  // any rendered token (and any word whose `alignedTo` points at a group
  // mergeAdjacentSameSource later folds away) still resolves its position.
  for (const g of state.groups) {
    const positions: number[] = [];
    for (const s of g.source) {
      const pos = resolveSourcePos(s, sourceIndexMap);
      sourcePosById.set(s.id, pos);
      if (pos < 0) continue;
      positions.push(pos);
    }
    groupPositions.set(g.id, positions);
  }
  // posOwners — position → which CARD(s) own it — must come from the
  // groups the cards actually render (displayGroups), not state.groups:
  // stripCompoundOverlaps drops a compound's source word when a standalone
  // card already owns that content, so mapping off state.groups let the
  // stripped token's position win by parse order and light the wrong card
  // on a strip-token hover.
  // groupPositions deliberately stays STATE-derived (the loop above): a
  // source word stripCompoundOverlaps removes from a compound's rendered
  // chain is still bound to it, and hover must still bridge it (see the
  // sourceWordKey comment in alignment.ts). Recomputing the union from the
  // card's narrowed chain would drop that word's position and take the
  // stripped token dark on hover. Safe for the merge paths too: both
  // mergeAdjacentSameSource (identical sourceKey) and
  // mergeSamePositionGroups (identical resolved-position key) fuse only
  // groups whose positions already match the survivor's.
  //
  // A position can have MORE THAN ONE owner (see buildPositionOwners): a
  // standalone card and a compound card that both name the same physical token.
  // Keeping only the first left the other card unable to recognise its own
  // token on hover (AMO 3:7 UST).
  const posOwners = buildPositionOwners(displayGroups, sourcePosById);
  // A source token claimed by 2+ DISTINCT groups is a data defect (one physical
  // Hebrew word can't belong to several alignment groups). Shared with
  // buildDisplayGroups through reusedSourceIdsOf so the strip can exempt exactly
  // the words this marks — see that helper for why the two must agree, and
  // findReusedSourceWordIds for the state.groups / reusedTokenKey choices.
  // Display only; nothing is fixed.
  const reusedSourceIds = reusedSourceIdsOf(state, sourceIndexMap);
  return { posOwners, sourcePosById, groupPositions, reusedSourceIds };
}

// Scope the english hover key by bibleVersion: `hover` is shared across both
// side-by-side panels, so an un-scoped `${text}|${occurrence}` key would give
// the OTHER panel's same-text/occurrence chip a false "exact" ring (hover ULT
// "and"(3) → UST "and"(3) lights too).
export function englishHoverKey(bibleVersion: string, text: string, occurrence: string): string {
  return `${bibleVersion}:${text}|${occurrence}`;
}

// Everything the resolvers below (and the two hover builders) need from the
// panel. Own-relative maps plus the panel's union offset.
export interface HoverCtx {
  hoverLink: boolean;
  bibleVersion: string;
  targetIdToGroupId: Map<string, string>;
  posMaps: HoverPosMaps;
  posOffset: number;
}

// The hover payload for an English chip: its group's union Hebrew positions,
// translated to union-relative, so the shared strip and the opposite panel can
// light their counterparts without sharing group ids (ids are per-panel).
export function makeEnglishHover(
  ctx: HoverCtx,
  wordId: string,
  text: string,
  occurrence: string,
  groupIdOverride?: string,
): HoverHighlight {
  const groupId = groupIdOverride ?? ctx.targetIdToGroupId.get(wordId) ?? null;
  const positions = (groupId ? ctx.posMaps.groupPositions.get(groupId) ?? [] : []).map(
    (p) => p + ctx.posOffset,
  );
  return {
    kind: "english",
    key: englishHoverKey(ctx.bibleVersion, text, occurrence),
    groupId,
    positions,
  };
}

// The hover payload for a Hebrew token. `pos` arrives union-relative.
export function makeHebrewHover(
  ctx: HoverCtx,
  pos: number,
  groupIdOverride?: string,
): HoverHighlight {
  return {
    kind: "hebrew",
    pos,
    // hover.groupId is a single representative (it only has to name a group for
    // the fallbacks in the resolvers); the authoritative "who owns this
    // position" question is answered by posOwners at each comparison. Insertion
    // order is display order, so this is the old first-wins owner.
    groupId:
      groupIdOverride ??
      ctx.posMaps.posOwners.get(pos - ctx.posOffset)?.values().next().value ??
      null,
  };
}

// Bound forms of the two pure ownership rules (tested in alignment.test.mjs).
function ownedBy(ctx: HoverCtx, pos: number, groupId: string | null): boolean {
  return positionOwnedBy(ctx.posMaps.posOwners, pos, groupId);
}
function sharesCard(ctx: HoverCtx, a: number, b: number): boolean {
  return positionsShareOwner(ctx.posMaps.posOwners, a, b);
}

// Highlight resolution. `hover` may name an English or Hebrew word; we mark
// same-language matches as "exact" and aligned cross-language partners as
// "linked".
export function resolveEnglishHighlight(
  ctx: HoverCtx,
  hover: HoverHighlight,
  wordId: string,
  text: string,
  occurrence: string,
  groupIdOverride?: string,
): HighlightTone {
  if (!ctx.hoverLink || !hover) return null;
  // Match the bibleVersion-scoped key set in makeEnglishHover so the
  // opposite panel's same-text chip doesn't ring "exact".
  const myKey = englishHoverKey(ctx.bibleVersion, text, occurrence);
  if (hover.kind === "english" && hover.key === myKey) return "exact";
  const myGroupId = groupIdOverride ?? ctx.targetIdToGroupId.get(wordId) ?? null;
  if (!myGroupId) return null;
  if (hover.kind === "hebrew") {
    // Resolve the hovered Hebrew position to THIS panel's own group.
    // The carried hover.groupId belongs to whichever panel the cursor
    // is in, so cross-panel linking resolves locally — each side lights
    // its own English (ULT "And I answered" ↔ UST "I asked"). The
    // groupId equality covers this panel's own card words whose source
    // pos failed to resolve (mirrors resolveHebrewHighlight's fallback; group
    // ids are per-panel UUIDs, so no cross-panel false match).
    if (ownedBy(ctx, hover.pos - ctx.posOffset, myGroupId)) return "linked";
    if (hover.groupId === myGroupId) return "linked";
    return null;
  }
  // English hovered (possibly in the other panel): its group's union
  // Hebrew positions resolve here to the group that shares the Hebrew.
  return hover.positions.some((p) => ownedBy(ctx, p - ctx.posOffset, myGroupId))
    ? "linked"
    : null;
}

export function resolveHebrewHighlight(
  ctx: HoverCtx,
  hover: HoverHighlight,
  pos: number,
  groupIdOverride?: string,
): HighlightTone {
  if (!ctx.hoverLink || !hover) return null;
  if (pos >= 0 && hover.kind === "hebrew" && hover.pos === pos) return "exact";
  // A card's own Hebrew names its card outright (groupIdOverride). A strip token
  // names no card — it is the verse's single entry for a physical token, which
  // can sit on a standalone card AND a compound card at once — so it asks the
  // weaker question: do these two positions share a card? Two consequences, both
  // intended: strip tokens that share any card light each other (hovering strip
  // `אֶל` lights strip `עֲבָדָיו` when a compound holds both — the same pair the
  // compound card lights), and the strip entry can be lit while the STANDALONE
  // card for that same token stays dark. That is not a contradiction: the strip
  // says "this token is involved", the card says "this card is not".
  if (hover.kind === "hebrew") {
    // Whole-group: the rest of the hovered word's group lights, resolved
    // to THIS panel's grouping — a compound card shows its siblings even
    // when the other side keeps them separate.
    if (groupIdOverride) {
      return ownedBy(ctx, hover.pos - ctx.posOffset, groupIdOverride) ? "linked" : null;
    }
    return pos >= 0 && sharesCard(ctx, pos - ctx.posOffset, hover.pos - ctx.posOffset)
      ? "linked"
      : null;
  }
  // English hover: its group's union positions name the Hebrew directly
  // (works on the shared strip and across panels). The groupId fallback covers
  // words those union positions miss — a card word whose source pos failed to
  // resolve, and a strip token belonging to a card whose `groupPositions` only
  // carry the surviving state group's positions.
  if (hover.positions.includes(pos)) return "linked";
  if (groupIdOverride) return hover.groupId === groupIdOverride ? "linked" : null;
  return pos >= 0 && ownedBy(ctx, pos - ctx.posOffset, hover.groupId) ? "linked" : null;
}

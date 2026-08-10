// Regression suite for the aligner's hover-highlight resolution
// (alignmentHover.ts). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/alignmentHover.test.mjs
//
// Why this file exists: this logic used to live inside useMemo/useCallback
// bodies in AlignmentPanel.tsx, so nothing here was reachable from the test
// runner. PR #410 shipped a real hover fix (fused cards, case 1 below) with no
// test, and its own review then caught a SECOND regression the fix introduced
// (stripped compounds, case 2). Both are locked in here.
//
// Not a test framework; failures exit non-zero. Mirrors alignment.test.mjs.

import {
  buildDisplayGroups,
  buildPosMaps,
  buildSourceIndexMap,
  buildTargetIdToGroupId,
  englishHoverKey,
  makeEnglishHover,
  makeHebrewHover,
  resolveEnglishHighlight,
  resolveHebrewHighlight,
  resolveSourcePos,
} from "./alignmentHover.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── fixtures ───────────────────────────────────────────────────────────────
// Four-token Hebrew source verse, walk positions 0..3.
const TOKENS = [
  { text: "וַיֹּאמֶר", strong: "H0559" },
  { text: "אֶל", strong: "H0413" },
  { text: "יְהוָה", strong: "H3068" },
  { text: "דָּבָר", strong: "H1697" },
];
const sourceVerse = {
  content: {
    verseObjects: TOKENS.map((t) => ({ type: "word", tag: "w", text: t.text, strong: t.strong })),
  },
};
const indexMap = buildSourceIndexMap(sourceVerse);

function src(id, tokenIdx, occurrence = "1") {
  const t = TOKENS[tokenIdx];
  return {
    id,
    strong: t.strong,
    content: t.text,
    occurrence,
    occurrences: "1",
  };
}
function tgt(id, text, occurrence = "1") {
  return { id, text, occurrence, occurrences: "1" };
}
function group(id, source, targets) {
  return { id, source, targets };
}
// buildDisplayGroups / buildPosMaps read only state.groups; the rest of
// AlignmentState is present so the shape stays honest.
function state(groups) {
  return { stream: [], sourceGroups: groups, groups, unaligned: [] };
}
function ctxFor(st, { bibleVersion = "ult", posOffset = 0, hoverLink = true } = {}) {
  const displayGroups = buildDisplayGroups(st, indexMap);
  const posMaps = buildPosMaps(st, displayGroups, indexMap);
  return {
    displayGroups,
    ctx: {
      hoverLink,
      bibleVersion,
      targetIdToGroupId: buildTargetIdToGroupId(displayGroups),
      posMaps,
      posOffset,
    },
  };
}

// ─── sanity: the index map + position resolution ────────────────────────────
{
  assert(resolveSourcePos(src("s", 0), indexMap) === 0, "first source token resolves to position 0");
  assert(resolveSourcePos(src("s", 3), indexMap) === 3, "fourth source token resolves to position 3");
  assert(
    resolveSourcePos({ id: "x", strong: "H9999", content: "nope", occurrence: "1" }, indexMap) === -1,
    "an unmatched source word resolves to -1",
  );
  assert(
    resolveSourcePos(src("s", 1, "2"), indexMap) === 1,
    "occurrence past the token count falls back to the first instance (occurrence data is not trustworthy)",
  );
}

// ─── 1. fused cards: every folded-away group's targets carry the SURVIVOR id ─
// PR #410. mergeAdjacentSameSource keeps only the survivor's group id, so
// building targetIdToGroupId from the stream's `alignedTo` left the eaten
// group's words pointing at an id no card and no position map knows —
// hovering the Hebrew lit the card's chips but not those words' inventory
// chips. The bigger the split alignment, the more chips went dark.
{
  const a = group("g-a", [src("sa", 1)], [tgt("t1", "to")]);
  const b = group("g-b", [src("sb", 1)], [tgt("t2", "him")]);
  const st = state([a, b]);
  const { displayGroups, ctx } = ctxFor(st);
  assert(displayGroups.length === 1, "two same-source groups render as ONE fused card");
  const survivor = displayGroups[0].id;
  assert(
    ctx.targetIdToGroupId.get("t1") === survivor && ctx.targetIdToGroupId.get("t2") === survivor,
    `both fused groups' targets resolve to the survivor's display id (${survivor})`,
  );
  // The behavioral consequence: hovering the Hebrew lights BOTH words.
  const hover = makeHebrewHover(ctx, 1);
  assert(
    resolveEnglishHighlight(ctx, hover, "t1", "to", "1") === "linked" &&
      resolveEnglishHighlight(ctx, hover, "t2", "him", "1") === "linked",
    "hovering the fused card's Hebrew links every folded-in target word",
  );
}
// Same claim for the other fold path: mergeSamePositionGroups collapses groups
// whose source words resolve to the same POSITION even when their occurrence
// numbers differ (an AI over-count: occ 1 and occ 2 of a once-present token).
{
  const a = group("g-a", [src("sa", 2, "1")], [tgt("t1", "Yahweh")]);
  const b = group("g-b", [src("sb", 2, "2")], [tgt("t2", "the")]);
  const st = state([a, b]);
  const { displayGroups, ctx } = ctxFor(st);
  assert(displayGroups.length === 1, "same-position duplicate groups render as ONE card");
  const survivor = displayGroups[0].id;
  assert(
    ctx.targetIdToGroupId.get("t1") === survivor && ctx.targetIdToGroupId.get("t2") === survivor,
    "same-position-collapsed groups' targets resolve to the survivor's display id",
  );
  const hover = makeHebrewHover(ctx, 2);
  assert(
    resolveEnglishHighlight(ctx, hover, "t2", "the", "1") === "linked",
    "hovering the collapsed card's Hebrew links the eaten group's target word",
  );
}

// ─── 2. a PARTLY-overlapping compound keeps its flagged word (AMO 3:2 UST) ──
// The reused-source-token marker has to be VISIBLE. stripCompoundOverlaps used
// to narrow a compound's rendered chain whenever only SOME of its words
// overlapped a standalone (`kept.length` neither 0 nor the full length), and
// AlignmentPanel maps chips off the DISPLAY group — so the flagged chip was
// never drawn. AMO 3:2 UST (compound [עַל, כֵּן, אֶפְקֹד] plus a standalone
// אֶפְקֹד) sat in the api-side "Reused source token" feed while the card looked
// clean, whereas AMO 3:7 UST (compound [אֶל, עֲבָדָיו], BOTH overlapped, so the
// `kept.length === 0` escape hatch fired) rendered the same defect plainly.
// Visibility must not depend on compound arity: flagged words are exempt from
// the strip. The fixture below is the 2-word version of the 3:2 shape — one of
// two words overlaps, so the old code stripped it.
//
// This case also still pins what PR #410's review caught and reverted:
// groupPositions must stay STATE-derived, so a word the strip DOES remove (the
// empty-x-content path that survives the exemption) keeps its position in the
// compound's union and does not go dark on hover.
{
  const standalone = group("g-std", [src("s-std", 1)], [tgt("t-std", "to")]);
  // Compound over the same אֶל plus יְהוָה — only אֶל overlaps the standalone.
  const compound = group("g-cmp", [src("s-c1", 1), src("s-c2", 2)], [tgt("t-cmp", "to Yahweh")]);
  const st = state([standalone, compound]);
  const { displayGroups, ctx } = ctxFor(st);
  const rendered = displayGroups.find((g) => g.id === "g-cmp");
  assert(
    rendered.source.length === 2 &&
      rendered.source.some((s) => s.id === "s-c1") &&
      rendered.source.some((s) => s.id === "s-c2"),
    "the compound card RENDERS the reused word rather than having it stripped away",
  );
  assert(
    ctx.posMaps.reusedSourceIds.has("s-c1") && ctx.posMaps.reusedSourceIds.has("s-std"),
    "both copies of the reused token are flagged",
  );
  // The whole point: every flagged word has a chip to wear the red marker on.
  const renderedFlagged = new Set();
  for (const g of displayGroups)
    for (const s of g.source) if (ctx.posMaps.reusedSourceIds.has(s.id)) renderedFlagged.add(s.id);
  assert(
    renderedFlagged.size === ctx.posMaps.reusedSourceIds.size,
    `every flagged source word renders (${renderedFlagged.size}/${ctx.posMaps.reusedSourceIds.size})`,
  );
  const union = ctx.posMaps.groupPositions.get("g-cmp") ?? [];
  assert(
    union.includes(1) && union.includes(2),
    `the compound's union positions cover both its words (got [${union}])`,
  );
  // Position 1 now has TWO owners — the standalone card and the compound card
  // both honestly name that physical token (buildPositionOwners, PR #413).
  assert(
    ctx.posMaps.posOwners.get(1)?.size === 2 &&
      ctx.posMaps.posOwners.get(1).has("g-std") &&
      ctx.posMaps.posOwners.get(1).has("g-cmp"),
    "the reused position is owned by BOTH cards, so neither contradicts itself on hover",
  );
  // ...and hovering the compound's English still bridges to both Hebrew tokens.
  const hover = makeEnglishHover(ctx, "t-cmp", "to Yahweh", "1");
  assert(
    resolveHebrewHighlight(ctx, hover, 1) === "linked",
    "hovering the compound's English lights the reused Hebrew token",
  );
  assert(
    resolveHebrewHighlight(ctx, hover, 2) === "linked",
    "hovering the compound's English lights its own Hebrew token too",
  );
  assert(
    resolveHebrewHighlight(ctx, hover, 3) === null,
    "an unrelated Hebrew token does not light",
  );
}

// ─── 3. unaligned words resolve to no group ─────────────────────────────────
{
  const aligned = group("g-a", [src("sa", 0)], [tgt("t1", "said")]);
  const st = state([aligned]);
  st.unaligned = [tgt("t-free", "then")];
  const { ctx } = ctxFor(st);
  assert(
    ctx.targetIdToGroupId.get("t-free") === undefined,
    "an unaligned word has no group id",
  );
  const hover = makeHebrewHover(ctx, 0);
  assert(
    resolveEnglishHighlight(ctx, hover, "t-free", "then", "1") === null,
    "hovering Hebrew never lights an unaligned word",
  );
  const eHover = makeEnglishHover(ctx, "t-free", "then", "1");
  assert(
    eHover.groupId === null && eHover.positions.length === 0,
    "hovering an unaligned word carries no group and no source positions",
  );
  assert(
    resolveHebrewHighlight(ctx, eHover, 0) === null,
    "hovering an unaligned word lights no Hebrew",
  );
  // A group whose source words don't resolve gets no position ownership.
  const ghost = state([group("g-x", [{ id: "sx", strong: "H0", content: "zzz", occurrence: "1" }], [tgt("t-x", "x")])]);
  const { ctx: gctx } = ctxFor(ghost);
  assert(
    gctx.posMaps.posOwners.size === 0,
    "a group with no resolvable source position claims no position",
  );
}

// ─── 4. cross-panel: the english key is bibleVersion-scoped ────────────────
// `hover` is shared by both side-by-side panels. An un-scoped
// `${text}|${occurrence}` key gave the OTHER panel's same-text chip a false
// "exact" ring (hover ULT "and"(3) → UST "and"(3) lit too).
{
  const ult = state([group("g-u", [src("su", 0)], [tgt("t-u", "and", "3")])]);
  const ust = state([group("g-s", [src("ss", 3)], [tgt("t-s", "and", "3")])]);
  const { ctx: ultCtx } = ctxFor(ult, { bibleVersion: "ult" });
  const { ctx: ustCtx } = ctxFor(ust, { bibleVersion: "ust" });
  const hover = makeEnglishHover(ultCtx, "t-u", "and", "3");
  assert(
    hover.key === englishHoverKey("ult", "and", "3") && hover.key !== englishHoverKey("ust", "and", "3"),
    "the english hover key is scoped by bibleVersion",
  );
  assert(
    resolveEnglishHighlight(ultCtx, hover, "t-u", "and", "3") === "exact",
    "the hovered chip rings exact in its OWN panel",
  );
  assert(
    resolveEnglishHighlight(ustCtx, hover, "t-s", "and", "3") !== "exact",
    "the other panel's identical text/occurrence chip does NOT ring exact",
  );
  assert(
    resolveEnglishHighlight(ustCtx, hover, "t-s", "and", "3") === null,
    "...and gets no tone at all when the two don't share Hebrew",
  );
  // Cross-panel LINKING still works when they do share the Hebrew: same source
  // token, per-panel group ids, positions carried union-relative.
  const shared = state([group("g-s2", [src("ss2", 0)], [tgt("t-s2", "spoke")])]);
  const { ctx: sharedCtx } = ctxFor(shared, { bibleVersion: "ust" });
  assert(
    resolveEnglishHighlight(sharedCtx, hover, "t-s2", "spoke", "1") === "linked",
    "the other panel's word over the SAME Hebrew token links",
  );
}

// ─── 5. AMO 3:7 — a source token owned by TWO cards, through the resolvers ──
// The #413 fix, asserted at the level the panel actually calls. alignment.test.mjs
// covers buildPositionOwners / positionOwnedBy in isolation; this pins that the
// RESOLVERS honour multi-ownership, which is the part the #414 extraction could
// have silently reverted. Shape: `אֶל` alone, `יְהוָה` alone, and a compound over
// both — position sequences "1", "2", "1.2", so mergeSamePositionGroups declines
// to fuse, and stripCompoundOverlaps no-ops on the compound because stripping ALL
// of a group's source words is its escape hatch.
{
  const standaloneA = group("g-a", [src("sa", 1)], [tgt("t-a", "to")]);
  const compound = group("g-both", [src("sc1", 1), src("sc2", 2)], [tgt("t-both", "his")]);
  const standaloneB = group("g-b", [src("sb", 2)], [tgt("t-b", "Yahweh")]);
  const st = state([standaloneA, compound, standaloneB]);
  const { displayGroups, ctx } = ctxFor(st);
  assert(displayGroups.length === 3, `all three cards survive the display pipeline (got ${displayGroups.length})`);
  assert(
    ctx.posMaps.posOwners.get(1)?.size === 2,
    `position 1 keeps BOTH owners (got ${ctx.posMaps.posOwners.get(1)?.size})`,
  );
  // Hovering the STANDALONE's Hebrew must light the compound card's English too.
  // With first-wins ownership the compound failed the equality and stayed dark
  // while its Hebrew lit — one card contradicting itself.
  const hover = makeHebrewHover(ctx, 1, "g-a");
  assert(
    resolveEnglishHighlight(ctx, hover, "t-both", "his", "1") === "linked",
    "hovering the standalone's Hebrew links the compound card's English (the #413 bug)",
  );
  assert(
    resolveEnglishHighlight(ctx, hover, "t-a", "to", "1") === "linked",
    "...and still links the standalone's own English",
  );
  assert(
    resolveEnglishHighlight(ctx, hover, "t-b", "Yahweh", "1") === null,
    "a card that does not render position 1 stays dark",
  );
  // Card-side Hebrew: the compound card's own token answers to the hover.
  assert(
    resolveHebrewHighlight(ctx, hover, 2, "g-both") === "linked",
    "the compound card's other Hebrew token lights as a group sibling",
  );
  assert(
    resolveHebrewHighlight(ctx, hover, 2, "g-b") === null,
    "the unrelated standalone card's Hebrew stays dark",
  );
  // Strip-side Hebrew (no groupIdOverride): two positions sharing any card light
  // each other — the intended widening documented in resolveHebrewHighlight.
  const stripHover = makeHebrewHover(ctx, 1);
  assert(
    resolveHebrewHighlight(ctx, stripHover, 2) === "linked",
    "on the strip, a token sharing the compound card with the hovered one lights",
  );
}

// ─── 6. buildPosMaps surfaces the reused-source-token flag (#408 wiring) ────
// The red "data defect" marker the cards draw comes from posMaps.reusedSourceIds.
// The detector itself is tested in alignment.test.mjs; this pins that buildPosMaps
// actually calls it, with reusedTokenKey (exact position, never Strong's) — the
// wiring the #414 extraction moved. Shape: the ZEC 14:8 UST defect, a compound
// over both tokens PLUS a standalone for each.
{
  const compound = group("g-both", [src("sc1", 1), src("sc2", 2)], [tgt("t-both", "whole year")]);
  const soloA = group("g-a", [src("sa", 1)], [tgt("t-a", "hot season")]);
  const soloB = group("g-b", [src("sb", 2)], [tgt("t-b", "cold season")]);
  const { ctx } = ctxFor(state([compound, soloA, soloB]));
  const flagged = ctx.posMaps.reusedSourceIds;
  assert(
    flagged.size === 4 && ["sc1", "sc2", "sa", "sb"].every((id) => flagged.has(id)),
    `every source word at a reused position is flagged (got [${[...flagged]}])`,
  );
  // And a clean verse stays unflagged — the marker must not become wallpaper.
  const { ctx: clean } = ctxFor(
    state([group("g-x", [src("sx", 0)], [tgt("t-x", "said")]), group("g-y", [src("sy", 3)], [tgt("t-y", "word")])]),
  );
  assert(clean.posMaps.reusedSourceIds.size === 0, "a clean verse flags nothing");
  // Two groups sharing an IDENTICAL position sequence are the legitimate
  // one-token-to-N-target-runs split (JER 28:1), not reuse. They also fuse into
  // one card, so nothing would be marked anyway — assert the detector agrees.
  const { ctx: split } = ctxFor(
    state([group("g-s1", [src("s1", 2)], [tgt("t-s1", "spoke")]), group("g-s2", [src("s2", 2)], [tgt("t-s2", "to me")])]),
  );
  assert(split.posMaps.reusedSourceIds.size === 0, "an identical-sequence split is not reuse");
}

// ─── posOffset: hover positions travel union-relative ──────────────────────
{
  const st = state([group("g-a", [src("sa", 1)], [tgt("t1", "to")])]);
  const { ctx } = ctxFor(st, { posOffset: 10 });
  const eHover = makeEnglishHover(ctx, "t1", "to", "1");
  assert(
    eHover.positions.length === 1 && eHover.positions[0] === 11,
    `english hover positions are offset into union space (got [${eHover.positions}])`,
  );
  const hHover = makeHebrewHover(ctx, 11);
  assert(hHover.groupId === "g-a", "a union-relative Hebrew hover resolves to the own-panel group");
  assert(
    resolveHebrewHighlight(ctx, hHover, 11) === "exact",
    "the hovered Hebrew token itself rings exact",
  );
}

// ─── hoverLink off: the resolvers are inert ────────────────────────────────
{
  const st = state([group("g-a", [src("sa", 0)], [tgt("t1", "said")])]);
  const { ctx: on } = ctxFor(st);
  const { ctx: off } = ctxFor(st, { hoverLink: false });
  const hover = makeHebrewHover(on, 0);
  assert(
    resolveEnglishHighlight(off, hover, "t1", "said", "1") === null &&
      resolveHebrewHighlight(off, hover, 0) === null,
    "with hover-link off both resolvers return null",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll alignmentHover tests passed.");

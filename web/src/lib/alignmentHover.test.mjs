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

// ─── 2. stripped compounds: the removed word's position stays in the union ──
// The regression PR #410's review caught and reverted. stripCompoundOverlaps
// narrows the compound's RENDERED chain, but the source word is still bound to
// it, so groupPositions must stay STATE-derived — recomputing the union from the
// card's narrowed chain takes the stripped token dark on hover.
{
  const standalone = group("g-std", [src("s-std", 1)], [tgt("t-std", "to")]);
  // Compound over the same אֶל plus יְהוָה — strip drops אֶל from its chain.
  const compound = group("g-cmp", [src("s-c1", 1), src("s-c2", 2)], [tgt("t-cmp", "to Yahweh")]);
  const st = state([standalone, compound]);
  const { displayGroups, ctx } = ctxFor(st);
  const rendered = displayGroups.find((g) => g.id === "g-cmp");
  assert(
    rendered.source.length === 1 && rendered.source[0].id === "s-c2",
    "stripCompoundOverlaps narrows the compound's rendered chain to the non-overlapping word",
  );
  const union = ctx.posMaps.groupPositions.get("g-cmp") ?? [];
  assert(
    union.includes(1) && union.includes(2),
    `the compound's union positions still include the STRIPPED word's position (got [${union}])`,
  );
  // Position 1 is owned by the standalone card (posToGroupId is
  // display-derived, so the stripped token cannot steal the card).
  assert(
    ctx.posMaps.posToGroupId.get(1) === "g-std",
    "the stripped position is owned by the standalone card, not the compound",
  );
  // ...and hovering the compound's English still bridges to that Hebrew token.
  const hover = makeEnglishHover(ctx, "t-cmp", "to Yahweh", "1");
  assert(
    resolveHebrewHighlight(ctx, hover, 1) === "linked",
    "hovering the compound's English still lights the stripped Hebrew token",
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
    gctx.posMaps.posToGroupId.size === 0,
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

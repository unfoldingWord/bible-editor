// Issue #777 / #778 — opening punctuation trapped in an alignment milestone.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/openingPunct.test.mjs

import { findOpeningPunctInAlignment, hoistOpeningPunctuation, OPENING_PUNCT_CHARS } from "./openingPunct.ts";
import { curlifyVerseObjects, recomputeTargetOccurrences, extractPlainText } from "./importParsers.ts";

let failed = 0;
function assert(ok, msg) {
  if (!ok) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("  ok:", msg);
  }
}

const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: strong, children, endTag: "zaln-e\\*",
});

// Concatenated raw text of a tree — the invariant the hoist must never break.
const raw = (nodes) => {
  let s = "";
  const walk = (arr) => {
    for (const n of arr ?? []) {
      if (!n || typeof n !== "object") continue;
      if (typeof n.text === "string") s += n.text;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(nodes);
  return s;
};

// Compact shape dump, so a failure prints something readable.
const shape = (nodes) =>
  JSON.stringify(nodes.map(function f(n) {
    if (Array.isArray(n.children)) return `[${n.strong} ${n.children.map(f).join("|")}]`;
    if (n.tag === "w") return `w(${n.text})`;
    if (n.type === "text") return `t(${JSON.stringify(n.text)})`;
    return `<${n.tag}>`;
  }));

// ─── 1. The JER 31:10 shape: `, ‘` trailing INSIDE the milestone ─────────────
// This is what a bible-editor gap relayout produces and what Door43 renders as
// `say, ‘ The one…`.
{
  console.log("\n[1] `, ‘` trailing a milestone that another milestone follows is hoisted out");
  const vos = [
    zaln("H0559", [w("and"), t(" "), w("say"), t(", ‘")]),
    zaln("H6908", [w("The"), t(" "), w("one")]),
    t("."),
  ];
  const found = findOpeningPunctInAlignment(vos);
  assert(found.length === 1, `detected once (got ${found.length})`);
  assert(found[0].index === 0 && found[0].text === ", ‘", `finding names the milestone and the run (got ${JSON.stringify(found[0])})`);

  const out = hoistOpeningPunctuation(vos);
  assert(out !== vos, "returns a new array when it acted");
  assert(raw(out) === raw(vos), `raw text is unchanged (${JSON.stringify(raw(out))} vs ${JSON.stringify(raw(vos))})`);
  assert(
    shape(out) === shape([zaln("H0559", [w("and"), t(" "), w("say")]), t(", ‘"), zaln("H6908", [w("The"), t(" "), w("one")]), t(".")]),
    `the whole gap sits between the two milestones (got ${shape(out)})`,
  );
  assert(findOpeningPunctInAlignment(out).length === 0, "the repaired tree no longer trips detection (idempotent)");
  assert(hoistOpeningPunctuation(out) === out, "a second pass is a no-op and returns the same array");
  // The input must not have been mutated — callers may still hold it.
  assert(
    shape(vos) === shape([zaln("H0559", [w("and"), t(" "), w("say"), t(", ‘")]), zaln("H6908", [w("The"), t(" "), w("one")]), t(".")]),
    `the caller's array is left untouched (got ${shape(vos)})`,
  );
}

// ─── 2. Nested (compound) milestones — the trailing text is deep ─────────────
{
  console.log("\n[2] Trailing text inside a NESTED milestone hoists to the TOP level");
  const vos = [
    zaln("H1", [zaln("H2", [w("say"), t(", ‘")])]),
    zaln("H3", [w("The")]),
  ];
  const out = hoistOpeningPunctuation(vos);
  assert(raw(out) === "say, ‘The", `raw text preserved (got ${JSON.stringify(raw(out))})`);
  assert(out.length === 3 && out[1].type === "text" && out[1].text === ", ‘",
    `hoisted to a TOP-LEVEL sibling, not merely one level up (got ${shape(out)})`);
  assert(out[0].children[0].children.length === 1, `the inner milestone keeps only its word (got ${shape(out)})`);
}

// ─── 3. Closing-only trailing text is LEFT ALONE ─────────────────────────────
// `\w*, \zaln-e\*\n\zaln-s` renders correctly — the newline IS the inter-word
// space. Only an opening bracket puts the space on the wrong side.
{
  console.log("\n[3] Closing-only trailing punctuation is not touched");
  for (const tail of [", ", ".", "; ", "”", ")"]) {
    const vos = [zaln("H1", [w("say"), t(tail)]), zaln("H2", [w("The")])];
    assert(findOpeningPunctInAlignment(vos).length === 0, `trailing ${JSON.stringify(tail)} is not a finding`);
    assert(hoistOpeningPunctuation(vos) === vos, `trailing ${JSON.stringify(tail)} returns the input untouched`);
  }
}

// ─── 4. Only an ADJACENT milestone pair is the defect ────────────────────────
// With anything between the two milestones usfm-js emits no newline, so the
// verse already renders correctly and must not be churned. A following in-flow
// marker is excluded by the same rule: that line break — and the punctuation
// around it — belongs to reconcileMarkers in the web edit engine.
{
  console.log("\n[4] Only a milestone→milestone pair is flagged");
  const trailing = [w("say"), t(", ‘")];
  const cases = [
    ["followed by a bare text node", [zaln("H1", [...trailing]), t(" "), zaln("H2", [w("The")])]],
    ["followed by a bare \\w", [zaln("H1", [...trailing]), w("The")]],
    ["followed by a \\q marker", [zaln("H1", [...trailing]), { tag: "q1", type: "quote" }, zaln("H2", [w("The")])]],
    ["last node in the verse", [zaln("H1", [...trailing])]],
  ];
  for (const [label, vos] of cases) {
    assert(findOpeningPunctInAlignment(vos).length === 0, `${label}: not a finding`);
    assert(hoistOpeningPunctuation(vos) === vos, `${label}: untouched`);
  }
}

// ─── 5. A text-bearing node after the last word aborts the hoist ─────────────
// usfm-js parks post-marker text on the MARKER node. Moving a marker is not
// this module's job, so such a milestone is left for the marker code.
{
  console.log("\n[5] A text-bearing non-text node after the last word aborts the hoist");
  const vos = [
    zaln("H1", [w("say"), t(", "), { tag: "q1", type: "quote", text: "‘" }]),
    zaln("H2", [w("The")]),
  ];
  assert(findOpeningPunctInAlignment(vos).length === 0, "not a finding — the opener rides a marker node");
  assert(hoistOpeningPunctuation(vos) === vos, "untouched");
}

// ─── 6. A milestone with no \w at all is left to pruneDeadMilestones ─────────
{
  console.log("\n[6] A wordless milestone is not this module's problem");
  const vos = [zaln("H1", [t("‘")]), zaln("H2", [w("The")])];
  assert(findOpeningPunctInAlignment(vos).length === 0, "not a finding");
  assert(hoistOpeningPunctuation(vos) === vos, "untouched");
}

// ─── 7. Every opening character in the set, and several per verse ────────────
{
  console.log("\n[7] Every opening character is recognised, and multiple sites repair in one pass");
  for (const ch of OPENING_PUNCT_CHARS) {
    const vos = [zaln("H1", [w("say"), t(`, ${ch}`)]), zaln("H2", [w("The")])];
    assert(findOpeningPunctInAlignment(vos).length === 1, `${JSON.stringify(ch)} is an opening character`);
  }
  const vos = [
    zaln("H1", [w("say"), t(", ‘")]),
    zaln("H2", [w("The"), t(" ("), ]),
    zaln("H3", [w("one")]),
    t("."),
  ];
  const out = hoistOpeningPunctuation(vos);
  assert(raw(out) === raw(vos), `raw text preserved across two repairs (got ${JSON.stringify(raw(out))})`);
  assert(findOpeningPunctInAlignment(out).length === 0, `both sites repaired in one pass (got ${shape(out)})`);
}

// ─── 8. Nothing to do → the SAME array reference comes back ──────────────────
// hoistOpeningPunctuation runs on every pipeline verse and every in-app save,
// so the clean path must not clone.
{
  console.log("\n[8] A clean verse is returned by reference (no clone on the hot path)");
  const vos = [zaln("H1", [w("say"), t(", ")]), t("‘"), zaln("H2", [w("The")]), t(".")];
  assert(hoistOpeningPunctuation(vos) === vos, "same array reference");
  assert(hoistOpeningPunctuation([]) !== undefined, "empty verse does not throw");
  assert(hoistOpeningPunctuation(undefined) === undefined, "a non-array is passed straight through");
}

// ─── 9. The pipelineImport self-heal chain order (#778) ──────────────────────
// applyVerseUpdate runs curlifyVerseObjects → hoistOpeningPunctuation →
// recomputeTargetOccurrences. Curling only ever swaps a straight quote for its
// curly form IN PLACE, so running the hoist AFTER it means the hoist's
// opening-bracket test sees the final characters; running it before would still
// work for a straight `'` (it is in the set) but would be relying on the set
// rather than on the order, so pin the order that the chain actually uses.
{
  console.log("\n[9] The self-heal chain: curlify → hoist → recompute");
  const verseObjects = [
    zaln("H1", [w("and"), t(" "), w("say"), t(", '")]),
    zaln("H2", [w("The"), t(" "), w("one")]),
    t("."),
  ];
  const before = raw(verseObjects);
  curlifyVerseObjects(verseObjects);
  assert(raw(verseObjects) === before.replace(", '", ", ‘"), `curling turns the straight quote curly in place (got ${JSON.stringify(raw(verseObjects))})`);
  const healed = hoistOpeningPunctuation(verseObjects);
  assert(
    healed.length === 4 && healed[1].type === "text" && healed[1].text === ", ‘",
    `the curled opener is stored as a TOP-LEVEL text node between the milestones (got ${shape(healed)})`,
  );
  // The hoist is raw-text preserving, so the plain_text applyVerseUpdate
  // re-derives after the chain is unaffected by it, and occurrence numbering
  // (which keys on `\w` text, not on text nodes) is untouched.
  assert(raw(healed) === raw(verseObjects), "raw text survives the hoist");
  assert(extractPlainText({ verseObjects: healed }) === "and say, ‘The one.",
    `plain_text reads as written (got ${JSON.stringify(extractPlainText({ verseObjects: healed }))})`);
  recomputeTargetOccurrences(healed);
  assert(
    healed[0].children.filter((n) => n.tag === "w").every((n) => n.occurrences === "1"),
    "recompute still sees every word after the hoist",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll openingPunct tests passed.");

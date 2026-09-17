// Unit tests for openingPunct.ts: hasOpeningPunctInsideMilestone (the lint
// detector) and hoistOpeningPunctuation (the #778 mirror wired into
// pipelineImport.ts's ULT/UST self-heal chain). Run from api/:
//   node --experimental-strip-types --no-warnings src/openingPunct.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { hasOpeningPunctInsideMilestone, hoistOpeningPunctuation } from "./openingPunct.ts";
import { curlifyVerseObjects, recomputeTargetOccurrences, extractPlainText } from "./importParsers.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (children) => ({ tag: "zaln", type: "milestone", content: "x", children, endTag: "zaln-e\\*" });

console.log("[hasOpeningPunctInsideMilestone]");

assert(
  hasOpeningPunctInsideMilestone([zaln([w("himself"), t(", ‘")]), zaln([w("You")])]) === true,
  "flags a milestone whose trailing text (after its last \\w) contains an opening quote",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([w("Judah"), t(", ")]), zaln([w("Er")])]) === false,
  "does not flag trailing closing punctuation without an opener",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([w("say")]), t(", "), zaln([t("‘"), w("The")])]) === false,
  "does not flag an opener already stored as the leading child of the FOLLOWING milestone",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([zaln([w("say"), t(", ‘")])])]) === true,
  "flags a nested milestone chain — the opener trails the outer chain's last word",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([])]) === false,
  "a milestone with no word leaf at all is not flagged",
);

assert(
  hasOpeningPunctInsideMilestone([zaln([zaln([w("say"), t(", ‘")]), zaln([w("The")])])]) === true,
  "flags an INNER milestone's own trailing opener even when a LATER sibling milestone's word masks it at the outer level (F5)",
);

assert(hasOpeningPunctInsideMilestone([]) === false, "an empty verse is not flagged");
assert(hasOpeningPunctInsideMilestone([t("plain text only")]) === false, "a verse with no milestones is not flagged");

// ─── hoistOpeningPunctuation (#778 mirror) ──────────────────────────────────

// Concatenated raw text of a tree — the invariant the hoist must never break
// (it may relocate WHITESPACE across a sibling boundary, but never a
// non-space character).
function raw(nodes) {
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
}

console.log("\n[hoistOpeningPunctuation]");

{
  // The JER 31:10 shape: `, ‘` trailing INSIDE the milestone before another
  // milestone — what a bible-editor gap relayout produces and what Door43
  // renders as `say, ‘ The one…`.
  const vos = [
    zaln([w("and"), t(" "), w("say"), t(", ‘")]),
    zaln([w("The"), t(" "), w("one")]),
    t("."),
  ];
  const out = hoistOpeningPunctuation(vos);
  assert(raw(out) === raw(vos), `raw text unchanged (${JSON.stringify(raw(out))} vs ${JSON.stringify(raw(vos))})`);
  assert(hasOpeningPunctInsideMilestone(vos) === true, "precondition: the input trips the detector");
  assert(hasOpeningPunctInsideMilestone(out) === false, "the hoisted tree no longer trips the detector (idempotent target)");
  assert(
    out.length === 4 && out[0].children.length === 3 && out[1].type === "text" && out[1].text === ", ‘" && out[2].tag === "zaln" && out[3].text === ".",
    `the whole gap sits between the two milestones as a top-level text node (got ${JSON.stringify(out)})`,
  );
  assert(JSON.stringify(vos) === JSON.stringify([zaln([w("and"), t(" "), w("say"), t(", ‘")]), zaln([w("The"), t(" "), w("one")]), t(".")]), "the caller's input array is not mutated");
  const again = hoistOpeningPunctuation(out);
  assert(raw(again) === raw(out) && hasOpeningPunctInsideMilestone(again) === false, "a second pass is idempotent");
}

{
  // Closing-only trailing punctuation renders correctly as-is (the newline IS
  // the inter-word space) — must not be touched.
  for (const tail of [", ", ".", "; ", "”", ")"]) {
    const vos = [zaln([w("say"), t(tail)]), zaln([w("The")])];
    const out = hoistOpeningPunctuation(vos);
    assert(JSON.stringify(out) === JSON.stringify(vos), `trailing ${JSON.stringify(tail)} is left untouched`);
  }
}

{
  // The ONLY guard is a following in-flow marker (\q1/\p/...): the hoist runs
  // unconditionally otherwise — a bare \w, or nothing at all, following the
  // milestone still gets the opener moved to a top-level text node right
  // after it. Confirmed byte-for-byte against the real web/src/lib/
  // openingPunct.ts implementation this mirrors.
  const trailing = [w("say"), t(", ‘")];

  {
    const vos = [zaln([...trailing]), { type: "quote", tag: "q1" }, zaln([w("The")])];
    const out = hoistOpeningPunctuation(vos);
    assert(JSON.stringify(out) === JSON.stringify(vos), "followed by a \\q1 line marker: untouched (the guard)");
  }
  {
    const vos = [zaln([...trailing]), w("The")];
    const out = hoistOpeningPunctuation(vos);
    assert(
      out.length === 3 && out[1].type === "text" && out[1].text === ", ‘" && out[2].tag === "w" && out[2].text === "The",
      `followed by a bare \\w: still hoisted to a top-level text node (got ${JSON.stringify(out)})`,
    );
  }
  {
    const vos = [zaln([...trailing])];
    const out = hoistOpeningPunctuation(vos);
    assert(
      out.length === 2 && out[1].type === "text" && out[1].text === ", ‘",
      `last node in the verse: still hoisted, appended as a new top-level text node (got ${JSON.stringify(out)})`,
    );
  }
}

{
  // A structural newline stored as its own text node between the two
  // milestones must not swallow the opener behind it — the opener steps over
  // the newline's leading whitespace so it stays glued to the next \zaln-s.
  const vos = [zaln([w("himself"), t(", ‘")]), t("\n"), zaln([w("You")])];
  const out = hoistOpeningPunctuation(vos);
  // Every non-space character survives, in order; the redundant space before
  // the newline is deliberately dropped (F3, accepted in #779's cold review:
  // "the hoist deletes the stray space after an opener on any save — that IS
  // the visible defect"), so exact byte-for-byte raw-text equality does not
  // hold across this glue path specifically.
  assert(raw(out).replace(/\s+/gu, "") === raw(vos).replace(/\s+/gu, ""), "every non-space character survives in order");
  assert(out[1].text === ",\n‘", `the closing comma, the stored newline, and the opener share one text node in that order (got ${JSON.stringify(out[1])})`);
  assert(!/‘\s+[A-Za-z]/.test(out.map((n) => n.text ?? "").join("")), "no space is left between the opener and the following word once concatenated");
}

{
  // A character wrapper (\qs) holds content, not a line break — it is NOT a
  // guard against hoisting, unlike a real line marker (\q1/\p/...).
  const vos = [zaln([w("say"), t(", ‘")]), { type: "quote", tag: "qs", endTag: "qs*", children: [w("Selah")] }, zaln([w("The")])];
  const out = hoistOpeningPunctuation(vos);
  assert(hasOpeningPunctInsideMilestone(out) === false, "hoists through a \\qs character wrapper");
}

{
  // Nested (compound) milestones: the trailing text is deep, and must hoist
  // to the TOP level of the whole verseObjects array, not merely one level up.
  const vos = [zaln([zaln([w("say"), t(", ‘")])]), zaln([w("The")])];
  const out = hoistOpeningPunctuation(vos);
  assert(raw(out) === "say, ‘The", `raw text preserved (got ${JSON.stringify(raw(out))})`);
  assert(out.length === 3 && out[1].type === "text" && out[1].text === ", ‘", `hoisted to a TOP-LEVEL sibling (got ${JSON.stringify(out)})`);
}

{
  // The pipelineImport self-heal chain order (#778): curlify -> hoist ->
  // recompute. Curling only ever swaps a straight quote for its curly form IN
  // PLACE, so running the hoist AFTER it means the hoist's opening-bracket
  // test sees the FINAL characters.
  const verseObjects = [
    zaln([w("and"), t(" "), w("say"), t(", '")]),
    zaln([w("The"), t(" "), w("one")]),
    t("."),
  ];
  const before = raw(verseObjects);
  curlifyVerseObjects(verseObjects);
  assert(raw(verseObjects) === before.replace(", '", ", ‘"), `curling turns the straight quote curly in place (got ${JSON.stringify(raw(verseObjects))})`);
  const healed = hoistOpeningPunctuation(verseObjects);
  assert(
    healed.length === 4 && healed[1].type === "text" && healed[1].text === ", ‘",
    `the curled opener is stored as a TOP-LEVEL text node between the milestones (got ${JSON.stringify(healed)})`,
  );
  assert(raw(healed) === raw(verseObjects), "raw text survives the hoist");
  assert(
    extractPlainText({ verseObjects: healed }) === "and say, ‘The one.",
    `plain_text reads as written (got ${JSON.stringify(extractPlainText({ verseObjects: healed }))})`,
  );
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
console.log("\nAll openingPunct (api) tests passed.");

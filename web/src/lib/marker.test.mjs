// Consistency + regression tests for USFM paragraph/poetry marker handling.
// Guards issue #702: paragraph/formatting markers (e.g. `\pmo`) must be
// recognized as FORMATTING, never re-tokenized into an alignable `\w` word
// on the edit round-trip.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/marker.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import { PARAGRAPH_TAGS, isInFlowMarker, extractEditableText } from "./usfm.ts";
import { tokenizeEditableText } from "./replace.ts";
import { paragraphClass } from "./highlight.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// A word node (draggable alignment target) whose text is exactly the marker
// tag is the bug signature: the marker leaked through as a word.
function isWordNode(n) {
  return n && typeof n === "object" && n.type === "word" && n.tag === "w";
}
function isMarkerNode(n, tag) {
  return n && typeof n === "object" && n.tag === tag && (n.type === "paragraph" || n.type === "quote");
}

// ── 1. Drift lock: EVERY canonical paragraph tag is recognized by the
//       recognizer (MARKER_TOKEN_RE, via tokenizeEditableText) as a marker,
//       and none leaks through as a `\w` word. This is the assertion that
//       would have caught the missing `\pmo`/`\pm`/`\pmc` before ship.
for (const tag of PARAGRAPH_TAGS) {
  const nodes = tokenizeEditableText(`\\${tag} some words here`);
  const markerHit = nodes.some((n) => isMarkerNode(n, tag));
  const leakedAsWord = nodes.some((n) => isWordNode(n) && n.text === tag);
  assert(markerHit, `\\${tag} tokenizes to a {tag:"${tag}"} marker node`);
  assert(!leakedAsWord, `\\${tag} does NOT leak through as a \\w word "${tag}"`);
}

// ── 2. The p-family marker LEADS its segment — it is the first node the
//       recognizer emits, ahead of the following word, so the marker never
//       fuses with or trails behind verse text. Guards the reported family
//       specifically (#702). `\pmo` must resolve to `pmo`, not `p` + "mo…".
for (const tag of ["pmo", "pmc", "pmr", "pm", "po", "pr", "cls"]) {
  const nodes = tokenizeEditableText(`\\${tag} word`);
  assert(isMarkerNode(nodes[0], tag), `\\${tag} recognized as the leading marker (p-family, #702)`);
}

// ── 3. Display-path sanity: isInFlowMarker (type-based, not tag-gated) accepts
//       a clean p-family node, so the renderer emits a block break for it. This
//       documents the contract; the drift GUARD for display is paragraphClass
//       (§5) — isInFlowMarker keys off type alone and can't detect a missing tag.
for (const tag of ["pm", "pmo", "pmc", "pmr", "po", "pr", "cls"]) {
  assert(isInFlowMarker({ type: "paragraph", tag }), `isInFlowMarker({type:"paragraph",tag:"${tag}"})`);
}

// ── 4. Regression for the exact #702 shape: a verse whose body carries a
//       clean `\pmo` node round-trips through the editable representation
//       WITHOUT the marker becoming a draggable word.
const verseObjects = [
  { type: "text", text: "Some words here.\n" },
  { tag: "pmo", nextChar: "\n", type: "paragraph" },
  { type: "text", text: "And embedded text.\n" },
];
const editable = extractEditableText(verseObjects);
assert(editable.includes("\\pmo"), `editable text surfaces the \\pmo token (got: ${JSON.stringify(editable)})`);
const reparsed = tokenizeEditableText(editable);
assert(
  reparsed.some((n) => isMarkerNode(n, "pmo")),
  "\\pmo survives the edit round-trip as a paragraph marker",
);
assert(
  !reparsed.some((n) => isWordNode(n) && n.text === "pmo"),
  "\\pmo does NOT come back as a draggable \\w word (the #702 bug)",
);

// ── 5. paragraphClass gives the p-family sensible (non-word) block styling.
assert(paragraphClass("pmo").wrapper === "be-para be-pm", "\\pmo → be-para be-pm");
assert(paragraphClass("pmc").wrapper === "be-para be-pm", "\\pmc → be-para be-pm");
assert(paragraphClass("pmr").wrapper === "be-para be-pmr", "\\pmr → be-para be-pmr");
assert(paragraphClass("pr").wrapper === "be-para be-pr", "\\pr → be-para be-pr");
assert(paragraphClass("cls").wrapper === "be-para be-pr", "\\cls → be-para be-pr");
assert(paragraphClass("po").wrapper === "be-para be-p", "\\po → default paragraph (be-para be-p)");

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nmarker.test.mjs: all assertions passed.");

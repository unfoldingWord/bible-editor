// Consistency + regression tests for USFM paragraph/poetry marker handling.
// Guards issue #702: paragraph/formatting markers (e.g. `\pmo`) must be
// recognized as FORMATTING, never re-tokenized into an alignable `\w` word
// on the edit round-trip.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/marker.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import {
  PARAGRAPH_TAGS,
  isInFlowMarker,
  extractEditableText,
  extractPlainText,
  splitSectionHeaders,
  isHeaderLabelNode,
  HEADER_LABEL_TAGS,
} from "./usfm.ts";
import { tokenizeEditableText } from "./replace.ts";
import { paragraphClass } from "./highlight.ts";
import { toJSON, toUSFM } from "usfm-js";

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

// ── 6. Header/reference/label family (#710): \sp \sr \r \cl. usfm-js parses
//       these WITHOUT a `type` field — unlike \s1-\s4, which are
//       `type:"section"`. \sp parks its label on `text` (matching a line
//       marker's same-line-text shape); \sr/\r/\cl park it on `content`
//       (matching \s1's shape). Build fixtures with usfm-js itself so the
//       node shapes are exactly what real corpus data produces, not a
//       hand-guessed approximation.
for (const tag of HEADER_LABEL_TAGS) {
  const usfm = `\\c 1\n\\v 1 First verse.\n\\${tag} Some Label\n\\v 2 Second verse.`;
  const parsed = toJSON(usfm);
  const v1 = parsed.chapters["1"]["1"].verseObjects;
  const labelNode = v1[v1.length - 1];
  assert(labelNode && labelNode.tag === tag, `\\${tag} fixture: usfm-js parks it at the tail of v1 (got ${JSON.stringify(labelNode)})`);
  assert(labelNode.type === undefined, `\\${tag} fixture: usfm-js gives it no "type" field`);

  assert(isHeaderLabelNode(labelNode), `isHeaderLabelNode recognizes \\${tag}`);

  const { sections, body } = splitSectionHeaders(v1);
  assert(
    sections.length === 1 && sections[0].tag === tag && sections[0].text === "Some Label",
    `splitSectionHeaders hoists \\${tag} into the header band (got ${JSON.stringify(sections)})`,
  );
  assert(!body.includes(labelNode), `splitSectionHeaders' body drops the \\${tag} node`);

  const editable = extractEditableText(v1);
  assert(!editable.includes("Some Label"), `extractEditableText excludes \\${tag}'s label text (got: ${JSON.stringify(editable)})`);
  assert(!editable.includes(`\\${tag}`), `extractEditableText excludes the literal \\${tag} token (got: ${JSON.stringify(editable)})`);

  const plain = extractPlainText(v1);
  assert(!plain.includes("Some Label"), `extractPlainText excludes \\${tag}'s label text (got: ${JSON.stringify(plain)})`);

  // The #710 failure mode: the label text re-tokenized into draggable \w
  // words ("Some", "Label") on the edit round-trip.
  const reparsed = tokenizeEditableText(editable);
  assert(
    !reparsed.some((n) => isWordNode(n) && (n.text === "Some" || n.text === "Label")),
    `\\${tag}'s label does NOT leak through the edit round-trip as a \\w word`,
  );

  // splitSectionHeaders only ever FILTERS — it never mutates or clones a
  // node — so recombining body + the untouched original label node
  // reproduces the exact source verse, and usfm-js re-serializes it
  // byte-identical to the input. Confirms no export-time loss end-to-end.
  const recombined = { ...parsed, chapters: { ...parsed.chapters, "1": { ...parsed.chapters["1"], "1": { verseObjects: [...body, labelNode] } } } };
  assert(toUSFM(recombined).trim() === usfm.trim(), `\\${tag} round-trips losslessly through usfm-js export (got: ${JSON.stringify(toUSFM(recombined))})`);
}

// ── 7. \d (Psalm superscription) is `type:"section"` but is deliberately
//       EXCLUDED from the header-label treatment — its text IS alignable
//       Hebrew and must stay in the verse body / plain text.
{
  const dNode = { type: "section", tag: "d", text: "A psalm of David." };
  assert(!isHeaderLabelNode(dNode), "\\d (Psalm title) is NOT a header-label node");
  const plain = extractPlainText([dNode]);
  assert(plain === "A psalm of David.", `extractPlainText still includes \\d's text (got: ${JSON.stringify(plain)})`);
}

// ── 8. \s5 (legacy chunk marker) must NOT be swept into the header-label
//       treatment alongside \s1 — it is a chunk BOUNDARY, not a label, and
//       usfm-js also gives it no text/content in the common case. Guards
//       against exactly the mis-bucketing #710 warns about.
{
  const usfm = "\\c 1\n\\v 1 First verse.\n\\s5\n\\v 2 Second verse.";
  const v1 = toJSON(usfm).chapters["1"]["1"].verseObjects;
  const s5Node = v1[v1.length - 1];
  assert(s5Node && s5Node.tag === "s5", `\\s5 fixture shape (got ${JSON.stringify(s5Node)})`);
  assert(!isHeaderLabelNode(s5Node), "\\s5 is NOT recognized as a header-label node");
  assert(!HEADER_LABEL_TAGS.has("s5"), "HEADER_LABEL_TAGS does not include s5");
  const { sections } = splitSectionHeaders(v1);
  assert(sections.length === 0, `\\s5 is not hoisted into the header band (got ${JSON.stringify(sections)})`);
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nmarker.test.mjs: all assertions passed.");

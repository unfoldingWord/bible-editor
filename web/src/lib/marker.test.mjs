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
  ACROSTIC_HEADING_TAGS,
  isInFlowMarker,
  isAcrosticHeading,
  extractEditableText,
  extractTrailingMarkers,
  liftMarkerText,
} from "./usfm.ts";
import { tokenizeEditableText, smartEditVerse } from "./replace.ts";
import { paragraphClass } from "./highlight.ts";
import { renderHighlightedHTML, renderEditableHTML } from "./highlight.ts";

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

// ── 6. \qa acrostic headings (#708). usfm-js parses `\qa Aleph` as
//       {tag:"qa", type:"quote", text:"Aleph"} — same type as a `\q1` poetry
//       LINE, but its text is a heading LABEL. It must round-trip intact while
//       NEVER becoming a draggable `\w` word, and must NOT be a canonical
//       paragraph tag (its text is not alignable verse body).
assert(!PARAGRAPH_TAGS.has("qa"), "\\qa is NOT in PARAGRAPH_TAGS (its label is not alignable body)");
assert(ACROSTIC_HEADING_TAGS.has("qa") && isAcrosticHeading({ tag: "qa", type: "quote" }), "isAcrosticHeading recognizes \\qa");

// liftMarkerText moves the label from `text` to `content` (invisible to the
// word/diff walkers — the shape that keeps it out of the alignable stream),
// keeping `type:"quote"` so the heading still drifts.
{
  const lifted = liftMarkerText([{ tag: "qa", type: "quote", text: "Aleph\n" }]);
  assert(lifted.length === 1, "\\qa lift does NOT split its label into a sibling text node");
  assert(lifted[0].content === "Aleph" && lifted[0].text === undefined, "\\qa label moves text → content on lift");
  assert(lifted[0].type === "quote", "\\qa keeps type:quote after lift (still drifts)");
}

// The edit baseline skips the heading entirely: neither `\qa` nor its label
// enters the editable text, so tokenizing that baseline yields no qa/Aleph word.
const qaVerse = [
  { tag: "qa", type: "quote", text: "Aleph\n" },
  { tag: "q1", type: "quote", text: "" },
  { type: "text", text: "Blessed are those\n" },
];
const qaEditable = extractEditableText(qaVerse);
assert(!/qa|Aleph/.test(qaEditable), `\\qa + label absent from edit baseline (got: ${JSON.stringify(qaEditable)})`);
const qaTokens = tokenizeEditableText(qaEditable);
assert(
  !qaTokens.some((n) => isWordNode(n) && (n.text === "qa" || n.text === "Aleph")),
  "neither \\qa nor its \"Aleph\" label is minted as a draggable \\w word (#708)",
);

// Rendering: the READ view shows the heading label; the EDITABLE render omits
// it (so the contenteditable capture — plain textContent — can't carry it).
const qaDisplay = renderHighlightedHTML(qaVerse, new Set());
const qaEdit = renderEditableHTML(qaVerse, new Set());
assert(/be-qa"[^>]*>Aleph/.test(qaDisplay), "read view renders \\qa as a be-qa heading label");
assert(!/Aleph/.test(qaEdit), "editable render OMITS the \\qa label (kept out of the DOM capture)");

// Round-trip: a real body edit (Blessed → Happy) preserves the `\qa` heading and
// its label, aligns the edited word, and never resurrects qa/Aleph as words.
{
  const res = smartEditVerse({ verseObjects: qaVerse }, qaEditable, qaEditable.replace("Blessed", "Happy"), {
    capturedFromDom: true,
  });
  const vo = res.content.verseObjects;
  const qa = vo.find((n) => n.tag === "qa");
  assert(!!qa && (qa.content === "Aleph" || qa.text === "Aleph\n"), "\\qa heading + label survive a real edit round-trip");
  assert(vo.some((n) => isWordNode(n) && n.text === "Happy"), "the edited word aligns");
  assert(!vo.some((n) => isWordNode(n) && (n.text === "qa" || n.text === "Aleph")), "no qa/Aleph draggable word after save");
}

// The heading still DRIFTS to the verse it introduces (usfm-js attaches a
// stanza-opening `\qa Beth` to the previous verse's trailing objects).
assert(
  extractTrailingMarkers([{ type: "text", text: "x\n" }, { tag: "qa", type: "quote", text: "Beth\n" }]).some(
    (n) => n.tag === "qa",
  ),
  "\\qa drifts as a trailing marker to the verse it heads",
);

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nmarker.test.mjs: all assertions passed.");

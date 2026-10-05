// Regression tests for the verse-history dialog's USFM view (issue #951).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseUsfmPreview.test.mjs

import { toJSON } from "usfm-js";
import { classifyHiddenChange, renderVerseUsfm, stripAlignmentNoise } from "./verseUsfmPreview.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const text = (r) => (r.kind === "usfm" ? r.text : null);

// ── 1. A markers-only change (added trailing \p) is invisible in plain_text
//       but visible in the USFM render: the ZEC 1:17 shape from #951.
{
  const before = toJSON(`\\c 1\n\\v 17 \\zaln-s |x-strong="H1"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* will overflow.`);
  const after = toJSON(`\\c 1\n\\v 17 \\zaln-s |x-strong="H1"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* will overflow.\n\\p`);
  const b = renderVerseUsfm(before.chapters["1"]["17"], 1, 17);
  const a = renderVerseUsfm(after.chapters["1"]["17"], 1, 17);
  assert(b.kind === "usfm" && a.kind === "usfm", "both versions render");
  assert(text(b) !== text(a), "USFM render differs when only a trailing \\p was added");
  assert(text(a).includes("\\p"), "the added \\p survives into the USFM render");
  assert(text(a).startsWith("\\v 17"), "render starts at the verse marker");
}

// ── 2. Scoped to the one verse; the chapter marker prefix is stripped.
{
  const parsed = toJSON(`\\c 3\n\\v 5 First verse text.\n\\v 6 Second verse text.`);
  const out = text(renderVerseUsfm(parsed.chapters["3"]["5"], 3, 5));
  assert(!out.includes("\\c"), "chapter marker is stripped from the per-verse render");
  assert(out.includes("First verse text"), "verse 5's own text is present");
  assert(!out.includes("Second verse text"), "verse 6's text does not leak into verse 5's render");
}

// ── 3. Verse 0 renders via the "front" key, like exportUsfm.ts.
{
  const parsed = toJSON(`\\c 1\nIntroduction text.\n\\v 1 First verse.`);
  const out = text(renderVerseUsfm(parsed.chapters["1"]["front"], 1, 0));
  assert(out.includes("Introduction text"), "verse 0 (front matter) renders its own text");
}

// ── 4. Every version renders `\v N`, never a bridge range. History entries
//       don't record their own verse_end, and the live row's range applied to
//       older versions showed a `\v 6-9` they never had (Codex review, #951).
{
  const vo = { verseObjects: [{ type: "text", text: "Bridged text." }] };
  assert(text(renderVerseUsfm(vo, 2, 6)).startsWith("\\v 6 "), "renders \\v 6");
  assert(text(renderVerseUsfm(vo, 2, 6, 9)).startsWith("\\v 6 "), "a stray verse_end argument is ignored: still \\v 6, not \\v 6-9");
}

// ── 5. No stored tree -> kind "none" (plain_text-only history entry).
{
  assert(renderVerseUsfm(null, 1, 1).kind === "none", "null content -> none");
  assert(renderVerseUsfm({}, 1, 1).kind === "none", "content with no verseObjects array -> none");
  assert(renderVerseUsfm({ verseObjects: [] }, 1, 1).kind === "none", "empty verseObjects -> none");
}

// ── 6. A tree toUSFM throws on -> kind "error", never an exception, so one
//       malformed history entry can't crash the dialog.
{
  let threw = false;
  let r;
  try {
    // A node whose children is not an array makes usfm-js iterate a number.
    r = renderVerseUsfm({ verseObjects: [{ tag: "w", type: "word", children: 5, text: "x" }, null] }, 1, 1);
  } catch {
    threw = true;
  }
  assert(!threw, "a malformed tree does not throw out of renderVerseUsfm");
  assert(r && (r.kind === "error" || r.kind === "usfm"), "malformed input resolves to error or usfm");
  // Force the error branch deterministically: a getter that throws.
  const hostile = { verseObjects: [{ get tag() { throw new Error("boom"); } }] };
  let r2;
  try {
    r2 = renderVerseUsfm(hostile, 1, 1);
  } catch {
    r2 = "threw";
  }
  assert(r2 !== "threw" && r2.kind === "error", "a throwing tree resolves to kind error");
}

// ── 7. Rendering never mutates the input (the #960 blocker; same defect as
//       #932 in exportUsfm.ts). toUSFM trims a paragraph's trailing
//       whitespace and strips text/type off a whitespace node after \p, in
//       place. Without a clone, opening history rewrote each entry's tree and
//       "Switch to vN" saved the rewritten one.
{
  const content = {
    verseObjects: [
      { tag: "p", type: "paragraph", text: "Blessed is   \n" },
      { type: "word", tag: "w", text: "the" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "man" },
      { tag: "p", type: "paragraph", nextChar: "\n" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "who" },
    ],
  };
  const before = JSON.parse(JSON.stringify(content));
  const r = renderVerseUsfm(content, 1, 1);
  assert(r.kind === "usfm", "the #932 fixture renders");
  assert(JSON.stringify(content) === JSON.stringify(before), "renderVerseUsfm does not mutate the input content");
  renderVerseUsfm(content, 1, 1);
  assert(JSON.stringify(content) === JSON.stringify(before), "a second render does not mutate either");
}

// ── 8. stripAlignmentNoise removes \zaln milestones and \w attributes, keeps
//       word text and other markers.
{
  const usfmText = String.raw`\q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*`;
  const stripped = stripAlignmentNoise(usfmText);
  assert(!stripped.includes("zaln-s"), "\\zaln-s milestones are removed");
  assert(!stripped.includes("zaln-e"), "\\zaln-e milestones are removed");
  assert(!stripped.includes("x-strong"), "alignment attributes are removed");
  assert(stripped.includes("\\w Salvation belongs to Yahweh\\w*"), "word text survives as a bare \\w");
  assert(stripped.includes("\\w Selah\\w*"), "second word survives as a bare \\w");
  assert(stripped.includes("\\q1") && stripped.includes("\\qs"), "poetry markers are untouched");
  const plain = "\\v 1 Plain text with no alignment.\n\\p";
  assert(stripAlignmentNoise(plain) === plain, "no-op when there is no alignment markup");
}

// ── 9. classifyHiddenChange: the chip label names a change the default
//       (attributes hidden) view can show, or says it needs attributes on.
{
  const zalnA = String.raw`\v 1 \zaln-s |x-strong="H1"\*\w Cities|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* overflow.`;
  const zalnB = String.raw`\v 1 \zaln-s |x-strong="H2"\*\w Cities|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* overflow.`;
  const withP = zalnA + "\n\\p";
  const ok = (t) => ({ kind: "usfm", text: t });
  assert(classifyHiddenChange("a", "a", ok(zalnA), ok(withP)) === "markers", "added \\p -> markers");
  assert(classifyHiddenChange("a", "a", ok(zalnA), ok(zalnB)) === "alignment", "re-pointed \\zaln only -> alignment");
  assert(classifyHiddenChange("a", "a", ok(zalnA), ok(zalnA)) === null, "identical -> no chip");
  assert(classifyHiddenChange("a", "b", ok(zalnA), ok(withP)) === null, "plain text changed -> no chip");
  assert(classifyHiddenChange(null, null, ok(zalnA), ok(withP)) === null, "missing plain text -> no chip");
  assert(classifyHiddenChange("a", "a", { kind: "none" }, ok(withP)) === null, "predecessor without a tree -> no chip");
  assert(classifyHiddenChange("a", "a", ok(zalnA), { kind: "error" }) === null, "unrenderable version -> no chip");
}

// ── 10. First alignment of bare text is "alignment", not "markers" (Cursor
//        review, #951). Aligning wraps each word in \w and, with
//        forcedNewLines, puts the words on separate lines; stripping the
//        attributes alone leaves those \w wrappers and newlines behind. Rendered
//        through usfm-js so the whitespace is what the dialog really compares.
{
  const bare = toJSON(`\\c 1\n\\v 17 Cities will overflow.`);
  const aligned = toJSON(`\\c 1\n\\v 17 \\zaln-s |x-strong="H1"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* \\zaln-s |x-strong="H2"\\*\\w will|x-occurrence="1" x-occurrences="1"\\w* \\w overflow|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*.`);
  const alignedP = toJSON(`\\c 1\n\\v 17 \\zaln-s |x-strong="H1"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* \\w will|x-occurrence="1" x-occurrences="1"\\w* \\w overflow|x-occurrence="1" x-occurrences="1"\\w*.\n\\p`);
  const r = (p) => renderVerseUsfm(p.chapters["1"]["17"], 1, 17);
  assert(classifyHiddenChange("x", "x", r(bare), r(aligned)) === "alignment", "bare text -> first alignment is alignment only");
  assert(classifyHiddenChange("x", "x", r(aligned), r(bare)) === "alignment", "alignment removed entirely is alignment only");
  assert(classifyHiddenChange("x", "x", r(bare), r(alignedP)) === "both", "first alignment plus an added \\p is both, not markers only");
}

// ── 11. Markers and alignment are judged separately (Cursor review, #951):
//        "markers" only when the alignment is untouched, "both" when the same
//        version also changed it, so the chip never says "markers only" over
//        a diff full of new \w wrappers.
{
  const zaln = (strong) => `\\zaln-s |x-strong="${strong}"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* \\w will|x-occurrence="1" x-occurrences="1"\\w* \\w overflow|x-occurrence="1" x-occurrences="1"\\w*.`;
  const r = (src) => renderVerseUsfm(toJSON(`\\c 1\n\\v 17 ${src}`).chapters["1"]["17"], 1, 17);
  assert(classifyHiddenChange("x", "x", r(zaln("H1")), r(zaln("H1") + "\n\\p")) === "markers", "aligned -> same alignment + \\p stays markers");
  assert(classifyHiddenChange("x", "x", r(zaln("H1")), r(zaln("H2") + "\n\\p")) === "both", "re-pointed \\zaln + \\p is both");
  assert(classifyHiddenChange("x", "x", r(zaln("H1")), r(zaln("H2"))) === "alignment", "re-pointed \\zaln alone stays alignment");
  assert(classifyHiddenChange("x", "x", r("Cities will overflow."), r("Cities will overflow.\n\\p")) === "markers", "bare -> bare + \\p is markers");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll verseUsfmPreview assertions passed.");
}

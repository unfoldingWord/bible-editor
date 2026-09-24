// Regression tests for the verse-history dialog's USFM view (issue #951).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseUsfmPreview.test.mjs

import { toJSON } from "usfm-js";
import { renderVerseUsfm, stripAlignmentNoise } from "./verseUsfmPreview.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── 1. A markers-only change (added trailing \p) is invisible in plain_text
//       but visible in the USFM render — the exact ZEC 1:17 shape from #951.
{
  const before = toJSON(`\\c 1\n\\v 17 \\zaln-s |x-strong="H1"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* will overflow.`);
  const after = toJSON(`\\c 1\n\\v 17 \\zaln-s |x-strong="H1"\\*\\w Cities|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* will overflow.\\p`);
  const beforeContent = before.chapters["1"]["17"];
  const afterContent = after.chapters["1"]["17"];

  const beforeUsfm = renderVerseUsfm(beforeContent, 1, 17);
  const afterUsfm = renderVerseUsfm(afterContent, 1, 17);
  assert(beforeUsfm !== afterUsfm, "USFM render differs when only a trailing \\p was added");
  assert(afterUsfm.includes("\\p"), "the added \\p survives into the USFM render");
}

// ── 2. renderVerseUsfm scopes to the one verse: no other verse's text leaks
//       in, and the chapter marker prefix is stripped.
{
  const parsed = toJSON(`\\c 3\n\\v 5 First verse text.\n\\v 6 Second verse text.`);
  const out = renderVerseUsfm(parsed.chapters["3"]["5"], 3, 5);
  assert(!out.includes("\\c"), "chapter marker is stripped from the per-verse render");
  assert(out.includes("First verse text"), "verse 5's own text is present");
  assert(!out.includes("Second verse text"), "verse 6's text does not leak into verse 5's render");
}

// ── 3. Verse 0 (front/intro) renders via the "front" verseKey, not a numeric
//       \v — mirrors exportUsfm.ts's own front-matter convention.
{
  const parsed = toJSON(`\\c 1\nIntroduction text.\n\\v 1 First verse.`);
  const out = renderVerseUsfm(parsed.chapters["1"]["front"], 1, 0);
  assert(out.includes("Introduction text"), "verse 0 (front matter) renders its own text");
}

// ── 4. null / missing content renders null, not a thrown error or "undefined".
{
  assert(renderVerseUsfm(null, 1, 1) === null, "null content -> null (not restorable, plain_text-only entry)");
  assert(renderVerseUsfm({}, 1, 1) === null, "content with no verseObjects array -> null");
  assert(renderVerseUsfm({ verseObjects: [] }, 1, 1) === null, "empty verseObjects -> null");
}

// ── 5. stripAlignmentNoise removes \zaln-s/\zaln-e milestones and \w
//       attribute payloads, but leaves the word text and other markers
//       (\q1, \p, \ts\*) fully intact — the exact corpus shape from
//       alignment.test.mjs.
{
  const usfmText = String.raw`\q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*`;
  const stripped = stripAlignmentNoise(usfmText);
  assert(!stripped.includes("zaln-s"), "\\zaln-s milestones are removed");
  assert(!stripped.includes("zaln-e"), "\\zaln-e milestones are removed");
  assert(!stripped.includes("x-strong"), "alignment attributes (x-strong etc) are removed");
  assert(stripped.includes("\\w Salvation belongs to Yahweh\\w*"), "word text survives as a bare \\w without attributes");
  assert(stripped.includes("\\w Selah\\w*"), "second word survives as a bare \\w without attributes");
  assert(stripped.includes("\\q1"), "\\q1 paragraph marker is untouched");
  assert(stripped.includes("\\qs"), "\\qs marker is untouched");
}

// ── 6. stripAlignmentNoise is a no-op on USFM with no alignment markup —
//       a plain-text-only edit still shows unchanged.
{
  const usfmText = "\\v 1 Plain text with no alignment.\\p";
  assert(stripAlignmentNoise(usfmText) === usfmText, "no-op when there is no alignment markup to strip");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll verseUsfmPreview assertions passed.");
}

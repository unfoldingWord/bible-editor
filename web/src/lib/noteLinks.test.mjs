// Regression suite for the "see how you translated" note-link parser.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/noteLinks.test.mjs
//
// Pins issue #715: `[2:5](../02/05.md)` (same-book) and
// `[ZEC 2:5](../../zec/02/05.md)` (cross-book) must parse into a clickable
// link segment; everything else (rc:// links, malformed refs, an unresolvable
// book code) must fall through as plain text so NoteCard never renders a dead
// link or drops real note content.

import { parseNoteSegments } from "./noteLinks.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function linksOf(text, book) {
  return parseNoteSegments(text, book).filter((s) => s.type === "link");
}

// ── same-book link ──
{
  const text = 'See how you translated this in [1:3](../01/03.md).';
  const segs = parseNoteSegments(text, "ZEC");
  assert(segs.length === 3, "same-book link splits into before/link/after");
  assert(segs[0].type === "text" && segs[0].text === "See how you translated this in ", "leading text preserved");
  assert(segs[1].type === "link" && segs[1].text === "1:3", "link label is the bracket text");
  assert(
    segs[1].type === "link" &&
      segs[1].target.book === "ZEC" &&
      segs[1].target.chapter === 1 &&
      segs[1].target.verse === 3,
    "same-book link targets the current book, chapter 1 verse 3",
  );
  assert(segs[2].type === "text" && segs[2].text === ".", "trailing text preserved");
}

// ── cross-book link, 3-letter lowercase code resolved to canonical code ──
{
  const links = linksOf("compare [ZEC 2:5](../../zec/02/05.md) here", "MAL");
  assert(links.length === 1, "cross-book link recognized");
  assert(links[0].target.book === "ZEC" && links[0].target.chapter === 2 && links[0].target.verse === 5,
    "cross-book link targets the named book/chapter/verse");
}

// ── PSA 3-digit chapter/verse ──
{
  const links = linksOf("see [150:6](../150/006.md)", "PSA");
  assert(links.length === 1, "3-digit PSA chapter/verse parses");
  assert(links[0].target.book === "PSA" && links[0].target.chapter === 150 && links[0].target.verse === 6,
    "3-digit chapter/verse values are numeric and correct");
}

// ── unresolvable cross-book code falls back to plain text ──
{
  const segs = parseNoteSegments("see [X 1:1](../../xyz/01/01.md)", "ZEC");
  assert(segs.every((s) => s.type === "text"), "unknown book code yields no link segment");
  assert(segs.map((s) => s.text).join("") === "see [X 1:1](../../xyz/01/01.md)", "full text preserved verbatim");
}

// ── rc://*/ta/man/translate/... links are out of scope and untouched ──
{
  const text = "See [[rc://*/ta/man/translate/figs-metaphor]]";
  const segs = parseNoteSegments(text, "ZEC");
  assert(segs.length === 1 && segs[0].type === "text" && segs[0].text === text,
    "rc:// links are not touched by the markdown-link parser");
}

// ── multiple links in one note ──
{
  const text = "See [1:3](../01/03.md) and [2:1](../02/01.md).";
  const links = linksOf(text, "ZEC");
  assert(links.length === 2, "two links in one note both parse");
  assert(links[0].target.verse === 3 && links[1].target.chapter === 2 && links[1].target.verse === 1,
    "each link keeps its own target");
}

// ── plain text with no links round-trips as a single text segment ──
{
  const text = "Alternate translation: nothing to link here.";
  const segs = parseNoteSegments(text, "ZEC");
  assert(segs.length === 1 && segs[0].type === "text" && segs[0].text === text,
    "note with no links yields one text segment covering the whole string");
}

// ── empty text yields no segments ──
{
  const segs = parseNoteSegments("", "ZEC");
  assert(segs.length === 0, "empty note text yields an empty segment list");
}

// ── segment offsets tile the original string exactly (no gaps/overlaps) ──
{
  const text = "before [1:3](../01/03.md) middle [2:1](../02/01.md) after";
  const segs = parseNoteSegments(text, "ZEC");
  let cursor = 0;
  for (const seg of segs) {
    assert(seg.start === cursor, `segment starts where the previous one ended (at ${cursor})`);
    cursor = seg.end;
  }
  assert(cursor === text.length, "segments cover the entire string with no trailing gap");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll noteLinks assertions passed.");

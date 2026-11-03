// T4T USFM → per-verse VerseDto parse (read-only reference version).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/t4t.test.mjs

import { parseT4tBook, T4T_ADD_TAG } from "./t4t.ts";
import { renderHighlightedHTML } from "./highlight.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const usfm = [
  "\\id ZEC - Translation 4 Translators",
  "\\c 1",
  "\\s1 Heading",
  "\\p",
  "\\v 1 Plain verse.",
  "\\v 3-4 Your ancestors  \\add have died\\add* [RHQ]. ◄repented/turned away►",
  "\\v 5 Last.",
  "",
].join("\n");

const book = parseT4tBook("ZEC", usfm);
const ch1 = book.get(1);
assert(!!ch1, "chapter 1 parsed");

// Bridge: keyed by its start verse, verse_end carries the end.
const bridge = ch1?.[3];
assert(bridge?.verse === 3 && bridge?.verse_end === 4, "\\v 3-4 → verse 3, verse_end 4");
assert(ch1?.[4] === undefined, "no separate entry for verse 4 of the bridge");
assert(ch1?.[1]?.verse_end === null, "singleton verse_end is null");
assert(bridge?.bible_version === "T4T", "bible_version is T4T");

// \add text kept in plain_text, alongside [RHQ] tags and ◄a/b► alternates.
assert(
  bridge?.plain_text === "Your ancestors have died [RHQ]. ◄repented/turned away►",
  `plain_text keeps \\add text, tags and alternates (got ${JSON.stringify(bridge?.plain_text)})`,
);

// \add is renamed to the private tag and renders italic.
const vos = bridge?.content?.verseObjects ?? [];
assert(vos.some((v) => v.tag === T4T_ADD_TAG && v.text === "have died"), "\\add renamed to private tag");
assert(!vos.some((v) => v.tag === "add"), "no raw add tag left");
const html = renderHighlightedHTML(vos, new Set());
assert(html.includes("<em>have died</em>"), `\\add renders italic (got ${html})`);
assert(html.includes("[RHQ]"), "[RHQ] renders");

// Chapter front (heading before \v 1) → verse 0.
assert(!!ch1?.[0], "front stored as verse 0");

// \bd / \sc text and an unnumbered \li run (which usfm-js nests as children,
// GEN 46:8-25 / DAN 5:27 shapes) must all still render.
{
  const src = [
    "\\c 5",
    "\\p",
    "\\v 1 “\\bd You\\bd* are \\sc Tekel\\sc* here.",
    "\\v 2 A list:",
    "\\li Reuben;",
    "\\li Simeon \\add and sons\\add* too;",
    "\\li Levi.",
    "",
  ].join("\n");
  const ch5 = parseT4tBook("DAN", src).get(5);
  const strip = (h) => h.replace(/<\/?(em|mark|span)[^>]*>/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const r1 = strip(renderHighlightedHTML(ch5?.[1]?.content?.verseObjects ?? [], new Set()));
  assert(r1.includes("“You are Tekel here."), `\\bd/\\sc text renders (got ${JSON.stringify(r1)})`);
  const vos2 = ch5?.[2]?.content?.verseObjects ?? [];
  assert(!vos2.some((v) => Array.isArray(v.children)), "nested \\li children flattened");
  const r2 = strip(renderHighlightedHTML(vos2, new Set()));
  for (const w of ["Reuben;", "Simeon", "and sons", "Levi."]) {
    assert(r2.includes(w), `\\li run renders ${w} (got ${JSON.stringify(r2)})`);
  }
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall t4t tests passed");

// Smoke test for computeTwlSortOrderUpdates / orderTwlRows — the canonical
// (ULT-position) TWL ordering shared by the nightly export and the reimport
// post-pass. Run from api/:
//   node --experimental-strip-types --no-warnings src/twlCanonicalOrder.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs /
// reimportClassify.test.mjs.

import {
  buildUltSequenceMap,
  computeTwlSortOrderUpdates,
  orderTwlRows,
  twlAnchorContext,
  twlSortPosition,
} from "./twlCanonicalOrder.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Build a minimal ULT VerseRow whose \zaln milestones (content = Hebrew word)
// wrap \w words in document order. `words` is an array of { content, text }
// entries — each becomes one zaln milestone wrapping one \w word, in order.
function ultVerse(chapter, verse, words) {
  const verseObjects = words.map((w) => ({
    type: "milestone",
    tag: "zaln",
    content: w.content,
    children: [{ type: "word", tag: "w", text: w.text }],
  }));
  return {
    book: "GEN",
    chapter,
    verse,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
}

function twl(id, chapter, verse, orig_words, occurrence, sort_order) {
  return {
    id,
    book: "GEN",
    chapter,
    verse,
    ref_raw: `${chapter}:${verse}`,
    tags: null,
    orig_words,
    occurrence,
    tw_link: `rc://en/tw/dict/bible/kt/${id}`,
    sort_order,
    version: 1,
    restored_from_version: null,
    updated_by: null,
    updated_at: 0,
    deleted_at: null,
  };
}

// Turn the updates array into a { id: sort_order } map for order-insensitive
// comparison (the array order is an implementation detail).
function toMap(updates) {
  const m = {};
  for (const u of updates) m[u.id] = u.sort_order;
  return m;
}

// ─── ULT-position ordering ───────────────────────────────────────────────────
{
  console.log("\n[ordering] rows sequenced by ULT word position");
  const verse = ultVerse(1, 1, [
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
    { content: "ג", text: "third" },
  ]);
  // Rows stored out of ULT order (g/a/b) — canonical order is a, b, c.
  const rows = [
    twl("g", 1, 1, "ג", 1, 100),
    twl("a", 1, 1, "א", 1, 200),
    twl("b", 1, 1, "ב", 1, 300),
  ];
  const { referenceOrdered, versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("a") === 0, "א → canonical index 0");
  assert(versePositions.get("b") === 1, "ב → canonical index 1");
  assert(versePositions.get("g") === 2, "ג → canonical index 2");
  assert(referenceOrdered.length === 3, "all rows retained");

  const updates = toMap(computeTwlSortOrderUpdates(rows, [verse]));
  assert(JSON.stringify(updates) === JSON.stringify({ a: 100, b: 200, g: 300 }),
    `updates canonicalize to a:100,b:200,g:300 (got ${JSON.stringify(updates)})`);
}

// ─── Occurrence keying (word#1 vs word#2) ────────────────────────────────────
{
  console.log("\n[occurrence] same OrigWords disambiguated by Occurrence");
  const verse = ultVerse(1, 2, [
    { content: "ד", text: "x" }, // ד occurrence 1 → position 0
    { content: "ד", text: "y" }, // ד occurrence 2 → position 1
  ]);
  // Stored reversed: occurrence 2 before occurrence 1.
  const rows = [
    twl("d2", 1, 2, "ד", 2, 100),
    twl("d1", 1, 2, "ד", 1, 200),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("d1") === 0, "ד#1 → index 0 (before ד#2)");
  assert(versePositions.get("d2") === 1, "ד#2 → index 1");

  const updates = toMap(computeTwlSortOrderUpdates(rows, [verse]));
  assert(JSON.stringify(updates) === JSON.stringify({ d1: 100, d2: 200 }),
    `updates put ד#1 first (got ${JSON.stringify(updates)})`);
}

// ─── Unaligned rows fall to the end, ordered by sort_order ───────────────────
{
  console.log("\n[unaligned] rows with no ULT match sink to the end by sort_order");
  const verse = ultVerse(1, 3, [{ content: "ה", text: "h" }]);
  const rows = [
    twl("h", 1, 3, "ה", 1, 100),   // aligned → position 0
    twl("z1", 1, 3, "zz", 1, 300), // unaligned
    twl("z2", 1, 3, "yy", 1, 200), // unaligned, lower sort_order → before z1
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("h") === 0, "aligned row first");
  assert(versePositions.get("z2") === 1, "unaligned lower sort_order next");
  assert(versePositions.get("z1") === 2, "unaligned higher sort_order last");
}

// ─── No-op when rows are already canonical ───────────────────────────────────
{
  console.log("\n[noop] already-canonical rows produce no updates");
  const verse = ultVerse(1, 1, [
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
  ]);
  const rows = [
    twl("a", 1, 1, "א", 1, 100),
    twl("b", 1, 1, "ב", 1, 200),
  ];
  const updates = computeTwlSortOrderUpdates(rows, [verse]);
  assert(updates.length === 0, `no updates (got ${JSON.stringify(updates)})`);
}

// ─── Reimport-path proof: content-identical but misordered → canonical diff ──
// The row loop preserves a content-identical row's local sort_order, so only
// this post-pass can adopt canonical order. Prove it emits the fixing diff.
{
  console.log("\n[reimport] content-identical-but-misordered rows get canonicalized");
  const verse = ultVerse(2, 5, [
    { content: "ראשון", text: "one" },   // position 0
    { content: "שני", text: "two" },     // position 1
    { content: "שלישי", text: "three" }, // position 2
  ]);
  // Master/D1 content identical, but sort_order is scrambled (200/300/100).
  const rows = [
    twl("r1", 2, 5, "ראשון", 1, 200),
    twl("r2", 2, 5, "שני", 1, 300),
    twl("r3", 2, 5, "שלישי", 1, 100),
  ];
  const updates = toMap(computeTwlSortOrderUpdates(rows, [verse]));
  assert(JSON.stringify(updates) === JSON.stringify({ r1: 100, r2: 200, r3: 300 }),
    `canonical diff r1:100,r2:200,r3:300 (got ${JSON.stringify(updates)})`);
}

// ─── Nested alignment: OUTER milestone word resolves (ZEC 3:1 "high priest") ──
// A TWL link can point at the OUTER word of a nested Hebrew→English alignment
// (הַכֹּהֵן wrapping הַגָּדוֹל, "high priest"). The English words sit under the
// inner milestone, so recording only the innermost left the outer word with no
// position → it sank to the end. buildUltSequenceMap now records every stack
// level, so the outer word resolves to the first English index of its span.
{
  console.log("\n[nested] a TWL link on the OUTER word of a nested alignment resolves");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "ראשון", children: [{ type: "word", tag: "w", text: "joshua" }] },
    {
      type: "milestone", tag: "zaln", content: "חיצון", // OUTER — no direct \w
      children: [
        {
          type: "milestone", tag: "zaln", content: "פנימי", // INNER — wraps the English words
          children: [
            { type: "word", tag: "w", text: "high" },
            { type: "word", tag: "w", text: "priest" },
          ],
        },
      ],
    },
    { type: "milestone", tag: "zaln", content: "אחרון", children: [{ type: "word", tag: "w", text: "standing" }] },
  ];
  const verse = {
    book: "GEN", chapter: 3, verse: 1, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("first", 3, 1, "ראשון", 1, 100),
    twl("inner", 3, 1, "פנימי", 1, 200),
    twl("outer", 3, 1, "חיצון", 1, 300), // the "high priest" analog
    twl("last", 3, 1, "אחרון", 1, 400),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("first") === 0, "first word → index 0");
  assert(versePositions.get("inner") === 1, "inner nested word → index 1");
  assert(versePositions.get("outer") === 2, "OUTER nested word → index 2 (resolved, NOT sunk to end)");
  assert(versePositions.get("last") === 3, "last word → index 3");
}

// ─── Occurrence = SOURCE instance, not target-word count ─────────────────────
// A source word aligned to MULTIPLE English words must still own ONE occurrence
// slot, so a later occurrence of the same word resolves to its own milestone —
// not to the first milestone's 2nd English word. Regression for the per-\w
// counter (Codex): foo aligned to 2 English words, then a 'mid' word, then foo
// again. A link on foo#2 must land AFTER 'mid', not before it.
{
  console.log("\n[occurrence-source] repeated word, first aligned to 2 English words");
  const verseObjects = [
    {
      type: "milestone", tag: "zaln", content: "foo", // occurrence 1, spans 2 English words
      children: [
        { type: "word", tag: "w", text: "aa" },
        { type: "word", tag: "w", text: "bb" },
      ],
    },
    { type: "milestone", tag: "zaln", content: "mid", children: [{ type: "word", tag: "w", text: "cc" }] },
    { type: "milestone", tag: "zaln", content: "foo", children: [{ type: "word", tag: "w", text: "dd" }] }, // occurrence 2
  ];
  const verse = {
    book: "GEN", chapter: 4, verse: 1, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("fooA", 4, 1, "foo", 1, 100),
    twl("mid", 4, 1, "mid", 1, 200),
    twl("fooB", 4, 1, "foo", 2, 300),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("fooA") === 0, "foo#1 (first source instance) → index 0");
  assert(versePositions.get("mid") === 1, "mid → index 1");
  assert(
    versePositions.get("fooB") === 2,
    "foo#2 (SECOND source instance) → index 2, AFTER mid (not the 1st foo's 2nd word)",
  );
}

// ─── Nested-phrase OrigWords (JHN 1:1 gj8t: Greek "τὸν Θεόν") ────────────────
// A TWL row can point at a multi-word source PHRASE spanning a nested
// article+noun milestone pair (outer "τὸν" wrapping inner "Θεόν"). OrigWords
// stores the concatenated phrase "τὸν Θεόν", which matches neither milestone's
// own `content` alone. Without keying the full nested chain, this row sank to
// the end of the verse's Words list (after Θεὸς) instead of between the 2nd
// λόγος and the final Θεὸς. Regression for the live prod bug found on JHN 1:1.
{
  console.log("\n[nested-phrase] TWL row on a multi-word nested phrase resolves");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "λόγος", children: [{ type: "word", tag: "w", text: "Word1" }] },
    { type: "milestone", tag: "zaln", content: "λόγος", children: [{ type: "word", tag: "w", text: "Word2" }] },
    {
      type: "milestone", tag: "zaln", content: "τὸν", // OUTER — article, no direct \w
      children: [
        {
          type: "milestone", tag: "zaln", content: "Θεόν", // INNER — noun, wraps the English word
          children: [{ type: "word", tag: "w", text: "God1" }],
        },
      ],
    },
    { type: "milestone", tag: "zaln", content: "λόγος", children: [{ type: "word", tag: "w", text: "Word3" }] },
    { type: "milestone", tag: "zaln", content: "Θεὸς", children: [{ type: "word", tag: "w", text: "God2" }] },
  ];
  const verse = {
    book: "JHN", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("logos1", 1, 1, "λόγος", 1, 100),
    twl("logos2", 1, 1, "λόγος", 2, 200),
    twl("tonTheon", 1, 1, "τὸν Θεόν", 1, 300), // spans the nested article+noun pair
    twl("theos", 1, 1, "Θεὸς", 1, 400),
    twl("logos3", 1, 1, "λόγος", 3, 500),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("logos1") === 0, "λόγος#1 → index 0");
  assert(versePositions.get("logos2") === 1, "λόγος#2 → index 1");
  assert(
    versePositions.get("tonTheon") === 2,
    `τὸν Θεόν (nested phrase) → index 2, between λόγος#2 and λόγος#3 (NOT sunk to the end)`,
  );
  assert(versePositions.get("logos3") === 3, "λόγος#3 → index 3");
  assert(versePositions.get("theos") === 4, "Θεὸς → index 4 (last, matches ULT English word order)");
}

// ─── Sibling-phrase OrigWords (LUK 17:20: Greek "Βασιλεία τοῦ Θεοῦ") ─────────
// A multi-word OrigWords phrase doesn't always span a NESTED chain — real NT
// data also spans SIBLING top-level milestones: "Βασιλεία" is its own
// standalone milestone, immediately followed by "τοῦ" (which itself nests
// "Θεοῦ"). Verified against prod LUK 17:20 content_json. The fix must resolve
// this as a contiguous run in the flat entry list, not just a parent→child
// chain, or 3-word "kingdom of God" phrases sink to the end just like the
// nested case did.
{
  console.log("\n[sibling-phrase] TWL row spanning sibling + nested milestones resolves");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "ἡ", children: [{ type: "word", tag: "w", text: "the" }] },
    { type: "milestone", tag: "zaln", content: "Βασιλεία", children: [{ type: "word", tag: "w", text: "kingdom" }] },
    {
      type: "milestone", tag: "zaln", content: "τοῦ", // OUTER — article, no direct \w
      children: [
        {
          type: "milestone", tag: "zaln", content: "Θεοῦ", // INNER — noun, wraps the English words
          children: [
            { type: "word", tag: "w", text: "of" },
            { type: "word", tag: "w", text: "God" },
          ],
        },
      ],
    },
    { type: "milestone", tag: "zaln", content: "ἔρχεται", children: [{ type: "word", tag: "w", text: "coming" }] },
  ];
  const verse = {
    book: "LUK", chapter: 17, verse: 20, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("the", 17, 20, "ἡ", 1, 100),
    twl("kingdomOfGod", 17, 20, "Βασιλεία τοῦ Θεοῦ", 1, 200), // spans sibling "Βασιλεία" + nested "τοῦ"/"Θεοῦ"
    twl("coming", 17, 20, "ἔρχεται", 1, 300),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("the") === 0, "ἡ → index 0");
  assert(
    versePositions.get("kingdomOfGod") === 1,
    "Βασιλεία τοῦ Θεοῦ (sibling + nested run) → index 1, between ἡ and ἔρχεται",
  );
  assert(versePositions.get("coming") === 2, "ἔρχεται → index 2");
}

// ─── Repeated multi-word phrase, occurrence disambiguates (REV 3:12-style) ──
// The same multi-word phrase can appear more than once in a verse — the
// per-phrase occurrence counter must track EXACT phrase text, not collide with
// the single-word occurrence counters for its component words.
{
  console.log("\n[phrase-occurrence] repeated multi-word phrase disambiguated by Occurrence");
  const verseObjects = [
    {
      type: "milestone", tag: "zaln", content: "τοῦ",
      children: [{ type: "milestone", tag: "zaln", content: "Θεοῦ", children: [{ type: "word", tag: "w", text: "God1" }] }],
    },
    { type: "milestone", tag: "zaln", content: "καὶ", children: [{ type: "word", tag: "w", text: "and" }] },
    {
      type: "milestone", tag: "zaln", content: "τοῦ",
      children: [{ type: "milestone", tag: "zaln", content: "Θεοῦ", children: [{ type: "word", tag: "w", text: "God2" }] }],
    },
  ];
  const verse = {
    book: "REV", chapter: 3, verse: 12, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("god1", 3, 12, "τοῦ Θεοῦ", 1, 100),
    twl("and", 3, 12, "καὶ", 1, 200),
    twl("god2", 3, 12, "τοῦ Θεοῦ", 2, 300),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("god1") === 0, "τοῦ Θεοῦ#1 → index 0");
  assert(versePositions.get("and") === 1, "καὶ → index 1");
  assert(versePositions.get("god2") === 2, "τοῦ Θεοῦ#2 → index 2 (AFTER καὶ, not confused with #1)");
}

// ─── Same phrase text via DIFFERENT groupings — occurrence stays position-major ──
// The identical normalized phrase text can arise two ways in one verse: once as
// a single glued milestone (K=1), once as two separate sibling milestones for
// the SAME underlying words (K=2). Occurrence is a structure-independent
// left-to-right scan over the source text (quoteBuilder.ts's convention), so
// counting occurrences length-major (all K=1 windows before any K=2 window)
// would number them out of document order whenever the K=1 instance sits AFTER
// the K=2 instance. Regression for that ordering bug — the glued instance here
// comes SECOND in the verse but must still be occurrence #2, not #1.
{
  console.log("\n[phrase-occurrence-grouping] same phrase via sibling THEN glued milestone stays position-major");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "υἱοῦ", children: [{ type: "word", tag: "w", text: "Son1" }] },
    { type: "milestone", tag: "zaln", content: "θεοῦ", children: [{ type: "word", tag: "w", text: "God1" }] }, // sibling pair, occurrence 1
    { type: "milestone", tag: "zaln", content: "καὶ", children: [{ type: "word", tag: "w", text: "and" }] },
    { type: "milestone", tag: "zaln", content: "υἱοῦ θεοῦ", children: [{ type: "word", tag: "w", text: "Son2" }] }, // one glued milestone, SAME text, occurrence 2
  ];
  const verse = {
    book: "MAT", chapter: 26, verse: 63, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("sonOfGod1", 26, 63, "υἱοῦ θεοῦ", 1, 100), // the sibling-pair instance — earlier in the verse
    twl("and", 26, 63, "καὶ", 1, 200),
    twl("sonOfGod2", 26, 63, "υἱοῦ θεοῦ", 2, 300), // the glued instance — later in the verse
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("sonOfGod1") === 0, "υἱοῦ θεοῦ#1 (sibling pair, first in verse) → index 0");
  assert(versePositions.get("and") === 1, "καὶ → index 1");
  assert(
    versePositions.get("sonOfGod2") === 2,
    "υἱοῦ θεοῦ#2 (glued milestone, second in verse) → index 2, NOT confused with #1 despite different grouping",
  );
}

// ─── Phrase starts with a word that has no aligned English target ───────────
// A phrase's FIRST source word can be entirely unaligned in ULT (e.g. a
// dropped connective with zero \w descendants). The anchor must fall through
// to the next entry in the run that DOES have a resolved englishIndex, not
// give up on the whole run just because window[0] itself has none.
{
  console.log("\n[leading-unaligned] phrase whose first word has no ULT alignment still resolves");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "πρῶτον", children: [{ type: "word", tag: "w", text: "First" }] },
    { type: "milestone", tag: "zaln", content: "καὶ", children: [] }, // dropped connective — no \w descendant at all
    { type: "milestone", tag: "zaln", content: "ἐλάλησεν", children: [{ type: "word", tag: "w", text: "spoke" }] },
  ];
  const verse = {
    book: "MAT", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("first", 1, 1, "πρῶτον", 1, 100),
    twl("andSpoke", 1, 1, "καὶ ἐλάλησεν", 1, 200), // starts with the unaligned connective
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("first") === 0, "πρῶτον → index 0");
  assert(
    versePositions.get("andSpoke") === 1,
    "καὶ ἐλάλησεν (leading word unaligned) → index 1, resolved via ἐλάλησεν's anchor, NOT sunk to the end",
  );
}

// ─── Unaligned occurrence #1 must still consume its occurrence slot ─────────
// Codex regression: a single-word source instance can itself be fully
// unaligned (no \w descendant at all) — its own occurrence counter must still
// advance even though it never gets a sequenceMap entry, or a LATER, aligned
// instance of the same word gets miscounted as occurrence #1 instead of #2.
{
  console.log("\n[unaligned-occurrence-slot] unaligned occurrence#1 doesn't steal occurrence#2's number");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "foo", children: [] }, // occurrence 1 — fully unaligned, no \w
    { type: "milestone", tag: "zaln", content: "foo", children: [{ type: "word", tag: "w", text: "Foo2" }] }, // occurrence 2 — aligned
  ];
  const verse = {
    book: "GEN", chapter: 5, verse: 1, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [twl("foo2", 5, 1, "foo", 2, 100)];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(
    versePositions.get("foo2") === 0,
    "foo#2 (the aligned instance) resolves via its OWN occurrence number, not miscounted as foo#1",
  );
}

// ─── headword anchoring ──────────────────────────────────────────────────────
// Hebrew glues "and"/"the"/"of" onto the noun, so one alignment span covers an
// English run like "and the great house of". Anchoring on the span's first word
// sorts the link by "and"; the team's direction is to sort it by the TW article
// headword, "house". Tiers: (1) headword, (2) first non-function word, (3) first
// word. These build a span with MANY \w under ONE milestone, which the
// one-word-per-milestone `ultVerse` helper above can't express.
function ultVerseSpans(chapter, verse, spans) {
  const verseObjects = spans.map((s) => ({
    type: "milestone",
    tag: "zaln",
    content: s.content,
    children: s.texts.map((t) => ({ type: "word", tag: "w", text: t })),
  }));
  return {
    book: "GEN",
    chapter,
    verse,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
}

{
  console.log("\n[headword-anchor] tiers 1/2/3 pick the anchor inside one span");
  const verse = ultVerseSpans(1, 1, [
    { content: "ק", texts: ["and", "the", "great", "house", "of"] },
  ]);
  const map = buildUltSequenceMap(verse);
  const row = twl("house", 1, 1, "ק", 1, 100);

  // Tier 3 (no title, single-word test not applicable here) is exercised below;
  // with >1 word and no title we get tier 2: skip and/the → "great" at index 2.
  assert(
    twlSortPosition(row, map, null) === 2,
    "tier 2: no headword → first non-function word 'great' (index 2), NOT 'and'",
  );

  // Tier 1: the article headword wins over the merely-first-content word.
  assert(
    twlSortPosition(row, map, { terms: ["house"], isName: false }) === 3,
    "tier 1: headword 'house' (index 3) beats tier 2's 'great'",
  );

  // Morphology still applies: the ULT may inflect the headword.
  const plural = ultVerseSpans(1, 2, [
    { content: "ק", texts: ["and", "the", "houses", "of"] },
  ]);
  assert(
    twlSortPosition(
      twl("house", 1, 2, "ק", 1, 100),
      buildUltSequenceMap(plural),
      { terms: ["house"], isName: false },
    ) === 2,
    "tier 1 matches inflected 'houses' (index 2) against headword 'house'",
  );

  // Tier 3: every word in the span is a function word — anchor on the first,
  // exactly as the pre-headword implementation did.
  const allFunction = ultVerseSpans(1, 3, [{ content: "ו", texts: ["and", "of"] }]);
  assert(
    twlSortPosition(twl("x", 1, 3, "ו", 1, 100), buildUltSequenceMap(allFunction), null) === 0,
    "tier 3: span is all function words → first word (index 0)",
  );

  // A single-word span is never skipped, even when that word is a function
  // word: there is nothing to skip TO, and skipping would strand the row.
  const lone = ultVerseSpans(1, 4, [{ content: "ה", texts: ["the"] }]);
  assert(
    twlSortPosition(twl("y", 1, 4, "ה", 1, 100), buildUltSequenceMap(lone), null) === 0,
    "single-word function-word span still resolves (index 0), not unresolved",
  );
}

{
  console.log("\n[headword-reorders] headword anchoring flips a nested pair");
  // Outer milestone א wraps BOTH words; nested inner ב wraps only the first.
  // Pre-headword both anchored at index 0 (a tie broken by sort_order, so the
  // stored order stood). With headwords, א anchors on "beta" (1) and ב on
  // "alpha" (0), so ב now sorts FIRST regardless of sort_order.
  const verseObjects = [
    {
      type: "milestone",
      tag: "zaln",
      content: "א",
      children: [
        {
          type: "milestone",
          tag: "zaln",
          content: "ב",
          children: [{ type: "word", tag: "w", text: "alpha" }],
        },
        { type: "word", tag: "w", text: "beta" },
      ],
    },
  ];
  const verse = {
    book: "GEN",
    chapter: 2,
    verse: 1,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
  // sort_order puts the outer row first — the order that stood before.
  const outer = twl("outerbeta", 2, 1, "א", 1, 100);
  const inner = twl("inneralpha", 2, 1, "ב", 1, 200);
  const rows = [outer, inner];

  const noTitles = orderTwlRows(rows, [verse]).versePositions;
  assert(
    noTitles.get("outerbeta") === 0 && noTitles.get("inneralpha") === 1,
    "without titles the stored order stands (outer, inner)",
  );

  const titles = new Map([
    [outer.tw_link, "# beta"],
    [inner.tw_link, "# alpha"],
  ]);
  const withTitles = orderTwlRows(rows, [verse], titles).versePositions;
  assert(
    withTitles.get("inneralpha") === 0 && withTitles.get("outerbeta") === 1,
    "with titles the headwords reorder them (inner 'alpha' before outer 'beta')",
  );
}

{
  console.log("\n[tier2-pronoun-aux] tier 2 skips pronouns and auxiliaries too");
  // Both cases come from the real-data measurement over 7 books: the headword
  // failed to match the ULT's wording, and tier 2 — when it skipped only
  // conjunctions/prepositions — stopped on a PRONOUN instead of the verb.
  // Pronouns + auxiliaries are now skipped, so it reaches the content word.
  const mic16 = ultVerseSpans(4, 1, [
    { content: "ק", texts: ["So", "I", "will", "make"] },
  ]);
  assert(
    twlSortPosition(twl("appoint", 4, 1, "ק", 1, 100), buildUltSequenceMap(mic16), null) === 3,
    "MIC 1:6 'So I will make' → 'make' (index 3), not the pronoun 'I'",
  );

  const mic35 = ultVerseSpans(4, 2, [
    { content: "ק", texts: ["then", "they", "call", "out"] },
  ]);
  assert(
    twlSortPosition(twl("declare", 4, 2, "ק", 1, 100), buildUltSequenceMap(mic35), null) === 2,
    "MIC 3:5 'then they call out' → 'call' (index 2), not the pronoun 'they'",
  );

  // "might" is an auxiliary AND the headword of other/mighty (251 live rows).
  // Tier 1 must claim it before tier 2 can skip it — this is what makes adding
  // auxiliaries to the skip list safe.
  const mighty = ultVerseSpans(4, 3, [{ content: "ק", texts: ["by", "his", "might"] }]);
  assert(
    twlSortPosition(
      twl("mighty", 4, 3, "ק", 1, 100),
      buildUltSequenceMap(mighty),
      { terms: ["might", "mighty"], isName: false },
    ) === 2,
    "tier 1 claims 'might' (index 2) even though it is also an auxiliary",
  );
  // …and with no headword context every word is skippable, so it falls to
  // tier 3 rather than returning nothing.
  assert(
    twlSortPosition(twl("mighty", 4, 3, "ק", 1, 100), buildUltSequenceMap(mighty), null) === 0,
    "same span with no headword → all words skippable → tier 3 first word (index 0)",
  );
}

// A `\zaln` milestone list where entries carry an explicit x-occurrence, so a
// single source word can be SPLIT into two non-contiguous chunks.
function ultVerseOccSpans(chapter, verse, spans) {
  const verseObjects = spans.map((s) => ({
    type: "milestone",
    tag: "zaln",
    content: s.content,
    occurrence: s.occurrence,
    occurrences: s.occurrences ?? 1,
    children: s.texts.map((t) => ({ type: "word", tag: "w", text: t })),
  }));
  return {
    book: "ISA",
    chapter,
    verse,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
}

{
  console.log("\n[split-source-word] non-contiguous alignment reunites into one span");
  // ISA 60:6 shape: וּתְהִלֹּת (occ 1/1) → "and", then יְבַשֵּׂרוּ → "they will
  // proclaim", then וּתְהִלֹּת (occ 1/1 AGAIN) → "the praises of". One Hebrew
  // word rendered "and … the praises of". Before the fix the two chunks looked
  // like occurrence 1 and 2, so the praise row resolved to just "and" (index 0)
  // and sorted AHEAD of proclaim.
  const verse = ultVerseOccSpans(60, 6, [
    { content: "וּתהלת", occurrence: 1, texts: ["and"] },
    { content: "יבשרו", occurrence: 1, texts: ["they", "will", "proclaim"] },
    { content: "וּתהלת", occurrence: 1, texts: ["the", "praises", "of"] },
  ]);
  const map = buildUltSequenceMap(verse);

  const praise = twl("praise", 60, 6, "וּתהלת", 1, 100);
  const declare = twl("declare", 60, 6, "יבשרו", 1, 200);

  assert(
    map.get("וּתהלת#1").map((w) => w.text).join(" ") === "and the praises of",
    `split chunks reunite into one span (got "${map.get("וּתהלת#1").map((w) => w.text).join(" ")}")`,
  );
  assert(
    twlSortPosition(praise, map, { terms: ["praise"], isName: false }) === 5,
    "praise anchors on 'praises' (index 5), NOT the leading 'and' (index 0)",
  );
  assert(
    twlSortPosition(declare, map, { terms: ["declare"], isName: false }) === 3,
    "declare anchors on 'proclaim' (index 3)",
  );

  const titles = new Map([
    [praise.tw_link, "# praise"],
    [declare.tw_link, "# declare, proclaim"],
  ]);
  const pos = orderTwlRows([praise, declare], [verse], titles).versePositions;
  assert(
    pos.get("declare") === 0 && pos.get("praise") === 1,
    "declare sorts BEFORE praise (the reported ISA 60:6 bug)",
  );
}

{
  console.log("\n[split-source-word] a genuinely REPEATED word still splits");
  // Guard against over-merging: same content but DIFFERENT x-occurrence is two
  // real instances and must stay two spans with independent occurrence numbers.
  const verse = ultVerseOccSpans(60, 7, [
    { content: "דבר", occurrence: 1, occurrences: 2, texts: ["first", "word"] },
    { content: "אחר", occurrence: 1, texts: ["middle"] },
    { content: "דבר", occurrence: 2, occurrences: 2, texts: ["second", "word"] },
  ]);
  const map = buildUltSequenceMap(verse);
  assert(
    map.get("דבר#1").map((w) => w.text).join(" ") === "first word",
    "occurrence 1 keeps only its own words",
  );
  assert(
    map.get("דבר#2").map((w) => w.text).join(" ") === "second word",
    "occurrence 2 keeps only its own words (not merged with #1)",
  );
}

{
  console.log("\n[split-source-word] NESTED same-content pair is NOT merged");
  // The doubled-source-milestone defect (JER 31:33 class): one \zaln-s wraps the
  // same token twice, NESTED, with identical content and occurrence. That is
  // corrupt data, not a split alignment — merging it would delete the #2
  // occurrence slot and strand a TWL row carrying Occurrence=2 at the tail of
  // the verse. Only SIBLING chunks reunite.
  const verseObjects = [
    {
      type: "milestone",
      tag: "zaln",
      content: "דבר",
      occurrence: 1,
      occurrences: 1,
      children: [
        {
          type: "milestone",
          tag: "zaln",
          content: "דבר",
          occurrence: 1,
          occurrences: 1,
          children: [{ type: "word", tag: "w", text: "word" }],
        },
      ],
    },
    {
      type: "milestone",
      tag: "zaln",
      content: "אחר",
      occurrence: 1,
      occurrences: 1,
      children: [{ type: "word", tag: "w", text: "other" }],
    },
  ];
  const verse = {
    book: "JER",
    chapter: 31,
    verse: 33,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
  const map = buildUltSequenceMap(verse);
  assert(map.has("דבר#1"), "nested doubled pair keeps occurrence #1");
  assert(
    map.has("דבר#2"),
    "nested doubled pair KEEPS occurrence #2 (a row with Occurrence=2 still resolves)",
  );
  assert(
    twlSortPosition(twl("w2", 31, 33, "דבר", 2, 100), map, null) === 0,
    "Occurrence=2 on the doubled word resolves to the word (index 0), not the verse tail",
  );
}

{
  console.log("\n[headword-missing-article] unknown link falls through cleanly");
  const verse = ultVerseSpans(3, 1, [
    { content: "ק", texts: ["and", "the", "great", "house"] },
  ]);
  const map = buildUltSequenceMap(verse);
  const row = twl("orphan", 3, 1, "ק", 1, 100);
  // Mirrors the one real prod row pointing at kt/arcofthecovenant (a typo for
  // ark…), which has no tw_articles entry: no title → tier 2, never a crash.
  assert(
    twlSortPosition(row, map, twlAnchorContext(row.tw_link, new Map())) === 2,
    "link absent from the title map → tier 2 ('great'), no throw",
  );
  assert(
    twlSortPosition(row, map, twlAnchorContext(null, new Map([["x", "# y"]]))) === 2,
    "null tw_link → tier 2, no throw",
  );
}

// ─── Manual order lock ────────────────────────────────────────────────────────
// A translator manually reordered a verse; canonical ordering must skip it
// entirely — keep the stored (disagreeing) sort_order and emit no updates.
{
  console.log("\n[locked] a locked verse keeps its stored sort_order and emits no sortOrderUpdates");
  const verse = ultVerse(6, 1, [
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
    { content: "ג", text: "third" },
  ]);
  // Canonical order would be a, b, g — but the verse is locked, so the stored
  // (deliberately disagreeing) sort_order must stand instead.
  const rows = [
    twl("g", 6, 1, "ג", 1, 100),
    twl("a", 6, 1, "א", 1, 200),
    twl("b", 6, 1, "ב", 1, 300),
  ];
  const lockedVerses = new Set(["6:1"]);
  const { versePositions, sortOrderUpdates } = orderTwlRows(rows, [verse], null, lockedVerses);
  assert(versePositions.get("g") === 0, "locked: stored order stands — g (sort_order 100) first");
  assert(versePositions.get("a") === 1, "locked: a (sort_order 200) second");
  assert(versePositions.get("b") === 2, "locked: b (sort_order 300) third");
  assert(sortOrderUpdates.length === 0, `locked verse emits no sortOrderUpdates (got ${JSON.stringify(sortOrderUpdates)})`);
}

// An unlocked verse in the SAME call must still be canonicalized normally —
// the lock is per-verse, not a call-wide switch.
{
  console.log("\n[locked] an unlocked verse in the same book is still canonicalized");
  const lockedVerse = ultVerse(7, 1, [
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
  ]);
  const unlockedVerse = ultVerse(7, 2, [
    { content: "ד", text: "first" },
    { content: "ה", text: "second" },
  ]);
  const rows = [
    // locked verse (7:1), stored order deliberately reversed
    twl("l-b", 7, 1, "ב", 1, 100),
    twl("l-a", 7, 1, "א", 1, 200),
    // unlocked verse (7:2), stored order also reversed — must canonicalize
    twl("u-h", 7, 2, "ה", 1, 100),
    twl("u-d", 7, 2, "ד", 1, 200),
  ];
  const lockedVerses = new Set(["7:1"]); // locks 7:1 only (bucket key is chapter:verse)
  const { versePositions, sortOrderUpdates } = orderTwlRows(
    rows,
    [lockedVerse, unlockedVerse],
    null,
    lockedVerses,
  );

  // Locked bucket: stored order stands.
  assert(versePositions.get("l-b") === 0, "locked verse: stored order stands (l-b first)");
  assert(versePositions.get("l-a") === 1, "locked verse: stored order stands (l-a second)");

  // Unlocked bucket: canonicalized to ULT position (d before h).
  assert(versePositions.get("u-d") === 0, "unlocked verse: canonical order (u-d first)");
  assert(versePositions.get("u-h") === 1, "unlocked verse: canonical order (u-h second)");

  const updates = toMap(sortOrderUpdates);
  assert(
    JSON.stringify(updates) === JSON.stringify({ "u-d": 100, "u-h": 200 }),
    `only the unlocked verse's rows get sortOrderUpdates (got ${JSON.stringify(updates)})`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll twlCanonicalOrder tests passed.");

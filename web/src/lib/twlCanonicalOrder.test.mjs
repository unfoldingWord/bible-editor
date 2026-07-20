// Smoke test for the client canonicalTwlOrder — the ULT-position TWL ordering
// used to render the Words list + drop approved suggestions into the right slot.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/twlCanonicalOrder.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors twlResolve.test.mjs.
//
// PARITY: the fixtures + expected orderings below intentionally duplicate
// api/src/twlCanonicalOrder.test.mjs so the two implementations are pinned to the
// same canonical order (cross-workspace import under the strip-types runner is
// awkward). If you change one, change both. The one shape difference: the web
// buildUltSequenceMap/canonicalTwlOrder take verseObjects directly (web verse
// content is pre-parsed), so fixtures here are the verseObjects array, not a
// VerseRow.

import {
  canonicalTwlOrder,
  manualTwlOrder,
  twlDisplayOrder,
  buildUltSequenceMap,
  twlSortPosition,
  twlAnchorContext,
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

// verseObjects: each { content, text } becomes one \zaln milestone (content =
// Hebrew word) wrapping one \w word, in document order.
function ultVerseObjects(words) {
  return words.map((w) => ({
    type: "milestone",
    tag: "zaln",
    content: w.content,
    children: [{ type: "word", tag: "w", text: w.text }],
  }));
}

// A span-based verseObjects builder: each { content, texts } becomes one
// \zaln milestone (content = Hebrew/Greek word or phrase) wrapping MULTIPLE
// \w words, in document order. Mirrors api-side ultVerseSpans.
function spanVerseObjects(spans) {
  return spans.map((s) => ({
    type: "milestone",
    tag: "zaln",
    content: s.content,
    children: s.texts.map((t) => ({ type: "word", tag: "w", text: t })),
  }));
}

function twl(id, orig_words, occurrence, sort_order, tw_link = `rc://en/tw/dict/bible/kt/${id}`) {
  return { id, orig_words, occurrence, sort_order, tw_link };
}

const ids = (rows) => rows.map((r) => r.id);

// ─── ULT-position ordering ───────────────────────────────────────────────────
{
  console.log("\n[ordering] rows sequenced by ULT word position");
  const vo = ultVerseObjects([
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
    { content: "ג", text: "third" },
  ]);
  // Stored out of ULT order (g/a/b) — canonical order is a, b, g.
  const rows = [twl("g", "ג", 1, 100), twl("a", "א", 1, 200), twl("b", "ב", 1, 300)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["a", "b", "g"]),
    `canonical order a,b,g (got ${JSON.stringify(ordered)})`);
}

// ─── Occurrence keying (word#1 vs word#2) ────────────────────────────────────
{
  console.log("\n[occurrence] same OrigWords disambiguated by Occurrence");
  const vo = ultVerseObjects([
    { content: "ד", text: "x" }, // ד occurrence 1 → position 0
    { content: "ד", text: "y" }, // ד occurrence 2 → position 1
  ]);
  const rows = [twl("d2", "ד", 2, 100), twl("d1", "ד", 1, 200)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["d1", "d2"]),
    `ד#1 before ד#2 (got ${JSON.stringify(ordered)})`);

  const map = buildUltSequenceMap(vo);
  assert(twlSortPosition({ orig_words: "ד", occurrence: 1 }, map) === 0, "ד#1 → index 0");
  assert(twlSortPosition({ orig_words: "ד", occurrence: 2 }, map) === 1, "ד#2 → index 1");
}

// ─── Unaligned rows fall to the end, ordered by sort_order ───────────────────
{
  console.log("\n[unaligned] rows with no ULT match sink to the end by sort_order");
  const vo = ultVerseObjects([{ content: "ה", text: "h" }]);
  const rows = [
    twl("h", "ה", 1, 100),   // aligned → position 0
    twl("z1", "zz", 1, 300), // unaligned
    twl("z2", "yy", 1, 200), // unaligned, lower sort_order → before z1
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["h", "z2", "z1"]),
    `aligned first, then unaligned by sort_order (got ${JSON.stringify(ordered)})`);
}

// ─── Already-canonical input is stable ───────────────────────────────────────
{
  console.log("\n[stable] already-ordered rows keep their order");
  const vo = ultVerseObjects([
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
  ]);
  const rows = [twl("a", "א", 1, 100), twl("b", "ב", 1, 200)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["a", "b"]),
    `stable a,b (got ${JSON.stringify(ordered)})`);
  // Input not mutated.
  assert(JSON.stringify(ids(rows)) === JSON.stringify(["a", "b"]), "input array not mutated");
}

// ─── Null / missing ULT → falls back to sort_order ───────────────────────────
{
  console.log("\n[fallback] no ULT verse → order by sort_order");
  const rows = [twl("b", "ב", 1, 200), twl("a", "א", 1, 100)];
  const ordered = ids(canonicalTwlOrder(rows, null));
  assert(JSON.stringify(ordered) === JSON.stringify(["a", "b"]),
    `sort_order fallback a,b (got ${JSON.stringify(ordered)})`);
}

// ─── Nested alignment: OUTER milestone word resolves (ZEC 3:1 "high priest") ──
// The English words sit under the inner milestone; recording only the innermost
// left the outer word unresolved → sunk to the end. Now every stack level is
// recorded, so the outer word resolves to its span's first English index.
{
  console.log("\n[nested] OUTER word of a nested alignment resolves (not sunk to end)");
  const vo = [
    { type: "milestone", tag: "zaln", content: "ראשון", children: [{ type: "word", tag: "w", text: "joshua" }] },
    {
      type: "milestone", tag: "zaln", content: "חיצון", // OUTER — no direct \w
      children: [
        {
          type: "milestone", tag: "zaln", content: "פנימי", // INNER
          children: [
            { type: "word", tag: "w", text: "high" },
            { type: "word", tag: "w", text: "priest" },
          ],
        },
      ],
    },
    { type: "milestone", tag: "zaln", content: "אחרון", children: [{ type: "word", tag: "w", text: "standing" }] },
  ];
  const rows = [
    twl("first", "ראשון", 1, 100),
    twl("inner", "פנימי", 1, 200),
    twl("outer", "חיצון", 1, 300),
    twl("last", "אחרון", 1, 400),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["first", "inner", "outer", "last"]),
    `outer resolves before last (got ${JSON.stringify(ordered)})`);
}

// ─── Occurrence = SOURCE instance, not target-word count ─────────────────────
// foo aligned to 2 English words, then 'mid', then foo again. A link on the 2nd
// source occurrence of foo must land AFTER mid — not at the 1st foo's 2nd word.
{
  console.log("\n[occurrence-source] repeated word, first aligned to 2 English words");
  const vo = [
    {
      type: "milestone", tag: "zaln", content: "foo",
      children: [
        { type: "word", tag: "w", text: "aa" },
        { type: "word", tag: "w", text: "bb" },
      ],
    },
    { type: "milestone", tag: "zaln", content: "mid", children: [{ type: "word", tag: "w", text: "cc" }] },
    { type: "milestone", tag: "zaln", content: "foo", children: [{ type: "word", tag: "w", text: "dd" }] },
  ];
  const rows = [
    twl("fooA", "foo", 1, 100),
    twl("mid", "mid", 1, 200),
    twl("fooB", "foo", 2, 300),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["fooA", "mid", "fooB"]),
    `foo#2 lands after mid (got ${JSON.stringify(ordered)})`);
}

// ─── Nested-phrase OrigWords (JHN 1:1 gj8t: Greek "τὸν Θεόν") ────────────────
// Mirrors the api-side fixture. A TWL row can point at a multi-word source
// PHRASE spanning a nested article+noun milestone pair — OrigWords stores the
// concatenated phrase "τὸν Θεόν", matching neither milestone's own `content`
// alone. Regression for the live prod bug found on JHN 1:1.
{
  console.log("\n[nested-phrase] TWL row on a multi-word nested phrase resolves");
  const vo = [
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
  const rows = [
    twl("logos1", "λόγος", 1, 100),
    twl("logos2", "λόγος", 2, 200),
    twl("tonTheon", "τὸν Θεόν", 1, 300),
    twl("theos", "Θεὸς", 1, 400),
    twl("logos3", "λόγος", 3, 500),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["logos1", "logos2", "tonTheon", "logos3", "theos"]),
    `canonical order logos1,logos2,tonTheon,logos3,theos (got ${JSON.stringify(ordered)})`,
  );
}

// ─── Sibling-phrase OrigWords (LUK 17:20: Greek "Βασιλεία τοῦ Θεοῦ") ─────────
// Mirrors the api-side fixture. A multi-word phrase can span SIBLING top-level
// milestones, not just a nested parent→child chain: "Βασιλεία" is standalone,
// immediately followed by "τοῦ" (which nests "Θεοῦ"). Verified against prod
// LUK 17:20 content_json.
{
  console.log("\n[sibling-phrase] TWL row spanning sibling + nested milestones resolves");
  const vo = [
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
  const rows = [
    twl("the", "ἡ", 1, 100),
    twl("kingdomOfGod", "Βασιλεία τοῦ Θεοῦ", 1, 200),
    twl("coming", "ἔρχεται", 1, 300),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["the", "kingdomOfGod", "coming"]),
    `canonical order the,kingdomOfGod,coming (got ${JSON.stringify(ordered)})`,
  );
}

// ─── Repeated multi-word phrase, occurrence disambiguates (REV 3:12-style) ──
{
  console.log("\n[phrase-occurrence] repeated multi-word phrase disambiguated by Occurrence");
  const vo = [
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
  const rows = [
    twl("god1", "τοῦ Θεοῦ", 1, 100),
    twl("and", "καὶ", 1, 200),
    twl("god2", "τοῦ Θεοῦ", 2, 300),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["god1", "and", "god2"]),
    `canonical order god1,and,god2 (got ${JSON.stringify(ordered)})`,
  );
}

// ─── Same phrase text via DIFFERENT groupings — occurrence stays position-major ──
// Mirrors the api-side fixture. The identical normalized phrase text can arise
// two ways in one verse: a sibling pair (K=2) FIRST, then a single glued
// milestone (K=1) for the SAME words SECOND. Occurrence must stay
// position-major (left-to-right document order), not window-length-major.
{
  console.log("\n[phrase-occurrence-grouping] same phrase via sibling THEN glued milestone stays position-major");
  const vo = [
    { type: "milestone", tag: "zaln", content: "υἱοῦ", children: [{ type: "word", tag: "w", text: "Son1" }] },
    { type: "milestone", tag: "zaln", content: "θεοῦ", children: [{ type: "word", tag: "w", text: "God1" }] },
    { type: "milestone", tag: "zaln", content: "καὶ", children: [{ type: "word", tag: "w", text: "and" }] },
    { type: "milestone", tag: "zaln", content: "υἱοῦ θεοῦ", children: [{ type: "word", tag: "w", text: "Son2" }] },
  ];
  const rows = [
    twl("sonOfGod1", "υἱοῦ θεοῦ", 1, 100),
    twl("and", "καὶ", 1, 200),
    twl("sonOfGod2", "υἱοῦ θεοῦ", 2, 300),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["sonOfGod1", "and", "sonOfGod2"]),
    `canonical order sonOfGod1,and,sonOfGod2 (got ${JSON.stringify(ordered)})`,
  );
}

// ─── Phrase starts with a word that has no aligned English target ───────────
// Mirrors the api-side fixture.
{
  console.log("\n[leading-unaligned] phrase whose first word has no ULT alignment still resolves");
  const vo = [
    { type: "milestone", tag: "zaln", content: "πρῶτον", children: [{ type: "word", tag: "w", text: "First" }] },
    { type: "milestone", tag: "zaln", content: "καὶ", children: [] },
    { type: "milestone", tag: "zaln", content: "ἐλάλησεν", children: [{ type: "word", tag: "w", text: "spoke" }] },
  ];
  const rows = [
    twl("first", "πρῶτον", 1, 100),
    twl("andSpoke", "καὶ ἐλάλησεν", 1, 200),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["first", "andSpoke"]),
    `canonical order first,andSpoke (got ${JSON.stringify(ordered)})`,
  );
}

// ─── Unaligned occurrence #1 must still consume its occurrence slot ─────────
// Mirrors the api-side fixture (Codex regression).
{
  console.log("\n[unaligned-occurrence-slot] unaligned occurrence#1 doesn't steal occurrence#2's number");
  const vo = [
    { type: "milestone", tag: "zaln", content: "foo", children: [] },
    { type: "milestone", tag: "zaln", content: "foo", children: [{ type: "word", tag: "w", text: "Foo2" }] },
  ];
  const rows = [twl("foo2", "foo", 2, 100)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["foo2"]),
    `foo#2 resolves via its OWN occurrence number (got ${JSON.stringify(ordered)})`,
  );
  const map = buildUltSequenceMap(vo);
  assert(twlSortPosition({ orig_words: "foo", occurrence: 2 }, map) === 0, "foo#2 → index 0, not miscounted as foo#1");
}

// ─── Headword anchoring: tiers 1/2/3 pick the anchor inside one span ────────
{
  console.log("\n[headword-anchor] tiers 1/2/3 pick the anchor inside one span");
  const vo = spanVerseObjects([
    { content: "ק", texts: ["and", "the", "great", "house", "of"] },
  ]);
  const map = buildUltSequenceMap(vo);
  const row = twl("house", "ק", 1, 100);

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
  const plural = spanVerseObjects([
    { content: "ק", texts: ["and", "the", "houses", "of"] },
  ]);
  assert(
    twlSortPosition(
      twl("houses", "ק", 1, 100),
      buildUltSequenceMap(plural),
      { terms: ["house"], isName: false },
    ) === 2,
    "tier 1 matches inflected 'houses' (index 2) against headword 'house'",
  );

  // Tier 3: every word in the span is a function word — anchor on the first,
  // exactly as the pre-headword implementation did.
  const allFunction = spanVerseObjects([{ content: "ו", texts: ["and", "of"] }]);
  assert(
    twlSortPosition(twl("x", "ו", 1, 100), buildUltSequenceMap(allFunction), null) === 0,
    "tier 3: span is all function words → first word (index 0)",
  );

  // A single-word span is never skipped, even when that word is a function
  // word: there is nothing to skip TO, and skipping would strand the row.
  const lone = spanVerseObjects([{ content: "ה", texts: ["the"] }]);
  assert(
    twlSortPosition(twl("y", "ה", 1, 100), buildUltSequenceMap(lone), null) === 0,
    "single-word function-word span still resolves (index 0), not unresolved",
  );
}

// ─── Headword anchoring flips a nested pair ─────────────────────────────────
{
  console.log("\n[headword-reorders] headword anchoring flips a nested pair");
  // Outer milestone א wraps BOTH words; nested inner ב wraps only the first.
  // Pre-headword both anchored at index 0 (a tie broken by sort_order, so the
  // stored order stood). With headwords, א anchors on "beta" (1) and ב on
  // "alpha" (0), so ב now sorts FIRST regardless of sort_order.
  const vo = [
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
  // sort_order puts the outer row first — the order that stood before.
  const outer = twl("outerbeta", "א", 1, 100);
  const inner = twl("inneralpha", "ב", 1, 200);
  const rows = [outer, inner];

  const noTitles = ids(canonicalTwlOrder(rows, vo));
  assert(
    JSON.stringify(noTitles) === JSON.stringify(["outerbeta", "inneralpha"]),
    "without titles the stored order stands (outer, inner)",
  );

  const titles = new Map([
    [outer.tw_link, "# beta"],
    [inner.tw_link, "# alpha"],
  ]);
  const withTitles = ids(canonicalTwlOrder(rows, vo, titles));
  assert(
    JSON.stringify(withTitles) === JSON.stringify(["inneralpha", "outerbeta"]),
    "with titles the headwords reorder them (inner 'alpha' before outer 'beta')",
  );
}

// ─── tier 2 skips pronouns and auxiliaries too ──────────────────────────────
{
  console.log("\n[tier2-pronoun-aux] tier 2 skips pronouns and auxiliaries too");
  // Both cases come from the real-data measurement over 7 books: the headword
  // failed to match the ULT's wording, and tier 2 — when it skipped only
  // conjunctions/prepositions — stopped on a PRONOUN instead of the verb.
  // Pronouns + auxiliaries are now skipped, so it reaches the content word.
  const mic16 = spanVerseObjects([
    { content: "ק", texts: ["So", "I", "will", "make"] },
  ]);
  assert(
    twlSortPosition(twl("appoint", "ק", 1, 100), buildUltSequenceMap(mic16), null) === 3,
    "MIC 1:6 'So I will make' → 'make' (index 3), not the pronoun 'I'",
  );

  const mic35 = spanVerseObjects([
    { content: "ק", texts: ["then", "they", "call", "out"] },
  ]);
  assert(
    twlSortPosition(twl("declare", "ק", 1, 100), buildUltSequenceMap(mic35), null) === 2,
    "MIC 3:5 'then they call out' → 'call' (index 2), not the pronoun 'they'",
  );

  // "might" is an auxiliary AND the headword of other/mighty (251 live rows).
  // Tier 1 must claim it before tier 2 can skip it — this is what makes adding
  // auxiliaries to the skip list safe.
  const mighty = spanVerseObjects([{ content: "ק", texts: ["by", "his", "might"] }]);
  assert(
    twlSortPosition(
      twl("mighty", "ק", 1, 100),
      buildUltSequenceMap(mighty),
      { terms: ["might", "mighty"], isName: false },
    ) === 2,
    "tier 1 claims 'might' (index 2) even though it is also an auxiliary",
  );
  // …and with no headword context every word is skippable, so it falls to
  // tier 3 rather than returning nothing.
  assert(
    twlSortPosition(twl("mighty", "ק", 1, 100), buildUltSequenceMap(mighty), null) === 0,
    "same span with no headword → all words skippable → tier 3 first word (index 0)",
  );
}

// A `\zaln` milestone list where entries carry an explicit x-occurrence, so a
// single source word can be SPLIT into two non-contiguous chunks. Mirrors the
// api-side ultVerseOccSpans. Returns the verseObjects array directly (web
// buildUltSequenceMap/canonicalTwlOrder take verseObjects, not a VerseRow).
function ultVerseOccSpans(chapter, verse, spans) {
  return spans.map((s) => ({
    type: "milestone",
    tag: "zaln",
    content: s.content,
    occurrence: s.occurrence,
    occurrences: s.occurrences ?? 1,
    children: s.texts.map((t) => ({ type: "word", tag: "w", text: t })),
  }));
}

{
  console.log("\n[split-source-word] non-contiguous alignment reunites into one span");
  // ISA 60:6 shape: וּתְהִלֹּת (occ 1/1) → "and", then יְבַשֵּׂרוּ → "they will
  // proclaim", then וּתְהִלֹּת (occ 1/1 AGAIN) → "the praises of". One Hebrew
  // word rendered "and … the praises of". Before the fix the two chunks looked
  // like occurrence 1 and 2, so the praise row resolved to just "and" (index 0)
  // and sorted AHEAD of proclaim.
  const vo = ultVerseOccSpans(60, 6, [
    { content: "וּתהלת", occurrence: 1, texts: ["and"] },
    { content: "יבשרו", occurrence: 1, texts: ["they", "will", "proclaim"] },
    { content: "וּתהלת", occurrence: 1, texts: ["the", "praises", "of"] },
  ]);
  const map = buildUltSequenceMap(vo);

  const praise = twl("praise", "וּתהלת", 1, 100);
  const declare = twl("declare", "יבשרו", 1, 200);

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
  const ordered = ids(canonicalTwlOrder([praise, declare], vo, titles));
  assert(
    JSON.stringify(ordered) === JSON.stringify(["declare", "praise"]),
    "declare sorts BEFORE praise (the reported ISA 60:6 bug)",
  );
}

{
  console.log("\n[split-source-word] a genuinely REPEATED word still splits");
  // Guard against over-merging: same content but DIFFERENT x-occurrence is two
  // real instances and must stay two spans with independent occurrence numbers.
  const vo = ultVerseOccSpans(60, 7, [
    { content: "דבר", occurrence: 1, occurrences: 2, texts: ["first", "word"] },
    { content: "אחר", occurrence: 1, texts: ["middle"] },
    { content: "דבר", occurrence: 2, occurrences: 2, texts: ["second", "word"] },
  ]);
  const map = buildUltSequenceMap(vo);
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
  const vo = [
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
  const map = buildUltSequenceMap(vo);
  assert(map.has("דבר#1"), "nested doubled pair keeps occurrence #1");
  assert(
    map.has("דבר#2"),
    "nested doubled pair KEEPS occurrence #2 (a row with Occurrence=2 still resolves)",
  );
  assert(
    twlSortPosition(twl("w2", "דבר", 2, 100), map, null) === 0,
    "Occurrence=2 on the doubled word resolves to the word (index 0), not the verse tail",
  );
}

// ─── Unknown link falls through cleanly ─────────────────────────────────────
{
  console.log("\n[headword-missing-article] unknown link falls through cleanly");
  const vo = spanVerseObjects([
    { content: "ק", texts: ["and", "the", "great", "house"] },
  ]);
  const map = buildUltSequenceMap(vo);
  const row = twl("orphan", "ק", 1, 100);
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

// ─── Manual-order lock ───────────────────────────────────────────────────────
// Mirrors api/src/twlCanonicalOrder.test.mjs's [locked] cases. The whole point
// of the lock: a verse is EITHER automatic OR manual, never a blend, and the
// human's order is not re-derived from the ULT behind their back.
{
  console.log("\n[locked] a locked verse renders in the human's stored order");
  const vo = ultVerseObjects([
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
    { content: "ג", text: "third" },
  ]);
  // Stored order deliberately DISAGREES with ULT position: the human moved
  // "third" to the front and "first" to the back.
  const rows = [
    twl("a", "א", 1, 300),
    twl("b", "ב", 1, 200),
    twl("g", "ג", 1, 100),
  ];

  assert(
    ids(canonicalTwlOrder(rows, vo, null)).join(",") === "a,b,g",
    "unlocked: automatic ordering still follows ULT position (a,b,g)",
  );
  assert(
    ids(manualTwlOrder(rows)).join(",") === "g,b,a",
    "manual ordering follows stored sort_order (g,b,a)",
  );
  assert(
    ids(twlDisplayOrder(rows, vo, null, true)).join(",") === "g,b,a",
    "locked verse displays the human's order, NOT the ULT order",
  );
  assert(
    ids(twlDisplayOrder(rows, vo, null, false)).join(",") === "a,b,g",
    "unlocked verse displays the automatic order",
  );
  assert(
    ids(twlDisplayOrder(rows, vo, null)).join(",") === "a,b,g",
    "omitting the lock flag is exactly the pre-lock behaviour",
  );
}

{
  console.log("\n[locked] a manual verse with no stored order stays stable");
  // sort_order nulls sort last and keep their input order — a locked verse whose
  // rows were never renumbered must not shuffle at random.
  const rows = [twl("x", "א", 1, null), twl("y", "ב", 1, null), twl("z", "ג", 1, null)];
  assert(ids(manualTwlOrder(rows)).join(",") === "x,y,z", "all-null sort_order keeps input order");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll twlCanonicalOrder (web) tests passed.");

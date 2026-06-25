// Behaviour lock for the ported TWL matcher (api/src/twlMatcher.ts). A faithful
// fixture-vs-Rich's-lib comparison would need JSZip + live DCS; instead we pin
// the behaviours that define the port: term extraction/normalization, variant
// generation, longest/priority match, word boundaries, brace handling, and the
// God/falsegod capitalization rule. If a future edit drifts from upstream
// node-twl-generator semantics, one of these fails.

import assert from "node:assert/strict";
import { buildTermMapFromArticles, buildTermTrie, scanVerseMatches } from "./twlMatcher.ts";

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, `${msg}\n    got: ${JSON.stringify(a)}\n    exp: ${JSON.stringify(b)}`);
  console.log(`  ok: ${msg}`);
  passed++;
};

// ── term map extraction ──────────────────────────────────────────────────────
{
  const map = buildTermMapFromArticles([
    { id: "kt/god", title: "God" },
    { id: "kt/yahweh", title: "Yahweh, Yah" },
    { id: "names/joseph-ot", title: "Joseph (OT)" },
    { id: "kt/temple", title: "the temple" },
    { id: "kt/falsegod", title: "false god, god" },
  ]);
  eq(map["God"], ["kt/god"], "single heading -> one term/article");
  eq(map["Yahweh"], ["kt/yahweh"], "comma heading splits: Yahweh");
  eq(map["Yah"], ["kt/yahweh"], "comma heading splits: Yah");
  eq(map["Joseph"], ["names/joseph-ot"], "trailing parenthetical stripped");
  eq(map["temple"], ["kt/temple"], "leading article 'the' stripped");
  // "god" appears in falsegod's heading ("false god, god"); "God" in god's.
  eq(map["god"], ["kt/falsegod"], "lowercase 'god' term -> falsegod");
}

// ── variant generation + longest/priority match ──────────────────────────────
{
  const trie = buildTermTrie(
    buildTermMapFromArticles([
      { id: "kt/horse", title: "horse" },
      { id: "other/city", title: "city" },
      { id: "kt/lovegod", title: "love God" },
      { id: "kt/love", title: "love" },
    ]),
  );

  const horses = scanVerseMatches("the horses ran", trie);
  ok(
    horses.some((m) => m.matchedText.toLowerCase() === "horses" && m.articles.includes("kt/horse")),
    "plural 'horses' matches term 'horse' (variant)",
  );

  const cities = scanVerseMatches("many cities fell", trie);
  ok(
    cities.some((m) => m.matchedText.toLowerCase() === "cities" && m.articles.includes("other/city")),
    "'cities' matches term 'city' (y->ies variant)",
  );

  // "love God" (multi-word) must win over the single-word "love".
  const loveGod = scanVerseMatches("they love God deeply", trie);
  const first = loveGod.find((m) => m.matchedText.toLowerCase().startsWith("love"));
  ok(first && /love\s+god/i.test(first.matchedText), "longest match wins: 'love God' over 'love'");
}

// ── word boundaries ──────────────────────────────────────────────────────────
{
  const trie = buildTermTrie(buildTermMapFromArticles([{ id: "kt/god", title: "God" }]));
  const godly = scanVerseMatches("a godly man", trie);
  ok(!godly.some((m) => m.matchedText.toLowerCase() === "god"), "'godly' does NOT match 'god' (end boundary)");
  const standalone = scanVerseMatches("trust God today", trie);
  ok(standalone.some((m) => m.matchedText === "God"), "standalone 'God' matches");
}

// ── God / falsegod capitalization disambiguation ─────────────────────────────
{
  const trie = buildTermTrie(
    buildTermMapFromArticles([
      { id: "kt/god", title: "God" },
      { id: "kt/falsegod", title: "god, false god" },
    ]),
  );
  const capital = scanVerseMatches("the LORD our God", trie).find((m) => m.matchedText === "God");
  ok(capital && capital.preferredArticle === "kt/god", "capitalized 'God' -> preferred kt/god");
  const lower = scanVerseMatches("they served a god", trie).find((m) => m.matchedText.toLowerCase() === "god");
  ok(lower && lower.preferredArticle === "kt/falsegod", "lowercase 'god' -> preferred kt/falsegod");
  ok(capital.articles.includes("kt/god") && capital.articles.includes("kt/falsegod"), "both articles kept for disambiguation");
}

// ── supplied-word braces ─────────────────────────────────────────────────────
{
  const trie = buildTermTrie(buildTermMapFromArticles([{ id: "other/creature", title: "creature" }]));
  const m = scanVerseMatches("the creature{s} of the field", trie).find((x) =>
    x.matchedText.toLowerCase().includes("creature"),
  );
  ok(m && m.matchedText === "creature{s}", "brace-supplied 's' kept in matchedText, matched as 'creatures'");
}

console.log(`twlMatcher: ${passed} assertions passed`);

// Behaviour lock for api/src/twHeadword.ts — the shared "does this English
// word correspond to this TW article headword" logic factored out of
// twlMatcher.ts. Run from api/:
//   node --experimental-strip-types --no-warnings src/twHeadword.test.mjs
//
// PARITY: web/src/lib/twHeadword.test.mjs mirrors these cases against the
// web copy. If you change one, change both.

import assert from "node:assert/strict";
import { headwordTermsFromTitle, matchesHeadword, isFunctionWord } from "./twHeadword.ts";
import { buildTermMapFromArticles } from "./twlMatcher.ts";

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

// ── headwordTermsFromTitle ───────────────────────────────────────────────────
eq(headwordTermsFromTitle("# God, gods"), ["God", "gods"], "comma-split, case preserved, both present");
eq(headwordTermsFromTitle("# house"), ["house"], "single term");
eq(headwordTermsFromTitle("# the LORD"), ["LORD"], "leading determiner 'the' stripped");
eq(headwordTermsFromTitle("# Baal (deity)"), ["Baal"], "trailing parenthetical stripped");

// ── matchesHeadword ───────────────────────────────────────────────────────────
ok(matchesHeadword("houses", ["house"]), "plural variant matches");
ok(matchesHeadword("House,", ["house"]), "trailing punctuation stripped before match");
ok(!matchesHeadword("temple", ["house"]), "unrelated word does not match");
ok(matchesHeadword("God", ["god"]), "case-insensitive: capitalized word matches lowercase term");
ok(matchesHeadword("god", ["God"]), "case-insensitive: lowercase word matches capitalized term");

// ── isFunctionWord ────────────────────────────────────────────────────────────
ok(isFunctionWord("The"), "'The' is a function word (case-insensitive)");
ok(!isFunctionWord("house"), "'house' is not a function word");

// Pronouns
ok(isFunctionWord("I"), "'I' is a function word (pronoun)");
ok(isFunctionWord("they"), "'they' is a function word (pronoun)");
// Auxiliary/copular verbs
ok(isFunctionWord("was"), "'was' is a function word (copular verb)");
ok(isFunctionWord("might"), "'might' is a function word (auxiliary verb)");
// Lexical verbs are deliberately excluded, even ones that overlap with
// auxiliary spellings/senses ("make", "let", "call") — only true
// auxiliaries/copulas are skippable.
ok(!isFunctionWord("make"), "'make' is not a function word (lexical verb)");
ok(!isFunctionWord("let"), "'let' is not a function word (lexical verb)");
ok(!isFunctionWord("call"), "'call' is not a function word (lexical verb)");

// "might" is both an auxiliary AND the headword of other/mighty — tier 1 must
// claim it for the headword before tier 2 could skip it as an auxiliary. This
// is what makes adding auxiliaries to the skip list safe.
ok(matchesHeadword("might", ["might", "mighty"]), "'might' matches headword terms ['might', 'mighty']");

// ── buildTermMapFromArticles still keeps God/god distinct ───────────────────
// Guards against a future refactor silently re-collapsing the two entries
// headwordTermsFromTitle's case-preservation exists to keep apart.
{
  const map = buildTermMapFromArticles([
    { id: "kt/god", title: "God" },
    { id: "kt/falsegod", title: "false god, god" },
  ]);
  eq(map["God"], ["kt/god"], "buildTermMapFromArticles: 'God' key -> kt/god");
  eq(map["god"], ["kt/falsegod"], "buildTermMapFromArticles: 'god' key -> kt/falsegod");
}

console.log(`twHeadword: ${passed} assertions passed`);

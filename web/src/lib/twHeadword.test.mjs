// Behaviour lock for web/src/lib/twHeadword.ts — the client mirror of
// api/src/twHeadword.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/twHeadword.test.mjs
//
// PARITY: mirrors api/src/twHeadword.test.mjs's cases against the web copy
// (the buildTermMapFromArticles case is web-side N/A since that function
// lives only in twlMatcher.ts, api-only — so this file covers only the
// twHeadword.ts surface, which is what's actually mirrored client-side).
// If you change one, change both.

import assert from "node:assert/strict";
import { headwordTermsFromTitle, matchesHeadword, isFunctionWord } from "./twHeadword.ts";

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

console.log(`twHeadword (web): ${passed} assertions passed`);

// The suggest route's glOccurrence must count the way the client's run picker
// does (issue #1436). The route scans a verse's plain text with the TW matcher
// and numbers each match; the client (web/src/lib/twlResolve.ts pickRun) finds
// the glOccurrence-th contiguous run of the span's words among the ULT's `\w`
// tokens. A possessive is one match on the route ("Solomon's") but two tokens
// on the client ("Solomon" + "s"), and a phrase match ("Yahweh of Armies")
// hides the word it starts with from a per-string count. Either way the next
// bare word got a number one too low and resolved to the wrong Hebrew word.
// These cases drive the real pieces end to end: extractPlainText -> matcher ->
// glOccurrences -> regroup / resolve.

import assert from "node:assert/strict";
import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlainText } from "./importParsers.ts";
import { buildTermMapFromArticles, buildTermTrie, scanVerseMatches } from "./twlMatcher.ts";
import { glOccurrences } from "./twlGlOccurrence.ts";
import { regroupTwlSuggestionsByXref, resolveSpanToSource } from "../../web/src/lib/twlResolve.ts";
import { nfc } from "../../web/src/lib/hebrew.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// What the route builds for one verse: every match with its glOccurrence.
const suggest = (verseObj, articles) => {
  const text = extractPlainText(verseObj);
  const matches = scanVerseMatches(text, buildTermTrie(buildTermMapFromArticles(articles)));
  const occ = glOccurrences(text, matches);
  return matches.map((m, i) => ({ matchedText: m.matchedText, glOccurrence: occ[i] }));
};
const names = (list) => list.map((s) => `${s.matchedText}#${s.glOccurrence}`);

const w = (text, occurrence, occurrences = occurrence) => ({
  type: "word",
  tag: "w",
  text,
  occurrence: String(occurrence),
  occurrences: String(occurrences),
});
const zaln = (content, occurrence, occurrences, children) => ({
  type: "milestone",
  tag: "zaln",
  content,
  occurrence: String(occurrence),
  occurrences: String(occurrences),
  children,
});
const t = (text) => ({ type: "text", text });

// --- an ordinary verse: "Solomon’s servants ... Solomon" ---------------------
{
  console.log("\n[possessive] ordinary verse");
  const uhb = [w("שְׁלֹמֹה", 1, 2), t(" "), w("עֶבֶד", 1, 1), t(" "), w("שְׁלֹמֹה", 2, 2)];
  const ult = [
    zaln("שְׁלֹמֹה", 1, 2, [w("Solomon", 1, 2), t("’"), w("s", 1)]),
    t(" "),
    zaln("עֶבֶד", 1, 1, [w("servants", 1)]),
    t(" "),
    w("came", 1),
    t(" "),
    w("to", 1),
    t(" "),
    zaln("שְׁלֹמֹה", 2, 2, [w("Solomon", 2, 2)]),
    t("."),
  ];
  const got = suggest({ verseObjects: ult }, [{ id: "names/solomon", title: "Solomon" }]);
  check(
    JSON.stringify(names(got)) === JSON.stringify(["Solomon's#1", "Solomon#2"]),
    `the bare Solomon after "Solomon’s" is the 2nd Solomon (got ${JSON.stringify(names(got))})`,
  );
  const bare = got[1];
  const r = resolveSpanToSource(ult, uhb, bare.matchedText, bare.glOccurrence);
  check(
    r && r.occurrence === 2 && r.confident,
    `bare Solomon resolves to the 2nd שְׁלֹמֹה (got ${JSON.stringify(r)})`,
  );
  const poss = resolveSpanToSource(ult, uhb, got[0].matchedText, got[0].glOccurrence);
  check(
    poss && poss.occurrence === 1 && poss.confident,
    `"Solomon’s" still resolves to the 1st שְׁלֹמֹה (got ${JSON.stringify(poss)})`,
  );
}

// --- a phrase match hides its first word from a per-string count -------------
{
  console.log("\n[phrase] Yahweh of Armies ... Yahweh");
  const uhb = [w("יְהוָה", 1, 2), t(" "), w("צְבָאוֹת", 1, 1), t(" "), w("יְהוָה", 2, 2)];
  const ult = [
    zaln("יְהוָה", 1, 2, [w("Yahweh", 1, 2)]),
    t(" "),
    zaln("צְבָאוֹת", 1, 1, [w("of", 1), t(" "), w("Armies", 1)]),
    t(" "),
    w("says", 1),
    t(" "),
    zaln("יְהוָה", 2, 2, [w("Yahweh", 2, 2)]),
    t("."),
  ];
  const got = suggest({ verseObjects: ult }, [
    { id: "kt/yahweh", title: "Yahweh" },
    { id: "kt/yahwehofhosts", title: "Yahweh of Armies" },
  ]);
  check(
    JSON.stringify(names(got)) === JSON.stringify(["Yahweh of Armies#1", "Yahweh#2"]),
    `the lone Yahweh is the 2nd "Yahweh" run (got ${JSON.stringify(names(got))})`,
  );
  const r = resolveSpanToSource(ult, uhb, got[1].matchedText, got[1].glOccurrence);
  check(r && r.occurrence === 2 && r.confident, `lone Yahweh -> 2nd יְהוָה (got ${JSON.stringify(r)})`);
}

// --- no possessive, no phrase: the numbers are what they always were ---------
{
  console.log("\n[plain] ordinary repeats");
  const ult = [w("God", 1, 2), t(" "), w("saw", 1), t(" "), w("God", 2, 2), t(", "), w("{the}", 1), t(" "), w("god", 1)];
  const got = suggest({ verseObjects: ult }, [{ id: "kt/god", title: "God" }]);
  check(
    JSON.stringify(names(got)) === JSON.stringify(["God#1", "God#2", "god#3"]),
    `God, God, god count 1, 2, 3 (got ${JSON.stringify(names(got))})`,
  );
}

// --- the real 2CH 9:10-12 bridge (UST standing in for a bridged ULT) ---------
// "Solomon" (9:12), "Solomon’s" (9:10), then "Solomon" (9:11, under the
// הַמֶּלֶךְ milestone with "King"). The route's second bare Solomon is the third
// "Solomon" run on the client.
{
  console.log("\n[possessive] 2CH 9:10-12 bridge");
  const here = dirname(fileURLToPath(import.meta.url));
  const samples = resolve(here, "../../docs/samples");
  const json = usfm.toJSON(readFileSync(resolve(samples, "en_ust_14-2CH-9_10-12.usfm"), "utf8"));
  const uhbJson = usfm.toJSON(readFileSync(resolve(samples, "hbo_uhb_14-2CH-9_10-12.usfm"), "utf8"));
  const uhbOf = (v) => uhbJson.chapters["9"][String(v)].verseObjects;
  const row = json.chapters["9"]["10-12"];
  const bridge = row.verseObjects;

  const got = suggest(row, [{ id: "names/solomon", title: "Solomon" }]);
  check(
    JSON.stringify(names(got)) === JSON.stringify(["Solomon#1", "Solomon's#1", "Solomon#3"]),
    `route numbers the bare Solomons 1 and 3 (got ${JSON.stringify(names(got))})`,
  );

  const groups = regroupTwlSuggestionsByXref(
    [
      { verse: 10, suggestions: got },
      { verse: 11, suggestions: [] },
      { verse: 12, suggestions: [] },
    ],
    9,
    (v) => (v >= 10 && v <= 12 ? bridge : undefined),
  );
  const byVerse = Object.fromEntries(groups.map((g) => [g.verse, names(g.suggestions)]));
  check(
    JSON.stringify(byVerse) === JSON.stringify({ 10: ["Solomon's#1"], 11: ["Solomon#3"], 12: ["Solomon#1"] }),
    `each Solomon sits under its own verse (got ${JSON.stringify(byVerse)})`,
  );

  const second = got[2];
  const r11 = resolveSpanToSource(bridge, uhbOf(11), second.matchedText, second.glOccurrence, "9:11");
  check(
    r11 && nfc(r11.orig_words) === nfc("הַ֠⁠מֶּלֶךְ") && r11.confident,
    `the second bare Solomon resolves to 9:11's Hebrew, not 9:10's שְׁלֹמֹה (got ${JSON.stringify(r11)})`,
  );
  const poss = resolveSpanToSource(bridge, uhbOf(10), got[1].matchedText, got[1].glOccurrence, "9:10");
  check(
    poss && nfc(poss.orig_words) === nfc("שְׁלֹמֹ֔ה") && poss.confident,
    `"Solomon’s" resolves to 9:10's שְׁלֹמֹה (got ${JSON.stringify(poss)})`,
  );
}

console.log(`\ntwlGlOccurrence: ${passed} passed`);

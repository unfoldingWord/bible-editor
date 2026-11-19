// Aligner round trip for a bridged target verse whose milestones count source
// occurrences PER SOURCE VERSE and name that verse in `x-ref` — the tCore format
// the published UST uses (issue #1401). Fixture: 2CH 9:10-12 from
// unfoldingWord/en_ust master and the matching UHB verses.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/bridgeAlignment.test.mjs

import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAlignment,
  serializeAlignment,
  clearGroup,
  moveSource,
  moveTargets,
  moveTarget,
  dropDuplicateSourceMilestones,
} from "./alignment.ts";
import { buildSourceIndexMap, resolveSourcePos, reusedTokenKey } from "./alignmentHover.ts";
import { concatSourceRange } from "./verseRange.ts";
import { nfc } from "./hebrew.ts";

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../../../docs/samples");
let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────
const ustRaw = readFileSync(resolve(samples, "en_ust_14-2CH-9_10-12.usfm"), "utf8");
const uhbRaw = readFileSync(resolve(samples, "hbo_uhb_14-2CH-9_10-12.usfm"), "utf8");

function freshTarget() {
  const json = usfm.toJSON(ustRaw);
  return { json, vo: json.chapters["9"]["10-12"].verseObjects };
}
const uhbJson = usfm.toJSON(uhbRaw);
const sourceByVerse = {};
for (const v of [10, 11, 12]) {
  sourceByVerse[v] = {
    chapter: 9,
    verse: v,
    verse_end: null,
    content: { verseObjects: uhbJson.chapters["9"][String(v)].verseObjects },
  };
}
// The source the aligner actually gets for a bridge (Shell → concatSourceRange).
const bridgeSource = concatSourceRange(sourceByVerse, 10, 12);
const svo = bridgeSource.content.verseObjects;

function verseUsfm(json, vo) {
  json.chapters["9"]["10-12"].verseObjects = vo;
  return usfm.toUSFM(json, { forcedNewLines: true });
}
function milestones(vo) {
  const out = [];
  const walk = (ns) => {
    for (const n of ns ?? []) {
      if (n?.tag === "zaln") out.push({ content: n.content, occurrence: n.occurrence, occurrences: n.occurrences, ref: n.ref });
      walk(n?.children);
    }
  };
  walk(vo);
  return out;
}
const baseline = (() => {
  const { json, vo } = freshTarget();
  return verseUsfm(json, vo);
})();

// ── 1. untouched round trip ──────────────────────────────────────────────────
{
  console.log("\n[1] 2CH 9:10-12 UST: load → save with no change is byte-identical");
  const { json, vo } = freshTarget();
  const before = milestones(vo);
  assert(before.length === 65 && before.every((m) => m.ref), "fixture: 65 milestones, every one carries x-ref");
  const out = serializeAlignment(parseAlignment(vo, svo));
  const after = milestones(out);
  const lostRef = after.filter((m) => !m.ref).length;
  assert(lostRef === 0, `every milestone keeps its x-ref (lost on ${lostRef})`);
  const renumbered = before.filter(
    (m, i) => !after[i] || after[i].occurrence !== m.occurrence || after[i].occurrences !== m.occurrences,
  ).length;
  assert(renumbered === 0, `no milestone is renumbered to whole-bridge counts (${renumbered} were)`);
  assert(verseUsfm(json, out) === baseline, "serialized USFM equals the Door43 text byte for byte");
}

// ── 2. re-aligning a cleared word writes tCore's per-verse count + x-ref ────
{
  console.log("\n[2] clear אֶת כָּל (9:12) → reload → re-align: placeholder carries the per-verse count and x-ref");
  const { json, vo } = freshTarget();
  const state = parseAlignment(vo, svo);
  const g = state.groups.find((x) => x.source.length === 2 && nfc(x.source[0].content) === nfc("אֶת") && x.source[0].ref === "9:12");
  assert(!!g, "found the אֶת+כָּל compound on 'many things in Jerusalem'");
  if (g) {
    const targetIds = g.targets.map((t) => t.id);
    const cleared = serializeAlignment(clearGroup(state, g.id));
    // Reload: the cleared source words now come back as placeholders built
    // from the source text — the path every newly aligned word takes.
    const reloaded = parseAlignment(cleared, svo);
    const ph = (content) =>
      reloaded.sourceGroups.find(
        (x) => x.targets.length === 0 && x.source.length === 1 && nfc(x.source[0].content) === nfc(content) && x.source[0].ref === "9:12",
      );
    const et = ph("אֶת");
    const kol = ph("כָּל");
    assert(!!et && et.source[0].occurrence === "1" && et.source[0].occurrences === "1",
      `placeholder אֶת counts within 9:12 (got ${et?.source[0].occurrence}/${et?.source[0].occurrences} ref=${et?.source[0].ref})`);
    assert(!!kol, "placeholder כָּל carries ref 9:12");
    if (et && kol) {
      let s = moveSource(reloaded, kol.source[0].id, et.id);
      const words = s.unaligned.filter((w) => ["many", "things", "in", "Jerusalem"].includes(w.text));
      s = moveTargets(s, words.map((w) => w.id), `g:${et.id}`);
      const out = serializeAlignment(s);
      assert(targetIds.length === 4 && words.length === 4, "the four target words moved back");
      assert(verseUsfm(json, out) === baseline, "re-aligned verse equals the Door43 text byte for byte");
    }
  }
}

// ── 3. one drag leaves every other milestone untouched ───────────────────────
{
  console.log("\n[3] unalign one word: every other milestone is byte-identical");
  const { json, vo } = freshTarget();
  const state = parseAlignment(vo, svo);
  const word = state.stream.find((x) => x.kind === "word" && x.word.text === "Ophir");
  const out = serializeAlignment(moveTarget(state, word.word.id, "u"));
  // The מֵאוֹפִיר milestone now closes after "to"; "Ophir" stands outside it.
  const want = baseline.replace(
    String.raw`\w to|x-occurrence="4" x-occurrences="7"\w*` + "\n" + String.raw`\w Ophir|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*,`,
    String.raw`\w to|x-occurrence="4" x-occurrences="7"\w*\zaln-e\*` + "\n" + String.raw`\w Ophir|x-occurrence="1" x-occurrences="1"\w*,`,
  );
  const got = verseUsfm(json, out);
  assert(want !== baseline, "expected text differs from the baseline only at 'Ophir'");
  assert(got === want, "only the 'Ophir' milestone boundary changed");
  const after = milestones(out);
  assert(after.length === 65 && after.every((m) => m.ref), "all 65 milestones keep x-ref after the drag");
}

// ── 4. the panel resolves an x-ref'd word inside its own source verse ─────────
{
  console.log("\n[4] resolveSourcePos honours x-ref inside a bridge");
  const indexMap = buildSourceIndexMap(bridgeSource);
  const { vo } = freshTarget();
  const state = parseAlignment(vo, svo);
  const et = state.groups.find((x) => nfc(x.source[0].content) === nfc("אֶת") && x.source[0].ref === "9:12")?.source[0];
  assert(!!et, "the parsed אֶת milestone carries ref 9:12");
  const pos = et ? resolveSourcePos(et, indexMap) : -1;
  // Position of the first אֶת in 9:12 = number of \w words in 9:10 + 9:11 + its index in 9:12.
  const wordsIn = (v) => {
    const out = [];
    const w = (ns) => { for (const n of ns ?? []) { if (n?.type === "word" && n.tag === "w") out.push(n.text); else if (n?.type === "milestone") w(n.children); } };
    w(sourceByVerse[v].content.verseObjects);
    return out;
  };
  const expected = wordsIn(10).length + wordsIn(11).length + wordsIn(12).findIndex((t) => nfc(t) === nfc("אֶת"));
  assert(pos === expected, `אֶת ref 9:12 resolves to its 9:12 token (pos ${pos}, want ${expected})`);
}

// ── 4b. an x-ref'd word that misses its own verse stays in that verse (#1414) ─
// אֶת occurs once in 9:11 and once in 9:12. A milestone claiming אֶת 2 in 9:11
// (more than that verse holds) used to fall through to the whole-bridge key
// t:אֶת|2, which is 9:12's token. It must resolve inside 9:11, and the reused-
// token identity must not collide with 9:12's אֶת either.
{
  console.log("\n[4b] an x-ref'd fallback resolves inside the named verse");
  const indexMap = buildSourceIndexMap(bridgeSource);
  const wordsIn = (v) => {
    const out = [];
    const w = (ns) => { for (const n of ns ?? []) { if (n?.type === "word" && n.tag === "w") out.push(n.text); else if (n?.type === "milestone") w(n.children); } };
    w(sourceByVerse[v].content.verseObjects);
    return out;
  };
  const in11 = wordsIn(10).length + wordsIn(11).findIndex((t) => nfc(t) === nfc("אֶת"));
  const in12 = wordsIn(10).length + wordsIn(11).length + wordsIn(12).findIndex((t) => nfc(t) === nfc("אֶת"));
  const over = { id: "x", strong: "H0853", occurrence: "2", occurrences: "2", content: "אֶת", ref: "9:11" };
  const pos = resolveSourcePos(over, indexMap);
  assert(pos === in11, `אֶת 2 x-ref 9:11 resolves to 9:11's token, not 9:12's (pos ${pos}, want ${in11}, 9:12 is ${in12})`);
  const k11 = reusedTokenKey(over, indexMap);
  const k12 = reusedTokenKey({ ...over, occurrence: "1", occurrences: "1", ref: "9:12" }, indexMap);
  assert(k11 !== k12, `reused-token identity keeps 9:11 and 9:12 apart (${k11} vs ${k12})`);
}

// ── 5. a legacy whole-bridge-numbered verse (no x-ref) is unchanged ──────────
{
  console.log("\n[5] legacy span convention (no x-ref) round-trips untouched");
  const target = String.raw`\id 2CH
\c 9
\p
\v 10-11 \zaln-s |x-strong="H0853" x-lemma="אֵת" x-morph="He,To" x-occurrence="1" x-occurrences="2" x-content="אֶת"\*\w one|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="H0853" x-lemma="אֵת" x-morph="He,To" x-occurrence="2" x-occurrences="2" x-content="אֶת"\*\w two|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const source = String.raw`\id 2CH
\c 9
\v 10 \w אֶת|lemma="אֵת" strong="H0853" x-morph="He,To"\w*
\v 11 \w אֶת|lemma="אֵת" strong="H0853" x-morph="He,To"\w*
`;
  const tj = usfm.toJSON(target);
  const sj = usfm.toJSON(source);
  const src = concatSourceRange({
    10: { chapter: 9, verse: 10, content: { verseObjects: sj.chapters["9"]["10"].verseObjects } },
    11: { chapter: 9, verse: 11, content: { verseObjects: sj.chapters["9"]["11"].verseObjects } },
  }, 10, 11);
  const vo = tj.chapters["9"]["10-11"].verseObjects;
  const base = usfm.toUSFM(tj, { forcedNewLines: true });
  tj.chapters["9"]["10-11"].verseObjects = serializeAlignment(parseAlignment(vo, src.content.verseObjects));
  assert(usfm.toUSFM(tj, { forcedNewLines: true }) === base, "1/2 and 2/2 without x-ref stay as they are");
}

// ── 6. x-ref on a non-bridged verse (2CH 7:4 shape) survives the round trip ──
{
  console.log("\n[6] x-ref on a single verse is preserved");
  const target = String.raw`\id 2CH
\c 7
\p
\v 4 \zaln-s |x-strong="H3068" x-lemma="יְהֹוָה" x-morph="He,Np" x-occurrence="1" x-occurrences="1" x-content="יְהוָֽה" x-ref="7:4"\*\w Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*.
`;
  const source = String.raw`\id 2CH
\c 7
\v 4 \w יְהוָֽה|lemma="יְהֹוָה" strong="H3068" x-morph="He,Np"\w*׃
`;
  const tj = usfm.toJSON(target);
  const sj = usfm.toJSON(source);
  const vo = tj.chapters["7"]["4"].verseObjects;
  const base = usfm.toUSFM(tj, { forcedNewLines: true });
  tj.chapters["7"]["4"].verseObjects = serializeAlignment(parseAlignment(vo, sj.chapters["7"]["4"].verseObjects));
  assert(usfm.toUSFM(tj, { forcedNewLines: true }) === base, "x-ref=\"7:4\" kept");
}

// ── 7. doubled-source dedup: same surface 1/1 in two bridged verses is not a duplicate ─
{
  console.log("\n[7] dropDuplicateSourceMilestones keeps אֶת 1/1 of 9:11 and אֶת 1/1 of 9:12 in one card");
  const z = (ref, children) => ({ tag: "zaln", type: "milestone", strong: "H0853", content: "אֶת", occurrence: "1", occurrences: "1", ref, children, endTag: "zaln-e\\*" });
  const card = [z("9:11", [z("9:12", [{ text: "them", tag: "w", type: "word", occurrence: "1", occurrences: "1" }])])];
  assert(dropDuplicateSourceMilestones(card) === card, "two verses' tokens are not collapsed");
  const dup = [z("9:12", [z("9:12", [{ text: "them", tag: "w", type: "word", occurrence: "1", occurrences: "1" }])])];
  assert(dropDuplicateSourceMilestones(dup) !== dup, "the same verse's token twice is still collapsed");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall bridge alignment checks passed");

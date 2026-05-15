// Smoke test for alignment.ts against the Selah, footnote, and
// poetry-paragraph cases catalogued in docs/usfm-alignment-audit.md.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/alignment.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors
// api/src/importParsers.test.mjs.

import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAlignment,
  serializeAlignment,
  alignmentPlainText,
  verseHasUnalignedWork,
} from "./alignment.ts";
import { extractPlainText } from "./usfm.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function parseSingleVerse(rawUsfm) {
  const json = usfm.toJSON(rawUsfm);
  const ch = Object.keys(json.chapters)[0];
  const v = Object.keys(json.chapters[ch]).find((k) => /^\d+$/.test(k));
  return { json, ch, v, verseObjects: json.chapters[ch][v].verseObjects };
}

function roundtripVerseUsfm(rawUsfm, sourceVO = null) {
  const { json, ch, v, verseObjects } = parseSingleVerse(rawUsfm);
  const state = parseAlignment(verseObjects, sourceVO);
  const out = serializeAlignment(state);
  json.chapters[ch][v].verseObjects = out;
  return usfm.toUSFM(json, { forcedNewLines: true });
}

// ─── Case 1: Selah at verse end (production ULT shape) ──────────────────
{
  console.log("\n[Case 1] Selah at verse end — production ULT shape");
  const target = String.raw`\id PSA
\c 3
\p
\v 8 \q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*
`;
  const source = String.raw`\id PSA
\c 3
\v 8 \w יְהוָה|x-strong="H3068" x-occurrence="1"\w* \w סֶלָה|x-strong="H5542" x-occurrence="1"\w*
`;
  const targetJson = usfm.toJSON(target);
  const sourceJson = usfm.toJSON(source);
  const tvo = targetJson.chapters["3"]["8"].verseObjects;
  const svo = sourceJson.chapters["3"]["8"].verseObjects;
  const state = parseAlignment(tvo, svo);

  // (a) Source group exists for H5542.
  const selahGroup = state.sourceGroups.find((g) => g.source.some((s) => s.strong === "H5542"));
  assert(!!selahGroup, "source group exists for H5542 (Selah)");

  // (b) "Selah" enters the stream as a word with alignedTo === selahGroup.id.
  const selahWord = state.stream.find(
    (item) => item.kind === "word" && item.word.text === "Selah",
  );
  assert(!!selahWord, "Selah enters the stream as a word");
  assert(selahWord && selahWord.alignedTo === selahGroup?.id, "Selah is aligned to the H5542 group");

  // (c) plain text contains "Selah" and matches extractPlainText on the
  // (re-serialized) verseObjects.
  const plain = alignmentPlainText(state);
  assert(plain.includes("Selah"), "alignmentPlainText includes 'Selah'");
  const importerPlain = extractPlainText(tvo);
  assert(plain === importerPlain, `alignmentPlainText matches importer extractPlainText (got ${JSON.stringify(plain)} vs ${JSON.stringify(importerPlain)})`);

  // (d) verseHasUnalignedWork is false (every UHB word is aligned).
  assert(!verseHasUnalignedWork(tvo, svo), "verseHasUnalignedWork returns false for fully-aligned Selah verse");

  // (e) round-trip preserves the \qs wrapper around the Selah \zaln-s.
  const rt = roundtripVerseUsfm(target, svo);
  assert(/\\qs[\s\S]*\\zaln-s[\s\S]*\\w Selah\|/.test(rt), "round-trip keeps \\qs wrapping the Selah \\zaln-s");
  assert(/\\zaln-e\\\*\s*\\qs\*/.test(rt) || /\\zaln-e\\\*\\qs\*/.test(rt), "round-trip closes \\zaln-e* before \\qs*");
}

// ─── Case 2: Mid-verse footnote ─────────────────────────────────────────
{
  console.log("\n[Case 2] Mid-verse footnote");
  const target = String.raw`\id PSA
\c 3
\v 11 \zaln-s |x-strong="H1697"\*\w Word|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\f + \ft From the Hebrew\f* \zaln-s |x-strong="H3068"\*\w of the LORD|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const rt = roundtripVerseUsfm(target);
  // Footnote position preserved between the two aligned blocks.
  assert(
    /\\w Word\|[^\n]*\\w\*\\zaln-e\\\*\s*\\f \+ \\ft From the Hebrew\\f\*\s*\\zaln-s/.test(rt) ||
      /\\zaln-e\\\*\\f \+ \\ft From the Hebrew\\f\*\s*\\zaln-s/.test(rt),
    "footnote stays between the two alignment milestones (mid-verse position preserved)",
  );
  // Footnote not appended at end of verse.
  assert(
    !/\\zaln-e\\\*\s*\n?\s*\\f \+ \\ft From the Hebrew\\f\*\s*\n?\s*$/.test(rt.split(/\\v\s+\d+/).pop() ?? ""),
    "footnote is NOT appended at verse end",
  );
}

// ─── Case 3: Bare \qs Selah\qs* (no inner alignment) ────────────────────
{
  console.log("\n[Case 3] Bare \\qs Selah\\qs* (no inner alignment)");
  const target = String.raw`\id PSA
\c 3
\v 10 \zaln-s |x-strong="H7965"\*\w Peace|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs Selah\qs*
`;
  const { verseObjects } = parseSingleVerse(target);
  const state = parseAlignment(verseObjects, null);
  const plain = alignmentPlainText(state);
  assert(plain.includes("Selah"), "alignmentPlainText includes Selah for bare \\qs Selah\\qs*");
  assert(plain.includes("Peace"), "alignmentPlainText includes Peace");
  const rt = roundtripVerseUsfm(target);
  assert(/\\qs[\s\S]*Selah[\s\S]*\\qs\*/.test(rt), "round-trip preserves \\qs Selah\\qs* block");
  // No bare extra "Selah" at end of verse (i.e. it stays inside qs).
  assert(!/\\qs\*\s*Selah/.test(rt), "Selah does not leak outside its \\qs* close");
}

// ─── Case 4: Multiple \q1/\q2 paragraph markers in poetry ───────────────
{
  console.log("\n[Case 4] Poetry paragraph markers preserved in order");
  const target = String.raw`\id PSA
\c 3
\p
\v 2 \q1 \zaln-s |x-strong="H7227"\*\w Many|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\q2 \zaln-s |x-strong="H0559a"\*\w say|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\q1 \zaln-s |x-strong="H0853"\*\w to|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const rt = roundtripVerseUsfm(target);
  // q1, q2, q1 markers should appear in original order, each followed by
  // its zaln-s.
  const order = [...rt.matchAll(/\\q([12])\b/g)].map((m) => m[1]);
  assert(order.length >= 3, `at least 3 q-markers present (got ${order.length})`);
  assert(order[0] === "1" && order[1] === "2" && order[2] === "1", `poetry paragraph order preserved (got ${order.join(",")})`);
}

// ─── Case 5: No-op save regression for Selah verse ──────────────────────
{
  console.log("\n[Case 5] No-op save preserves content_json and plain_text");
  const target = String.raw`\v 8 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*`;
  // Wrap in a minimal chapter so usfm-js will parse the verse.
  const wrapped = `\\id PSA\n\\c 3\n\\p\n${target}\n`;
  const { verseObjects: vo } = parseSingleVerse(wrapped);
  const stateA = parseAlignment(vo, null);
  const plainA = alignmentPlainText(stateA);
  const reVO = serializeAlignment(stateA);
  // Reparse the serialized output and confirm structural stability.
  const stateB = parseAlignment(reVO, null);
  const plainB = alignmentPlainText(stateB);
  assert(plainA === plainB, "plain text stable across parse → serialize → parse cycle");
  assert(
    stateA.stream.filter((s) => s.kind === "word").length ===
      stateB.stream.filter((s) => s.kind === "word").length,
    "stream word count stable",
  );
  // Source group count stable.
  assert(stateA.sourceGroups.length === stateB.sourceGroups.length, "source group count stable");
}

// ─── Case 6: OBA round-trip parity ──────────────────────────────────────
{
  console.log("\n[Case 6] OBA round-trip preserves alignment marker counts");
  const obaPath = resolve(repoRoot, "docs/samples/31-OBA.usfm");
  const original = readFileSync(obaPath, "utf8");
  const json = usfm.toJSON(original);
  // Walk every verse: parse + serialize, swap in place.
  for (const chKey of Object.keys(json.chapters)) {
    const chapterObj = json.chapters[chKey];
    for (const vKey of Object.keys(chapterObj)) {
      if (!/^\d+(-\d+)?$/.test(vKey)) continue;
      const vo = chapterObj[vKey].verseObjects;
      if (!Array.isArray(vo)) continue;
      const state = parseAlignment(vo, null);
      chapterObj[vKey].verseObjects = serializeAlignment(state);
    }
  }
  const reEmitted = usfm.toUSFM(json, { forcedNewLines: true });
  const counts = (s) => ({
    zalnStart: (s.match(/\\zaln-s/g) || []).length,
    zalnEnd: (s.match(/\\zaln-e\\\*/g) || []).length,
    wTokens: (s.match(/\\w /g) || []).length,
    xStrong: (s.match(/x-strong="/g) || []).length,
    xLemma: (s.match(/x-lemma="/g) || []).length,
    xMorph: (s.match(/x-morph="/g) || []).length,
    xContent: (s.match(/x-content="/g) || []).length,
    xOccurrence: (s.match(/x-occurrence="/g) || []).length,
  });
  const a = counts(original);
  const b = counts(reEmitted);
  for (const k of Object.keys(a)) {
    assert(a[k] === b[k], `OBA round-trip ${k}: ${a[k]} → ${b[k]}`);
  }
}

// ─── Case 7: Phase D — Psalm-title import + export round-trip ──────────
{
  console.log("\n[Case 7] Psalm-title (\\d) import + export round-trip");
  // Import: \d at chapter level should land at chapter=N, verse=0.
  const src = String.raw`\id PSA
\c 3
\d \zaln-s |x-strong="H4210"\*\w A psalm of David|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\v 1 \zaln-s |x-strong="H3068"\*\w O LORD|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  // Inline mini-importer that mirrors the production extractor at
  // api/src/importParsers.ts (verbatim post-Phase-D behaviour).
  const json = usfm.toJSON(src);
  const out = [];
  for (const chKey of Object.keys(json.chapters)) {
    const chNum = parseInt(chKey, 10);
    if (!Number.isFinite(chNum)) continue;
    const chapterObj = json.chapters[chKey];
    for (const vKey of Object.keys(chapterObj)) {
      let vNum;
      if (vKey === "front") vNum = 0;
      else if (/^\d+(-\d+)?$/.test(vKey)) vNum = parseInt(vKey.split("-")[0], 10);
      else continue;
      out.push({ chapter: chNum, verse: vNum, content: chapterObj[vKey] });
    }
  }
  const psalmTitle = out.find((r) => r.chapter === 3 && r.verse === 0);
  assert(!!psalmTitle, "Psalm title imports as chapter=3, verse=0");
  // Export: writing verse 0 back must use the "front" key so usfm-js
  // emits `\d` content above `\v 1` (not as `\v 0`).
  const chapters = {};
  for (const r of out) {
    const ch = String(r.chapter);
    if (!chapters[ch]) chapters[ch] = {};
    const verseKey = r.verse === 0 ? "front" : String(r.verse);
    chapters[ch][verseKey] = r.content;
  }
  const headers = [
    { tag: "id", content: "PSA ULT — bible-editor export" },
    { tag: "usfm", content: "3.0" },
  ];
  const reEmitted = usfm.toUSFM({ headers, chapters }, { forcedNewLines: true });
  assert(/\\d[\s\S]*\\zaln-s[\s\S]*A psalm of David[\s\S]*\\zaln-e\\\*[\s\S]*\\v 1/.test(reEmitted), "export places Psalm title above \\v 1 with alignment intact");
}

// ─── Case 8: Phase B — buildMilestone omits empty attributes ─────────────
{
  console.log("\n[Case 8] Phase B — empty zaln attributes are omitted on round-trip");
  // Synthetic verse with only x-strong set. Phase B should emit a
  // milestone without x-lemma="" / x-morph="" pollution.
  const target = String.raw`\id PSA
\c 3
\v 99 \zaln-s |x-strong="H1697"\*\w Word|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const rt = roundtripVerseUsfm(target);
  assert(/x-strong="H1697"/.test(rt), "x-strong survives round-trip");
  assert(!/x-lemma=""/.test(rt), "no empty x-lemma=\"\" pollution");
  assert(!/x-morph=""/.test(rt), "no empty x-morph=\"\" pollution");
  assert(!/x-content=""/.test(rt), "no empty x-content=\"\" pollution");
}

// ─── Case 9: Phase C — \qs and \f survive inline plain-text edits ────────
{
  console.log("\n[Case 9] Phase C — replace.ts preserves \\qs / \\f across overlap");
  // Dynamic import so the test file is self-contained even if web/ is
  // built / served separately.
  const { smartEditVerse } = await import("./replace.ts");

  // (a) Footnote outside the edit range stays put.
  {
    const target = String.raw`\v 1 \zaln-s |x-strong="H1697"\*\w Word|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\f + \ft note\f* \zaln-s |x-strong="H3068"\*\w of the LORD|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*`;
    const wrapped = `\\id TST\n\\c 1\n${target}\n`;
    const json = usfm.toJSON(wrapped);
    const verseObj = json.chapters["1"]["1"];
    const content = { verseObjects: verseObj.verseObjects };
    const oldPlain = "Word of the LORD";
    const newPlain = "Wordy of the LORD"; // change to "Word" only
    const result = smartEditVerse(content, oldPlain, newPlain);
    const verseObjects = result.content.verseObjects;
    const flatten = (vos) => {
      const tags = [];
      const walk = (xs) => {
        for (const n of xs ?? []) {
          if (n?.tag) tags.push(n.tag);
          if (Array.isArray(n?.children)) walk(n.children);
        }
      };
      walk(vos);
      return tags;
    };
    const tags = flatten(verseObjects);
    assert(tags.includes("f"), `\\f footnote survives edit to nearby word (tags=${tags.join(",")})`);
  }

  // (b) Editing OVER the footnote anchor (which has zero raw-text)
  // still preserves the footnote.
  {
    const target = String.raw`\v 1 \zaln-s |x-strong="H7965"\*\w Peace|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\f + \ft note\f* world`;
    const wrapped = `\\id TST\n\\c 1\n${target}\n`;
    const json = usfm.toJSON(wrapped);
    const verseObj = json.chapters["1"]["1"];
    const content = { verseObjects: verseObj.verseObjects };
    const oldPlain = "Peace world";
    const newPlain = "Quiet world"; // change "Peace" only
    const result = smartEditVerse(content, oldPlain, newPlain);
    const flatten = (vos) => {
      const tags = [];
      const walk = (xs) => {
        for (const n of xs ?? []) {
          if (n?.tag) tags.push(n.tag);
          if (Array.isArray(n?.children)) walk(n.children);
        }
      };
      walk(vos);
      return tags;
    };
    const tags = flatten(result.content.verseObjects);
    assert(tags.includes("f"), `\\f survives edit to adjacent word (tags=${tags.join(",")})`);
  }

  // (c) \qs wrapping \zaln with alignment survives edit to nearby word.
  {
    const target = String.raw`\v 1 \zaln-s |x-strong="H3068"\*\w Praise|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \qs \zaln-s |x-strong="H5542"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*`;
    const wrapped = `\\id TST\n\\c 1\n${target}\n`;
    const json = usfm.toJSON(wrapped);
    const verseObj = json.chapters["1"]["1"];
    const content = { verseObjects: verseObj.verseObjects };
    const oldPlain = "Praise Selah";
    const newPlain = "Praising Selah"; // edit "Praise" only
    const result = smartEditVerse(content, oldPlain, newPlain);
    const flatten = (vos) => {
      const tags = [];
      const walk = (xs) => {
        for (const n of xs ?? []) {
          if (n?.tag) tags.push(n.tag);
          if (Array.isArray(n?.children)) walk(n.children);
        }
      };
      walk(vos);
      return tags;
    };
    const tags = flatten(result.content.verseObjects);
    assert(tags.includes("qs"), `\\qs wrapper survives edit to adjacent aligned word (tags=${tags.join(",")})`);
    assert(tags.filter((t) => t === "zaln").length >= 1, `at least one \\zaln milestone survives`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll alignment tests passed.");

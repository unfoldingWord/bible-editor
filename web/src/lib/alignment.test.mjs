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
import { findTargetHighlights, findSourceHighlights } from "./highlight.ts";
import { buildQuoteFromSelection, collectTargetTokens } from "./quoteBuilder.ts";

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

  // (d) Multi-word edit (e.g. is→are in several places) across a USFM verse
  // whose `\w` tokens land on separate lines. Behavior under unalign-on-edit:
  // each changed word lifts out of its `\zaln-s`, becoming a bare \w chip.
  // Milestones wrapping unchanged neighbors survive untouched.
  {
    const target = String.raw`\v 1 \zaln-s |x-strong="H1"\*\w he|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\zaln-s |x-strong="H2"\*\w is|x-occurrence="1" x-occurrences="3"\w*\zaln-e\*
\zaln-s |x-strong="H3"\*\w good|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*,
\zaln-s |x-strong="H4"\*\w she|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\zaln-s |x-strong="H2"\*\w is|x-occurrence="2" x-occurrences="3"\w*\zaln-e\*
\zaln-s |x-strong="H5"\*\w kind|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*.`;
    const wrapped = `\\id TST\n\\c 1\n${target}\n`;
    const json = usfm.toJSON(wrapped);
    const verseObj = json.chapters["1"]["1"];
    const content = { verseObjects: verseObj.verseObjects };
    const oldPlain = "he is good, she is kind.";
    const newPlain = "he are good, she are kind.";
    const result = smartEditVerse(content, oldPlain, newPlain);
    const aligned = [];
    const bare = [];
    const walk = (xs, insideZaln) => {
      for (const n of xs ?? []) {
        if (n?.tag === "zaln") { walk(n.children, true); continue; }
        if (n?.type === "word" && n?.tag === "w") (insideZaln ? aligned : bare).push(n.text);
        if (Array.isArray(n?.children)) walk(n.children, insideZaln);
      }
    };
    walk(result.content.verseObjects, false);
    assert(
      aligned.join(",") === "he,good,she,kind",
      `unchanged neighbors stay aligned (got [${aligned.join(",")}])`,
    );
    assert(
      bare.join(",") === "are,are",
      `each edited 'is' is now a bare unaligned \\w (got [${bare.join(",")}])`,
    );
    assert(result.preservedAlignment === true, `still preserved=true (got ${result.preservedAlignment})`);
    assert(result.plainText === newPlain, `plain text round-trips cleanly (got ${JSON.stringify(result.plainText)})`);
  }

  // (e) Single-word edit (Praise → Praising) inside a `\zaln-s` whose only
  // child is the edited word: the milestone collapses to a bare \w, while
  // the sibling `\qs` wrapper around Selah survives intact. Regression
  // guard against the prior "preserve in place" behavior that kept the
  // edited word aligned — translators want their edit to invalidate the
  // old alignment so the new word becomes a draggable unaligned chip.
  {
    const target = String.raw`\v 1 \zaln-s |x-strong="H3068"\*\w Praise|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \qs \zaln-s |x-strong="H5542"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*`;
    const wrapped = `\\id TST\n\\c 1\n${target}\n`;
    const json = usfm.toJSON(wrapped);
    const verseObj = json.chapters["1"]["1"];
    const content = { verseObjects: verseObj.verseObjects };
    const result = smartEditVerse(content, "Praise Selah", "Praising Selah");
    const aligned = [];
    const bare = [];
    const walk = (xs, insideZaln) => {
      for (const n of xs ?? []) {
        if (n?.tag === "zaln") { walk(n.children, true); continue; }
        if (n?.type === "word" && n?.tag === "w") (insideZaln ? aligned : bare).push(n.text);
        if (Array.isArray(n?.children)) walk(n.children, insideZaln);
      }
    };
    walk(result.content.verseObjects, false);
    assert(bare.includes("Praising"), `edited Praise becomes bare unaligned 'Praising' (bare=${JSON.stringify(bare)})`);
    assert(aligned.includes("Selah"), `Selah stays aligned (aligned=${JSON.stringify(aligned)})`);
    const flatten = (vos) => {
      const tags = [];
      const w = (xs) => { for (const n of xs ?? []) { if (n?.tag) tags.push(n.tag); if (Array.isArray(n?.children)) w(n.children); } };
      w(vos);
      return tags;
    };
    const tags = flatten(result.content.verseObjects);
    assert(tags.includes("qs"), `\\qs wrapper survives (tags=${tags.join(",")})`);
    assert(result.plainText === "Praising Selah", `plain text correct (got ${JSON.stringify(result.plainText)})`);
  }

  // (f) Legacy data with punct-attached \w (a curly quote ride-along that
  // pre-dates the import-time normalize) gets healed by the next save.
  // Translator edits "fathers" → "ancestors"; the `“Your` \w in an
  // UNCHANGED neighbor milestone normalizes anyway as defense-in-depth.
  {
    const verseObjects = [
      {
        tag: "zaln", type: "milestone", strong: "H1",
        children: [{ type: "word", tag: "w", text: "“Your", occurrence: "1", occurrences: "1" }],
        endTag: "zaln-e\\*",
      },
      { type: "text", text: " " },
      {
        tag: "zaln", type: "milestone", strong: "H2",
        children: [{ type: "word", tag: "w", text: "fathers", occurrence: "1", occurrences: "1" }],
        endTag: "zaln-e\\*",
      },
      { type: "text", text: "." },
    ];
    const result = smartEditVerse({ verseObjects }, "“Your fathers.", "“Your ancestors.");
    let badQuote = 0;
    const walk = (xs) => {
      for (const n of xs ?? []) {
        if (n?.tag === "w" && typeof n.text === "string" && n.text.includes("“")) badQuote++;
        if (Array.isArray(n?.children)) walk(n.children);
      }
    };
    walk(result.content.verseObjects);
    assert(badQuote === 0, `no \\w node carries a leading curly quote after save (found ${badQuote})`);
    assert(result.plainText === "“Your ancestors.", `plain text preserves leading quote in a text node (got ${JSON.stringify(result.plainText)})`);
  }
}

// ─── Case 10: Highlight precision — quote shouldn't bleed across milestones ──
//
// ZEC 1:1 UST has two separate zaln milestones whose direct \w children
// each include a "the" token:
//
//   zaln(content="בֶּרֶכְיָה") { \w the (occ=1)  \w son  \w of  \w Berechiah }
//   zaln(content="עִדּוֹ")    { \w and  \w the (occ=2)  \w grandson  ... }
//
// A TN whose quote is "בֶּרֶכְיָה" (occurrence 1) must highlight ONLY the
// first "the" and friends — the second "the" belongs to a different
// Hebrew word's alignment and should stay untouched. The user-reported
// over-highlighting bug looks like this: a 2-Hebrew-word quote lights up
// extra "the"s elsewhere in the verse. ZEC 1:1 is the closest analogue
// in our fixtures.
{
  console.log("\n[Case 10] Highlight precision in ZEC 1:1");
  const sample = resolve(repoRoot, "docs/samples/en_ust_38-ZEC.usfm");
  const ust = readFileSync(sample, "utf-8");
  const json = usfm.toJSON(ust);
  const verseObjects = json.chapters["1"]["1"].verseObjects;

  // Single-word quote: "בֶּ֣רֶכְיָ֔ה" — the milestone tagged that way owns
  // \w the (occurrence 1). The other "the" belongs to עִדּוֹ.
  const hl = findTargetHighlights(verseObjects, "בֶּ֣רֶכְיָ֔ה", 1);
  assert(hl.has("the|1"), "ZEC 1:1: בֶּרֶכְיָה quote highlights the (occ=1)");
  assert(hl.has("son|1"), "ZEC 1:1: בֶּרֶכְיָה quote highlights son");
  assert(hl.has("Berechiah|1"), "ZEC 1:1: בֶּרֶכְיָה quote highlights Berechiah");
  assert(
    !hl.has("the|2"),
    `ZEC 1:1: בֶּרֶכְיָה quote must NOT highlight the (occ=2). Got: ${[...hl].join(",")}`,
  );
  assert(
    !hl.has("the|3"),
    `ZEC 1:1: בֶּרֶכְיָה quote must NOT highlight the (occ=3). Got: ${[...hl].join(",")}`,
  );
  assert(
    !hl.has("grandson|1"),
    `ZEC 1:1: בֶּרֶכְיָה quote must NOT highlight grandson (Iddo's milestone)`,
  );

  // Multi-word quote: "בַּ⁠חֹ֨דֶשׁ֙ הַ⁠שְּׁמִינִ֔י" (In the eighth month) —
  // a real TN quote from en_tn_tn_ZEC.tsv 1:1 bra8. Should only highlight
  // words from those two milestones, not bleed into nearby ones.
  const hl2 = findTargetHighlights(
    verseObjects,
    "בַּ⁠חֹ֨דֶשׁ֙ הַ⁠שְּׁמִינִ֔י",
    1,
  );
  // Sanity: at least one ULT/UST gateway word must light up — empty would
  // mean the matcher couldn't anchor at all.
  assert(hl2.size > 0, `ZEC 1:1: multi-word quote produces non-empty highlights (got ${[...hl2].join(",")})`);
  // Specific over-match guard: "Berechiah" lives in a totally different
  // milestone and must not light up.
  assert(
    !hl2.has("Berechiah|1"),
    `ZEC 1:1: month/year quote must NOT highlight Berechiah. Got: ${[...hl2].join(",")}`,
  );
  assert(
    !hl2.has("Iddo|1"),
    `ZEC 1:1: month/year quote must NOT highlight Iddo. Got: ${[...hl2].join(",")}`,
  );
}

// ─── Case 11: NUM 20:1 — nested milestones + repeated Hebrew compound ─────
//
// The exact structure the user hit on production: the compound
// "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן" appears TWICE in the verse (x-occurrences=2),
// with NESTED milestones (the outer בַּ⁠חֹ֣דֶשׁ wraps the inner הָֽ⁠רִאשׁ֔וֹן,
// and only the inner one carries the \w children).
//
//   {first occurrence}                 {second occurrence}
//   zaln(בַ⁠חֹדֶשׁ, occ=1) {            zaln(בַ⁠חֹדֶשׁ, occ=2) {
//     zaln(הָ⁠רִאשׁוֹן, occ=1) {            zaln(הָ⁠רִאשׁוֹן, occ=2) {
//       \w In  \w the  \w first  \w month     \w of  \w the  \w next  \w year
//     }                                    }
//   }                                    }
//
// With TN quote `בַ⁠חֹדֶשׁ הָ⁠רִאשׁוֹן` occurrence=1 the highlight set MUST
// be exactly {In, the(occ=1), first, month} — never bleeding into the
// second occurrence's "of, the(occ=2), next, year".
{
  console.log("\n[Case 11] NUM 20:1 nested-milestone disambiguation");
  const verseObjects = [
    {
      tag: "zaln",
      type: "milestone",
      occurrence: 1,
      occurrences: 2,
      content: "בַּ⁠חֹ֣דֶשׁ",
      children: [
        {
          tag: "zaln",
          type: "milestone",
          occurrence: 1,
          occurrences: 2,
          content: "הָֽ⁠רִאשׁ֔וֹן",
          children: [
            { type: "word", tag: "w", text: "In", occurrence: 1, occurrences: 1 },
            { type: "word", tag: "w", text: "the", occurrence: 1, occurrences: 5 },
            { type: "word", tag: "w", text: "first", occurrence: 1, occurrences: 1 },
            { type: "word", tag: "w", text: "month", occurrence: 1, occurrences: 1 },
          ],
        },
      ],
    },
    {
      tag: "zaln",
      type: "milestone",
      occurrence: 2,
      occurrences: 2,
      content: "בַּ⁠חֹ֣דֶשׁ",
      children: [
        {
          tag: "zaln",
          type: "milestone",
          occurrence: 2,
          occurrences: 2,
          content: "הָֽ⁠רִאשׁ֔וֹן",
          children: [
            { type: "word", tag: "w", text: "of", occurrence: 1, occurrences: 2 },
            { type: "word", tag: "w", text: "the", occurrence: 2, occurrences: 5 },
            { type: "word", tag: "w", text: "next", occurrence: 1, occurrences: 1 },
            { type: "word", tag: "w", text: "year", occurrence: 1, occurrences: 1 },
          ],
        },
      ],
    },
    // a downstream milestone whose direct children also include "the" — a red
    // herring to make sure we never bleed past the matched range.
    {
      tag: "zaln",
      type: "milestone",
      occurrence: 1,
      occurrences: 1,
      content: "הָ֨⁠עֵדָ֤ה",
      children: [
        { type: "word", tag: "w", text: "the", occurrence: 4, occurrences: 5 },
        { type: "word", tag: "w", text: "whole", occurrence: 1, occurrences: 1 },
        { type: "word", tag: "w", text: "community", occurrence: 1, occurrences: 1 },
      ],
    },
  ];

  const hl = findTargetHighlights(verseObjects, "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן", 1);
  assert(hl.has("In|1"), "NUM 20:1 occ=1 highlights In");
  assert(hl.has("the|1"), "NUM 20:1 occ=1 highlights the(1)");
  assert(hl.has("first|1"), "NUM 20:1 occ=1 highlights first");
  assert(hl.has("month|1"), "NUM 20:1 occ=1 highlights month");
  assert(
    !hl.has("the|2"),
    `NUM 20:1 occ=1 must NOT highlight the(2) from occ=2 scope. Got: ${[...hl].join(",")}`,
  );
  assert(
    !hl.has("the|4"),
    `NUM 20:1 occ=1 must NOT highlight the(4) from הָ⁠עֵדָה's scope. Got: ${[...hl].join(",")}`,
  );
  assert(
    !hl.has("of|1"),
    `NUM 20:1 occ=1 must NOT highlight "of" from occ=2 scope. Got: ${[...hl].join(",")}`,
  );

  // Symmetric check: occurrence=2 lights up the second range exclusively.
  const hl2 = findTargetHighlights(verseObjects, "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן", 2);
  assert(hl2.has("of|1"), "NUM 20:1 occ=2 highlights of");
  assert(hl2.has("the|2"), "NUM 20:1 occ=2 highlights the(2)");
  assert(
    !hl2.has("the|1"),
    `NUM 20:1 occ=2 must NOT highlight the(1) from occ=1 scope. Got: ${[...hl2].join(",")}`,
  );
}

// ─── Case 12: Hebrew-click → quote builder ────────────────────────────────
//
// Selecting contiguous Hebrew words produces a single space-joined quote;
// disjoint selections insert " & " between groups. Occurrence is computed
// by counting how many positions in the verse start a matching pattern up
// to and including the selected one.
{
  console.log("\n[Case 12] Quote builder from Hebrew selection");
  // Fake verseObjects: a flat list of \w tokens with predictable text.
  const verseObjects = [
    { type: "word", tag: "w", text: "וַ⁠יָּבֹ֣אוּ", occurrence: 1, occurrences: 1 },
    { type: "word", tag: "w", text: "בְנֵֽי", occurrence: 1, occurrences: 1 },
    { type: "word", tag: "w", text: "יִ֠שְׂרָאֵל", occurrence: 1, occurrences: 1 },
    { type: "word", tag: "w", text: "בַּ⁠חֹ֣דֶשׁ", occurrence: 1, occurrences: 2 },
    { type: "word", tag: "w", text: "הָֽ⁠רִאשׁ֔וֹן", occurrence: 1, occurrences: 2 },
    { type: "word", tag: "w", text: "בַּ⁠חֹ֣דֶשׁ", occurrence: 2, occurrences: 2 },
    { type: "word", tag: "w", text: "הָֽ⁠רִאשׁ֔וֹן", occurrence: 2, occurrences: 2 },
  ];

  // Two adjacent words → single quote, occurrence 1.
  const sel1 = new Set(["בַּ⁠חֹ֣דֶשׁ|1", "הָֽ⁠רִאשׁ֔וֹן|1"]);
  const b1 = buildQuoteFromSelection(verseObjects, sel1);
  assert(b1 !== null, "builder returns non-null for valid selection");
  assert(
    b1?.quote === "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן",
    `single-group quote (got: ${b1?.quote})`,
  );
  assert(b1?.occurrence === 1, `occurrence=1 for first instance (got: ${b1?.occurrence})`);

  // The same pair, but the SECOND occurrence → occurrence 2.
  const sel2 = new Set(["בַּ⁠חֹ֣דֶשׁ|2", "הָֽ⁠רִאשׁ֔וֹן|2"]);
  const b2 = buildQuoteFromSelection(verseObjects, sel2);
  assert(b2?.quote === "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן", `same quote shape for second occurrence`);
  assert(b2?.occurrence === 2, `occurrence=2 for second instance (got: ${b2?.occurrence})`);

  // Disjoint selection → ' & ' separator. Picking word 1 and word 4
  // produces a two-group quote.
  const sel3 = new Set(["וַ⁠יָּבֹ֣אוּ|1", "בַּ⁠חֹ֣דֶשׁ|1"]);
  const b3 = buildQuoteFromSelection(verseObjects, sel3);
  assert(
    b3?.quote === "וַ⁠יָּבֹ֣אוּ & בַּ⁠חֹ֣דֶשׁ",
    `disjoint groups joined by ' & ' (got: ${b3?.quote})`,
  );

  // Empty selection → null.
  const b4 = buildQuoteFromSelection(verseObjects, new Set());
  assert(b4 === null, "empty selection returns null");
}

// ─── Case 12b: maqqef-joined run keeps its maqqef ─────────────────────────
//
// ZEC 5:3 style: כָל and הַגֹּנֵב are separate \w tokens joined by a maqqef
// text node (usfm-js emits "־" as a bare text sibling). Building a quote
// from that consecutive run must reproduce כָל־הַגֹּנֵב, not כָל הַגֹּנֵב.
// Distinct occurrences also disambiguate the two כָל so only the intended
// run is selected.
{
  console.log("\n[Case 12b] Quote builder preserves the maqqef");
  const verseObjects = [
    { type: "word", tag: "w", text: "כָל", occurrence: 1, occurrences: 2 },
    { type: "text", text: "־" },
    { type: "word", tag: "w", text: "הָאָרֶץ", occurrence: 1, occurrences: 1 },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "כָל", occurrence: 2, occurrences: 2 },
    { type: "text", text: "־" },
    { type: "word", tag: "w", text: "הַגֹּנֵב", occurrence: 1, occurrences: 1 },
  ];

  // Select the SECOND כָל + הַגֹּנֵב (the maqqef-joined "all who steal").
  const sel = new Set(["כָל|2", "הַגֹּנֵב|1"]);
  const b = buildQuoteFromSelection(verseObjects, sel);
  assert(b !== null, "builder returns non-null");
  assert(b?.quote === "כָל־הַגֹּנֵב", `maqqef preserved (got: ${b?.quote})`);
  // First (and only) occurrence of the phrase כָל־הַגֹּנֵב in the verse.
  assert(b?.occurrence === 1, `occurrence=1 (got: ${b?.occurrence})`);

  // A space-separated run still joins with a space, not a maqqef: הָאָרֶץ is
  // followed by a " " text node before the second כָל.
  const selSpace = new Set(["הָאָרֶץ|1", "כָל|2"]);
  const bSpace = buildQuoteFromSelection(verseObjects, selSpace);
  assert(bSpace?.quote === "הָאָרֶץ כָל", `space run stays space-joined (got: ${bSpace?.quote})`);
}

// ─── Case 13: collectTargetTokens — ancestor chain per \w ────────────────
//
// The picker resolves an English click to its \zaln-s ancestor chain so
// non-Hebrew speakers can build a quote without typing Hebrew. Outer-to-
// inner order, with each ancestor's exact occurrence index from its
// milestone — that's what the picker needs to turn into ${content}|${occ}
// keys for the existing UHB-keyed selection set.
{
  console.log("\n[Case 13] collectTargetTokens ancestor resolution");
  const ust = [
    {
      tag: "zaln",
      type: "milestone",
      occurrence: 1,
      occurrences: 2,
      content: "בַּ⁠חֹ֣דֶשׁ",
      children: [
        {
          tag: "zaln",
          type: "milestone",
          occurrence: 1,
          occurrences: 2,
          content: "הָֽ⁠רִאשׁ֔וֹן",
          children: [
            { type: "word", tag: "w", text: "In", occurrence: 1, occurrences: 1 },
            { type: "word", tag: "w", text: "the", occurrence: 1, occurrences: 3 },
            { type: "word", tag: "w", text: "first", occurrence: 1, occurrences: 1 },
          ],
        },
      ],
    },
    // Sibling that doesn't share the ancestor chain — the "the" inside
    // here is a different instance, used to confirm the walker keeps
    // ancestor stacks disjoint between siblings.
    {
      tag: "zaln",
      type: "milestone",
      occurrence: 1,
      occurrences: 1,
      content: "הָ֨⁠עֵדָ֤ה",
      children: [
        { type: "word", tag: "w", text: "the", occurrence: 2, occurrences: 3 },
        { type: "word", tag: "w", text: "whole", occurrence: 1, occurrences: 1 },
      ],
    },
  ];

  const tokens = collectTargetTokens(ust);
  assert(tokens.length === 5, `5 \\w tokens emitted (got ${tokens.length})`);

  const first = tokens.find((t) => t.text === "first");
  assert(first !== undefined, "first \\w token resolved");
  assert(
    first?.sources.length === 2,
    `first has two ancestors (got ${first?.sources.length})`,
  );
  assert(
    first?.sources[0].content === "בַּ⁠חֹ֣דֶשׁ" && first?.sources[0].occurrence === 1,
    `outer ancestor is בַּחֹדֶשׁ occ=1 (got ${JSON.stringify(first?.sources[0])})`,
  );
  assert(
    first?.sources[1].content === "הָֽ⁠רִאשׁ֔וֹן" && first?.sources[1].occurrence === 1,
    `inner ancestor is הָרִאשׁוֹן occ=1 (got ${JSON.stringify(first?.sources[1])})`,
  );

  // The "the" inside בַחֹדֶשׁ has ancestors [בַחֹדֶשׁ, הָרִאשׁוֹן].
  // The "the" inside הָעֵדָה has ancestor [הָעֵדָה] only — different chain.
  const the1 = tokens.find((t) => t.text === "the" && t.occurrence === 1);
  const the2 = tokens.find((t) => t.text === "the" && t.occurrence === 2);
  assert(
    the1?.sources.length === 2,
    `the(1) has two ancestors (the בַחֹדֶשׁ chain)`,
  );
  assert(
    the2?.sources.length === 1 && the2?.sources[0].content === "הָ֨⁠עֵדָ֤ה",
    `the(2) has one ancestor (הָעֵדָה only). Got: ${JSON.stringify(the2?.sources)}`,
  );
}

// ─── Case 14: end-to-end picker round-trip (no UI) ────────────────────────
//
// Simulate the picker's click handler: user clicks "first" in UST, which
// adds its ancestor chain to the selection set; then buildQuoteFromSelection
// against the UHB verseObjects produces the right quote+occurrence.
{
  console.log("\n[Case 14] Picker click → quote round-trip");

  // UHB version of the same fragment — used for quote rendering.
  const uhb = [
    { type: "word", tag: "w", text: "בַּ⁠חֹ֣דֶשׁ", occurrence: 1, occurrences: 1 },
    { type: "word", tag: "w", text: "הָֽ⁠רִאשׁ֔וֹן", occurrence: 1, occurrences: 1 },
  ];
  // UST with nested zaln (same as Case 13 first milestone).
  const ust = [
    {
      tag: "zaln",
      type: "milestone",
      occurrence: 1,
      occurrences: 1,
      content: "בַּ⁠חֹ֣דֶשׁ",
      children: [
        {
          tag: "zaln",
          type: "milestone",
          occurrence: 1,
          occurrences: 1,
          content: "הָֽ⁠רִאשׁ֔וֹן",
          children: [
            { type: "word", tag: "w", text: "In", occurrence: 1, occurrences: 1 },
            { type: "word", tag: "w", text: "the", occurrence: 1, occurrences: 1 },
            { type: "word", tag: "w", text: "first", occurrence: 1, occurrences: 1 },
          ],
        },
      ],
    },
  ];

  const tokens = collectTargetTokens(ust);
  const firstTok = tokens.find((t) => t.text === "first");
  assert(firstTok !== undefined, "found 'first' target token");

  // Picker click handler: dump every ancestor into the selection set.
  const selection = new Set();
  for (const a of firstTok?.sources ?? []) {
    selection.add(`${a.content}|${a.occurrence}`);
  }

  const built = buildQuoteFromSelection(uhb, selection);
  assert(built !== null, "buildQuoteFromSelection returns a quote");
  assert(
    built?.quote === "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן",
    `quote round-trips through UHB (got: ${built?.quote})`,
  );
  assert(built?.occurrence === 1, `occurrence=1 (got: ${built?.occurrence})`);
}

// ─── Case 15: Paragraph / poetry markers round-trip through edits ────────
//
// Stored shape: `{type:"paragraph", tag}` siblings inside verseObjects.
// extractEditableText surfaces them as inline "\p ", "\q1 " etc. so the
// active-verse contenteditable can show them as visible chips. When the
// user edits text that's between (not over) markers, all marker nodes
// must survive unmoved. When the user inserts a marker via the toolbar
// (or types one literally), tokenizeEditableText turns it into a new
// `{type:"paragraph", tag}` node at the right position.
{
  console.log("\n[Case 15] Paragraph / poetry markers round-trip");
  const { smartEditVerse, tokenizeEditableText } = await import("./replace.ts");
  const { extractEditableText, splitSectionHeaders } = await import("./usfm.ts");

  // (a) extractEditableText surfaces \p and \q1 inline. usfm-js stores
  // \q1 as type:"quote" while \p is type:"paragraph" — both are in-flow
  // markers and both should surface.
  {
    const vo = [
      { type: "paragraph", tag: "p" },
      { type: "word", tag: "w", text: "Blessed", occurrence: "1", occurrences: "1" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "is", occurrence: "1", occurrences: "1" },
      { type: "quote", tag: "q1" },
      { type: "word", tag: "w", text: "the", occurrence: "1", occurrences: "1" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "man", occurrence: "1", occurrences: "1" },
    ];
    const editable = extractEditableText(vo);
    // No space before \q1 — the marker node has no preceding text node,
    // and the renderer's contenteditable textContent matches this shape.
    assert(
      editable === "\\p Blessed is\\q1 the man",
      `editable text includes inline markers (got ${JSON.stringify(editable)})`,
    );
  }

  // (b) Edit a word INSIDE the q1 line — both marker nodes survive at
  // their original positions and are not duplicated. The \q1 keeps
  // type:"quote" (poetry); \p stays type:"paragraph".
  {
    const vo = [
      { type: "paragraph", tag: "p" },
      { type: "word", tag: "w", text: "Blessed", occurrence: "1", occurrences: "1" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "is", occurrence: "1", occurrences: "1" },
      { type: "quote", tag: "q1" },
      { type: "word", tag: "w", text: "the", occurrence: "1", occurrences: "1" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "man", occurrence: "1", occurrences: "1" },
    ];
    const oldEditable = "\\p Blessed is\\q1 the man";
    const newEditable = "\\p Blessed is\\q1 the woman";
    const result = smartEditVerse({ verseObjects: vo }, oldEditable, newEditable);
    const markers = result.content.verseObjects.filter(
      (n) => n.type === "paragraph" || n.type === "quote",
    );
    assert(
      markers.length === 2,
      `still two marker nodes after text edit (got ${markers.length})`,
    );
    assert(
      markers[0].tag === "p" && markers[1].tag === "q1",
      `marker tags survive in order (got [${markers.map((p) => p.tag).join(",")}])`,
    );
    assert(
      markers[0].type === "paragraph" && markers[1].type === "quote",
      `marker types survive (got [${markers.map((p) => p.type).join(",")}])`,
    );
    const firstParaIdx = result.content.verseObjects.findIndex(
      (n) => n.type === "paragraph" || n.type === "quote",
    );
    assert(firstParaIdx === 0, `leading \\p still at index 0 (got ${firstParaIdx})`);
  }

  // (c) tokenizeEditableText: input with literal markers emits marker
  // nodes interleaved with text / word nodes. Words are still draggable
  // (have tag:"w"). \q1 emits as type:"quote", \p as type:"paragraph".
  {
    const nodes = tokenizeEditableText("\\p hello \\q1 world");
    const tags = nodes.map((n) => n.tag || n.type);
    assert(
      tags[0] === "p",
      `first node is \\p (got ${tags.join(",")})`,
    );
    const firstNode = nodes[0];
    assert(
      firstNode.type === "paragraph",
      `\\p emitted as type:"paragraph" (got ${firstNode.type})`,
    );
    const q1 = nodes.find((n) => n.tag === "q1");
    assert(q1 !== undefined && q1.type === "quote", `q1 emitted as type:"quote" (got ${JSON.stringify(q1)})`);
    const words = nodes.filter((n) => n.tag === "w").map((n) => n.text);
    assert(
      JSON.stringify(words) === JSON.stringify(["hello", "world"]),
      `hello + world emitted as \\w nodes (got ${JSON.stringify(words)})`,
    );
  }

  // (d) Inserting a NEW \q2 marker via the toolbar/typing: smartEditVerse
  // sees the new marker text in the diff, falls back to localized rewrite,
  // and emits the marker node in the right spot.
  {
    const vo = [
      { type: "word", tag: "w", text: "fear", occurrence: "1", occurrences: "1" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "not", occurrence: "1", occurrences: "1" },
    ];
    const oldEditable = "fear not";
    const newEditable = "fear \\q2 not";
    const result = smartEditVerse({ verseObjects: vo }, oldEditable, newEditable);
    const markers = result.content.verseObjects.filter(
      (n) => n && (n.type === "paragraph" || n.type === "quote"),
    );
    assert(
      markers.length === 1 && markers[0].tag === "q2" && markers[0].type === "quote",
      `new \\q2 quote node emitted (got ${JSON.stringify(markers)})`,
    );
  }

  // (e*) extractTrailingMarkers: \q1 at the END of a verse — usfm-js
  // attaches markers to the prior verse (before `\v`), but visually
  // they introduce the NEXT verse. The display layer drifts them down.
  {
    const { extractTrailingMarkers } = await import("./usfm.ts");
    // ZEC 9:8 shape: ends with milestones, then a trailing \ts\*, then \q1.
    // \ts\* parses as `{tag:"ts", content:"\\*"}` (no `type` field) and
    // is now treated as an in-flow marker — it drifts along with \q1.
    const vo = [
      { type: "word", tag: "w", text: "Yahweh" },
      { type: "text", text: "!\n\n" },
      { tag: "ts", content: "\\*" },
      { type: "quote", tag: "q1" },
    ];
    const trailing = extractTrailingMarkers(vo);
    assert(
      trailing.length === 2 && trailing[0].tag === "ts" && trailing[1].tag === "q1",
      `\\ts\\* + \\q1 both detected as trailing markers (got ${JSON.stringify(trailing)})`,
    );
    // Multiple stacked trailing markers
    const vo2 = [
      { type: "word", tag: "w", text: "end" },
      { type: "paragraph", tag: "p" },
      { type: "quote", tag: "q1" },
    ];
    const trailing2 = extractTrailingMarkers(vo2);
    assert(
      trailing2.length === 2 &&
        trailing2[0].tag === "p" &&
        trailing2[1].tag === "q1",
      `both \\p + \\q1 detected, in order (got ${JSON.stringify(trailing2)})`,
    );
    // No trailing markers → empty
    const vo3 = [{ type: "word", tag: "w", text: "plain" }, { type: "text", text: "." }];
    assert(
      extractTrailingMarkers(vo3).length === 0,
      `no trailing markers when verse ends in text`,
    );
    // Zero-width space (U+200B) — from the editor's empty-block
    // placeholder leaking into saved data. Must step past it like
    // ordinary whitespace so drift still works on healed-or-not rows.
    const vo4 = [
      { type: "word", tag: "w", text: "end" },
      { type: "text", text: ". " },
      { type: "quote", tag: "q1" },
      { type: "text", text: "​" },
    ];
    const trailing4 = extractTrailingMarkers(vo4);
    assert(
      trailing4.length === 1 && trailing4[0].tag === "q1",
      `trailing \\q1 detected past trailing ZWSP placeholder (got ${JSON.stringify(trailing4)})`,
    );
  }

  // (e**) tokenizeEditableText strips zero-width spaces. Otherwise the
  // editor's caret-placeholder `​` (rendered as `&#8203;` in empty
  // marker-led blocks) would accumulate in saved verseObjects every
  // time the user saves.
  {
    const { tokenizeEditableText } = await import("./replace.ts");
    const nodes = tokenizeEditableText("hello​ world​");
    const texts = nodes
      .filter((n) => n.type === "text" || n.type === "word")
      .map((n) => n.text);
    assert(
      texts.every((t) => !t.includes("​")),
      `no node text contains a zero-width space (got ${JSON.stringify(texts)})`,
    );
  }

  // (e***) \ts\* chunk markers surface in editable text and round-trip
  // through tokenizeEditableText to the original `{tag:"ts", content:"\\*"}`
  // shape (no `type` field — matches what usfm-js produces on import).
  {
    const vo = [
      { tag: "ts", content: "\\*" },
      { type: "word", tag: "w", text: "Then", occurrence: "1", occurrences: "1" },
    ];
    const editable = extractEditableText(vo);
    assert(
      editable === "\\ts\\* Then",
      `\\ts\\* surfaced inline in editable text (got ${JSON.stringify(editable)})`,
    );
    const nodes = tokenizeEditableText(editable);
    const ts = nodes.find((n) => n.tag === "ts");
    assert(
      ts !== undefined && ts.content === "\\*" && ts.type === undefined,
      `\\ts\\* round-trips as {tag:"ts", content:"\\\\*"} with no type (got ${JSON.stringify(ts)})`,
    );
  }

  // (e) splitSectionHeaders: \s1 hoisted, \d stays inline (alignable).
  {
    const vo = [
      { type: "section", tag: "s1", text: "The Cleansing" },
      { type: "section", tag: "d", text: "A psalm of David." },
      { type: "word", tag: "w", text: "Yahweh", occurrence: "1", occurrences: "1" },
    ];
    const { sections, body } = splitSectionHeaders(vo);
    assert(
      sections.length === 1 && sections[0].tag === "s1",
      `only \\s1 hoisted (sections=${JSON.stringify(sections)})`,
    );
    const stillHasD = body.some((n) => n && n.tag === "d");
    assert(stillHasD, `\\d stays inline in body (body tags=${body.map((n) => n?.tag).join(",")})`);
  }
}

// ─── Case 16: malformed occurrence (occurrence > occurrences) on a split gloss ──
// An AI/tC aligner emits the 2nd span of a non-contiguous split gloss as
// occurrence="2" while occurrences stays "1" — impossible ("2 of 1"). Real
// example: ZEC 5:5 וַיֵּצֵא → "And" … "went out". The bad value must not stop
// the two spans from merging into one group, and a save must heal it.
{
  console.log("\n[Case 16] malformed occurrence (occurrence > occurrences) on a split gloss");
  const target = String.raw`\id ZEC
\c 5
\v 5 \zaln-s |x-strong="c:H3318" x-lemma="יָצָא" x-morph="He,C:Vqw3ms" x-occurrence="1" x-occurrences="1" x-content="וַ⁠יֵּצֵא"\*\w And|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="d:H4397" x-occurrence="1" x-occurrences="1" x-content="הַ⁠מַּלְאָךְ"\*\w the|x-occurrence="1" x-occurrences="1"\w*\w angel|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="c:H3318" x-lemma="יָצָא" x-morph="He,C:Vqw3ms" x-occurrence="2" x-occurrences="1" x-content="וַ⁠יֵּצֵא"\*\w went|x-occurrence="1" x-occurrences="1"\w*\w out|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*`;
  const { verseObjects } = parseSingleVerse(target);
  const state = parseAlignment(verseObjects, null);

  const verb = state.groups.filter((g) => g.source.some((s) => s.strong === "c:H3318"));
  assert(verb.length === 1, `the two split spans of c:H3318 merge into ONE group (got ${verb.length})`);
  assert(state.groups.length === 2, `verse has 2 alignment groups, not 3 (got ${state.groups.length})`);
  if (verb.length === 1) {
    const targets = verb[0].targets.map((t) => t.text);
    assert(
      JSON.stringify(targets) === JSON.stringify(["And", "went", "out"]),
      `merged group holds all three target words in stream order (got ${JSON.stringify(targets)})`,
    );
  }

  // Save heals the malformed value: serialize re-splits the non-contiguous
  // targets into two \zaln-s runs, both inheriting the surviving occurrence="1".
  const rt = roundtripVerseUsfm(target);
  assert(!/x-occurrence="2"/.test(rt), `round-trip drops the impossible occurrence="2"`);
  assert(
    (rt.match(/x-strong="c:H3318"/g) || []).length === 2,
    "round-trip still emits two c:H3318 \\zaln-s runs (non-contiguous gloss preserved)",
  );
}

// ─── Case 17: word-extending insertion merges into the adjacent \w ───────
// Regression for ZEC 5:3: the word "This" had been truncated to "is"; the
// translator retyped the missing "Th" immediately before "is". The minimal
// diff sees a pure insertion of "Th", which previously emitted a STANDALONE
// \w "Th" next to "is" (two chips). It must instead extend the existing word
// into a single \w "This".
{
  console.log("\n[Case 17] word-extending insertion merges into the adjacent \\w");
  const { smartEditVerse } = await import("./replace.ts");

  const collectWords = (vos, inZaln = false, aligned = [], bare = []) => {
    for (const n of vos ?? []) {
      if (n?.tag === "zaln") {
        collectWords(n.children, true, aligned, bare);
        continue;
      }
      if (n?.type === "word" && n?.tag === "w") (inZaln ? aligned : bare).push(n.text);
      if (Array.isArray(n?.children)) collectWords(n.children, inZaln, aligned, bare);
    }
    return { aligned, bare };
  };

  // (a) Prepend into a bare (unaligned) word — two "is" words, fix the first.
  {
    const vo = [
      { type: "text", text: '"' },
      { type: "word", tag: "w", text: "is", occurrence: "1", occurrences: "2" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "2" },
      { type: "text", text: " the curse" },
    ];
    const result = smartEditVerse({ verseObjects: vo }, '"is is the curse', '"This is the curse');
    const { aligned, bare } = collectWords(result.content.verseObjects);
    const words = [...aligned, ...bare];
    assert(
      JSON.stringify(bare) === JSON.stringify(["This", "is"]),
      `prepended "Th" merges into one \\w "This" (got ${JSON.stringify(words)})`,
    );
    assert(!words.includes("Th"), `no standalone "Th" token (got ${JSON.stringify(words)})`);
    assert(
      result.plainText === '"This is the curse',
      `plain text correct (got ${JSON.stringify(result.plainText)})`,
    );
  }

  // (b) Prepend into a word still inside a \zaln-s: the merged word lifts out
  // (a translator edit invalidates the old alignment), exactly as the existing
  // word-replace path does — and it's ONE \w, not "Th" + "is".
  {
    const vo = [
      { type: "text", text: '"' },
      {
        tag: "zaln",
        type: "milestone",
        strong: "H2088",
        children: [{ type: "word", tag: "w", text: "is", occurrence: "1", occurrences: "1" }],
        endTag: "zaln-e\\*",
      },
      { type: "text", text: " the curse" },
    ];
    const result = smartEditVerse({ verseObjects: vo }, '"is the curse', '"This the curse');
    const { aligned, bare } = collectWords(result.content.verseObjects);
    assert(
      bare.join(",") === "This" && aligned.length === 0,
      `merged word is a single bare \\w "This" (bare=${JSON.stringify(bare)}, aligned=${JSON.stringify(aligned)})`,
    );
  }

  // (c) Append to the end of a word ("going" → "goings") merges too — the
  // mirror case (left-merge), so the fix isn't prepend-only.
  {
    const vo = [
      { type: "word", tag: "w", text: "going", occurrence: "1", occurrences: "1" },
      { type: "text", text: " out" },
    ];
    const result = smartEditVerse({ verseObjects: vo }, "going out", "goings out");
    const { bare } = collectWords(result.content.verseObjects);
    assert(
      bare.join(",") === "goings",
      `appended "s" merges into one \\w "goings" (got ${JSON.stringify(bare)})`,
    );
  }
}

// ─── Case 18: ghost dismissal suppresses the rejected suggestion ─────────
// The "predicted alignment" circle: accept a ghost, send it back to the bank,
// and it regenerates in the same box. The fix records a session dismissal
// (keyed by source group + target text) that computeGhosts skips — so the
// rejected suggestion can't reappear, and the NEXT-best one surfaces instead.
{
  console.log("\n[Case 18] ghost dismissal suppresses the rejected suggestion");
  const { computeGhosts, dismissedGhostKey } = await import("./alignmentSuggest.ts");

  // One empty group for a single Hebrew word; two candidate target surfaces.
  const group = {
    id: "g1",
    source: [{ id: "s1", strong: "H1", lemma: "", morph: "", occurrence: "1", occurrences: "1", content: "חֶסֶד" }],
    targets: [],
  };
  const suggestions = {
    "H1~": {
      words: [
        { surface: "love", confidence: 0.9, source: "memory" },
        { surface: "kindness", confidence: 0.6, source: "memory" },
      ],
      phrases: [],
    },
  };
  const streamWords = [
    { id: "w1", text: "love", aligned: false },
    { id: "w2", text: "kindness", aligned: false },
  ];

  // (a) No dismissals → one of the two candidates is suggested (which one wins
  // is the blend's call — position can outrank raw frequency; we don't pin it).
  const g0 = computeGhosts([group], streamWords, suggestions);
  const top = g0.get("g1")?.text;
  assert(top === "love" || top === "kindness", `a candidate is suggested (got ${JSON.stringify(g0.get("g1"))})`);

  // (b) Dismiss whichever was top → the OTHER candidate surfaces, never the
  // rejected one again.
  const dismissed = new Set([dismissedGhostKey(group, top)]);
  const g1 = computeGhosts([group], streamWords, suggestions, dismissed);
  const next = g1.get("g1")?.text;
  assert(next && next !== top, `dismissing "${top}" surfaces the other candidate (got ${JSON.stringify(next)})`);

  // (c) Dismiss both → the group goes blank (no ghost).
  const dismissed2 = new Set([dismissedGhostKey(group, "love"), dismissedGhostKey(group, "kindness")]);
  const g2 = computeGhosts([group], streamWords, suggestions, dismissed2);
  assert(!g2.has("g1"), `after dismissing both candidates, no ghost remains (got ${JSON.stringify(g2.get("g1"))})`);

  // (d) Key stability: same group + text → same key (so re-parsed group ids
  // don't leak), and it's case / NFC-insensitive on the target text.
  const groupClone = JSON.parse(JSON.stringify({ ...group, id: "g1-reparsed" }));
  assert(
    dismissedGhostKey(group, "love") === dismissedGhostKey(groupClone, "Love"),
    `key ignores group id and target casing`,
  );
  assert(
    dismissedGhostKey(group, "love") !== dismissedGhostKey(group, "kindness"),
    `different target text → different key`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll alignment tests passed.");

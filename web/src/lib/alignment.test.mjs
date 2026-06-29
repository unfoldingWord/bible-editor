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
  mergeGroups,
  moveSource,
  clearGroup,
  stripCompoundOverlaps,
  mergeAdjacentSameSource,
  mergeSamePositionGroups,
  sourceKey,
  cardKey,
} from "./alignment.ts";
import { extractPlainText } from "./usfm.ts";
import { findTargetHighlights, findSourceHighlights } from "./highlight.ts";
import { buildQuoteFromSelection, collectTargetTokens, tokenKey } from "./quoteBuilder.ts";

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
  // same-line `\qs Selah\qs*` parks Selah on the qs node's text (no children);
  // it must still surface as a draggable, alignable unaligned word.
  assert(
    state.unaligned.map((w) => w.text).includes("Selah"),
    `Selah surfaces as an alignable unaligned word (got ${JSON.stringify(state.unaligned.map((w) => w.text))})`,
  );
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

// ─── Case 11b: merge group is ATOMIC regardless of nesting depth ──────────
//
// A merge group (N source words ↔ M target words) serializes as a chain of
// nested \zaln-s with ALL target \w at the innermost level. Quoting ANY source
// word in the chain — outer, middle, or innermost — must light the WHOLE
// group's targets. Before the subtree fix, only the innermost source word lit
// the targets while every outer source word lit nothing (a depth-dependent
// asymmetry). ZEC 6:5: מֵהִתְיַצֵּב>עַל>אֲדוֹן>כָּל>הָאָרֶץ ↔ "the earth one".
{
  console.log("\n[Case 11b] merge group is atomic regardless of nesting depth");
  const nest = (content, occurrence, children) => ({
    tag: "zaln",
    type: "milestone",
    occurrence,
    occurrences: 1,
    content,
    children,
  });
  // Innermost milestone (כָּל) carries the two target words.
  const inner = nest("כָּל", 1, [
    { type: "word", tag: "w", text: "the", occurrence: 1, occurrences: 1 },
    { type: "word", tag: "w", text: "earth", occurrence: 1, occurrences: 1 },
  ]);
  const verseObjects = [nest("מֵֽ⁠הִתְיַצֵּ֖ב", 1, [nest("עַל", 1, [nest("אֲד֥וֹן", 1, [inner])])])];

  const expect = ["the|1", "earth|1"];
  for (const src of ["מֵֽ⁠הִתְיַצֵּ֖ב", "עַל", "אֲד֥וֹן", "כָּל"]) {
    const hl = findTargetHighlights(verseObjects, src, 1);
    assert(
      expect.every((k) => hl.has(k)) && hl.size === expect.length,
      `quoting "${src}" lights the whole merge group {the,earth} (got ${[...hl].join(",") || "∅"})`,
    );
  }
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

  // Selection keys go through tokenKey — the same fold the picker uses — so
  // the U+2060 word-joiner inside these tokens is stripped on BOTH sides
  // (matchNorm); a raw `${text}|${occ}` literal would no longer match the
  // collectUhbWords key after the tokenKey→matchNorm change.

  // Two adjacent words → single quote, occurrence 1.
  const sel1 = new Set([tokenKey("בַּ⁠חֹ֣דֶשׁ", 1), tokenKey("הָֽ⁠רִאשׁ֔וֹן", 1)]);
  const b1 = buildQuoteFromSelection(verseObjects, sel1);
  assert(b1 !== null, "builder returns non-null for valid selection");
  assert(
    b1?.quote === "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן",
    `single-group quote (got: ${b1?.quote})`,
  );
  assert(b1?.occurrence === 1, `occurrence=1 for first instance (got: ${b1?.occurrence})`);

  // The same pair, but the SECOND occurrence → occurrence 2.
  const sel2 = new Set([tokenKey("בַּ⁠חֹ֣דֶשׁ", 2), tokenKey("הָֽ⁠רִאשׁ֔וֹן", 2)]);
  const b2 = buildQuoteFromSelection(verseObjects, sel2);
  assert(b2?.quote === "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן", `same quote shape for second occurrence`);
  assert(b2?.occurrence === 2, `occurrence=2 for second instance (got: ${b2?.occurrence})`);

  // Disjoint selection → ' & ' separator. Picking word 1 and word 4
  // produces a two-group quote.
  const sel3 = new Set([tokenKey("וַ⁠יָּבֹ֣אוּ", 1), tokenKey("בַּ⁠חֹ֣דֶשׁ", 1)]);
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

  // Picker click handler: dump every ancestor's selection KEY into the set —
  // a.key is tokenKey(content, occ) (matchNorm-folded), exactly what
  // QuoteBuilderPopper's handleEnglishClick adds. Using the raw
  // `${content}|${occ}` would miss the U+2060-stripped key the UHB row carries.
  const selection = new Set();
  for (const a of firstTok?.sources ?? []) {
    selection.add(a.key);
  }

  const built = buildQuoteFromSelection(uhb, selection);
  assert(built !== null, "buildQuoteFromSelection returns a quote");
  assert(
    built?.quote === "בַּ⁠חֹ֣דֶשׁ הָֽ⁠רִאשׁ֔וֹן",
    `quote round-trips through UHB (got: ${built?.quote})`,
  );
  assert(built?.occurrence === 1, `occurrence=1 (got: ${built?.occurrence})`);
}

// ─── Case 14b: tokenKey folds U+2060 so picker ↔ builder agree ────────────
//
// The highlighter joins quote↔token equality via matchNorm (NFC + word-joiner
// U+2060/U+200D stripping). The quote-builder's tokenKey used to fold by nfc()
// ONLY, leaving the joiner in. When an AI-generated zaln x-content omits a
// U+2060 that the UHB \w token carries (a known drift), the two minted
// different keys: clicking the English chip toggled a phantom key, and
// buildQuoteFromSelection (whose UhbWord.key is also tokenKey) never saw the
// selection, so the quote never built. tokenKey now uses matchNorm too, so one
// fold governs both sides regardless of which copy carries the joiner.
{
  console.log("\n[Case 14b] tokenKey folds U+2060 — picker chip ↔ UHB token");
  const J = "⁠"; // WORD JOINER

  // UHB token carries the joiner (הָ⁠אֶבֶן). Build a quote from a selection
  // key authored WITHOUT the joiner (as an AI x-content would emit it).
  const uhb = [
    { type: "word", tag: "w", text: `הָ${J}אֶ֧בֶן`, occurrence: 1, occurrences: 1 },
  ];
  const selNoJoiner = new Set([tokenKey("הָאֶ֧בֶן", 1)]);
  const built = buildQuoteFromSelection(uhb, selNoJoiner);
  assert(built !== null, "builder matches a joiner-less selection key against a joiner-carrying UHB token");
  assert(built?.quote === `הָ${J}אֶ֧בֶן`, `quote renders the RAW UHB text incl. joiner (got: ${JSON.stringify(built?.quote)})`);

  // Symmetry: a zaln content WITHOUT the joiner and a UHB token WITH it mint
  // the SAME key now (matchNorm strips it on both).
  assert(
    tokenKey(`הָ${J}אֶ֧בֶן`, 1) === tokenKey("הָאֶ֧בֶן", 1),
    "tokenKey is joiner-insensitive (joiner and joiner-less mint one key)",
  );
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

  // (e†) stripTrailingMarkers — the exact inverse of extractTrailingMarkers,
  // used by the display render paths (book/doc/column) so a verse's own
  // trailing markers (which drift to the NEXT verse) aren't rendered twice.
  // Real usfm-js shape: a `\qa ZAYIN` acrostic header parses as
  // {tag:"qa", type:"quote", text:"ZAYIN\n"} — the letter rides ON the marker,
  // so dropping the marker drops the doubled letter.
  {
    const { extractTrailingMarkers, stripTrailingMarkers } = await import("./usfm.ts");
    const acrostic = [
      { type: "word", tag: "w", text: "them" },
      { type: "text", text: ".\n\n" },
      { tag: "qa", type: "quote", text: "ZAYIN\n" },
      { tag: "q1", type: "quote", nextChar: " " },
    ];
    const body = stripTrailingMarkers(acrostic);
    assert(
      body.length === 2 && !JSON.stringify(body).includes("ZAYIN"),
      `acrostic \\qa+\\q1 stripped from body; letter no longer doubled (got ${JSON.stringify(body)})`,
    );
    // strip + extract reconstructs the original — markers move, nothing is lost
    assert(
      JSON.stringify([...body, ...extractTrailingMarkers(acrostic)]) === JSON.stringify(acrostic),
      `stripTrailingMarkers is the exact inverse of extractTrailingMarkers`,
    );
    // verse ending in real text → unchanged reference (no trailing markers)
    const plain = [{ type: "word", tag: "w", text: "plain" }, { type: "text", text: "." }];
    assert(stripTrailingMarkers(plain) === plain, `no trailing markers → array returned unchanged`);
    // non-array guard
    assert(
      Array.isArray(stripTrailingMarkers(null)) && stripTrailingMarkers(null).length === 0,
      `non-array input → []`,
    );
  }

  // (e‡) A verse-final same-line `\qs Selah\qs*` is verse CONTENT, not a
  // driftable line marker — it must NOT be peeled off / drifted to the next
  // verse. usfm-js parses it as {tag:"qs", type:"quote", text:"Selah",
  // endTag:"qs*"}: same type:"quote" as a poetry marker, but the `endTag`
  // (the `\qs*` close) marks it a character-style wrapper that holds content.
  {
    const { extractTrailingMarkers, stripTrailingMarkers } = await import("./usfm.ts");
    const selah = [
      { type: "text", text: "Praise. " },
      { tag: "qs", type: "quote", text: "Selah", endTag: "qs*" },
      { type: "text", text: "\n" },
    ];
    assert(
      extractTrailingMarkers(selah).length === 0,
      `\\qs Selah\\qs* does not drift to the next verse (got ${JSON.stringify(extractTrailingMarkers(selah))})`,
    );
    assert(
      stripTrailingMarkers(selah) === selah,
      `\\qs Selah\\qs* stays in the verse body (Selah not stripped)`,
    );
    // A real poetry marker AFTER the wrapper still drifts; the wrapper stops the
    // backward scan, so only the trailing \q1 is peeled (Selah stays put).
    const selahThenQ1 = [
      { type: "text", text: "Praise. " },
      { tag: "qs", type: "quote", text: "Selah", endTag: "qs*" },
      { tag: "q1", type: "quote", nextChar: " " },
    ];
    const drifted = extractTrailingMarkers(selahThenQ1);
    assert(
      drifted.length === 1 && drifted[0].tag === "q1",
      `trailing \\q1 after \\qs still drifts; \\qs does not (got ${JSON.stringify(drifted)})`,
    );
    assert(
      JSON.stringify(stripTrailingMarkers(selahThenQ1)).includes("Selah"),
      `Selah survives in the stripped body`,
    );
    // Improperly-closed `\qs Selah` (no `\qs*`) — older gatewayEdit left these in
    // DCS. usfm-js parses them with an EMPTY endTag ({tag:"qs", endTag:""}), so an
    // endTag-only guard would miss them; the wrapper-tag check keeps Selah put.
    const selahUnclosed = [
      { type: "text", text: "He is good " },
      { tag: "qs", type: "quote", text: "Selah\n", children: [], endTag: "" },
    ];
    assert(
      extractTrailingMarkers(selahUnclosed).length === 0,
      `unclosed \\qs Selah (endTag:"") does not drift (got ${JSON.stringify(extractTrailingMarkers(selahUnclosed))})`,
    );
    assert(
      stripTrailingMarkers(selahUnclosed) === selahUnclosed,
      `unclosed \\qs Selah stays in the verse body`,
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

// ─── Case 19: mergeGroups — fold one whole alignment card into another ───
// Drag a whole card onto another to combine the groups: the eaten group's
// source words append to the survivor's chain and all its English re-points to
// the survivor. A single-word group merged this way behaves exactly like
// dragging its lone Hebrew word via moveSource (it collapses, English follows).
// Reversible via clearGroup (splits the compound back into singletons).
{
  console.log("\n[Case 19] mergeGroups — fold one alignment card into another");
  const byStrong = (st, strong) => st.groups.find((g) => g.source.some((s) => s.strong === strong));
  const srcStrongs = (g) => g.source.map((s) => s.strong);
  const targetTexts = (g) => g.targets.map((t) => t.text);

  // (a) compound + compound → one 4-word compound, targets in stream order.
  {
    const target = String.raw`\id TST
\c 1
\v 1 \zaln-s |x-strong="H1" x-content="א"\*\zaln-s |x-strong="H2" x-content="ב"\*\w one|x-occurrence="1" x-occurrences="1"\w* \w two|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\zaln-e\* \zaln-s |x-strong="H3" x-content="ג"\*\zaln-s |x-strong="H4" x-content="ד"\*\w three|x-occurrence="1" x-occurrences="1"\w* \w four|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\zaln-e\*`;
    const state = parseAlignment(parseSingleVerse(target).verseObjects, null);
    assert(state.groups.length === 2, `starts with 2 compound groups (got ${state.groups.length})`);
    const A = byStrong(state, "H1");
    const B = byStrong(state, "H3");
    const merged = mergeGroups(state, A.id, B.id);
    assert(merged.groups.length === 1, `compound+compound merge → 1 group (got ${merged.groups.length})`);
    const m = merged.groups[0];
    assert(
      JSON.stringify(srcStrongs(m)) === JSON.stringify(["H1", "H2", "H3", "H4"]),
      `merged source = survivor chain then eaten chain (got ${JSON.stringify(srcStrongs(m))})`,
    );
    assert(
      JSON.stringify(targetTexts(m)) === JSON.stringify(["one", "two", "three", "four"]),
      `targets re-derive in stream order (got ${JSON.stringify(targetTexts(m))})`,
    );
    // serialize → reparse stays a single 4-source group (valid USFM, no loss).
    const reparsed = parseAlignment(serializeAlignment(merged), null);
    assert(reparsed.groups.length === 1, `serialize→reparse keeps 1 group (got ${reparsed.groups.length})`);
    assert(reparsed.groups[0].source.length === 4, `reparsed group has 4 source words (got ${reparsed.groups[0].source.length})`);
  }

  // (b) single-word group folded into a compound — the moveSource-equivalent
  // case. solo's lone Hebrew word joins the chain and "solo" re-points.
  {
    const target = String.raw`\id TST
\c 1
\v 2 \zaln-s |x-strong="H5" x-content="ה"\*\w solo|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="H6" x-content="ו"\*\zaln-s |x-strong="H7" x-content="ז"\*\w pair|x-occurrence="1" x-occurrences="1"\w* \w mate|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\zaln-e\*`;
    const st = parseAlignment(parseSingleVerse(target).verseObjects, null);
    const solo = byStrong(st, "H5");
    const pair = byStrong(st, "H6");
    assert(solo.source.length === 1, `solo is a single-word group (got ${solo.source.length})`);
    const m = mergeGroups(st, pair.id, solo.id);
    assert(m.groups.length === 1, `single+compound merge → 1 group (got ${m.groups.length})`);
    const g = m.groups[0];
    assert(
      JSON.stringify(srcStrongs(g)) === JSON.stringify(["H6", "H7", "H5"]),
      `survivor(compound) chain then eaten(single) (got ${JSON.stringify(srcStrongs(g))})`,
    );
    assert(
      JSON.stringify(targetTexts(g)) === JSON.stringify(["solo", "pair", "mate"]),
      `solo's English follows the merge, in stream order (got ${JSON.stringify(targetTexts(g))})`,
    );
    const soloWord = m.stream.find((it) => it.kind === "word" && it.word.text === "solo");
    assert(soloWord && soloWord.alignedTo === pair.id, `"solo" stream word re-points to the survivor group id`);

    // (c) no-op guards: equal ids, missing eaten, missing survivor.
    assert(mergeGroups(st, solo.id, solo.id) === st, `self-merge is a no-op (same ref)`);
    assert(mergeGroups(st, solo.id, "nope") === st, `missing eaten id is a no-op`);
    assert(mergeGroups(st, "nope", pair.id) === st, `missing survivor id is a no-op`);

    // (d) reversible: clearGroup splits the merged compound back to singletons
    // and frees its English — the Undo affordance, so a merge isn't a trap.
    const split = clearGroup(m, pair.id);
    assert(split.groups.length === 3, `clearGroup splits merged compound into 3 singletons (got ${split.groups.length})`);
    assert(split.groups.every((gr) => gr.source.length === 1), `each split group is a singleton`);
    assert(split.unaligned.length === 3, `all 3 English words return to the bank (got ${split.unaligned.length})`);
  }
}

// ─── Case 20: ZEC 5:4 — wide-gap discontinuous source highlight ───────────
// The zvhg writing-pronouns TN quote is three disjoint UHB words: וּבָאָה (5th
// token), וְלָנֶה (14th, a 9-token gap later), and וְכִלַּתּוּ (17th, near the
// end). A previous fixed cap (MAX_RUN_GAP=6) made the second group unreachable,
// so the whole match returned null and NOTHING highlighted in the UHB on prod.
// quoteBuilder's matcher never had that cap, so it would author a quote the
// highlighter couldn't find. Regression: a discontinuous quote must highlight
// exactly its group words — however far apart — and never the gap words.
{
  console.log("\n[Case 20] ZEC 5:4 wide-gap discontinuous source highlight");
  const uhb = readFileSync(resolve(repoRoot, "docs/samples/hbo_uhb_38-ZEC.usfm"), "utf-8");
  const verseObjects = usfm.toJSON(uhb).chapters["5"]["4"].verseObjects;

  // Collect bare \w tokens in document order to derive exact-byte expectations
  // (avoids hand-typed Hebrew drifting from the parsed source).
  const words = [];
  (function walk(nodes) {
    for (const n of nodes ?? []) {
      if (n?.type === "word" && n?.tag === "w") words.push(String(n.text ?? ""));
      else if (n?.type === "milestone") walk(n.children ?? []);
    }
  })(verseObjects);

  const g1 = words[4], g2 = words[13], g3 = words[16]; // the three quote words
  const gapWord = words[7]; // הַ⁠גַּנָּב — sits between g1 and g2, must NOT light up
  const quote = `${g1} & ${g2} & ${g3}`; // === the real zvhg TSV quote

  const hl = findSourceHighlights(verseObjects, quote, 1);
  assert(
    hl.size === 3,
    `ZEC 5:4: wide-gap quote highlights exactly its 3 group words (got ${hl.size}: ${[...hl].join(",")})`,
  );
  assert(hl.has(`${g1}|1`), `ZEC 5:4: highlights group 1 (וּבָאָה)`);
  assert(hl.has(`${g2}|1`), `ZEC 5:4: highlights group 2 (וְלָנֶה, 9 tokens after group 1)`);
  assert(hl.has(`${g3}|1`), `ZEC 5:4: highlights group 3 (וְכִלַּתּוּ)`);
  assert(!hl.has(`${gapWord}|1`), `ZEC 5:4: must NOT highlight the gap word between groups`);
}

// ─── Case 21: editor whitespace divergence must not nuke alignment ────────
// saveVerseDraft diffs the whitespace-collapsed extractEditableText baseline
// against the RAW textContent/innerText captured from the contenteditable. A
// single divergent tail char (trailing space, innerText block-newline, toolbar
// `&nbsp;` U+00A0, `&#8203;` U+200B placeholder) used to collapse
// diffSingleChange's common suffix to zero, so the change range ballooned to
// the verse end and localizedRewriteVerse dropped every \zaln-s after the edit
// — the "alignment from there to the end goes away" bug. smartEditVerse now
// normalizes both inputs so the diff sees only the genuine edit.
{
  console.log("\n[Case 21] editor whitespace divergence preserves alignment");
  const { smartEditVerse } = await import("./replace.ts");
  const { extractEditableText, normalizeEditable } = await import("./usfm.ts");

  const target = String.raw`\v 1 \zaln-s |x-strong="H1"\*\w he|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\zaln-s |x-strong="H2"\*\w is|x-occurrence="1" x-occurrences="3"\w*\zaln-e\*
\zaln-s |x-strong="H3"\*\w good|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*,
\zaln-s |x-strong="H4"\*\w she|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\zaln-s |x-strong="H2"\*\w is|x-occurrence="2" x-occurrences="3"\w*\zaln-e\*
\zaln-s |x-strong="H5"\*\w kind|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*.`;
  const json = usfm.toJSON(`\\id TST\n\\c 1\n${target}\n`);
  const content = { verseObjects: json.chapters["1"]["1"].verseObjects };
  const baseline = extractEditableText(content.verseObjects);

  const collect = (result) => {
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
    return { aligned, bare };
  };

  // The single genuine edit in every variant: good -> great.
  const expectOnlyGreatUnaligned = (label, captured) => {
    const result = smartEditVerse(content, baseline, captured);
    const { aligned, bare } = collect(result);
    assert(
      bare.join(",") === "great",
      `${label}: only the edited word unaligns (got bare [${bare.join(",")}])`,
    );
    assert(
      aligned.join(",") === "he,is,she,is,kind",
      `${label}: every other word stays aligned (got [${aligned.join(",")}])`,
    );
    assert(result.preservedAlignment === true, `${label}: preservedAlignment stays true`);
  };

  // (a) Trailing space — the proven repro. textContent commonly ends with one.
  expectOnlyGreatUnaligned("trailing space", baseline.replace("good", "great") + " ");

  // (b) innerText block-newline — DocColumn/BookView read innerText, which
  // inserts \n between block-level <div>s. An embedded \n must collapse away.
  expectOnlyGreatUnaligned("embedded newline", baseline.replace("good", "great").replace(" ", "\n"));

  // (c) Toolbar `&nbsp;` (U+00A0) injected after a chip / between words.
  expectOnlyGreatUnaligned("nbsp U+00A0", baseline.replace("good", "great") + " ");

  // (d) `&#8203;` (U+200B) empty-block placeholder — stripped, never saved.
  {
    const result = smartEditVerse(content, baseline, baseline.replace("good", "great") + "​");
    const { aligned, bare } = collect(result);
    assert(bare.join(",") === "great", `ZWSP: only the edited word unaligns (got [${bare.join(",")}])`);
    assert(aligned.join(",") === "he,is,she,is,kind", `ZWSP: every other word stays aligned (got [${aligned.join(",")}])`);
    let zwsp = 0;
    const scan = (xs) => {
      for (const n of xs ?? []) {
        if (typeof n?.text === "string" && n.text.includes("​")) zwsp++;
        if (Array.isArray(n?.children)) scan(n.children);
      }
    };
    scan(result.content.verseObjects);
    assert(zwsp === 0, `ZWSP: no U+200B leaks into saved verseObjects (got ${zwsp})`);
    assert(!result.plainText.includes("​"), `ZWSP: no U+200B in plainText`);
  }

  // (e) Normalizer contract: it collapses every editor-artifact class
  // (ASCII whitespace, U+00A0 nbsp, U+200B zwsp) to the same canonical form
  // extractEditableText produces, and is idempotent on an already-clean
  // baseline — so the diff's two sides can never drift apart.
  assert(normalizeEditable(baseline) === baseline, `idempotent on the extractEditableText baseline`);
  assert(
    normalizeEditable("\\p  A  ​ B \n") === "\\p A B",
    `collapses double space / nbsp / zwsp / trailing newline to canonical form (got ${JSON.stringify(normalizeEditable("\\p  A  ​ B \n"))})`,
  );
}

// ─── Case 22: ZEC 6:2 — split source token (occurrence>occurrences) highlight ──
// Prod ULT renders one Hebrew token whose English gloss is NON-CONTIGUOUS as
// TWO `\zaln-s` runs with the same x-content, the second stamped
// occurrence="2" while occurrences stays "1" (impossible — "the 2nd of 1").
// For בַּ⁠מֶּרְכָּבָה → "In the" … (interrupted by "first") … "chariot", the split
// parked "chariot" in the second run, so the translate-ordinal note (d8lb,
// quote `בַּ⁠מֶּרְכָּבָה הָ⁠רִאשֹׁנָה & וּ⁠בַ⁠מֶּרְכָּבָה הַ⁠שֵּׁנִית`) lit up "In the
// first" and "and in the second" but NEVER "chariot". collectMilestoneRuns now
// folds the continuation back into the first run so both "chariot"s highlight.
{
  console.log("\n[Case 22] ZEC 6:2 split-source-token highlight (occurrence>occurrences)");
  // Define each Hebrew content ONCE so the milestone content and the quote
  // share byte-identical strings (no hand-typed cantillation drift).
  const baChariot = "בַּ⁠מֶּרְכָּבָ֥ה"; //   "in the chariot"
  const haFirst = "הָ⁠רִֽאשֹׁנָ֖ה"; //       "the first"
  const susimA = "סוּסִ֣ים"; //              "horses" (clause 1 cantillation)
  const adummim = "אֲדֻמִּ֑ים"; //           "red"
  const ubaChariot = "וּ⁠בַ⁠מֶּרְכָּבָ֥ה"; // "and in the chariot"
  const haSecond = "הַ⁠שֵּׁנִ֖ית"; //        "the second"
  const susimB = "סוּסִ֥ים"; //              "horses" (clause 2 cantillation)
  const shechorim = "שְׁחֹרִֽים"; //          "black"

  const ms = (content, occurrence, occurrences, words) => ({
    type: "milestone", tag: "zaln", content,
    occurrence: String(occurrence), occurrences: String(occurrences),
    children: words.map(([text, o, os]) => ({
      type: "word", tag: "w", text, occurrence: String(o), occurrences: String(os),
    })),
  });

  // Verbatim shape of prod ULT ZEC 6:2: split continuations marked ← below.
  const verseObjects = [
    ms(baChariot, 1, 1, [["In", 1, 1], ["the", 1, 2]]),
    ms(haFirst, 1, 1, [["first", 1, 1]]),
    ms(baChariot, 2, 1, [["chariot", 1, 2]]), //                 ← split continuation
    ms(susimA, 1, 1, [["were", 1, 2]]),
    ms(adummim, 1, 1, [["red", 1, 1]]),
    ms(susimA, 2, 1, [["horses", 1, 2]]), //                     ← split continuation
    ms(ubaChariot, 1, 1, [["and", 1, 1], ["in", 1, 1], ["the", 2, 2]]),
    ms(haSecond, 1, 1, [["second", 1, 1]]),
    ms(ubaChariot, 2, 1, [["chariot", 2, 2]]), //                ← split continuation
    ms(susimB, 1, 1, [["were", 2, 2]]),
    ms(shechorim, 1, 1, [["black", 1, 1]]),
    ms(susimB, 2, 1, [["horses", 2, 2]]), //                     ← split continuation
  ];

  const quote = `${baChariot} ${haFirst} & ${ubaChariot} ${haSecond}`;
  const hl = findTargetHighlights(verseObjects, quote, 1);

  // The regression: both "chariot"s — parked in the split-continuation runs —
  // now light up.
  assert(hl.has("chariot|1"), `ZEC 6:2: highlights first chariot (the bug). Got: ${[...hl].join(",")}`);
  assert(hl.has("chariot|2"), `ZEC 6:2: highlights second chariot. Got: ${[...hl].join(",")}`);
  // …alongside the rest of the two quoted phrases.
  for (const key of ["In|1", "the|1", "first|1", "and|1", "in|1", "the|2", "second|1"]) {
    assert(hl.has(key), `ZEC 6:2: highlights ${key}. Got: ${[...hl].join(",")}`);
  }
  // No bleed into the unquoted horses / colors (σוּסִים / red / black runs).
  assert(!hl.has("red|1"), `ZEC 6:2: must NOT highlight "red". Got: ${[...hl].join(",")}`);
  assert(!hl.has("black|1"), `ZEC 6:2: must NOT highlight "black". Got: ${[...hl].join(",")}`);
  assert(
    !hl.has("horses|1") && !hl.has("horses|2"),
    `ZEC 6:2: must NOT highlight "horses". Got: ${[...hl].join(",")}`,
  );
}

// ─── Case 23: ZEC 6:2 — quote-builder picker selects split-token target words ─
// Companion to Case 22 (which fixed the scripture-column highlight). The
// "Build quote" popper lights up an ULT/UST chip when every source ancestor in
// its chain is in the selection set (chainSelected). collectTargetTokens stamps
// each ancestor's selection key from the milestone occurrence — so the split
// continuation בַּ⁠מֶּרְכָּבָה occurrence="2"/occurrences="1" gave "chariot" the
// key …|2, a phantom the single UHB token (…|1) can never match. So clicking
// the Hebrew (or "In"/"the") selected "In the" but left "chariot" dark, and
// clicking "chariot" toggled a key that built nothing. Clamping occurrence into
// [1, occurrences] folds "chariot" onto …|1 with its siblings.
{
  console.log("\n[Case 23] ZEC 6:2 picker selects split-token target words");
  const baChariot = "בַּ⁠מֶּרְכָּבָ֥ה"; //   "in the chariot"
  const haFirst = "הָ⁠רִֽאשֹׁנָ֖ה"; //       "the first"
  const ubaChariot = "וּ⁠בַ⁠מֶּרְכָּבָ֥ה"; // "and in the chariot"
  const haSecond = "הַ⁠שֵּׁנִ֖ית"; //        "the second"

  const ms = (content, occurrence, occurrences, words) => ({
    type: "milestone", tag: "zaln", content,
    occurrence: String(occurrence), occurrences: String(occurrences),
    children: words.map(([text, o, os]) => ({
      type: "word", tag: "w", text, occurrence: String(o), occurrences: String(os),
    })),
  });

  const ult = [
    ms(baChariot, 1, 1, [["In", 1, 1], ["the", 1, 2]]),
    ms(haFirst, 1, 1, [["first", 1, 1]]),
    ms(baChariot, 2, 1, [["chariot", 1, 2]]), //   ← split continuation
    ms(ubaChariot, 1, 1, [["and", 1, 1], ["in", 1, 1], ["the", 2, 2]]),
    ms(haSecond, 1, 1, [["second", 1, 1]]),
    ms(ubaChariot, 2, 1, [["chariot", 2, 2]]), //  ← split continuation
  ];

  const toks = collectTargetTokens(ult);
  const srcKey = (text, occ = 1) => {
    const t = toks.find((x) => x.text === text && x.occurrence === occ);
    assert(t !== undefined, `found target token "${text}" occ=${occ}`);
    return t.sources.map((s) => s.key);
  };
  // chainSelected mirror (the helper is private to QuoteBuilderPopper).
  const lit = (text, occ, sel) => srcKey(text, occ).every((k) => sel.has(k));

  // "chariot" (1st) and "In"/"the" now resolve to the SAME source key.
  const baKey = tokenKey(baChariot, 1); // the single UHB token's selection key
  assert(srcKey("In").join() === baKey, `"In" keys to בַּ⁠מֶּרְכָּבָה|1 (got ${srcKey("In").join()})`);
  assert(
    srcKey("chariot", 1).join() === baKey,
    `the bug: 1st "chariot" keys to בַּ⁠מֶּרְכָּבָה|1 (got ${srcKey("chariot", 1).join()})`,
  );

  // Selecting the first Hebrew token lights up In + the + chariot together,
  // and never the second clause.
  const sel1 = new Set([baKey]);
  assert(lit("In", 1, sel1), `selecting בַּ⁠מֶּרְכָּבָה lights "In"`);
  assert(lit("the", 1, sel1), `selecting בַּ⁠מֶּרְכָּבָה lights "the"(1)`);
  assert(lit("chariot", 1, sel1), `selecting בַּ⁠מֶּרְכָּבָה lights "chariot"(1) — the fix`);
  assert(!lit("chariot", 2, sel1), `must NOT light the 2nd "chariot" (belongs to וּ⁠בַ⁠מֶּרְכָּבָה)`);
  assert(!lit("second", 1, sel1), `must NOT light "second"`);

  // The second clause is symmetric: its four words share וּ⁠בַ⁠מֶּרְכָּבָה|1.
  const ubaKey = tokenKey(ubaChariot, 1);
  const sel2 = new Set([ubaKey]);
  assert(lit("and", 1, sel2), `selecting וּ⁠בַ⁠מֶּרְכָּבָה lights "and"`);
  assert(lit("chariot", 2, sel2), `selecting וּ⁠בַ⁠מֶּרְכָּבָה lights "chariot"(2)`);
  assert(!lit("chariot", 1, sel2), `must NOT light the 1st "chariot"`);
}

// ─── Case 24: reordered target — quote contiguous in source, scattered in target ─
//
// ULT/UST milestone order follows the ENGLISH, which freely permutes and
// interleaves source words relative to the Hebrew/Greek the quote is written
// in. A quote that is contiguous in the source (and highlights fine on
// UHB/UGNT) is then NON-adjacent — often non-monotonic — in target order.
// findTargetHighlights OL-anchors: it resolves the quote against the SOURCE
// (UHB) verse, then maps via the alignment (content, occurrence) — order
// independent. With NO source verse it degrades to a GL-only set match.
// Real bug: ISA 28:1 wdkm `עֲטֶרֶת גֵּאוּת שִׁכֹּרֵי אֶפְרַיִם` scatters its four
// words across the whole UST verse.
{
  console.log("\n[Case 24] ISA 28:1 reordered UST target (real sample) — OL-anchored + degradation");
  const ust = usfm.toJSON(readFileSync(resolve(repoRoot, "docs/samples/en_ust_23-ISA.usfm"), "utf-8"));
  const uhb = usfm.toJSON(readFileSync(resolve(repoRoot, "docs/samples/hbo_uhb_23-ISA.usfm"), "utf-8"));
  const ustVo = ust.chapters["28"]["1"].verseObjects;
  const uhbVo = uhb.chapters["28"]["1"].verseObjects;
  const quote = "עֲטֶ֤רֶת גֵּאוּת֙ שִׁכֹּרֵ֣י אֶפְרַ֔יִם";
  // Run both the OL-anchored path (with the UHB source) and the degradation
  // path (no source) — for this all-occurrence-1 quote they must agree.
  for (const [label, hl] of [
    ["OL-anchored", findTargetHighlights(ustVo, quote, 1, uhbVo)],
    ["degradation", findTargetHighlights(ustVo, quote, 1)],
  ]) {
    // The four quoted source words land on four scattered English spans.
    assert(hl.has("crown|1"), `ISA 28:1 (${label}): עֲטֶרֶת lights "crown". Got: ${[...hl].sort().join(",")}`);
    assert(hl.has("proud|1"), `ISA 28:1 (${label}): גֵּאוּת lights "proud"`);
    assert(hl.has("drunk|1"), `ISA 28:1 (${label}): שִׁכֹּרֵי lights "drunk"`);
    assert(hl.has("Samaria|1"), `ISA 28:1 (${label}): אֶפְרַיִם lights "Samaria"`);
    // No bleed into the unquoted neighbours (צְבִי תִפְאַרְתּוֹ / רֹאשׁ / וְצִיץ / יָיִן).
    for (const key of ["beautiful|1", "hilltop|1", "flower|1", "wine|1"]) {
      assert(!hl.has(key), `ISA 28:1 (${label}): must NOT highlight ${key}. Got: ${[...hl].sort().join(",")}`);
    }
  }
}

// ─── Case 25: degradation path respects occurrence + lights split-gloss dups ──
//
// Synthetic verse with NO source verse supplied (degradation path). The quote
// "A B" is never adjacent in target order (an unquoted milestone always sits
// between A and B). "A"/"B" each occur twice (occ 1 and 2): wantOcc must pick
// the matching source occurrence and never bleed across. A split-gloss
// duplicate (same content+occurrence appearing twice) must light both copies.
{
  console.log("\n[Case 25] degradation path: occurrence + split-gloss");
  const A = "אָלֶף";
  const B = "בֵּית";
  const X = "גִּימֶל";
  const ms = (content, occurrence, words) => ({
    type: "milestone", tag: "zaln", content,
    occurrence: String(occurrence), occurrences: "2",
    children: words.map(([text, o]) => ({
      type: "word", tag: "w", text, occurrence: String(o), occurrences: "1",
    })),
  });
  const verseObjects = [
    ms(A, 1, [["a1", 1]]),
    ms(X, 1, [["x1", 1]]),   // intervening — breaks A|B adjacency
    ms(B, 1, [["b1", 1]]),
    ms(A, 1, [["a1dup", 1]]), // split-gloss continuation of A occ 1 (same content+occ)
    ms(A, 2, [["a2", 1]]),
    ms(X, 2, [["x2", 1]]),
    ms(B, 2, [["b2", 1]]),
  ];
  const occ1 = findTargetHighlights(verseObjects, `${A} ${B}`, 1);
  assert(occ1.has("a1|1") && occ1.has("b1|1"), `occ1 lights a1+b1. Got: ${[...occ1].join(",")}`);
  assert(occ1.has("a1dup|1"), `occ1 lights the split-gloss duplicate a1dup. Got: ${[...occ1].join(",")}`);
  assert(!occ1.has("a2|1") && !occ1.has("b2|1"), `occ1 must NOT bleed into occ2. Got: ${[...occ1].join(",")}`);
  assert(!occ1.has("x1|1"), `occ1 must NOT light intervening x1. Got: ${[...occ1].join(",")}`);

  const occ2 = findTargetHighlights(verseObjects, `${A} ${B}`, 2);
  assert(occ2.has("a2|1") && occ2.has("b2|1"), `occ2 lights a2+b2. Got: ${[...occ2].join(",")}`);
  assert(!occ2.has("a1|1") && !occ2.has("a1dup|1"), `occ2 must NOT light occ1. Got: ${[...occ2].join(",")}`);
}

// ─── Case 26: OL-anchoring fixes phrase-occurrence ≠ word-occurrence ──────────
//
// The case the GL-only degradation path CANNOT get right. Source order is
// [A(1) B(1) A(2) C(1)]; the quoted phrase "A C" occurs once (occurrence 1) but
// its "A" is the SECOND A in the verse (the first A stands alone earlier). The
// English then reorders, emitting C before the A's. Only by resolving against
// the source (A(2), C(1)) can we light the right A. The degradation path keys
// on the phrase occurrence (1) and wrongly lights the first A.
{
  console.log("\n[Case 26] OL-anchored: phrase-occurrence ≠ word-occurrence");
  // ASCII stand-ins for source words; nfc() is identity so the join is exact.
  const w = (text, occurrence, occurrences) => ({ type: "word", tag: "w", text, occurrence: String(occurrence), occurrences: String(occurrences) });
  const sourceVo = [w("A", 1, 2), w("B", 1, 1), w("A", 2, 2), w("C", 1, 1)];
  const ms = (content, occurrence, occurrences, en) => ({
    type: "milestone", tag: "zaln", content, occurrence: String(occurrence), occurrences: String(occurrences),
    children: [{ type: "word", tag: "w", text: en, occurrence: "1", occurrences: "1" }],
  });
  // English reorders: C, then A(2), then A(1), then B.
  const targetVo = [ms("C", 1, 1, "zee"), ms("A", 2, 2, "ay2"), ms("A", 1, 2, "ay1"), ms("B", 1, 1, "bee")];

  const anchored = findTargetHighlights(targetVo, "A C", 1, sourceVo);
  assert(anchored.has("ay2|1"), `OL-anchored lights the SECOND A (ay2). Got: ${[...anchored].join(",")}`);
  assert(anchored.has("zee|1"), `OL-anchored lights C (zee). Got: ${[...anchored].join(",")}`);
  assert(!anchored.has("ay1|1"), `OL-anchored must NOT light the first A (ay1). Got: ${[...anchored].join(",")}`);
  assert(!anchored.has("bee|1"), `OL-anchored must NOT light unquoted B (bee). Got: ${[...anchored].join(",")}`);

  // Document the limitation the OL-anchoring overcomes: without the source the
  // degradation path keys on phrase occurrence (1) and lights the WRONG A.
  const degraded = findTargetHighlights(targetVo, "A C", 1);
  assert(degraded.has("ay1|1"), `degradation (no source) lights the first A — the limitation OL-anchoring fixes. Got: ${[...degraded].join(",")}`);
}

// ─── Case 27: ZEC 4:10 — word-joiner (U+2060) quote↔token mismatch ────────
//
// UHB glues clitic morphemes to their host with U+2060 WORD JOINER
// (הָ⁠אֶ֧בֶן); TN quote text routinely omits it (5 of 302 seeded ZEC quotes).
// nfc() does NOT fold format characters away, so the real seeded quote
// `הָאֶ֧בֶן הַבְּדִ֛יל` never matched the joiner-carrying UHB tokens and
// nothing highlighted. Every quote↔token equality now strips U+2060/U+200D
// from BOTH sides (matchNorm); keys still carry the RAW token text.
{
  console.log("\n[Case 27] ZEC 4:10 word-joiner quote↔token match");
  const uhb = usfm.toJSON(readFileSync(resolve(repoRoot, "docs/samples/hbo_uhb_38-ZEC.usfm"), "utf-8"));
  const verseObjects = uhb.chapters["4"]["10"].verseObjects;

  // Pull the two real tokens (WITH joiners) from the parsed sample so the
  // expectations can't drift from the data.
  const words = [];
  (function walk(nodes) {
    for (const n of nodes ?? []) {
      if (n?.type === "word" && n?.tag === "w") words.push(String(n.text ?? ""));
      else if (n?.type === "milestone") walk(n.children ?? []);
    }
  })(verseObjects);
  const stoneTok = words[8]; // הָ⁠אֶ֧בֶן (carries U+2060)
  const tinTok = words[9];   // הַ⁠בְּדִ֛יל (carries U+2060)
  assert(stoneTok.includes("⁠") && tinTok.includes("⁠"), "UHB 4:10 tokens carry U+2060");

  // (a) The real seeded TSV quote (NO joiners) lights the joiner-carrying
  // tokens, and the highlight keys keep the RAW token text.
  const seededQuote = "הָאֶ֧בֶן הַבְּדִ֛יל";
  assert(!seededQuote.includes("⁠"), "seeded quote carries no U+2060");
  const hl = findSourceHighlights(verseObjects, seededQuote, 1);
  assert(hl.has(`${stoneTok}|1`), `joiner-less quote lights הָ⁠אֶ֧בֶן (raw key). Got: ${[...hl].join(",")}`);
  assert(hl.has(`${tinTok}|1`), `joiner-less quote lights הַ⁠בְּדִ֛יל (raw key). Got: ${[...hl].join(",")}`);
  assert(hl.size === 2, `exactly the two quoted tokens light up (got ${hl.size})`);

  // (b) Builder-authored quotes (which DO carry the joiners — raw token
  // text) keep round-tripping through the same matcher.
  const sel = new Set([tokenKey(stoneTok, 1), tokenKey(tinTok, 1)]);
  const built = buildQuoteFromSelection(verseObjects, sel);
  assert(built !== null && built.quote.includes("⁠"), `built quote keeps the raw joiners (got ${JSON.stringify(built?.quote)})`);
  const hlBuilt = findSourceHighlights(verseObjects, built.quote, built.occurrence);
  assert(
    [...hlBuilt].sort().join(",") === [...hl].sort().join(","),
    `built (joiner-carrying) quote highlights the same set as the seeded quote`,
  );

  // (c) Target side: zaln x-content carries the joiner, quote doesn't —
  // both the degradation path and the OL-anchored path must still join.
  const ms27 = (content, words27) => ({
    type: "milestone", tag: "zaln", content, occurrence: "1", occurrences: "1",
    children: words27.map((text) => ({
      type: "word", tag: "w", text, occurrence: "1", occurrences: "1",
    })),
  });
  const targetVo = [ms27(stoneTok, ["the", "stone"]), ms27(tinTok, ["of", "tin"])];
  const sourceVo27 = [
    { type: "word", tag: "w", text: stoneTok, occurrence: "1", occurrences: "1" },
    { type: "word", tag: "w", text: tinTok, occurrence: "1", occurrences: "1" },
  ];
  for (const [label, hlT] of [
    ["degradation", findTargetHighlights(targetVo, seededQuote, 1)],
    ["OL-anchored", findTargetHighlights(targetVo, seededQuote, 1, sourceVo27)],
  ]) {
    for (const key of ["the|1", "stone|1", "of|1", "tin|1"]) {
      assert(hlT.has(key), `${label}: joiner-less quote lights ${key}. Got: ${[...hlT].join(",")}`);
    }
  }
}

// ─── Case 28: occurrence -1 — "every occurrence" per the TSV spec ─────────
//
// `occurrence: -1` was clamped to 1 (Math.max(1, occurrence|0)), silently
// highlighting only the first instance. It must light EVERY match: the
// union of all matches on the source path, and every matching run on the
// target degradation path. Seeded data has no -1 rows, so synthetic.
{
  console.log("\n[Case 28] occurrence -1 highlights every occurrence");
  const w28 = (text, occurrence, occurrences) => ({
    type: "word", tag: "w", text, occurrence: String(occurrence), occurrences: String(occurrences),
  });

  // (a) Source path: single word, two instances.
  const sourceVo = [w28("אָב", 1, 2), w28("בֵּן", 1, 1), w28("אָב", 2, 2)];
  const all = findSourceHighlights(sourceVo, "אָב", -1);
  assert(all.has("אָב|1") && all.has("אָב|2"), `-1 lights both instances. Got: ${[...all].join(",")}`);
  assert(!all.has("בֵּן|1"), `-1 must NOT light the unquoted word. Got: ${[...all].join(",")}`);
  // Positive occurrences still pick a single instance (no regression).
  const one = findSourceHighlights(sourceVo, "אָב", 1);
  assert(one.has("אָב|1") && !one.has("אָב|2"), `occ=1 still picks only the first. Got: ${[...one].join(",")}`);

  // (b) Source path: two-word phrase, two instances → union of both runs.
  const phraseVo = [w28("אָב", 1, 2), w28("בֵּן", 1, 2), w28("גַּם", 1, 1), w28("אָב", 2, 2), w28("בֵּן", 2, 2)];
  const phraseAll = findSourceHighlights(phraseVo, "אָב בֵּן", -1);
  assert(
    phraseAll.size === 4 && phraseAll.has("אָב|2") && phraseAll.has("בֵּן|2"),
    `-1 phrase lights both runs (got ${[...phraseAll].join(",")})`,
  );
  assert(!phraseAll.has("גַּם|1"), `-1 phrase must NOT light the gap word`);

  // (c) Target paths: zaln runs at occ 1 and 2 for the quoted word.
  const ms28 = (content, occurrence, en) => ({
    type: "milestone", tag: "zaln", content, occurrence: String(occurrence), occurrences: "2",
    children: [{ type: "word", tag: "w", text: en, occurrence: "1", occurrences: "1" }],
  });
  const targetVo = [ms28("אָב", 1, "father1"), ms28("בֵּן", 1, "son"), ms28("אָב", 2, "father2")];
  for (const [label, hlT] of [
    ["degradation", findTargetHighlights(targetVo, "אָב", -1)],
    ["OL-anchored", findTargetHighlights(targetVo, "אָב", -1, sourceVo)],
  ]) {
    assert(hlT.has("father1|1") && hlT.has("father2|1"), `${label}: -1 lights both fathers. Got: ${[...hlT].join(",")}`);
    assert(!hlT.has("son|1"), `${label}: -1 must NOT light son. Got: ${[...hlT].join(",")}`);
  }
  // Positive occurrence still scoped on the target side too.
  const occ2 = findTargetHighlights(targetVo, "אָב", 2, sourceVo);
  assert(occ2.has("father2|1") && !occ2.has("father1|1"), `occ=2 still picks only the second. Got: ${[...occ2].join(",")}`);
}

// ─── Case 29: \d (Psalm superscription) — matchers descend into it ────────
//
// \d is `type:"section"` but its content IS alignable verse body. The
// renderer already descends (highlight.ts segmentByParagraphs special
// case); collectBareWords / collectMilestoneRuns / collectUhbWords now do
// too, so a quote on a superscription word matches.
{
  console.log("\n[Case 29] \\d superscription words match quotes");
  const mizmor = "מִזְמ֥וֹר";
  const ledavid = "לְ⁠דָוִ֑ד";
  const yahweh = "יְהוָ֔ה";
  const w29 = (text) => ({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });

  // UHB-style: bare \w inside the \d section node, then a \q1 verse body.
  const uhbVo = [
    { type: "section", tag: "d", children: [w29(mizmor), { type: "text", text: " " }, w29(ledavid)] },
    { type: "quote", tag: "q1" },
    w29(yahweh),
  ];
  // (a) collectBareWords descends: quote on a superscription word matches.
  const hlSrc = findSourceHighlights(uhbVo, mizmor, 1);
  assert(hlSrc.has(`${mizmor}|1`), `\\d source word highlights (got ${[...hlSrc].join(",")})`);
  const hlSrc2 = findSourceHighlights(uhbVo, `${ledavid} & ${yahweh}`, 1);
  assert(
    hlSrc2.has(`${ledavid}|1`) && hlSrc2.has(`${yahweh}|1`),
    `discontinuous quote spanning \\d boundary matches (got ${[...hlSrc2].join(",")})`,
  );

  // ULT-style: zaln milestones inside the \d section node.
  const ultVo = [
    {
      type: "section", tag: "d",
      children: [
        {
          type: "milestone", tag: "zaln", content: mizmor, occurrence: "1", occurrences: "1",
          children: [w29("A"), { type: "text", text: " " }, w29("psalm")],
        },
      ],
    },
    { type: "quote", tag: "q1" },
    {
      type: "milestone", tag: "zaln", content: yahweh, occurrence: "1", occurrences: "1",
      children: [w29("Yahweh")],
    },
  ];
  // (b) collectMilestoneRuns descends: degradation + OL-anchored paths.
  for (const [label, hlT] of [
    ["degradation", findTargetHighlights(ultVo, mizmor, 1)],
    ["OL-anchored", findTargetHighlights(ultVo, mizmor, 1, uhbVo)],
  ]) {
    assert(hlT.has("A|1") && hlT.has("psalm|1"), `${label}: quote on \\d zaln lights its targets. Got: ${[...hlT].join(",")}`);
    assert(!hlT.has("Yahweh|1"), `${label}: must NOT bleed into the verse body. Got: ${[...hlT].join(",")}`);
  }

  // (c) collectUhbWords descends: the quote builder can select \d words.
  const built = buildQuoteFromSelection(uhbVo, new Set([tokenKey(mizmor, 1)]));
  assert(built?.quote === mizmor, `builder authors a quote from a \\d word (got ${JSON.stringify(built)})`);
  assert(built?.occurrence === 1, `builder occurrence=1 (got ${built?.occurrence})`);
}

// ─── Case 30: \d wrapper round-trips byte-clean through parse/serialize ───
//
// alignment.ts's walk() previously treated a `type:"section", tag:"d"` node
// carrying children as an opaque marker, so its inner zaln / \w never
// entered the alignment stream (the dialog couldn't edit superscription
// alignments). It now descends via openMarker/closeMarker brackets like
// \qs. Gate: the rebuilt tree must be DEEPLY EQUAL to the input — this is
// the proof required before letting the serializer rebuild \d nodes.
{
  console.log("\n[Case 30] \\d wrapper deep-equal round-trip through parse/serialize");
  const { deepStrictEqual } = await import("node:assert");
  const dVerse = [
    {
      type: "section",
      tag: "d",
      children: [
        {
          tag: "zaln", type: "milestone", strong: "H4210", lemma: "מִזְמוֹר", morph: "He,Ncmsa",
          occurrence: "1", occurrences: "1", content: "מִזְמ֥וֹר",
          children: [
            { text: "A", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
            { type: "text", text: " " },
            { text: "psalm", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
          ],
          endTag: "zaln-e\\*",
        },
        { type: "text", text: " " },
        {
          tag: "zaln", type: "milestone", strong: "l:H1732",
          occurrence: "1", occurrences: "1", content: "לְ⁠דָוִ֑ד",
          children: [
            { text: "of", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
            { type: "text", text: " " },
            { text: "David", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
          ],
          endTag: "zaln-e\\*",
        },
        { type: "text", text: ".\n" },
      ],
    },
    { tag: "q1", nextChar: " ", type: "quote" },
    {
      tag: "zaln", type: "milestone", strong: "H3068",
      occurrence: "1", occurrences: "1", content: "יְהוָה",
      children: [{ text: "Yahweh", tag: "w", type: "word", occurrence: "1", occurrences: "1" }],
      endTag: "zaln-e\\*",
    },
  ];
  const state = parseAlignment(dVerse, null);

  // (a) The superscription's zaln/\w entered the alignment stream.
  const psalmGroup = state.groups.find((g) => g.source.some((s) => s.strong === "H4210"));
  assert(!!psalmGroup, "source group exists for the \\d-wrapped H4210");
  assert(
    psalmGroup?.targets.map((t) => t.text).join(" ") === "A psalm",
    `\\d targets derive in stream order (got ${JSON.stringify(psalmGroup?.targets.map((t) => t.text))})`,
  );
  assert(state.unaligned.length === 0, `every word (including \\d words) is aligned (got ${state.unaligned.length} unaligned)`);

  // (b) Deep-equal round-trip — the byte-clean gate.
  let deepEqual = true;
  let diff = "";
  try {
    deepStrictEqual(serializeAlignment(state), dVerse);
  } catch (e) {
    deepEqual = false;
    diff = String(e.message).slice(0, 400);
  }
  assert(deepEqual, `parse → serialize returns a deeply-equal tree${diff ? ` (${diff})` : ""}`);

  // (c) Plain text matches the shared extractor (importer parity).
  assert(
    alignmentPlainText(state) === extractPlainText(dVerse),
    `alignmentPlainText matches extractPlainText for the \\d verse`,
  );

  // (d) A childless / text-only \d still rides along verbatim (opaque path).
  const bareDVerse = [
    { tag: "d", text: "A psalm of David.\n" },
    { type: "quote", tag: "q1" },
    { text: "Yahweh", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
  ];
  let bareEqual = true;
  try {
    deepStrictEqual(serializeAlignment(parseAlignment(bareDVerse, null)), bareDVerse);
  } catch {
    bareEqual = false;
  }
  assert(bareEqual, "text-only \\d (no children) round-trips verbatim through the opaque path");
}

// ─── Case 31: withSourceCoverage totals keyed by NFC (textKey) ────────────
//
// collectSourceWords counts textOccurrence per NFC textKey, but the
// placeholder builder totalled occurrences by RAW sw.text — so two
// raw-different / NFC-equal tokens (UHB legacy combining-mark order vs
// NFC) produced occurrence="2" with occurrences="1", the same impossible
// "2nd of 1" shape the split-gloss healers exist to clean up.
{
  console.log("\n[Case 31] withSourceCoverage occurrences keyed by NFC");
  // kaf+dagesh+hiriq+yod in UHB legacy order; NFC reorders hiriq before
  // dagesh (CCC 14 < 21) → raw-different, NFC-equal.
  const legacy = "\u05DB\u05BC\u05B4\u05D9"; // כ + dagesh + hiriq + yod
  const canonical = legacy.normalize("NFC");
  assert(legacy !== canonical, "precondition: legacy and NFC forms differ byte-wise");
  assert(legacy.normalize("NFC") === canonical.normalize("NFC"), "precondition: forms are NFC-equal");

  const sourceVo = [
    { type: "word", tag: "w", text: legacy, strong: "H1", lemma: "", morph: "" },
    { type: "word", tag: "w", text: canonical, strong: "H1", lemma: "", morph: "" },
  ];
  // Empty target → both source words become placeholder groups.
  const state = parseAlignment([], sourceVo);
  assert(state.groups.length === 2, `two placeholder groups (got ${state.groups.length})`);
  const occs = state.groups.map((g) => [g.source[0].occurrence, g.source[0].occurrences]);
  assert(
    JSON.stringify(occs) === JSON.stringify([["1", "2"], ["2", "2"]]),
    `NFC-equal tokens count as one text: occurrence/occurrences = 1/2 and 2/2 (got ${JSON.stringify(occs)})`,
  );
  for (const g of state.groups) {
    const occ = parseInt(g.source[0].occurrence, 10);
    const total = parseInt(g.source[0].occurrences, 10);
    assert(occ <= total, `placeholder occurrence ≤ occurrences (got ${occ}/${total})`);
  }
}

// ─── Case: stripCompoundOverlaps is occurrence-aware (ZEC 6:13 עַל) ─────────
// A standalone source word must only strip an identical (content + occurrence)
// sibling out of a compound — never a genuinely-distinct repeat. Regression
// for the second עַל (occ 2) vanishing from the cards because a standalone
// עַל (occ 1) shared its content.
{
  console.log("\n[Case] stripCompoundOverlaps keeps distinct occurrences (ZEC 6:13 עַל)");
  const sw = (content, occurrence, occurrences = "2") => ({
    id: `${content}-${occurrence}`,
    strong: "H5921a",
    occurrence,
    occurrences,
    content,
  });
  const tw = (text) => ({ id: text, text, occurrence: "1", occurrences: "1" });
  // Standalone עַל(1) "on", and a compound [עַל(2), כִּסְאוֹ] "his throne".
  const groups = [
    { id: "g-standalone", source: [sw("עַל", "1")], targets: [tw("on")] },
    {
      id: "g-compound",
      source: [sw("עַל", "2"), { id: "throne", strong: "H3678", occurrence: "1", occurrences: "1", content: "כִּסְאוֹ" }],
      targets: [tw("his"), tw("throne")],
    },
  ];
  const stripped = stripCompoundOverlaps(groups);
  const compound = stripped.find((g) => g.id === "g-compound");
  assert(
    compound.source.some((s) => s.content === "עַל" && s.occurrence === "2"),
    `עַל(2) survives in the compound (got [${compound.source.map((s) => `${s.content}|${s.occurrence}`).join(", ")}])`,
  );
  assert(compound.source.length === 2, `compound keeps both source words (got ${compound.source.length})`);

  // Sanity: an identical-occurrence overlap IS still stripped.
  const dupGroups = [
    { id: "g-s", source: [sw("עַל", "1")], targets: [tw("on")] },
    {
      id: "g-c",
      source: [sw("עַל", "1"), { id: "k", strong: "H3678", occurrence: "1", occurrences: "1", content: "כִּסְאוֹ" }],
      targets: [tw("throne")],
    },
  ];
  const dupStripped = stripCompoundOverlaps(dupGroups);
  const dupCompound = dupStripped.find((g) => g.id === "g-c");
  assert(
    !dupCompound.source.some((s) => s.content === "עַל"),
    `identical occurrence (עַל occ 1) still stripped from the compound (got [${dupCompound.source.map((s) => s.content).join(", ")}])`,
  );

  // mergeAdjacentSameSource only fuses truly identical source chains.
  const merged = mergeAdjacentSameSource(stripped);
  assert(merged.length === 2, `distinct-occurrence groups are not merged (got ${merged.length})`);
}

// ─── Case: parse normalizes a reversed compound's source order (ZEC 6:13) ──
// Some AI-generated alignments nest a compound's `\zaln-s` milestones in
// reverse — ZEC 6:13 UST stamped הֵיכַל before its אֵת direct-object marker.
// parseAlignment must reorder the group's `source` into canonical UHB order
// (אֵת then הֵיכַל) so the RTL card renders right AND serialize re-nests
// correctly. Well-formed (already-canonical) data must be untouched.
{
  console.log("\n[Case] parse reorders a reversed compound to canonical source order (ZEC 6:13)");
  // Target nests temple (הֵיכַל) FIRST, then the DO marker (אֵת) — reversed.
  const target = String.raw`\id ZEC
\c 6
\v 13 \zaln-s |x-strong="H1964" x-lemma="הֵיכָל" x-occurrence="1" x-occurrences="1" x-content="הֵיכַל"\*\zaln-s |x-strong="H0853" x-lemma="אֵת" x-occurrence="1" x-occurrences="1" x-content="אֶת"\*\w temple|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\zaln-e\*
`;
  // UHB source in canonical order: אֶת precedes הֵיכַל.
  const source = String.raw`\id ZEC
\c 6
\v 13 \w אֶת|x-strong="H0853" x-occurrence="1"\w* \w הֵיכַל|x-strong="H1964" x-occurrence="1"\w*
`;
  const tvo = usfm.toJSON(target).chapters["6"]["13"].verseObjects;
  const svo = usfm.toJSON(source).chapters["6"]["13"].verseObjects;
  const state = parseAlignment(tvo, svo);

  const compound = state.groups.find((g) => g.source.length === 2);
  assert(!!compound, "compound group with both Hebrew words exists");
  const order = compound.source.map((s) => s.strong);
  assert(
    order[0] === "H0853" && order[1] === "H1964",
    `source reordered to canonical [אֵת, הֵיכַל] (got [${order.join(", ")}])`,
  );

  // Serialize re-nests in the corrected order: \zaln-s(אֵת) wraps \zaln-s(הֵיכַל).
  const rt = usfm.toUSFM(
    (() => {
      const j = usfm.toJSON(target);
      j.chapters["6"]["13"].verseObjects = serializeAlignment(state);
      return j;
    })(),
    { forcedNewLines: true },
  );
  const idxEt = rt.indexOf('x-content="אֶת"');
  const idxTemple = rt.indexOf('x-content="הֵיכַל"');
  assert(
    idxEt >= 0 && idxTemple >= 0 && idxEt < idxTemple,
    "serialized USFM nests אֵת before הֵיכַל",
  );

  // Already-canonical data is left untouched (no spurious reorder/churn).
  const ok = String.raw`\id ZEC
\c 6
\v 13 \zaln-s |x-strong="H0853" x-lemma="אֵת" x-occurrence="1" x-occurrences="1" x-content="אֶת"\*\zaln-s |x-strong="H1964" x-lemma="הֵיכָל" x-occurrence="1" x-occurrences="1" x-content="הֵיכַל"\*\w temple|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\zaln-e\*
`;
  const okState = parseAlignment(
    usfm.toJSON(ok).chapters["6"]["13"].verseObjects,
    svo,
  );
  const okOrder = okState.groups.find((g) => g.source.length === 2).source.map((s) => s.strong);
  assert(
    okOrder[0] === "H0853" && okOrder[1] === "H1964",
    `canonical input preserved (got [${okOrder.join(", ")}])`,
  );
}

// ─── Case: bare (un-\w-wrapped) text is alignable ───────────────────────
// The AI returns unaligned ULT/UST as plain text (`\p \v 1 In the
// beginning...`) with no \w wrappers. Those words must surface as draggable
// unaligned targets, not vanish into a passthrough text node (which also
// glued to a preceding marker on export — `\q1Some`).
{
  console.log("\n[Case] bare text tokenizes into alignable words");
  const raw = String.raw`\id GEN
\c 1
\p \v 1 In the beginning God created the heavens and the earth.
`;
  const { verseObjects } = parseSingleVerse(raw);
  const state = parseAlignment(verseObjects, null);
  const words = state.unaligned.map((w) => w.text);
  assert(words.length === 10, `10 bare words surface as unaligned (got ${words.length}: ${words.join(",")})`);
  assert(words.includes("beginning") && words.includes("God"), "key words present in unaligned bag");
  assert(words.filter((w) => w === "the").length === 3, `"the" surfaces 3× (got ${words.filter((w) => w === "the").length})`);
  // verse with bare words is now correctly flagged as needing alignment
  assert(verseHasUnalignedWork(verseObjects, null), "verseHasUnalignedWork true for bare-text verse");
  // serialize → words become \w nodes; no bare prose run remains
  const rt = roundtripVerseUsfm(raw, null);
  assert(/\\w In\|/.test(rt) && /\\w beginning\|/.test(rt), "bare words serialize as \\w tokens");
  assert(!/\bIn the beginning God\b/.test(rt.replace(/\\w |\|[^\\]*\\w\*/g, "")) || /\\w/.test(rt), "no untokenized prose run survives");
  // plain text is preserved through the round-trip
  const plain = alignmentPlainText(state);
  assert(
    plain === "In the beginning God created the heavens and the earth.",
    `plain text preserved (got ${JSON.stringify(plain)})`,
  );
}

// ─── Case: literal \q2 in bare text is a marker, not a target word ───────
// HOS 7:13 UST bug: a \q2 poetry marker typed (or AI-drafted) straight into the
// verse text — WITHOUT the marker button — landed as a literal "\q2" inside a
// text node instead of a structural marker. The bare-text tokenizer then
// surfaced it in the aligner as the unalignable target word "q2". It must be
// recognized as a poetry marker and round-trip to a real \q2 node — which also
// heals the data when the alignment is saved. Mirrors the corrupted content
// shape directly (usfm-js would parse a \q2 in raw USFM as a marker; the bug is
// when it is already sitting as literal text).
{
  console.log("\n[Case] literal \\q2 in bare text surfaces as a marker, not a target word");
  const verseObjects = [
    { type: "word", tag: "w", text: "obeying", occurrence: "1", occurrences: "1" },
    { type: "text", text: " me \\q2 I will destroy them." },
  ];
  const state = parseAlignment(verseObjects, null);
  const words = state.unaligned.map((w) => w.text);
  assert(!words.includes("q2"), `\\q2 does NOT surface as a draggable word (got ${JSON.stringify(words)})`);
  assert(
    state.stream.some((s) => s.kind === "marker" && s.node.tag === "q2"),
    "the \\q2 token becomes a structural marker stream node",
  );
  const reVO = serializeAlignment(state);
  assert(
    reVO.some((n) => n && n.tag === "q2" && n.type === "quote"),
    `serialize emits a real \\q2 marker node (got tags ${reVO.map((n) => n.tag ?? n.type).join(",")})`,
  );
  assert(
    !reVO.some((n) => n && n.type === "word" && /q2/.test(String(n.text))),
    "no literal q2 word node survives serialize (data healed on save)",
  );
}

// ─── Case: a normal aligned verse's punctuation text is untouched ────────
// Guard against the bare-text tokenizer disturbing inter-word separators in
// already-aligned verses (their text nodes hold only punctuation/space).
{
  console.log("\n[Case] punctuation-only text nodes round-trip unchanged");
  const raw = String.raw`\id GEN
\c 1
\p \v 1 \zaln-s |x-strong="H7225" x-content="רֵאשִׁית"\*\w beginning|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*, \zaln-s |x-strong="H1254" x-content="בָּרָא"\*\w created|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*.
`;
  const { verseObjects } = parseSingleVerse(raw);
  const state = parseAlignment(verseObjects, null);
  assert(state.unaligned.length === 0, `aligned verse has no spurious unaligned words (got ${state.unaligned.length})`);
  const plain = alignmentPlainText(state);
  assert(plain === "beginning, created.", `punctuation preserved (got ${JSON.stringify(plain)})`);
}

// ─── Case: text PARKED ON a marker node (LAM 1:7 UST `\q1 Some enemies…`) ──
// usfm-js attaches same-line post-marker text to the marker's `text` field, not
// a separate text node — so the bare-text branch never sees it. parseAlignment
// must lift+tokenize it; otherwise the words are invisible to the aligner (and
// were glued as `\q1Some` on export). This is the exact LAM 1:7 UST shape.
{
  console.log("\n[Case] text parked on a \\q marker tokenizes into alignable words");
  const raw = String.raw`\id LAM
\c 1
\q1 \v 7 \zaln-s |x-strong="H3389" x-content="יְרוּשָׁלִַם"\*\w Jerusalem|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\q1 Some enemies watched
`;
  const { verseObjects } = parseSingleVerse(raw);
  // precondition: confirm the fixture reproduces the marker-parked-text shape
  const parked = verseObjects.some(
    (n) => n && n.type === "quote" && typeof n.text === "string" && /Some/.test(n.text),
  );
  assert(parked, "precondition: usfm-js parks post-marker text on the \\q1 node");
  const state = parseAlignment(verseObjects, null);
  const words = state.unaligned.map((w) => w.text);
  assert(
    ["Some", "enemies", "watched"].every((w) => words.includes(w)),
    `marker-parked words surface as unaligned (got ${JSON.stringify(words)})`,
  );
  const rt = roundtripVerseUsfm(raw, null);
  assert(/\\w Some\|/.test(rt) && /\\w watched\|/.test(rt), "parked words serialize as \\w tokens, not glued to \\q1");
  assert(!/\\q1Some/.test(rt), "no \\q1Some glue in the round-trip");
}

// ─── Card-key uniqueness for split-aligned source tokens (JER 28:1 UST) ──
// One source token aligned to two non-contiguous target runs yields two
// distinct groups whose source words resolve to the SAME source position (the
// token appears once in the UHB). A position-only React key collided across
// them, so the cards piled up on every hover-driven re-render. cardKey must
// stay unique here while still separating same-Strong different-pointing words.
{
  console.log("\n[Case] cardKey stays unique for split-aligned source tokens (JER 28:1)");
  const mk = (id, strong, occurrence, occurrences, content) => ({
    id,
    strong,
    occurrence,
    occurrences,
    content,
  });
  // The single אָמַר (pos 12) + אֵלַי (pos 13) wrap BOTH "spoke to me" runs,
  // stamped occ 1/2 and 2/2 — exactly the real displayGroups output.
  const gSpoke1 = {
    id: "grp-spoke-1",
    source: [mk("s-amar-1", "H0559", "1", "2", "אָמַר"), mk("s-elay-1", "H0413", "1", "2", "אֵלַי")],
    targets: [],
  };
  const gSpoke2 = {
    id: "grp-spoke-2",
    source: [mk("s-amar-2", "H0559", "2", "2", "אָמַר"), mk("s-elay-2", "H0413", "2", "2", "אֵלַי")],
    targets: [],
  };
  // לְעֵינֵי (pos 22) → "while" / "watched".
  const gWhile = { id: "grp-while", source: [mk("s-le-1", "l:H5869a", "1", "2", "לְעֵינֵי")], targets: [] };
  const gWatched = { id: "grp-watched", source: [mk("s-le-2", "l:H5869a", "2", "2", "לְעֵינֵי")], targets: [] };
  // Both halves of each split resolve to the same physical source position.
  const sourcePos = new Map([
    ["s-amar-1", 12],
    ["s-amar-2", 12],
    ["s-elay-1", 13],
    ["s-elay-2", 13],
    ["s-le-1", 22],
    ["s-le-2", 22],
  ]);
  const groups = [gSpoke1, gSpoke2, gWhile, gWatched];
  const keys = groups.map((g) => cardKey(g, sourcePos));
  assert(
    new Set(keys).size === keys.length,
    `all split-aligned card keys are unique (got ${JSON.stringify(keys)})`,
  );
  assert(
    cardKey(gSpoke1, sourcePos) !== cardKey(gSpoke2, sourcePos),
    "the two 'spoke to me' groups get distinct keys",
  );
  assert(
    cardKey(gWhile, sourcePos) !== cardKey(gWatched, sourcePos),
    "while / watched groups get distinct keys",
  );

  // Regression guard for the case the position key was introduced for: same
  // Strong, different pointing, DIFFERENT positions — must stay distinct.
  const gAlefA = { id: "x", source: [mk("a1", "H0413", "1", "1", "אֶל")], targets: [] };
  const gAlefB = { id: "y", source: [mk("a2", "H0413", "1", "1", "אֵלָיו")], targets: [] };
  const posMap2 = new Map([
    ["a1", 3],
    ["a2", 7],
  ]);
  assert(
    cardKey(gAlefA, posMap2) !== cardKey(gAlefB, posMap2),
    "same-Strong different-pointing words at different positions get distinct keys",
  );

  // Empty-source group (shouldn't happen, but guard) falls back to its id.
  assert(
    cardKey({ id: "ph", source: [], targets: [] }, sourcePos) === "ph",
    "empty-source group falls back to group id",
  );
}

// ─── Same-position groups collapse to one card (JER 28:1 UST doubling) ───
// A source token the AI stamped with occurrences>actual yields two groups that
// resolve to the SAME physical Hebrew position. mergeSamePositionGroups fuses
// them (targets concatenated) so the Hebrew word renders once; genuine repeats
// at different positions are left alone.
{
  console.log("\n[Case] mergeSamePositionGroups collapses a doubled source token (JER 28:1)");
  const g = (id, posSeq, targets) => ({
    id,
    source: posSeq.map((p, i) => ({ id: `${id}-s${i}`, strong: "X", occurrence: "1", occurrences: "1", content: `w${p}` })),
    targets: targets.map((t, i) => ({ id: `${id}-t${i}`, text: t, occurrence: "1", occurrences: "1" })),
    _posSeq: posSeq, // test-only carrier so positionKey is deterministic
  });
  // חֲנַנְיָה (pos 14) appears twice as two groups; אָמַר אֵלַי (pos 12,13) twice.
  const hanan1 = g("hanan1", [14], ["Hananiah"]);
  const hanan2 = g("hanan2", [14], ["Hananiah"]);
  const spoke1 = g("spoke1", [12, 13], ["spoke", "to", "me"]);
  const spoke2 = g("spoke2", [12, 13], ["spoke", "to", "me"]);
  // A genuinely-repeated word at TWO distinct positions must NOT merge.
  const son1 = g("son1", [15], ["son"]);
  const azzur = g("azzur", [16], ["Azzur"]);
  const positionKey = (grp) => (grp._posSeq ? grp._posSeq.join(".") : null);

  const merged = mergeSamePositionGroups(
    [hanan1, hanan2, spoke1, spoke2, son1, azzur],
    positionKey,
  );
  assert(merged.length === 4, `6 groups collapse to 4 (got ${merged.length})`);
  const hanan = merged.find((x) => positionKey(x) === "14");
  assert(hanan.targets.map((t) => t.text).join(" ") === "Hananiah Hananiah", "the two Hananiah groups merge into one card with both chips");
  const spoke = merged.find((x) => positionKey(x) === "12.13");
  assert(spoke.targets.length === 6, "the two compound 'spoke to me' groups merge (6 target chips)");
  assert(
    merged.some((x) => positionKey(x) === "15") && merged.some((x) => positionKey(x) === "16"),
    "distinct positions (son, Azzur) stay separate",
  );

  // Unresolved position (null key) never merges, even against another null.
  const u1 = { id: "u1", source: [], targets: [{ id: "u1t", text: "x", occurrence: "1", occurrences: "1" }] };
  const u2 = { id: "u2", source: [], targets: [{ id: "u2t", text: "y", occurrence: "1", occurrences: "1" }] };
  const unmerged = mergeSamePositionGroups([u1, u2], () => null);
  assert(unmerged.length === 2, "groups with unresolved positions are never merged");
}

// ─── Clearing a collapsed over-count card unaligns EVERY underlying group ──────
// AlignmentPanel collapses same-position duplicates (occ 1/2 + 2/2 → one card)
// for display, but the card's clear button must unalign the GROUPS those cards
// hid — not just the survivor whose id the card carries. sourceKey separates the
// two over-count halves (different occurrence), so a sourceKey-only clear left
// the second group aligned (and still serializable). The fix matches on
// sourceKey OR position, exactly the keys the display collapse uses. Mirrors
// AlignmentPanel.groupPositionKey + handleClearGroup with lib sourceKey.
{
  console.log("\n[Case] clearing a collapsed over-count card unaligns BOTH groups");
  const positionKey = (grp) =>
    grp._posSeq && !grp._posSeq.some((p) => p < 0) ? grp._posSeq.join(".") : null;
  // One physical Hebrew token at pos 14, AI-stamped occurrences=2 → two groups
  // (occ 1/2 and 2/2). Same position, DIFFERENT sourceKey.
  const og1 = {
    id: "og1", _posSeq: [14],
    source: [{ id: "og1-s", strong: "X", occurrence: "1", occurrences: "2", content: "w14" }],
    targets: [{ id: "og1-t", text: "A", occurrence: "1", occurrences: "1" }],
  };
  const og2 = {
    id: "og2", _posSeq: [14],
    source: [{ id: "og2-s", strong: "X", occurrence: "2", occurrences: "2", content: "w14" }],
    targets: [{ id: "og2-t", text: "B", occurrence: "1", occurrences: "1" }],
  };
  const card = mergeSamePositionGroups([og1, og2], positionKey);
  assert(card.length === 1, `occ 1/2 + 2/2 collapse to ONE card (got ${card.length})`);
  assert(sourceKey(og1) !== sourceKey(og2), "the two over-count halves carry different sourceKeys");

  const groups = [og1, og2];
  const target = groups.find((x) => x.id === card[0].id);
  const key = sourceKey(target);
  const posKey = positionKey(target);
  const cleared = groups
    .filter((x) => sourceKey(x) === key || (posKey !== null && positionKey(x) === posKey))
    .map((x) => x.id);
  assert(
    cleared.includes("og1") && cleared.includes("og2"),
    `clearing the collapsed card unaligns BOTH groups (got ${JSON.stringify(cleared)})`,
  );
  // Regression: sourceKey alone (the old handler) cleared only the survivor.
  const oldCleared = groups.filter((x) => sourceKey(x) === key).map((x) => x.id);
  assert(
    oldCleared.length === 1,
    `sourceKey-only clear left the hidden group aligned — the bug this guards (got ${JSON.stringify(oldCleared)})`,
  );
}

// ─── Case 32: ZEC 6:5 — split source token (occurrence==occurrences) highlight ─
// Sibling of Case 22, the OTHER split-gloss shape. Prod ULT renders the single
// Hebrew token וַ⁠יַּעַן ("and he answered") as TWO `\zaln-s` runs with the same
// x-content — "And" … (interrupted by "the angel") … "answered" — but this time
// BOTH spans keep occurrence="1"/occurrences="1" (not the impossible "2 of 1" of
// ZEC 6:2). So the occurrence>occurrences heal never fired: the matcher saw the
// run sequence [וַיַּעַן, הַמַּלְאָךְ, וַיַּעַן, וַיֹּאמֶר, …] — an extra וַיַּעַן at
// position 2 — and the 4-word writing-quotations quote (dalj) matched NOTHING,
// so ULT highlighted no words at all. collectMilestoneRuns now folds runs that
// share content AND effective occurrence, so the two וַיַּעַן spans become one.
{
  console.log("\n[Case 32] ZEC 6:5 split-source-token highlight (occurrence==occurrences)");
  // Define each Hebrew content ONCE so milestone content and the quote share
  // byte-identical strings (no hand-typed cantillation drift).
  const wayyaan = "וַ⁠יַּ֥עַן"; //     "and he answered"
  const hamalak = "הַ⁠מַּלְאָ֖ךְ"; //   "the angel"
  const wayyomer = "וַ⁠יֹּ֣אמֶר"; //    "and he said"
  const elay = "אֵלָ֑⁠י"; //           "to me"
  const elleh = "אֵ֗לֶּה"; //          "these"
  const arba = "אַרְבַּע֙"; //          "four"

  const ms = (content, occurrence, occurrences, words) => ({
    type: "milestone", tag: "zaln", content,
    occurrence: String(occurrence), occurrences: String(occurrences),
    children: words.map(([text, o, os]) => ({
      type: "word", tag: "w", text, occurrence: String(o), occurrences: String(os),
    })),
  });

  // Verbatim shape of prod ULT ZEC 6:5: the split continuation is marked ← below.
  const verseObjects = [
    ms(wayyaan, 1, 1, [["And", 1, 1]]),
    ms(hamalak, 1, 1, [["the", 1, 5], ["angel", 1, 1]]),
    ms(wayyaan, 1, 1, [["answered", 1, 1]]), //   ← split continuation (same occ)
    ms(wayyomer, 1, 1, [["and", 1, 1], ["said", 1, 1]]),
    ms(elay, 1, 1, [["to", 1, 1], ["me", 1, 1]]),
    ms(elleh, 1, 1, [["These", 1, 1], ["are", 1, 1]]),
    ms(arba, 1, 1, [["the", 2, 5], ["four", 1, 1]]),
  ];

  const quote = `${wayyaan} ${hamalak} ${wayyomer} ${elay}`; // dalj writing-quotations
  const hl = findTargetHighlights(verseObjects, quote, 1);

  // The regression: the whole clause "And the angel answered and said to me"
  // now highlights — "answered" (parked in the split-continuation run) included.
  for (const key of ["And|1", "the|1", "angel|1", "answered|1", "and|1", "said|1", "to|1", "me|1"]) {
    assert(hl.has(key), `ZEC 6:5: highlights ${key}. Got: ${[...hl].join(",")}`);
  }
  // No bleed into the following clause ("These are the four …").
  assert(!hl.has("These|1"), `ZEC 6:5: must NOT highlight "These". Got: ${[...hl].join(",")}`);
  assert(!hl.has("the|2"), `ZEC 6:5: must NOT highlight "the"(2) of "the four". Got: ${[...hl].join(",")}`);
  assert(!hl.has("four|1"), `ZEC 6:5: must NOT highlight "four". Got: ${[...hl].join(",")}`);
}

// ─── Case: moveSource / mergeGroups keep canonical source order (ZEC 7:2) ──
// Dragging the EARLIER Hebrew chip (אֵת, pos 9) onto the LATER card (פְּנֵי,
// pos 10) used to append it to the end → reversed "פְּנֵי אֵת". With a position
// resolver the destination chain is re-sorted into verse order regardless of
// drag direction. (mergeGroups was only saved by the dialog picking the earlier
// card as survivor — the resolver makes both paths order-independent.)
{
  console.log("\n[Case] moveSource/mergeGroups canonicalize combined source order (ZEC 7:2 אֵת + פְּנֵי)");
  // Two separate single-word aligned groups; UHB source has אֶת before פְּנֵי.
  const target = String.raw`\id ZEC
\c 7
\v 2 \zaln-s |x-strong="H0853" x-lemma="אֵת" x-occurrence="1" x-occurrences="1" x-content="אֶת"\*\w obj|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="H6440" x-lemma="פָּנֶה" x-occurrence="1" x-occurrences="1" x-content="פְּנֵי"\*\w before|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const source = String.raw`\id ZEC
\c 7
\v 2 \w אֶת|x-strong="H0853" x-occurrence="1"\w* \w פְּנֵי|x-strong="H6440" x-occurrence="1"\w*
`;
  const tvo = usfm.toJSON(target).chapters["7"]["2"].verseObjects;
  const svo = usfm.toJSON(source).chapters["7"]["2"].verseObjects;
  const state = parseAlignment(tvo, svo);

  // Position resolver mirroring the dialog: content (NFC) → verse position.
  const posByContent = new Map();
  svo.forEach((n, i) => {
    if (n && n.type === "word" && n.tag === "w") posByContent.set(n.text.normalize("NFC"), i);
  });
  const sourcePos = (s) => posByContent.get((s.content ?? "").normalize("NFC")) ?? -1;

  const etGroup = state.groups.find((g) => g.source.some((s) => s.strong === "H0853"));
  const peneGroup = state.groups.find((g) => g.source.some((s) => s.strong === "H6440"));
  const etSourceId = etGroup.source.find((s) => s.strong === "H0853").id;

  // Without a resolver, dragging אֵת onto פְּנֵי reverses the chain (old bug).
  const bad = moveSource(state, etSourceId, peneGroup.id);
  const badOrder = bad.sourceGroups.find((g) => g.id === peneGroup.id).source.map((s) => s.strong);
  assert(
    badOrder[0] === "H6440" && badOrder[1] === "H0853",
    `precondition: resolver-less moveSource reverses (got [${badOrder.join(", ")}])`,
  );

  // With the resolver, the destination chain is canonical [אֵת, פְּנֵי].
  const fixed = moveSource(state, etSourceId, peneGroup.id, sourcePos);
  const fixedOrder = fixed.sourceGroups.find((g) => g.id === peneGroup.id).source.map((s) => s.strong);
  assert(
    fixedOrder[0] === "H0853" && fixedOrder[1] === "H6440",
    `moveSource canonicalizes to [אֵת, פְּנֵי] regardless of drag direction (got [${fixedOrder.join(", ")}])`,
  );

  // mergeGroups with the wrong survivor (later card) still lands canonical.
  const m = mergeGroups(state, peneGroup.id, etGroup.id, sourcePos);
  const mOrder = m.sourceGroups.find((g) => g.id === peneGroup.id).source.map((s) => s.strong);
  assert(
    mOrder[0] === "H0853" && mOrder[1] === "H6440",
    `mergeGroups canonicalizes even with later-card survivor (got [${mOrder.join(", ")}])`,
  );
}

// ─── Case 33: Hebrew object marker (H0853) suggestion rule ──────────────
// The accusative particle אֵת carries no English of its own, so on its own it
// must never draw a ghost. With a conjunction vav (וְאֵת) it may take "and" and
// only "and"; with a pronominal suffix (אֹתוֹ "him") it has real content and
// keeps normal suggestions; grouped with its object noun it inherits the noun's.
{
  console.log("\n[Case 33] object marker (H0853) alignment suggestion rule");
  const { computeGhosts } = await import("./alignmentSuggest.ts");
  const om = (over) => ({
    id: "s",
    strong: "H0853",
    lemma: "אֵת",
    morph: "He,To",
    occurrence: "1",
    occurrences: "1",
    content: "אֶת",
    ...over,
  });

  // (a) Bare ungrouped object marker → no ghost, even when the endpoint returns
  // a tempting target.
  {
    const group = { id: "g", source: [om()], targets: [] };
    const suggestions = { "H0853~To": { words: [{ surface: "the", confidence: 0.9, source: "memory" }], phrases: [] } };
    const stream = [{ id: "w1", text: "the", aligned: false }];
    const g = computeGhosts([group], stream, suggestions);
    assert(!g.has("g"), `bare object marker draws no suggestion (got ${JSON.stringify(g.get("g"))})`);
  }

  // (b) Vav-prefixed object marker → suggests "and", and only "and" (the
  // endpoint's other surfaces are ignored).
  {
    const group = { id: "g", source: [om({ strong: "c:H0853", morph: "He,C:To", content: "וְאֶת" })], targets: [] };
    const suggestions = { "c:H0853~To": { words: [{ surface: "the", confidence: 0.95, source: "memory" }], phrases: [] } };
    const stream = [
      { id: "w1", text: "the", aligned: false },
      { id: "w2", text: "and", aligned: false },
    ];
    const g = computeGhosts([group], stream, suggestions);
    assert(g.get("g")?.text === "and", `vav object marker suggests only "and" (got ${JSON.stringify(g.get("g"))})`);
  }

  // (c) Vav-prefixed but no "and" present → no ghost (never a wrong word).
  {
    const group = { id: "g", source: [om({ strong: "c:H0853", morph: "He,C:To", content: "וְאֶת" })], targets: [] };
    const suggestions = { "c:H0853~To": { words: [{ surface: "the", confidence: 0.95, source: "memory" }], phrases: [] } };
    const stream = [{ id: "w1", text: "the", aligned: false }];
    const g = computeGhosts([group], stream, suggestions);
    assert(!g.has("g"), `vav object marker with no "and" stays blank (got ${JSON.stringify(g.get("g"))})`);
  }

  // (d) Object marker WITH a pronominal suffix (אֹתוֹ "him") → real content, so
  // it keeps normal suggestions.
  {
    const group = { id: "g", source: [om({ morph: "He,To:Sp3ms", content: "אֹתוֹ" })], targets: [] };
    const suggestions = { "H0853~Sp3ms": { words: [{ surface: "him", confidence: 0.9, source: "memory" }], phrases: [] } };
    const stream = [{ id: "w1", text: "him", aligned: false }];
    const g = computeGhosts([group], stream, suggestions);
    assert(g.get("g")?.text === "him", `suffixed object marker keeps normal suggestion (got ${JSON.stringify(g.get("g"))})`);
  }

  // (e) Object marker GROUPED with its object noun → rule doesn't fire; the
  // compound group takes the noun's suggestion.
  {
    const group = {
      id: "g",
      source: [
        om(),
        { id: "s2", strong: "H3389", lemma: "יְרוּשָׁלִַם", morph: "He,Np", occurrence: "1", occurrences: "1", content: "יְרוּשָׁלִַ֖ם" },
      ],
      targets: [],
    };
    const suggestions = {
      "H0853~To": { words: [], phrases: [] },
      "H3389~Np": { words: [{ surface: "Jerusalem", confidence: 0.95, source: "memory" }], phrases: [] },
    };
    const stream = [{ id: "w1", text: "Jerusalem", aligned: false }];
    const g = computeGhosts([group], stream, suggestions);
    assert(g.get("g")?.text === "Jerusalem", `grouped object marker inherits the noun's suggestion (got ${JSON.stringify(g.get("g"))})`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll alignment tests passed.");

// A `\sp` speaker label written as words (#1350).
//
// Door43 en_ust Song of Songs writes most speaker labels as `\w` words:
//   \sp \w The|x-occurrence="1" x-occurrences="1"\w*
//   \w woman|…\w* …
// usfm-js parses that as an EMPTY `sp` node followed by ordinary `\w` body
// words, so the label read as verse text everywhere. nestWordLabels moves the
// words into the `sp` node (`children`, `endTag: ""`), which usfm-js renders
// back byte for byte. This file pins what the editor does with that shape:
// the header band shows the label, and the aligner never offers its words as
// targets. The fixture is a trimmed copy of the real Door43 file (SNG 1:1 and
// 1:4, read 2026-11-13).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/spWordLabel.test.mjs

import usfm from "usfm-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nestWordLabels, splitSectionHeaders, extractPlainText, extractEditableText, rewriteHeaderLabel, isWordLabelNode, headerLabelText, labelNoteTexts } from "./usfm.ts";
import { parseAlignment, serializeAlignment, countUnalignedTargetWords } from "./alignment.ts";
import { curlifyVerseContent } from "./curlyVerse.ts";
import { editHeaderBand, renumberTargetOccurrences } from "./replace.ts";
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = readFileSync(resolve(repoRoot, "api/src/fixtures/sng-sp-labels.usfm.txt"), "utf8");
const parsed = usfm.toJSON(fixture);
const verse = (v) => parsed.chapters["1"][v].verseObjects;

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else passed++;
}
const json = (x) => JSON.stringify(x);
const render = (vos) => usfm.toUSFM({ headers: [], chapters: { 1: { 1: { verseObjects: vos } } } }, { forcedNewLines: true });
const labelsOf = (vos) => vos.filter((n) => n && n.tag === "sp");

const v1 = nestWordLabels(verse("1"));
const v4 = nestWordLabels(verse("4"));

// The nest itself.
{
  assert(labelsOf(v1).length === 1 && Array.isArray(labelsOf(v1)[0].children), "1:1: the label's words are inside the sp node");
  assert(labelsOf(v4).length === 4 && labelsOf(v4).every((n) => Array.isArray(n.children)), "1:4: all four labels nested");
  assert(render(v1) === render(verse("1")), "1:1: renders byte-identical to the parsed source");
  assert(render(v4) === render(verse("4")), "1:4: renders byte-identical (one label holds \\zaln milestones)");
  assert(json(nestWordLabels(v4)) === json(v4), "idempotent: a second nest changes nothing");
  const v5 = verse("5");
  assert(nestWordLabels(v5) === v5, "a verse with no sp node is returned as is");
  const textLabel = [{ tag: "sp", text: "The man\n" }, { tag: "q1", type: "quote" }, { type: "text", text: "Hi" }];
  assert(json(nestWordLabels(textLabel)) === json(textLabel), "a plain-text label is left alone");
  const noWord = [{ tag: "sp", nextChar: " " }, { type: "text", text: "\n" }, { tag: "q1", type: "quote" }];
  assert(json(nestWordLabels(noWord)) === json(noWord), "an empty sp with no word after it is left alone");
}

// Shapes that must NOT nest (review of #1350). Parsed by usfm-js:
//   1:1  \sp \w The\w* \zaln-s …\*\w man\w*⏎\q1 \w Hi\w*\zaln-e\* \w there\w*
//        → sp, w:The, " ", zaln[w:man "\n" q1 w:Hi], " ", w:there
//        The milestone opens on a label word and closes in the body: nesting
//        would swallow the \q1 and every body word to the verse end.
//   1:2  \sp \zaln-s …\*\zaln-e\*⏎\q1 \w Go\w*  → sp, zaln[], "\n", q1, w:Go
//        No \w word in the run at all.
{
  const odd = usfm.toJSON(String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \zaln-s |x-strong="H1" x-lemma="a" x-morph="He" x-occurrence="1" x-occurrences="1" x-content="א"\*\w man|x-occurrence="1" x-occurrences="1"\w*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \w there|x-occurrence="1" x-occurrences="1"\w*
\v 2 \w Next|x-occurrence="1" x-occurrences="1"\w*.
\sp \zaln-s |x-strong="H2" x-lemma="b" x-morph="He" x-occurrence="1" x-occurrences="1" x-content="ב"\*\zaln-e\*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`).chapters["1"];
  const spanning = odd["1"].verseObjects;
  const zalnAt = spanning.findIndex((n) => n.tag === "zaln");
  assert(spanning[zalnAt].children.some((n) => n.tag === "q1"), "setup: usfm-js puts the \\q1 inside the spanning milestone");
  assert(nestWordLabels(spanning) === spanning, "a label whose run meets a milestone spanning into the body is not nested");
  assert(extractPlainText(nestWordLabels(spanning)).includes("Hi there"), "…so the body words stay verse text");
  const noWords = odd["2"].verseObjects;
  assert(noWords.some((n) => n.tag === "zaln" && n.children === undefined || (n.tag === "zaln" && n.children.length === 0)), "setup: an empty milestone after the sp");
  assert(nestWordLabels(noWords) === noWords, "a run with milestones but no \\w word is not nested");
}

// An opener with an empty `text` (review of #1350): nested, the empty text
// dropped, and every reader treats it as a word label.
{
  const opener = [{ tag: "sp", text: "" }, { text: "The", tag: "w", type: "word", occurrence: "1", occurrences: "1" }, { type: "text", text: " " }, { text: "man", tag: "w", type: "word", occurrence: "1", occurrences: "1" }, { type: "text", text: "\n" }, { tag: "q1", type: "quote" }];
  const nested = nestWordLabels(opener);
  assert(nested[0].text === undefined && Array.isArray(nested[0].children), `empty text dropped when nesting (got ${json(nested[0])})`);
  assert(render(nested) === render(opener), "…and it renders the same");
  const handMade = { tag: "sp", text: "", children: nested[0].children, endTag: "" };
  assert(isWordLabelNode(handMade) && headerLabelText(handMade) === "The man", `a nested label with text "" still reads as a word label (got ${json(headerLabelText(handMade))})`);
}

// Plain and editable text skip the label.
{
  assert(extractPlainText(v1) === "This is King Solomon’s most beautiful song.", `1:1 plain text (got ${json(extractPlainText(v1))})`);
  assert(!/speaking|herself/.test(extractPlainText(v4)), `1:4 plain text has no label words (got ${json(extractPlainText(v4))})`);
  assert(!/woman|loves/.test(extractEditableText(v1)), `1:1 editable text has no label words (got ${json(extractEditableText(v1))})`);
}

// The header band shows the label.
{
  const s1 = splitSectionHeaders(v1).sections;
  assert(json(s1) === json([{ tag: "sp", text: "The woman thinks about the man she loves" }]), `1:1 band (got ${json(s1)})`);
  const s4 = splitSectionHeaders(v4).sections.map((s) => s.text);
  assert(
    json(s4) === json([
      "The woman speaking to herself",
      "The women of Jerusalem speaking about the man",
      "The woman speaking to the man about the young women of Jerusalem",
      "The woman speaking to the women of Jerusalem",
    ]),
    `1:4 bands (got ${json(s4)})`,
  );
}

// The aligner never offers label words as targets, and saving the alignment
// keeps each label exactly as it was.
{
  const targets = (st) => [...st.groups.flatMap((g) => g.targets), ...st.unaligned].map((x) => x.text);
  const st1 = parseAlignment(v1, null);
  assert(json(targets(st1)) === json(["This", "is", "King", "Solomon", "s", "most", "beautiful", "song"]), `1:1 targets (got ${json(targets(st1))})`);
  assert(countUnalignedTargetWords(v1) === 0, `1:1: no unaligned words (got ${countUnalignedTargetWords(v1)})`);
  const st4 = parseAlignment(v4, null);
  assert(!targets(st4).includes("speaking") && !targets(st4).includes("herself"), `1:4: no label word is a target (got ${json(targets(st4))})`);
  // Door43 leaves three body words of 1:4 unaligned ("the young women" before
  // "adore you"); the label words used to add 32 more.
  assert(countUnalignedTargetWords(v4) === 3, `1:4: only the 3 unaligned body words count (got ${countUnalignedTargetWords(v4)}, ${countUnalignedTargetWords(verse("4"))} before the nest)`);
  for (const [name, vos, st] of [["1:1", v1, st1], ["1:4", v4, st4]]) {
    const out = serializeAlignment(st);
    assert(json(labelsOf(out)) === json(labelsOf(vos)), `${name}: alignment round trip keeps the labels`);
    assert(render(out) === render(vos), `${name}: alignment round trip renders identically`);
  }
}

// Editing the label in the header band (#1354 item 1): the label stays words,
// written once. Each unchanged word keeps its `\w` attributes and any `\zaln`
// around it; only a changed word loses its alignment (the body edit's rule).
// The occurrence numbers are counted over the whole verse afterwards.
{
  const label = labelsOf(v1)[0];
  const band = (vos, index, tag, text) => editHeaderBand(vos, { index, tag, text });
  const e1 = band(v1, 0, "sp", "The woman dreams about the man she loves");
  const r = render(labelsOf(e1));
  assert(isWordLabelNode(labelsOf(e1)[0]) && r.includes("\\w dreams|") && !r.includes("thinks") && !/\\sp The woman/.test(r),
    `band edit keeps the label as \\w words, new text once (got ${json(r)})`);
  assert(headerLabelText(labelsOf(e1)[0]) === "The woman dreams about the man she loves", `band edit: the band shows the new text (got ${json(headerLabelText(labelsOf(e1)[0]))})`);
  assert(json(e1.filter((n) => n.tag !== "sp")) === json(v1.filter((n) => n.tag !== "sp")), "band edit: the verse body is untouched");
  assert(rewriteHeaderLabel(label, "sp", "The woman thinks about the man she loves") === label, "an unchanged band save keeps the words as they were");
  assert(band(v1, 0, "sp", "The woman thinks about the man she loves") === v1, "an unchanged band save hands back the same verse");

  // SNG 1:4 label 3 holds two `\zaln H0157` milestones ("the", "young women").
  const zalnIn = (node) => {
    const out = [];
    const walk = (ns, chain) => {
      for (const n of ns ?? []) {
        const next = n?.type === "milestone" && n.tag === "zaln" ? [...chain, n.strong] : chain;
        if (n?.type === "word") out.push(`${n.text}:${next.join(">")}`);
        if (Array.isArray(n?.children)) walk(n.children, next);
      }
    };
    walk(node.children, []);
    return out.join("|");
  };
  const l3 = labelsOf(v4)[2];
  assert(zalnIn(l3) === "The:|woman:|speaking:|to:|the:H0157|man:|about:|the:|young:H0157|women:H0157|of:|Jerusalem:", `setup: label 3's alignment (got ${zalnIn(l3)})`);
  const t3 = headerLabelText(l3);
  const talk = band(v4, 2, "sp", t3.replace("speaking", "talking"));
  assert(zalnIn(labelsOf(talk)[2]) === "The:|woman:|talking:|to:|the:H0157|man:|about:|the:|young:H0157|women:H0157|of:|Jerusalem:",
    `a changed word beside aligned ones: every other word keeps its alignment (got ${zalnIn(labelsOf(talk)[2])})`);
  const girls = band(v4, 2, "sp", t3.replace("the young women", "the girls"));
  assert(zalnIn(labelsOf(girls)[2]) === "The:|woman:|speaking:|to:|the:H0157|man:|about:|the:|girls:|of:|Jerusalem:",
    `the aligned words changed: only they lose alignment (got ${zalnIn(labelsOf(girls)[2])})`);
  const noOcc = (k, v) => (k === "occurrence" || k === "occurrences" ? undefined : v);
  for (const [name, out] of [["talking", talk], ["girls", girls]]) {
    assert(JSON.stringify(labelsOf(out).filter((_, i) => i !== 2), noOcc) === JSON.stringify(labelsOf(v4).filter((_, i) => i !== 2), noOcc), `${name}: the other labels keep their words`);
    assert(renumberTargetOccurrences(out) === out, `${name}: occurrences counted over the whole verse, labels included`);
    assert(JSON.stringify(out.filter((n) => n.tag !== "sp"), (k, v) => (k === "occurrence" || k === "occurrences" ? undefined : v)) ===
      JSON.stringify(v4.filter((n) => n.tag !== "sp"), (k, v) => (k === "occurrence" || k === "occurrences" ? undefined : v)),
      `${name}: the body is untouched but for occurrence numbers`);
    const delta = analyzeAlignmentDelta({ verseObjects: v4 }, { verseObjects: out });
    assert(delta.unexpectedLosses.length === 0, `${name}: the save's alignment guard sees no collateral loss (got ${json(delta.unexpectedLosses)})`);
    // Export then import again: the same label, words and alignment.
    const again = nestWordLabels(usfm.toJSON(render(out)).chapters["1"]["1"].verseObjects);
    assert(render(labelsOf(again)) === render(labelsOf(out)) && zalnIn(labelsOf(again)[2]) === zalnIn(labelsOf(out)[2]), `${name}: the edited label survives export and re-import`);
  }
  // The label's last word changed: it still ends the label, the \q2 still
  // follows it, and export then import gives the same label back.
  {
    const last = band(v4, 2, "sp", t3.replace("Jerusalem", "Zion"));
    const l = labelsOf(last)[2];
    assert(headerLabelText(l) === t3.replace("Jerusalem", "Zion") && last[last.indexOf(l) + 1]?.tag === "q2", `last word changed: label text and its \\q2 kept (got ${json(headerLabelText(l))})`);
    const again = nestWordLabels(usfm.toJSON(render(last)).chapters["1"]["1"].verseObjects);
    const la = labelsOf(again)[2];
    assert(headerLabelText(la) === headerLabelText(l) && again[again.indexOf(la) + 1]?.tag === "q2" && zalnIn(la) === zalnIn(l),
      `last word changed: survives export and re-import, \\q2 right after (got ${json(headerLabelText(la))})`);
  }
  // The guard sees label words: dropping an aligned label word's milestone with
  // the text unchanged is a loss it reports.
  const stripped = v4.map((n, i) => (n === l3 ? { ...n, children: n.children.map((c) => (c.tag === "zaln" ? c.children[0] : c)) } : n));
  assert(analyzeAlignmentDelta({ verseObjects: v4 }, { verseObjects: stripped }).beforeAligned > analyzeAlignmentDelta({ verseObjects: v4 }, { verseObjects: stripped }).afterAligned,
    "the alignment guard counts aligned words inside a label");

  // Retagging a word label to a section heading writes plain heading text (the
  // dropdown's s1/s2/s3 take no words); deleting it removes the node.
  const s1 = band(v1, 0, "s1", "A heading");
  assert(s1.some((n) => n.tag === "s1" && n.type === "section" && n.content === "A heading\n" && n.children === undefined), `retag to s1: plain heading (got ${json(s1.find((n) => n.tag === "s1"))})`);
  const del = band(v4, 1, null, "");
  assert(labelsOf(del).length === 3 && JSON.stringify(labelsOf(del), noOcc) === JSON.stringify(labelsOf(v4).filter((_, i) => i !== 1), noOcc) && renumberTargetOccurrences(del) === del,
    "delete removes that one label; occurrences counted again without its words");

  // A plain-text label keeps today's band edit.
  const plain = [{ tag: "sp", text: "The man\n" }, { tag: "q1", type: "quote" }, { text: "Hi", tag: "w", type: "word", occurrence: "1", occurrences: "1" }];
  const pe = band(plain, 0, "sp", "The king");
  assert(json(pe[0]) === json({ tag: "sp", content: "The king\n" }), `plain-text label: written as plain text (got ${json(pe[0])})`);
}

// A footnote, cross reference or character marker inside a `\sp` line is part
// of the label (#1354 item 2): in USFM the whole line is the label. The run
// crosses them, the label renders back byte for byte, and the body keeps only
// body words.
{
  const fx = usfm.toJSON(String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \w woman|x-occurrence="1" x-occurrences="1"\w*\f + \ft A note.\f* \add \w speaking|x-occurrence="1" x-occurrences="1"\w*\add* \nd \w Lord|x-occurrence="1" x-occurrences="1"\w*\nd* \k \w key|x-occurrence="1" x-occurrences="1"\w*\k* \zaln-s |x-strong="H1" x-lemma="a" x-morph="He" x-occurrence="1" x-occurrences="1" x-content="א"\*\w man|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w* there.
\v 2 \w Next|x-occurrence="1" x-occurrences="1"\w*.
\sp \add The\add* \w woman|x-occurrence="1" x-occurrences="1"\w* \x - \xo 1:1 \xt Gen 1:1\x*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`).chapters["1"];
  const f1 = fx["1"].verseObjects;
  const n1 = nestWordLabels(f1);
  const lab1 = labelsOf(n1)[0];
  assert(labelsOf(n1).length === 1 && isWordLabelNode(lab1), "footnote/char markers: the label is nested");
  assert(lab1.children.some((c) => c.type === "footnote") && lab1.children.some((c) => c.tag === "add") && lab1.children.some((c) => c.tag === "zaln"),
    `the run crosses the footnote, \\add, \\nd, \\k and the milestone (got ${json(lab1.children.map((c) => c.tag ?? c.type))})`);
  assert(n1[n1.indexOf(lab1) + 1]?.tag === "q1", "…up to the \\q1");
  assert(render(n1) === render(f1), "footnote/char markers: renders byte-identical");
  assert(extractPlainText(n1) === "Body. Hi there.", `footnote/char markers: plain text has no label word (got ${json(extractPlainText(n1))})`);
  assert(headerLabelText(lab1) === "The woman speaking Lord key man", `the band shows the label's words, not the footnote (got ${json(headerLabelText(lab1))})`);
  const f2 = fx["2"].verseObjects;
  const n2 = nestWordLabels(f2);
  const lab2 = labelsOf(n2)[0];
  assert(isWordLabelNode(lab2) && lab2.children.some((c) => c.tag === "x") && n2[n2.indexOf(lab2) + 1]?.tag === "q1",
    `a cross reference right before the \\q1 is inside the label (got ${json(n2.map((c) => c.tag ?? c.type))})`);
  assert(render(n2) === render(f2), "cross reference: renders byte-identical");
  assert(headerLabelText(lab2) === "The woman", `the band shows "The woman" (got ${json(headerLabelText(lab2))})`);
  assert(json(nestWordLabels(n1)) === json(n1), "idempotent with footnotes");
  // A character marker that holds a line marker ends the run, like a spanning
  // milestone: such a label is not nested at all.
  const bad = [{ tag: "sp", nextChar: " " }, { tag: "add", children: [{ text: "The", tag: "w", type: "word" }, { tag: "q1", type: "quote" }], endTag: "add*" }, { tag: "q1", type: "quote" }];
  assert(nestWordLabels(bad) === bad, "a character marker holding a line marker: not nested");
  // A band edit of such a label keeps its footnote.
  const edited = editHeaderBand(n1, { index: 0, tag: "sp", text: "The woman speaking Lord key person" });
  const el = labelsOf(edited)[0];
  assert(el.children.some((c) => c.type === "footnote" && c.content === "+ \\ft A note."), `band edit keeps the label's footnote (got ${json(el.children.map((c) => c.tag ?? c.type))})`);
  assert(render(labelsOf(edited)).includes("\\f + \\ft A note.\\f*") && headerLabelText(el) === "The woman speaking Lord key person", `band edit with a footnote renders it (got ${json(render(labelsOf(edited)))})`);
  // #1366: a one-word band edit in these labels changes only that word's bytes
  // (the footnote's whitespace is split out for the edit and rendered the same).
  const lady1 = editHeaderBand(n1, { index: 0, tag: "sp", text: "The lady speaking Lord key man" });
  assert(render(labelsOf(lady1)) === render(labelsOf(n1)).replace("\\w woman|", "\\w lady|"), `1:1 woman -> lady: only that word changes (got ${json(render(labelsOf(lady1)))})`);
  const lady2 = editHeaderBand(n2, { index: 0, tag: "sp", text: "The lady" });
  assert(render(labelsOf(lady2)) === render(labelsOf(n2)).replace("\\w woman|", "\\w lady|"), `1:2 woman -> lady beside \\add and \\x: only that word changes (got ${json(render(labelsOf(lady2)))})`);
}

// #1366 item 2: a footnote or cross reference inside a label shows in the
// header band (read-only: its text beside the label's words), and a band edit
// of the word right beside it keeps it in place, byte for byte.
{
  const fx = usfm.toJSON(String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \w woman|x-occurrence="1" x-occurrences="1"\w*\f + \ft A note.\f* \add \w speaking|x-occurrence="1" x-occurrences="1"\w*\add*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w* there.
\v 2 \w Next|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \w woman|x-occurrence="1" x-occurrences="1"\w* \x - \xo 1:1 \xt Gen 1:1\x*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`).chapters["1"];
  const n1 = nestWordLabels(fx["1"].verseObjects);
  const n2 = nestWordLabels(fx["2"].verseObjects);
  const s1 = splitSectionHeaders(n1).sections;
  assert(json(s1) === json([{ tag: "sp", text: "The woman speaking", notes: ["A note."] }]), `the band lists the label's footnote (got ${json(s1)})`);
  const s2 = splitSectionHeaders(n2).sections;
  assert(json(s2) === json([{ tag: "sp", text: "The woman", notes: ["1:1 Gen 1:1"] }]), `the band lists the label's cross reference (got ${json(s2)})`);
  assert(json(splitSectionHeaders(v1).sections[0]) === json({ tag: "sp", text: "The woman thinks about the man she loves" }), "a label with no note has no notes field");
  // Review of #1366: nested markers inside a note (`\+it`) are dropped too.
  const nestedNote = { tag: "sp", endTag: "", children: [{ text: "The", tag: "w", type: "word" }, { tag: "f", type: "footnote", content: "+ \\ft A \\+it word\\+it* here.", endTag: "f*" }] };
  assert(json(labelNoteTexts(nestedNote)) === json(["A word here."]), `a nested \\+it in a note is dropped from its text (got ${json(labelNoteTexts(nestedNote))})`);
  // The word right before the footnote, and the word right after it.
  const labelBytes = (vos) => render(labelsOf(vos));
  for (const [from, to] of [["woman", "lady"], ["speaking", "talking"]]) {
    const e = editHeaderBand(n1, { index: 0, tag: "sp", text: "The woman speaking".replace(from, to) });
    assert(labelBytes(e) === labelBytes(n1).replace(`\\w ${from}|`, `\\w ${to}|`), `band edit of "${from}" beside the footnote: only that word changes, the footnote stays (got ${json(labelBytes(e))})`);
  }
  const ex = editHeaderBand(n2, { index: 0, tag: "sp", text: "The lady" });
  assert(labelBytes(ex) === labelBytes(n2).replace("\\w woman|", "\\w lady|"), `band edit of the word before a cross reference keeps it (got ${json(labelBytes(ex))})`);
  // Found in the live test: a footnote at a line end (`\w The\w*\f …\f*⏎\w
  // woman\w*`). usfm-js parks the line break on the footnote's `nextChar`, so
  // the band read "Thewoman", and editing "woman" saved one word "Thelady".
  const eol = nestWordLabels(usfm.toJSON(String.raw`\c 1
\p
\v 1 \w Song|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w*\f + \ft A note.\f*
\w woman|x-occurrence="1" x-occurrences="1"\w*
\w thinks|x-occurrence="1" x-occurrences="1"\w*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*
`).chapters["1"]["1"].verseObjects);
  assert(json(splitSectionHeaders(eol).sections) === json([{ tag: "sp", text: "The woman thinks", notes: ["A note."] }]), `footnote at a line end: the band reads "The woman thinks" (got ${json(splitSectionHeaders(eol).sections)})`);
  const eolEdit = editHeaderBand(eol, { index: 0, tag: "sp", text: "The lady thinks" });
  assert(labelBytes(eolEdit) === labelBytes(eol).replace("\\w woman|", "\\w lady|"), `footnote at a line end: editing the word after it changes only that word (got ${json(labelBytes(eolEdit))})`);
  assert(editHeaderBand(eol, { index: 0, tag: "sp", text: "The woman thinks" }) === eol, "footnote at a line end: an unchanged band save hands back the same verse");
  // Review round 2 of #1366: a `nextChar` that is not whitespace is not band
  // text (the edit's baseline leaves it out too), so the two agree, an
  // unchanged save changes nothing, and a word edit keeps it byte for byte.
  const punct = [{ tag: "sp", endTag: "", children: [{ text: "The", tag: "w", type: "word", occurrence: "1", occurrences: "1" }, { tag: "f", type: "footnote", content: "+ \\ft N.", endTag: "f*", nextChar: ";" }, { type: "text", text: " " }, { text: "woman", tag: "w", type: "word", occurrence: "1", occurrences: "1" }, { type: "text", text: "\n" }] }, { tag: "q1", type: "quote" }, { text: "Hi", tag: "w", type: "word", occurrence: "1", occurrences: "1" }];
  const pText = splitSectionHeaders(punct).sections[0].text;
  assert(pText === "The woman", `a punctuation nextChar is not band text (got ${json(pText)})`);
  assert(editHeaderBand(punct, { index: 0, tag: "sp", text: pText }) === punct, "punctuation nextChar: an unchanged band save hands back the same verse");
  const pEdit = editHeaderBand(punct, { index: 0, tag: "sp", text: "The lady" });
  assert(labelBytes(pEdit) === labelBytes(punct).replace("\\w woman|", "\\w lady|"), `punctuation nextChar: a word edit keeps it byte for byte (got ${json(labelBytes(pEdit))})`);
}

// #1366 item 3: only character and note markers join a label's run. `\va`,
// `\vp`, `\ca` and `\fig` are closed markers too, but not part of a speaker
// label: a `\va` after a flat label stays in the verse (it used to be moved
// into the label and vanish from the body). `\fe` and `\wj` still join.
{
  const fx = usfm.toJSON(String.raw`\c 1
\p
\v 1 \w Body|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \w man|x-occurrence="1" x-occurrences="1"\w*
\va 2\va*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*
\v 2 \w B|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \fe + \ft end\fe* \wj \w man|x-occurrence="1" x-occurrences="1"\w*\wj*
\q1 \w Hi|x-occurrence="1" x-occurrences="1"\w*
\v 3 \w C|x-occurrence="1" x-occurrences="1"\w*.
\sp \w The|x-occurrence="1" x-occurrences="1"\w* \vp 2a\vp* \ca 3\ca* \fig A|src="a.jpg" size="col"\fig*
\q1 \w Go|x-occurrence="1" x-occurrences="1"\w*
`).chapters["1"];
  const kids = (vos) => labelsOf(vos)[0].children.map((c) => c.tag ?? c.type);
  const n1 = nestWordLabels(fx["1"].verseObjects);
  assert(!kids(n1).includes("va") && n1[n1.indexOf(labelsOf(n1)[0]) + 1]?.tag === "va", `\\va after a label stays in the verse (got label ${json(kids(n1))})`);
  assert(render(n1) === render(fx["1"].verseObjects), "\\va: renders byte-identical");
  const n2 = nestWordLabels(fx["2"].verseObjects);
  assert(kids(n2).includes("fe") && kids(n2).includes("wj") && n2[n2.indexOf(labelsOf(n2)[0]) + 1]?.tag === "q1", `\\fe and \\wj join the label (got ${json(kids(n2))})`);
  const n3 = nestWordLabels(fx["3"].verseObjects);
  assert(!kids(n3).some((k) => k === "vp" || k === "ca" || k === "fig"), `\\vp, \\ca, \\fig are not label markers (got ${json(kids(n3))})`);
  assert(render(n3) === render(fx["3"].verseObjects), "\\vp/\\ca/\\fig: renders byte-identical");
}

// #1366 item 6 (kept as is, pinned): a band save with blank text writes the
// label as plain text, so its words and their alignment go, as delete and a
// retag already do (the body rule: deleting words drops their alignment).
{
  const blank = editHeaderBand(v4, { index: 2, tag: "sp", text: "" });
  const l = labelsOf(blank)[2];
  assert(json(l) === json({ tag: "sp", nextChar: " ", content: "\n" }) && labelsOf(blank).length === 4, `blank text: the label becomes an empty plain-text label (got ${json(l)})`);
  assert(analyzeAlignmentDelta({ verseObjects: v4 }, { verseObjects: blank }).afterAligned < analyzeAlignmentDelta({ verseObjects: v4 }, { verseObjects: blank }).beforeAligned,
    "blank text: the label's aligned words are gone");
}

// Review round 4 of #1350. The labels are Door43's bytes: the save's quote
// curling (curlifyVerseContent, run on every typed save) must not touch a quote
// inside a word label, and a quote only in a label must not make the save
// clone and re-lay the verse at all.
{
  const wq = (text, occ = "1", occs = "1") => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
  const tq = (text) => ({ type: "text", text });
  const label = () => ({
    tag: "sp", nextChar: " ", endTag: "",
    children: [wq("The"), tq(" "), { tag: "zaln", type: "milestone", strong: "H1", content: "א", occurrence: "1", occurrences: "1", children: [wq("king's")], endTag: "zaln-e\\*" }, tq(" \"men\"\n")],
  });
  const body = (quote) => [wq("A"), tq(` ${quote}home`), tq(".\n"), label(), { tag: "q1", type: "quote" }, wq("He"), tq(" ran.")];
  const both = { verseObjects: body("'") };
  const curled = curlifyVerseContent(both);
  assert(json(labelsOf(curled.verseObjects)) === json(labelsOf(both.verseObjects)), `curling a save leaves a word label's quotes as Door43 wrote them (got ${json(labelsOf(curled.verseObjects))})`);
  assert(extractPlainText(curled).includes("‘home"), `the body quote is still curled (got ${json(extractPlainText(curled))})`);
  const onlyLabel = { verseObjects: body("") };
  assert(curlifyVerseContent(onlyLabel) === onlyLabel, "a quote only inside a word label: the save hands back the same tree");
}

// A source word aligned only inside a word label (SNG 1:4's label holds
// `\zaln-s H0157`) is aligned: the aligner must not offer it as an empty card,
// or aligning it again writes a second milestone for the same source word.
// (In the real 1:4 that word is also aligned twice in the body, so it was
// covered anyway; this pins the label-only case.)
{
  const src = (text, strong) => ({ tag: "w", type: "word", text, strong, lemma: text, morph: "He,Vqp3cp", occurrence: "1", occurrences: "1" });
  const source = [src("אָב", "H0001"), { type: "text", text: " " }, src("אָהַב", "H0157")];
  const zaln = (strong, content, kids) => ({ tag: "zaln", type: "milestone", strong, lemma: content, morph: "He,Vqp3cp", content, occurrence: "1", occurrences: "1", children: kids, endTag: "zaln-e\\*" });
  const wd = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
  const target = [
    zaln("H0001", "אָב", [wd("Father")]), { type: "text", text: ".\n" },
    { tag: "sp", nextChar: " ", endTag: "", children: [wd("The"), { type: "text", text: " " }, zaln("H0157", "אָהַב", [wd("lover")]), { type: "text", text: "\n" }] },
    { tag: "q1", type: "quote" }, wd("Come"), { type: "text", text: "." },
  ];
  const st = parseAlignment(target, source);
  const strongs = st.sourceGroups.map((g) => `${g.source.map((s) => s.strong).join("+")}:${g.targets?.length ?? 0}`);
  assert(!st.sourceGroups.some((g) => g.source.some((s) => s.strong === "H0157")), `a source word aligned inside a word label gets no empty card (got ${json(strongs)})`);
  assert(json(labelsOf(serializeAlignment(st))) === json(labelsOf(target)), "the label (and its milestone) round-trips the aligner untouched");
}

// Only `\sp` holds a label written as words. Another header-label node that
// carries `children` (a `\r` or `\cl` usfm-js gave children) is not one, so
// the edit engine and the header band treat it as before.
{
  assert(isWordLabelNode({ tag: "sp", children: [{ type: "word", tag: "w", text: "The" }], endTag: "" }), "an sp with word children is a word label");
  assert(!isWordLabelNode({ tag: "r", children: [{ type: "text", text: "(Ps 23)" }] }), "an r with children is not a word label");
  assert(!isWordLabelNode({ tag: "cl", children: [{ type: "text", text: "Psalm" }] }), "a cl with children is not a word label");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`spWordLabel: ${passed} checks passed.`);

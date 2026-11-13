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
import { nestWordLabels, splitSectionHeaders, extractPlainText, extractEditableText, rewriteHeaderLabel } from "./usfm.ts";
import { parseAlignment, serializeAlignment, countUnalignedTargetWords } from "./alignment.ts";

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

// Editing the label in the header band writes plain label text once, never
// the text plus the old words.
{
  const label = labelsOf(v1)[0];
  const edited = rewriteHeaderLabel(label, "sp", "The woman dreams");
  const r = render([edited]);
  assert(r.includes("\\sp The woman dreams\n") && !r.includes("\\w") && !r.includes("thinks"), `band edit renders the new text once (got ${json(r)})`);
  assert(rewriteHeaderLabel(label, "sp", "The woman thinks about the man she loves") === label, "an unchanged band save keeps the words as they were");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`spWordLabel: ${passed} checks passed.`);

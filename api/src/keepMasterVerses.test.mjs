// #1412: planKeepMasterVerses / masterMovedVerseGuardRefuses, the verse half
// of keepMasterRows.test.mjs. Run from api/:
//   node --experimental-strip-types --no-warnings src/keepMasterVerses.test.mjs
//
// Renders come from real Door43 files through the production importer and
// renderer (extractVersesForRange → buildUsfm), the same path the export takes.
//
// The last block replays the 2026-08-11 1CH ULT revert (STATE.md) from a
// trimmed copy (chapters 1-3, header kept) of the real Door43 files
// (src/fixtures/1ch-ult-2026-08-11.*.usfm.txt; .txt because the repo ignores *.usfm):
//   base   = en_ult ba9a53d2 (our 2026-08-08 push, PR #6644, merged)
//   master = en_ult 59053738 (master just before the reverting push)
//   ours   = en_ult 00a4f292 (the 2026-08-11 push, PR #6664, that reverted it)
// ours and base are laid out by today's normalizeUsfmFormatting, as the
// export would render them now. Measured on the WHOLE book (not checked in,
// 2.6 MB each): 195 verses kept and 4 that cannot be placed, so that push
// would now be refused (master_moved_guard), not shipped.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUsfm,
  keptVerseRefsBetween,
  MASTER_MOVED_REFUSE_THRESHOLD,
  masterMovedVerseGuardRefuses,
  planKeepMasterVerses,
  usfmRevertReport,
  verseTextByRef,
} from "./export.ts";
import { extractVersesForRange } from "./importParsers.ts";
import { normalizeUsfmFormatting } from "./usfmFormat.ts";
import { validateUsfm } from "./usfmValidate.ts";

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name) => readFileSync(join(here, "..", "..", "docs", "samples", name), "utf8");
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");

// D1's render of a Door43 file, as the export produces it.
function render(raw, bibleVersion = "ULT") {
  const verses = extractVersesForRange(raw, 0, 999).map((e) => ({
    book: "X",
    chapter: e.chapter,
    verse: e.verse,
    verse_end: e.verseEnd,
    bible_version: bibleVersion,
    content_json: e.contentJson,
    plain_text: e.plainText,
    version: 1,
    updated_by: null,
    updated_at: 0,
  }));
  return buildUsfm({ book: "OBA", bibleVersion, headers: null, verses });
}

// One verse's text: its `\v` marker to the next `\v`/`\c` (chapter 1 files).
function verseSpan(usfm, verse) {
  const start = usfm.search(new RegExp(`\\\\v ${verse}(?=\\s)`));
  if (start < 0) throw new Error(`test setup: no \\v ${verse}`);
  const rest = usfm.slice(start + 3);
  const next = rest.search(/\\[vc]\s/);
  return { start, end: next < 0 ? usfm.length : start + 3 + next };
}
const verseText = (usfm, verse) => {
  const s = verseSpan(usfm, verse);
  return usfm.slice(s.start, s.end);
};
function editVerse(usfm, verse, from, to) {
  const s = verseSpan(usfm, verse);
  const body = usfm.slice(s.start, s.end);
  const next = body.replace(from, to);
  if (next === body) throw new Error(`test setup: ${JSON.stringify(from)} not in ${verse}`);
  return usfm.slice(0, s.start) + next + usfm.slice(s.end);
}
// Change the first `\w` word of a verse (a person editing on Door43).
const editFirstWord = (usfm, verse) => editVerse(usfm, verse, /\\w ([^|\s]+)\|/, "\\w $1Q|");
// "ref/reason,…" for a plan's unplaceable verses.
const cp = (plan) => (plan ? plan.cannotPlace.map((u) => `${u.ref}/${u.reason}`).join() : "null");

const OBA = render(sample("31-OBA.usfm"));
ok(normalizeUsfmFormatting(OBA) === OBA, "(setup: our render is already in our own layout)");

console.log("\n[1. round trip: unchanged ours, base and master keep nothing]");
{
  const plan = planKeepMasterVerses(OBA, OBA, OBA);
  ok(plan && plan.kept.length === 0 && plan.cannotPlace.length === 0 && plan.content === OBA, "nothing kept, content unchanged");
  // A second render of the same D1 is byte-identical, so night 2 is the same.
  ok(render(sample("31-OBA.usfm")) === OBA, "rendering the same D1 twice gives the same bytes");
}

console.log("\n[2. only master changed a verse → master's verse is kept, every other verse is ours byte for byte]");
{
  const master = editFirstWord(OBA, 3);
  const plan = planKeepMasterVerses(OBA, OBA, master, null, true);
  ok(plan && plan.kept.join() === "1:3" && plan.cannotPlace.length === 0, `kept 1:3 (${plan?.kept})`);
  ok(plan.content === master, "the result equals master's file");
  ok(!masterMovedVerseGuardRefuses(plan), "one kept verse does not refuse");
  ok(usfmRevertReport(plan.content, master, OBA).entries.length === 0, "the revert report finds nothing overwritten");
}

console.log("\n[3. the first and last verse of the file]");
{
  const master = editFirstWord(editFirstWord(OBA, 1), 21);
  const plan = planKeepMasterVerses(OBA, OBA, master, null, true);
  ok(plan && plan.kept.join() === "1:1,1:21" && plan.content === master, `kept 1:1 and 1:21 (${plan?.kept})`);
}

console.log("\n[4. ours changed the verse too → ours ships]");
{
  const master = editFirstWord(OBA, 3);
  const ours = editVerse(OBA, 3, "\\w pride|", "\\w arrogance|");
  const plan = planKeepMasterVerses(ours, OBA, master, null, true);
  ok(plan && plan.kept.length === 0 && plan.content === ours, "nothing kept");
}

console.log("\n[5. ours differs from base only by render churn (masked) → still ours-unchanged]");
{
  // recomputeTargetOccurrences renumbering a `\w` (STATE.md) is churn, not an edit.
  const base = editVerse(OBA, 3, /(\\w pride\|x-occurrence=")1(" x-occurrences=")1"/, '$12$22"');
  const master = editFirstWord(base, 3);
  const plan = planKeepMasterVerses(OBA, base, master, null, true);
  ok(plan && plan.kept.join() === "1:3", `kept 1:3 (${plan?.kept})`);
}

console.log("\n[6. master moved only formatting (spaces between words, Hebrew mark order) → ours ships]");
{
  const spaced = editVerse(OBA, 3, /\\w\*\n\\w /, "\\w*   \n\\w ");
  ok(spaced !== OBA, "(setup: master differs in bytes)");
  const p1 = planKeepMasterVerses(OBA, OBA, spaced, null, true);
  ok(p1 && p1.kept.length === 0, `whitespace: nothing kept (${p1?.kept})`);
  // Every x-content in NFC order instead of the UHB's legacy order.
  const nfc = OBA.replace(/x-content="([^"]+)"/g, (_, c) => `x-content="${c.normalize("NFC")}"`);
  ok(nfc !== OBA, "(setup: some x-content is not NFC)");
  const p2 = planKeepMasterVerses(OBA, OBA, nfc, null, true);
  ok(p2 && p2.kept.length === 0, `mark order: nothing kept (${p2?.kept})`);
}

console.log("\n[7. a verse new in ours (not in base) is never kept]");
{
  const base = OBA.replace(/\\v 21 [\s\S]*$/, "");
  const master = editFirstWord(OBA, 21);
  const plan = planKeepMasterVerses(OBA, base, master, null, true);
  ok(plan && plan.kept.length === 0 && plan.cannotPlace.length === 0, "nothing kept");
}

console.log("\n[8. bridged verse (2CH 9:10-12): kept by its bridge key; a re-bridge cannot be placed]");
{
  const ours = render(sample("en_ust_14-2CH-9_10-12.usfm"), "UST");
  const master = editVerse(ours, "10-12", /\\w ([^|\s]+)\|/, "\\w $1Q|");
  const plan = planKeepMasterVerses(ours, ours, master, null, true);
  ok(plan && plan.kept.join() === "9:10-12" && plan.content === master, `kept 9:10-12 (${plan?.kept})`);
  const rebridged = ours.replace("\\v 10-12", "\\v 10-11");
  const p2 = planKeepMasterVerses(ours, ours, rebridged, null, true);
  ok(cp(p2) === "9:10-12/structure" && masterMovedVerseGuardRefuses(p2), `cannot place 9:10-12 (${cp(p2)})`);
}

console.log("\n[9. master lacks a verse: overlap or a proven-whole read → cannot place; otherwise ships]");
{
  // Door43 bridged 2 and 3: "1:2" and "1:3" are gone, "1:2-3" overlaps both.
  const s3 = verseSpan(OBA, 3);
  const bridged = (OBA.slice(0, s3.start) + OBA.slice(s3.start).replace(/^\\v 3\s*/, "")).replace(/\\v 2(?=\s)/, "\\v 2-3");
  const p1 = planKeepMasterVerses(OBA, OBA, bridged, null, true);
  ok(cp(p1) === "1:2/structure,1:3/structure", `re-bridge: cannot place 1:2, 1:3 (${cp(p1)})`);
  // The last verse missing with nothing overlapping: a short read looks the same.
  const short = OBA.slice(0, verseSpan(OBA, 21).start);
  const p2 = planKeepMasterVerses(OBA, OBA, short);
  ok(p2 && p2.cannotPlace.length === 0 && p2.kept.length === 0, "unverified read: ships as before");
  const p3 = planKeepMasterVerses(OBA, OBA, short, null, true);
  ok(cp(p3) === "1:21/structure", `verified read: cannot place 1:21 (${cp(p3)})`);
}

console.log("\n[10. master doubled a verse marker → cannot place]");
{
  const s = verseSpan(OBA, 5);
  const doubled = OBA.slice(0, s.end) + OBA.slice(s.start, s.end) + OBA.slice(s.end);
  const plan = planKeepMasterVerses(OBA, OBA, doubled, null, true);
  ok(cp(plan) === "1:5/structure", `cannot place 1:5 (${cp(plan)})`);
}

console.log("\n[11. onlyRefs limits the plan (carry mode)]");
{
  const master = editFirstWord(editFirstWord(OBA, 3), 4);
  const plan = planKeepMasterVerses(OBA, OBA, master, new Set(["1:4"]), true);
  ok(plan && plan.kept.join() === "1:4", `only 1:4 kept (${plan?.kept})`);
  ok(verseText(plan.content, 3) === verseText(OBA, 3), "1:3 stays ours");
}

console.log("\n[12. keptVerseRefsBetween reads back what a push kept]");
{
  const pushed = planKeepMasterVerses(OBA, OBA, editFirstWord(editFirstWord(OBA, 3), 7), null, true).content;
  ok([...keptVerseRefsBetween(OBA, pushed)].join() === "1:3,1:7", "1:3 and 1:7");
}

console.log("\n[13. unparseable input → null (not measured)]");
{
  ok(planKeepMasterVerses(OBA, OBA, "\\v 1 no chapter") === null, "a verse before any chapter");
  ok(planKeepMasterVerses(OBA, OBA.replace("\\v 4 ", "\\v 4a "), OBA) === null, "a verse number that is not a plain verse or range");
}

console.log("\n[14. threshold: kept verses count one each, a bridge too; any cannot-place refuses]");
{
  const refs = (n) => Array.from({ length: n }, (_, i) => `1:${i + 1}`);
  ok(MASTER_MOVED_REFUSE_THRESHOLD === 20, "threshold is 20");
  ok(!masterMovedVerseGuardRefuses({ kept: refs(20), cannotPlace: [] }), "20 kept ships");
  ok(masterMovedVerseGuardRefuses({ kept: refs(21), cannotPlace: [] }), "21 kept refuses");
  ok(masterMovedVerseGuardRefuses({ kept: [], cannotPlace: [{ ref: "1:2", reason: "structure" }] }), "one cannot-place refuses");
}

console.log("\n[14b. a master read not proven whole keeps nothing (review A1)]");
{
  // A read cut inside the last verse still parses, and the stub of 1:21
  // would read as a Door43 edit.
  const s21 = verseSpan(OBA, 21);
  const cut = OBA.slice(0, s21.start + Math.floor((s21.end - s21.start) / 2));
  ok(verseTextByRef(cut)?.has("1:21"), "(setup: the cut file still parses with a 1:21)");
  const unverified = planKeepMasterVerses(OBA, OBA, cut);
  ok(unverified && unverified.kept.length === 0 && unverified.content === OBA, `unverified: nothing kept, ours ships (${unverified?.kept})`);
  const real = planKeepMasterVerses(OBA, OBA, editFirstWord(OBA, 3));
  ok(real && real.kept.length === 0 && !masterMovedVerseGuardRefuses(real), "unverified: even a real Door43 edit ships as before");
}

console.log("\n[14c. a measured refusal does not depend on the splice (review A2)]");
{
  let master = OBA;
  for (let v = 1; v <= 21; v++) master = editFirstWord(master, v);
  const plan = planKeepMasterVerses(OBA, OBA, master, null, true);
  ok(plan && plan.kept.length === 21 && masterMovedVerseGuardRefuses(plan), `21 kept → refuses (${plan?.kept.length})`);
  ok(plan.content === OBA && plan.unspliced.length === 0, "nothing was spliced for a push that will not ship");
}

console.log("\n[14d. master byte-equal to base: early exit, same answer (review A3)]");
{
  const ours = editVerse(OBA, 3, "\\w pride|", "\\w arrogance|");
  const plan = planKeepMasterVerses(ours, OBA, OBA, null, true);
  ok(plan && plan.kept.length === 0 && plan.cannotPlace.length === 0 && plan.content === ours, "nothing kept, ours ships");
}

console.log("\n[15. replay: 1CH ULT, 2026-08-11 (chapters 1-3)]");
{
  const base = normalizeUsfmFormatting(fixture("1ch-ult-2026-08-11.base.usfm.txt"));
  const master = fixture("1ch-ult-2026-08-11.master.usfm.txt");
  const ours = normalizeUsfmFormatting(fixture("1ch-ult-2026-08-11.ours.usfm.txt"));
  const plan = planKeepMasterVerses(ours, base, master, null, true);
  ok(plan && plan.kept.length === 17, `17 verses Door43 changed and Bible Editor did not are kept (${plan?.kept.length})`);
  // Door43's text for these lays out differently under our validator layout
  // (1:45 ends `\ts*  \v 46`), so it cannot ship as master's verse.
  ok(cp(plan) === "1:19/layout,1:45/layout,1:48/layout", `1:19, 1:45, 1:48 cannot be placed (${cp(plan)})`);
  ok(masterMovedVerseGuardRefuses(plan), "so this push is refused, and master keeps every one of them");

  // Chapters 2-3 alone: nothing unplaceable, 16 kept, and the push ships them.
  const from2 = (u) => u.slice(0, u.search(/\\c\s+1\s/)) + u.slice(u.search(/\\c\s+2\s/));
  const p2 = planKeepMasterVerses(from2(ours), from2(base), from2(master), null, true);
  ok(p2 && p2.kept.length === 16 && p2.cannotPlace.length === 0, `chapters 2-3: 16 kept, 0 cannot place (${p2?.kept.length}, ${cp(p2)})`);
  ok(!masterMovedVerseGuardRefuses(p2), "…which ships");
  ok(validateUsfm(p2.content).length === 0, "the result passes validateUsfm");
  const reverted = new Set(usfmRevertReport(p2.content, from2(master), from2(base)).entries.map((e) => e.ref));
  ok(p2.kept.every((r) => !reverted.has(r)), `no kept verse is reported as reverted (${JSON.stringify(usfmRevertReport(p2.content, from2(master), from2(base)).entries.filter((e) => p2.kept.includes(e.ref)))})`);
  const oursRefs = verseTextByRef(from2(ours));
  const outRefs = verseTextByRef(p2.content);
  ok([...oursRefs].every(([r, j]) => p2.kept.includes(r) || outRefs.get(r) === j), "every other verse is ours, parse for parse");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nkeepMasterVerses: all passed");

// #1403: planKeepMasterRows / masterMovedGuardRefuses, the export's per-row
// three-way check for tn/tq/twl. Run from api/:
//   node --experimental-strip-types --no-warnings src/keepMasterRows.test.mjs
//
// The last block replays the 2026-11-16 NUM TN revert (#1407) from a trimmed
// copy of the real Door43 files (src/fixtures/num-tn-2026-11-16.*.tsv):
//   base   = en_tn fdde7f08 (our 2026-11-11 push, PR #7980, merged)
//   ours   = en_tn f7c0bf34 (the 2026-11-16 render, PR #8022)
//   master = en_tn c74d711c (master just before #8022, with Richard's edits)
// The trim keeps every row the guard keeps plus up to 15 rows of each other
// shape (both sides changed, master-only cosmetic, identical).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MASTER_MOVED_REFUSE_THRESHOLD,
  masterMovedGuardRefuses,
  planKeepMasterRows,
  tsvRevertReport,
} from "./export.ts";

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const TN_HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
const tn = (rows) => [TN_HEADER, ...rows.map((r) => r.join("\t"))].join("\n") + "\n";
const row = (ref, id, note, quote = "q") => [ref, id, "", "rc://*/ta/man/translate/figs-metaphor", quote, "1", note];

console.log("\n[only master moved → master's row ships]");
{
  const base = tn([row("1:1", "aa11", "Old note."), row("1:2", "bb22", "Second.")]);
  const ours = base;
  const master = tn([row("1:1", "aa11", "Fixed note on Door43."), row("1:2", "bb22", "Second.")]);
  const plan = planKeepMasterRows(ours, base, master, "tn");
  ok(plan.kept.length === 1 && plan.kept[0].id === "aa11", "aa11 is kept");
  ok(plan.kept[0].fields.join(",") === "Note", "…naming the field master changed");
  ok(plan.content === master, "the render becomes byte-identical to master");
  ok(!masterMovedGuardRefuses(plan), "one kept row ships");
  const report = tsvRevertReport(plan.content, master, "tn", base);
  ok(report.entries.length === 0, "the revert report then finds nothing to overwrite");
}

console.log("\n[both sides changed → ours ships (merge-conflict logic untouched)]");
{
  const base = tn([row("1:1", "aa11", "Old note.")]);
  const ours = tn([row("1:1", "aa11", "Translator's new note.")]);
  const master = tn([row("1:1", "aa11", "Fixed note on Door43.")]);
  const plan = planKeepMasterRows(ours, base, master, "tn");
  ok(plan.kept.length === 0 && plan.moved.length === 0, "nothing kept");
  ok(plan.content === ours, "render unchanged");
}

console.log("\n[only ours changed → ours ships]");
{
  const base = tn([row("1:1", "aa11", "Old note.")]);
  const ours = tn([row("1:1", "aa11", "Translator's new note.")]);
  const plan = planKeepMasterRows(ours, base, base, "tn");
  ok(plan.kept.length === 0 && plan.content === ours, "nothing kept, render unchanged");
}

console.log("\n[cosmetic differences]");
{
  const base = tn([row("1:1", "aa11", "Old  note."), row("1:2", "bb22", "Two.")]);
  // master: whitespace-only on aa11, Tags-only on bb22 → neither is substantive.
  const masterRows = [row("1:1", "aa11", "Old note. "), row("1:2", "bb22", "Two.")];
  masterRows[1][2] = "keyterm";
  const plan = planKeepMasterRows(base, base, tn(masterRows), "tn");
  ok(plan.kept.length === 0, "whitespace-only and Tags-only master moves are not kept");
  // ours differs from base only in whitespace (renderer churn) → still "unchanged".
  const oursReflowed = tn([row("1:1", "aa11", "Old note."), row("1:2", "bb22", "Two.")]);
  const master2 = tn([row("1:1", "aa11", "New wording."), row("1:2", "bb22", "Two.")]);
  const plan2 = planKeepMasterRows(oursReflowed, base, master2, "tn");
  ok(plan2.kept.map((k) => k.id).join() === "aa11", "a whitespace-only reflow on our side does not switch the guard off");
  // Hebrew mark order: same text, combining marks in a different order.
  const legacy = "בְּ"; // bet + dagesh + sheva
  const nfc = legacy.normalize("NFC");
  ok(legacy !== nfc, "(fixture: the two quote strings differ byte-wise)");
  const plan3 = planKeepMasterRows(tn([row("1:1", "aa11", "N.", legacy)]), tn([row("1:1", "aa11", "N.", legacy)]), tn([row("1:1", "aa11", "N.", nfc)]), "tn");
  ok(plan3.kept.length === 0, "a Hebrew mark-order-only quote change on master is not substantive");
}

console.log("\n[master moved the row to another verse → not kept, refuses]");
{
  const base = tn([row("1:1", "aa11", "Old note.")]);
  const master = tn([row("1:2", "aa11", "Note rewritten for verse 2.")]);
  const plan = planKeepMasterRows(base, base, master, "tn");
  ok(plan.kept.length === 0 && plan.moved.length === 1, "reported as moved, not kept");
  ok(plan.content === base, "render left as ours");
  ok(masterMovedGuardRefuses(plan), "a moved row refuses the push");
}

console.log("\n[review round 1: what still counts as our change, and as a Door43 move]");
{
  // A Door43 move to another verse with NO text change also refuses (Codex F2).
  const base = tn([row("1:1", "aa11", "Same note.")]);
  const movedOnly = planKeepMasterRows(base, base, tn([row("1:2", "aa11", "Same note.")]), "tn");
  ok(movedOnly.moved.length === 1 && movedOnly.kept.length === 0, "a reference-only move is reported as moved");
  ok(masterMovedGuardRefuses(movedOnly), "…and refuses the push");

  // A translator's literal line break is our change, not whitespace churn.
  const oursBreak = tn([row("1:1", "aa11", "Same\\nnote.")]);
  const p1 = planKeepMasterRows(oursBreak, base, tn([row("1:1", "aa11", "Door43 wording.")]), "tn");
  ok(p1.kept.length === 0 && p1.content === oursBreak, "a `\\n` line-break edit on our side keeps ours");

  // twl: a translator's Tags-only edit is our change too (Codex F1).
  const TWL = "Reference\tID\tTags\tOrigWords\tOccurrence\tTWLink";
  const twl = (words, tags) => `${TWL}\n1:1\tw111\t${tags}\t${words}\t1\trc://*/tw/dict/bible/kt/god\n`;
  const p2 = planKeepMasterRows(twl("אֱלֹהִים", "keyterm"), twl("אֱלֹהִים", ""), twl("אֱלֹהֵי", ""), "twl");
  ok(p2.kept.length === 0, "a twl Tags edit on our side keeps ours");

  // tn: a kept row ships with blank Tags, like every other exported tn row.
  const masterTagged = [row("1:1", "aa11", "Door43 wording.")];
  masterTagged[0][2] = "stale-tag";
  const p3 = planKeepMasterRows(base, base, tn(masterTagged), "tn");
  ok(p3.kept.length === 1 && p3.content.split("\n")[1].split("\t")[2] === "", "a kept tn row's Tags are blanked");

  // Columns in another order are not read as ours (Claude F9).
  const swapped = base.replace("SupportReference\tQuote", "Quote\tSupportReference");
  ok(planKeepMasterRows(base, base, swapped, "tn") === null, "a master with reordered columns → null");

  // Review round 2: a Reference that differs only in spacing or dash form is
  // not a move (it would refuse the whole push), and a BOM does not switch
  // the guard off.
  const ranged = tn([row("1:1-3", "aa11", "Same note.")]);
  const dashOnly = planKeepMasterRows(ranged, ranged, tn([row("1:1–3 ", "aa11", "Same note.")]), "tn");
  ok(dashOnly.moved.length === 0 && dashOnly.kept.length === 0, "a dash/space-only Reference difference is not a move");
  const bomMaster = "﻿" + tn([row("1:1", "aa11", "Door43 wording.")]);
  ok(planKeepMasterRows(base, base, bomMaster, "tn")?.kept.length === 1, "a master file with a BOM is still measured");

  // onlyIds restricts the plan (carry mode).
  const two = tn([row("1:1", "aa11", "A."), row("1:2", "bb22", "B.")]);
  const twoMaster = tn([row("1:1", "aa11", "A fixed."), row("1:2", "bb22", "B fixed.")]);
  const p4 = planKeepMasterRows(two, two, twoMaster, "tn", new Set(["bb22"]));
  ok(p4.kept.map((k) => k.id).join() === "bb22", "onlyIds limits the kept rows");
}

console.log("\n[threshold]");
{
  const n = MASTER_MOVED_REFUSE_THRESHOLD + 1;
  const ids = Array.from({ length: n + 2 }, (_, i) => `r${String(i).padStart(3, "0")}`);
  const base = tn(ids.map((id, i) => row(`1:${i + 1}`, id, `Note ${i}.`)));
  const atLimit = tn(ids.map((id, i) => row(`1:${i + 1}`, id, i < MASTER_MOVED_REFUSE_THRESHOLD ? `Fixed ${i}.` : `Note ${i}.`)));
  const over = tn(ids.map((id, i) => row(`1:${i + 1}`, id, i < n ? `Fixed ${i}.` : `Note ${i}.`)));
  ok(!masterMovedGuardRefuses(planKeepMasterRows(base, base, atLimit, "tn")), `${MASTER_MOVED_REFUSE_THRESHOLD} kept rows ship`);
  ok(masterMovedGuardRefuses(planKeepMasterRows(base, base, over, "tn")), `${n} kept rows refuse`);
}

console.log("\n[fails open / skips what it cannot place]");
{
  const base = tn([row("1:1", "aa11", "Old.")]);
  ok(planKeepMasterRows(base, "not a tsv", base, "tn") === null, "unparseable base → null (caller ships as today)");
  ok(planKeepMasterRows(base, base, "Reference\tNope\n", "tn") === null, "unparseable master → null");
  const dupMaster = tn([row("1:1", "aa11", "New."), row("1:1", "aa11", "Newer.")]);
  ok(planKeepMasterRows(base, base, dupMaster, "tn").kept.length === 0, "a duplicated ID is never kept");
  const newOnMaster = tn([row("1:1", "aa11", "Old."), row("1:2", "zz99", "Added on Door43.")]);
  ok(planKeepMasterRows(base, base, newOnMaster, "tn").kept.length === 0, "a row only master has is left to the shrink guard");
}

console.log("\n[tq and twl columns]");
{
  const TQ = "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse";
  const tq = (resp) => `${TQ}\n1:1\tq111\t\t\t\tWho?\t${resp}\n`;
  ok(planKeepMasterRows(tq("God."), tq("God."), tq("The LORD."), "tq").kept.length === 1, "tq Response change is kept");
  const TWL = "Reference\tID\tTags\tOrigWords\tOccurrence\tTWLink";
  const twl = (link, tags = "") => `${TWL}\n1:1\tw111\t${tags}\tאֱלֹהִים\t1\t${link}\n`;
  ok(planKeepMasterRows(twl("rc://*/tw/dict/bible/kt/god"), twl("rc://*/tw/dict/bible/kt/god"), twl("rc://*/tw/dict/bible/kt/falsegod"), "twl").kept.length === 1, "twl TWLink change is kept");
  ok(planKeepMasterRows(twl("rc://*/tw/dict/bible/kt/god"), twl("rc://*/tw/dict/bible/kt/god"), twl("rc://*/tw/dict/bible/kt/god", "keyterm"), "twl").kept.length === 0, "twl Tags-only change is not");
}

console.log("\n[replay: NUM TN, 2026-11-16 (#1407)]");
{
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  const read = (k) => readFileSync(join(dir, `num-tn-2026-11-16.${k}.tsv`), "utf8");
  const base = read("base");
  const ours = read("ours");
  const master = read("master");
  const before = tsvRevertReport(ours, master, "tn", base).entries.filter((e) => e.class === "substantive");
  ok(before.length === 79, `the shipped render reverted 79 substantive rows (alert 1439/1440 count; got ${before.length})`);
  const plan = planKeepMasterRows(ours, base, master, "tn");
  ok(plan.kept.length === 79 && plan.moved.length === 0, `the guard keeps master's text on all 79 (got ${plan.kept.length} kept, ${plan.moved.length} moved)`);
  const keptIds = new Set(plan.kept.map((k) => k.id));
  ok(before.every((e) => plan.kept.some((k) => k.ref === e.ref)), "every reverted ref is among the kept rows");
  const after = tsvRevertReport(plan.content, master, "tn", base).entries.filter((e) => e.class === "substantive");
  ok(after.length === 0, "with the guard, the render reverts none of them");
  const masterLines = new Map(master.split("\n").slice(1).filter(Boolean).map((l) => [l.split("\t")[1], l]));
  const oursLines = new Map(ours.split("\n").slice(1).filter(Boolean).map((l) => [l.split("\t")[1], l]));
  const outLines = plan.content.split("\n").slice(1).filter(Boolean);
  ok(outLines.every((l) => {
    const id = l.split("\t")[1];
    return keptIds.has(id) ? l === masterLines.get(id) : l === oursLines.get(id);
  }), "kept rows are master's exact line; every other row is ours, unchanged");
  ok(masterMovedGuardRefuses(plan), `79 > ${MASTER_MOVED_REFUSE_THRESHOLD}: the workflow refuses this push and alerts instead`);
}

console.log("\n[#1415: only Door43 deleted a row → it is left out; a row we changed or added still ships]");
{
  const base = tn([row("1:1", "aa11", "One."), row("1:2", "bb22", "Two."), row("1:3", "cc33", "Three.")]);
  const ours = tn([row("1:1", "aa11", "One."), row("1:2", "bb22", "Two."), row("1:3", "cc33", "Three, edited."), row("1:4", "dd44", "New.")]);
  const master = tn([row("1:1", "aa11", "One.")]);
  const plan = planKeepMasterRows(ours, base, master, "tn");
  ok(plan.dropped.map((r) => r.id).join() === "bb22", `bb22 dropped (got ${plan.dropped.map((r) => r.id)})`);
  ok(plan.dropped[0].ref === "1:2", "dropped row carries our ref");
  ok(plan.kept.length === 0 && plan.moved.length === 0, "nothing kept or moved");
  ok(plan.content === tn([row("1:1", "aa11", "One."), row("1:3", "cc33", "Three, edited."), row("1:4", "dd44", "New.")]), "bb22's line is removed; cc33 (edited) and dd44 (new) ship");
  ok(!masterMovedGuardRefuses(plan), "one dropped row ships");

  const crlf = (s) => s.replace(/\n/g, "\r\n");
  const p2 = planKeepMasterRows(crlf(ours), base, master, "tn");
  ok(p2.content === crlf(tn([row("1:1", "aa11", "One."), row("1:3", "cc33", "Three, edited."), row("1:4", "dd44", "New.")])), "CRLF render: line removed cleanly");

  const p3 = planKeepMasterRows(ours, base, master, "tn", new Set(["aa11"]));
  ok(p3.dropped.length === 0 && p3.content === ours, "onlyIds without bb22: not dropped");

  ok(masterMovedGuardRefuses({ kept: Array(11).fill({}), moved: [], dropped: Array(10).fill({}) }), "11 kept + 10 dropped refuses");
  ok(!masterMovedGuardRefuses({ kept: Array(10).fill({}), moved: [], dropped: Array(10).fill({}) }), "10 kept + 10 dropped ships");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nkeepMasterRows: all passed");

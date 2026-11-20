// #1419: the export-revert report after D1 imported master's current file.
// Pure parts of export.ts: importedHeadUnusableReason (file-level gate),
// preImportRowMatchesMaster / partitionTsvRevertEntriesByImport (row level),
// and the record wording. The end-to-end shape (real ExportWorkflow) is in
// revertAfterImportJourney.test.mjs.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/exportRevertImportedHead.test.mjs
import {
  importedHeadUnusableReason,
  partitionTsvRevertEntriesByImport,
  planRevertReportAlerts,
  preImportRowMatchesMaster,
  tsvRevertReport,
} from "./export.ts";
import { splitRevertRefs } from "../../scripts/watchdog/exportRevertCheck.mjs";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const SHA = "e1997bc45e" + "0".repeat(30);
const LATER = "f0f0f0f0f0" + "0".repeat(30);
const SYNC = { sourceSha: SHA, origin: "reimport", syncedAt: 1794917541 };

// 1. File-level gate.
{
  eq(importedHeadUnusableReason(SYNC, SHA), "", "gate: clean reimport of the commit being diffed is usable");
  eq(importedHeadUnusableReason(SYNC, LATER), "master_moved_since_import", "gate: master moved after the import -> unusable");
  eq(importedHeadUnusableReason({ ...SYNC, origin: "reimport_withheld" }, SHA), "not_a_reimport", "gate: withheld sync -> unusable");
  eq(importedHeadUnusableReason({ ...SYNC, origin: "own_publish" }, SHA), "not_a_reimport", "gate: own_publish stamp -> unusable");
  eq(importedHeadUnusableReason({ ...SYNC, origin: "import" }, SHA), "not_a_reimport", "gate: first import (no merge ran) -> unusable");
  eq(importedHeadUnusableReason(null, SHA), "no_sync_row", "gate: no sync row -> unusable");
  eq(importedHeadUnusableReason({ ...SYNC, sourceSha: null }, null), "sha_unknown", "gate: null === null is not a match");
  eq(importedHeadUnusableReason({ ...SYNC, sourceSha: "" }, ""), "sha_unknown", "gate: empty shas are not a match");
  eq(importedHeadUnusableReason({ ...SYNC, syncedAt: null }, SHA), "synced_at_unknown", "gate: synced_at unknown -> unusable");
}

const H = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
const SR = "rc://*/ta/man/translate/figs-metaphor";
const tn = (rows) => `${H}\n${rows.map(([ref, id, note, quote = "q"]) => `${ref}\t${id}\t\t${SR}\t${quote}\t1\t${note}`).join("\n")}\n`;
const parsed = (ref, note, extra = {}) => ({
  id: "x",
  refRaw: ref,
  chapter: Number(ref.split(":")[0]),
  verse: Number(ref.split(":")[1]),
  occurrence: 1,
  tags: null,
  support_reference: SR,
  quote: "q",
  note,
  ...extra,
});
const refs = (l) => l.map((e) => e.ref);

// 2. Row level: the 2CH shape, and the variant where master moved after
//    the import.
{
  const base = tn([["1:2", "pcj7", "short of"], ["2:1", "fnm3", "Intro."]]); // our 10-23 export
  const master = tn([["1:2", "pcj7", "a person's fix"], ["2:1", "fnm3", "Intro.\\n\\n\\n"]]); // + human commits
  const render = tn([["1:2", "pcj7", "translator edit after import"], ["2:1", "fnm3", "Intro."]]);
  const report = tsvRevertReport(render, master, "tn", base);
  eq(refs(report.entries), ["1:2", "2:1"], "precondition: both rows report against the old export base");
  eq(report.entries.map((e) => e.id), ["pcj7", "fnm3"], "entries carry the row ID");
  const imported = new Map([
    ["pcj7", parsed("1:2", "a person's fix")],
    ["fnm3", parsed("2:1", "Intro.")], // stored normalised
  ]);
  const out = partitionTsvRevertEntriesByImport(report.entries, "tn", master, imported);
  eq([refs(out.attention), refs(out.probablyOurs)], [[], ["1:2", "2:1"]], "2CH: D1 held master's rows at the import -> all probably ours");

  // Variant: master changed pcj7 again after the import. Even if the gate
  // were passed, the row no longer equals what D1 imported.
  const masterLater = tn([["1:2", "pcj7", "a second person's fix"], ["2:1", "fnm3", "Intro.\\n\\n\\n"]]);
  const r2 = tsvRevertReport(render, masterLater, "tn", base);
  const o2 = partitionTsvRevertEntriesByImport(r2.entries, "tn", masterLater, imported);
  eq([refs(o2.attention), refs(o2.probablyOurs)], [["1:2"], ["2:1"]], "master moved after the import: that row needs attention");
}

// 3. Row-level evidence that must keep a row loud.
{
  const master = tn([["1:2", "aa11", "master text"]]);
  const render = tn([["1:2", "aa11", "app text"]]);
  const entries = tsvRevertReport(render, master, "tn", null).entries;
  const loud = (pre, label) => {
    const out = partitionTsvRevertEntriesByImport(entries, "tn", master, pre);
    eq([refs(out.attention), refs(out.probablyOurs)], [["1:2"], []], `attention: ${label}`);
  };
  loud(new Map(), "no edit_log write before the import (seeded row)");
  loud(new Map([["aa11", null]]), "latest pre-import write is a delete / unparseable");
  loud(new Map([["aa11", parsed("1:2", "old D1 text")]]), "import kept D1's own text (protected or conflict)");
  loud(new Map([["aa11", { review_kind: "merge_conflict" }]]), "latest pre-import write is a review-flag-only write");
  loud(new Map([["aa11", { note: "master text" }]]), "partial app payload (no refRaw / fields)");
  loud(new Map([["aa11", parsed("1:3", "master text")]]), "D1 held the row at another Reference (ref move kept)");
  const { quote, ...noQuote } = parsed("1:2", "master text");
  loud(new Map([["aa11", noQuote]]), "payload missing a content field");
  loud(new Map([["aa11", parsed("1:2", "master text", { quote: "other" })]]), "quote differs");
  loud(new Map([["aa11", parsed("1:2", 42)]]), "non-string note");
  const noId = entries.map(({ id, ...e }) => e);
  const o = partitionTsvRevertEntriesByImport(noId, "tn", master, new Map([["aa11", parsed("1:2", "master text")]]));
  eq(refs(o.attention), ["1:2"], "attention: an entry without an ID");
  const ok = partitionTsvRevertEntriesByImport(entries, "tn", master, new Map([["aa11", parsed("1:2", "master text")]]));
  eq(refs(ok.probablyOurs), ["1:2"], "control: the matching payload is probably ours");
  const bad = partitionTsvRevertEntriesByImport(entries, "tn", "garbage", new Map([["aa11", parsed("1:2", "master text")]]));
  eq(refs(bad.attention), ["1:2"], "attention: master does not parse");
}

// 4. Per Reference: export_reverts keeps one row per ref, so one loud row
//    at a ref keeps the others there loud too.
{
  const master = tn([["3:1", "r1", "m1"], ["3:1", "r2", "m2"], ["3:2", "r3", "m3"]]);
  const render = tn([["3:1", "r1", "a1"], ["3:1", "r2", "a2"], ["3:2", "r3", "a3"]]);
  const entries = tsvRevertReport(render, master, "tn", null).entries;
  const pre = new Map([
    ["r1", parsed("3:1", "m1")],
    ["r2", parsed("3:1", "D1 kept its own")],
    ["r3", parsed("3:2", "m3")],
  ]);
  const out = partitionTsvRevertEntriesByImport(entries, "tn", master, pre);
  eq([refs(out.attention), refs(out.probablyOurs)], [["3:1", "3:1"], ["3:2"]], "a loud row keeps its whole Reference loud");
}

// 5. Prose normalisation, tq and twl field sets.
{
  const cells = (ref, note) => [ref, "aa11", "", SR, "q", "1", note];
  eq(preImportRowMatchesMaster(cells("1:1", "A  note.\\n\\n"), parsed("1:1", "A note."), "tn"), true, "tn: doubled space and trailing literal \\n still match");
  eq(preImportRowMatchesMaster(cells("1:1", "A note, changed."), parsed("1:1", "A note."), "tn"), false, "tn: a substantive note change does not match");
  eq(preImportRowMatchesMaster(cells(" 1:1", "A note."), parsed("1:1", "A note."), "tn"), true, "tn: Reference compares trimmed");
  const tq = ["1:1", "q1", "", "", "1", "Who?", "Him."];
  const tqp = { refRaw: "1:1", quote: null, occurrence: 1, question: "Who?", response: "Him." };
  eq(preImportRowMatchesMaster(tq, tqp, "tq"), true, "tq: matching question and response");
  eq(preImportRowMatchesMaster(tq, { ...tqp, response: "Her." }, "tq"), false, "tq: response differs");
  const twl = ["1:1", "w1", "keyterm", "אֱלֹהִים", "1", "rc://*/tw/dict/bible/kt/god"];
  const twp = { refRaw: "1:1", tags: "keyterm", orig_words: "אֱלֹהִים", occurrence: 1, tw_link: "rc://*/tw/dict/bible/kt/god" };
  eq(preImportRowMatchesMaster(twl, twp, "twl"), true, "twl: matching row");
  eq(preImportRowMatchesMaster(twl, { ...twp, tags: "name" }, "twl"), false, "twl: Tags count (they ship as-is)");
  eq(preImportRowMatchesMaster(twl, { ...twp, tw_link: "rc://*/tw/dict/bible/kt/lord" }, "twl"), false, "twl: link differs");
}

// 6. The record's wording, and that the watchdog still parses it.
{
  const sub = (ref) => ({ ref, class: "substantive" });
  const plan = planRevertReportAlerts({
    book: "2CH",
    resource: "tn",
    kind: "tsv",
    attention: [],
    probablyOurs: [sub("1:2"), sub("2:intro")],
    mechanical: true,
    branch: "2CH-tn-be-1",
    generation: "g9",
    probablyOursBasis: { kind: "imported_head", importedSha: SHA },
  });
  eq(plan.map((a) => a.source), ["revert_probably_ours:2CH:tn"], "imported head: only the quiet record, no export_revert / mechanical_overwrite");
  eq(plan[0].severity, "info", "imported head: record is info");
  eq(plan[0].message.includes("on 2 row(s)"), true, "imported head: counts rows");
  eq(plan[0].message.includes("imported master's current file (Door43 commit e1997bc45e"), true, "imported head: names the imported commit");
  eq(/no person touched/.test(plan[0].message), false, "imported head: does not claim no person touched the rows");
  const group = { book: "2CH", resource: "tn", exportRevert: null, probablyOurs: { id: 9, message: plan[0].message } };
  const split = splitRevertRefs(["1:2", "2:intro"], group);
  eq([split.probablyOursRefs, split.exportRevertRefs, split.split], [["1:2", "2:intro"], [], "exact"], "watchdog parses the imported-head record's ref list");
  // Two rows at one Reference: the record counts rows, lists the ref once.
  const shared = planRevertReportAlerts({
    book: "2CH", resource: "tn", kind: "tsv", attention: [], probablyOurs: [sub("3:1"), sub("3:1"), sub("3:2")],
    mechanical: false, branch: "b", generation: "g9", probablyOursBasis: { kind: "imported_head", importedSha: SHA },
  });
  eq(shared[0].message.includes("on 3 row(s)") && shared[0].message.includes("hand-edit: 3:1, 3:2."), true, "shared Reference: 3 rows counted, ref listed once");
  const s2 = splitRevertRefs(["3:1", "3:2"], { book: "2CH", resource: "tn", exportRevert: null, probablyOurs: { id: 9, message: shared[0].message } });
  eq(s2.split, "exact", "watchdog split is exact for a shared Reference");
  // The lineage wording is unchanged by default.
  const lineage = planRevertReportAlerts({
    book: "EZK", resource: "ust", kind: "usfm", attention: [], probablyOurs: [sub("10:1")], mechanical: false, branch: "b", generation: "g1",
  });
  eq(/on 1 verse\(s\).*no person touched these verses/s.test(lineage[0].message), true, "lineage wording unchanged");
}

if (failed > 0) {
  console.error(`\n${failed} exportRevertImportedHead check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll exportRevertImportedHead checks passed.");

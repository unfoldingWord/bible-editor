// Issue #1231 (option B): the export-revert report partitioned by master's
// measured lineage. Nothing is dropped.
//
// The report's per-row base is our LAST push, which master may never have
// held (an export PR that never merged). Then every verse our translators
// changed between the confirmed render and that push reads as "master moved
// here". partitionRevertEntriesByLineage moves a reported USFM row into
// `probablyOurs` only when the persisted lineage proves no person touched its
// ref, and only when that lineage is complete, pinned to the same master
// commit the report diffs against, walked from the same confirmed point, and
// holds no AI commit. Anything else, and every TSV row, stays in `attention`.
// planRevertReportAlerts then builds the loud alerts from `attention` only and
// a quiet record alert for `probablyOurs`.
//
// Fixture shapes follow the EZK UST case in the issue (alert 1327,
// 2026-10-22): master = confirmed render + a hand-edit in another chapter;
// base = an unmerged later push; render = newer D1 work.
import { partitionRevertEntriesByLineage, planRevertReportAlerts, tsvRevertReport, usfmRevertReport } from "./export.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const MASTER_SHA = "05bcc1533a" + "0".repeat(30);
const OTHER_SHA = "22d88ce53d" + "0".repeat(30);
const CONFIRMED_AT = 1792476000;

// A compacted MasterLineageSummary as persisted by loadMasterLineage, with one
// human commit whose refs were mapped completely.
function summary(humanRefs, overrides = {}) {
  return {
    mayHoldHumanEdit: true,
    hasHumanCommit: true,
    incomplete: false,
    incompleteReason: "",
    counts: { ours: 1, ai: 0, human: 1 },
    humanShas: [MASTER_SHA],
    humanCommits: [{ sha: MASTER_SHA, author: "A Person", date: "2026-10-20T16:44:00Z" }],
    refsComplete: true,
    humanRefs,
    refsReason: "",
    oursPrNumbers: [4812],
    ...overrides,
  };
}
function stored(lineage, { sha = MASTER_SHA, confirmedAt = CONFIRMED_AT } = {}) {
  return { json: lineage === null ? null : JSON.stringify(lineage), sha, confirmedAt };
}
const CURRENT = { masterSha: MASTER_SHA, confirmedAt: CONFIRMED_AT };
const refs = (r) => r.entries.map((e) => e.ref);
const ids = (list) => list.map((e) => e.ref);
const P = (entries, kind, s, cur = CURRENT) => partitionRevertEntriesByLineage(entries, kind, s, cur);

// ── USFM fixtures ──────────────────────────────────────────────────────────
function usfm(v93, v101, v1415 = "a bridged verse") {
  return (
    `\\id EZK\n\\c 3\n\\p\n\\v 14-15 ${v1415}\n` +
    `\\c 9\n\\p\n\\v 3 ${v93}\n\\c 10\n\\p\n\\v 1 ${v101}\n`
  );
}

// 1. F1 (#1232's failure, the gate): our PR merged but was never confirmed;
//    a person then reverted 9:3 on master to the older wording. Their commit
//    touched 9:3, so the row must stay in `attention`.
{
  const base = usfm("the newer wording", "the cherubim"); // our merged push M
  const master = usfm("the older wording", "the cherubim"); // M + a person's revert at 9:3
  const render = usfm("the newer wording", "the cherubim"); // D1 still holds M's text
  const report = usfmRevertReport(render, master, base);
  eq(refs(report), ["9:3"], "F1 precondition: the report lists the reverted verse");
  const out = P(report.entries, "usfm", stored(summary(["9:3"])));
  eq(ids(out.attention), ["9:3"], "F1: a person's revert to older text inside the window needs attention");
  eq(ids(out.probablyOurs), [], "F1: nothing is called ours");
  eq(out.partitioned, true, "F1: the lineage was usable (the row stayed on evidence, not by fallback)");

  // Same, TSV: TSV is never partitioned, so it stays in attention anyway.
  const H = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const tBase = `${H}\n9:3\tab12\t\t\tq\t1\tnewer note\n`;
  const tMaster = `${H}\n9:3\tab12\t\t\tq\t1\tolder note\n`;
  const tRender = tBase;
  const tReport = tsvRevertReport(tRender, tMaster, "tn", tBase);
  eq(refs(tReport), ["9:3"], "F1 TSV precondition: the report lists the reverted row");
  eq(ids(P(tReport.entries, "tsv", stored(summary(["9:3"]))).attention), ["9:3"], "F1 TSV: a person's revert of a note needs attention");
}

// 2. The EZK case: translators changed 9:3 between the confirmed render and an
//    unmerged push; the only person's commit touched 10:1. The row is our own
//    work, so it is kept but labelled probablyOurs. The hand-edit verse itself
//    is not in the report (D1 already took it).
{
  const base = usfm("second wording", "the cherubim"); // unmerged push
  const master = usfm("first wording", "the cherubs"); // confirmed render + hand-edit at 10:1
  const render = usfm("third wording", "the cherubs");
  const report = usfmRevertReport(render, master, base);
  eq(refs(report), ["9:3"], "EZK precondition: the last-push base falsely reports our own verse");
  const out = P(report.entries, "usfm", stored(summary(["10:1"])));
  eq(ids(out.attention), [], "EZK: no row needs attention");
  eq(ids(out.probablyOurs), ["9:3"], "EZK: the row no person touched is kept as probablyOurs");
  eq(out.partitioned, true, "EZK: the partition ran");
  eq(out.reason, "", "EZK: no fallback reason");

  // A render that reverts the person's hand-edit at 10:1 still needs attention.
  const revertingRender = usfm("third wording", "the cherubim");
  const r2 = usfmRevertReport(revertingRender, master, base);
  eq(refs(r2), ["9:3", "10:1"], "a render that undoes the hand-edit lists both rows");
  const o2 = P(r2.entries, "usfm", stored(summary(["10:1"])));
  eq(ids(o2.attention), ["10:1"], "a render that undoes the hand-edit puts the hand-edited verse in attention");
  eq(ids(o2.probablyOurs), ["9:3"], "and our own verse in probablyOurs");

  // USFM bridge: a human ref inside a bridge keeps the bridged row in attention.
  const bMaster = usfm("x", "y", "bridged master text");
  const bRender = usfm("x", "y", "bridged render text");
  const br = usfmRevertReport(bRender, bMaster, null);
  eq(refs(br), ["3:14-15"], "bridge precondition: a bridged verse reports as 3:14-15");
  eq(ids(P(br.entries, "usfm", stored(summary(["3:15"]))).attention), ["3:14-15"], "a person's touch on the second half of a bridge needs attention");
  eq(ids(P(br.entries, "usfm", stored(summary(["3:*"]))).attention), ["3:14-15"], "a whole-chapter claim needs attention");
  const b3 = P(br.entries, "usfm", stored(summary(["4:1"])));
  eq([ids(b3.attention), ids(b3.probablyOurs)], [[], ["3:14-15"]], "a bridge no person touched is probablyOurs");
  eq(ids(P([{ ref: "not-a-ref", class: "substantive" }], "usfm", stored(summary(["6:1"]))).attention), ["not-a-ref"], "an unparseable ref needs attention");
  eq(ids(P([{ ref: "", class: "substantive" }], "usfm", stored(summary(["6:1"]))).attention), [""], "an empty ref needs attention");
}

// 3-5. Every lineage that cannot prove the window puts every row in attention.
{
  const entries = [{ ref: "9:3", class: "substantive" }, { ref: "9:4", class: "substantive" }];
  const full = ["9:3", "9:4"];
  const good = summary(["10:1"]);
  const control = P(entries, "usfm", stored(good));
  eq([ids(control.attention), ids(control.probablyOurs)], [[], full], "control: a usable lineage calls both ours");

  const cases = [
    ["stale lineage (lineage sha != master sha)", stored(good, { sha: OTHER_SHA }), CURRENT],
    ["lineage sha null", stored(good, { sha: null }), CURRENT],
    ["both shas null (null === null must not pass)", stored(good, { sha: null }), { ...CURRENT, masterSha: null }],
    ["empty lineage sha and empty master sha", stored(good, { sha: "" }), { ...CURRENT, masterSha: "" }],
    ["lineage walked from a different confirmed point", stored(good, { confirmedAt: CONFIRMED_AT - 1 }), CURRENT],
    ["both confirmed points null", stored(good, { confirmedAt: null }), { ...CURRENT, confirmedAt: null }],
    ["AI commit in the window (counts.ai > 0)", stored(summary(["10:1"], { counts: { ours: 1, ai: 1, human: 1 } })), CURRENT],
    ["counts.ai missing", stored(summary(["10:1"], { counts: { ours: 1, human: 1 } })), CURRENT],
    ["counts.ai not a number", stored(summary(["10:1"], { counts: { ours: 1, ai: "0", human: 1 } })), CURRENT],
    ["counts missing", stored(summary(["10:1"], { counts: undefined })), CURRENT],
    ["refsComplete false", stored(summary([], { refsComplete: false, refsReason: "too_many_human_commits" })), CURRENT],
    ["refsComplete absent (pre-#557 summary)", stored(summary(["10:1"], { refsComplete: undefined })), CURRENT],
    ["incomplete walk", stored(summary(["10:1"], { incomplete: true, incompleteReason: "page_cap" })), CURRENT],
    ["incomplete absent", stored(summary(["10:1"], { incomplete: undefined })), CURRENT],
    [
      "no human commit (complete, refs never measured)",
      stored(
        summary([], {
          hasHumanCommit: false,
          mayHoldHumanEdit: false,
          refsComplete: false,
          refsReason: "not_measured",
          counts: { ours: 2, ai: 0, human: 0 },
        }),
      ),
      CURRENT,
    ],
    ["contradictory flags (refsComplete but mayHoldHumanEdit false)", stored(summary(["10:1"], { mayHoldHumanEdit: false })), CURRENT],
    ["null lineage", stored(null), CURRENT],
    ["lineage JSON 'null'", { json: "null", sha: MASTER_SHA, confirmedAt: CONFIRMED_AT }, CURRENT],
    ["unparseable lineage JSON", { json: "{not json", sha: MASTER_SHA, confirmedAt: CONFIRMED_AT }, CURRENT],
    ["lineage JSON is an array", { json: "[]", sha: MASTER_SHA, confirmedAt: CONFIRMED_AT }, CURRENT],
    ["no stored lineage row at all", null, CURRENT],
    ["humanRefs holds a malformed entry", stored(summary(["10:1", "garbage"])), CURRENT],
    ["humanRefs empty despite refsComplete", stored(summary([])), CURRENT],
  ];
  for (const [label, s, cur] of cases) {
    const out = P(entries, "usfm", s, cur);
    eq(ids(out.attention), full, `all attention: ${label}`);
    eq(ids(out.probablyOurs), [], `nothing called ours: ${label}`);
    eq(out.partitioned, false, `not partitioned: ${label}`);
    eq(out.reason.length > 0, true, `a reason is logged: ${label}`);
  }
}

// 6. TSV is never partitioned (Codex F2 on #1234): a row a person edited at
//    5:2 that a later commit of ours moved to 5:3 reports under 5:3, which is
//    not in humanRefs, so it would be mislabelled ours. Even with a usable
//    lineage that names no touched verse, every TSV row needs attention.
{
  const H = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const rows = (note) =>
    `${H}\n5:1,3,8\tc001\t\t\tq\t1\t${note}\n5:2-3\tc002\t\t\tq\t1\t${note}\n` +
    `front:intro\tc003\t\t\tq\t1\t${note}\n5:intro\tc004\t\t\tq\t1\t${note}\nnot-a-ref\tc005\t\t\tq\t1\t${note}\n`;
  const report = tsvRevertReport(rows("render"), rows("master"), "tn", null);
  const all = ["5:1,3,8", "5:2-3", "front:intro", "5:intro", "not-a-ref"];
  eq(refs(report), all, "TSV precondition: every differing row is reported");
  const out = P(report.entries, "tsv", stored(summary(["6:1"])));
  eq(ids(out.attention), all, "TSV: every row needs attention even when no person touched chapter 5");
  eq(ids(out.probablyOurs), [], "TSV: nothing is called ours");
  eq(out.partitioned, false, "TSV: not partitioned");
  eq(out.reason, "tsv_not_partitioned", "TSV: the log says why");
}

// 7. Which alerts the report writes (planRevertReportAlerts).
{
  const base = { book: "EZK", resource: "ust", kind: "usfm", mechanical: true, branch: "EZK-ust-be-1", generation: "gen1" };
  const sub = (ref) => ({ ref, class: "substantive" });
  const sources = (plan) => plan.map((a) => a.source);

  // The EZK case: every row is ours. No loud alert, one quiet one.
  const ours11 = Array.from({ length: 11 }, (_, i) => sub(`10:${i + 1}`));
  const p1 = planRevertReportAlerts({ ...base, attention: [], probablyOurs: ours11 });
  eq(sources(p1), ["revert_probably_ours:EZK:ust"], "attention empty: no export_revert or mechanical_overwrite alert, one quiet alert");
  const q = p1[0];
  eq(q.severity, "info", "quiet alert is severity info");
  eq(q.eventKey, "gen1:revert_probably_ours:EZK:ust", "quiet alert event key follows the export_revert pattern");
  eq(q.message.includes("11 verse(s)"), true, "quiet alert gives the count");
  eq(
    q.message.includes("10:1, 10:2, 10:3, 10:4, 10:5, 10:6, 10:7, 10:8, 10:9, 10:10 (+1 more)"),
    true,
    "quiet alert lists the first 10 refs and +N more",
  );
  eq(q.message.includes("10:11"), false, "quiet alert stops at 10 refs");
  eq(/no person touched/.test(q.message), true, "quiet alert says no person touched these verses");

  // Mixed: the loud alerts count only attention.
  const p2 = planRevertReportAlerts({ ...base, attention: [sub("9:3")], probablyOurs: [sub("10:1"), sub("10:2")] });
  eq(
    sources(p2),
    ["export_revert:EZK:ust", "mechanical_overwrite:EZK:ust", "revert_probably_ours:EZK:ust"],
    "mixed: loud alerts plus the quiet one",
  );
  eq(p2[0].message.includes("on 1 row(s)/verse(s)"), true, "export_revert counts attention only");
  eq(p2[0].message.includes("10:1"), false, "export_revert does not list probablyOurs refs");
  eq(p2[0].severity, "warning", "export_revert stays warning");
  eq(p2[0].eventKey, "gen1:export_revert:EZK:ust", "export_revert event key unchanged");
  eq(p2[1].message.includes("1 verse changed"), true, "mechanical_overwrite counts attention only");
  eq(p2[1].message.includes("10:1"), false, "mechanical_overwrite does not list probablyOurs refs");
  eq(p2[2].message.includes("2 verse(s)"), true, "quiet alert counts probablyOurs");

  // Today's shape: everything in attention, no quiet alert; not mechanical.
  const p3 = planRevertReportAlerts({ ...base, mechanical: false, attention: [sub("9:3")], probablyOurs: [] });
  eq(sources(p3), ["export_revert:EZK:ust"], "no probablyOurs: no quiet alert");
  eq(sources(planRevertReportAlerts({ ...base, attention: [], probablyOurs: [] })), [], "nothing reported: no alerts");
}

if (failed > 0) {
  console.error(`\n${failed} exportRevertLineageFilter check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll exportRevertLineageFilter checks passed.");

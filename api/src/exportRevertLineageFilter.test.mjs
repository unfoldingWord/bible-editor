// Issue #1231: the export-revert report narrowed by master's measured lineage.
//
// The report's per-row base is our LAST push, which master may never have
// held (an export PR that never merged). Then every verse our translators
// changed between the confirmed render and that push reads as "master moved
// here". narrowRevertEntriesByLineage drops a reported row only when the
// persisted lineage proves no person touched its ref, and only when that
// lineage is complete, pinned to the same master commit the report diffs
// against, walked from the same confirmed point, and holds no AI commit.
// Anything else keeps today's full report.
//
// Fixture shapes follow the EZK UST case in the issue (alert 1327,
// 2026-10-22): master = confirmed render + a hand-edit in another chapter;
// base = an unmerged later push; render = newer D1 work.
import { narrowRevertEntriesByLineage, tsvRevertReport, usfmRevertReport } from "./export.ts";

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

// ── USFM fixtures ──────────────────────────────────────────────────────────
function usfm(v93, v101, v1415 = "a bridged verse") {
  return (
    `\\id EZK\n\\c 3\n\\p\n\\v 14-15 ${v1415}\n` +
    `\\c 9\n\\p\n\\v 3 ${v93}\n\\c 10\n\\p\n\\v 1 ${v101}\n`
  );
}

// 1. F1 (#1232's failure, the gate): our PR merged but was never confirmed;
//    a person then reverted 9:3 on master to the older wording. Their commit
//    touched 9:3, so the row must still be reported.
{
  const base = usfm("the newer wording", "the cherubim"); // our merged push M
  const master = usfm("the older wording", "the cherubim"); // M + a person's revert at 9:3
  const render = usfm("the newer wording", "the cherubim"); // D1 still holds M's text
  const report = usfmRevertReport(render, master, base);
  eq(refs(report), ["9:3"], "F1 precondition: the report lists the reverted verse");
  const out = narrowRevertEntriesByLineage(report.entries, stored(summary(["9:3"])), CURRENT);
  eq(refs(out), ["9:3"], "F1: a person's revert to older text inside the window is still reported");
  eq(out.narrowed, true, "F1: the lineage was usable (the row survived on evidence, not by fallback)");

  // Same, TSV.
  const H = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const tBase = `${H}\n9:3\tab12\t\t\tq\t1\tnewer note\n`;
  const tMaster = `${H}\n9:3\tab12\t\t\tq\t1\tolder note\n`;
  const tRender = tBase;
  const tReport = tsvRevertReport(tRender, tMaster, "tn", tBase);
  eq(refs(tReport), ["9:3"], "F1 TSV precondition: the report lists the reverted row");
  eq(
    refs(narrowRevertEntriesByLineage(tReport.entries, stored(summary(["9:3"])), CURRENT)),
    ["9:3"],
    "F1 TSV: a person's revert of a note inside the window is still reported",
  );
}

// 2. F2 / the EZK case: translators changed 9:3 between the confirmed render
//    and an unmerged push; the only person's commit touched 10:1. The row is
//    our own work, so it is dropped. The hand-edit verse itself is not in the
//    report (D1 already took it).
{
  const base = usfm("second wording", "the cherubim"); // unmerged push
  const master = usfm("first wording", "the cherubs"); // confirmed render + hand-edit at 10:1
  const render = usfm("third wording", "the cherubs");
  const report = usfmRevertReport(render, master, base);
  eq(refs(report), ["9:3"], "EZK precondition: the last-push base falsely reports our own verse");
  const out = narrowRevertEntriesByLineage(report.entries, stored(summary(["10:1"])), CURRENT);
  eq(refs(out), [], "EZK: a row no person touched is dropped");
  eq(out.narrowed, true, "EZK: narrowing fired");
  eq(out.dropped, 1, "EZK: one row dropped");

  // A render that reverts the person's hand-edit at 10:1 is still reported.
  const revertingRender = usfm("third wording", "the cherubim");
  const r2 = usfmRevertReport(revertingRender, master, base);
  eq(refs(r2), ["9:3", "10:1"], "a render that undoes the hand-edit lists both rows");
  eq(
    refs(narrowRevertEntriesByLineage(r2.entries, stored(summary(["10:1"])), CURRENT)),
    ["10:1"],
    "a render that undoes the hand-edit still reports the hand-edited verse",
  );

  // USFM bridge: a human ref inside a bridge keeps the bridged row.
  const bMaster = usfm("x", "y", "bridged master text");
  const bRender = usfm("x", "y", "bridged render text");
  const br = usfmRevertReport(bRender, bMaster, null);
  eq(refs(br), ["3:14-15"], "bridge precondition: a bridged verse reports as 3:14-15");
  eq(
    refs(narrowRevertEntriesByLineage(br.entries, stored(summary(["3:15"])), CURRENT)),
    ["3:14-15"],
    "a person's touch on the second half of a bridge keeps the bridged row",
  );
  eq(
    refs(narrowRevertEntriesByLineage(br.entries, stored(summary(["3:*"])), CURRENT)),
    ["3:14-15"],
    "a whole-chapter claim keeps the row",
  );
  eq(
    refs(narrowRevertEntriesByLineage(br.entries, stored(summary(["4:1"])), CURRENT)),
    [],
    "a bridge no person touched is dropped",
  );
}

// 3-5. Every lineage that cannot prove the window keeps the full report.
{
  const entries = [{ ref: "9:3", class: "substantive" }, { ref: "9:4", class: "substantive" }];
  const full = ["9:3", "9:4"];
  const good = summary(["10:1"]);
  eq(refs(narrowRevertEntriesByLineage(entries, stored(good), CURRENT)), [], "control: a usable lineage drops both");

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
    const out = narrowRevertEntriesByLineage(entries, s, cur);
    eq(refs(out), full, `full report: ${label}`);
    eq(out.narrowed, false, `not narrowed: ${label}`);
  }
}

// 6. TSV references: comma lists, bridges, intros, and an unparseable one.
{
  const H = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const rows = (note) =>
    `${H}\n5:1,3,8\tc001\t\t\tq\t1\t${note}\n5:2-3\tc002\t\t\tq\t1\t${note}\n` +
    `front:intro\tc003\t\t\tq\t1\t${note}\n5:intro\tc004\t\t\tq\t1\t${note}\nnot-a-ref\tc005\t\t\tq\t1\t${note}\n`;
  const report = tsvRevertReport(rows("render"), rows("master"), "tn", null);
  eq(
    refs(report),
    ["5:1,3,8", "5:2-3", "front:intro", "5:intro", "not-a-ref"],
    "TSV precondition: every differing row is reported",
  );
  eq(
    refs(narrowRevertEntriesByLineage(report.entries, stored(summary(["5:8"])), CURRENT)),
    ["5:1,3,8", "not-a-ref"],
    "a person's touch on any verse of a comma list keeps that row; an unparseable Reference stays reported",
  );
  eq(
    refs(narrowRevertEntriesByLineage(report.entries, stored(summary(["5:3"])), CURRENT)),
    ["5:1,3,8", "5:2-3", "not-a-ref"],
    "rows sharing a touched verse are all kept (comma list and bridge)",
  );
  eq(
    refs(narrowRevertEntriesByLineage(report.entries, stored(summary(["0:0", "5:0"])), CURRENT)),
    ["front:intro", "5:intro", "not-a-ref"],
    "intro rows map to verse 0, matching the lineage's own TSV mapping",
  );
  eq(
    refs(narrowRevertEntriesByLineage(report.entries, stored(summary(["6:1"])), CURRENT)),
    ["not-a-ref"],
    "only the unparseable Reference survives when no person touched chapter 5",
  );
  eq(
    refs(narrowRevertEntriesByLineage([{ ref: "", class: "substantive" }], stored(summary(["6:1"])), CURRENT)),
    [""],
    "an empty Reference stays reported",
  );
}

if (failed > 0) {
  console.error(`\n${failed} exportRevertLineageFilter check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll exportRevertLineageFilter checks passed.");

// Tests for scripts/watchdog/exportRevertCheck.mjs (issue #1233): the sync
// watchdog's proof that an export_revert alert is false. No network, no token:
// every fixture is inline. Lives under api/src so scripts/run-tests.mjs finds
// it (`cd api && npm test`). Run alone from api/:
//   node --experimental-strip-types --no-warnings src/watchdogExportRevertCheck.test.mjs

import {
  checkExportRevertAlert,
  classifyExportRevertRefs,
  fetchFileAt,
  groupRevertAlerts,
  isOurExportSubject,
  knownRenderShas,
  pickExportCommits,
  renderPinStatus,
  revertSummaryLines,
  snapshotStatus,
  splitRevertRefs,
  splitVerdict,
} from "../../scripts/watchdog/exportRevertCheck.mjs";
import { planRevertReportAlerts } from "./export.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- USFM ---------------------------------------------------------------
const usfm = (verses) =>
  `\\id EZK EN_UST\n\\usfm 3.0\n\\h Ezekiel\n\\c 9\n\\p\n` + verses.map(([v, t]) => `\\v ${v} ${t}\n`).join("");

const prevUsfm = usfm([["3", "Then the glory went up."], ["4", "Yahweh said to him."], ["5", "Go through the city."]]);
// Master after a hand-edit at 9:5 and a verse 9:6 added on master since.
const masterUsfm = usfm([
  ["3", "Then the glory went up."],
  ["4", "Yahweh said to him."],
  ["5", "Go through the whole city."],
  ["6", "Kill old men."],
]);

{
  const r = classifyExportRevertRefs(["9:3", "9:4"], prevUsfm, masterUsfm, "ust");
  assert(same(r.falseRefs, ["9:3", "9:4"]) && r.realRefs.length === 0, "usfm: master never moved at the ref -> false");
}
{
  const r = classifyExportRevertRefs(["9:5"], prevUsfm, masterUsfm, "ult");
  assert(same(r.realRefs, ["9:5"]) && r.falseRefs.length === 0, "usfm: master really moved at the ref -> real");
}
{
  const r = classifyExportRevertRefs(["9:6"], prevUsfm, masterUsfm, "ust");
  assert(same(r.realRefs, ["9:6"]), "usfm: verse absent from previous export but on master -> real, not false");
}
{
  const r = classifyExportRevertRefs(["9:9"], prevUsfm, masterUsfm, "ust");
  assert(same(r.unknownRefs, ["9:9"]), "usfm: ref not on master at all -> unknown");
}
{
  const r = classifyExportRevertRefs(["9:3", "9:3"], prevUsfm, prevUsfm, "ust");
  assert(same(r.falseRefs, ["9:3"]), "usfm: duplicate alert refs are counted once");
}

// --- TSV ----------------------------------------------------------------
const tn = (rows) =>
  ["Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote", ...rows.map((r) => r.join("\t"))].join("\n") + "\n";
const tnPrev = tn([
  ["1:1", "ab12", "", "rc://*/ta/man/translate/figs-metaphor", "word", "1", "Note A"],
  ["1:1", "cd34", "", "", "other", "1", "Note B"],
  ["1:2", "ef56", "", "", "x", "1", "Note C"],
  ["1:3", "gh78", "", "", "y", "1", "Note D"],
]);
const tnMaster = tn([
  ["1:1", "ab12", "", "rc://*/ta/man/translate/figs-metaphor", "word", "1", "Note A"],
  ["1:1", "cd34", "", "", "other", "1", "Note B"],
  // 1:2 shares its ref with a row a maintainer added on master.
  ["1:2", "ef56", "", "", "x", "1", "Note C"],
  ["1:2", "zz99", "", "", "z", "1", "Hand-added note"],
  // 1:3 hand-edited on master.
  ["1:3", "gh78", "", "", "y", "1", "Note D, fixed by hand"],
]);
{
  const r = classifyExportRevertRefs(["1:1"], tnPrev, tnMaster, "tn");
  assert(same(r.falseRefs, ["1:1"]), "tsv: two rows share the ref, both unchanged -> false");
}
{
  const r = classifyExportRevertRefs(["1:2"], tnPrev, tnMaster, "tn");
  assert(same(r.realRefs, ["1:2"]), "tsv: shared ref where master added a row -> real");
}
{
  const r = classifyExportRevertRefs(["1:3"], tnPrev, tnMaster, "tn");
  assert(same(r.realRefs, ["1:3"]), "tsv: row edited on master -> real");
}
{
  const r = classifyExportRevertRefs(["1:1"], "garbage\theader\n", tnMaster, "tn");
  assert(same(r.unknownRefs, ["1:1"]) && r.falseRefs.length === 0, "tsv: unparseable side -> unknown, never false");
}

{
  // Same ID twice on master (once at the alerted ref, once elsewhere).
  const dupMaster = tn([
    ["1:1", "ab12", "", "rc://*/ta/man/translate/figs-metaphor", "word", "1", "Note A"],
    ["1:1", "cd34", "", "", "other", "1", "Note B"],
    ["1:2", "ab12", "", "", "x", "1", "Copy with a duplicated ID"],
  ]);
  const r = classifyExportRevertRefs(["1:1", "1:2"], tnPrev, dupMaster, "tn");
  assert(same(r.unknownRefs, ["1:1", "1:2"]) && r.falseRefs.length === 0, "tsv: duplicated ID on either side -> unknown at every ref it sits at");
  const r2 = classifyExportRevertRefs(["1:1"], dupMaster, tnPrev, "tn");
  assert(same(r2.unknownRefs, ["1:1"]), "tsv: duplicated ID in the previous export -> unknown");
}

// --- snapshot tie and our-render set -----------------------------------
{
  const gen = { generation: "g7" };
  const alert = { id: 1327, eventKey: "g7:export_revert:EZK:ust", createdAtS: 1792820398 };
  const ok = { alert, book: "EZK", resource: "ust", newerAlertId: null, generation: gen, detectedAt: [1792820390, 1792820391] };
  assert(snapshotStatus(ok) === null, "snapshot: generation matches, rows just before the alert -> tied");
  assert(snapshotStatus({ ...ok, newerAlertId: 1400 }) === "superseded_snapshot", "snapshot: newer alert for the pair -> superseded_snapshot");
  assert(snapshotStatus({ ...ok, generation: { generation: "g8" } }) === "snapshot_generation_mismatch", "snapshot: other generation -> mismatch");
  assert(snapshotStatus({ ...ok, generation: null }) === "snapshot_generation_mismatch", "snapshot: no generation row -> mismatch");
  assert(snapshotStatus({ ...ok, detectedAt: [1792820390, 1792820398 + 3600] }) === "snapshot_time_mismatch", "snapshot: a row written an hour after the alert -> time mismatch");
  assert(snapshotStatus({ ...ok, detectedAt: [] }) === "no_snapshot_rows", "snapshot: no rows -> no_snapshot_rows");
  const r = checkExportRevertAlert(
    { alertId: 1, book: "EZK", resource: "ust", alertCreatedAtMs: 0, refs: ["9:3", "9:4"], snapshot: "superseded_snapshot", knownRenders: new Set() },
    "",
  );
  assert(r.status === "superseded_snapshot" && same(r.unknownRefs, ["9:3", "9:4"]) && r.falseRefs.length === 0, "check: untied snapshot -> every ref unknown, no Door43 call");
}
{
  const k = knownRenderShas({
    pushed_blob_sha: "8eff",
    prev_pushed_blob_sha: "17b7",
    unconfirmed_renders_json: JSON.stringify(["2d20", "17b7", "8eff"]),
  });
  assert(same([...k].sort(), ["17b7", "2d20", "8eff"]), "renders: union of unconfirmed_renders_json and pushed/prev_pushed blob shas");
  assert(knownRenderShas(null).size === 0, "renders: no sync row -> empty set");
}

// --- history walk -------------------------------------------------------
// Trimmed from the real Door43 history of en_ust/26-EZK.usfm (2026-10-22).
const c = (sha, created, message, parent) => ({ sha, created, commit: { message }, parents: [{ sha: parent }] });
const ezk = [
  c("0c338b57a62407422daa02d9712120cb97bd009d", "2026-10-22T05:42:33Z", "bible-editor: EZK ust → master (#4821)\n\nCo-authored-by: x", "8dd382783b37a0c30997dda05e603436d0ddfc42"),
  c("05bcc1533af6ab3c0d710e24ce2e8f47f8837d0f", "2026-10-20T16:44:54Z", "cherubim =>cherubs (#4814)", "690ff06fba3508984712f40a19a0334d1f292fed"),
  c("22d88ce53d3968440ba2d4815c411c1568e765cb", "2026-10-20T06:02:42Z", "bible-editor: EZK ust → master (#4812)", "b0c316cf978f4131667349313405ead101f5a65d"),
  c("681f34937f000000000000000000000000000000", "2026-10-18T05:40:13Z", "bible-editor: EZK ust → master (#4810)", "74dfc30418000000000000000000000000000000"),
  c("3c018b9775000000000000000000000000000000", "2026-09-26T06:10:50-04:00", "Removes space after — if not before a \\v", "617080acfb000000000000000000000000000000"),
];
const alertAt = Date.parse("2026-10-22T05:39:58Z");
{
  const p = pickExportCommits(ezk, { book: "EZK", resource: "ust", alertCreatedAtMs: alertAt });
  assert(
    p.status === "ok" &&
      p.exportSha.startsWith("0c338b57a6") &&
      p.masterSha.startsWith("8dd382783b") &&
      p.prevExportSha.startsWith("22d88ce53d"),
    "walk: export 0c338b57a6, master at its parent 8dd382783b, previous export 22d88ce53d",
  );
}
{
  // Tonight's export PR not merged yet: master's state at export time cannot be
  // pinned from dates, so the walk fails closed.
  const p = pickExportCommits(ezk.slice(1), { book: "EZK", resource: "ust", alertCreatedAtMs: alertAt });
  assert(p.status === "export_not_merged" && p.prevExportSha === undefined, "walk: unmerged export -> export_not_merged, nothing to compare");
}
{
  const bad = [ezk[0], { ...ezk[1], created: "not a date" }, ...ezk.slice(2)];
  const p = pickExportCommits(bad, { book: "EZK", resource: "ust", alertCreatedAtMs: alertAt });
  assert(p.status === "unparseable_date" && p.prevExportSha === undefined, "walk: an unparseable commit date -> unparseable_date");
}
{
  // An old-dated human commit above tonight's export makes the walk stop early;
  // that must not yield a verdict.
  const odd = [{ ...ezk[1], created: "2020-01-01T00:00:00Z" }, ezk[0], ...ezk.slice(2)];
  const p = pickExportCommits(odd, { book: "EZK", resource: "ust", alertCreatedAtMs: alertAt });
  assert(p.status !== "ok", "walk: old-dated commit ahead of the export -> no confident pick");
}
{
  const p = pickExportCommits(ezk, { book: "EZK", resource: "ult", alertCreatedAtMs: alertAt });
  assert(p.status === "export_not_merged" && p.prevExportSha === undefined, "walk: other resource's subjects never match");
}
{
  // B1: tonight's export is unmerged, but an EARLIER export merged one minute
  // before the alert, inside the clock-skew slack. The walk picks it; pinning
  // its blob to tonight's pushed render must turn every ref unknown.
  const earlier = c("e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0", "2026-10-22T05:38:58Z", "bible-editor: EZK ust → master (review requested) (#4819)", "05bcc1533af6ab3c0d710e24ce2e8f47f8837d0f");
  const p = pickExportCommits([earlier, ...ezk.slice(1)], { book: "EZK", resource: "ust", alertCreatedAtMs: alertAt });
  assert(p.status === "ok" && p.exportSha.startsWith("e0e0"), "walk: an earlier merge inside the slack is picked (the case B1 guards)");
  const known = new Set(["2d20", "17b7", "8eff"]);
  const pin = renderPinStatus({ exportBlobSha: "17b7", prevBlobSha: "2d20", pushedBlobSha: "8eff", knownRenders: known });
  assert(pin === "export_not_this_render", "pin: export commit's blob is not tonight's pushed render -> export_not_this_render (all unknown)");
}
{
  const known = new Set(["2d20", "8eff"]);
  assert(renderPinStatus({ exportBlobSha: "8eff", prevBlobSha: "2d20", pushedBlobSha: "8eff", knownRenders: known }) === null, "pin: export = pushed render, prev is ours -> verdict allowed");
  assert(renderPinStatus({ exportBlobSha: "8eff", prevBlobSha: "2d20", pushedBlobSha: null, knownRenders: known }) === "export_not_this_render", "pin: no pushed_blob_sha recorded -> export_not_this_render");
  assert(renderPinStatus({ exportBlobSha: "8eff", prevBlobSha: "aaaa", pushedBlobSha: "8eff", knownRenders: known }) === "prev_not_our_render", "pin: prev blob not one of our renders -> prev_not_our_render");
  assert(renderPinStatus({ exportBlobSha: "8eff", prevBlobSha: "8eff", pushedBlobSha: "8eff", knownRenders: known }) === "prev_is_this_render", "pin: prev blob equals the export's blob -> prev_is_this_render");
}
assert(isOurExportSubject("bible-editor: EZK ust → master (review requested) (#9)", "EZK", "ust"), "subject: review-requested variant matches");
assert(!isOurExportSubject('Revert "bible-editor: EZK ust → master (#4821)" (#4822)', "EZK", "ust"), "subject: a human revert does not match");
assert(!isOurExportSubject("bible-editor: EZKX ust → master", "EZK", "ust"), "subject: other book does not match");

// --- fetch guard (throws before any network call) -------------------------
{
  let threw = false;
  try {
    fetchFileAt("en_ust", "26-EZK.usfm", "22d88ce53d", "");
  } catch (e) {
    threw = /non-full sha/.test(String(e?.message));
  }
  assert(threw, "fetchFileAt refuses a short sha (Door43 would silently serve master)");
}

{
  let threw = false;
  try {
    fetchFileAt("en_ust", "26-EZK.usfm", "22d88ce53d3968440ba2d4815c411c1568e765cb", 'abc" -o /tmp/x');
  } catch (e) {
    threw = /DOOR43_TOKEN contains/.test(String(e?.message));
  }
  assert(threw, "a token with quotes or spaces is refused before curl runs");
}

// --- revert_probably_ours records (#1240) --------------------------------
// The alerts come from export.ts's own planRevertReportAlerts, so a change to
// either message's wording breaks these tests instead of silently breaking
// the split. `rowsOf` stands in for export_reverts, which holds every entry.
{
  const entry = (ref) => ({ ref, class: "substantive" });
  const plan = (attention, probablyOurs) =>
    planRevertReportAlerts({
      book: "EZK",
      resource: "ust",
      kind: "usfm",
      attention: attention.map(entry),
      probablyOurs: probablyOurs.map(entry),
      mechanical: false,
      branch: "live-snapshot",
      generation: "g7",
    })
      .filter((a) => !a.source.startsWith("mechanical_overwrite:"))
      .map((a, i) => ({ id: 1400 + i, source: a.source, event_key: a.eventKey, created_at: 1792820398, message: a.message }));

  // A night whose every row is probably ours: no export_revert alert at all.
  {
    const alerts = plan([], ["9:3", "9:4"]);
    assert(alerts.length === 1 && alerts[0].source === "revert_probably_ours:EZK:ust", "fixture: probably-ours-only night writes no export_revert alert");
    const groups = groupRevertAlerts(alerts);
    assert(groups.length === 1 && groups[0].exportRevert === null && groups[0].probablyOurs?.id === 1400, "group: a probably-ours-only night still yields a check");
    assert(groups[0].generation === "g7" && groups[0].newerAlertId === null, "group: generation read from the event_key");
    const s = splitRevertRefs(["9:3", "9:4"], groups[0]);
    assert(same(s.probablyOursRefs, ["9:3", "9:4"]) && s.exportRevertRefs.length === 0 && s.split === "exact", "split: probably-ours-only night -> every row is probably ours, exact");
    const snap = snapshotStatus({
      alert: groups[0].anchor,
      book: "EZK",
      resource: "ust",
      newerAlertId: null,
      generation: { generation: "g7" },
      detectedAt: [1792820390],
    });
    assert(snap === null, "snapshot: a revert_probably_ours event_key ties the snapshot too");
  }

  // Mixed night: two loud rows, two probably-ours rows, one alert each.
  {
    const alerts = plan(["9:5", "9:6"], ["9:3", "9:4"]);
    const groups = groupRevertAlerts(alerts);
    assert(groups.length === 1 && groups[0].exportRevert && groups[0].probablyOurs, "group: both alerts of one report form one group (one Door43 check)");
    const s = splitRevertRefs(["9:3", "9:4", "9:5", "9:6"], groups[0]);
    assert(
      same(s.exportRevertRefs, ["9:5", "9:6"]) && same(s.probablyOursRefs, ["9:3", "9:4"]) && s.split === "exact",
      "split: mixed night -> export_revert keeps only its own refs",
    );
    const verdict = { status: "ok", falseRefs: ["9:3", "9:5"], realRefs: ["9:4"], unknownRefs: ["9:6"] };
    const er = splitVerdict(verdict, s.exportRevertRefs);
    const po = splitVerdict(verdict, s.probablyOursRefs);
    assert(same(er.falseRefs, ["9:5"]) && same(er.unknownRefs, ["9:6"]) && er.realRefs.length === 0 && er.refs === 2, "verdict: export_revert counts only its own refs");
    assert(same(po.falseRefs, ["9:3"]) && same(po.realRefs, ["9:4"]) && po.refs === 2, "verdict: probably-ours counts only its own refs");
    const { loud, quiet } = revertSummaryLines([
      { ...er, group: "export_revert", alertId: 1400, book: "EZK", resource: "ust" },
      { ...po, group: "revert_probably_ours", alertId: 1401, book: "EZK", resource: "ust", split: s.split },
    ]);
    assert(loud.some((l) => l.includes("Alert 1400") && l.includes("UNDECIDED")), "summary: export_revert line in the loud section");
    assert(
      loud.some((l) => l.includes("1401") && l.includes("REAL") && l.includes("9:4") && /edit history missed a hand-edit/.test(l)),
      "summary: a REAL probably-ours ref is reported in the loud section",
    );
    assert(quiet.some((l) => l.includes("1401") && l.includes("probably ours: 1 confirmed ours, 0 undecided, 1 REAL")), "summary: quiet probably-ours tally");
  }

  // More probably-ours refs than the record lists: the unlisted ones fall on
  // the loud side, and the split says so.
  {
    const po = Array.from({ length: 302 }, (_, i) => `${10 + Math.floor(i / 40)}:${(i % 40) + 1}`);
    const alerts = plan(["9:5"], po);
    const s = splitRevertRefs(["9:5", ...po], groupRevertAlerts(alerts)[0]);
    assert(s.probablyOursRefs.length === 300 && s.exportRevertRefs.length === 3, "split: >300 probably ours -> the 2 unlisted are checked under export_revert");
    assert(/^inexact/.test(s.split), "split: truncated record list -> inexact");
  }

  // A lone alert owns every row: no count comparison, so no false
  // "unverified" note.
  {
    const s = splitRevertRefs(["9:3", "9:4", "9:7"], groupRevertAlerts(plan([], ["9:3", "9:4"]))[0]);
    assert(s.probablyOursRefs.length === 3 && s.split === "exact", "split: lone alert -> every row, exact without a count check");
  }

  // Mixed USFM night whose counts disagree with the snapshot: every row is
  // still checked, and the split is flagged.
  {
    const s = splitRevertRefs(["9:3", "9:4", "9:5", "9:7"], groupRevertAlerts(plan(["9:5"], ["9:3", "9:4"]))[0]);
    assert(same(s.exportRevertRefs, ["9:5", "9:7"]) && /^unverified/.test(s.split), "split: mixed usfm count mismatch -> unverified, extra rows on the loud side");
  }

  // TSV export_revert-only night (#1240 review F1): several tn rows share a
  // Reference, so the alert's row count exceeds export_reverts' unique refs.
  {
    const alerts = planRevertReportAlerts({
      book: "EZK",
      resource: "tn",
      kind: "tsv",
      attention: ["1:1", "1:1", "1:1", "1:2"].map((ref) => ({ ref, class: "substantive", fields: ["Note"] })),
      probablyOurs: [],
      mechanical: false,
      branch: "live-snapshot",
      generation: "g7",
    })
      .filter((a) => a.source.startsWith("export_revert:"))
      .map((a) => ({ id: 1600, source: a.source, event_key: a.eventKey, created_at: 1792820398, message: a.message }));
    assert(alerts.length === 1 && / on 4 row\(s\)/.test(alerts[0].message), "fixture: tsv alert counts 4 rows over 2 refs");
    const s = splitRevertRefs(["1:1", "1:2"], groupRevertAlerts(alerts)[0]);
    assert(same(s.exportRevertRefs, ["1:1", "1:2"]) && s.split === "exact", "split: tsv duplicate refs -> exact, no unverified note");
    const { loud } = revertSummaryLines([{ ...splitVerdict({ status: "ok", falseRefs: ["1:1"], realRefs: [], unknownRefs: ["1:2"] }, s.exportRevertRefs), group: "export_revert", alertId: 1600, book: "EZK", resource: "tn", split: s.split }]);
    assert(loud.length === 1 && !/unverified|Ref split/.test(loud[0]), "summary: tsv export_revert line carries no split note");
  }

  // Section wording (#1240 review F5).
  {
    const po = { status: "ok", falseRefs: ["1:1"], realRefs: [], unknownRefs: [], group: "revert_probably_ours", alertId: 1700, book: "JOL", resource: "ult" };
    const a = revertSummaryLines([po]);
    assert(a.loud[0] === "- No export_revert alerts tonight (1 probably-ours record(s) checked below)." && a.loud.length === 1, "summary: probably-ours-only night says no export_revert alerts, not 'None checked'");
    const b = revertSummaryLines([], { failed: ["revert_probably_ours"] });
    assert(same(b.loud, ["- None checked."]) && same(b.quiet, ["- A revert_probably_ours check failed, see errors."]), "summary: a failed probably-ours check is noted only in its own section");
    const c = revertSummaryLines([po], { failed: ["export_revert"] });
    assert(same(c.loud, ["- An export_revert check failed, see errors."]) && c.quiet.length === 1, "summary: a failed export_revert check is noted only in the loud section");
  }

  // A newer report for the same pair supersedes the older group.
  {
    const older = plan(["9:5"], ["9:3"]);
    const newer = plan([], ["9:3"]).map((a) => ({ ...a, id: 1500, event_key: a.event_key.replace("g7", "g8") }));
    const groups = groupRevertAlerts([...older, ...newer]);
    const g7 = groups.find((g) => g.generation === "g7");
    const g8 = groups.find((g) => g.generation === "g8");
    assert(g7.newerAlertId === 1500 && g8.newerAlertId === null, "group: an older report is superseded by a newer one of either source");
  }
}

console.log("watchdogExportRevertCheck: all passed");

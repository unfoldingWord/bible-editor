// Tests for scripts/watchdog/exportRevertCheck.mjs (issue #1233): the sync
// watchdog's proof that an export_revert alert is false. No network, no token:
// every fixture is inline. Lives under api/src so scripts/run-tests.mjs finds
// it (`cd api && npm test`). Run alone from api/:
//   node --experimental-strip-types --no-warnings src/watchdogExportRevertCheck.test.mjs

import {
  checkExportRevertAlert,
  classifyExportRevertRefs,
  fetchFileAt,
  isOurExportSubject,
  knownRenderShas,
  pickExportCommits,
  snapshotStatus,
} from "../../scripts/watchdog/exportRevertCheck.mjs";

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

console.log("watchdogExportRevertCheck: all passed");

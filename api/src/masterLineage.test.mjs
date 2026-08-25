// Regression tests for masterLineage.ts — classifying who moved Door43 master.
//
// Every fixture below is a REAL commit subject/author taken from master history
// on 2026-08-19 (en_tq/tq_AMO.tsv, en_tn/tn_JER.tsv, en_ult/26-EZK.usfm,
// en_ust/24-JER.usfm), not an invented shape. That matters here more than usual:
// this classifier's output decides whether a Door43 edit can be overwritten, so
// a fixture that merely looks plausible would lock in a guess.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/masterLineage.test.mjs

import { readFileSync } from "node:fs";
import {
  classifyMasterCommit,
  compactLineage,
  LINEAGE_EVIDENCE_CAP,
  LINEAGE_REF_CAP,
  masterMayHoldHumanEdit,
  masterMayHoldHumanEditForVerse,
  mergeRefEvidence,
  parseDiffHunksForPath,
  refsTouchedInUsfm,
  summarizeLineage,
} from "./masterLineage.ts";
import { computeVerseMerge } from "./verseMerge.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const BW = "9089+deferredreward@noreply.door43.org";
const BOT = "bot@unfoldingword.org";
const RICH = "rich.mahn@unfoldingword.org";

function kind(message, authorEmail) {
  return classifyMasterCommit({ sha: "deadbeef", message, authorEmail }).kind;
}

// ── ours ────────────────────────────────────────────────────────────────────
// The squash merge onto master, across all three resource families.
eq(kind("bible-editor: AMO tq → master (#815)", BW), "ours", "tq squash merge is ours");
eq(kind("bible-editor: JER tn → master (#7462)", BW), "ours", "tn squash merge is ours");
eq(kind("bible-editor: EZK ult → master (#6754)", BW), "ours", "ult squash merge is ours");

// The -be- BRANCH commit also appears in master's file history once the branch
// merges (real: en_ust/24-JER.usfm carries several). It is our own render too.
eq(
  kind("bible-editor export: JER ust → JER-be-Grant_Ailie (export-2026-07-24T05-30-57-846Z)", BW),
  "ours",
  "the -be- branch export commit is ours",
);

// Author is NOT the signal for ours: the DCS merge bot squashes under the PR
// author, which is a human account. Same message under a bot author is still
// ours.
eq(kind("bible-editor: AMO tq → master (#815)", BOT), "ours", "ours is decided by message, not author");

// ── the Revert trap ─────────────────────────────────────────────────────────
// REAL commit on en_ult/26-EZK.usfm, authored by a human, deliberately undoing
// one of our exports. A substring test for "bible-editor:" would classify it as
// ours and drop a human decision out of the lineage entirely.
eq(
  kind('Revert "bible-editor: EZK ult → master (#6711)" (#6716)', BW),
  "human",
  "a human Revert of our export is a HUMAN commit, not ours (prefix is anchored)",
);

// ── ai ──────────────────────────────────────────────────────────────────────
eq(kind("TQ: AMO 5 [be..s@api.bp-assistant]", BOT), "ai", "bp-assistant tq push is ai");
eq(kind("ULT: EZK 28 [de..d@api.bp-assistant]", BOT), "ai", "bp-assistant ult push is ai");
eq(kind("UST: JER 43 [Gr..e@api.bp-assistant]", BOT), "ai", "bp-assistant ust push is ai");

// The bot also pushes on a human's behalf — real: `ULT: EZK 38 [pjoakes]`, bot
// author, plain username in the bracket. The content is still machine-written,
// so the author decides, not the bracket.
eq(kind("ULT: EZK 38 [pjoakes]", BOT), "ai", "a bot push requested by a human is still ai (author decides)");

// The marker alone is enough even without the known bot address, so a future
// bot pushing under a different account is still recognized.
eq(kind("TQ: AMO 9 [xx..y@api.bp-assistant]", "someone-else@example.org"), "ai",
  "the bp-assistant marker alone classifies as ai");

// ── human ───────────────────────────────────────────────────────────────────
eq(kind("Adds '0' to Occurrence column (#458)", RICH), "human", "a maintainer edit is human");
eq(kind("Cleanup of \\s1 tags", RICH), "human", "an unprefixed maintainer commit is human");
eq(kind("Changing Qere to Ketiv in alignment (to match uhb) (#6709)", "40496+stephenwunrow@noreply.door43.org"),
  "human", "a translator's hand fix is human");
// Benjamin's own HAND commits on master are human, not ours — real examples.
eq(kind("tq AMO: converge 10 rows with Bible Editor D1 (in-app edits 2026-08-17..19 blocked from export) (#814)", BW),
  "human", "a hand commit that merely mentions Bible Editor is human");
eq(kind("Fix JER UST mangled word markers and token splits (4 \\x corruptions, 38:2 th-ey join, 50:29 spacing) (#4554)", BW),
  "human", "our own account's hand fix on master is human");

// ── fail-safe: everything unrecognized is human ─────────────────────────────
eq(kind(null, null), "human", "no message and no author -> human");
eq(kind("", ""), "human", "empty message and author -> human");
eq(kind("some future tooling nobody has written yet", "new-bot@example.org"), "human",
  "an unrecognized shape is human, never guessed as ai");
// A login is null on plenty of commits including human ones, so nothing may key
// on it; this asserts classification never consults a field we did not pass.
eq(kind("Removes all Support Reference links in notes", "richmahn@users.noreply.github.com"), "human",
  "a human commit with no Gitea login is still human");

// Only the SUBJECT is classified — a body that quotes one of our messages must
// not flip the kind.
eq(
  kind("Fixes verse and quote combos\n\nThis undoes bible-editor: EZK ult → master (#6754)", RICH),
  "human",
  "only the first line is classified; a body quoting our message does not make it ours",
);

// ── lineage summary + the fail-safe gate ────────────────────────────────────
{
  const cs = [
    classifyMasterCommit({ sha: "a", message: "bible-editor: AMO tq → master (#815)", authorEmail: BW }),
    classifyMasterCommit({ sha: "b", message: "TQ: AMO 5 [be..s@api.bp-assistant]", authorEmail: BOT }),
  ];
  const lin = summarizeLineage(cs);
  eq(lin.hasHumanCommit, false, "ours + ai only -> no human commit");
  eq(lin.incomplete, false, "a complete walk is not incomplete");
  eq(masterMayHoldHumanEdit(lin), false, "ours + ai only -> master may NOT hold a human edit");
}
{
  const cs = [
    classifyMasterCommit({ sha: "a", message: "bible-editor: AMO tq → master (#815)", authorEmail: BW }),
    classifyMasterCommit({ sha: "b", message: "Adds '0' to Occurrence column (#458)", authorEmail: RICH }),
  ];
  eq(masterMayHoldHumanEdit(summarizeLineage(cs)), true, "one human commit is enough to protect master");
}
{
  // The distinction the alert wording depends on: "we walked the range and found
  // no human" is NOT the same claim as "we could not walk the range".
  const lin = summarizeLineage([], { incomplete: true, incompleteReason: "page_cap" });
  eq(lin.hasHumanCommit, false, "an incomplete walk found no human commit...");
  eq(lin.incomplete, true, "...and says so separately");
  eq(lin.incompleteReason, "page_cap", "...naming why");
  eq(masterMayHoldHumanEdit(lin), true, "an incomplete lineage protects master exactly like a human commit");
}
{
  // An empty COMPLETE lineage is a real, useful answer: master moved with no
  // commits since the ancestor is impossible, but zero-human is not.
  eq(masterMayHoldHumanEdit(summarizeLineage([])), false, "a complete empty lineage holds no human edit");
  eq(masterMayHoldHumanEdit(null), true, "never having looked protects master");
  // `undefined`, not just `null`: the summary reaches the merge through a
  // Workflow step's serialized plan, and an instance that started before this
  // shipped replays a plan entry with no such field at all.
  eq(masterMayHoldHumanEdit(undefined), true, "an absent lineage protects master exactly like a null one");
  // A malformed object must answer protectively rather than return undefined.
  // The callers all test `=== false`, so undefined would land on master-wins
  // today — but that is the callers being careful, not this function being safe.
  eq(masterMayHoldHumanEdit({}), true, "a malformed lineage object protects master, and returns a real boolean");
  eq(masterMayHoldHumanEdit({ commits: [] }), true, "…as does one missing both decision fields");
}

console.log("\n[the compact summary that crosses a Workflow step boundary]");

{
  const cs = [
    classifyMasterCommit({ sha: "s1", message: "bible-editor: AMO tq → master (#815)", authorEmail: BW }),
    classifyMasterCommit({ sha: "s2", message: "TQ: AMO 5 [be..s@api.bp-assistant]", authorEmail: BOT }),
    classifyMasterCommit({ sha: "s3", message: "Adds '0' to Occurrence column (#458)", authorEmail: RICH }),
  ];
  const s = compactLineage(summarizeLineage(cs));
  eq(s.counts.ours, 1, "summary counts our export commits");
  eq(s.counts.ai, 1, "summary counts AI pushes");
  eq(s.counts.human, 1, "summary counts human commits");
  eq(s.hasHumanCommit, true, "summary carries hasHumanCommit");
  eq(s.mayHoldHumanEdit, true, "summary answers the merge's question directly");
  eq(JSON.stringify(s.humanShas), JSON.stringify(["s3"]), "summary names the human commit as evidence");
  eq(masterMayHoldHumanEdit(s), true, "the helper reads a summary as it reads a lineage");
}

{
  // The decision-changing shape, and the one thing the summary must never get
  // wrong: this is the only answer that lets D1 win a conflict.
  const cs = [
    classifyMasterCommit({ sha: "s1", message: "bible-editor: AMO tq → master (#815)", authorEmail: BW }),
    classifyMasterCommit({ sha: "s2", message: "TQ: AMO 5 [be..s@api.bp-assistant]", authorEmail: BOT }),
  ];
  const s = compactLineage(summarizeLineage(cs));
  eq(s.mayHoldHumanEdit, false, "ours + ai only -> the summary says master may not hold a human edit");
  eq(masterMayHoldHumanEdit(s), false, "and the helper agrees, reading the summary");
  eq(JSON.stringify(s.humanShas), JSON.stringify([]), "no human shas to cite");
}

{
  // Compaction must not launder an incomplete walk into a clean "no human".
  // This is the whole fail-safe, and it has to survive a JSON round trip.
  const lin = summarizeLineage(
    [classifyMasterCommit({ sha: "s1", message: "TQ: AMO 5 [be..s@api.bp-assistant]", authorEmail: BOT })],
    { incomplete: true, incompleteReason: "source_sha_not_in_history" },
  );
  const s = compactLineage(lin);
  eq(s.hasHumanCommit, false, "incomplete summary still reports no human commit found");
  eq(s.incomplete, true, "...and reports that the walk was incomplete");
  eq(s.incompleteReason, "source_sha_not_in_history", "...naming why, for the alert");
  eq(s.mayHoldHumanEdit, true, "...and protects master anyway");
  const revived = JSON.parse(JSON.stringify(s));
  eq(masterMayHoldHumanEdit(revived), true, "the answer survives serialization through a Workflow step");
}

{
  // The evidence list is capped; the counts are not.
  const many = Array.from({ length: 9 }, (_, i) =>
    classifyMasterCommit({ sha: `h${i}`, message: `a hand fix ${i}`, authorEmail: RICH }),
  );
  const s = compactLineage(summarizeLineage(many));
  eq(s.counts.human, 9, "every human commit is counted");
  eq(s.humanShas.length, LINEAGE_EVIDENCE_CAP, "the cited shas are capped");
}

// ── #557: WHICH VERSE did the human touch? ──────────────────────────────────
//
// THE FIXTURES ARE REAL, and they have to be: this decides whether one
// maintainer's marker cleanup can authorize reverting somebody else's app edit
// in a chapter they never opened.
//
//   api/src/fixtures/jer-ult-127cc1f3.diff   `Fixes s5 markers`, richmahn,
//   api/src/fixtures/jer-ult-82aad43b.diff   `Fixes USFM`, richmahn,
//                                            both 2026-08-13, unfoldingWord/en_ult
//
// are the commits' own unified diffs, byte-for-byte as git.door43.org served
// them on 2026-08-24 — multi-book, exactly as pushed (82aad43b also touches
// 04-NUM and 33-MIC, which is why the path filter is not an optimization).
//
//   api/src/fixtures/jer-ult-*.markers.txt
//
// is 24-JER.usfm AS IT STOOD AT THAT COMMIT, reduced to the only thing the
// hunk -> verse mapping reads: the real line NUMBER and the real line TEXT of
// every line carrying a \c or \v marker, plus the file's real line count. The
// full revisions are 4.6 MB each and cannot live in the repo; the reduction was
// verified against them — `refsTouchedInUsfm` returns an identical ref set for
// the real file and for the stand-in rebuilt below (2026-08-24).
//
// Both files are produced by `scripts/extract-usfm-markers.mjs` (the exact
// commands are in its header), so the reduction is re-derivable rather than a
// one-time transformation nobody can reproduce.
//
// The measured facts these commits carry: their hunks land ONLY in chapters 23
// and 31. On 2026-08-13T20:19Z the reimport nevertheless recorded
// adopt_conflict / both_changed for JER ULT 40:5, 40:6 and 40:10, overwriting
// Grant_Ailie's app edits, because the lineage question was asked of the FILE.
console.log("\n[#557: the hunk -> verse map, from the two real richmahn commits]");

const JER_PATH = "24-JER.usfm";
const FIXTURE_FILLER = '\\w word|x-occurrence="1" x-occurrences="1"\\w*';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

// Rebuild the stand-in for one revision: a file of the revision's real line
// count, carrying the revision's real marker lines at their real line numbers.
function loadRevision(name) {
  const markers = [];
  let totalLines = 0;
  for (const line of fixture(`${name}.markers.txt`).split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    const key = line.slice(0, tab);
    const val = line.slice(tab + 1);
    if (key === "lines") {
      totalLines = Number(val);
      continue;
    }
    markers.push({ line: Number(key), head: val });
  }
  const lines = new Array(totalLines).fill(FIXTURE_FILLER);
  for (const m of markers) lines[m.line - 1] = m.head;
  return { text: lines.join("\n"), markers, totalLines };
}

// The marker index also tells us where a given ref really lives in that
// revision — used below to build the "the human DID touch chapter 40" sibling
// case out of the same real file rather than an invented one.
function markerLineOf(markers, wanted) {
  let chapter = 0;
  for (let i = 0; i < markers.length; i++) {
    const head = markers[i].head;
    const c = /\\c (\d+)/.exec(head);
    if (c) chapter = Number(c[1]);
    const v = /\\v (\d+)/.exec(head);
    const ref = c && !v ? `${chapter}:c` : v ? `${chapter}:${Number(v[1])}` : null;
    if (ref === wanted) {
      const next = markers[i + 1]?.line ?? markers[i].line + 1;
      return { start: markers[i].line, count: Math.max(1, next - markers[i].line) };
    }
  }
  return null;
}

const RICH_COMMITS = [
  { name: "jer-ult-127cc1f3", sha: "127cc1f3696994d967fc25fdd28a3a55d111132e", subject: "Fixes s5 markers", chapter: 23, hunks: 15 },
  { name: "jer-ult-82aad43b", sha: "82aad43b84ab35ce7139c2e5e47fea0cd5ef41fb", subject: "Fixes USFM", chapter: 31, hunks: 2 },
];

const richEvidence = [];
for (const c of RICH_COMMITS) {
  const parsed = parseDiffHunksForPath(fixture(`${c.name}.diff`), JER_PATH);
  eq(parsed.complete, true, `${c.subject}: its diff parses for ${JER_PATH}`);
  eq(parsed.hunks.length, c.hunks, `${c.subject}: ${c.hunks} hunks touch ${JER_PATH}`);
  const rev = loadRevision(c.name);
  const ev = refsTouchedInUsfm(rev.text, parsed.hunks);
  eq(ev.complete, true, `${c.subject}: every hunk mapped to a verse`);
  const chapters = [...new Set(ev.refs.map((r) => Number(r.split(":")[0])))];
  eq(JSON.stringify(chapters), JSON.stringify([c.chapter]), `${c.subject}: lands only in chapter ${c.chapter}`);
  richEvidence.push(ev);
}

// The path filter is load-bearing, not tidiness: `Fixes USFM` also rewrote
// 04-NUM.usfm and 33-MIC.usfm, and NUM's line numbers mapped onto JER's file
// would place a human edit in verses nobody touched.
{
  const num = parseDiffHunksForPath(fixture("jer-ult-82aad43b.diff"), "04-NUM.usfm");
  eq(num.complete, true, "the same commit's NUM hunks parse too");
  eq(num.hunks.length, 10, "...and are a different set of 10 hunks");
  eq(
    parseDiffHunksForPath(fixture("jer-ult-127cc1f3.diff"), "04-NUM.usfm").complete,
    false,
    "a path the commit never touched is NOT silently 'no hunks, nothing touched'",
  );
  eq(
    parseDiffHunksForPath(fixture("jer-ult-127cc1f3.diff"), "04-NUM.usfm").reason,
    "path_not_in_diff",
    "...it is incomplete, and says why",
  );
}

const richRefs = mergeRefEvidence(richEvidence);
eq(richRefs.complete, true, "both commits mapped -> the window's evidence is complete");
eq(richRefs.refs.includes("23:5"), true, "the window touched JER 23:5");
eq(richRefs.refs.includes("31:19"), true, "the window touched JER 31:19");
eq(richRefs.refs.includes("40:5"), false, "the window did NOT touch JER 40:5");
eq(richRefs.refs.includes("40:*"), false, "...nor chapter 40 as a whole");

console.log("\n[#557: the merge decision, per verse]");

// The real window: our own exports and a bp-assistant push around Rich's two
// hand commits (subjects and authors from en_ult/24-JER.usfm's history).
const RICH_WINDOW = summarizeLineage(
  [
    classifyMasterCommit({ sha: "5080d90444", message: "bible-editor: JER ult → master (#6706)", authorEmail: BW }),
    classifyMasterCommit({ sha: RICH_COMMITS[1].sha, message: "Fixes USFM", authorEmail: RICH }),
    classifyMasterCommit({ sha: RICH_COMMITS[0].sha, message: "Fixes s5 markers", authorEmail: RICH }),
    classifyMasterCommit({ sha: "27bf9236aa", message: "bible-editor: JER ult → master (#6701)", authorEmail: BW }),
  ],
  { humanRefs: richRefs },
);
const RICH_SUMMARY = JSON.parse(JSON.stringify(compactLineage(RICH_WINDOW)));

eq(RICH_SUMMARY.counts.human, 2, "the window holds Rich's two hand commits");
eq(RICH_SUMMARY.mayHoldHumanEdit, true, "the FILE-level answer is unchanged: a human did move this file");
eq(RICH_SUMMARY.refsComplete, true, "...and the per-verse map is complete");
eq(RICH_SUMMARY.humanRefs.length, 32, "...naming the 32 verse refs those commits landed in");

// The decision the issue exists for.
eq(masterMayHoldHumanEditForVerse(RICH_SUMMARY, 40, 5), false, "no human touched JER 40:5");
eq(masterMayHoldHumanEditForVerse(RICH_SUMMARY, 40, 6), false, "no human touched JER 40:6");
eq(masterMayHoldHumanEditForVerse(RICH_SUMMARY, 40, 10), false, "no human touched JER 40:10");
eq(masterMayHoldHumanEditForVerse(RICH_SUMMARY, 23, 5), true, "a human DID touch JER 23:5");
eq(masterMayHoldHumanEditForVerse(RICH_SUMMARY, 31, 19), true, "a human DID touch JER 31:19");

{
  // End to end, through the merge itself: the three verses that were actually
  // overwritten on 2026-08-13.
  const base = JSON.stringify({ verseObjects: [{ type: "text", text: "the ancestor we last published" }] });
  const ours = JSON.stringify({ verseObjects: [{ type: "text", text: "Grant_Ailie's app edit" }] });
  const theirs = JSON.stringify({ verseObjects: [{ type: "text", text: "the AI run sitting on master" }] });
  for (const verse of [5, 6, 10]) {
    const r = computeVerseMerge({
      base,
      ours,
      theirs,
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(RICH_SUMMARY, 40, verse),
    });
    eq(r.action, "keep_ai_master", `JER 40:${verse} both-changed -> keep_ai_master, not a revert`);
  }
  // Same window, same run, a verse Rich DID touch: master still wins there.
  eq(
    computeVerseMerge({
      base,
      ours,
      theirs,
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(RICH_SUMMARY, 23, 5),
    }).action,
    "adopt_conflict",
    "JER 23:5 both-changed -> adopt_conflict: master holds a real hand edit there",
  );
}

{
  // The sibling case the issue names: a human commit that DOES land in chapter
  // 40. Built from the same real revision — the hunk is the real line range of
  // JER 40:5 in 24-JER.usfm at 82aad43b, so the mapping runs over real markers.
  const rev = loadRevision("jer-ult-82aad43b");
  const at = markerLineOf(rev.markers, "40:5");
  eq(at !== null, true, "the real revision has a 40:5 marker to aim at");
  const ev = refsTouchedInUsfm(rev.text, [{ newStart: at.start, newCount: at.count }]);
  eq(ev.complete, true, "a chapter-40 hunk maps");
  eq(ev.refs.includes("40:5"), true, "...to 40:5");
  const summary = JSON.parse(
    JSON.stringify(
      compactLineage(
        summarizeLineage([classifyMasterCommit({ sha: RICH_COMMITS[1].sha, message: "Fixes USFM", authorEmail: RICH })], {
          humanRefs: ev,
        }),
      ),
    ),
  );
  eq(masterMayHoldHumanEditForVerse(summary, 40, 5), true, "a human DID touch 40:5 in this window");
  const base = JSON.stringify({ verseObjects: [{ type: "text", text: "the ancestor" }] });
  eq(
    computeVerseMerge({
      base,
      ours: JSON.stringify({ verseObjects: [{ type: "text", text: "our app edit" }] }),
      theirs: JSON.stringify({ verseObjects: [{ type: "text", text: "the maintainer's fix" }] }),
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(summary, 40, 5),
    }).action,
    "adopt_conflict",
    "a human edit IN chapter 40 still wins the both-changed conflict there",
  );
}

{
  // Chapter front matter (a hunk on the \c line itself, before the chapter's
  // first \v) claims the WHOLE chapter: which verse a \c / \s1 / \p change
  // affects is not decidable from line position, so it protects all of them.
  const rev = loadRevision("jer-ult-82aad43b");
  const at = markerLineOf(rev.markers, "40:c");
  eq(at !== null, true, "the real revision has a \\c 40 line to aim at");
  const ev = refsTouchedInUsfm(rev.text, [{ newStart: at.start, newCount: 1 }]);
  eq(ev.refs.includes("40:*"), true, "a chapter-front hunk claims the chapter, not a verse");
  const summary = compactLineage(
    summarizeLineage([classifyMasterCommit({ sha: "h1", message: "Fixes headings", authorEmail: RICH })], {
      humanRefs: ev,
    }),
  );
  eq(masterMayHoldHumanEditForVerse(summary, 40, 5), true, "...so every verse of chapter 40 stays protected");
  eq(masterMayHoldHumanEditForVerse(summary, 41, 5), false, "...and only that chapter");
}

console.log("\n[#557: every uncertainty resolves to the file-level answer]");

{
  const rev = loadRevision("jer-ult-127cc1f3");
  // A diff whose file header never arrives (a truncated body, a fetch that
  // returned the tail): hunks with no file to belong to.
  const truncated = fixture("jer-ult-127cc1f3.diff").split("\n").slice(6).join("\n");
  eq(parseDiffHunksForPath(truncated, JER_PATH).complete, false, "a diff with no file header is incomplete");
  eq(parseDiffHunksForPath("", JER_PATH).reason, "empty_diff", "an empty diff is incomplete, not 'nothing touched'");
  eq(
    parseDiffHunksForPath(`diff --git a/${JER_PATH} b/${JER_PATH}\n@@ what even is this @@\n`, JER_PATH).reason,
    "unparseable_hunk_header",
    "a hunk header we cannot read is incomplete",
  );
  eq(
    parseDiffHunksForPath(`diff --git a/${JER_PATH} b/${JER_PATH}\nBinary files differ\n`, JER_PATH).reason,
    "binary_patch",
    "a binary patch is incomplete",
  );
  eq(
    parseDiffHunksForPath(`diff --git a/old.usfm b/${JER_PATH}\n@@ -1,2 +1,2 @@\n`, JER_PATH).reason,
    "renamed_file",
    "a rename is incomplete — the line numbers are against a different history",
  );
  // The mismatched-revision guard: real hunks against a file that is not the
  // one they were computed from. This is what catches an abbreviated sha
  // resolving to master's tip (measured: the raw endpoint does exactly that).
  eq(
    refsTouchedInUsfm("\\c 1\n\\v 1 short file\n", parseDiffHunksForPath(fixture("jer-ult-127cc1f3.diff"), JER_PATH).hunks)
      .reason,
    "hunk_past_end_of_file",
    "hunks that run past the end of the file are incomplete, never mapped to what is there",
  );
  eq(refsTouchedInUsfm("", [{ newStart: 1, newCount: 1 }]).reason, "empty_file", "an empty file is incomplete");
  eq(
    refsTouchedInUsfm(rev.text, [{ newStart: 1, newCount: 3 }]).reason,
    "before_first_chapter",
    "a hunk in the file header, before any \\c, is incomplete — it belongs to no verse",
  );
  eq(
    refsTouchedInUsfm(rev.text, [{ newStart: 1, newCount: rev.totalLines }]).complete,
    false,
    "a whole-file rewrite does not narrow anything",
  );
  // ── A TRUNCATED DIFF: the shape transport cannot catch ────────────────────
  // Door43 serves `.diff` chunked with NO Content-Length (measured 2026-08-24),
  // so a short read arrives looking like a valid, smaller diff. Left unchecked
  // it maps to a SMALLER ref set — and a ref that goes missing is exactly what
  // lets D1 overwrite a maintainer's edit. Each hunk header declares how many
  // lines follow it, so a body cut short is provable from the content alone.
  {
    const full = fixture("jer-ult-82aad43b.diff");
    const diffLines = full.split("\n");
    // Three lines into the LAST JER hunk's body (its header is fixture line
    // 119, 1-based) — where a dropped chunk would land.
    const truncated = parseDiffHunksForPath(diffLines.slice(0, 122).join("\n"), JER_PATH);
    eq(truncated.complete, false, "a diff cut mid-hunk-body is incomplete");
    eq(truncated.reason, "hunk_body_short", "...named as a short body, not a generic parse failure");
    eq(truncated.hunks.length, 0, "...and yields NO hunks, so nothing can map an under-claimed ref set");
    // The under-claim it prevents, concretely: the surviving hunk covers
    // 31:10-11 and the cut one covers 31:18-19, so accepting the short body
    // would have answered "no human touched 31:19" — which is false.
    const whole = refsTouchedInUsfm(
      loadRevision("jer-ult-82aad43b").text,
      parseDiffHunksForPath(full, JER_PATH).hunks,
    );
    eq(whole.refs.includes("31:19"), true, "the WHOLE diff claims 31:19 — the ref a truncated read would drop");

    // The residual, stated rather than hidden: a cut landing exactly ON a hunk
    // boundary is a well-formed smaller diff and is not detectable this way. It
    // is caught only when it removes our path's section entirely.
    eq(
      parseDiffHunksForPath(diffLines.slice(0, 118).join("\n"), JER_PATH).complete,
      true,
      "a cut landing exactly on a hunk boundary still parses (the known residual)",
    );
    eq(
      parseDiffHunksForPath(diffLines.slice(0, 100).join("\n"), JER_PATH).complete,
      false,
      "...while a cut before our path's section is caught",
    );

    // The count is a real count, not a shape check: wrong on either side fails.
    const d = (hdr, body) => parseDiffHunksForPath(`diff --git a/${JER_PATH} b/${JER_PATH}\n${hdr}\n${body}`, JER_PATH);
    eq(d("@@ -1,3 +1,3 @@", " ctx\n").reason, "hunk_body_short", "a body shorter than its header claims is rejected");
    eq(d("@@ -1 +1 @@", " ctx\n ctx\n").reason, "hunk_body_short", "...and one longer than it claims");
    eq(d("@@ -1,2 +1,2 @@", " ctx\n-a\n+b\n").complete, true, "a body matching BOTH sides of its header is complete");
    eq(d("@@ -1,2 +1,1 @@", " ctx\n-a\n+b\n").reason, "hunk_body_short", "...and the OLD side is counted too");
    eq(
      d("@@ -1,2 +1,2 @@", " ctx\n-a\n+b\n\\ No newline at end of file\n").complete,
      true,
      "git's no-newline marker is a note, not a line, and is not counted",
    );
  }

  eq(mergeRefEvidence([]).complete, false, "no evidence at all is incomplete");
  eq(
    mergeRefEvidence([richEvidence[0], { complete: false, refs: [], reason: "diff_fetch_failed" }]).complete,
    false,
    "one unmapped commit makes the whole window incomplete — the mapped refs are not the whole set",
  );
  eq(
    mergeRefEvidence([richEvidence[0], { complete: false, refs: [], reason: "diff_fetch_failed" }]).reason,
    "diff_fetch_failed",
    "...and the reason survives for the log",
  );
}

{
  // The gate itself. Every one of these must answer the file-level question,
  // which for a window holding a human commit is `true` — master wins.
  const human = [classifyMasterCommit({ sha: "h1", message: "Fixes s5 markers", authorEmail: RICH })];
  const good = { complete: true, refs: ["23:5"], reason: "" };

  eq(
    masterMayHoldHumanEditForVerse(compactLineage(summarizeLineage(human)), 40, 5),
    true,
    "no per-verse evidence at all -> the file-level answer (today's behavior)",
  );
  eq(
    masterMayHoldHumanEditForVerse(
      compactLineage(summarizeLineage(human, { humanRefs: { complete: false, refs: ["23:5"], reason: "ref_cap_exceeded" } })),
      40,
      5,
    ),
    true,
    "INCOMPLETE evidence never narrows, even when it carries refs",
  );
  eq(
    compactLineage(summarizeLineage(human, { humanRefs: { complete: false, refs: ["23:5"], reason: "x" } })).humanRefs.length,
    0,
    "...and incomplete refs do not even cross the step boundary",
  );
  eq(
    masterMayHoldHumanEditForVerse(
      compactLineage(summarizeLineage(human, { humanRefs: good, incomplete: true, incompleteReason: "page_cap" })),
      40,
      5,
    ),
    true,
    "an incomplete COMMIT walk is not narrowed by a complete ref map — we never saw the whole window",
  );
  eq(
    masterMayHoldHumanEditForVerse(compactLineage(summarizeLineage(human, { humanRefs: { complete: true, refs: [], reason: "" } })), 40, 5),
    true,
    "human commits that mapped to zero refs are not believed",
  );
  eq(masterMayHoldHumanEditForVerse(null, 40, 5), true, "never having looked protects master");
  eq(masterMayHoldHumanEditForVerse(undefined, 40, 5), true, "an absent lineage protects master");
  eq(masterMayHoldHumanEditForVerse({}, 40, 5), true, "a malformed lineage object protects master");
  eq(
    masterMayHoldHumanEditForVerse({ mayHoldHumanEdit: true, refsComplete: true, humanRefs: ["23:5"] }, 40, 5),
    true,
    "a partially-deserialized summary with no `incomplete` field protects master",
  );
  // A ref set is DATA that came back through JSON and out of a D1 text column,
  // so its entries are validated, not trusted. A malformed entry fails every
  // `includes` test silently — the non-protective direction — so one bad entry
  // discards the whole set.
  {
    const withRefs = (refs) => ({
      mayHoldHumanEdit: true,
      hasHumanCommit: true,
      incomplete: false,
      refsComplete: true,
      humanRefs: refs,
    });
    eq(masterMayHoldHumanEditForVerse(withRefs([null, 42]), 40, 5), true, "refs that are not strings protect master");
    eq(masterMayHoldHumanEditForVerse(withRefs(["23:5", "nonsense"]), 40, 5), true, "one malformed ref discards the set");
    eq(masterMayHoldHumanEditForVerse(withRefs(["23:5", "23:"]), 40, 5), true, "...including a half-written one");
    eq(masterMayHoldHumanEditForVerse(withRefs("23:5"), 40, 5), true, "a refs field that is not an array protects master");
    eq(masterMayHoldHumanEditForVerse(withRefs(["23:5", "31:*"]), 40, 5), false, "a well-formed set still narrows");
  }

  // A BRIDGED row (`\v 14-15` — one D1 row covering two verses) must be asked
  // about its whole range: the human's hunk may have landed in the second half.
  {
    const bridge = compactLineage(
      summarizeLineage(human, { humanRefs: { complete: true, refs: ["40:15"], reason: "" } }),
    );
    eq(masterMayHoldHumanEditForVerse(bridge, 40, 14), false, "verse 14 alone is untouched");
    eq(masterMayHoldHumanEditForVerse(bridge, 40, 14, 15), true, "...but the row bridging 14-15 IS protected");
    eq(masterMayHoldHumanEditForVerse(bridge, 40, 14, null), false, "a null verseEnd is 'not a bridge', not 'unknown'");
    eq(masterMayHoldHumanEditForVerse(bridge, 40, 14, 13), true, "a backwards bridge protects master");
    eq(masterMayHoldHumanEditForVerse(bridge, 40, 14, 9999), true, "an absurd bridge width protects master");
    eq(masterMayHoldHumanEditForVerse(bridge, 40, 14, Number.NaN), true, "a nonsense verseEnd protects master");
  }

  eq(
    masterMayHoldHumanEditForVerse(RICH_SUMMARY, Number.NaN, 5),
    true,
    "a nonsense chapter protects master",
  );
  eq(masterMayHoldHumanEditForVerse(RICH_SUMMARY, 40, -1), true, "a nonsense verse protects master");
  // The one direction narrowing may NOT change: a window with no human commit
  // at all already answers false, and per-verse evidence cannot make it true.
  const aiOnly = compactLineage(
    summarizeLineage([classifyMasterCommit({ sha: "s2", message: "ULT: JER 40 [Gr..e@api.bp-assistant]", authorEmail: BOT })]),
  );
  eq(masterMayHoldHumanEditForVerse(aiOnly, 40, 5), false, "an AI-only window still answers false everywhere");
  eq(masterMayHoldHumanEditForVerse(aiOnly, 23, 5), false, "...including in the chapters a human touched in OTHER windows");
}

{
  // The cap is a degradation to the file-level answer, never a truncated set:
  // dropping refs off the end would silently un-protect the verses that fell off.
  const refs = Array.from({ length: LINEAGE_REF_CAP + 1 }, (_, i) => `1:${i + 1}`);
  eq(mergeRefEvidence([{ complete: true, refs, reason: "" }]).complete, false, "a ref set past the cap is incomplete");
  eq(mergeRefEvidence([{ complete: true, refs, reason: "" }]).reason, "ref_cap_exceeded", "...and says why");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall masterLineage assertions passed");

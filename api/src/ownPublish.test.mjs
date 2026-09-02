// Smoke test for ownPublish.ts — recognizing "master moved because OUR export
// merged" instead of mistaking it for a foreign edit.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/ownPublish.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors verseMerge.test.mjs /
// reimportSyncGate.test.mjs.
//
// REGRESSION UNDER TEST (prod forensics, 2026-08-14 — the AMOS revert). The
// nightly Door43->D1 sync's three-way merge recovers its ancestor as of
// book_resource_syncs.master_confirmed_at, and that watermark is stamped ONLY
// when an export's render was ALREADY byte-identical to master (export.ts's
// isMasterConfirmed / commitToDcs's `branchTouched:false` pre-check). So on any
// night the export actually PUSHES a `-be-` branch which later merges, master
// moves and the watermark does not — and the next sync reads `theirs != base`,
// a condition meant to detect a FOREIGN commit, for our own merged export.
// Every verse edited in the app since then falls to computeVerseMerge step 6
// (`adopt_conflict`: master wins) and the translator's work is overwritten.
// AMO ch2 edits from 2026-08-13 were reverted at 2026-08-14 01:07 UTC exactly
// this way; 168 adopt_conflicts landed across the fleet in two days.
//
// The AMOS-timeline block below runs that timeline twice against the REAL
// computeVerseMerge: once with the pre-fix state (no recorded publish), where
// it asserts the `adopt_conflict` data loss actually reproduces, and once with
// the fix's recorded publish, where it asserts the app edit is kept and the
// watermark advances. Asserting the OLD outcome is the point — a regression
// test that only checks the new behavior can't tell you it was ever broken.

import { findOurMergeForPr, gitBlobSha, judgeOwnPublishDecline, recognizeOwnPublish } from "./ownPublish.ts";
import { computeVerseMerge } from "./verseMerge.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── gitBlobSha: must agree with git itself ──────────────────────────────────
// Expected values are NOT self-generated: each is the output of
// `git hash-object <file>` on a file containing exactly the string on the left
// (run 2026-08-14, git for Windows). That independence is the whole value of
// this block — it proves our locally computed hash is the same object id git
// and Gitea use, so the sha stored at export time can be compared against
// master's bytes (and diagnosed in prod with one shell command) rather than
// being a private convention that only happens to be self-consistent.
console.log("\n-- gitBlobSha vs `git hash-object` --");

eq(
  await gitBlobSha(""),
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "empty string -> git's well-known empty-blob id",
);
eq(
  await gitBlobSha("hello\n"),
  "ce013625030ba8dba906f756967f9e9ca394464a",
  "'hello\\n' -> git's well-known blob id",
);
eq(
  await gitBlobSha("\\v 16 And he who is swift of foot shall not escape;\n"),
  "056f8b79fb86e1dde1c5e9370aedefeb0212d86c",
  "a USFM verse line (52 bytes) matches git hash-object",
);
// Multi-byte UTF-8 is the case a naive `content.length` header would get wrong:
// this string is 14 JS chars but 28 UTF-8 bytes, and git's blob header counts
// BYTES. Every file this fix hashes is UTF-8 USFM/TSV with Hebrew and Greek in
// the alignment attributes, so getting this wrong would make recognition never
// fire on precisely the resources that matter.
eq(
  await gitBlobSha("שָׁלוֹם עוֹלָם\n"),
  "d92ed570c21698207033e715068fc7800f3359a0",
  "multi-byte Hebrew (14 chars / 28 bytes) matches git hash-object — byte length, not char length",
);
eq(
  (await gitBlobSha("abc")) === (await gitBlobSha("abd")),
  false,
  "a one-character difference changes the hash (it is a content identity, not a length check)",
);

// ── recognizeOwnPublish: the decision table ─────────────────────────────────
console.log("\n-- recognizeOwnPublish --");

const SHA_OURS = "1111111111111111111111111111111111111111";
const SHA_THEIRS = "2222222222222222222222222222222222222222";
const READ_AT = 1_754_000_000;

const matched = recognizeOwnPublish({
  masterBlobSha: SHA_OURS,
  pushedBlobSha: SHA_OURS,
  pushedReadAt: READ_AT,
});
eq(matched.recognized, true, "master's bytes == the render we pushed -> recognized as our own publish");
eq(matched.readAt, READ_AT, "recognized -> hands back the render's D1-READ time to stamp as the watermark");
eq(matched.reason, "own_publish", "recognized -> reason own_publish");

const differs = recognizeOwnPublish({
  masterBlobSha: SHA_THEIRS,
  pushedBlobSha: SHA_OURS,
  pushedReadAt: READ_AT,
});
eq(differs.recognized, false, "master's bytes differ (foreign commit, or our branch hasn't merged) -> decline");
eq(differs.reason, "content_differs", "decline reason names the mismatch");
eq(differs.readAt, null, "a decline never offers a timestamp to stamp");

// Warm-up: migration 0048 does not backfill, so every (book, resource) starts
// with no recorded render. Must be inert — never read "not yet measured" as
// "converged" (the standing "absent measurement is not evidence" rule).
const warmUp = recognizeOwnPublish({
  masterBlobSha: SHA_OURS,
  pushedBlobSha: null,
  pushedReadAt: null,
});
eq(warmUp.recognized, false, "no recorded publish yet (0048 does not backfill) -> inert, not converged");
eq(warmUp.reason, "no_pushed_render", "warm-up decline is named distinctly from a byte mismatch");

// Master unreadable/unhashable. Fail-safe: decline, never assume. Reachable in
// production because the callers hash via gitBlobShaOrNull, which turns a hashing
// failure into this null rather than throwing out of a retried Workflow step.
const unknown = recognizeOwnPublish({
  masterBlobSha: null,
  pushedBlobSha: SHA_OURS,
  pushedReadAt: READ_AT,
});
eq(unknown.recognized, false, "master's bytes unhashable -> decline (absent measurement is not evidence)");
eq(unknown.reason, "master_blob_unknown", "unhashable master decline is named distinctly");

// Half-written row: bytes match but no read time. Inventing `Date.now()` here
// would be strictly WORSE than the status quo — it would date the ancestor
// cutoff after app edits master never received, i.e. cause the very data loss
// this module exists to prevent.
const noReadAt = recognizeOwnPublish({
  masterBlobSha: SHA_OURS,
  pushedBlobSha: SHA_OURS,
  pushedReadAt: null,
});
eq(noReadAt.recognized, false, "bytes match but no recorded read time -> decline rather than invent a watermark");
eq(noReadAt.reason, "no_pushed_read_at", "half-written-row decline is named distinctly");

// (No separate "superseded older render" case: only the LATEST push is stored,
// so an older render reaching master is byte-for-byte the same input shape as the
// `differs` case above — a second assertion over identical inputs with a
// different story attached would test nothing new.)

// ── The AMOS timeline ──────────────────────────────────────────────────────
// AMO 2:16 ULT, the verse prod forensics found reverted byte-identically to its
// previously published text.
//
// SCOPE OF THIS BLOCK, stated plainly so it isn't over-read: `computeVerseMerge`
// is the real thing, but the ANCESTOR RECOVERY it is fed is modeled by the
// one-line `baseFor` stub below, not by bookReimport.ts's actual edit_log
// sub-select. So this demonstrates that a stale-vs-corrected watermark is what
// flips the verdict from `adopt_conflict` to `keep_master_unchanged` — it does
// not prove the recovery query itself behaves as modeled. The D1 writes on either
// side (markOwnPublishConverged / recordPushedRender) are covered separately by
// executing their SQL against a local D1, not here.
console.log("\n-- AMO 2:16 ULT timeline: export pushes -> merge moves master -> app edit -> sync --");

const V0 = JSON.stringify({
  verseObjects: [{ type: "text", text: "And the strong of heart shall flee away naked in that day." }],
});
const V1 = JSON.stringify({
  verseObjects: [{ type: "text", text: "And the bravest of them shall flee away naked in that day." }],
});
const V2 = JSON.stringify({
  verseObjects: [{ type: "text", text: "And the most courageous shall flee away naked on that day." }],
});

const T0 = 1_754_000_000; // an earlier night whose render already matched master
const T1_EDIT = T0 + 86_400 - 100; // translator's first edit  -> D1 holds V1
const T1_READ = T0 + 86_400; // night 1's export reads D1, renders V1, PUSHES a -be- branch
// ...the DCS validate-and-merge Action merges that branch: master now holds V1.
// The translator's SECOND edit, 3600s after night 1's D1 read, is what the bug
// destroyed. It has no constant of its own because nothing here needs to compute
// with it — the load-bearing fact is only that it lands AFTER T1_READ, which is
// why the corrected watermark leaves it outside the merge ancestor.

// The one row that matters, as it stands when night 2's sync starts.
// master_confirmed_at is still T0: night 1's export PUSHED (branchTouched:true),
// so isMasterConfirmed was false and nothing advanced the watermark. That is
// the bug, reproduced as data rather than asserted as prose.
const syncRowPreFix = {
  master_confirmed_at: T0,
  pushed_blob_sha: null, // nothing recorded what we published — pre-fix
  pushed_read_at: null,
};

// The ancestor bookReimport.ts recovers: newest edit_log verse payload dated
// BEFORE master_confirmed_at. With the watermark stuck at T0 that is V0; the
// T1_EDIT payload (V1) is dated after it and is therefore NOT the ancestor.
const baseFor = (watermark) => (watermark >= T1_EDIT ? V1 : V0);

const preFixRecognition = recognizeOwnPublish({
  masterBlobSha: await gitBlobSha(V1), // master's bytes ARE our night-1 render
  pushedBlobSha: syncRowPreFix.pushed_blob_sha,
  pushedReadAt: syncRowPreFix.pushed_read_at,
});
eq(preFixRecognition.recognized, false, "pre-fix: nothing recorded what we published, so nothing can recognize it");

// Pre-fix, the sync therefore ran the per-verse merge. Reproduce it with the
// REAL computeVerseMerge and the REAL pre-fix inputs.
const preFixMerge = computeVerseMerge({
  base: baseFor(syncRowPreFix.master_confirmed_at), // V0 — the stale ancestor
  ours: V2, // D1: the translator's 2026-08-13 edit
  theirs: V1, // master: our OWN night-1 export, now merged
  humanEditedSinceExport: true, // the second edit landed after the watermark
});
eq(preFixMerge.action, "adopt_conflict", "PRE-FIX REPRODUCTION: our own merged export is judged a foreign edit");
eq(preFixMerge.adopt, true, "PRE-FIX REPRODUCTION: master wins -> the app edit (V2) is overwritten by V1");
eq(
  preFixMerge.reason,
  "both_changed",
  "PRE-FIX REPRODUCTION: reason 'both_changed' — the misattribution, stated in the merge's own terms",
);

// Now the same night with the fix in place: night 1's export recorded the blob
// sha of the render it pushed, plus the time it read D1 to produce it.
const syncRowFixed = {
  master_confirmed_at: T0,
  pushed_blob_sha: await gitBlobSha(V1),
  pushed_read_at: T1_READ,
};

const fixedRecognition = recognizeOwnPublish({
  masterBlobSha: await gitBlobSha(V1),
  pushedBlobSha: syncRowFixed.pushed_blob_sha,
  pushedReadAt: syncRowFixed.pushed_read_at,
});
eq(fixedRecognition.recognized, true, "FIXED: master's bytes are exactly our night-1 render -> our own publish");
eq(
  fixedRecognition.readAt,
  T1_READ,
  "FIXED: the watermark advances to the render's D1-READ time (T1_READ), not to 'now'",
);

// (No assertion here on `Math.max(existing, readAt)`. Re-implementing the SQL's
// MAX()/COALESCE() in JavaScript and asserting arithmetic over constants chosen
// two lines earlier would pass even if the real statement were wrong — it tests
// the test. The actual UPDATE's monotonicity was verified by executing it against
// a local D1, which is the only place that claim can be earned.)

// On the nightly path the resource is now skipped outright, so this merge never
// runs for it. Assert it anyway, for the user/admin path — which deliberately
// stamps the watermark and then DOES import (see bookReimport.ts's runReimport
// comment) — and as belt-and-braces for the nightly one: the corrected ancestor
// alone is enough to keep the app edit.
const fixedMerge = computeVerseMerge({
  base: baseFor(T1_READ), // V1 — what we actually published, now the ancestor
  ours: V2,
  theirs: V1,
  humanEditedSinceExport: true,
});
eq(
  fixedMerge.action,
  "keep_master_unchanged",
  "FIXED: with the corrected ancestor, master is seen not to have moved -> D1's V2 is kept",
);
eq(fixedMerge.adopt, false, "FIXED: nothing is adopted, so the translator's edit is not overwritten");

// ── The fix must not swallow a REAL foreign edit ────────────────────────────
// The failure mode to guard against is over-reach: recognition making us blind
// to genuine out-of-band Door43 work (the 1CH incident, the opposite direction).
console.log("\n-- a genuine foreign edit on master still merges --");

const FOREIGN = JSON.stringify({
  verseObjects: [{ type: "text", text: "And the bravest of them shall flee away naked in that day!" }],
});

const foreignRecognition = recognizeOwnPublish({
  masterBlobSha: await gitBlobSha(FOREIGN), // a maintainer edited master on top of our merge
  pushedBlobSha: await gitBlobSha(V1),
  pushedReadAt: T1_READ,
});
eq(foreignRecognition.recognized, false, "a maintainer's hand edit changes the bytes -> recognition declines");
eq(foreignRecognition.reason, "content_differs", "declined for the right reason");

// Declining means the pre-existing three-way merge runs, and with the watermark
// now correct it adopts the maintainer's edit — which is exactly what the 1CH
// fix wanted and what this PR must not undo.
const foreignMerge = computeVerseMerge({
  base: V1, // ancestor: what we published and master then held
  ours: V1, // D1 untouched since
  theirs: FOREIGN, // master: the maintainer's out-of-band correction
  humanEditedSinceExport: false,
});
eq(foreignMerge.action, "adopt", "a real foreign edit is still adopted (the 1CH behavior is preserved)");
eq(foreignMerge.adopt, true, "adopt -> master's out-of-band correction reaches D1");

// --- findOurMergeAfterRead / judgeOwnPublishDecline ---------------------------
//
// PROD SHAPE UNDER TEST (2026-09-01/02, en_tq tq_JER.tsv): the bp-assistant bot
// pushed a chapter every evening (23:49Z on 09-01) between our nightly merges
// (05:38Z / 05:42Z), so the byte comparison declined three nights running and the
// blind counter raised the "cannot tell them apart" banner — while the merge job
// was measured landing our exact bytes every time (five PRs, three books; #859's
// head blob IS the ba421e896eab the banner named). Shas, dates and blobs below
// are the real ones.
const READ_AT_0901 = Date.parse("2026-09-01T05:31:00Z") / 1000; // render read, night of 09-01
const READ_AT_0902 = Date.parse("2026-09-02T05:31:00Z") / 1000;
const PUSHED_0901 = "ba421e896eab"; // what we pushed on 09-01 (PR #859 head blob)
const PUSHED_0902 = "f8bacfca3bb4"; // what we pushed on 09-02 (PR #864 head blob)
const botPush = { sha: "863fbfa65119", kind: "ai", date: "2026-09-01T23:49:46Z", authorName: "BW Bot", message: "TQ: JER 10 [ju..7@api.bp-assistant]" };
const ourMerge0901 = { sha: "22d652732b18", kind: "ours", date: "2026-09-01T05:38:03Z", authorName: "Benjamin Wright", message: "bible-editor: JER tq → master (#859)" };
const ourMerge0902 = { sha: "744f2ee87f2a", kind: "ours", date: "2026-09-02T05:42:19Z", authorName: "Benjamin Wright", message: "bible-editor: JER tq → master (#864)" };
const humanEdit = { sha: "dd522309086b", kind: "human", date: "2026-06-06T15:32:07Z", authorName: "Richard Mahn", message: "Richmahn reorder rows (#572)" };
const humanRevert = { sha: "0badc0ffee00", kind: "human", date: "2026-09-02T07:00:00Z", authorName: "Someone", message: 'Revert "bible-editor: JER tq → master (#864)"' };

// Step 1: which commit merged tonight's push? Matched by the export PR's number in
// the squash commit's subject. Newest-first walks, as Gitea serves them.
{
  // 09-02 morning: PR #864's merge is on master.
  const found = findOurMergeForPr([ourMerge0902, botPush, ourMerge0901], 864);
  eq(found.found, true, "the merge carrying our PR's number is found");
  eq(found.commit.sha, "744f2ee87f2a", "…and it is that commit");

  // The JER tq night of 09-01 → 09-02: bot push on top of our 09-01 merge (#859).
  // The merge is found UNDER the bot commit — position never mattered.
  const under = findOurMergeForPr([botPush, ourMerge0901], 859);
  eq(under.found, true, "our merge is found beneath a later bot push");
  eq(under.commit.sha, "22d652732b18", "…the right one");

  // Tonight's branch (#864) has not merged yet: only #859's merge is on master.
  const pending = findOurMergeForPr([botPush, ourMerge0901], 864);
  eq(pending.found, false, "no commit with our PR's number → nothing merged yet");
  eq(pending.reason, "merge_pending", "…and says so");
  // Codex finding on PR #704: two overlapping exports. Export A (#859) merged
  // AFTER export B's render was read; B is #864 and still pending. Matching by
  // date would have compared A's blob against B's push; by PR number it is pending.
  eq(findOurMergeForPr([ourMerge0901], 864).reason, "merge_pending", "another export's later-landing merge is not mistaken for ours");
  // Cold-review F2 shape: an old foreign commit newest, our new branch pending.
  eq(findOurMergeForPr([humanEdit], 864).reason, "merge_pending", "a stale foreign commit as newest is NOT an explanation while our push is unmerged");
  // A human revert of our merge carries the same "(#864)" but is not ours.
  eq(findOurMergeForPr([humanRevert], 864).reason, "merge_pending", "a human revert quoting our PR number is never taken for the merge");
  eq(findOurMergeForPr([humanRevert, ourMerge0902], 864).commit?.sha, "744f2ee87f2a", "…the real merge beneath it still is");

  // Absence is named for what it is.
  eq(findOurMergeForPr([], 864).reason, "no_commits", "an empty walk measures nothing");
  eq(findOurMergeForPr([ourMerge0902], null).reason, "no_pr_number", "no PR on record for the push → nothing to look for");
  eq(findOurMergeForPr([ourMerge0902], 0).reason, "no_pr_number", "…nor for a nonsense number");
  eq(findOurMergeForPr([{ ...ourMerge0902, message: null }], 864).reason, "merge_pending", "an ours commit with no subject cannot be the match");
  // Only the subject line is matched — a body mentioning another PR is not a match.
  eq(findOurMergeForPr([{ ...ourMerge0901, message: "bible-editor: JER tq → master (#859)\n\nsupersedes (#864)" }], 864).reason, "merge_pending", "a PR number in the body does not match");
}

// Step 2: the verdict from the merge commit's blob.
{
  const merge0901 = findOurMergeForPr([botPush, ourMerge0901], 859);
  // THE JER tq NIGHT, measured: the merge holds exactly what we pushed → preserved,
  // and the bot's push is named as what moved the file afterwards.
  const preserved = judgeOwnPublishDecline({ ourMerge: merge0901, mergedBlobSha: PUSHED_0901, pushedBlobSha: PUSHED_0901, newest: botPush });
  eq(preserved.verdict, "preserved", "merge blob == pushed blob → the merge job kept our bytes");
  eq(preserved.mergeSha, "22d652732b18", "…citing the merge");
  eq(preserved.newest?.kind, "ai", "…and naming what landed after it as the bot's push");
  eq(preserved.newest?.author, "BW Bot", "…by account");

  // A rewrite, measured at the merge itself — even with the bot's push on top,
  // which is exactly the case the first draft could not see (cold review F1).
  const rewritten = judgeOwnPublishDecline({ ourMerge: merge0901, mergedBlobSha: "0000deadbeef", pushedBlobSha: PUSHED_0901, newest: botPush });
  eq(rewritten.verdict, "rewritten", "merge blob != pushed blob → the merge changed our content, whatever came after");
  eq(rewritten.mergedBlobSha, "0000deadbeef", "…citing what it holds");
  eq(rewritten.mergeSha, "22d652732b18", "…and where");

  // Our merge is itself the newest commit and matched: preserved with nothing to name
  // (in practice recognition would have fired first; the judge stays honest anyway).
  const merge0902 = findOurMergeForPr([ourMerge0902], 864);
  eq(judgeOwnPublishDecline({ ourMerge: merge0902, mergedBlobSha: PUSHED_0902, pushedBlobSha: PUSHED_0902, newest: ourMerge0902 }).newest, null, "a matching merge that is also newest names no later commit");

  // Absence is not evidence, in either direction.
  const noBlob = judgeOwnPublishDecline({ ourMerge: merge0901, mergedBlobSha: null, pushedBlobSha: PUSHED_0901, newest: botPush });
  eq(noBlob.verdict, "unmeasured", "a failed tree read measures nothing");
  eq(noBlob.reason, "merge_blob_unknown", "…for the stated reason");
  const notFound = judgeOwnPublishDecline({ ourMerge: { found: false, reason: "merge_pending" }, mergedBlobSha: null, pushedBlobSha: PUSHED_0902, newest: botPush });
  eq(notFound.verdict, "unmeasured", "no merge to measure → unmeasured");
  eq(notFound.reason, "merge_pending", "…carrying step 1's reason");
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll gitBlobSha / recognizeOwnPublish / judgeOwnPublishDecline / AMOS-timeline checks passed.");
}

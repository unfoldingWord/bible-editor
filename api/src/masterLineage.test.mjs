// Regression tests for masterLineage.ts — classifying who moved Door43 master.
//
// Every fixture below is a REAL commit subject/author, not an invented shape:
// from master history on 2026-08-19 (en_tq/tq_AMO.tsv, en_tn/tn_JER.tsv,
// en_ult/26-EZK.usfm, en_ust/24-JER.usfm), and — for the #550 section — from
// the full 46,802-commit history described in masterLineage.ts's header, each
// one cited by sha. That matters here more than usual: this classifier's output
// decides whether a Door43 edit can be overwritten, so a fixture that merely
// looks plausible would lock in a guess. The places below where a shape is
// RECONSTRUCTED rather than quoted say so in a comment — and a reconstructed
// fixture may never be the only thing holding up a rule (that is how the
// verse-range and TWL widenings got in, and out again).
//
// ABLATION (re-run 2026-08-24 after the cold review, by patching
// masterLineage.ts — AI_PIPELINE_SUBJECT for R1–R5 and R8–R10,
// AI_PIPELINE_TRAILER for R11, the classifier's bot branch for R6–R7 — and
// re-running this file). The point is that a test which still passes with the
// tightening removed proves nothing:
//
//   baseline (as shipped)                       exit 0, 0 FAIL
//   R1 loose prefix `^(ULT|UST|TN|TQ):\s`       exit 1, 5 FAIL — 3a2432b15b,
//                                               plus the verse-range and both
//                                               book-code narrowings
//   R2 bracket made optional                    exit 0, 0 FAIL
//   R3 chapter digits made optional             exit 0, 0 FAIL
//   R4 end anchor removed                       exit 0, 0 FAIL
//   R5 digits AND bracket both dropped          exit 1, 2 FAIL — 3a2432b15b +
//                                               the verse-range narrowing
//   R6 `ai` = bot author email alone            exit 1, 15 FAIL — all six
//      (the pre-#550 rule)                      hand-directed outliers, all
//                                               four narrowings, both reason
//                                               assertions, the wrapped
//                                               trailer, the marker-mention
//                                               case, the retired vocabulary
//   R7 trailer accepted with no bot gate        exit 1, 1 FAIL — "a human
//                                               revert quoting a pipeline
//                                               trailer … is human"
//   R8 `TWL` re-added to the alternation        exit 1, 1 FAIL — "a TWL: prefix
//                                               is NOT an accepted shape"
//   R9 verse-range group re-added               exit 1, 1 FAIL — "a
//                                               verse-ranged target is NOT
//                                               accepted"
//   R10 book code loosened to                   exit 1, 2 FAIL — both book-code
//       `[1-3]?[A-Z]{2,3}`                      assertions
//   R11 trailer separator `\s*`                 exit 1, 1 FAIL — "a trailer
//       (spans newlines)                        whose value sits on the next
//                                               line is NOT the measured one"
//
// Read that honestly: on MEASURED data the LAM-intro exclusion needs only ONE
// of {chapter digits, bracket} to survive, which is why R2 and R3 alone break
// nothing and R5 breaks it. The end anchor (R4) breaks nothing measurable at
// all — it is kept because it costs nothing (all 807 real pipeline pushes still
// match) and narrows in the protective direction. R6 and R7 are the ones that
// carry the change — removing EITHER half of the two-signal rule fails the
// assertions that justify it — and R8–R11 are what keep the pattern from
// drifting back to accepting shapes nobody has ever observed.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/masterLineage.test.mjs

import {
  classifyMasterCommit,
  compactLineage,
  LINEAGE_EVIDENCE_CAP,
  masterMayHoldHumanEdit,
  summarizeLineage,
} from "./masterLineage.ts";

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
// so the bracket does not decide. (Since #550 the author does not decide alone
// either — see the two-signal section below.)
eq(kind("ULT: EZK 38 [pjoakes]", BOT), "ai", "a bot push requested by a human is still ai");

// The marker alone is enough even without the known bot address, so a future
// bot pushing under a different account is still recognized.
eq(kind("TQ: AMO 9 [xx..y@api.bp-assistant]", "someone-else@example.org"), "ai",
  "the bp-assistant marker alone classifies as ai");

// ── #550: the bot account is NOT sufficient on its own ──────────────────────
// The bot authored 817 commits in the corpus. 807 are pipeline pushes; ten are
// not, and six of those ten are hand-directed edits that the old
// author-email-only rule stamped `ai` — i.e. made overwritable by our next
// export. Each subject below is quoted from its commit (sha cited).
eq(kind("align PSA 7, 8 superscriptions", BOT), "human",
  "22ba6f3b9e: a bot-pushed hand alignment of two PSA superscriptions is human");
eq(kind("align PSA 4-9 superscriptions", BOT), "human",
  "1503b9e4fb: the same hand pass over six chapters is human");
// Subject abbreviated at the tail (it continues past the \qa tags); nothing
// after the first word affects the classification.
eq(kind("Fix LAM 1-4 acrostic \\qa tags", BOT), "human",
  "9f6417e437: a 93-hunk marker-convention normalization is human, not an AI run");
eq(kind("UST LAM 3: remove duplicate verses 1-10", BOT), "human",
  "08f0c4ffa0: a pure +0/-140 deletion is human (note it is `UST LAM 3:`, not `UST:`)");
eq(kind("fix: restore HAB 2:1-10 TN rows lost in AI insert", BOT), "human",
  "e417839d09: a repair OF AI damage must never itself classify as ai");
// The regression this section exists for, and the one the ablation above turns
// on. 3a2432b15b is the weakest of the six verdicts on content grounds, but the
// classification is not close: a LOOSE `^(ULT|UST|TN|TQ):\s` prefix test
// stamps it `ai` (R1/R5), while EITHER the required chapter digits OR the
// required bracket excludes it (R2/R3 pass alone).
eq(kind("TN: LAM chapter and book introductions", BOT), "human",
  "3a2432b15b: a book-wide intro pass is human — the loose prefix regex would call it ai");

// …and the 807 real pipeline pushes still classify `ai`, in all three
// renderings of the bracket. The bracket is a REQUESTER field whose rendering
// migrated (plain username -> truncated email -> x@api.bp-assistant); the
// recorded decision is that a human's name there does NOT make the commit
// human, because the content is still machine-written.
eq(kind("ULT: EZK 38 [pjoakes]", BOT), "ai",
  "plain-username bracket (c70e1f1a84) is still ai — that commit carries the pipeline trailer in its body");
eq(kind("TQ: AMO 5 [be..s@api.bp-assistant]", BOT), "ai", "the x@api.bp-assistant bracket is ai");
// The middle (truncated-email) rendering, using a domain that really occurs in
// it (`@my.wheaton.edu` 18×, `@gmail.com` 11×, `@unfoldingword.org` 1×). What
// this pins is NOT the bracket contents — those are opaque to the regex
// (`[^\]]*`) — but that the verdict survives a bracket with no bp-assistant
// address in it at all: this commit reaches `ai` through the bot email plus the
// subject SHAPE, never through AI_MARKER.
eq(kind("TN: JER 12 [st..w@my.wheaton.edu]", BOT), "ai",
  "a truncated-email bracket with no bp-assistant address in it is still ai, via bot + shape");
// Numbered book code. RECONSTRUCTED (no `1CH`-style bot subject was quoted in
// the measurement) — it pins the `[1-3][A-Z]{2}` half of the book-code group.
eq(kind("TN: 1CH 4 [de..d@api.bp-assistant]", BOT), "ai", "a numbered book code matches the pipeline shape");

// ── #550: what the pipeline shape deliberately does NOT accept ──────────────
// Every unmeasured shape this regex accepts is a way to stamp a hand edit `ai`,
// so the narrowings below are pinned as tightly as the exclusions. Each cites
// its count over the full 46,802-commit history.
// `TWL:` — zero such subjects exist. (Note this one also carries a
// bp-assistant address: it is `human` anyway, because a bot commit that fails
// the shape test returns from the bot branch and never reaches AI_MARKER.)
eq(kind("TWL: 1CH 4 [de..d@api.bp-assistant]", BOT), "human",
  "a TWL: prefix is NOT an accepted pipeline shape — zero occurrences measured");
// Verse / verse-range targets — zero of the bot's 817, zero repo-wide. This is
// the shape of e417839d09, this change's own motivating hand repair.
eq(kind("TN: HAB 2:1-10 [benjamin]", BOT), "human",
  "a verse-ranged target is NOT accepted — it is the shape of a hand repair, not of any measured push");
// Book code must be three letters, or a digit plus two.
eq(kind("TN: AB 1 [de..d@api.bp-assistant]", BOT), "human", "a two-letter book code is not a book code");
eq(kind("TN: 1ABC 1 [de..d@api.bp-assistant]", BOT), "human", "a four-character book code is not a book code");
eq(classifyMasterCommit({ sha: "x", message: "ULT: EZK 38 [pjoakes]", authorEmail: BOT }).reason,
  "bot_author_pipeline_subject", "…and the reason names the signal that fired");

// ── #550: the X-AI-Pipeline trailer, gated on the bot author ────────────────
// bp-assistant writes `X-AI-Pipeline: bp-assistant/{generate|notes|tqs}` into
// the commit BODY (519 commits, 518 bot-authored). Accepted as an alternative
// SHAPE signal so a future wording change to the subject does not silently
// reclassify real pipeline output. Be clear about what it buys TODAY: nothing.
// All 518 bot-authored trailer commits also match the subject rule, so the
// trailer classifies zero commits on its own — it is insurance against the next
// format migration, not coverage. The cases below are therefore forward-looking
// by construction.
eq(
  kind("TN: regenerate JER notes after prompt change\n\nX-AI-Pipeline: bp-assistant/notes\n", BOT),
  "ai",
  "a bot commit with a non-pipeline subject but a valid trailer is ai",
);
// The separator is `[ \t]*`, not `\s*`: a `\s*` would span the newline and
// accept a WRAPPED trailer, i.e. a body that never actually wrote the header
// bp-assistant writes. Narrower is the protective direction here.
eq(
  kind("TN: regenerate JER notes after prompt change\n\nX-AI-Pipeline:\nbp-assistant/notes\n", BOT),
  "human",
  "a trailer whose value sits on the next line is NOT the measured trailer",
);
// …but NEVER as a standalone rule. 56fc2ec924 (2026-06-04, Stephen Wunrow) is a
// HUMAN revert whose body quotes the reverted commit's subject AND its trailer.
// A trailer-only rule calls that human revert `ai` — the same trap as
// `Revert "bible-editor: …"`.
eq(
  kind(
    'revert 682f8938 (#7036)\n\nThis reverts commit 682f8938.\n\nUST: JER 31 [Gr..e@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/generate\n',
    "40496+stephenwunrow@noreply.door43.org",
  ),
  "human",
  "a human revert quoting a pipeline trailer (and subject) is human, not ai",
);
// The same trailer under the BOT author is ai — the gate is the author, not the
// wording. (Subject real; the body is reconstructed from the trailer format the
// corpus measured on 519 commits.)
eq(kind("TQ: AMO 5 [be..s@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/tqs\n", BOT), "ai",
  "a real bot push with both signals is ai");

// A hand-directed bot push returns `human` from the bot branch itself — it does
// NOT fall through to AI_MARKER, so a subject that merely MENTIONS a
// bp-assistant address cannot undo the decision. (No measured commit has this
// shape; the assertion pins the ordering, which is what would rot.)
eq(kind("fix: restore HAB 2:1-10 TN rows lost in the be..s@api.bp-assistant insert", BOT), "human",
  "a bot hand-fix that names the bp-assistant address is still human");
eq(classifyMasterCommit({ sha: "x", message: "align PSA 7, 8 superscriptions", authorEmail: BOT }).reason,
  "bot_author_no_pipeline_shape", "…and the reason says WHY it is human, for the alert");

// The dead `AI …for BOOK CH` vocabulary is deliberately NOT accepted: nothing
// has used it since 2026-04-01, it appears under three non-bot identities, and
// one commit it would readmit is the defective run e417839d09 had to repair.
eq(kind("AI TN for HAB 2", BOT), "human", "the retired `AI RES for BOOK CH` vocabulary is not an ai shape");

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

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall masterLineage assertions passed");

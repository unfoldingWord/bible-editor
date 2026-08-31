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
//   R6 `ai` = bot author email alone            exit 1, 15 FAIL as first
//      (the pre-#550 rule)                      measured 2026-08-24 — all six
//                                               hand-directed outliers, all
//                                               four narrowings, both reason
//                                               assertions, the wrapped
//                                               trailer, the marker-mention
//                                               case, the retired vocabulary.
//                                               STALE — see the 2026-08-31
//                                               re-run below (issue #670):
//                                               22 FAIL on current main.
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
// Re-run 2026-08-27 for #634 and #638 (masterLineage.ts's own header note 4
// and the AI_PIPELINE_TRAILER / AI_PIPELINE_SUBJECT_LOOSE comments carry the
// same figures). R12/R13 are #634's rows, re-measured against the #638
// assertion set; R14 is #638's own:
//
//   R12 AI_PIPELINE_SUBJECT_LOOSE gate            exit 1, 7 FAIL — both #622
//       removed from the trailer route            trailer-route assertions,
//       (the route had NO subject gate at         both #634 ones, and three
//       all before #634; #629's REVERT_PREFIX     of the #638 ones: a
//       gate on that route turned out to be       bot-authored revert, a
//       provably subsumed by this one — see       bot-authored hand REPAIR,
//       AI_PIPELINE_TRAILER's own comment — so    and 3a2432b15b's book-wide
//       there is no longer a narrower ablation    intro pass, each quoting a
//       to run for #629 alone)                    trailer, all wrongly `ai`
//   R13 REVERT_PREFIX narrowed back to            exit 1, 2 FAIL — the two
//       `/^revert\s/i` (the pre-#634 pattern)      widened-prefix cases:
//                                                  `Reverts "…"` (no space)
//                                                  and `Revert:"…"` (colon)
//                                                  both fall through to
//                                                  AI_MARKER and wrongly
//                                                  become `ai`
//   R14 AI_PIPELINE_SUBJECT_LOOSE weakened        exit 1, 2 FAIL — both
//       back to the prefix-only                    3a2432b15b assertions.
//       `/^(ULT|UST|TN|TQ):\s/` that #634          `TN: LAM chapter and book
//       shipped (this is R1's regex, on the        introductions` passes a
//       trailer route instead of the subject       prefix-only gate and its
//       route)                                     quoted trailer then makes
//                                                  a real hand-directed bot
//                                                  commit `ai` again
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
// R14 is R1's finding applied to the OTHER route, and it is why #638 exists:
// the prefix-only test R1 measured as re-admitting 3a2432b15b is exactly what
// #634 installed as the trailer route's gate. R2/R3 say either of {digits,
// bracket} alone excludes that commit, so the gate now asks for the weaker
// `digits OR bracket` — enough to shut the door, still loose enough to be
// insurance against a subject-format migration rather than a copy of the full
// rule. What R14 does NOT prove: that the gate catches a hand repair whose
// subject fully matches the pipeline grammar. It does not, by construction —
// the FLOOR assertion at the end of the #638 section pins that residual `ai`
// so it stays visible.
//
// Re-run 2026-08-31 (issue #670), R6 ONLY, against current main (HEAD
// c0b1e4f): the 15-FAIL number above was measured 2026-08-24, before #634 and
// #638 added the trailer-route hardening sections (the #622/#634/#638
// assertions folded into R12–R14 above), so it undercounts what R6 actually
// breaks today. Reproduced by temporarily replacing the bot branch's whole
// two-signal body in masterLineage.ts — the `AI_PIPELINE_SUBJECT` check, the
// `AI_PIPELINE_SUBJECT_LOOSE`+`AI_PIPELINE_TRAILER` check, and the
// `bot_author_no_pipeline_shape` fallback — with a single unconditional
// `return { ...commit, kind: "ai", reason: "bot_author_pipeline_subject" }`
// (bot author decides alone, nothing else consulted), then running this file
// unmodified, then reverting masterLineage.ts (confirmed byte-identical to
// HEAD via `git diff` afterward — this file's own assertions were never
// touched). Result: exit 1, 22 FAIL. The 22 is the original 15 (same six
// hand-directed outliers, four narrowings, wrapped trailer, marker-mention
// reason pair, retired vocabulary, and the #550 bot-authored-revert case)
// PLUS 7 new failures from the #622/#634/#638 trailer-route sections that did
// not exist in the 2026-08-24 test file — each a kind+reason pair or a
// gate-exclusion assertion added since. Every failure, old and new, is a
// case the two-signal rule exists to fix, so the shape of the ablation is
// unchanged; only the count grew as the test file did. Do not cite the
// issue-filing-time claim of "24 FAIL on main, 25 after #655's #647
// assertion" — that #647 assertion (the "non-revert human edit message that
// merely quotes the marker" case, below) exercises the AI_MARKER route on a
// NON-bot author, which R6's patch never touches, so it cannot be part of
// R6's count; 22, measured directly above, is what this exact patch against
// this exact HEAD produces.
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
  refEvidenceTouches,
  refsTouchedInTsv,
  refsTouchedInUsfm,
  summarizeLineage,
} from "./masterLineage.ts";
import { computeVerseMerge } from "./verseMerge.ts";
import { computeTsvMerge } from "./tsvMerge.ts";
import { refParts } from "./importParsers.ts";

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
// (Subject carries a chapter number but NOT the full `RES: BOOK CH [req]`
// grammar, so it misses AI_PIPELINE_SUBJECT and reaches the trailer route.
// #638 strengthened that route's gate to prefix + {digits or bracket}: this
// fixture gained the `31` so it still probes the TRAILER rather than dying at
// the subject gate. The digit-less and bracket-less original now classifies
// `human` — pinned in the #638 section below.)
eq(
  kind("TN: regenerate JER 31 notes after prompt change\n\nX-AI-Pipeline: bp-assistant/notes\n", BOT),
  "ai",
  "a bot commit with a non-pipeline subject but a valid trailer is ai",
);
// The separator is `[ \t]*`, not `\s*`: a `\s*` would span the newline and
// accept a WRAPPED trailer, i.e. a body that never actually wrote the header
// bp-assistant writes. Narrower is the protective direction here.
eq(
  kind("TN: regenerate JER 31 notes after prompt change\n\nX-AI-Pipeline:\nbp-assistant/notes\n", BOT),
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

// ── #622: a bot-authored revert whose quoted body carries the trailer ──────
// Gitea's revert button quotes the reverted commit's body verbatim. If that
// reverted commit was a real pipeline push, the quoted body still contains
// `X-AI-Pipeline: bp-assistant/…` even though THIS commit's subject is a
// revert, not a pipeline push. The trailer test must not outvote the subject:
// a hand-directed revert pushed through the bot account is exactly the class
// #614 exists to preserve as `human`.
// RECONSTRUCTED (`sha: "deadbeef"`): no bot-authored revert of this exact
// shape was ever quoted/measured against the corpus — the fixture is
// prospective, built to probe the gap #622 describes, not a cited commit.
eq(
  kind(
    'Revert "UST: JER 31 [Gr..e@api.bp-assistant]"\n\nThis reverts commit deadbeef.\n\nUST: JER 31 [Gr..e@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/generate\n',
    BOT,
  ),
  "human",
  "a bot-authored revert quoting a pipeline trailer in its body is human, not ai (#622)",
);
eq(
  classifyMasterCommit({
    sha: "x",
    message:
      'Revert "UST: JER 31 [Gr..e@api.bp-assistant]"\n\nThis reverts commit deadbeef.\n\nX-AI-Pipeline: bp-assistant/generate\n',
    authorEmail: BOT,
  }).reason,
  "bot_author_no_pipeline_shape",
  "…and the reason says WHY, same as any other hand-directed bot push (#622)",
);

// ── #634 part 1: a bot-pushed HAND REPAIR that quotes what it repairs ──────
// #622's REVERT_PREFIX guard only excludes REVERTS from the trailer route. It
// does nothing for a hand repair whose subject is not a revert at all but
// whose body pastes the offending commit's own message — trailer included —
// as a maintainer citing what they fixed naturally would. The module's own
// motivating case is exactly this shape: e417839d09,
// `fix: restore HAB 2:1-10 TN rows lost in AI insert` (THE MEASURED BASIS
// above). RECONSTRUCTED: e417839d09's own real body was not refetched for
// this fixture; the body below is a plausible worst case built to probe the
// gap, not that commit's literal text.
eq(
  kind(
    "fix: restore HAB 2:1-10 TN rows lost in AI insert\n\nReverts the damage from:\n\nTN: HAB 2 [be..s@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/notes\n",
    BOT,
  ),
  "human",
  "a bot-pushed hand repair whose body quotes the repaired commit's trailer is human, not ai (#634)",
);
eq(
  classifyMasterCommit({
    sha: "x",
    message:
      "fix: restore HAB 2:1-10 TN rows lost in AI insert\n\nTN: HAB 2 [be..s@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/notes\n",
    authorEmail: BOT,
  }).reason,
  "bot_author_no_pipeline_shape",
  "…and the reason says WHY, same as any other hand-directed bot push (#634)",
);
// The gate must not swallow a REAL trailer commit: subjects with a genuine
// pipeline shape still pass it (already covered above, e.g. the "TN:
// regenerate JER 31 notes…" case) — this just pins that a subject with NO
// resource prefix at all is what the fail-closed gate rejects.
eq(
  classifyMasterCommit({
    sha: "x",
    message: "TN: regenerate JER 31 notes after prompt change\n\nX-AI-Pipeline: bp-assistant/notes\n",
    authorEmail: BOT,
  }).kind,
  "ai",
  "…while a subject that DOES carry a resource prefix still passes the trailer route (#634)",
);

// ── #634 part 2: REVERT_PREFIX widened from `revert ` to `reverts?\b` ──────
// The old `/^revert\s/i` needed a literal space right after `revert`, missing
// `Reverts` (no space before the next word) and `Revert:` (colon, not
// whitespace) — both real shapes: the file header cites three `Reverts BE
// changes` commits by rich.mahn (2026-08-17), and Gitea's own revert-button
// wording can render as `Revert"…"` with no space before the quote. Each case
// below reaches the (non-bot) AI_MARKER route, where REVERT_PREFIX is the ONLY
// gate — so these fail against the old regex and pass against `reverts?\b`.
eq(
  kind('Reverts "TQ: AMO 5 [be..s@api.bp-assistant]" and related changes', RICH),
  "human",
  "RECONSTRUCTED: 'Reverts \"…\"' (no space before the quote) is human, not ai — REVERT_PREFIX now matches without a following space (#634)",
);
eq(
  kind('Revert:"UST: JER 31 [Gr..e@api.bp-assistant]"', RICH),
  "human",
  "RECONSTRUCTED: 'Revert:\"…\"' (colon, no space) is human, not ai — \\b matches a word/non-word boundary too (#634)",
);
// And the widened prefix must not start matching an unrelated word that
// merely begins with the same letters.
//
// READ THE EXPECTATION HONESTLY: `ai` here is what the CODE does, not what is
// desirable. RICH is a human, and the subject is a human sentence that merely
// QUOTES a pipeline marker — but AI_MARKER matches the subject with no author
// check at all (masterLineage.ts note 4), so anything quoting
// `@api.bp-assistant` outside a revert lands on `ai`. This assertion pins that
// wrong-direction outcome deliberately, because what it is really testing is
// that `\b` does not fire mid-word; the fallout is AI_MARKER's own design gap.
// That gap fires ZERO times in the path-scoped history this module actually
// sees, so it is filed rather than fixed here — issue #647 asked for a
// MEASURED decision on whether AI_MARKER should learn an author check, and
// masterLineage.ts note 4 now records that decision: no, leave it, because the
// shape this would protect against (a non-bot, non-revert subject quoting the
// marker) has a measured count of ZERO across the full 46,802-commit corpus.
eq(
  kind('Revertsomething "TQ: AMO 5 [be..s@api.bp-assistant]"', RICH),
  "ai",
  "'Revertsomething' is NOT a revert — \\b must not fire mid-word (#634)",
);
// #647's own motivating example: an ordinary, non-revert human edit message
// that happens to quote the marker. Same residual gap as above, pinned
// separately because it is the shape the issue actually worried about (the
// `Revertsomething` case above exists to test `\b`'s word-boundary behavior,
// not this). masterLineage.ts note 4 records why this stays `ai`: measured
// zero occurrences of this shape in the full corpus, and an author check would
// cost AI_MARKER's one remaining job (catching an unknown future bot) against
// a shape that has never once happened.
eq(
  kind('Fix bad rows from TQ: AMO 5 [be..s@api.bp-assistant]', RICH),
  "ai",
  "a non-revert human edit message that merely quotes the marker still classifies ai — the recorded, measured decision, not an oversight (#647)",
);

// ── #638: the trailer-route gate is prefix + {chapter digits or bracket} ────
// #634 gated the trailer route on the resource prefix ALONE,
// `/^(ULT|UST|TN|TQ):\s/`. That is the exact regex ablation row R1 above
// records as re-admitting 3a2432b15b, `TN: LAM chapter and book
// introductions` — a REAL hand-directed bot commit (THE MEASURED BASIS in
// masterLineage.ts), one of the six the two-signal rule exists to keep
// `human`. The FULL subject rule excludes it on the required chapter digits
// and the required bracket; the prefix-only gate handed it a second door,
// which opens the moment such a commit's body quotes a trailer. R2/R3
// measured that EITHER of {digits, bracket} alone excludes it, so the gate now
// requires the weaker `digits OR bracket` — enough to shut the door, still
// looser than the full pattern. R14 ablates it.
//
// RECONSTRUCTED BODY: 3a2432b15b's own body was not refetched, and on the
// measured corpus it carries no trailer at all (all 519 trailer commits match
// the full subject rule). The body below is the worst case the gate has to
// survive — a hand pass citing the run it followed — not that commit's
// literal text. The SUBJECT is quoted verbatim from the corpus.
eq(
  kind(
    "TN: LAM chapter and book introductions\n\nFollows on from:\n\nTN: LAM 3 [be..s@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/notes\n",
    BOT,
  ),
  "human",
  "3a2432b15b's subject does NOT pass the trailer-route gate — no chapter digits, no bracket (#638)",
);
eq(
  classifyMasterCommit({
    sha: "3a2432b15b",
    message: "TN: LAM chapter and book introductions\n\nX-AI-Pipeline: bp-assistant/notes\n",
    authorEmail: BOT,
  }).reason,
  "bot_author_no_pipeline_shape",
  "…and the reason says WHY, same as any other hand-directed bot push (#638)",
);
// EITHER signal alone re-opens the route, which is what makes the gate an OR
// rather than an AND: these two pin the two halves independently, so a future
// edit that drops one of them fails here rather than silently narrowing.
eq(
  kind("TN: LAM 3 introductions reworked\n\nX-AI-Pipeline: bp-assistant/notes\n", BOT),
  "ai",
  "a chapter digit alone satisfies the strengthened gate (#638)",
);
eq(
  kind("TN: LAM introductions [be..s@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/notes\n", BOT),
  "ai",
  "a bracket alone satisfies the strengthened gate (#638)",
);
// The strengthening must not cost a REAL pipeline push. All 518 measured
// bot-authored trailer commits carry BOTH a chapter number and a bracket, so
// the gate rejects zero of them; this pins the shape.
eq(
  kind("TQ: AMO 5 [be..s@api.bp-assistant] (reformatted)\n\nX-AI-Pipeline: bp-assistant/tqs\n", BOT),
  "ai",
  "a real pipeline subject that misses only the END ANCHOR still passes the trailer route (#638)",
);
// …and the hand repair #634 was built for is still excluded, by the prefix
// half, exactly as before the strengthening.
eq(
  kind(
    "fix: restore HAB 2:1-10 TN rows lost in AI insert\n\nTN: HAB 2 [be..s@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/notes\n",
    BOT,
  ),
  "human",
  "`fix: restore HAB 2:1-10 …` still has no resource prefix, so the gate still excludes it (#638)",
);
//
// THE FLOOR, pinned rather than assumed. A hand repair whose subject FULLY
// matches the pipeline grammar — resource prefix, chapter digits AND bracket —
// and whose body quotes a trailer is indistinguishable from a real push by any
// subject-shape test, and classifies `ai`. `ai` is the overwritable direction,
// so this is a real residual risk, not a cosmetic one. Closing it needs an
// author-level or content-level signal the trailer route does not have. The
// expectation below is what the code DOES, not what is desirable.
eq(
  kind(
    "TN: HAB 2 [benjamin] restore rows lost in AI insert\n\nX-AI-Pipeline: bp-assistant/notes\n",
    BOT,
  ),
  "ai",
  "FLOOR: a hand repair whose subject matches the pipeline grammar is still ai — the route's design limit (#638)",
);

// The dead `AI …for BOOK CH` vocabulary is deliberately NOT accepted: nothing
// has used it since 2026-04-01, it appears under three non-bot identities, and
// one commit it would readmit is the defective run e417839d09 had to repair.
eq(kind("AI TN for HAB 2", BOT), "human", "the retired `AI RES for BOOK CH` vocabulary is not an ai shape");

// ── the Revert-quoting-bp-assistant trap (#612) ─────────────────────────────
// Gitea's revert button quotes the reverted commit's subject verbatim, so a
// HUMAN reverting a bp-assistant push produces a subject that still matches
// AI_MARKER. That must not classify the revert itself as ai — it would let
// the very content the maintainer reverted overwrite their revert.
eq(
  kind('Revert "UST: JER 31 [Gr..e@api.bp-assistant]"', RICH),
  "human",
  "a human revert quoting a bp-assistant address is human, not ai",
);
// A bot-authored revert of a pipeline push is `human` as of #550: the
// BOT_EMAILS branch runs first, the `Revert "…"` subject fails
// AI_PIPELINE_SUBJECT, and the body carries no trailer — so it returns
// `bot_author_no_pipeline_shape` and never reaches AI_MARKER at all. That is
// the protective direction: a revert pushed through the bot account is a
// hand-directed edit, and calling it `ai` would let the reverted content
// overwrite it. (Before #550 the bare author check made this `ai`.)
eq(
  kind('Revert "UST: JER 31 [Gr..e@api.bp-assistant]"', BOT),
  "human",
  "a bot-authored revert is human — it fails the pipeline shape test (#550)",
);
// Lowercase, unquoted "revert " a maintainer might type by hand is guarded too.
eq(
  kind("revert TQ: AMO 5 [be..s@api.bp-assistant] — bad AI push", RICH),
  "human",
  "a hand-typed lowercase revert quoting the marker is also human",
);
// A revert of something else entirely is unaffected — still human, as before.
eq(
  kind('Revert "bible-editor: EZK ult → master (#6711)" (#6716)', BW),
  "human",
  "a revert unrelated to bp-assistant is still human (unchanged by the guard)",
);

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

// ── #607: the TSV half of #557's per-verse narrowing ────────────────────────
//
// #557 narrowed the lineage guard from "did a human touch this FILE" to "did
// a human touch this VERSE" for ult/ust only — fetchHumanTouchedRefs refused
// anything that did not end in `.usfm`. #607 gives tn/tq/twl the same
// narrowing: a TSV row's ref is its own first column, so the map is per-line
// and needs no \c/\v walk (see refsTouchedInTsv's header comment).
//
// THE FIXTURES ARE REAL, same standard as #557's:
//
//   api/src/fixtures/jer-tn-bbdc2cbc.diff   `Fixes lashes and periods`,
//   api/src/fixtures/jer-tn-72a4062d.diff   `Fixes word before AT`,
//                                           both Richard Mahn, unfoldingWord/en_tn
//
// are the commits' own unified diffs, byte-for-byte as git.door43.org served
// them on 2026-08-27 (each is a whole-repo whitespace/punctuation sweep across
// every tn_*.tsv file, which is why the path filter matters here too).
//
//   api/src/fixtures/jer-tn-*.rows.txt
//
// is tn_JER.tsv AS IT STOOD AT THAT COMMIT, reduced to only the lines the
// commit's own hunks cover — real line NUMBER, real line TEXT, plus the
// file's real line count. Unlike the USFM reduction, no \c/\v state needs
// preserving: refsTouchedInTsv reads each covered line independently, so the
// lines it never reads are provably irrelevant, not just presumed so. Both
// files are produced by `scripts/extract-tsv-rows.mjs` (a full 40-char sha is
// required — same trap as extract-usfm-markers.mjs: an abbreviated sha
// silently serves master's current tip).
console.log("\n[#607: the TSV hunk -> ref map, from two real richmahn commits]");

const JER_TSV_PATH = "tn_JER.tsv";

function loadTsvRevision(name) {
  const rows = new Map();
  let totalLines = 0;
  for (const line of fixture(`${name}.rows.txt`).split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    const key = line.slice(0, tab);
    const val = line.slice(tab + 1);
    if (key === "lines") {
      totalLines = Number(val);
      continue;
    }
    rows.set(Number(key), val);
  }
  // Filler that is NOT a valid ref column — if the mapper ever reads a line
  // outside its hunks (a bug this fixture would otherwise hide), it fails
  // loudly (unparseable_ref_column) instead of silently passing.
  const lines = new Array(totalLines).fill("NOT-A-REAL-ROW\tunclaimed filler, never inside any hunk");
  for (const [lineNo, val] of rows) lines[lineNo - 1] = val;
  return { text: lines.join("\n"), totalLines };
}

const TN_COMMITS = [
  { name: "jer-tn-bbdc2cbc", sha: "bbdc2cbc14974eb45ea9b1a8d0c9f995260b5e36", subject: "Fixes lashes and periods", hunks: 1, chapters: [22] },
  { name: "jer-tn-72a4062d", sha: "72a4062d565c370c82f06a1c05513ebb1b776aed", subject: "Fixes word before AT", hunks: 3, chapters: [48, 51] },
];

const tnEvidence = [];
for (const c of TN_COMMITS) {
  const parsed = parseDiffHunksForPath(fixture(`${c.name}.diff`), JER_TSV_PATH);
  eq(parsed.complete, true, `${c.subject}: its diff parses for ${JER_TSV_PATH}`);
  eq(parsed.hunks.length, c.hunks, `${c.subject}: ${c.hunks} hunk(s) touch ${JER_TSV_PATH}`);
  const rev = loadTsvRevision(c.name);
  const ev = refsTouchedInTsv(rev.text, parsed.hunks);
  eq(ev.complete, true, `${c.subject}: every hunk mapped to a ref`);
  const chapters = [...new Set(ev.refs.map((r) => Number(r.split(":")[0])))].sort((a, b) => a - b);
  eq(JSON.stringify(chapters), JSON.stringify(c.chapters), `${c.subject}: lands only in chapter(s) ${c.chapters.join(",")}`);
  tnEvidence.push(ev);
}
eq(tnEvidence[0].refs.includes("22:19"), true, "commit 1 (single hunk) touched JER TN 22:19");
eq(tnEvidence[1].refs.includes("48:8"), true, "commit 2 (three hunks) touched JER TN 48:8");
eq(tnEvidence[1].refs.includes("51:55"), true, "...and 51:55");

// The path filter matters here too: both commits are whole-repo sweeps.
{
  const other = parseDiffHunksForPath(fixture("jer-tn-bbdc2cbc.diff"), "tn_1KI.tsv");
  eq(other.complete, true, "the same commit's 1KI hunks parse too (a different path in the same diff)");
  eq(
    parseDiffHunksForPath(fixture("jer-tn-bbdc2cbc.diff"), "tn_NOTABOOK.tsv").reason,
    "path_not_in_diff",
    "a path the commit never touched is NOT silently 'no hunks, nothing touched'",
  );
}

const tnWindowEvidence = mergeRefEvidence(tnEvidence);
eq(tnWindowEvidence.complete, true, "both commits mapped -> the window's evidence is complete");
eq(tnWindowEvidence.refs.includes("22:19"), true, "the window touched JER TN 22:19");
eq(tnWindowEvidence.refs.includes("48:8"), true, "...and 48:8");
eq(tnWindowEvidence.refs.includes("40:5"), false, "the window did NOT touch JER TN 40:5");
eq(tnWindowEvidence.refs.includes("40:*"), false, "...nor chapter 40 as a whole");

console.log("\n[#607: the merge decision, per row]");

const TN_WINDOW = summarizeLineage(
  [
    classifyMasterCommit({ sha: "5080d90444", message: "bible-editor: JER tn → master (#7415)", authorEmail: BW }),
    classifyMasterCommit({ sha: TN_COMMITS[1].sha, message: TN_COMMITS[1].subject, authorEmail: RICH }),
    classifyMasterCommit({ sha: TN_COMMITS[0].sha, message: TN_COMMITS[0].subject, authorEmail: RICH }),
    classifyMasterCommit({ sha: "27bf9236aa", message: "bible-editor: JER tn → master (#7444)", authorEmail: BW }),
  ],
  { humanRefs: tnWindowEvidence },
);
const TN_SUMMARY = JSON.parse(JSON.stringify(compactLineage(TN_WINDOW)));

eq(TN_SUMMARY.counts.human, 2, "the window holds Rich's two hand commits");
eq(TN_SUMMARY.mayHoldHumanEdit, true, "the FILE-level answer is unchanged: a human did move this file");
eq(TN_SUMMARY.refsComplete, true, "...and the per-row map is complete");

// The decision the issue exists for — asked the way bookReimport.ts's
// resolveEditedCandidates actually asks it: row.chapter, row.verse, no
// verseEnd (a TSV bridge already collapses to its first verse in those
// fields; see the ParsedTsvRow / refParts note this fix's call-site comment
// cites).
eq(masterMayHoldHumanEditForVerse(TN_SUMMARY, 22, 19), true, "a human DID touch JER TN 22:19");
eq(masterMayHoldHumanEditForVerse(TN_SUMMARY, 48, 8), true, "...and 48:8");
eq(masterMayHoldHumanEditForVerse(TN_SUMMARY, 51, 55), true, "...and 51:55");
eq(masterMayHoldHumanEditForVerse(TN_SUMMARY, 40, 5), false, "no human touched JER TN 40:5");
eq(masterMayHoldHumanEditForVerse(TN_SUMMARY, 1, 1), false, "...nor JER TN 1:1");

{
  // End to end, through computeTsvMerge itself — the same shape as the #557
  // verse-merge block above, for the tn kind.
  const base = { note: "the ancestor we last published" };
  const ours = { note: "the translator's app edit" };
  const theirs = { note: "the AI run sitting on master" };
  eq(
    computeTsvMerge("tn", base, ours, theirs, {
      masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(TN_SUMMARY, 40, 5),
    }).action,
    "keep_ai_master",
    "JER TN 40:5 both-changed -> keep_ai_master, not a revert (no human touched this row)",
  );
  eq(
    computeTsvMerge("tn", base, ours, theirs, {
      masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(TN_SUMMARY, 22, 19),
    }).action,
    "adopt_conflict",
    "JER TN 22:19 both-changed -> adopt_conflict: master holds a real hand edit there",
  );
}

console.log("\n[#607: every uncertainty resolves to the file-level answer, TSV side]");

{
  eq(refsTouchedInTsv("", [{ newStart: 1, newCount: 1 }]).reason, "empty_file", "an empty TSV file is incomplete");
  {
    const noHunks = refsTouchedInTsv("Reference\tID\n1:1\tabcd\n", []);
    eq(noHunks.complete, true, "no hunks -> complete, nothing touched");
    eq(noHunks.refs.length, 0, "...with an empty ref set");
  }

  const goodFile =
    ["Reference\tID\tNote", "front:intro\taaaa\tintro note", "1:1\tbbbb\tfirst note", "1:2-3\tcccc\tbridged note"].join("\n") +
    "\n";

  eq(
    refsTouchedInTsv(goodFile, [{ newStart: 1, newCount: 1 }]).reason,
    "unparseable_ref_column",
    "the header row's own column 1 ('Reference') does not parse as a ref",
  );

  {
    // front:intro -> chapter 0, verse 0 — parseTsvRow's own convention
    // (refParts in importParsers.ts), which the merge call site relies on.
    const ev = refsTouchedInTsv(goodFile, [{ newStart: 2, newCount: 1 }]);
    eq(ev.complete, true, "front:intro maps");
    eq(JSON.stringify(ev.refs), JSON.stringify(["0:0"]), "...to 0:0");
  }
  {
    // A bridge expands to every verse it covers, not the whole chapter — the
    // ref itself states the range, unlike refsTouchedInUsfm's chapter-front
    // case which has no such information to go on.
    const ev = refsTouchedInTsv(goodFile, [{ newStart: 4, newCount: 1 }]);
    eq(ev.complete, true, "a bridged ref maps");
    eq(JSON.stringify([...ev.refs].sort()), JSON.stringify(["1:2", "1:3"]), "...to every verse it covers");
  }
  eq(
    refsTouchedInTsv(goodFile, [{ newStart: 1, newCount: 999 }]).reason,
    "hunk_past_end_of_file",
    "a hunk past the end of the file is incomplete, never mapped to what is there",
  );
  {
    // A comma-separated verse list: measured real (en_tn/tn_PSA.tsv, "5:1,3,8,12"),
    // and DIFFERENT from a bridge — discrete verses, not a range.
    const commaFile = ["Reference\tID", "5:1,3,8,12\tabcd"].join("\n") + "\n";
    const ev = refsTouchedInTsv(commaFile, [{ newStart: 2, newCount: 1 }]);
    eq(ev.complete, true, "a comma-separated verse list maps");
    eq(JSON.stringify([...ev.refs].sort()), JSON.stringify(["5:1", "5:12", "5:3", "5:8"]), "...to exactly those verses");
    eq(ev.refs.includes("5:2"), false, "...and NOT the verses in between (this is a list, not a bridge)");
    // A comma segment can itself be a bridge.
    const mixedFile = ["Reference\tID", "5:1,3-4,8\tabcd"].join("\n") + "\n";
    const mixedEv = refsTouchedInTsv(mixedFile, [{ newStart: 2, newCount: 1 }]);
    eq(mixedEv.complete, true, "a comma list with a bridged segment maps");
    eq(
      JSON.stringify([...mixedEv.refs].sort()),
      JSON.stringify(["5:1", "5:3", "5:4", "5:8"]),
      "...expanding only the bridged segment",
    );
    // One bad segment discards the WHOLE ref (fails closed, unlike the display
    // helper importParsers.ts's coveredVersesFromRef, which would skip it).
    eq(
      refsTouchedInTsv(["Reference\tID", "5:1,intro,8\tabcd"].join("\n") + "\n", [{ newStart: 2, newCount: 1 }]).reason,
      "unparseable_ref_column",
      "'intro' mixed into a comma list is not a real shape — the whole ref is discarded, not skipped",
    );
  }

  eq(
    refsTouchedInTsv(["Reference\tID", "not-a-ref\tabcd"].join("\n") + "\n", [{ newStart: 2, newCount: 1 }]).reason,
    "unparseable_ref_column",
    "garbage in the ref column is incomplete, never silently skipped",
  );
  eq(
    refsTouchedInTsv(["Reference\tID", "totally malformed, no tab at all"].join("\n") + "\n", [{ newStart: 2, newCount: 1 }])
      .complete,
    false,
    "a line with no tab separator reads whole as the ref column, and still fails safely",
  );
  eq(
    refsTouchedInTsv(["Reference\tID", "front:intro-6\tabcd"].join("\n") + "\n", [{ newStart: 2, newCount: 1 }]).reason,
    "unparseable_ref_column",
    "'front:intro' with a trailing range is not a real shape",
  );
  eq(
    refsTouchedInTsv(["Reference\tID", "1:9-3\tabcd"].join("\n") + "\n", [{ newStart: 2, newCount: 1 }]).reason,
    "unparseable_ref_column",
    "an inverted bridge (9-3) is not narrowed, not collapsed to a singleton",
  );

  {
    // The cap is a degradation, same direction as refsTouchedInUsfm's.
    const rows = ["Reference\tID"];
    for (let i = 1; i <= LINEAGE_REF_CAP + 1; i++) rows.push(`1:${i}\tid${i}`);
    const manyFile = rows.join("\n") + "\n";
    const ev = refsTouchedInTsv(manyFile, [{ newStart: 2, newCount: LINEAGE_REF_CAP + 1 }]);
    eq(ev.complete, false, "more refs than the cap degrades to the file-level answer");
    eq(ev.reason, "ref_cap_exceeded", "...and says why");
  }

  {
    // Zero-context pure deletion (newCount === 0): claims both sides of the
    // join, same rule as refsTouchedInUsfm's.
    const delFile = ["Reference\tID", "1:1\ta", "1:2\tb", "1:3\tc"].join("\n") + "\n";
    const ev = refsTouchedInTsv(delFile, [{ newStart: 2, newCount: 0 }]);
    eq(ev.complete, true, "a pure-deletion hunk maps");
    eq(JSON.stringify([...ev.refs].sort()), JSON.stringify(["1:1", "1:2"]), "...claiming both sides of the join");
  }

  eq(
    mergeRefEvidence([tnEvidence[0], { complete: false, refs: [], reason: "diff_fetch_failed" }]).complete,
    false,
    "one unmapped TSV commit makes the whole window incomplete",
  );
}

// ── PR #644 review, F1: a verse number near Number.MAX_SAFE_INTEGER must
// never reach a `for` loop ──────────────────────────────────────────────────
//
// Both mappers loop `for (let v = lo; v <= hi; v++)` over a verse range. Once
// `v` exceeds 2^53 (Number.MAX_SAFE_INTEGER + 1), `v++` stops changing `v` —
// float precision cannot represent every integer past that point — so the
// loop never terminates. `hi - lo > MAX_BRIDGE_WIDTH` does NOT catch this: a
// single verse with no bridge has `hi === lo`, so its width is 0. Reproduced
// in isolation (a throwaway probe, not committed) against the exact pre-fix
// loop shape with `\v 9007199254740993` / `"1:9007199254740993"` — killed by
// an OS-level timeout after 6s and tens of millions of iterations with `v`
// frozen at 9007199254740992 (2^53). MAX_VERSE_NUMBER is the fix: it is
// checked BEFORE either loop runs, so these assertions must resolve
// immediately, not merely "eventually" — a regression here would hang this
// whole test file, not just fail one assertion.
console.log("\n[PR #644 review F1: a huge verse number must not hang, in either mapper]");
{
  const HUGE = "9007199254740993"; // rounds to 2^53 once coerced to a Number
  const t0 = Date.now();

  const tsvFile = ["Reference\tID", `1:${HUGE}\tabcd`].join("\n") + "\n";
  const tsvEv = refsTouchedInTsv(tsvFile, [{ newStart: 2, newCount: 1 }]);
  eq(tsvEv.complete, false, "refsTouchedInTsv: a single huge verse number (no bridge) is incomplete, not a hang");
  eq(tsvEv.reason, "unparseable_ref_column", "...via the ref-column parse, not silently accepted");

  const usfmText = ["\\id JER", "\\c 1", `\\v ${HUGE} huge`].join("\n") + "\n";
  const usfmEv = refsTouchedInUsfm(usfmText, [{ newStart: 3, newCount: 1 }]);
  eq(usfmEv.complete, false, "refsTouchedInUsfm: the same shape via a \\v marker is incomplete, not a hang");
  eq(usfmEv.reason, "unparseable_verse_bridge", "...via the marker's own bridge check, not silently accepted");

  // A huge verse as the BRIDGE END (dash present) must be caught too — the
  // width-only check does not fire when lo itself is already past the bound.
  const tsvBridgeFile = ["Reference\tID", `1:5-${HUGE}\tabcd`].join("\n") + "\n";
  eq(
    refsTouchedInTsv(tsvBridgeFile, [{ newStart: 2, newCount: 1 }]).complete,
    false,
    "a huge BRIDGE END is caught too, not just a bare huge verse",
  );
  const usfmBridgeText = ["\\id JER", "\\c 1", `\\v 5-${HUGE} huge`].join("\n") + "\n";
  eq(
    refsTouchedInUsfm(usfmBridgeText, [{ newStart: 3, newCount: 1 }]).complete,
    false,
    "...same for the USFM marker's bridge end",
  );

  // The point of the fix: this whole block resolves fast. A regenerated
  // pre-fix build would not reach this line inside any sane test timeout.
  eq(Date.now() - t0 < 5000, true, "all four assertions above resolved in well under 5s");
}

// ── PR #644 review, F4: an emitted key must itself be a valid "c:v" ref ─────
//
// A chapter number so large it stringifies in scientific notation
// ("1e+24:1") is finite, so it clears every isFinite/width check — the gap is
// that nothing validated the emitted KEY, not the input magnitude. Without
// this, refsTouchedInTsv would return `complete:true` with a ref set the
// consumer's own REF_KEY_RE validation (masterLineage.ts's `validRefs`, via
// refsFrom) silently discards — a persisted lineage record claiming a
// completeness the consumer does not actually honor.
console.log("\n[PR #644 review F4: an emitted key that fails REF_KEY_RE discards the whole ref]");
{
  const hugeChapterFile = ["Reference\tID", "999999999999999999999999:1\tabcd"].join("\n") + "\n";
  const ev = refsTouchedInTsv(hugeChapterFile, [{ newStart: 2, newCount: 1 }]);
  eq(ev.complete, false, "a chapter number that stringifies in scientific notation is incomplete, not complete:true");
  eq(ev.reason, "unparseable_ref_column", "...caught at the ref-column parse, before any completeness claim is made");
}

// ── PR #644 review, F6: parseTsvRefColumn's key format must never drift from
// refParts, the consumer's own key producer ─────────────────────────────────
//
// masterMayHoldHumanEditForVerse looks evidence up by (chapter, verse) —
// which for a TSV row comes from parseTsvRow's refParts (importParsers.ts),
// NOT from refsTouchedInTsv's own parsing. If the two ever disagreed on what
// a ref STRING means, the evidence computed here would silently never be
// found at the lookup site, quietly degrading every narrowing back to the
// file-level answer — safe, but pointless. Table-driven so a future change to
// either parser is caught here instead of a production alert nobody expected.
// `refParts` intentionally collapses a bridge/comma-list to its FIRST verse
// only ("range collapses to first verse for indexing" — its own comment), so
// the contract this pins is narrower than "identical output": the (chapter,
// verse) pair refParts extracts must always be a member of the ref set
// parseTsvRefColumn (via refsTouchedInTsv) produces for the same string.
console.log("\n[PR #644 review F6: parseTsvRefColumn keys agree with refParts, the consumer's own parser]");
{
  const REF_SHAPE_CASES = [
    { ref: "front:intro", label: "chapter-front intro" },
    { ref: "1:intro", label: "in-chapter intro" },
    { ref: "40:5-6", label: "a bridge" },
    { ref: "5:1,3,8,12", label: "a comma-separated verse list" },
    { ref: "01:05", label: "leading zeros" },
    { ref: "  40:5  ", label: "outer whitespace" },
  ];
  for (const { ref, label } of REF_SHAPE_CASES) {
    const file = ["Reference\tID", `${ref}\tabcd`].join("\n") + "\n";
    const ev = refsTouchedInTsv(file, [{ newStart: 2, newCount: 1 }]);
    eq(ev.complete, true, `${label} ("${ref}"): parseTsvRefColumn maps it`);
    const [chapter, verse] = refParts(ref);
    eq(
      refEvidenceTouches(ev.refs, chapter, verse),
      true,
      `${label}: refParts's own (chapter, verse) key — (${chapter}, ${verse}) — is a member of the evidence set, ` +
        `so masterMayHoldHumanEditForVerse's lookup actually finds what this mapper claimed`,
    );
  }
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall masterLineage assertions passed");

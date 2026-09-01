// Who moved master? — pure classification of a Door43 master commit.
//
// THE PROBLEM (issue #540 item 1). Every attribution this codebase does today
// is content-shaped: the three-way merge compares D1, master, and a
// reconstructed ancestor, and ownPublish.ts compares master's bytes against the
// exact bytes we last pushed. Both are blind in the same way — they can tell
// that master moved, never WHO moved it. So "a Door43 editor edited this"
// currently means "the bytes are not what we expected", which is also true when
// our own export merged, when an AI push landed, and when an export-time
// normalization changed a character. Acting on that guess is what produced the
// AMO 4:2 shape: a hand fix on master reverted to the text of the AI run that
// preceded it.
//
// Door43 knows the answer and we never asked. Gitea's commits API returns each
// commit's message and author, and the three producers are distinguishable:
//
//   OURS   `bible-editor: AMO tq → master (#815)`      the squash merge, and
//          `bible-editor export: JER ust → JER-be-Grant_Ailie (export-…)`
//          the branch commit, which also appears in master's file history once
//          the branch merges. Both are our own render; neither is anyone's edit.
//   AI     `TQ: AMO 5 [be..s@api.bp-assistant]`, authored by
//          `bot@unfoldingword.org` AND shaped like a pipeline push (see the
//          two-signal rule on classifyMasterCommit). bp-assistant writes the
//          content.
//   HUMAN  everything else — richmahn, stephenwunrow, lrsallee, justplainjane47,
//          NateKreider, and Benjamin's own hand commits.
//
// THE MEASURED BASIS (issue #550, measured 2026-08-24). These rules used to
// cite a single day's spot check of four files. They now rest on the FULL
// history of the five repos: 46,802 commits across en_ult / en_ust / en_tn /
// en_tq / en_twl, 101 distinct author emails — plus 2,727 PATH-SCOPED commits
// across 18 files, path-scoped being the shape listMasterCommitsSince actually
// fetches. (The first pass sampled 8,700 of those commits; a cold review
// re-derived every count below against all 46,802 and they reproduce exactly.)
// What it counted:
//
//   * `bot@unfoldingword.org` (display name always `BW Bot`) authored 817
//     commits. 807 are `RES: BOOK CH [requester]`-shaped pipeline pushes. TEN
//     ARE NOT — and diffing all ten against known-good bp-assistant output
//     found SIX HAND-DIRECTED EDITS that the old author-email-only rule stamped
//     `ai`: 22ba6f3b9e and 1503b9e4fb (align PSA superscriptions — one `\d`
//     line replaced per chapter, English untouched), 9f6417e437 (LAM `\qa`
//     acrostic marker normalization, 93 hunks, zero alignment work),
//     08f0c4ffa0 (`UST LAM 3: remove duplicate verses 1-10`, +0/-140, a pure
//     deletion), e417839d09 (restoring HAB 2:1-10 TN rows that a DEFECTIVE AI
//     run had destroyed nine minutes earlier) and 3a2432b15b (LAM TN chapter
//     and book intros). All ten are reachable in path-scoped history, so this
//     was production-reachable, not theoretical — and e417839d09 is the whole
//     failure in miniature: a repair OF AI damage, classified as AI, and
//     therefore overwritable by the next export.
//   * The fingerprint of REAL pipeline output: one chapter, one hunk
//     (occasionally two), every row/verse in that chapter replaced.
//   * bp-assistant also writes a trailer in the commit BODY —
//     `X-AI-Pipeline: bp-assistant/{generate|notes|tqs}`, on 519 commits, 518
//     of them bot-authored. ALL 518 also match the subject rule, so the trailer
//     adds ZERO coverage today. It is not carrying any commit; it is insurance
//     against the next subject-format migration (the bracket rendering has
//     already migrated twice — see note 2), and it costs one gated regex.
//   * OURS_PREFIX has zero false positives in 1,535 matches.
//   * THE SAFETY PROPERTY, measured rather than argued: replaying the old rule
//     against the new one over all 46,802 commits flips exactly TEN commits,
//     every one of them `ai` -> `human`, every one bot-authored. Zero commits
//     flip toward `ai` or `ours`; no non-bot commit changes at all.
//
// FOUR THINGS THE REAL DATA CHANGED, none of which were obvious up front:
//
// 1. `Revert "bible-editor: EZK ult → master (#6711)" (#6716)` is a REAL commit
//    on en_ult, authored by a human — and it is not a one-off. The corpus holds
//    20 human-authored reverts, 12 of them `Revert "bible-editor: …"`, TEN of
//    those on 2026-08-14 alone (af608ef1dc ult EZK, 0644698241 tn ISA,
//    b508aba798 tn AMO, ecfa7fd93b tn EZK, 5b068498e2 ust EZK, 2a07686d16 ust
//    NUM, 1c41821993 ult NUM, e391110c81 twl 1CH, 757bab7e44 twl ISA), plus
//    three `Reverts BE changes` by rich.mahn on 2026-08-17. A substring test
//    for "bible-editor:" calls every one of them ours and silently drops a
//    whole revert CAMPAIGN out of the lineage — so the prefix is anchored at
//    the start of the message. The anchor is structural, not incidental.
// 2. DECISION — the question issue #550 asked to record: A BOT PUSH CARRYING A
//    HUMAN'S NAME IN THE BRACKET STAYS `ai`. `ULT: EZK 38 [pjoakes]` is
//    bot-authored with a plain username where later commits carry
//    `x@api.bp-assistant`. The reason is evidentiary, not taste: the bracket is
//    a REQUESTER field, and its RENDERING migrated — plain username (Mar–May
//    2026) → truncated email → `x@api.bp-assistant` (Jun–Aug) — with the same
//    people appearing in both forms. Reading the plain form as human would
//    classify identical pipeline runs by their message-formatting ERA rather
//    than by their producer. And c70e1f1a84 (`ULT: EZK 38 [pjoakes]`,
//    2026-08-13) carries `X-AI-Pipeline: bp-assistant/generate` in its body —
//    the bot's own declaration that the content is machine-written.
//    RESIDUAL: what genuinely needed protecting was never the bracket, it was
//    the bot pushing a HAND-AUTHORED REPAIR with no trailer and no pipeline
//    grammar — the six commits above. That is exactly what the tightened `ai`
//    rule now catches.
// 3. `login` is null on plenty of commits, human ones included
//    (`richmahn@users.noreply.github.com` with no login). Never key on it.
// 4. AI_MARKER matches the SUBJECT, with no author check — so a HUMAN commit
//    whose subject merely QUOTES a bp-assistant address also matched it.
//    Gitea's revert button produces exactly that shape:
//    `Revert "UST: JER 31 [Gr..e@api.bp-assistant]"`, authored by whoever
//    clicked revert. Measured on the full history (46,802 commits): the revert
//    button is in active use (12 human `Revert "bible-editor: …"` commits, ten
//    on 2026-08-14 alone). Fixed by excluding revert subjects from AI_MARKER,
//    mirroring OURS_PREFIX's own anchoring rationale (note 1).
//    AI_MARKER is otherwise INERT in the history this module actually sees: it
//    fires 339× repo-wide and ZERO times path-scoped, because all 339 are
//    `Merge pull request …` commits and Gitea's path-scoped history
//    simplification drops merge commits. Kept rather than retired — it is the
//    one route that still recognizes a future bot pushing under an author
//    BOT_EMAILS does not know (see the constant's own note) — but do not
//    credit it with doing work today. (issue #612)
//    RE-MEASURED 2026-08-30 (issue #647), asking the narrower question note 4
//    left open: not "does AI_MARKER fire on a non-revert subject" (it can, by
//    construction — the regex has no author or revert check) but "has it EVER
//    fired on the shape that would actually hurt", i.e. a human's own edit
//    message that happens to quote the marker outside a revert (the issue's
//    own example: `Fix bad rows from TQ: AMO 5 [be..s@api.bp-assistant]`).
//    It has not: ALL 339 repo-wide AI_MARKER matches are `Merge pull request
//    …`-shaped (this note's own count above), zero of them share the
//    "ordinary sentence that cites the marker" shape the issue is worried
//    about, and — independently — Gitea's path-scoped history simplification
//    drops every one of the 339 before this classifier ever sees it. So the
//    measured count of "non-bot, non-revert, marker-quoting, classifier-
//    visible" commits across the full 46,802-commit corpus is ZERO, and per
//    this issue's own decision rule ("if that count is 0 ... the decision is
//    leave it, with the number written down") the answer is: leave AI_MARKER
//    as a bare subject match, do not add an author check. An author check
//    would also cost something real — it is the one route that still catches
//    an UNKNOWN future bot (see the constant's own comment) — so paying that
//    cost against a shape that has never once occurred is the wrong trade.
//    masterLineage.test.mjs pins the residual gap this leaves (a non-bot,
//    non-revert subject that quotes the marker still classifies `ai`) so it
//    stays visible rather than silently relied upon; re-open this note the day
//    a real commit of that shape is found.
//    The same trap applies to the AI_PIPELINE_TRAILER route, which reads the
//    BOT-authored commit's body rather than an unknown author's subject: a
//    bot-pushed hand-directed revert or repair can quote another commit's
//    trailer verbatim. #629 first fixed the revert shape with a REVERT_PREFIX
//    gate on that route; #634 replaced it with the broader
//    AI_PIPELINE_SUBJECT_LOOSE gate (the subject must show SOME pipeline
//    shape, not just an absence of "revert"), which subsumes #629's case and
//    additionally closes the sibling one: a hand REPAIR whose subject cites
//    no pipeline shape at all — e417839d09 itself. #638 then strengthened
//    that gate from the prefix alone to prefix + {chapter digits or bracket},
//    because the prefix alone is the same regex ablation row R1 records as
//    re-admitting 3a2432b15b (`TN: LAM chapter and book introductions`), one
//    of the six hand-directed bot commits above. A subject that fully matches
//    the pipeline grammar and still quotes a trailer remains `ai` — that is
//    the route's floor, and the test suite pins it rather than hiding it.
//
// FAIL-SAFE DIRECTION, and it is the whole safety argument for this module.
// Downstream, `ai` and `ours` are what let a conflict resolve D1-wins; `human`
// preserves today's master-wins behavior. So every uncertainty must resolve to
// `human`: an unrecognized message, an absent author, a shape we have never
// seen. Mis-labelling a human commit as AI would revert a maintainer's hand
// edit — the exact failure this work exists to stop — while mis-labelling an AI
// commit as human only leaves today's behavior in place. Nothing here can
// produce `ai` or `ours` except a positive match on a pattern we have observed
// in production.
//
// Pure (no network, no D1) so the classification is regression-testable without
// a Workflow context — same convention as verseMerge.ts, tsvMerge.ts,
// ownPublish.ts and shrinkGuard.ts. The fetch that feeds it lives in
// dcsSources.ts.

export type MasterCommitAuthorKind =
  | "ours" // our own export: the squash merge, or the -be- branch commit
  | "ai" // a bp-assistant PIPELINE push — bot author AND pipeline shape
  | "human"; // a maintainer's own edit — and the fail-safe default

export interface MasterCommit {
  sha: string;
  /**
   * Full commit message. The first line decides `ours`; the BODY is read too,
   * for bp-assistant's `X-AI-Pipeline:` trailer (see classifyMasterCommit).
   */
  message: string | null;
  /** commit.author.email from Gitea. Null when absent. */
  authorEmail: string | null;
  /**
   * commit.author.name from Gitea. Never classified on — but DISPLAYED since
   * #684 (see LineageHumanCommit), so it is no longer diagnostic-only.
   */
  authorName?: string | null;
  /** commit.author.date, ISO-8601. Never classified on; displayed as a day (#684). */
  date?: string | null;
}

export interface ClassifiedCommit extends MasterCommit {
  kind: MasterCommitAuthorKind;
  /** Which rule fired, so an alert can cite its evidence rather than assert. */
  reason: string;
}

// Our export's two message prefixes, anchored at the start (see note 1 above —
// a human `Revert "bible-editor: …"` must NOT match). The book/resource are not
// checked: this classifier is already scoped to one file's history by the
// caller, and a stricter match would fail closed to `human` on any future
// wording change, which is the safe direction anyway.
const OURS_PREFIX = /^bible-editor(?: export)?:\s/;

// bp-assistant's own marker. Kept as a second, independent route to `ai` so a
// future bot that pushes under a different author is still recognized — but see
// note 4: it is inert in path-scoped history, which is the only history we see.
const AI_MARKER = /@api\.bp-assistant\b/;

// A human clicking Gitea's revert button on a bp-assistant push quotes that
// push's subject verbatim (`Revert "UST: JER 31 [Gr..e@api.bp-assistant]"`),
// which would otherwise match AI_MARKER regardless of who authored the
// revert. See note 4 above. Matches both `Revert "…` (Gitea's own wording)
// and a plain `revert …` a maintainer might type by hand.
//
// `\b` rather than a required `\s`, and `s?` for the plural (issue #634): the
// old `/^revert\s/i` needed a literal space right after `revert`, which missed
// `Reverts` (the corpus's own `Reverts BE changes`, three real commits by
// rich.mahn on 2026-08-17 — see note 1 above) and `Revert:` (colon, not
// whitespace). `\b` matches either shape, plus a bare `Revert` with nothing
// after it, while still rejecting an unrelated word that merely starts with
// the same letters (`Revertsome` fails: no word/non-word transition after
// `revert` or after `reverts`). Not widened to `reapply` / `undo` / `rollback`
// — issue #634 flags them as worth considering but explicitly declines to add
// them without measuring the real corpus first, and this module does not
// guess.
//
// The same decline covers the TENSE FORMS. `Reverted …` and `Reverting …` do
// NOT match `/^reverts?\b/i` — `\b` fires after `revert`, but the pattern then
// has to end, and `ed`/`ing` are word characters, so the match fails. That is
// deliberate, not an oversight of the `s?`: `s` was added because the corpus
// HOLDS three `Reverts BE changes` commits, and no `Reverted`/`Reverting`
// subject has been measured in the 46,802 commits. Widening the alternation on
// the strength of English grammar rather than a commit in hand is the exact
// guess this module refuses elsewhere. Add either form the day one is
// measured — the direction is protective (more subjects classify `human`), so
// the cost of waiting is only that a hypothetical `Reverting "…@api.bp-
// assistant…"` by a non-bot author would reach AI_MARKER and classify `ai`.
const REVERT_PREFIX = /^reverts?\b/i;

// The bot account that authors every bp-assistant push. Necessary for `ai`, and
// (since #550) no longer sufficient on its own — see classifyMasterCommit.
//
// DO NOT ADD `ai@unfoldingword.org` OR `53472+bookpackagebot@…` HERE. They were
// measured: three and zero path-scoped commits respectively. The `human`
// fail-safe already handles both correctly, and widening the bot set is the one
// direction that can only cost us — every address added is another way for a
// hand edit to be stamped machine-written.
const BOT_EMAILS = new Set(["bot@unfoldingword.org"]);

// The whole-subject shape of a real bp-assistant pipeline push. Validated
// against the corpus: it matches 807 of the bot's 817 commits, and the ten it
// does not match are exactly the outlier set from THE MEASURED BASIS above (six
// of them hand-directed edits).
//
// Three details are load-bearing EXCLUSIONS, each measured rather than taste:
//   * the required CHAPTER DIGITS and the required BRACKET — either alone
//     excludes `TN: LAM chapter and book introductions` (3a2432b15b), a
//     hand-directed book-wide intro pass. Relax BOTH — i.e. fall back to a
//     loose `^(ULT|UST|TN|TQ):\s` prefix test — and that commit is stamped
//     `ai` again. masterLineage.test.mjs pins it, and the ablation in that
//     file's header records which relaxation breaks which assertion.
//   * the END ANCHOR, which is what makes this a whole-subject match rather
//     than a prefix: a subject that begins with the pipeline grammar and then
//     says something else is, by that fact, not a plain pipeline push. It costs
//     nothing (all 807 still match) and fails in the protective direction.
// The other five hand-directed subjects never reach any of that — none of them
// opens with `RES:` at all (`UST LAM 3: …` and `fix: restore HAB …` are the
// near misses), so the anchored prefix alone excludes them.
//
// AND THREE DELIBERATE NARROWINGS, which matter just as much, because every
// unmeasured thing this pattern ACCEPTS is a way to stamp a hand edit `ai`:
//   * NO `TWL:` in the alternation. Zero `TWL:` subjects exist in all 46,802
//     commits; the observed prefixes are ULT, UST, TN, TQ only.
//   * NO verse or verse-range after the chapter. `(?::\d+(?:-\d+)?)?` matched
//     0 of the bot's 817 commits and 0 repo-wide — and it would have accepted
//     `TN: HAB 2:1-10 [benjamin]`, which is the exact shape of this change's
//     own motivating commit (e417839d09, a hand repair of AI damage).
//   * BOOK CODE is `[1-3][A-Z]{2}` or `[A-Z]{3}`, not `[1-3]?[A-Z]{2,3}`, which
//     also accepted `AB` and `1ABC`.
// If bp-assistant ever starts emitting a TWL push, a verse-ranged target, or
// some other code shape, those commits classify `human` — which only preserves
// master. RE-ADD ON MEASUREMENT, not on expectation: widen this only with the
// commits in hand, the way the rest of this comment was earned.
//
// DELIBERATELY NOT ACCEPTED either: the older `AI (ULT|UST|TN|TQ) for {BOOK}
// {CH}` vocabulary. It would keep four stale commits as `ai`, but nothing has
// used it since 2026-04-01, it appears under three non-bot identities, and one
// commit it would readmit is the defective run whose damage e417839d09 had to
// repair.
const AI_PIPELINE_SUBJECT =
  /^(ULT|UST|TN|TQ):\s+(?:[1-3][A-Z]{2}|[A-Z]{3})\s+\d+\s*\[[^\]]*\]\s*$/;

// bp-assistant's trailer, written into the commit BODY. An alternative SHAPE
// signal — never a standalone rule, always gated on the bot author email. It
// currently classifies NOTHING on its own (all 518 bot trailer commits also
// match the subject rule); it exists so the next subject-format migration does
// not silently reclassify real pipeline output. `[ \t]*`, not `\s*`, so the
// separator cannot span a newline and match `X-AI-Pipeline:\nbp-assistant/…`.
// Why the gate: 56fc2ec924 (2026-06-04, Stephen Wunrow) is a HUMAN
// `revert 682f8938… (#7036)` whose body quotes the reverted commit's subject
// AND its trailer. A trailer-only rule calls that human revert `ai` — the same
// species of trap as `Revert "bible-editor: …"` in note 1.
//
// The trailer route also requires the SUBJECT to carry SOME pipeline shape
// (AI_PIPELINE_SUBJECT_LOOSE, checked at the call site below). #629
// originally gated this route on the narrower REVERT_PREFIX — excluding just
// the case where Gitea's revert button quotes a reverted pipeline commit's
// trailer verbatim. #634 replaced it with AI_PIPELINE_SUBJECT_LOOSE, which
// subsumes that case and additionally closes the sibling one: a bot-pushed
// HAND REPAIR whose subject is not a revert but whose body pastes the message
// of the commit it repairs, trailer included. e417839d09 (`fix: restore HAB
// 2:1-10 TN rows lost in AI insert`, THE MEASURED BASIS above) is exactly
// this shape; a repair that also quotes what it repairs must not flip back to
// `ai` on the strength of that quote.
// REVERT_PREFIX is not ALSO checked here: the two patterns are both anchored
// at `^` and share no prefix (`revert` vs. `ULT|UST|TN|TQ`), so no subject can
// ever match both — AI_PIPELINE_SUBJECT_LOOSE already excludes every revert
// subject on its own (measured by ablation, not just argued: removing
// REVERT_PREFIX from the old combined condition left every assertion in
// masterLineage.test.mjs passing). Keeping a provably-dead condition around
// would be exactly the unmeasured guess this module's own discipline refuses
// elsewhere. Re-add it only if AI_PIPELINE_SUBJECT_LOOSE's alternation ever
// grows a resource code beginning with the letters `re` — none of
// ULT/UST/TN/TQ do today.
const AI_PIPELINE_TRAILER = /^X-AI-Pipeline:[ \t]*bp-assistant\//m;

// The LOOSE shape test that gates the trailer route (#634, strengthened in
// #638). Deliberately not the FULL AI_PIPELINE_SUBJECT — no book code, no
// `RES: BOOK CH` ordering, no end anchor — because requiring the whole thing
// would make this route redundant with the subject rule above it. What it DOES
// require is the resource prefix AND at least one of {a digit, a `[`}
// somewhere after it.
//
// WHY BOTH HALVES, and this is the part #634 got wrong. #634 shipped the
// prefix alone, `/^(ULT|UST|TN|TQ):\s/`. That is the EXACT regex this module's
// own ablation row R1 (masterLineage.test.mjs) records as re-admitting
// 3a2432b15b — `TN: LAM chapter and book introductions`, a real hand-directed
// bot commit and one of the six THE MEASURED BASIS above exists to keep
// `human`. The FULL subject rule excludes it via the required chapter digits
// and the required bracket; a prefix-only gate on the trailer route handed it
// a second door, which opens the moment such a commit's body quotes a trailer.
// R2/R3 measured that EITHER of {digits, bracket} alone excludes 3a2432b15b,
// so requiring the weaker `digits OR bracket` still shuts that door while
// staying looser than the full pattern. R14 ablates the strengthening itself.
//
// THE CLAIM THIS COMMENT USED TO MAKE, corrected. "Every real trailer commit's
// subject already matches the FULL AI_PIPELINE_SUBJECT (518/518), so this
// loose check costs nothing measured" is true only in the EXCLUSION direction:
// it says the gate never REJECTS a real pipeline push. It said nothing about
// what the gate ADMITS, which is exactly where 3a2432b15b came back in. The
// 518/518 figure still holds and still means the STRENGTHENED gate rejects
// zero measured pipeline output — every one of those 518 subjects carries both
// a chapter number and a bracket, so both halves of the new gate pass.
//
// WHAT IT STILL CANNOT CATCH, stated because it is a design limit of this
// route and not an oversight: a hand repair whose subject fully matches the
// pipeline grammar (digits AND bracket) and whose body quotes a trailer STILL
// classifies `ai`. No subject-shape test can separate that from a real push —
// only an author-level or content-level signal could, and neither is available
// here. masterLineage.test.mjs pins one such case deliberately, so the floor
// is visible rather than assumed.
//
// AND WHAT THE GATE CONSCIOUSLY ACCEPTS LOSING, so the trailer keeps doing its
// one stated job — surviving the next subject-format MIGRATION (the header's
// own word; the bracket rendering has already migrated twice, see note 2) —
// without becoming a blanket bypass. Each of these now classifies `human` on
// this route, all in the protective direction:
//   * `TWL:` subjects — zero in all 46,802 measured commits, and no TWL
//     pipeline exists; the same narrowing the full pattern already makes.
//   * lowercase prefixes (`tn: …`) — the alternation is case-sensitive.
//   * colon-less forms (`TN HAB 2 [x]`) — the `:` is required.
// If a future migration produces any of those, those commits classify `human`,
// which only preserves master. RE-ADD ON MEASUREMENT, not on expectation.
const AI_PIPELINE_SUBJECT_LOOSE = /^(ULT|UST|TN|TQ):\s(?=.*[\d[])/;

function firstLine(message: string | null): string {
  if (!message) return "";
  const nl = message.indexOf("\n");
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}

export function classifyMasterCommit(commit: MasterCommit): ClassifiedCommit {
  const subject = firstLine(commit.message);
  // The FULL message, body included — the trailer test below reads the body,
  // which firstLine() throws away.
  const message = commit.message ?? "";
  const email = (commit.authorEmail ?? "").trim().toLowerCase();

  // `ours` is checked FIRST. Our own export commits are authored under the
  // account that opened the PR (a human's, since the DCS merge bot squashes
  // under the PR author), so an author-first order would call every one of them
  // a human edit and defeat the whole point.
  if (OURS_PREFIX.test(subject)) {
    return { ...commit, kind: "ours", reason: "bible_editor_export_message" };
  }
  // `ai` requires BOTH signals (issue #550): the bot account AND a commit that
  // looks like a pipeline push. The author email alone used to be enough, and
  // that stamped six hand-directed bot commits `ai` — including a repair of AI
  // damage. Dropping one of them back to `human` costs nothing but today's
  // master-wins behavior; the reverse costs a maintainer's edit.
  if (email && BOT_EMAILS.has(email)) {
    if (AI_PIPELINE_SUBJECT.test(subject)) {
      return { ...commit, kind: "ai", reason: "bot_author_pipeline_subject" };
    }
    // Gated on AI_PIPELINE_SUBJECT_LOOSE (#634, subsuming #629's narrower
    // REVERT_PREFIX gate; strengthened in #638 from prefix-only to prefix +
    // {digits or bracket} — see that constant's own comment): a bot-authored
    // commit whose BODY quotes another commit's pipeline trailer must not
    // classify `ai` unless its own SUBJECT shows some pipeline shape too.
    // That covers a hand-directed revert (Gitea's button quotes the reverted
    // commit's body verbatim, trailer included), a hand repair that instead
    // pastes the message of the commit it repairs, and — only since the #638
    // strengthening — a book-wide hand pass that happens to open with a
    // resource prefix (3a2432b15b). None of those subjects looks like a
    // pipeline push.
    if (AI_PIPELINE_SUBJECT_LOOSE.test(subject) && AI_PIPELINE_TRAILER.test(message)) {
      return { ...commit, kind: "ai", reason: "bot_author_pipeline_trailer" };
    }
    // A bot commit that is neither is a HAND-DIRECTED bot push — the six
    // commits in THE MEASURED BASIS. It returns here rather than falling
    // through to AI_MARKER: we have already established this is the known bot
    // and the commit does not look like a pipeline push, and AI_MARKER exists
    // for the opposite case (an UNKNOWN author with the marker). Letting it
    // fall through would let a subject that merely MENTIONS a bp-assistant
    // address undo the decision we just made.
    return { ...commit, kind: "human", reason: "bot_author_no_pipeline_shape" };
  }
  // A revert subject is never an AI push, whatever it quotes — see note 4 and
  // REVERT_PREFIX above. Checked before AI_MARKER, not instead of it: a
  // bot-authored revert is still caught by the BOT_EMAILS check above this.
  if (!REVERT_PREFIX.test(subject) && AI_MARKER.test(subject)) {
    return { ...commit, kind: "ai", reason: "bp_assistant_marker" };
  }
  // Everything unrecognized — including a commit with no message and no author
  // at all — is a human edit, because that is the outcome that preserves
  // master's content. See FAIL-SAFE DIRECTION above.
  return { ...commit, kind: "human", reason: "unrecognized" };
}

// What the caller actually needs to decide with: did any HUMAN touch this file
// on master since the ancestor?
export interface MasterLineage {
  commits: ClassifiedCommit[];
  /** True when at least one commit classified `human`. */
  hasHumanCommit: boolean;
  /**
   * True when we could NOT prove we walked the whole range — the fetch failed,
   * or paging hit its cap before reaching `source_sha`. An incomplete lineage
   * must be treated exactly like a human commit downstream: we cannot rule one
   * out, and ruling one out wrongly is what reverts a maintainer's work. Kept
   * SEPARATE from hasHumanCommit so an alert can say which it measured rather
   * than claiming a human edit it never saw (the standing alert-wording rule).
   */
  incomplete: boolean;
  /** Why it is incomplete, for the alert. Empty when complete. */
  incompleteReason: string;
  /**
   * WHICH verses those human commits touched (#557), when that was measurable.
   * Absent or null means nobody narrowed, so the file-level answer stands —
   * which is the protective one. See the per-verse section at the bottom of
   * this file.
   */
  humanRefs?: HumanRefEvidence | null;
}

export function summarizeLineage(
  commits: ClassifiedCommit[],
  opts: { incomplete?: boolean; incompleteReason?: string; humanRefs?: HumanRefEvidence | null } = {},
): MasterLineage {
  return {
    commits,
    hasHumanCommit: commits.some((c) => c.kind === "human"),
    incomplete: opts.incomplete === true,
    incompleteReason: opts.incomplete === true ? (opts.incompleteReason ?? "unknown") : "",
    humanRefs: opts.humanRefs ?? null,
  };
}

// How many human commit shas a summary carries as evidence. The count is
// authoritative; this list exists so an alert can NAME what it measured instead
// of asserting it, and it rides through a Workflow step's serialized return
// value, so it must stay small.
export const LINEAGE_EVIDENCE_CAP = 5;

// One human commit's identity, as Door43 reported it (#684).
//
// THE BRACKET TRAP, stated here because this is the shape a display reads. The
// bot pushes on a named human's behalf with that person's username in the
// SUBJECT (`ULT: EZK 38 [pjoakes]`). `author` is the commit's own author field
// and nothing else — never the bracket. classifyMasterCommit already decides on
// the author, so a display that parsed the subject instead could name a person
// on a commit the classifier called `ai`, i.e. show identity for a commit whose
// content the system deliberately does not protect.
export interface LineageHumanCommit {
  sha: string;
  /** commit.author.name. Null when Gitea reported none. */
  author: string | null;
  /**
   * commit.author.date, the FULL ISO-8601 timestamp Door43 reported —
   * "2026-08-15T14:22:07Z", not "2026-08-15".
   *
   * Persisted at full precision deliberately (cold review F6). This value lands
   * in book_resource_syncs.master_lineage_json, which is the durable record an
   * incident is reconstructed from six weeks later, and the reconstructions in
   * this repo routinely hinge on INTRA-DAY ordering — which of two commits on
   * the same day came first, and whether it preceded or followed our own export.
   * A day-only field cannot answer that and cannot be widened after the fact.
   * The truncation to a day is a DISPLAY concern and happens only in
   * describeHumanCommits, via isoDay.
   */
  date: string | null;
}

// How many commits a user-facing message will NAME. The chip and the alert
// clamp to about two lines, so this is a display budget, not an evidence one —
// the summary still carries up to LINEAGE_EVIDENCE_CAP, and `counts.human` is
// the authoritative total, which is what the "+N more" tail is computed from.
//
// WHICH commits get named, since only some do (cold review F7). The list is
// newest-first (listMasterCommitsSince's own order, preserved through
// compactLineage), so this names the NEWEST few and folds the oldest into
// "+N more". Deliberate, not incidental: the most recent Door43 edit is the one
// whose content is on master right now and the one a translator opening the row
// will be looking at, and the tail still says how many older ones there were,
// so nothing is hidden — only deferred to the full record in
// master_lineage_json. An oldest-first display would name the commit least
// likely to explain what the reader is seeing.
export const LINEAGE_NAMED_COMMITS_MAX = 3;

// How much of an author's name a message will carry. Door43 commit author names
// are third-party input interpolated into a review reason, so they are clamped
// (cold review F4): the field is free text on Door43's side, and one very long
// name would eat the whole two-line chip and push the outcome and the remedy —
// the parts a translator has to act on — out of view.
const AUTHOR_NAME_MAX = 40;

// Unicode bidi isolates. An author name is arbitrary third-party text and this
// is a Bible-translation tool, so RTL names (Hebrew, Arabic, Persian) are an
// ordinary case, not an exotic one. Interpolated raw, an RTL name reorders the
// LTR text around it — the date and the sha that follow can visually jump to
// the other side of the name, so the message would attribute a commit to the
// wrong day or sha ON SCREEN while the stored string is correct. FSI…PDI makes
// each name its own bidi run, which is exactly what that hazard needs (cold
// review F4). Applied to the NAME only, never to our own words.
const FSI = "\u2068";
const PDI = "\u2069";

// Everything a name must not carry into a one-line message: C0/C1 controls
// (a newline would break the chip's two-line clamp outright) and the LEGACY
// bidi overrides/embeddings, which — unlike the isolates above — have no
// terminator of their own and can leak their direction into the rest of the
// sentence. The isolate pair we add ourselves is the sanctioned mechanism; a
// name is not allowed to bring its own.
const NAME_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * One author name, made safe to interpolate: controls stripped, whitespace
 * collapsed, clamped to AUTHOR_NAME_MAX, wrapped in bidi isolates. Null when
 * nothing legible survives, which reads the same as "Gitea reported no author".
 */
function displayAuthor(name: string | null | undefined): string | null {
  const flat = (name ?? "").replace(NAME_UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  // The ellipsis is inside the isolate so a clamped RTL name still renders as
  // one run. Array spread, not slice: a name ending in an emoji or any other
  // astral character must not be cut through the middle of a surrogate pair.
  const chars = [...flat];
  const clamped = chars.length > AUTHOR_NAME_MAX ? `${chars.slice(0, AUTHOR_NAME_MAX - 1).join("")}…` : flat;
  return `${FSI}${clamped}${PDI}`;
}

// Just the day, for display.
//
// This keeps the day AS DOOR43 REPORTED IT — commit.author.date carries the
// author's own UTC offset, and the leading 10 characters are therefore that
// person's local calendar day, not the UTC day (cold review F5). Deliberate:
// the reader is going to ask the named editor "what did you change on the
// 15th?", and the answer has to match the date THEY would give. A UTC
// normalization would silently shift a late-evening commit to the next day for
// editors east of Greenwich and to the previous day for those west of it. The
// full timestamp, offset included, is preserved in the persisted evidence (see
// LineageHumanCommit.date), so forensics never has to rely on this.
function isoDay(date: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((date ?? "").trim());
  return m ? m[1] : null;
}

// The one literal that introduces the identity clause, and the boundary a
// churn guard splits a reason on (cold review F1). Defined once, here, because
// two things depend on it being the SAME string: the clause builder below, and
// stripHumanCommitEvidence, which a dedup guard uses to compare two reasons
// while ignoring identity drift.
export const LINEAGE_EVIDENCE_LEAD = "Door43 edits to this file:";

/**
 * A review reason with its #684 identity clause removed (cold review F1).
 *
 * WHY A DEDUP GUARD MUST USE THIS. The identity clause is not stable across
 * nights the way the rest of a reason is: the commits named in it change
 * whenever Door43's history moves or the watermark the walk is bounded by
 * advances. A guard comparing whole reason strings would therefore see "the
 * message changed" on a row where nothing about the FINDING changed, rewrite
 * the flag, and bump the row's version — and a version bump on a row nobody
 * touched 409s the outbox op of any tab holding that row. Comparing the base
 * reason keeps the guard's decision exactly what it was before #684: identical
 * finding, no write.
 *
 * Applied to BOTH sides of a comparison. Also trims the trailing space the
 * clause is joined with, so "base." and "base. Door43 edits to this file: …"
 * compare equal.
 */
// `unknown` rather than `string | null`: the value on the other side of a
// comparison is a column read off a D1 row, which arrives untyped. Narrowing
// here keeps every call site from casting, and a non-string (a NULL column, a
// number from a malformed row) compares as "" — the answer that mints rather
// than suppresses, which is the protective direction for a guard.
export function stripHumanCommitEvidence(reason: unknown): string {
  const s = typeof reason === "string" ? reason : "";
  const i = s.indexOf(LINEAGE_EVIDENCE_LEAD);
  return (i < 0 ? s : s.slice(0, i)).trimEnd();
}

/**
 * The identity clause to append to a review reason, or `""` when nothing was
 * measured — " Door43 edits to this file: NAME on 2026-08-15 (a1b2c3d)."
 *
 * Callers append this and compare with stripHumanCommitEvidence; going through
 * one builder is what guarantees the delimiter the guard splits on is the
 * delimiter the text actually carries.
 *
 * ONE ACCEPTED COST, so nobody rediscovers it as a bug (cold review F2).
 * BookLintIndicator's popup collapses identical flags into one counted entry,
 * keyed on `check | message` (web/src/components/bookLintGrouping.ts). Two rows
 * flagged on DIFFERENT nights can now carry different identity clauses, so they
 * land in two groups where before they shared one. Accepted, because the
 * within-a-night case — the one that produced #653's 63-row JER pile the
 * grouping exists for — is unaffected: a lineage is measured once per (book,
 * resource) per run, so every row flagged by the same run carries the exact same
 * clause and still collapses into a single entry. The alternative, keying the
 * group on the stripped base reason, would hide from a translator that two
 * groups were caused by two different people, which is precisely the
 * information #684 exists to surface.
 */
export function humanCommitEvidenceClause(
  lineage: MasterLineage | MasterLineageSummary | null | undefined,
  max: number = LINEAGE_NAMED_COMMITS_MAX,
): string {
  const who = describeHumanCommits(lineage, max);
  return who ? ` ${LINEAGE_EVIDENCE_LEAD} ${who}.` : "";
}

/**
 * "justplainjane47 on 2026-08-15 (a1b2c3d)" for the human commits a lineage
 * MEASURED — or `""` when it measured none it can name (#684).
 *
 * Empty is the honest answer in every one of these cases, and each maps to a
 * caller keeping the wording it had before this existed:
 *   - no lineage at all (nobody walked master's history)
 *   - an INCOMPLETE walk (the standing rule: state only measured causes — an
 *     unfinished walk has not established who, or even that anyone, moved it)
 *   - a complete walk that found no human commit
 *   - a summary persisted before #684, which carries `humanShas` but no
 *     identity: something moved master, and we cannot say who from this record
 *
 * Repeated authors are named ONCE, with their dates gathered (cold review F4):
 * three commits by one person on one afternoon is one fact about one person, and
 * repeating the name three times spent the whole two-line chip saying it. So
 * "Stephen Wunrow on 2026-08-14 (b39f0c7), 2026-08-13 (aa12bc3)", never the
 * name twice. `max` still bounds the COMMITS named, not the people.
 *
 * Accepts either lineage shape. Pure — no fetch, no D1.
 */
export function describeHumanCommits(
  lineage: MasterLineage | MasterLineageSummary | null | undefined,
  max: number = LINEAGE_NAMED_COMMITS_MAX,
): string {
  if (lineage == null) return "";
  if (lineage.incomplete !== false) return "";
  if (lineage.hasHumanCommit !== true) return "";
  let entries: LineageHumanCommit[];
  let total: number;
  if ("commits" in lineage) {
    const humans = lineage.commits.filter((c) => c.kind === "human");
    total = humans.length;
    // Full timestamp, exactly as the compacted form carries it (F6) — isoDay is
    // applied below, at display, and in one place only.
    entries = humans.map((c) => ({ sha: c.sha, author: c.authorName ?? null, date: c.date ?? null }));
  } else {
    // The compacted form. `humanCommits` absent = pre-#684 snapshot.
    entries = lineage.humanCommits ?? [];
    total = lineage.counts?.human ?? entries.length;
  }
  // Grouped by displayed author, insertion-ordered (newest commit first — see
  // LINEAGE_NAMED_COMMITS_MAX on why newest). `named` counts COMMITS, so the
  // budget is spent on commits whether or not they share an author.
  const groups = new Map<string, { label: string; whens: { day: string | null; sha: string }[] }>();
  let named = 0;
  for (const e of entries) {
    if (named >= max) break;
    const day = isoDay(e.date);
    const short = (e.sha ?? "").slice(0, 7);
    const who = displayAuthor(e.author);
    // A bare sha names nobody and no when — it is not what this is for, and it
    // would read as identity while carrying none. Skipped, which can leave the
    // whole string empty and the caller on its prior wording.
    if (!who && !day) continue;
    named++;
    // Our own words when Door43 named no author, so they carry no isolates:
    // the hazard the isolates answer is third-party text, and wrapping a
    // literal would only make the stored string harder to read back.
    const label = who ?? "a Door43 editor";
    const g = groups.get(label);
    if (g) g.whens.push({ day, sha: short });
    else groups.set(label, { label, whens: [{ day, sha: short }] });
  }
  if (named === 0) return "";
  const parts: string[] = [];
  for (const g of groups.values()) {
    const whens = g.whens.map((w) => (w.day ? (w.sha ? `${w.day} (${w.sha})` : w.day) : `(${w.sha})`));
    // "on" only when there is a day to hang it on; a sha-only group reads
    // "NAME (a1b2c3d)".
    parts.push(g.whens.some((w) => w.day) ? `${g.label} on ${whens.join(", ")}` : `${g.label} ${whens.join(", ")}`);
  }
  // `total` is the count of human commits in the whole window, and `named`
  // counts commits rather than groups, so the tail never under-reports how many
  // there were — not even when three of them share one author.
  const extra = Math.max(0, total - named);
  return extra > 0 ? `${parts.join("; ")}; +${extra} more` : parts.join("; ");
}

// The compact form of a lineage — what actually travels from the one place that
// can fetch it (planAndStageBookResources, which already holds master's sha) to
// the merge call sites several Workflow steps later. A full MasterLineage can
// carry ~250 commits with their whole messages; a step return value must not.
//
// `mayHoldHumanEdit` is COMPUTED HERE, by the helper below, and never
// recomputed downstream: the fail-safe is "incomplete counts as human", and a
// consumer holding only the compacted booleans could reconstruct that wrong.
export interface MasterLineageSummary {
  /** masterMayHoldHumanEdit(lineage), evaluated once, at the fetch. */
  mayHoldHumanEdit: boolean;
  hasHumanCommit: boolean;
  incomplete: boolean;
  incompleteReason: string;
  counts: { ours: number; ai: number; human: number };
  /** Up to LINEAGE_EVIDENCE_CAP human commit shas, newest first. */
  humanShas: string[];
  /**
   * The SAME commits as `humanShas`, same cap and same order, with the identity
   * Door43 reported for each (#684). `humanShas` is kept alongside rather than
   * replaced: this field is ABSENT on every summary persisted to
   * book_resource_syncs.master_lineage_json before #684 shipped, and that column
   * is last-run-wins, so a reader must treat absent as "identity was not
   * measured" and fall back to the wording it used before. Nothing decides on
   * this — it exists so a flag or an alert can name who moved master instead of
   * saying only that something did.
   */
  humanCommits?: LineageHumanCommit[];
  /**
   * #557, the per-verse narrowing. TRUE only when every human commit in the
   * window was mapped, in full, to a bounded set of verse refs. Anything else —
   * one unparseable diff, one unmapped hunk, too many human commits to afford
   * the fetches, a ref set past LINEAGE_REF_CAP — leaves this false and the
   * file-level answer standing. Absent on a summary serialized before #557
   * shipped, which reads the same as false.
   */
  refsComplete?: boolean;
  /** The refs those human commits touched: "c:v", or "c:*" for a whole chapter. */
  humanRefs?: string[];
  /** Why the narrowing did not complete, for the log. Empty when it did. */
  refsReason?: string;
}

export function compactLineage(lineage: MasterLineage): MasterLineageSummary {
  const counts = { ours: 0, ai: 0, human: 0 };
  const humanShas: string[] = [];
  const humanCommits: LineageHumanCommit[] = [];
  for (const c of lineage.commits) {
    counts[c.kind]++;
    if (c.kind === "human" && humanShas.length < LINEAGE_EVIDENCE_CAP) {
      humanShas.push(c.sha);
      // #684. Same commits, same cap, same order — carried alongside the bare
      // shas rather than replacing them, because a persisted pre-#684 snapshot
      // has only the shas and every reader must still work off that.
      // The FULL timestamp, not the day (cold review F6): this is the persisted
      // forensic record, and intra-day ordering is what an incident
      // reconstruction needs. isoDay runs at display only.
      humanCommits.push({ sha: c.sha, author: c.authorName ?? null, date: c.date ?? null });
    }
  }
  const ev = lineage.humanRefs ?? null;
  return {
    mayHoldHumanEdit: masterMayHoldHumanEdit(lineage),
    hasHumanCommit: lineage.hasHumanCommit,
    incomplete: lineage.incomplete,
    incompleteReason: lineage.incompleteReason,
    counts,
    humanShas,
    humanCommits,
    // Narrowing evidence only crosses the boundary when it is COMPLETE. A
    // half-mapped ref set has no downstream use — masterMayHoldHumanEditForVerse
    // ignores it — and carrying it would only invite a future reader to treat
    // "the refs we did manage to map" as the whole truth.
    refsComplete: ev?.complete === true,
    humanRefs: ev?.complete === true ? ev.refs : [],
    refsReason: ev == null ? "not_measured" : ev.complete === true ? "" : ev.reason,
  };
}

// The single question the merge asks. Separated from the data so no call site
// can reconstruct the fail-safe wrong: an incomplete walk is NOT "no human
// found", and reading `hasHumanCommit` on its own would say exactly that.
//
// Accepts either form, and — deliberately — `undefined` as well as `null`: a
// caller that never looked, or one reading a field an in-flight Workflow's
// memoized step result simply does not carry, must land on the protective
// answer rather than on `!undefined`. Only a COMPLETE walk that found no human
// commit returns false, and only that answer lets D1 win a both-changed
// conflict.
export function masterMayHoldHumanEdit(
  lineage: MasterLineage | MasterLineageSummary | null | undefined,
): boolean {
  if (lineage == null) return true; // never looked -> assume a human did
  if ("mayHoldHumanEdit" in lineage) return lineage.mayHoldHumanEdit !== false;
  // Every comparison is `!== false`, never a truthiness test, so a malformed or
  // partially-deserialized object answers protectively instead of falling
  // through to `undefined`. `return a || b` on a missing field returns undefined
  // — which today's call sites happen to treat as master-wins because they test
  // `=== false`, but that is the callers being careful, not this function being
  // safe. Encode it here, where the rule lives.
  return lineage.incomplete !== false || lineage.hasHumanCommit !== false;
}

// ── WHICH VERSE did the human touch? (issue #557) ───────────────────────────
//
// Everything above answers "did a human touch this FILE". Applied per verse,
// that is far too broad, and the breadth is not theoretical: on 2026-08-13
// Richard Mahn pushed `Fixes s5 markers` (127cc1f3) and `Fixes USFM`
// (82aad43b) to en_ult/24-JER.usfm. Both land only in chapters 23 and 31 —
// measured from their own diffs, committed as fixtures in
// masterLineage.test.mjs — yet the file-level answer let them authorize
// reverting Grant_Ailie's app edits in JER ULT 40:5, 40:6 and 40:10.
//
// So: for each human commit, map its hunks to the verses they landed in, and
// let the merge ask about ITS verse. Same fail-safe direction as everything
// else in this module, and it is the whole safety argument here too: a diff we
// cannot parse, a hunk we cannot place, a file that does not line up with its
// own diff, a ref set too big to carry, or simply not having looked ALL leave
// `refsComplete` false, and a false there means the file-level answer stands —
// today's behavior, master wins. Narrowing is only ever allowed to fire on a
// positive, complete mapping. Nothing here can widen master's reach; it can
// only decline to widen it.
//
// THE ONE ASYMMETRY, stated because this module's whole argument is "never claim
// fewer refs than the commit touched": only the NEW side of a hunk is mapped.
// Content the human DELETED exists only on the old side, so a verse that a
// commit only removed lines from is claimed via the surrounding new-side lines
// rather than via the deleted text itself. In practice the new side still covers
// it — a modification puts `+` lines inside the verse's own span, git's default
// three lines of context bracket a pure deletion on both sides, and a
// zero-context deletion claims both lines of the join (see the newCount === 0
// branch below). Mapping the old side too would need the PARENT revision, i.e. a
// third fetch per commit, which the subrequest budget does not have. If a real
// under-claim is ever measured, that is the fix; nobody has produced one.
//
// Pure, like the rest of the module: the two fetches this needs (the commit's
// diff, and the file as it stood at that commit) live in dcsSources.ts.

// How many human commits in one window we are willing to map. Each one costs
// TWO subrequests — the commit's `.diff`, plus the file at that exact sha,
// which for a USFM is several MB (24-JER.usfm was 4.6 MB on 2026-08-24) — and
// the nightly path's budget is already tight against Cloudflare's ~1000
// subrequest cap (see dcsSources.ts's paging note and bookReimport.ts's
// batching). Three keeps the worst case at 6 extra subrequests per (book,
// resource) per run, on runs where master moved AND a human is in the window;
// it covers the measured JER case (two commits) with room for one more.
// Windows above the bound are not a failure — they fall back to the file-level
// answer, which is exactly what shipped before this.
export const LINEAGE_REFINE_MAX_HUMAN_COMMITS = 3;

// How many refs a summary will carry. It rides a Workflow step's serialized
// return value and is persisted to D1 (master_lineage_json), so it must stay
// small: 200 refs is ~1.8 KB of JSON. A human commit that touched more verses
// than this is a whole-file reformat, and "the human touched everything" is
// precisely the file-level answer — so overflowing degrades to it rather than
// truncating the set, which would silently un-protect the refs that fell off.
export const LINEAGE_REF_CAP = 200;

export interface HumanRefEvidence {
  /** True ONLY when every hunk of every human commit was mapped. */
  complete: boolean;
  /** "c:v" for one verse, "c:*" for a whole chapter. Empty when incomplete. */
  refs: string[];
  /** Why it is incomplete. Empty when complete. */
  reason: string;
}

/** One unified-diff hunk, new-side only — that is the side the fetched file is. */
export interface HunkRange {
  newStart: number;
  newCount: number;
}

const REF_INCOMPLETE = (reason: string): HumanRefEvidence => ({ complete: false, refs: [], reason });

// `\c 23` / `\v 5` / `\v 5-6`. The space after the letter is required, which is
// what keeps `\va` (alternate verse), `\vp` (published verse) and `\ca` out.
const CV_MARKER_RE = /\\(c|v) (\d+)(?:-(\d+))?/g;

// A verse bridge wider than this is not a bridge, it is a parse gone wrong.
const MAX_BRIDGE_WIDTH = 50;

// No real Bible chapter has anywhere near this many verses (PSA 119, the
// longest, has 176). A verse number past this is corrupt input, not a
// generous allowance — and it is load-bearing, not just a sanity check: a
// `for (let v = lo; v <= hi; v++)` loop over a verse number near
// Number.MAX_SAFE_INTEGER (2^53-1) can spin forever, because `v++` stops
// changing `v` once it exceeds the range floats can represent every integer
// in. `hi - lo > MAX_BRIDGE_WIDTH` does NOT catch a single huge verse number
// with no bridge (lo === hi, so the width is 0) — this bound is the one that
// does, and it is checked BEFORE any verse loop runs, in both
// refsTouchedInUsfm (a `\v` marker's own number) and parseTsvRefColumn (a TSV
// ref column's verse segment).
const MAX_VERSE_NUMBER = 999;

// Pull the new-side hunk ranges for ONE path out of a whole-commit unified
// diff. Real commits here touch several books at once (82aad43b touched
// 04-NUM, 24-JER and 33-MIC), so filtering by path is not an optimization —
// mapping another book's line numbers onto this book's file would place hunks
// in verses nobody touched.
//
// Every shape we cannot read returns incomplete: a header we cannot parse, a
// binary patch, a rename (the line numbers would be against a different file's
// history), or the path never appearing at all — the commits API already
// filtered to commits that touch it, so its absence means we are reading
// something other than what we asked for.
//
// AND THE BODY IS COUNTED, WHICH IS THIS FUNCTION'S ONLY COMPLETENESS PROOF.
// Measured 2026-08-24: Door43 serves `.diff` chunked, with NO Content-Length —
// so the transport layer has nothing to check a short read against, and a diff
// cut off mid-body arrives looking like a valid, smaller diff. That is not a
// theoretical failure: a two-hunk diff truncated before its second `@@` maps to
// a SMALLER ref set, and a missing ref is exactly what lets D1 overwrite a
// maintainer's edit. Refusing every header-less body would disable the feature
// outright (it is always header-less here), so completeness is proved from the
// content instead: each `@@ -a,b +c,d @@` declares how many lines follow it, and
// a truncated hunk comes up short. Mismatch — either direction — is
// `hunk_body_short`, which is incomplete, which is master-wins.
export function parseDiffHunksForPath(
  diff: string,
  path: string,
): { hunks: HunkRange[]; complete: boolean; reason: string } {
  if (typeof diff !== "string" || diff.length === 0) {
    return { hunks: [], complete: false, reason: "empty_diff" };
  }
  const lines = diff.split("\n");
  // A trailing newline splits into one empty element that is not a diff line.
  // Dropped so it cannot be miscounted as an (unprefixed) empty context line.
  if (lines[lines.length - 1] === "") lines.pop();

  const hunks: HunkRange[] = [];
  let inTarget = false;
  let sawTarget = false;
  // The hunk whose body we are counting, if any.
  let open: { range: HunkRange; oldCount: number; newCount: number; ctx: number; add: number; del: number } | null =
    null;

  // Close the open hunk, keeping it only if its body is exactly as long as its
  // header promised on BOTH sides.
  const closeHunk = (): boolean => {
    if (open === null) return true;
    const ok = open.ctx + open.add === open.newCount && open.ctx + open.del === open.oldCount;
    if (ok) hunks.push(open.range);
    open = null;
    return ok;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (!closeHunk()) return { hunks: [], complete: false, reason: "hunk_body_short" };
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) return { hunks: [], complete: false, reason: "unparseable_file_header" };
      const [, from, to] = m;
      inTarget = from === path || to === path;
      if (inTarget) {
        sawTarget = true;
        // A rename touching our path: the hunk numbers belong to a file that is
        // only partly this one. Refuse rather than map them.
        if (from !== to) return { hunks: [], complete: false, reason: "renamed_file" };
      }
      continue;
    }
    if (!inTarget) continue;
    if (line.startsWith("@@")) {
      if (!closeHunk()) return { hunks: [], complete: false, reason: "hunk_body_short" };
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!h) return { hunks: [], complete: false, reason: "unparseable_hunk_header" };
      // A side with no count means exactly one line (`+12` === `+12,1`).
      const oldCount = h[2] === undefined ? 1 : Number(h[2]);
      const newStart = Number(h[3]);
      const newCount = h[4] === undefined ? 1 : Number(h[4]);
      open = {
        range: { newStart, newCount },
        oldCount,
        newCount,
        ctx: 0,
        add: 0,
        del: 0,
      };
      continue;
    }
    if (open !== null) {
      // Body lines. A content line ALWAYS carries its ' ' / '+' / '-' prefix, so
      // a bare "" here is an empty context line some proxy stripped, and a
      // leading '\' is git's "\ No newline at end of file", which is a note
      // about the previous line rather than a line of its own.
      if (line === "" || line.startsWith(" ")) open.ctx++;
      else if (line.startsWith("+")) open.add++;
      else if (line.startsWith("-")) open.del++;
      else if (line.startsWith("\\")) continue;
      else return { hunks: [], complete: false, reason: "unparseable_hunk_body" };
      continue;
    }
    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      return { hunks: [], complete: false, reason: "binary_patch" };
    }
    if (line.startsWith("deleted file mode ")) {
      return { hunks: [], complete: false, reason: "file_deleted" };
    }
  }
  // The last hunk in the body is the one a truncated fetch cuts, so this close
  // is the one that matters most.
  if (!closeHunk()) return { hunks: [], complete: false, reason: "hunk_body_short" };
  if (!sawTarget) return { hunks: [], complete: false, reason: "path_not_in_diff" };
  return { hunks, complete: true, reason: "" };
}

// Map new-side hunk ranges onto the verses of the file AS IT STOOD AT THAT
// COMMIT. `fileText` must be that exact revision: line numbers from one commit
// against another commit's bytes place hunks in the wrong verses, silently. The
// bounds check below is the guard for that (a hunk running past the end of the
// file is the loud half of the mismatch), and the caller pins the fetch to the
// commit's full 40-char sha.
//
// DELIBERATELY OVER-BROAD, in the protective direction: a hunk's whole new-side
// span is claimed, context lines included, and a line is credited both to the
// verse in effect when it starts and to every verse it opens. Claiming a
// neighbouring verse costs nothing but today's behavior for that verse; missing
// one is the failure this exists to prevent.
export function refsTouchedInUsfm(fileText: string, hunks: HunkRange[]): HumanRefEvidence {
  if (typeof fileText !== "string" || fileText.length === 0) return REF_INCOMPLETE("empty_file");
  if (hunks.length === 0) return { complete: true, refs: [], reason: "" };

  const lines = fileText.split("\n");
  const spans: Array<[number, number]> = [];
  for (const h of hunks) {
    if (!Number.isInteger(h.newStart) || !Number.isInteger(h.newCount) || h.newStart < 0 || h.newCount < 0) {
      return REF_INCOMPLETE("bad_hunk_range");
    }
    if (h.newCount === 0) {
      // A pure deletion. `newStart` is the line the removed text sat AFTER, so
      // claim both sides of the join — the deleted text belonged to one of them.
      const lo = Math.max(1, h.newStart);
      if (lo > lines.length) return REF_INCOMPLETE("hunk_past_end_of_file");
      spans.push([lo, Math.min(lines.length, h.newStart + 1)]);
      continue;
    }
    const hi = h.newStart + h.newCount - 1;
    if (h.newStart < 1 || hi > lines.length) return REF_INCOMPLETE("hunk_past_end_of_file");
    spans.push([h.newStart, hi]);
  }
  spans.sort((a, b) => a[0] - b[0]);

  const refs = new Set<string>();
  let chapter = 0;
  let verseLo = -1; // -1 = no verse opened yet in this chapter
  let verseHi = -1;
  let si = 0;

  const claim = (): string | null => {
    if (chapter <= 0) return "before_first_chapter";
    if (verseLo < 0) {
      // Chapter front matter (\c, \s1, \p before the first \v). Which verse it
      // affects is not decidable from line position, so claim the chapter.
      // NOTE: a hunk that starts ON a chapter's first verse line claims `c:*`
      // too (the line's opening state is still front matter), which is
      // over-protective — and costs one slot, so a single chapter's effective
      // budget is LINEAGE_REF_CAP - 1. Both effects are in the safe direction.
      refs.add(`${chapter}:*`);
      return null;
    }
    for (let v = verseLo; v <= verseHi; v++) refs.add(`${chapter}:${v}`);
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    // Advance past spans that ended before this line.
    while (si < spans.length && spans[si][1] < lineNo) si++;
    if (si >= spans.length) break; // every hunk is behind us; the rest of the file cannot be claimed
    const covered = spans[si][0] <= lineNo && lineNo <= spans[si][1];
    const line = lines[i];
    const hasMarker = line.includes("\\c ") || line.includes("\\v ");
    if (!hasMarker) {
      if (covered && claim() !== null) return REF_INCOMPLETE("before_first_chapter");
      continue;
    }
    // The state at the START of the line is claimed first, then each marker on
    // the line updates the state and is claimed in turn — a line can both end
    // one verse and open the next (`…\zaln-e\*.` `\q1 \v 5 …` is one line in
    // real ULT).
    if (covered && claim() !== null) return REF_INCOMPLETE("before_first_chapter");
    for (const m of line.matchAll(CV_MARKER_RE)) {
      const n = Number(m[2]);
      if (!Number.isFinite(n)) return REF_INCOMPLETE("unparseable_marker");
      if (m[1] === "c") {
        chapter = n;
        verseLo = -1;
        verseHi = -1;
      } else {
        const end = m[3] === undefined ? n : Number(m[3]);
        // `n > MAX_VERSE_NUMBER` on its own (not just the bridge width) is
        // what stops `\v 9007199254740993` — a single verse, no bridge, so
        // `end - n === 0` never trips MAX_BRIDGE_WIDTH — from reaching the
        // `for` loop in claim() below, where a verse number that large makes
        // `v++` stop advancing and the loop never terminates.
        if (
          !Number.isFinite(end) ||
          end < n ||
          end - n > MAX_BRIDGE_WIDTH ||
          n > MAX_VERSE_NUMBER ||
          end > MAX_VERSE_NUMBER
        ) {
          return REF_INCOMPLETE("unparseable_verse_bridge");
        }
        verseLo = n;
        verseHi = end;
      }
      if (covered && claim() !== null) return REF_INCOMPLETE("before_first_chapter");
    }
    if (refs.size > LINEAGE_REF_CAP) return REF_INCOMPLETE("ref_cap_exceeded");
  }
  if (refs.size > LINEAGE_REF_CAP) return REF_INCOMPLETE("ref_cap_exceeded");
  // Hunks that mapped to nothing at all mean the walk never reached them —
  // an answer of "no verses touched" from a commit that demonstrably touched
  // the file is the one shape that must never narrow anything.
  if (refs.size === 0) return REF_INCOMPLETE("no_refs_mapped");
  return { complete: true, refs: [...refs], reason: "" };
}

// ── TSV per-row mapping (issue #607) ─────────────────────────────────────
//
// refsTouchedInUsfm has to WALK the file, because a USFM line does not carry
// its own verse — it inherits whatever \c/\v marker came before it. A TSV row
// has no such problem: its ref IS column 1 ("40:5", "40:5-6", "front:intro"),
// so the map is per-line and stateless. No state carried between lines, no
// walk — just read each covered line's own first column.
//
// Same contract as refsTouchedInUsfm (HumanRefEvidence, same over-broad-in-
// the-safe-direction posture, same requirement that `fileText` be the file AS
// IT STOOD AT THAT COMMIT), and the same fail-safe direction: a ref column
// that will not parse, a hunk past the end of the file, or a ref set past
// LINEAGE_REF_CAP all return incomplete rather than guess.

// One verse segment: a bare verse ("5") or a bridge ("5-6"). This is the unit
// a comma-separated ref column's verse part splits into — see
// parseTsvRefColumn below.
const TSV_VERSE_SEGMENT_RE = /^(\d+)(?:-(\d+))?$/;

// One ref column -> the "c:v" keys it claims. Measured against real corpus
// data (2026-08-27, en_tn/tn_PSA.tsv, 8,213 rows): 20 are a single bridge
// ("5:2-3") and 1 is a comma-separated verse list ("5:1,3,8,12") — both real
// shapes, not hypothetical, so both are parsed rather than left to fall back.
// A bridge expands to every verse it covers rather than claiming the whole
// chapter — narrower, and correct, because the ref ITSELF states the range;
// there is no hunk boundary to reason about the way refsTouchedInUsfm's
// chapter-front case has to. `front:intro` and `N:intro` both collapse to
// verse 0, matching parseTsvRow's own convention in bookReimport.ts (via
// importParsers.ts's refParts): the evidence computed here and the (chapter,
// verse) the merge call site looks it up by must agree on what "this row's
// verse" means, or a touched intro row would never be found.
//
// Fails CLOSED on any one bad segment — unlike importParsers.ts's
// coveredVersesFromRef (a display helper, which skips a malformed comma
// segment and keeps the rest), this module cannot afford to under-claim: one
// unparseable segment discards the WHOLE ref, which is incomplete, which is
// master-wins for the row it belongs to.
function parseTsvRefColumn(ref: string): string[] | null {
  const trimmed = ref.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return null;
  const chapterPart = trimmed.slice(0, colon);
  const versePart = trimmed.slice(colon + 1);
  if (chapterPart !== "front" && !/^\d+$/.test(chapterPart)) return null;
  const chapter = chapterPart === "front" ? 0 : Number(chapterPart);
  if (versePart === "intro") {
    const key = `${chapter}:0`;
    return REF_KEY_RE.test(key) ? [key] : null;
  }

  const refs: string[] = [];
  for (const rawSeg of versePart.split(",")) {
    const m = TSV_VERSE_SEGMENT_RE.exec(rawSeg.trim());
    if (!m) return null; // "intro" mixed with other segments, or plain garbage
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    // `lo`/`hi > MAX_VERSE_NUMBER` (not just the bridge width) is what stops
    // a single huge verse number with no dash ("999999999999999") — its
    // width is 0, so MAX_BRIDGE_WIDTH alone never catches it — from reaching
    // the `for` loop below, where `v++` stops advancing once `v` passes
    // Number.MAX_SAFE_INTEGER and the loop never terminates. See
    // MAX_VERSE_NUMBER's own comment.
    if (
      !Number.isFinite(lo) ||
      !Number.isFinite(hi) ||
      hi < lo ||
      hi - lo > MAX_BRIDGE_WIDTH ||
      lo > MAX_VERSE_NUMBER ||
      hi > MAX_VERSE_NUMBER
    ) {
      return null;
    }
    for (let v = lo; v <= hi; v++) {
      const key = `${chapter}:${v}`;
      // A chapter number so large it prints in scientific notation
      // ("1e+24:1") would otherwise sail through as `complete:true` with a
      // key the consumer (masterMayHoldHumanEditForVerse's own REF_KEY_RE
      // check, via refsFrom) silently discards — this catches it here
      // instead, so the evidence never claims a completeness it does not
      // have.
      if (!REF_KEY_RE.test(key)) return null;
      refs.push(key);
    }
  }
  return refs.length > 0 ? refs : null;
}

// Map new-side hunk ranges onto the TSV rows they touched. `fileText` must be
// that exact revision, same requirement as refsTouchedInUsfm and for the same
// reason (see its header comment). DELIBERATELY OVER-BROAD in the same way
// too: a hunk's whole new-side span is claimed, context lines included — a
// context line is a real row that existed at that revision, and claiming it
// costs nothing but today's behavior for that row.
export function refsTouchedInTsv(fileText: string, hunks: HunkRange[]): HumanRefEvidence {
  if (typeof fileText !== "string" || fileText.length === 0) return REF_INCOMPLETE("empty_file");
  if (hunks.length === 0) return { complete: true, refs: [], reason: "" };

  const lines = fileText.split("\n");
  // A trailing newline splits into one empty element that is not a row.
  if (lines[lines.length - 1] === "") lines.pop();

  const spans: Array<[number, number]> = [];
  for (const h of hunks) {
    if (!Number.isInteger(h.newStart) || !Number.isInteger(h.newCount) || h.newStart < 0 || h.newCount < 0) {
      return REF_INCOMPLETE("bad_hunk_range");
    }
    if (h.newCount === 0) {
      // A pure deletion. `newStart` is the line the removed row sat AFTER —
      // claim both surviving rows at the join, NOT because a deleted row's
      // own ref needs protecting (it does not: a row master deleted never
      // reaches applyTsvRows' merge loop for that ref, since prune handles a
      // gone id on its own path, not resolveEditedCandidates). It is because
      // the two rows still standing at that join are real rows that existed
      // at this revision, and if the human's edit landed on one of THEM — a
      // different row, sharing a ref with the one deleted here, that the
      // human never touched — under-claiming it would be the unprotective
      // failure this module exists to avoid.
      const lo = Math.max(1, h.newStart);
      if (lo > lines.length) return REF_INCOMPLETE("hunk_past_end_of_file");
      spans.push([lo, Math.min(lines.length, h.newStart + 1)]);
      continue;
    }
    const hi = h.newStart + h.newCount - 1;
    if (h.newStart < 1 || hi > lines.length) return REF_INCOMPLETE("hunk_past_end_of_file");
    spans.push([h.newStart, hi]);
  }

  const refs = new Set<string>();
  for (const [lo, hi] of spans) {
    for (let lineNo = lo; lineNo <= hi; lineNo++) {
      const line = lines[lineNo - 1];
      const tab = line.indexOf("\t");
      const refCol = tab === -1 ? line : line.slice(0, tab);
      const mapped = parseTsvRefColumn(refCol);
      if (mapped === null) return REF_INCOMPLETE("unparseable_ref_column");
      for (const r of mapped) refs.add(r);
      if (refs.size > LINEAGE_REF_CAP) return REF_INCOMPLETE("ref_cap_exceeded");
    }
  }
  // No "hunks touched nothing" guard here, unlike refsTouchedInUsfm: every
  // covered line either fails to parse (returned above) or contributes at
  // least one ref (parseTsvRefColumn never returns an empty array), so
  // `hunks.length > 0` guarantees `refs.size > 0` by construction — the shape
  // that guard exists to catch cannot occur on this per-line, stateless path.
  return { complete: true, refs: [...refs], reason: "" };
}

// Union the per-commit evidence. One incomplete part makes the whole window
// incomplete: the refs we DID map are not the whole set of verses a human
// touched, and treating them as if they were is the un-protective error.
export function mergeRefEvidence(parts: HumanRefEvidence[]): HumanRefEvidence {
  if (parts.length === 0) return REF_INCOMPLETE("no_evidence");
  const refs = new Set<string>();
  for (const p of parts) {
    if (p == null || p.complete !== true) return REF_INCOMPLETE(p?.reason || "incomplete_part");
    for (const r of p.refs) refs.add(r);
  }
  if (refs.size > LINEAGE_REF_CAP) return REF_INCOMPLETE("ref_cap_exceeded");
  return { complete: true, refs: [...refs], reason: "" };
}

// "40:5" or "40:*", and nothing else. Entries are validated rather than trusted:
// the set arrives through a Workflow step's JSON and out of a D1 text column, and
// a malformed entry silently fails every `includes` test — which is the
// NON-protective answer. One bad entry discards the whole set (see refsFrom).
const REF_KEY_RE = /^\d+:(?:\d+|\*)$/;

function validRefs(refs: unknown): string[] | null {
  if (!Array.isArray(refs)) return null;
  for (const r of refs) if (typeof r !== "string" || !REF_KEY_RE.test(r)) return null;
  return refs as string[];
}

function refsFrom(lineage: MasterLineage | MasterLineageSummary): HumanRefEvidence | null {
  if ("humanRefs" in lineage) {
    const hr = (lineage as { humanRefs?: unknown }).humanRefs;
    // The uncompacted lineage carries the evidence object itself.
    if (hr != null && !Array.isArray(hr) && typeof hr === "object") {
      const ev = hr as HumanRefEvidence;
      if (ev.complete !== true) return null;
      const refs = validRefs(ev.refs);
      return refs === null ? null : { complete: true, refs, reason: "" };
    }
    // The compacted summary carries the flattened pair.
    const complete = (lineage as MasterLineageSummary).refsComplete;
    if (complete === true) {
      const refs = validRefs(hr);
      if (refs !== null) return { complete: true, refs, reason: "" };
    }
  }
  return null;
}

/** Does this evidence claim (chapter, verse)? "c:*" claims the whole chapter. */
export function refEvidenceTouches(refs: string[], chapter: number, verse: number): boolean {
  return refs.includes(`${chapter}:*`) || refs.includes(`${chapter}:${verse}`);
}

// The per-verse form of masterMayHoldHumanEdit — what the verse merge asks now.
//
// It can only ever return the file-level answer or a NARROWER one, and only on
// complete positive evidence. Every other route returns true (master wins), the
// behavior that shipped before #557:
//   - the file-level answer is already false          -> false, nothing to narrow
//   - no lineage at all / an unparseable one          -> true
//   - the commit walk was incomplete                  -> true
//   - no per-verse evidence, or incomplete evidence   -> true
//   - a ref set holding anything that is not a ref    -> true
//   - human commits exist but mapped to zero refs     -> true (a mapping we do
//     not believe: the commits touched the file, so they touched some verse)
//
// `verseEnd` is for a BRIDGED row (a D1 verse covering 14-15, from `\v 14-15`).
// The whole range is asked, and ANY verse in it being human-touched protects the
// row — asking only about the start verse would leave a bridge unprotected when
// the human's hunk landed in its second half.
export function masterMayHoldHumanEditForVerse(
  lineage: MasterLineage | MasterLineageSummary | null | undefined,
  chapter: number,
  verse: number,
  verseEnd?: number | null,
): boolean {
  if (masterMayHoldHumanEdit(lineage) === false) return false;
  if (lineage == null) return true;
  if (lineage.incomplete !== false) return true;
  if (!Number.isInteger(chapter) || !Number.isInteger(verse) || chapter < 0 || verse < 0) return true;
  const ev = refsFrom(lineage);
  if (ev === null) return true;
  if (ev.refs.length === 0) return true;
  let end = verse;
  if (verseEnd != null) {
    // A bridge we cannot believe (backwards, absurd, or not a number) is not a
    // reason to narrow anything.
    if (!Number.isInteger(verseEnd) || verseEnd < verse || verseEnd - verse > MAX_BRIDGE_WIDTH) return true;
    end = verseEnd;
  }
  for (let v = verse; v <= end; v++) if (refEvidenceTouches(ev.refs, chapter, v)) return true;
  return false;
}

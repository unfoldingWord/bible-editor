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
// cite a single day's spot check of four files. They now rest on a corpus:
// 8,700 repo-wide commits across en_ult / en_ust / en_tn / en_tq / en_twl —
// roughly eight months of history, 51 distinct author emails — plus 2,727
// PATH-SCOPED commits across 18 files, path-scoped being the shape
// listMasterCommitsSince actually fetches. What it counted:
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
//     of them bot-authored, all of them a strict subset of the 807.
//   * OURS_PREFIX has zero false positives in 1,535 matches.
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
// 4. AI_MARKER is INERT in the history this module actually sees. It fires 339×
//    repo-wide and ZERO times path-scoped: all 339 are `Merge pull request …`
//    commits, and Gitea's path-scoped history simplification drops merge
//    commits. Keep it as a cheap net for a future bot pushing under a different
//    author — but do not credit it with doing work today.
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
  /** commit.author.name from Gitea. Diagnostic only — never classified on. */
  authorName?: string | null;
  /** commit.author.date, ISO-8601. Diagnostic only. */
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
// Three details are load-bearing, and each one is a measured exclusion rather
// than taste:
//   * the required CHAPTER DIGITS and the required BRACKET — either alone
//     excludes `TN: LAM chapter and book introductions` (3a2432b15b), a
//     hand-directed book-wide intro pass. Relax BOTH — i.e. fall back to a
//     loose `^(ULT|UST|TN|TQ|TWL):\s` prefix test — and that commit is stamped
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
// DELIBERATELY NOT ACCEPTED: the older `AI (ULT|UST|TN|TQ) for {BOOK} {CH}`
// vocabulary. It would keep four stale commits as `ai`, but nothing has used it
// since 2026-04-01, it appears under three non-bot identities, and one commit
// it would readmit is the defective run whose damage e417839d09 had to repair.
const AI_PIPELINE_SUBJECT =
  /^(ULT|UST|TN|TQ|TWL):\s+[1-3]?[A-Z]{2,3}\s+\d+(?::\d+(?:-\d+)?)?\s*\[[^\]]*\]\s*$/;

// bp-assistant's trailer, written into the commit BODY. An alternative SHAPE
// signal — never a standalone rule, always gated on the bot author email.
// Why the gate: 56fc2ec924 (2026-06-04, Stephen Wunrow) is a HUMAN
// `revert 682f8938… (#7036)` whose body quotes the reverted commit's subject
// AND its trailer. A trailer-only rule calls that human revert `ai` — the same
// species of trap as `Revert "bible-editor: …"` in note 1.
const AI_PIPELINE_TRAILER = /^X-AI-Pipeline:\s*bp-assistant\//m;

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
    if (AI_PIPELINE_TRAILER.test(message)) {
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
  if (AI_MARKER.test(subject)) {
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
}

export function summarizeLineage(
  commits: ClassifiedCommit[],
  opts: { incomplete?: boolean; incompleteReason?: string } = {},
): MasterLineage {
  return {
    commits,
    hasHumanCommit: commits.some((c) => c.kind === "human"),
    incomplete: opts.incomplete === true,
    incompleteReason: opts.incomplete === true ? (opts.incompleteReason ?? "unknown") : "",
  };
}

// How many human commit shas a summary carries as evidence. The count is
// authoritative; this list exists so an alert can NAME what it measured instead
// of asserting it, and it rides through a Workflow step's serialized return
// value, so it must stay small.
export const LINEAGE_EVIDENCE_CAP = 5;

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
}

export function compactLineage(lineage: MasterLineage): MasterLineageSummary {
  const counts = { ours: 0, ai: 0, human: 0 };
  const humanShas: string[] = [];
  for (const c of lineage.commits) {
    counts[c.kind]++;
    if (c.kind === "human" && humanShas.length < LINEAGE_EVIDENCE_CAP) humanShas.push(c.sha);
  }
  return {
    mayHoldHumanEdit: masterMayHoldHumanEdit(lineage),
    hasHumanCommit: lineage.hasHumanCommit,
    incomplete: lineage.incomplete,
    incompleteReason: lineage.incompleteReason,
    counts,
    humanShas,
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

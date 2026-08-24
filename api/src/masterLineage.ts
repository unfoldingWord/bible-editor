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
// commit's message and author, and the three producers are distinguishable —
// verified against real master history on 2026-08-19 (en_tq/tq_AMO.tsv,
// en_tn/tn_JER.tsv, en_ult/26-EZK.usfm, en_ust/24-JER.usfm):
//
//   OURS   `bible-editor: AMO tq → master (#815)`      the squash merge, and
//          `bible-editor export: JER ust → JER-be-Grant_Ailie (export-…)`
//          the branch commit, which also appears in master's file history once
//          the branch merges. Both are our own render; neither is anyone's edit.
//   AI     `TQ: AMO 5 [be..s@api.bp-assistant]`, authored by
//          `bot@unfoldingword.org`. bp-assistant writes the content.
//   HUMAN  everything else — richmahn, stephenwunrow, lrsallee, justplainjane47,
//          NateKreider, and Benjamin's own hand commits.
//
// THREE THINGS THE REAL DATA CHANGED, none of which were obvious up front:
//
// 1. `Revert "bible-editor: EZK ult → master (#6711)" (#6716)` is a REAL commit
//    on en_ult, authored by a human. A substring test for "bible-editor:" calls
//    it ours and silently drops a deliberate human revert out of the lineage —
//    so the prefix is anchored at the start of the message.
// 2. The bot also pushes on a human's behalf: `ULT: EZK 38 [pjoakes]` carries
//    the bot author but a plain username in the bracket. The content is still
//    machine-written, so the AUTHOR is the signal, not the bracket.
// 3. `login` is null on plenty of commits, human ones included
//    (`richmahn@users.noreply.github.com` with no login). Never key on it.
// 4. A human's OWN revert can quote a bp-assistant address without being an AI
//    push: Gitea's revert button emits `Revert "<original subject>"`, and a
//    maintainer reverting a bad AI push produces
//    `Revert "UST: JER 31 [Gr..e@api.bp-assistant]"` under their own (human)
//    author. AI_MARKER tests the subject only, so unguarded it would classify
//    that human revert `ai` and let the very content being reverted win a
//    both-changed conflict back over the maintainer (issue #612). Fixed with
//    the minimal option (excluding revert subjects from AI_MARKER, mirroring
//    note 1's OURS_PREFIX anchoring) rather than requiring a bot author for
//    AI_MARKER too: measured 2026-08-24, every AI_MARKER hit in the repo's
//    history is a MERGE commit, which Gitea's path-scoped file history drops —
//    so AI_MARKER already fires 0 times in the shape this classifier actually
//    sees, and retiring it outright was judged not worth losing its stated
//    role (recognizing a future bot under a different author) for a rule that
//    costs nothing today.
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
  | "ai" // bp-assistant / any bot-authored push
  | "human"; // a maintainer's own edit — and the fail-safe default

export interface MasterCommit {
  sha: string;
  /** Full commit message; only the first line is classified. */
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
// future bot that pushes under a different author is still recognized.
const AI_MARKER = /@api\.bp-assistant\b/;

// Gitea's revert-button format: `Revert "<original subject>"`. A HUMAN revert
// of a bp-assistant push quotes that push's subject verbatim, so AI_MARKER
// would otherwise fire on the human's own commit — reverting the very content
// the maintainer was trying to undo (issue #612). Mirrors OURS_PREFIX's
// anchoring rationale above: a pattern that only tests for a substring inside
// the subject cannot tell "this IS an ai push" from "this QUOTES one". Scoped
// to AI_MARKER only — a revert of one of OUR OWN exports is already handled
// above (OURS_PREFIX is anchored, so `Revert "bible-editor: …"` never matches
// it and correctly falls through to `human`).
const REVERT_PREFIX = /^Revert "/;

// The bot account that authors every bp-assistant push. This is the PRIMARY ai
// signal: it catches `ULT: EZK 38 [pjoakes]` (bot-authored, human-requested),
// whose content is still machine-written (see note 2 above).
const BOT_EMAILS = new Set(["bot@unfoldingword.org"]);

function firstLine(message: string | null): string {
  if (!message) return "";
  const nl = message.indexOf("\n");
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}

export function classifyMasterCommit(commit: MasterCommit): ClassifiedCommit {
  const subject = firstLine(commit.message);
  const email = (commit.authorEmail ?? "").trim().toLowerCase();

  // `ours` is checked FIRST. Our own export commits are authored under the
  // account that opened the PR (a human's, since the DCS merge bot squashes
  // under the PR author), so an author-first order would call every one of them
  // a human edit and defeat the whole point.
  if (OURS_PREFIX.test(subject)) {
    return { ...commit, kind: "ours", reason: "bible_editor_export_message" };
  }
  if (email && BOT_EMAILS.has(email)) {
    return { ...commit, kind: "ai", reason: "bot_author_email" };
  }
  if (AI_MARKER.test(subject) && !REVERT_PREFIX.test(subject)) {
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

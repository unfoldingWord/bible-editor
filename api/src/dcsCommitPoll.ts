// Continuous polling of the tracked Door43 repos' master branches into the
// dcs_commits ledger (issue #685).
//
// WHAT THIS BUYS. Until now the only thing that looked at Door43 was the
// nightly sync, and it looked at one file at a time, kept counts, and threw the
// commits away. So "who changed what over there, and when" was answerable for
// about as long as one Workflow step, and a Door43 change was invisible until
// the next 05:30 tick. This walks each repo's master history on the existing
// 5-minute cron and writes one durable row per (repo, sha), classified by
// classifyMasterCommit — the same classifier the nightly walk uses, imported,
// not re-implemented.
//
// WHAT IT DELIBERATELY DOES NOT DO. Nothing reads this table to make a gating
// decision yet. masterLineage still walks Door43 live; the ledger has to prove
// contiguous coverage of a window before anything trusts it, and the one thing
// that can break contiguity is recorded rather than hidden (see the gap note on
// GAP HANDLING below).
//
// ── BUDGET ────────────────────────────────────────────────────────────────────
// Five repos. Per repo per poll: at most DCS_POLL_PAGE_LIMIT (4) fetches, and
// the page size is fixed at 50 SERVER-SIDE (`limit` is ignored — measured; see
// the long comment on listMasterCommitsSince), so 4 pages is exactly the ~200
// commits/tick the issue asked for. Worst case for a whole tick is 5 × 4 = 20
// subrequests against Cloudflare's ~1000 cap, and the steady-state case is 5
// (one page each, stopping on the high-water sha). Self-rate-limited to one real
// poll per repo per DCS_POLL_INTERVAL_SECONDS (30 min), so the 5-minute cron
// tick that finds nothing due costs ONE D1 read and zero fetches.
//
// ── BOOTSTRAP ─────────────────────────────────────────────────────────────────
// A repo with no high-water mark is walked back DCS_POLL_BOOTSTRAP_SECONDS
// (30 days), still under the same 4-page cap. That cap binds in practice, and
// on purpose: en_tn's master holds 36,111 commits across 723 pages (measured
// 2026-09-01), so an unbounded first walk would be ~723 subrequests for one
// repo. The first poll therefore ingests the newest ≤200 commits inside the
// window, records where it stopped in dcs_repo_polls.gap_since_sha, and moves
// on. Deeper history is a backfill job, not a cron tick.
//
// ── GAP HANDLING ──────────────────────────────────────────────────────────────
// listMasterCommitsSince reports `incomplete` for a page cap, a force-pushed
// (unreachable) high-water sha, and every transport failure. Those split two
// ways here:
//   * TRANSPORT failure (http_*, fetch_failed, bad_body, commit_without_sha) —
//     insert whatever arrived (rows are keyed (repo, sha), so a partial page is
//     just an early version of the same truth) and LEAVE the high-water mark
//     alone. The next interval re-walks the same range and completes it.
//   * page_cap / source_sha_not_in_history — the range is real but longer than
//     one tick's budget, or the old mark is not on master any more. Advance the
//     mark to the new tip anyway and record gap_since_sha. Refusing to advance
//     here is the livelock: the same 200 commits would be re-fetched every
//     interval forever and the ledger would never see a new commit again.
//     Bounded, recorded loss beats an unbounded stall.

import type { Env } from "./index";
import { listMasterCommitsSince, TRACKED_DCS_REPOS } from "./dcsSources.ts";
import { classifyMasterCommit, OURS_PREFIX, type MasterCommit, type ClassifiedCommit } from "./masterLineage.ts";

/** One real poll per repo per this many seconds (the 5-min cron just checks). */
export const DCS_POLL_INTERVAL_SECONDS = 30 * 60;
/** Pages per repo per poll. 50 commits/page server-side → ~200 commits. */
export const DCS_POLL_PAGE_LIMIT = 4;
/** Defensive row cap per repo per poll, independent of the page math above. */
export const DCS_POLL_COMMIT_CAP = 200;
/**
 * Statements per env.DB.batch() write. D1 caps a batch at 100 statements —
 * same constraint, same reason, as bookImport.ts's CHUNK (80) and
 * bookReimport.ts's WRITE_BATCH (90). 80 leaves room for the poll-state upsert
 * that rides in the final chunk (81 worst case) and stays clear of the cap.
 */
export const DCS_POLL_WRITE_BATCH = 80;
/**
 * Per-fetch timeout (review finding F14). Without it a hanging Door43 holds the
 * whole scheduled invocation, and this poller shares its tick with the pipeline
 * poll, the stale-lock sweep and the hourly edit_log retention sweep — none of
 * which should be starved by one slow upstream. 20s × 4 pages is still a
 * generous ceiling, and an abort is just `fetch_failed`, which already means
 * "do not advance the mark, retry next interval".
 */
export const DCS_POLL_FETCH_TIMEOUT_MS = 20_000;
/** How far back a never-polled repo is seeded. */
export const DCS_POLL_BOOTSTRAP_SECONDS = 30 * 86400;
/**
 * Max paths recorded in files_json. A normal push touches one file (measured:
 * every commit on en_tn page 1 touched exactly one). A mass rename or a repo-
 * wide reformat touches thousands, and the ledger is not the place to store
 * them — the count is what a reader needs at that point.
 */
export const DCS_POLL_MAX_FILES = 50;

export interface DcsPollStateRow {
  repo: string;
  last_sha: string | null;
  last_committed_at: number | null;
  last_attempted_at: number | null;
  last_success_at: number | null;
  last_status: string | null;
  gap_since_sha: string | null;
  gap_at: number | null;
}

/**
 * Is this repo due for a real poll? A missing row is due (never polled).
 * `last_attempted_at` — not `last_success_at` — is the key, so a repo whose
 * Door43 fetches are failing retries once per interval instead of on every
 * 5-minute tick.
 */
export function repoNeedsPoll(
  state: DcsPollStateRow | null | undefined,
  nowSeconds: number,
  intervalSeconds: number = DCS_POLL_INTERVAL_SECONDS,
): boolean {
  if (!state) return true;
  const last = state.last_attempted_at;
  if (last == null || !Number.isFinite(last)) return true;
  return nowSeconds - last >= intervalSeconds;
}

/**
 * The boundary to walk to: the stored sha, or the bootstrap time window.
 *
 * KNOWN LIMIT OF THE TIME BOUND (review finding F2, documented not fixed).
 * listMasterCommitsSince ends a time-bounded walk at the first commit whose
 * AUTHOR date predates `sinceTime`, and repo-scoped history is not sorted by
 * author date — a rebased or cherry-picked commit carries an old author date
 * while sitting near the tip. So a bootstrap walk can terminate early, on that
 * one commit, and report `incomplete: false`: no gap is recorded, because the
 * walker genuinely believes it reached the far side of the range. The blast
 * radius is bounded to BOOTSTRAP only (every later poll uses the sha bound,
 * which is exact) and the loss is old history, never a new commit. Fixing it
 * properly means bounding on committer date, which the walker cannot do without
 * changing what gating reads — hence a follow-up issue rather than a change
 * here.
 */
export function pollBounds(
  state: DcsPollStateRow | null | undefined,
  nowSeconds: number,
): { sinceSha: string | null; sinceTime: number | null } {
  const sha = state?.last_sha ?? null;
  if (sha) return { sinceSha: sha, sinceTime: null };
  return { sinceSha: null, sinceTime: nowSeconds - DCS_POLL_BOOTSTRAP_SECONDS };
}

export interface LedgerRow {
  repo: string;
  sha: string;
  parentSha: string | null;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: number | null;
  subject: string | null;
  classification: ClassifiedCommit["kind"];
  reason: string;
  filesJson: string | null;
}

/** First line only — the ledger stores the subject, never the body. */
function subjectOf(message: string | null | undefined): string | null {
  if (message == null) return null;
  const nl = message.indexOf("\n");
  return (nl === -1 ? message : message.slice(0, nl)).trimEnd();
}

// Gitea's own merge-commit subject: `Merge pull request '<inner subject>' (#N)
// from <branch> into master`. Measured verbatim on git.door43.org 2026-09-01.
const MERGE_SUBJECT = /^Merge pull request\s+['"](.+)['"]\s*\(#\d+\)/;

// The AI pipeline's PR-title grammar (issue #696): `AI (ULT|UST|TN|TQ) for
// {BOOK} {CH} [name]`. This is the SAME "older" vocabulary
// masterLineage.ts's AI_PIPELINE_SUBJECT deliberately excludes — see that
// constant's own comment. There it is checked against a DIRECT commit
// subject in PATH-scoped history, measured to appear under three non-bot
// identities, so accepting it there risks stamping a hand-typed commit `ai`.
// Here it is checked ONLY against the INNER subject of an already-unwrapped
// MERGE commit, which is different data: nobody hand-types a real Door43 PR
// titled literally "AI UST for EZK 39 [pjoakes]" and merges it under their
// own account through Gitea's ordinary merge button. Every repo-scoped
// sample of this shape (2026-09-01, en_ust + en_ult) is a
// "Merge pull request '...'" envelope — the PR itself opened and merged by
// the bot pipeline. Same text, different context; not a contradiction of the
// exclusion above.
//
// Same book-code/digits/bracket/end-anchor shape as AI_PIPELINE_SUBJECT, for
// the same reasons (see that constant's comment): a looser match would
// accept more than has ever been measured.
const AI_PIPELINE_MERGE_TITLE =
  /^AI\s+(?:ULT|UST|TN|TQ)\s+for\s+(?:[1-3][A-Z]{2}|[A-Z]{3})\s+\d+\s*\[[^\]]*\]\s*$/;

/**
 * LEDGER-LOCAL classification. Wraps classifyMasterCommit; never replaces it,
 * and does not touch it — the gating paths share that function and its rules
 * rest on a measured 46,802-commit corpus of PATH-scoped history.
 *
 * WHY A WRAPPER IS NEEDED HERE (review finding F4, and it is the common case,
 * not an edge). This poller walks REPO-scoped history, which is full of Gitea
 * merge commits that path-scoped history mostly hides. classifyMasterCommit's
 * `ours` test is anchored at the start of the subject — deliberately, so that a
 * human `Revert "bible-editor: …"` cannot be misread as our own export — and an
 * anchored test cannot see through a `Merge pull request '…'` wrapper. MEASURED
 * over the newest 1,000 commits of en_ult + en_tn (2026-09-01): 262 are merge
 * commits and 113 of those wrap one of our own exports, e.g.
 *
 *     Merge pull request 'bible-editor: LAM ult → master' (#6555) from LAM-be into master
 *
 * Every one of those 113 would be recorded as a HUMAN maintainer's edit — in a
 * table whose entire purpose is saying who did what. So: unwrap the merge
 * subject, and if the INNER subject is one of ours, say `ours`. Anything else
 * defers to classifyMasterCommit on the FULL subject, which is what keeps the
 * existing rules in charge: a merge of a bp-assistant push still reaches
 * AI_MARKER, and `Revert "Merge pull request '…'"` never matches the anchored
 * MERGE_SUBJECT at all, so it stays human.
 *
 * issue #696 adds a THIRD, LAST-RESORT check, tried only when the above still
 * says `human`: an AI-pipeline PR merge
 * ("Merge pull request 'AI UST for EZK 39 [pjoakes]' (#N) …") carries neither
 * our export prefix nor the bp-assistant marker anywhere in the full subject
 * — the bracket names the requesting translator, not the bot — so it used to
 * fall all the way through. See AI_PIPELINE_MERGE_TITLE's own comment for why
 * that shape is safe to accept here specifically, even though the shared
 * classifier deliberately excludes it for direct (non-merge) subjects. Tried
 * last, not alongside `ours`, so a merge classifyMasterCommit already
 * resolves via AI_MARKER keeps that more specific reason.
 *
 * The wrapper only ever moves a commit human → ours/ai, i.e. it can only ever
 * REMOVE our own machine's or the bot pipeline's pushes from the human
 * column. It cannot mask a real maintainer edit, because a maintainer's
 * subject does not contain our export prefix or the pipeline's PR-title
 * grammar inside a merge wrapper.
 */
export function classifyForLedger(commit: MasterCommit): { kind: ClassifiedCommit["kind"]; reason: string } {
  const subject = subjectOf(commit.message) ?? "";
  const merge = MERGE_SUBJECT.exec(subject);
  if (merge && OURS_PREFIX.test(merge[1])) {
    return { kind: "ours", reason: "merge_of_bible_editor_export" };
  }
  const classified = classifyMasterCommit(commit);
  // Fallback only — checked after classifyMasterCommit, not before, so a
  // merge that classifyMasterCommit already resolves via AI_MARKER on the
  // FULL subject (e.g. a bracket that itself quotes the bp-assistant address)
  // keeps that more specific reason. This only fires when the full-subject
  // rules found nothing, i.e. exactly the #696 gap: an inner subject with the
  // pipeline's PR-title grammar but no marker text anywhere in the envelope.
  if (merge && classified.kind === "human" && AI_PIPELINE_MERGE_TITLE.test(merge[1])) {
    return { kind: "ai", reason: "merge_of_ai_pipeline_pr" };
  }
  return { kind: classified.kind, reason: classified.reason };
}

/**
 * Turn one walk's commits into ledger rows. Pure. The cap is applied to the
 * NEWEST commits (the array is newest-first) so a truncated walk still leaves
 * the tip contiguous with the mark we then store — and `dropped` reports
 * whether it actually cut anything, because a silent truncation would be a
 * coverage hole indistinguishable from complete data (review finding F7). The
 * cap is normally unreachable (4 pages × 50 = exactly 200), so a non-zero
 * `dropped` means Gitea's page size changed under us; the caller records it the
 * same way it records a page cap rather than discarding the difference.
 */
export function ledgerRowsFromCommits(
  repo: string,
  commits: MasterCommit[],
  cap: number = DCS_POLL_COMMIT_CAP,
): { rows: LedgerRow[]; dropped: number } {
  const kept = commits.slice(0, cap);
  const rows = kept.map((c) => {
    const classified = classifyForLedger(c);
    // COMMITTER date first (review finding F6): the ledger's question is "when
    // did this land on master", and author date answers "when was it first
    // written" — different on every rebase, cherry-pick and squash merge, which
    // is most of how work reaches these repos. Author date is the fallback for
    // a payload without a committer block.
    const at = Date.parse(c.committerDate ?? c.date ?? "");
    const files = c.files;
    return {
      repo,
      sha: c.sha,
      parentSha: c.parentSha ?? null,
      authorName: c.authorName ?? null,
      authorEmail: c.authorEmail ?? null,
      committedAt: Number.isFinite(at) ? Math.floor(at / 1000) : null,
      subject: subjectOf(c.message),
      classification: classified.kind,
      reason: classified.reason,
      filesJson: files == null ? null : JSON.stringify(files.slice(0, DCS_POLL_MAX_FILES)),
    };
  });
  return { rows, dropped: commits.length - kept.length };
}

/**
 * Whether an incomplete walk should still advance the high-water mark. See
 * GAP HANDLING at the top: a budget/history problem advances (and records the
 * gap), a transport problem does not.
 */
export function advancesDespiteIncomplete(reason: string): boolean {
  return reason === "page_cap" || reason === "source_sha_not_in_history";
}

const INSERT_COMMIT_SQL = `INSERT INTO dcs_commits
   (repo, sha, parent_sha, author_name, author_email, committed_at, message,
    classification, classification_reason, files_json, seen_at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
 ON CONFLICT (repo, sha) DO NOTHING`;

// ATTEMPT CLAIM (review finding F1). Written BEFORE the walk, in its own tiny
// batch-free statement, because the alternative was a fetch loop with no exit:
// last_attempted_at used to be stamped only by the results upsert in the FINAL
// write batch, so ANY write failure — a D1 outage, or simply the migration not
// yet applied in prod — left the stamp unwritten, every repo permanently "due",
// and all five re-polled on every 5-minute tick forever. Claiming the attempt
// first inverts that: a broken write path costs one poll per repo per interval,
// which is the same cost as a broken Door43.
const CLAIM_ATTEMPT_SQL = `INSERT INTO dcs_repo_polls (repo, last_attempted_at)
 VALUES (?1, ?2)
 ON CONFLICT (repo) DO UPDATE SET last_attempted_at = excluded.last_attempted_at`;

const UPSERT_POLL_SQL = `INSERT INTO dcs_repo_polls
   (repo, last_sha, last_committed_at, last_attempted_at, last_success_at,
    last_status, gap_since_sha, gap_at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
 ON CONFLICT (repo) DO UPDATE SET
   -- ?9 = "the ingest completed, advance the mark". last_sha and
   -- last_committed_at move TOGETHER off that one flag (review finding F12):
   -- COALESCEing them independently let a tip with an unparseable date write
   -- the new sha while keeping the PREVIOUS commit's timestamp, so the pair
   -- described two different commits. A null date for the current tip is the
   -- honest answer; a stale one from another commit is not.
   last_sha = CASE WHEN ?9 = 1 THEN excluded.last_sha ELSE dcs_repo_polls.last_sha END,
   last_committed_at = CASE WHEN ?9 = 1 THEN excluded.last_committed_at ELSE dcs_repo_polls.last_committed_at END,
   last_attempted_at = excluded.last_attempted_at,
   last_success_at = COALESCE(excluded.last_success_at, dcs_repo_polls.last_success_at),
   last_status = excluded.last_status,
   -- OLDEST unresolved gap WINS (review finding F3). The COALESCE used to run
   -- the other way and let each new gap overwrite the previous one, so a repo
   -- that hit its page cap twice reported only the second hole and looked more
   -- contiguous than it was. Coverage claims must err conservative: the field
   -- means "history below this sha is not proven contiguous", and only a
   -- backfill that actually closes the hole may clear it (no code clears it
   -- today — that is the follow-up this table is shaped for). Set as a pair
   -- with gap_at, for the same reason as last_sha/last_committed_at above.
   gap_since_sha = CASE WHEN dcs_repo_polls.gap_since_sha IS NULL
                          THEN excluded.gap_since_sha ELSE dcs_repo_polls.gap_since_sha END,
   gap_at = CASE WHEN dcs_repo_polls.gap_since_sha IS NULL
                   THEN excluded.gap_at ELSE dcs_repo_polls.gap_at END`;

export interface RepoPollResult {
  repo: string;
  polled: boolean;
  fetched: number;
  inserted: number;
  status: string;
  advanced: boolean;
  gapSince: string | null;
}

/**
 * Poll one repo. Exported for a targeted admin/manual run; the cron entry point
 * is pollDcsCommits below.
 */
export async function pollDcsRepo(env: Env, repo: string, nowSeconds: number): Promise<RepoPollResult> {
  const state = await env.DB.prepare(
    `SELECT repo, last_sha, last_committed_at, last_attempted_at, last_success_at,
            last_status, gap_since_sha, gap_at
       FROM dcs_repo_polls WHERE repo = ?1`,
  )
    .bind(repo)
    .first<DcsPollStateRow>();

  if (!repoNeedsPoll(state, nowSeconds)) {
    return { repo, polled: false, fetched: 0, inserted: 0, status: "not_due", advanced: false, gapSince: null };
  }

  // Claim the attempt BEFORE spending a single fetch. See CLAIM_ATTEMPT_SQL.
  await env.DB.prepare(CLAIM_ATTEMPT_SQL).bind(repo, nowSeconds).run();

  const { sinceSha, sinceTime } = pollBounds(state, nowSeconds);
  const page = await listMasterCommitsSince(env, repo, null, sinceSha, {
    pageLimit: DCS_POLL_PAGE_LIMIT,
    sinceTime,
    files: true,
    timeoutMs: DCS_POLL_FETCH_TIMEOUT_MS,
  });

  const { rows, dropped } = ledgerRowsFromCommits(repo, page.commits);
  // A defensive-cap truncation is a coverage hole exactly like a page cap, and
  // must be recorded as one rather than discarded (review finding F7). It can
  // only happen if Gitea's fixed 50-per-page changes under us, so it also
  // doubles as the alarm for that.
  const status = dropped > 0 ? "commit_cap" : page.incomplete ? page.incompleteReason || "incomplete" : "ok";
  const advance = dropped > 0 || !page.incomplete || advancesDespiteIncomplete(page.incompleteReason);
  // The tip is rows[0] — the walk is newest-first.
  const tip = rows[0] ?? null;
  const gapSince =
    dropped > 0 || (page.incomplete && advancesDespiteIncomplete(page.incompleteReason))
      ? (sinceSha ?? rows[rows.length - 1]?.sha ?? null)
      : null;

  // CHUNKED, because D1 caps a batch at 100 statements (documented at
  // bookImport.ts's CHUNK and bookReimport.ts's WRITE_BATCH). A single batch of
  // every insert plus the poll upsert would be up to 201 statements and would
  // fail ATOMICALLY on the most important path there is — the bootstrap poll,
  // which is 4 pages × 50 by design. Nothing would be ingested, the watermark
  // would never advance, and every following tick would repeat the same failure
  // forever. Caught in review of #685 before it shipped; the mock D1 in the
  // tests now enforces the cap so the next version of this mistake fails loudly.
  //
  // OLDEST-FIRST. `rows` is newest-first (the walk order); inserts go out in
  // reverse, so whatever lands before a mid-poll failure is a CONTIGUOUS run
  // upward from the existing high-water mark, never an island below the tip
  // with a hole under it.
  const ordered = [...rows].reverse();
  const insertStatements = ordered.map((r) =>
    env.DB.prepare(INSERT_COMMIT_SQL).bind(
      r.repo,
      r.sha,
      r.parentSha,
      r.authorName,
      r.authorEmail,
      r.committedAt,
      r.subject,
      r.classification,
      r.reason,
      r.filesJson,
      nowSeconds,
    ),
  );
  const pollStatement = env.DB.prepare(UPSERT_POLL_SQL).bind(
    repo,
    // The pair travels together and the ?9 flag below decides whether it lands
    // — see UPSERT_POLL_SQL. `tip?.committedAt` may legitimately be null.
    tip?.sha ?? null,
    tip?.committedAt ?? null,
    nowSeconds,
    page.incomplete && !advance ? null : nowSeconds,
    status,
    gapSince,
    gapSince ? nowSeconds : null,
    // ?9 — advance the (last_sha, last_committed_at) pair, or leave both.
    advance ? 1 : 0,
  );

  // The poll upsert rides in the LAST chunk, so the watermark can only advance
  // in the same transaction that finishes the ingest. An earlier chunk failing
  // therefore leaves the mark where it was, and the next interval re-walks the
  // same range — safe, because every insert is ON CONFLICT DO NOTHING, so a
  // re-walk re-inserts what is missing and leaves what landed untouched. The
  // alternative (stamping a watermark per chunk) would need its own partial
  // status vocabulary to earn nothing: a chunk failing here means D1 is
  // erroring, and re-walking is the right answer to that anyway.
  const chunks: (typeof pollStatement)[][] = [];
  for (let i = 0; i < insertStatements.length; i += DCS_POLL_WRITE_BATCH) {
    chunks.push(insertStatements.slice(i, i + DCS_POLL_WRITE_BATCH));
  }
  if (chunks.length === 0) chunks.push([]);
  chunks[chunks.length - 1].push(pollStatement);
  for (const chunk of chunks) {
    await env.DB.batch(chunk);
  }

  return {
    repo,
    polled: true,
    fetched: page.commits.length,
    inserted: rows.length,
    status,
    advanced: advance,
    gapSince,
  };
}

/**
 * Cron entry point. Sequential, not Promise.all: five repos at ≤4 fetches each
 * is nowhere near needing concurrency, and serial keeps the subrequest and D1
 * pressure of one tick flat and predictable. A failure on one repo must not
 * skip the rest, so each is wrapped.
 *
 * NO IN-FLIGHT LOCK, deliberately (review finding F13). Two overlapping
 * scheduled invocations — a retry, or a slow tick still running when the next
 * fires — can both decide the same repo is due and walk it twice. That is
 * WASTE, not corruption: the attempt claim makes the second one see a fresh
 * last_attempted_at in most orderings, every insert is ON CONFLICT DO NOTHING,
 * and the watermark can only move forward to a tip both walks would agree on.
 * The worst case is a few duplicated fetches. A real lock (a claim row with an
 * expiry, plus the stale-lock sweep it would then need — see
 * book_import_locks) costs more moving parts than the waste it prevents.
 */
export async function pollDcsCommits(env: Env, nowSeconds?: number): Promise<RepoPollResult[]> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const out: RepoPollResult[] = [];
  for (const repo of TRACKED_DCS_REPOS) {
    try {
      out.push(await pollDcsRepo(env, repo, now));
    } catch (e) {
      console.error("dcs commit poll failed", repo, e instanceof Error ? e.message : String(e));
      out.push({ repo, polled: true, fetched: 0, inserted: 0, status: "error", advanced: false, gapSince: null });
    }
  }
  return out;
}

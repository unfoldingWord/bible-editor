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
import { classifyMasterCommit, type MasterCommit, type ClassifiedCommit } from "./masterLineage.ts";

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

/** The boundary to walk to: the stored sha, or the bootstrap time window. */
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

/**
 * Turn one walk's commits into ledger rows. Pure — the classification is
 * whatever classifyMasterCommit says, with no second opinion applied here, and
 * the cap is applied to the NEWEST commits (the array is newest-first) so a
 * truncated walk still leaves the tip contiguous with the mark we then store.
 */
export function ledgerRowsFromCommits(
  repo: string,
  commits: MasterCommit[],
  cap: number = DCS_POLL_COMMIT_CAP,
): LedgerRow[] {
  return commits.slice(0, cap).map((c) => {
    const classified = classifyMasterCommit(c);
    const at = typeof c.date === "string" ? Date.parse(c.date) : NaN;
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

const UPSERT_POLL_SQL = `INSERT INTO dcs_repo_polls
   (repo, last_sha, last_committed_at, last_attempted_at, last_success_at,
    last_status, gap_since_sha, gap_at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
 ON CONFLICT (repo) DO UPDATE SET
   last_sha = COALESCE(excluded.last_sha, dcs_repo_polls.last_sha),
   last_committed_at = COALESCE(excluded.last_committed_at, dcs_repo_polls.last_committed_at),
   last_attempted_at = excluded.last_attempted_at,
   last_success_at = COALESCE(excluded.last_success_at, dcs_repo_polls.last_success_at),
   last_status = excluded.last_status,
   gap_since_sha = COALESCE(excluded.gap_since_sha, dcs_repo_polls.gap_since_sha),
   gap_at = COALESCE(excluded.gap_at, dcs_repo_polls.gap_at)`;

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

  const { sinceSha, sinceTime } = pollBounds(state, nowSeconds);
  const page = await listMasterCommitsSince(env, repo, null, sinceSha, {
    pageLimit: DCS_POLL_PAGE_LIMIT,
    sinceTime,
    files: true,
  });

  const rows = ledgerRowsFromCommits(repo, page.commits);
  const status = page.incomplete ? page.incompleteReason || "incomplete" : "ok";
  const advance = !page.incomplete || advancesDespiteIncomplete(page.incompleteReason);
  // The tip is rows[0] — the walk is newest-first.
  const tip = rows[0] ?? null;
  const gapSince =
    page.incomplete && advancesDespiteIncomplete(page.incompleteReason)
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
    advance ? (tip?.sha ?? null) : null,
    advance ? (tip?.committedAt ?? null) : null,
    nowSeconds,
    page.incomplete && !advance ? null : nowSeconds,
    status,
    gapSince,
    gapSince ? nowSeconds : null,
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

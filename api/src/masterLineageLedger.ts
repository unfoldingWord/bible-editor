// Durable, repo-scoped master lineage (issues #547/#692/#691).
//
// The nightly path still owns the live-Gitea fallback. This module only turns
// a ledger read into lineage when the ledger can prove that it covers the whole
// requested window. A partial/old/malformed ledger is not an empty answer: it
// is an explicit refusal, so callers can perform the existing live walk.

import {
  summarizeLineage,
  type ClassifiedCommit,
  type MasterCommit,
  type MasterLineage,
} from "./masterLineage.ts";
import { classifyForLedger, DCS_POLL_MAX_FILES } from "./dcsCommitPoll.ts";

export interface LedgerLineageRow {
  repo: string;
  sha: string;
  parent_sha: string | null;
  author_name: string | null;
  author_email: string | null;
  committed_at: number | null;
  message: string | null;
  classification: string;
  classification_reason: string | null;
  files_json: string | null;
}

export interface LedgerPollRow {
  last_sha: string | null;
  last_status: string | null;
  gap_since_sha: string | null;
  last_success_at: number | null;
  coverage_since: number | null;
}

export interface LedgerDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
}

export interface LedgerLineageResult {
  usable: boolean;
  reason: string;
  lineage: MasterLineage | null;
  commits: MasterCommit[];
}

const EMPTY = (reason: string): LedgerLineageResult => ({
  usable: false,
  reason,
  lineage: null,
  commits: [],
});

function parseFiles(json: string | null): string[] | null {
  if (json == null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) return null;
    // The poller stores at most DCS_POLL_MAX_FILES. A full-sized stored list
    // may have been sliced, and therefore cannot prove that the target path is
    // absent. Treat it as unknown even if the target happens to be present.
    if (parsed.length >= DCS_POLL_MAX_FILES) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

function classifyStored(row: LedgerLineageRow): ClassifiedCommit | null {
  if (row.classification !== "ours" && row.classification !== "ai" && row.classification !== "human") {
    return null;
  }
  const commit: MasterCommit = {
    sha: row.sha,
    message: row.message,
    authorEmail: row.author_email,
    authorName: row.author_name,
    committerDate: row.committed_at == null ? null : new Date(row.committed_at * 1000).toISOString(),
    parentSha: row.parent_sha,
  };
  // The stored classification is the result of classifyForLedger at poll time.
  // Re-running the classifier here would lose the commit body (the ledger
  // deliberately stores subject only) and could turn a formerly positive
  // trailer decision into an unmeasured human. Keep its recorded reason/kind,
  // but retain the shared classifier import as the contract this ledger uses.
  const recorded = classifyForLedger(commit);
  return {
    ...commit,
    kind: row.classification,
    reason: row.classification_reason || recorded.reason,
  } as ClassifiedCommit;
}

/**
 * Read a ledger-backed lineage for one exact file.
 *
 * `currentRepoHeadSha` must be obtained from the live repo head. Comparing it
 * with dcs_repo_polls.last_sha prevents a quiet-but-stale poll from hiding a
 * newer human edit. The poll must also be successful and gap-free. Every row
 * in the time window needs a complete file list; this is what lets repo-scoped
 * history safely narrow to one path even though path-scoped Gitea history can
 * omit merge wrappers.
 */
export async function readLedgerMasterLineage(
  db: LedgerDb,
  repo: string,
  path: string,
  confirmedAt: number,
  currentRepoHeadSha: string | null,
): Promise<LedgerLineageResult> {
  if (!Number.isFinite(confirmedAt)) return EMPTY("bad_confirmed_at");
  if (!currentRepoHeadSha) return EMPTY("current_repo_head_unavailable");

  const poll = await db
    .prepare(
      `SELECT last_sha, last_status, last_success_at, gap_since_sha, coverage_since
         FROM dcs_repo_polls WHERE repo = ?1`,
    )
    .bind(repo)
    .first<LedgerPollRow>();
  if (!poll) return EMPTY("ledger_poll_missing");
  if (poll.last_sha !== currentRepoHeadSha) return EMPTY("ledger_tip_stale");
  if (
    poll.last_status !== "ok" ||
    poll.last_success_at == null ||
    poll.gap_since_sha != null ||
    poll.coverage_since == null
  ) {
    return EMPTY("ledger_coverage_incomplete");
  }
  if (confirmedAt < poll.coverage_since) return EMPTY("ledger_window_before_coverage_floor");

  const rows = await db
    .prepare(
      `SELECT repo, sha, parent_sha, author_name, author_email, committed_at, message,
              classification, classification_reason, files_json
         FROM dcs_commits
        WHERE repo = ?1 AND (committed_at >= ?2 OR committed_at IS NULL)
        ORDER BY committed_at DESC`,
    )
    .bind(repo, confirmedAt)
    .all<LedgerLineageRow>();

  // The hourly dcs_commits retention sweep (api/src/index.ts) can delete rows
  // older than its cutoff and raise coverage_since to that same cutoff. If it
  // runs between the poll read above and the commit read just issued, this
  // reader's confirmedAt may have satisfied the OLD floor while the window it
  // just read has already lost its oldest commits to the sweep — a truncated
  // read that would otherwise report itself complete. Re-reading the floor
  // now and rejecting if it moved past confirmedAt closes that gap.
  const recheckPoll = await db
    .prepare(`SELECT coverage_since FROM dcs_repo_polls WHERE repo = ?1`)
    .bind(repo)
    .first<{ coverage_since: number | null }>();
  if (recheckPoll?.coverage_since != null && confirmedAt < recheckPoll.coverage_since) {
    return EMPTY("ledger_floor_moved");
  }

  const raw = rows.results ?? [];
  const commits: ClassifiedCommit[] = [];
  for (const row of raw) {
    if (row.committed_at == null) return EMPTY("ledger_commit_time_unknown");
    const files = parseFiles(row.files_json);
    if (files == null) return EMPTY("ledger_file_list_incomplete");
    const classified = classifyStored(row);
    if (classified == null) return EMPTY("ledger_classification_unknown");
    if (files.includes(path)) commits.push(classified);
  }

  return {
    usable: true,
    reason: "ledger_complete",
    commits,
    // A repo-wide ledger can prove that no relevant commit was human even if
    // this file had no commits. Its empty commit list is therefore a complete
    // negative, unlike a failed live path walk.
    lineage: summarizeLineage(commits, { incomplete: false, incompleteReason: "" }),
  };
}

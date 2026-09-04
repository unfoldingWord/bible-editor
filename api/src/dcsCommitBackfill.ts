// Slow backfill for dcs_repo_polls' recorded coverage holes (issue #692
// item 2, follow-up to the poller in dcsCommitPoll.ts / issue #685).
//
// WHAT THE HOLE IS. pollDcsRepo advances a repo's high-water mark even when a
// walk could not reach its target boundary (a burst bigger than one tick's
// page budget, or a never-polled repo's bootstrap window) — see GAP HANDLING
// in dcsCommitPoll.ts. When that happens it now records TWO edges of the
// skipped range on dcs_repo_polls:
//   * gap_from_sha  — the NEAR edge: the parent of the oldest row that walk
//                      actually inserted. Nothing at or below this sha is in
//                      the ledger yet.
//   * gap_since_sha — the FAR edge: the boundary the walk was trying to
//                      reach. For an incremental poll this is the PREVIOUS
//                      high-water mark, already in the ledger. For a
//                      bootstrap poll it is the sha of the oldest row that
//                      walk itself just inserted — a sha that can never be
//                      found by walking OLDER than it, which is exactly what
//                      makes a bootstrap "gap" resolve by walking all the way
//                      to the repo's first commit rather than to a specific
//                      target (see "BOOTSTRAP GAPS" below).
//
// WHAT THIS DOES. On every POLL_CRON tick (index.ts), for each tracked repo
// that currently has a gap, walk a SMALL number of extra pages backward from
// gap_from_sha (the same listMasterCommitsSince this repo's forward poll
// uses, just anchored at a historical sha instead of master's live tip —
// hence `fromSha`). Insert whatever lands (rows are keyed (repo, sha), so a
// re-walk of already-backfilled ground is inert), then:
//   * the walk reaches gap_since_sha (or, for a bootstrap gap, the true root
//     of the repo's history) → continuity is proven; clear all three columns.
//   * the walk is cut short by ITS OWN small page cap → move gap_from_sha to
//     the new frontier (the oldest row just inserted's parent) and leave
//     gap_since_sha/gap_at alone, so the next tick resumes exactly where this
//     one stopped.
//   * a transport failure → leave everything alone; the next tick retries.
//
// BOOTSTRAP GAPS, walked out fully. A bootstrap gap's gap_since_sha names a
// sha this backward walk will never encounter (see above), so
// listMasterCommitsSince eventually reaches the repo's genesis commit and
// reports `source_sha_not_in_history` — which reads exactly like "the target
// is not an ancestor of this chain", the same signal a force-push produces.
// Both cases mean the same thing to a caller with nothing more to check
// against: there is no more history to find, so the hole is resolved. That
// is a deliberate, not an accidental, unification — it is also what makes a
// never-polled repo's full history eventually land in the ledger without a
// separate "walk everything" code path.
//
// BUDGET. DCS_BACKFILL_PAGE_LIMIT pages per repo per tick, same per-fetch
// timeout as the regular poll. Five repos, worst case DCS_BACKFILL_PAGE_LIMIT
// × 5 extra subrequests per 5-minute tick — small next to the regular poll's
// own worst case (see BUDGET in dcsCommitPoll.ts) and the two run back to
// back in the same handler, both wrapped so neither can fail the other.

import type { Env } from "./index";
import { listMasterCommitsSince, TRACKED_DCS_REPOS } from "./dcsSources.ts";
import { DCS_POLL_FETCH_TIMEOUT_MS, DCS_POLL_WRITE_BATCH, INSERT_COMMIT_SQL, ledgerRowsFromCommits } from "./dcsCommitPoll.ts";

/** Pages per repo per tick. 50 commits/page → 100 commits/repo/tick. */
export const DCS_BACKFILL_PAGE_LIMIT = 2;

interface GapState {
  gap_since_sha: string | null;
  gap_from_sha: string | null;
}

export interface BackfillResult {
  repo: string;
  attempted: boolean;
  fetched: number;
  inserted: number;
  resolved: boolean;
  status: string;
}

const CLEAR_GAP_SQL = `UPDATE dcs_repo_polls
   SET gap_since_sha = NULL, gap_from_sha = NULL, gap_at = NULL
 WHERE repo = ?1 AND gap_since_sha = ?2`;

// Moves ONLY gap_from_sha, and only while it is still the value this walk
// started from — the same "don't clobber a concurrent write" guard as
// CLEAR_GAP_SQL. gap_since_sha/gap_at are untouched: this walk made progress
// but did not close the hole.
const ADVANCE_GAP_FROM_SQL = `UPDATE dcs_repo_polls
   SET gap_from_sha = ?3
 WHERE repo = ?1 AND gap_since_sha = ?2 AND gap_from_sha = ?4`;

/**
 * Backfill one repo's recorded gap by a small, bounded amount. No-op (and
 * cheap: one D1 read) when the repo has no gap. Exported for a targeted
 * admin/manual run; the cron entry point is backfillDcsGaps below.
 */
export async function backfillDcsRepoGap(env: Env, repo: string, nowSeconds: number): Promise<BackfillResult> {
  const state = await env.DB.prepare(`SELECT gap_since_sha, gap_from_sha FROM dcs_repo_polls WHERE repo = ?1`)
    .bind(repo)
    .first<GapState>();

  if (!state?.gap_since_sha) {
    return { repo, attempted: false, fetched: 0, inserted: 0, resolved: false, status: "no_gap" };
  }

  // A gap recorded with no near edge — either a defensive case in
  // pollDcsRepo (the oldest inserted row was itself a repo root), or a row
  // left over from before this migration added the column. Either way there
  // is no sha to resume from, so the hole cannot be walked; dropping it is
  // the same "bounded, recorded loss beats an unbounded stall" call
  // dcsCommitPoll.ts already makes for a page-cap gap it cannot avoid.
  if (!state.gap_from_sha) {
    await env.DB.prepare(CLEAR_GAP_SQL).bind(repo, state.gap_since_sha).run();
    return { repo, attempted: true, fetched: 0, inserted: 0, resolved: true, status: "no_from_sha" };
  }

  const page = await listMasterCommitsSince(env, repo, null, state.gap_since_sha, {
    pageLimit: DCS_BACKFILL_PAGE_LIMIT,
    fromSha: state.gap_from_sha,
    files: true,
    timeoutMs: DCS_POLL_FETCH_TIMEOUT_MS,
  });

  const { rows } = ledgerRowsFromCommits(repo, page.commits);
  const ordered = [...rows].reverse(); // oldest-first, same reasoning as pollDcsRepo
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
  for (let i = 0; i < insertStatements.length; i += DCS_POLL_WRITE_BATCH) {
    await env.DB.batch(insertStatements.slice(i, i + DCS_POLL_WRITE_BATCH));
  }

  // Reached the far edge for real, OR walked past the true root without ever
  // finding it (force-push under the hole, or — the common case — a
  // bootstrap gap, whose gap_since_sha is never reachable by an older-only
  // walk in the first place; see BOOTSTRAP GAPS above). Both mean "nothing
  // more to find below here".
  const resolved = !page.incomplete || page.incompleteReason === "source_sha_not_in_history";

  if (resolved) {
    await env.DB.prepare(CLEAR_GAP_SQL).bind(repo, state.gap_since_sha).run();
    return {
      repo,
      attempted: true,
      fetched: page.commits.length,
      inserted: rows.length,
      resolved: true,
      status: page.incomplete ? page.incompleteReason : "ok",
    };
  }

  // page_cap (the only other incomplete reason listMasterCommitsSince can
  // report when sinceTime is not in play, which it never is here) or a
  // transport failure. Either way this walk did not reach the far edge.
  const oldestParent = rows[rows.length - 1]?.parentSha ?? null;
  if (page.incompleteReason === "page_cap" && oldestParent) {
    await env.DB.prepare(ADVANCE_GAP_FROM_SQL).bind(repo, state.gap_since_sha, oldestParent, state.gap_from_sha).run();
  } else if (page.incompleteReason === "page_cap") {
    // A full page whose last row is a repo root — nothing older exists, so
    // there is nowhere left to advance to. Same call as the "no_from_sha"
    // branch above: resolve rather than retry a walk that can never move.
    await env.DB.prepare(CLEAR_GAP_SQL).bind(repo, state.gap_since_sha).run();
    return { repo, attempted: true, fetched: page.commits.length, inserted: rows.length, resolved: true, status: "reached_root" };
  }
  // Transport failure: gap_from_sha stays put, rows fetched before the
  // failure (if any) are still inserted above — the next tick resumes the
  // same range, exactly like a mid-walk transport failure in the regular
  // poll.

  return {
    repo,
    attempted: true,
    fetched: page.commits.length,
    inserted: rows.length,
    resolved: false,
    status: page.incompleteReason,
  };
}

/**
 * Cron entry point, called from the same POLL_CRON tick as pollDcsCommits.
 * Sequential for the same reason pollDcsCommits is: small, predictable load
 * per tick beats concurrency five repos have no need for. A failure on one
 * repo must not skip the rest.
 */
export async function backfillDcsGaps(env: Env, nowSeconds?: number): Promise<BackfillResult[]> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const out: BackfillResult[] = [];
  for (const repo of TRACKED_DCS_REPOS) {
    try {
      out.push(await backfillDcsRepoGap(env, repo, now));
    } catch (e) {
      console.error("dcs commit backfill failed", repo, e instanceof Error ? e.message : String(e));
      out.push({ repo, attempted: true, fetched: 0, inserted: 0, resolved: false, status: "error" });
    }
  }
  return out;
}

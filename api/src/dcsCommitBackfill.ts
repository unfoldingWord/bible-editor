// Slow backfill for dcs_repo_polls' recorded coverage holes (issue #692
// item 2, follow-up to the poller in dcsCommitPoll.ts / issue #685).
//
// WHAT THE HOLE IS. pollDcsRepo advances a repo's high-water mark even when a
// walk could not reach its target boundary (a burst bigger than one tick's
// page budget, or a never-polled repo's bootstrap window) — see GAP HANDLING
// in dcsCommitPoll.ts. When that happens it now records TWO things on
// dcs_repo_polls:
//   * gap_since_sha     — the FAR edge: the boundary the walk was trying to
//                          reach. For an incremental poll this is the
//                          PREVIOUS high-water mark, already in the ledger.
//                          For a bootstrap poll it is the sha of the oldest
//                          row that walk itself just inserted — a sha that
//                          can never be found by walking OLDER than it,
//                          which is exactly what makes a bootstrap "gap"
//                          resolve by walking all the way to the repo's
//                          first commit rather than to a specific target
//                          (see "BOOTSTRAP GAPS" below).
//   * gap_frontier_json — the NEAR edge(s): a JSON array of shas, one per
//                          not-yet-visited parent of a row the capped walk
//                          DID visit (dcsCommitPoll.ts's computeGapFrontier).
//                          A SET, not a single sha — PR #734's review
//                          (Codex, P1) found that a single "oldest row's
//                          first parent" resume point silently drops history
//                          the moment a merge commit sits anywhere in the
//                          capped range: the merge's OTHER parent leads to a
//                          branch whose own history can extend arbitrarily
//                          past where the first-parent chain was cut, and a
//                          single resume sha can never reach it. Repo-scoped
//                          Door43 history is measured ~26% merge commits
//                          (dcsCommitPoll.ts's classifyForLedger doc
//                          comment), so this is the common case, not an edge
//                          one.
//
// WHAT THIS DOES. On every POLL_CRON tick, for each tracked repo that
// currently has a gap, advance ONE frontier entry by a small, bounded walk
// (the same listMasterCommitsSince the forward poll uses, anchored at that
// entry via `fromSha` instead of master's live tip). Whatever the walk
// finds gets inserted (rows are keyed (repo, sha), so re-walking already-
// covered ground is inert); then, REGARDLESS of how the walk ended,
// computeGapFrontier runs again over exactly the rows THIS sub-walk
// visited, and `current` is replaced by whatever it finds:
//   * the walk reaches gap_since_sha, or runs out of history entirely (see
//     BOOTSTRAP GAPS) → normally empty, so `current` simply drops. But NOT
//     always (Codex review round 2, P1): reaching gap_since_sha proves only
//     that the specific chain this walk followed is covered — if a merge
//     commit sat anywhere in the visited rows, its OTHER parent is neither
//     visited nor (in general) gap_since_sha, and computeGapFrontier still
//     finds it. The first version of this fix dropped `current`
//     unconditionally on "reached the target", which silently lost that
//     branch exactly as PR #734's FIRST review round found for the forward
//     poll's own gap computation.
//   * the walk is cut short by its own page budget → the sub-frontier is
//     one entry for an ordinary chain, more than one if this sub-walk
//     itself crossed a merge, or empty if the oldest row it saw is itself a
//     repo root (nothing older to find — this entry resolves too).
//   * a transport failure → leave the frontier untouched; the next tick
//     retries the same entry.
// The overall gap clears the moment the frontier is empty — every branch
// that ever forked off the walked range has been traced back to
// gap_since_sha or to history's beginning.
//
// ONE ENTRY PER REPO PER TICK, deliberately, not the whole frontier. This
// keeps the per-tick budget flat and predictable regardless of how many
// branches a hole happens to fork into — a frontier with several entries
// just takes a few more ticks to close, and nothing about correctness
// depends on closing it quickly (dcs_commits is not read for any gating
// decision yet; see the module doc on dcsCommitPoll.ts).
//
// BOOTSTRAP GAPS, walked out fully. A bootstrap gap's gap_since_sha names a
// sha this backward walk will never encounter (see above), so
// listMasterCommitsSince eventually reaches a root commit and reports
// `source_sha_not_in_history` — which reads exactly like "the target is not
// an ancestor of this chain", the same signal a force-push produces. Both
// cases mean the same thing to a caller with nothing more to check against:
// there is no more history down this branch, so this frontier entry is
// resolved. That is a deliberate, not an accidental, unification — it is
// also what makes a never-polled repo's full history eventually land in the
// ledger without a separate "walk everything" code path.
//
// BUDGET. DCS_BACKFILL_PAGE_LIMIT pages per repo per tick (one frontier
// entry's worth), same per-fetch timeout as the regular poll. Five repos,
// worst case DCS_BACKFILL_PAGE_LIMIT × 5 extra subrequests per 5-minute
// tick — small next to the regular poll's own worst case (see BUDGET in
// dcsCommitPoll.ts) and the two run back to back in the same handler, both
// wrapped so neither can fail the other.

import type { Env } from "./index";
import { listMasterCommitsSince, TRACKED_DCS_REPOS } from "./dcsSources.ts";
import {
  DCS_POLL_FETCH_TIMEOUT_MS,
  DCS_POLL_WRITE_BATCH,
  INSERT_COMMIT_SQL,
  computeGapFrontier,
  ledgerRowsFromCommits,
  parseGapFrontier,
} from "./dcsCommitPoll.ts";

/** Pages per repo per tick, spent on ONE frontier entry. */
export const DCS_BACKFILL_PAGE_LIMIT = 2;

interface GapState {
  gap_since_sha: string | null;
  gap_frontier_json: string | null;
}

export interface BackfillResult {
  repo: string;
  attempted: boolean;
  fetched: number;
  inserted: number;
  /** The OVERALL gap is closed: the frontier is now empty. */
  resolved: boolean;
  status: string;
}

// Guarded on gap_frontier_json too (Codex re-review, P1) — not just
// gap_since_sha. Without it, a concurrent poll that appends a fresh entry to
// the frontier (see the UNION in pollDcsRepo's gap_frontier_json comment)
// between this function's read and this write is silently overwritten: the
// clear still matches on gap_since_sha alone, nulls the whole gap, and the
// newly-appended commits — already past last_sha, so never revisited — are
// gone from the ledger with no marker recording the loss. The scheduled poll
// and backfill run back-to-back in the same handler, but nothing prevents
// two overlapping scheduled invocations (see pollDcsCommits's own NO IN-
// FLIGHT LOCK note). Binding the exact frontier this walk started from turns
// that race into a no-op clear instead: the CAS fails, the gap survives with
// whatever the concurrent write left it, and the next tick picks it up.
const CLEAR_GAP_SQL = `UPDATE dcs_repo_polls
   SET gap_since_sha = NULL, gap_frontier_json = NULL, gap_at = NULL
 WHERE repo = ?1 AND gap_since_sha = ?2 AND gap_frontier_json = ?3`;

// Replaces ONLY gap_frontier_json, and only while it is still the exact
// value this walk started from — the same "don't clobber a concurrent
// write" guard as CLEAR_GAP_SQL. gap_since_sha/gap_at are untouched: this
// walk made progress but did not empty the frontier.
const UPDATE_FRONTIER_SQL = `UPDATE dcs_repo_polls
   SET gap_frontier_json = ?3
 WHERE repo = ?1 AND gap_since_sha = ?2 AND gap_frontier_json = ?4`;

/**
 * Backfill one repo's recorded gap by advancing a single frontier entry a
 * small, bounded amount. No-op (and cheap: one D1 read) when the repo has no
 * gap. Exported for a targeted admin/manual run; the cron entry point is
 * backfillDcsGaps below.
 */
export async function backfillDcsRepoGap(env: Env, repo: string, nowSeconds: number): Promise<BackfillResult> {
  const state = await env.DB.prepare(`SELECT gap_since_sha, gap_frontier_json FROM dcs_repo_polls WHERE repo = ?1`)
    .bind(repo)
    .first<GapState>();

  if (!state?.gap_since_sha) {
    return { repo, attempted: false, fetched: 0, inserted: 0, resolved: false, status: "no_gap" };
  }

  const frontierJson = state.gap_frontier_json;
  const frontier = parseGapFrontier(frontierJson);

  // An empty frontier with a gap still open — either a defensive case (the
  // walk that opened this gap found nothing to resume from at all), or a row
  // left over from before this migration added the column. Either way there
  // is no sha to resume from, so the hole cannot be walked; dropping it is
  // the same "bounded, recorded loss beats an unbounded stall" call
  // dcsCommitPoll.ts already makes for a page-cap gap it cannot avoid.
  if (frontier.length === 0) {
    await env.DB.prepare(CLEAR_GAP_SQL).bind(repo, state.gap_since_sha, frontierJson).run();
    return { repo, attempted: true, fetched: 0, inserted: 0, resolved: true, status: "no_frontier" };
  }

  // ONE entry per tick — see the module doc's "ONE ENTRY PER REPO PER TICK".
  const [current, ...rest] = frontier;

  const page = await listMasterCommitsSince(env, repo, null, state.gap_since_sha, {
    pageLimit: DCS_BACKFILL_PAGE_LIMIT,
    fromSha: current,
    files: true,
    timeoutMs: DCS_POLL_FETCH_TIMEOUT_MS,
  });

  const { rows } = ledgerRowsFromCommits(repo, page.commits);
  const ordered = [...rows].reverse(); // oldest-first, same discipline as pollDcsRepo
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

  // Reached the far edge for real, OR walked past history's end without ever
  // finding it (force-push under the hole, or — the common case — a
  // bootstrap gap, whose gap_since_sha is never reachable by an older-only
  // walk in the first place; see BOOTSTRAP GAPS above). Both mean "nothing
  // more to find ALONG THE PATH THIS WALK ACTUALLY TOOK" — NOT "this entry
  // is fully resolved". Codex review round 2 (P1): reaching gap_since_sha
  // only proves the specific chain this walk followed is covered; if a
  // merge commit sat anywhere in `rows`, its OTHER parent is neither
  // visited nor (in general) equal to gap_since_sha, and dropping `current`
  // outright — the original version of this fix — silently lost that
  // branch exactly as PR #734's FIRST review round found for the forward
  // poll. So: compute this sub-walk's own frontier UNCONDITIONALLY, the
  // same function the page-cap path already used, regardless of how the
  // walk ended. On an ordinary merge-free range this is empty and `current`
  // simply drops, same behavior as before.
  const reachedTarget = !page.incomplete;
  const reachedHistoryEnd = page.incompleteReason === "source_sha_not_in_history";
  const isTransportFailure = page.incomplete && !reachedHistoryEnd && page.incompleteReason !== "page_cap";

  let status: string;
  let newFrontier: string[];
  if (isTransportFailure) {
    // Put `current` (and every other untouched entry) back unchanged. The
    // rows fetched before the failure (if any) are still inserted above —
    // the next tick resumes the same entry, exactly like a mid-walk
    // transport failure in the regular poll.
    status = page.incompleteReason;
    newFrontier = frontier;
  } else {
    const subFrontier = computeGapFrontier(rows, state.gap_since_sha);
    newFrontier = [...rest, ...subFrontier];
    status = reachedTarget
      ? "ok"
      : reachedHistoryEnd
        ? "source_sha_not_in_history"
        : subFrontier.length === 0
          ? // A full page whose visited rows' every parent is already visited
            // or absent (a repo root among them) — nowhere left to go down
            // this branch. Resolve rather than retry a walk that can never
            // move.
            "reached_root"
          : "page_cap";
  }

  if (newFrontier.length === 0) {
    await env.DB.prepare(CLEAR_GAP_SQL).bind(repo, state.gap_since_sha, frontierJson).run();
    return { repo, attempted: true, fetched: page.commits.length, inserted: rows.length, resolved: true, status };
  }

  const newFrontierJson = JSON.stringify(newFrontier);
  if (newFrontierJson !== frontierJson) {
    await env.DB.prepare(UPDATE_FRONTIER_SQL).bind(repo, state.gap_since_sha, newFrontierJson, frontierJson).run();
  }
  return { repo, attempted: true, fetched: page.commits.length, inserted: rows.length, resolved: false, status };
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

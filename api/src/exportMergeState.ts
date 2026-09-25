// Issue #442, option C: flag only the exports Door43 rejected or left waiting
// more than a day, so the admin panel shows what is stuck without a per-book
// click-through.
//
// GOVERNING RULE: never a false "rejected" or "waiting". When the evidence is
// missing or ambiguous the export is returned `unchecked` (with a reason) or
// not flagged at all — never a guessed flag.
//
// WHY "EXPORTED" IS NOT "MERGED". An export pushes a `-be-` branch and opens a
// PR; a DCS Actions job validates it and, on success, squash-merges it. Gitea
// then reports that PR `state: closed, merged: false` (measured 2026-09-25 on
// en_tn #7763, and in STATE.md), so `merged: false` cannot tell a merge from a
// rejection. The positive evidence of OUR squash merge is the commit on master,
// `bible-editor: NUM tn → master (#7763)` — the same match ownPublish.ts's
// findOurMergeForPr makes. `merged: true` IS trusted: it is what a maintainer's
// merge-commit merge reports, whose master commit ("Merge pull request '…'
// (#N) …") is classified human and would otherwise read as a rejection.
//
// WHICH PR. Per (book, resource), the HIGHEST pr_number any export recorded.
// Snapshots are inserted when an export step FINISHES, so two overlapping runs
// of the same pair (the nightly cron and a manual admin export — both reach
// ExportWorkflow's per-pair step) can record out of order; insertion order is
// therefore not "newest". Gitea numbers PRs per repo in creation order, so the
// highest number is the most recently opened PR, deterministically.
//
// WHEN A PAIR NEEDS ONLY THE OPEN LIST. If any `unchanged` snapshot was
// recorded after the last snapshot carrying that PR, the render matched master
// (exportWorkflow.ts's `!commit.branchTouched` path) and that same step tried
// to CLOSE any lingering PR itself. But closeDcsPr does not throw on a non-2xx,
// so the close can fail silently. Such a pair gets no single-PR GET and no
// master walk; it is looked up only in its repo's open-PR list. Listed → still
// open, judged as open (age from its opened time, validation). Absent → no flag
// and no further call. (A truncated list can only hide a flag here, never
// invent one.) A failed list → unchecked (`open_pr_list_failed`).
//
// WHEN "WAITING" STARTS. From when the PR was opened: the earlier of Door43's
// `created_at` and the first snapshot carrying that pr_number. Every nightly
// export re-pushes an open PR and records a fresh snapshot with the same
// number, so the newest snapshot's time would reset the clock daily.
//
// BUDGET (Cloudflare's ~1000-subrequest cap). The merge check runs in D1
// first: the dcs_commits ledger (issue #685, polled every 30 min) already
// holds our squash commits, so a merged export costs zero fetches. Only
// exports the ledger cannot prove merged go to Door43, at most
// MERGE_LIVE_LOOKUP_CAP of them (the rest are `unchecked`, reason
// `lookup_budget`):
//   * one open-PR list per repo that has any: listOpenPrs pages until an empty
//     page, so at least 2 fetches per repo (the empty page included) and at
//     most 20 (its page cap, the empty page included);
//   * per export, at most 3 more: open in that list → 1 status read; otherwise
//     1 single-PR GET (the list can be truncated, so absence proves nothing),
//     then either 1 status read (it is open after all) or ≤ MASTER_WALK_PAGES
//     pages of a file-scoped master walk (closed, merged: false).
// Worst case: 5 × 20 list fetches + 20 × 3 = 160 subrequests; the usual case
// is 0.
//
// WALL TIME. Every Door43 read has a LOOKUP_TIMEOUT_MS bound: the whole paged
// list shares one deadline, and the single-PR GET, each walk page and the
// status read each get their own. Repos are listed in parallel and exports are
// looked up in parallel, so the worst case is one list deadline plus the
// longest per-export chain (GET + 2 walk pages, or GET + status) =
// 4 × LOOKUP_TIMEOUT_MS = 40 s. The web client waits 120 s for this route.
// A timed-out status read is null (unknown), so an open PR is then judged on
// age alone.
//
// OWNER. The ledger and the master walk read unfoldingWord's repos
// (dcsSources.ts's DCS_OWNER). If DCS_EXPORT_OWNER names someone else, a
// closed PR cannot be judged from them, so it is `unchecked` (owner_mismatch)
// and the ledger is not consulted.
//
// IMPLEMENTER'S CALL (stated in the PR): a failed validation on a still-open PR
// counts as rejected. merge-be-pr.yaml merges only on a successful validation
// run, so a red PR will never merge on its own — it is as stuck as a closed one.

import type { Env } from "./index";
import { RESOURCE_TARGETS, getCommitStatus, listOpenPrs, type DcsOpenPr, type Resource } from "./export.ts";
import { DCS_OWNER, dcsResourceFile, listMasterCommitsSince } from "./dcsSources.ts";
import { classifyMasterCommit } from "./masterLineage.ts";
import { findOurMergeForPr } from "./ownPublish.ts";

/** An open PR is flagged "waiting" once it has been open MORE than this long. */
export const MERGE_WAIT_FLAG_SECONDS = 24 * 3600;
/** Max unresolved exports that get per-export Door43 reads in one request. */
export const MERGE_LIVE_LOOKUP_CAP = 20;
/** Pages (50 commits each, server-fixed) per closed-PR master walk. */
const MASTER_WALK_PAGES = 2;
/** Door43 read timeout: the whole open-PR list, and each single-PR GET, walk
 *  page and status read (see WALL TIME). */
const LOOKUP_TIMEOUT_MS = 10_000;
/** The squash commit's date is the merge time, after the push; this margin only
 *  absorbs clock skew between our D1 stamp and Door43's. */
const PUSH_CLOCK_MARGIN_SECONDS = 3600;

export type ExportMergeState =
  | { state: "merged" }
  | { state: "pending" }
  | { state: "waiting" }
  | { state: "rejected"; reason: "validation_failed" | "closed_unmerged" }
  | { state: "unknown"; reason: "master_unmeasured" };

// Pure. `exportedAt` is when the PR was opened. `mergedOnMaster`: true =
// merge evidence found; false = a complete master walk found none; null = not
// measured.
export function classifyExportMerge(input: {
  exportedAt: number;
  now: number;
  open: boolean;
  checkState: string | null;
  mergedOnMaster: boolean | null;
}): ExportMergeState {
  if (input.mergedOnMaster === true) return { state: "merged" };
  if (input.open) {
    if (input.checkState === "failure" || input.checkState === "error") {
      return { state: "rejected", reason: "validation_failed" };
    }
    return input.now - input.exportedAt > MERGE_WAIT_FLAG_SECONDS ? { state: "waiting" } : { state: "pending" };
  }
  if (input.mergedOnMaster === false) return { state: "rejected", reason: "closed_unmerged" };
  return { state: "unknown", reason: "master_unmeasured" };
}

export interface ExportMergeFlag {
  book: string;
  resource: Resource;
  prNumber: number;
  /** When the PR was opened (unix seconds). */
  exportedAt: number;
  state: "waiting" | "rejected";
  reason: "validation_failed" | "closed_unmerged" | null;
  url: string;
}

export type ExportMergeUncheckedReason =
  | "lookup_budget"
  | "pr_lookup_failed"
  | "owner_mismatch"
  | "master_unmeasured"
  | "lookup_failed"
  | "open_pr_list_failed";

export interface ExportMergeUnchecked {
  book: string;
  resource: Resource;
  prNumber: number;
  reason: ExportMergeUncheckedReason;
}

export interface ExportMergeFlags {
  flags: ExportMergeFlag[];
  unchecked: ExportMergeUnchecked[];
  errors: Array<{ repo: string; message: string }>;
}

interface Candidate {
  book: string;
  resource: Resource;
  pr_number: number;
  first_at: number;
  matched_master_since: number;
  merged_in_ledger: number;
}

const isoToSec = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

// GET /repos/{owner}/{repo}/pulls/{n}. Null on any non-200 or unusable body;
// a transport failure throws (the caller isolates it per export).
async function getDcsPr(
  cfg: { baseUrl: string; token: string; owner: string; repo: string },
  n: number,
  timeoutMs: number,
): Promise<{ state: string; merged: boolean; headSha: string | null; createdAt: number | null } | null> {
  const res = await fetch(
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/pulls/${n}`,
    {
      headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) return null;
  const pr = (await res.json()) as {
    state?: string;
    merged?: boolean;
    head?: { sha?: string };
    created_at?: string;
  };
  if (typeof pr.state !== "string") return null;
  return {
    state: pr.state,
    merged: pr.merged === true,
    headSha: typeof pr.head?.sha === "string" ? pr.head.sha : null,
    createdAt: isoToSec(pr.created_at),
  };
}

export async function computeExportMergeFlags(
  env: Env,
  now: number,
  // Test seam only: the route always uses LOOKUP_TIMEOUT_MS.
  opts: { timeoutMs?: number } = {},
): Promise<ExportMergeFlags> {
  const timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const baseUrl = env.DCS_BASE_URL.replace(/\/$/, "");
  const token = env.DCS_SERVICE_TOKEN ?? "";
  const owner = env.DCS_EXPORT_OWNER ?? "unfoldingWord";
  const ownerMatchesLedger = owner === DCS_OWNER;

  // One query. Per pair: the highest pr_number (see WHICH PR), the first time
  // any snapshot carried it (WHEN "WAITING" STARTS), whether an `unchanged`
  // was recorded after its last snapshot (WHEN A PAIR NEEDS NO CHECK), and
  // whether the ledger holds its squash commit. The ledger subquery rides the
  // (repo, committed_at) index; classification = 'ours' keeps a human
  // `Revert "… (#N)"` from counting as the merge. Repo is 'en_' || resource,
  // which is RESOURCE_TARGETS' naming for all five.
  const rs = await env.DB.prepare(
    `WITH per_pr AS (
       SELECT book, resource, pr_number, MIN(committed_at) AS first_at, MAX(id) AS last_id
         FROM export_snapshots WHERE pr_number IS NOT NULL
        GROUP BY book, resource, pr_number
     ), cur AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY book, resource ORDER BY pr_number DESC) rn FROM per_pr
     )
     SELECT c.book, c.resource, c.pr_number, c.first_at,
            EXISTS (
              SELECT 1 FROM export_snapshots u
               WHERE u.book = c.book AND u.resource = c.resource
                 AND u.error = 'unchanged' AND u.id > c.last_id
            ) AS matched_master_since,
            EXISTS (
              SELECT 1 FROM dcs_commits d
               WHERE d.repo = 'en_' || c.resource
                 AND d.committed_at >= c.first_at - ?1
                 AND d.classification = 'ours'
                 AND instr(d.message, '(#' || c.pr_number || ')') > 0
            ) AS merged_in_ledger
       FROM cur c
      WHERE c.rn = 1`,
  )
    .bind(PUSH_CLOCK_MARGIN_SECONDS)
    .all<Candidate>();

  const eligible = (rs.results ?? []).filter(
    (r) => r.resource in RESOURCE_TARGETS && !(ownerMatchesLedger && r.merged_in_ledger),
  );
  // `unchanged` after the PR: almost certainly closed by our own export, but
  // closeDcsPr can fail silently, so only the open list is consulted for these.
  const openOnly = eligible.filter((r) => r.matched_master_since);
  const full = eligible.filter((r) => !r.matched_master_since);

  const out: ExportMergeFlags = { flags: [], unchecked: [], errors: [] };
  const uncheck = (r: Candidate, reason: ExportMergeUncheckedReason) =>
    out.unchecked.push({ book: r.book, resource: r.resource, prNumber: r.pr_number, reason });

  // One open-PR list per repo that has anything to check, bounded by one
  // deadline for the whole paged list. A failed or timed-out list is not fatal
  // for `full` exports (each gets its own GET below); an `openOnly` export has
  // no other check, so it is reported unchecked.
  const repos = [...new Set(eligible.map((r) => RESOURCE_TARGETS[r.resource].repo))];
  const openByRepo = new Map<string, Map<number, DcsOpenPr>>();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const prs = await listOpenPrs({ baseUrl, token, owner, repo, timeoutMs });
        openByRepo.set(repo, new Map(prs.map((p) => [p.number, p])));
      } catch (e) {
        out.errors.push({ repo, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  const openOnlyStillOpen: Candidate[] = [];
  for (const r of openOnly) {
    const list = openByRepo.get(RESOURCE_TARGETS[r.resource].repo);
    if (!list) uncheck(r, "open_pr_list_failed");
    else if (list.has(r.pr_number)) openOnlyStillOpen.push(r);
    // absent from a complete-enough list → closed by our export: no flag, no further call
  }

  const work = [...full, ...openOnlyStillOpen]
    // Newest first, so the budget goes to the exports most likely to matter.
    .sort((a, b) => b.pr_number - a.pr_number || a.book.localeCompare(b.book));
  const live = work.slice(0, MERGE_LIVE_LOOKUP_CAP);
  for (const r of work.slice(MERGE_LIVE_LOOKUP_CAP)) uncheck(r, "lookup_budget");

  await Promise.all(
    live.map(async (r) => {
      try {
        const repo = RESOURCE_TARGETS[r.resource].repo;
        const cfg = { baseUrl, token, owner, repo };
        let open = false;
        let headSha: string | null = null;
        let createdAt: number | null = null;
        let mergedOnMaster: boolean | null = null;

        const listed = openByRepo.get(repo)?.get(r.pr_number);
        if (listed) {
          open = true;
          headSha = listed.headSha || null;
          createdAt = isoToSec(listed.createdAt);
        } else {
          // Absent from a list that may be truncated or failed: ask for the PR itself.
          const pr = await getDcsPr(cfg, r.pr_number, timeoutMs);
          if (!pr) return uncheck(r, "pr_lookup_failed");
          createdAt = pr.createdAt;
          if (pr.state === "open") {
            open = true;
            headSha = pr.headSha;
          } else if (pr.merged) {
            return; // merged — nothing to flag
          } else if (!ownerMatchesLedger) {
            return uncheck(r, "owner_mismatch");
          } else {
            const file = dcsResourceFile(r.book, r.resource);
            if (!file) return uncheck(r, "master_unmeasured");
            const walk = await listMasterCommitsSince(env, file.repo, file.path, null, {
              sinceTime: r.first_at - PUSH_CLOCK_MARGIN_SECONDS,
              pageLimit: MASTER_WALK_PAGES,
              timeoutMs,
            });
            const match = findOurMergeForPr(walk.commits.map(classifyMasterCommit), r.pr_number);
            mergedOnMaster = match.found ? true : walk.incomplete ? null : false;
          }
        }

        const checkState = open && headSha ? await getCommitStatus(cfg, headSha, { timeoutMs }) : null;
        const openedAt = createdAt != null ? Math.min(createdAt, r.first_at) : r.first_at;
        const verdict = classifyExportMerge({ exportedAt: openedAt, now, open, checkState, mergedOnMaster });
        if (verdict.state === "waiting" || verdict.state === "rejected") {
          out.flags.push({
            book: r.book,
            resource: r.resource,
            prNumber: r.pr_number,
            exportedAt: openedAt,
            state: verdict.state,
            reason: verdict.state === "rejected" ? verdict.reason : null,
            url: `${baseUrl}/${owner}/${repo}/pulls/${r.pr_number}`,
          });
        } else if (verdict.state === "unknown") {
          uncheck(r, verdict.reason);
        }
      } catch (e) {
        // One export's failure must not fail the whole response.
        console.warn("merge-flags lookup failed", {
          book: r.book,
          resource: r.resource,
          pr: r.pr_number,
          error: e instanceof Error ? e.message : String(e),
        });
        uncheck(r, "lookup_failed");
      }
    }),
  );

  const byBook = (a: { book: string; resource: string }, b: { book: string; resource: string }) =>
    a.book === b.book ? a.resource.localeCompare(b.resource) : a.book.localeCompare(b.book);
  out.flags.sort(byBook);
  out.unchecked.sort(byBook);
  return out;
}

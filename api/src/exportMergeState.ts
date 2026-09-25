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
// WHEN A PAIR NEEDS NO CHECK. If any `unchanged` snapshot was recorded after
// the last snapshot carrying that PR, the render matched master
// (exportWorkflow.ts's `!commit.branchTouched` path) and that same step CLOSED
// any lingering PR itself. That pair is fine: no flag, no Door43 read. (Under
// an overlap this can only hide a flag, never invent one.)
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
//     page, so at least 2 fetches per repo (the empty page included), capped
//     by listOpenPrs at 20 pages;
//   * per export, at most 3 more: open in that list → 1 status read; otherwise
//     1 single-PR GET (the list can be truncated, so absence proves nothing),
//     then either 1 status read (it is open after all) or ≤ MASTER_WALK_PAGES
//     pages of a file-scoped master walk (closed, merged: false).
// Worst case: 5 × 21 list fetches + 20 × 3 = 165; the usual case is 0.
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
/** Per-fetch timeout for the single-PR GET and the master walk. */
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
  | "lookup_failed";

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
): Promise<{ state: string; merged: boolean; headSha: string | null; createdAt: number | null } | null> {
  const res = await fetch(
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/pulls/${n}`,
    {
      headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
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

export async function computeExportMergeFlags(env: Env, now: number): Promise<ExportMergeFlags> {
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

  const unresolved = (rs.results ?? [])
    .filter(
      (r) =>
        r.resource in RESOURCE_TARGETS &&
        !r.matched_master_since &&
        !(ownerMatchesLedger && r.merged_in_ledger),
    )
    // Newest first, so the budget goes to the exports most likely to matter.
    .sort((a, b) => b.pr_number - a.pr_number || a.book.localeCompare(b.book));

  const out: ExportMergeFlags = { flags: [], unchecked: [], errors: [] };
  const live = unresolved.slice(0, MERGE_LIVE_LOOKUP_CAP);
  const uncheck = (r: Candidate, reason: ExportMergeUncheckedReason) =>
    out.unchecked.push({ book: r.book, resource: r.resource, prNumber: r.pr_number, reason });
  for (const r of unresolved.slice(MERGE_LIVE_LOOKUP_CAP)) uncheck(r, "lookup_budget");

  // One open-PR list per repo that has anything to check. A failed list is not
  // fatal: every PR then gets its own GET below.
  const repos = [...new Set(live.map((r) => RESOURCE_TARGETS[r.resource].repo))];
  const openByRepo = new Map<string, Map<number, DcsOpenPr>>();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const prs = await listOpenPrs({ baseUrl, token, owner, repo });
        openByRepo.set(repo, new Map(prs.map((p) => [p.number, p])));
      } catch (e) {
        out.errors.push({ repo, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

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
          const pr = await getDcsPr(cfg, r.pr_number);
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
              timeoutMs: LOOKUP_TIMEOUT_MS,
            });
            const match = findOurMergeForPr(walk.commits.map(classifyMasterCommit), r.pr_number);
            mergedOnMaster = match.found ? true : walk.incomplete ? null : false;
          }
        }

        const checkState = open && headSha ? await getCommitStatus(cfg, headSha) : null;
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

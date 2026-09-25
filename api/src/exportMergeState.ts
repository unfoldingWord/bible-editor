// Issue #442, option C: flag only the exports Door43 rejected or left waiting
// more than a day, so the admin panel shows what is stuck without a per-book
// click-through.
//
// WHY "EXPORTED" IS NOT "MERGED". An export pushes a `-be-` branch and opens a
// PR; a DCS Actions job validates it and, on success, squash-merges it. Gitea
// then reports that PR `state: closed, merged: false` (measured 2026-09-25 on
// en_tn #7763, and in STATE.md), so the PR's own `merged` flag cannot tell a
// merge from a rejection. The only positive evidence of a merge is the squash
// commit on master, `bible-editor: NUM tn → master (#7763)` — the same match
// ownPublish.ts's findOurMergeForPr makes.
//
// WHICH EXPORT. The newest export_snapshots row per (book, resource) that
// opened a PR. A later `unchanged` skip carries no PR and changes nothing on
// Door43, so it must not hide a PR that is still stuck.
//
// BUDGET (Cloudflare's ~1000-subrequest cap). The merge check runs in D1
// first: the dcs_commits ledger (issue #685, polled every 30 min) already
// holds our squash commits, so a merged export costs zero fetches. Only
// exports the ledger cannot prove merged go to Door43:
//   * one open-PR list per repo that has any (listOpenPrs; normally 1 page),
//   * one combined-status read per unresolved export whose PR is open,
//   * a file-scoped master walk (≤ MASTER_WALK_PAGES pages) per unresolved
//     export whose PR is closed — the ledger may have a coverage gap.
// At most MERGE_LIVE_LOOKUP_CAP exports get the per-export reads; the rest are
// returned `unchecked` with reason `lookup_budget`, never guessed.
//
// IMPLEMENTER'S CALL (stated in the PR): a failed validation on a still-open PR
// counts as rejected. merge-be-pr.yaml merges only on a successful validation
// run, so a red PR will never merge on its own — it is as stuck as a closed one.

import type { Env } from "./index";
import { RESOURCE_TARGETS, getCommitStatus, listOpenPrs, type DcsOpenPr, type Resource } from "./export.ts";
import { dcsResourceFile, listMasterCommitsSince } from "./dcsSources.ts";
import { classifyMasterCommit } from "./masterLineage.ts";
import { findOurMergeForPr } from "./ownPublish.ts";

/** An open PR is flagged "waiting" once its export is MORE than this old. */
export const MERGE_WAIT_FLAG_SECONDS = 24 * 3600;
/** Max unresolved exports that get per-export Door43 reads in one request. */
export const MERGE_LIVE_LOOKUP_CAP = 20;
/** Pages (50 commits each, server-fixed) per closed-PR master walk. */
const MASTER_WALK_PAGES = 2;
/** The squash commit's date is the merge time, after the push; this margin only
 *  absorbs clock skew between our D1 stamp and Door43's. */
const PUSH_CLOCK_MARGIN_SECONDS = 3600;

export type ExportMergeState =
  | { state: "merged" }
  | { state: "pending" }
  | { state: "waiting" }
  | { state: "rejected"; reason: "validation_failed" | "closed_unmerged" }
  | { state: "unknown"; reason: "master_unmeasured" };

// Pure. `mergedOnMaster`: true = squash commit found; false = a complete master
// walk found none; null = not measured.
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
  exportedAt: number;
  state: "waiting" | "rejected";
  reason: "validation_failed" | "closed_unmerged" | null;
  url: string;
}

export interface ExportMergeUnchecked {
  book: string;
  resource: Resource;
  prNumber: number;
  reason: "lookup_budget" | "open_pr_list_failed" | "master_unmeasured";
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
  committed_at: number;
  merged_in_ledger: number;
}

export async function computeExportMergeFlags(env: Env, now: number): Promise<ExportMergeFlags> {
  const baseUrl = env.DCS_BASE_URL;
  const token = env.DCS_SERVICE_TOKEN ?? "";
  const owner = env.DCS_EXPORT_OWNER ?? "unfoldingWord";

  // One query: the newest PR-bearing export per pair, and whether the ledger
  // already holds its squash commit. The ledger subquery rides the
  // (repo, committed_at) index; classification = 'ours' keeps a human
  // `Revert "… (#N)"` from counting as the merge. Repo is 'en_' || resource,
  // which is RESOURCE_TARGETS' naming for all five.
  const rs = await env.DB.prepare(
    `SELECT s.book, s.resource, s.pr_number, s.committed_at,
            EXISTS (
              SELECT 1 FROM dcs_commits d
               WHERE d.repo = 'en_' || s.resource
                 AND d.committed_at >= s.committed_at - ?1
                 AND d.classification = 'ours'
                 AND instr(d.message, '(#' || s.pr_number || ')') > 0
            ) AS merged_in_ledger
       FROM (
         SELECT book, resource, pr_number, committed_at,
                ROW_NUMBER() OVER (PARTITION BY book, resource ORDER BY committed_at DESC, id DESC) rn
           FROM export_snapshots WHERE pr_number IS NOT NULL
       ) s
      WHERE s.rn = 1`,
  )
    .bind(PUSH_CLOCK_MARGIN_SECONDS)
    .all<Candidate>();

  const unresolved = (rs.results ?? [])
    .filter((r) => !r.merged_in_ledger && r.resource in RESOURCE_TARGETS)
    // Newest first, so the budget goes to the exports most likely to matter.
    .sort((a, b) => b.committed_at - a.committed_at || a.book.localeCompare(b.book));

  const out: ExportMergeFlags = { flags: [], unchecked: [], errors: [] };
  const live = unresolved.slice(0, MERGE_LIVE_LOOKUP_CAP);
  for (const r of unresolved.slice(MERGE_LIVE_LOOKUP_CAP)) {
    out.unchecked.push({ book: r.book, resource: r.resource, prNumber: r.pr_number, reason: "lookup_budget" });
  }

  // One open-PR list per repo that has anything to check.
  const repos = [...new Set(live.map((r) => RESOURCE_TARGETS[r.resource].repo))];
  const openByRepo = new Map<string, Map<number, DcsOpenPr> | null>();
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const prs = await listOpenPrs({ baseUrl, token, owner, repo });
        openByRepo.set(repo, new Map(prs.map((p) => [p.number, p])));
      } catch (e) {
        openByRepo.set(repo, null);
        out.errors.push({ repo, message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  await Promise.all(
    live.map(async (r) => {
      const repo = RESOURCE_TARGETS[r.resource].repo;
      const open = openByRepo.get(repo);
      if (!open) {
        out.unchecked.push({ book: r.book, resource: r.resource, prNumber: r.pr_number, reason: "open_pr_list_failed" });
        return;
      }
      const pr = open.get(r.pr_number);
      let checkState: string | null = null;
      let mergedOnMaster: boolean | null = null;
      if (pr) {
        checkState = await getCommitStatus({ baseUrl, token, owner, repo }, pr.headSha);
      } else {
        const file = dcsResourceFile(r.book, r.resource);
        if (file) {
          const walk = await listMasterCommitsSince(env, file.repo, file.path, null, {
            sinceTime: r.committed_at - PUSH_CLOCK_MARGIN_SECONDS,
            pageLimit: MASTER_WALK_PAGES,
          });
          const match = findOurMergeForPr(walk.commits.map(classifyMasterCommit), r.pr_number);
          mergedOnMaster = match.found ? true : walk.incomplete ? null : false;
        }
      }
      const verdict = classifyExportMerge({ exportedAt: r.committed_at, now, open: !!pr, checkState, mergedOnMaster });
      if (verdict.state === "waiting" || verdict.state === "rejected") {
        out.flags.push({
          book: r.book,
          resource: r.resource,
          prNumber: r.pr_number,
          exportedAt: r.committed_at,
          state: verdict.state,
          reason: verdict.state === "rejected" ? verdict.reason : null,
          url: `${baseUrl.replace(/\/$/, "")}/${owner}/${repo}/pulls/${r.pr_number}`,
        });
      } else if (verdict.state === "unknown") {
        out.unchecked.push({ book: r.book, resource: r.resource, prNumber: r.pr_number, reason: verdict.reason });
      }
    }),
  );

  const byBook = (a: { book: string; resource: string }, b: { book: string; resource: string }) =>
    a.book === b.book ? a.resource.localeCompare(b.resource) : a.book.localeCompare(b.book);
  out.flags.sort(byBook);
  out.unchecked.sort(byBook);
  return out;
}

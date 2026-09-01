// GET /api/dcs-commits — read surface over the dcs_commits ledger (issue #685).
//
// Split from dcsCommitPoll.ts on purpose: this file imports Hono, and plain
// `node --experimental-strip-types` (which is how api/src/*.test.mjs runs)
// cannot resolve the `hono` package from node_modules. Keeping the poller
// Hono-free is what makes it unit-testable at all.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireEditor } from "./auth";
import { TRACKED_DCS_REPOS } from "./dcsSources";
import type { DcsPollStateRow } from "./dcsCommitPoll";

// GET /api/dcs-commits?repo=&since=&limit= — recent ledger rows, newest first.
// requireEditor (not requireAuth): this is Door43 maintenance detail, the same
// audience as the admin sync-activity view, and it is read-only.

export const dcsCommits = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

dcsCommits.use("*", requireEditor);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

dcsCommits.get("/", async (c) => {
  const repo = (c.req.query("repo") ?? "").trim();
  if (repo && !TRACKED_DCS_REPOS.includes(repo)) {
    return c.json({ error: "unknown_repo", tracked: TRACKED_DCS_REPOS }, 400);
  }
  const sinceRaw = c.req.query("since");
  const since = sinceRaw == null ? null : Number(sinceRaw);
  if (since != null && !Number.isFinite(since)) return c.json({ error: "bad_since" }, 400);
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT;

  const rs = await c.env.DB.prepare(
    `SELECT repo, sha, parent_sha, author_name, author_email, committed_at, message,
            classification, classification_reason, files_json, seen_at
       FROM dcs_commits
      WHERE (?1 = '' OR repo = ?1)
        AND (?2 IS NULL OR committed_at >= ?2)
      ORDER BY committed_at DESC, seen_at DESC
      LIMIT ?3`,
  )
    .bind(repo, since, limit)
    .all<{
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
      seen_at: number;
    }>();

  const polls = await c.env.DB.prepare(
    `SELECT repo, last_sha, last_committed_at, last_attempted_at, last_success_at,
            last_status, gap_since_sha, gap_at
       FROM dcs_repo_polls ORDER BY repo`,
  ).all<DcsPollStateRow>();

  return c.json({
    commits: (rs.results ?? []).map((r) => ({
      repo: r.repo,
      sha: r.sha,
      parentSha: r.parent_sha,
      authorName: r.author_name,
      authorEmail: r.author_email,
      committedAt: r.committed_at,
      subject: r.message,
      classification: r.classification,
      classificationReason: r.classification_reason,
      files: r.files_json == null ? null : (JSON.parse(r.files_json) as string[]),
      seenAt: r.seen_at,
    })),
    // The poll state travels with the rows deliberately: "no commits" means
    // something different when the repo has never been polled than when it was
    // polled two minutes ago, and a reader must be able to tell.
    polls: (polls.results ?? []).map((p) => ({
      repo: p.repo,
      lastSha: p.last_sha,
      lastCommittedAt: p.last_committed_at,
      lastAttemptedAt: p.last_attempted_at,
      lastSuccessAt: p.last_success_at,
      lastStatus: p.last_status,
      gapSinceSha: p.gap_since_sha,
      gapAt: p.gap_at,
    })),
  });
});

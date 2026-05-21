// Post-export orchestrator: after a resource's snapshot lands on the
// live-snapshot branch, dispatch the resource's validate-and-merge Gitea
// Actions workflow, poll for completion, and act on the result.
//
//   success           → clear any prior banner alert, reimport the resource
//                       (pristine rows only) so D1 matches the freshly-merged
//                       master branch.
//   failure / timeout → insert a banner alert targeted at a configured user
//                       (deferredreward for en_tn).
//
// One ValidatorConfig per (resource, repo). Today only en_tn has the
// workflow file — append entries to VALIDATORS as the DCS manager rolls it
// out to en_tq / en_twl / en_ult / en_ust.

import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";
import { reimportBookFromDcs, type Resource } from "./bookReimport";

export interface ValidatorConfig {
  resource: Resource;
  owner: string;
  repo: string;
  workflowFile: string;
  ref: string;
  alertTargetUsername: string;
}

export const VALIDATORS: ValidatorConfig[] = [
  {
    resource: "tn",
    owner: "unfoldingWord",
    repo: "en_tn",
    workflowFile: "validate_and_merge_snapshot.yaml",
    ref: "master",
    alertTargetUsername: "deferredreward",
  },
];

interface DispatchResult {
  workflowRunId: number;
  htmlUrl: string;
}

interface RunStatus {
  status: string;            // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "cancelled" | "skipped" | "timed_out" | null while running
  htmlUrl: string;
}

const POLL_MAX_ITERATIONS = 30;
const POLL_INTERVAL_SECONDS = "60 seconds";

function validateAlertSource(cfg: ValidatorConfig): string {
  return `validate_merge:${cfg.repo}`;
}

function reimportAlertSource(cfg: ValidatorConfig): string {
  return `reimport:${cfg.repo}`;
}

async function recordReimportFailureAlert(
  env: Env,
  cfg: ValidatorConfig,
  failedBooks: string[],
  totalBooks: number,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM system_alerts
      WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
  )
    .bind(cfg.alertTargetUsername, reimportAlertSource(cfg))
    .run();
  const sample = failedBooks.slice(0, 5).join(", ");
  const more = failedBooks.length > 5 ? `, +${failedBooks.length - 5} more` : "";
  const message =
    `Benjamin fix this — post-merge reimport failed for ${failedBooks.length}/${totalBooks} book(s) on ${cfg.repo}: ${sample}${more}`;
  await env.DB.prepare(
    `INSERT INTO system_alerts (username, severity, source, message, link_url)
     VALUES (?1, 'error', ?2, ?3, NULL)`,
  )
    .bind(cfg.alertTargetUsername, reimportAlertSource(cfg), message)
    .run();
}

async function reimportOneBook(env: Env, resource: Resource, book: string): Promise<void> {
  const maxRow = await env.DB
    .prepare(`SELECT MAX(chapter) AS m FROM verses WHERE book = ?1`)
    .bind(book)
    .first<{ m: number | null }>();
  const maxCh = maxRow?.m ?? 0;
  if (maxCh < 1) return; // book not seeded enough to reimport
  const chapters = Array.from({ length: maxCh }, (_, i) => i + 1);
  await reimportBookFromDcs(env, book, chapters, [resource], null, { source: "cron" });
}

function dcsHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `token ${env.DCS_SERVICE_TOKEN!}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// POST /api/v1/repos/{owner}/{repo}/actions/workflows/{file}/dispatches?return_run_details=true
//
// DCS's `return_run_details=true` extension *should* respond 200 with
// {workflow_run_id, html_url}. But deployed door43 DCS (currently
// 1.25.7+dcs.22) ignores that param and returns 204 No Content, which made
// our previous `await res.json()` throw with "Unexpected end of JSON input"
// and silently fail every nightly run. Defensive path:
//   1. Read the body as text. If it's a parseable run-details payload,
//      use it directly.
//   2. Otherwise the dispatch was still accepted (Gitea returns 204 on
//      successful dispatch without details). Fall back to listing recent
//      workflow_dispatch runs and matching by workflow filename + dispatch
//      timestamp.
async function dispatchValidate(env: Env, cfg: ValidatorConfig): Promise<DispatchResult> {
  const base = env.DCS_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/dispatches?return_run_details=true`;
  const dispatchedAt = Math.floor(Date.now() / 1000);
  const res = await fetch(url, {
    method: "POST",
    headers: dcsHeaders(env),
    body: JSON.stringify({ ref: cfg.ref }),
  });
  if (!res.ok) {
    throw new Error(`dispatch_failed: ${res.status} ${await res.text()}`);
  }
  const text = (await res.text()).trim();
  if (text) {
    try {
      const body = JSON.parse(text) as {
        workflow_run_id?: number;
        html_url?: string;
      };
      if (typeof body.workflow_run_id === "number" && body.html_url) {
        return { workflowRunId: body.workflow_run_id, htmlUrl: body.html_url };
      }
    } catch {
      /* fall through to list-runs fallback */
    }
  }
  return findDispatchedRun(env, cfg, dispatchedAt);
}

// Fallback when dispatch returns 204 (no run details). Lists recent
// workflow_dispatch runs and picks the most recent one created at-or-after
// our dispatch time (60s clock-skew tolerance). We do NOT filter by
// workflow file path — Gitea's `path` field shape varies across versions
// (the first prod attempt rejected ALL runs because of an over-strict
// `endsWith` check). Race window: another workflow_dispatch on this repo
// within the same few seconds; the en_tn validator is the only thing
// dispatching this, so fine in practice.
async function findDispatchedRun(
  env: Env,
  cfg: ValidatorConfig,
  sinceUnix: number,
): Promise<DispatchResult> {
  const base = env.DCS_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/runs?event=workflow_dispatch&limit=10`;
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { method: "GET", headers: dcsHeaders(env) });
    if (res.ok) {
      const data = (await res.json()) as unknown;
      const runs = Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : ((data as { workflow_runs?: unknown }).workflow_runs as
            | Array<Record<string, unknown>>
            | undefined) ?? [];
      const candidates = runs
        .map((r) => {
          const id = typeof r.id === "number" ? r.id : 0;
          const htmlUrl = typeof r.html_url === "string" ? r.html_url : "";
          const createdRaw = r.created_at;
          let createdMs = 0;
          if (typeof createdRaw === "string") {
            const t = new Date(createdRaw).getTime();
            createdMs = Number.isFinite(t) ? t : 0;
          } else if (typeof createdRaw === "number") {
            // Some Gitea versions return seconds, some ms. Normalize to ms.
            createdMs = createdRaw < 1e12 ? createdRaw * 1000 : createdRaw;
          }
          return { id, htmlUrl, createdMs };
        })
        .filter((r) => r.id > 0)
        .sort((a, b) => b.createdMs - a.createdMs);
      // Prefer a run timestamped at-or-after our dispatch (60s skew); fall
      // back to the freshest run when timestamp parsing was unreliable
      // (createdMs === 0).
      const sinceMs = (sinceUnix - 60) * 1000;
      const candidate = candidates.find(
        (r) => r.createdMs === 0 || r.createdMs >= sinceMs,
      );
      if (candidate) return { workflowRunId: candidate.id, htmlUrl: candidate.htmlUrl };
      // Diagnostic: capture first run's keys so the error reveals what we saw.
      const sample = runs[0] ? Object.keys(runs[0]).join(",") : "empty";
      lastErr = `no run within window (saw ${runs.length}; keys: ${sample})`;
    } else {
      lastErr = `list_runs ${res.status}`;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`dispatched_but_run_not_found: ${lastErr ?? "unknown"}`);
}

// Find or open the live-snapshot → master PR. The validate workflow's
// first step is "find open PR from live-snapshot to master" — if no PR
// exists, the workflow no-ops with conclusion=success and there's no merge.
// Our nightly export pushes commits to live-snapshot but never opens a PR,
// so we open one here right before dispatching.
async function ensureSnapshotPr(
  env: Env,
  cfg: ValidatorConfig,
): Promise<{ number: number | null; created: boolean; reason: string }> {
  const base = env.DCS_BASE_URL.replace(/\/$/, "");
  const headBranch = env.DCS_EXPORT_BRANCH ?? "live-snapshot";
  const baseBranch = cfg.ref;
  if (headBranch === baseBranch) {
    return { number: null, created: false, reason: "head_equals_base" };
  }

  const listUrl = `${base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/pulls?state=open&limit=50`;
  const listRes = await fetch(listUrl, { method: "GET", headers: dcsHeaders(env) });
  if (!listRes.ok) {
    throw new Error(`pulls_list_failed: ${listRes.status} ${await listRes.text()}`);
  }
  const pulls = (await listRes.json()) as Array<{
    number: number;
    head?: { ref?: string };
    base?: { ref?: string };
  }>;
  const existing = pulls.find(
    (p) => p.head?.ref === headBranch && p.base?.ref === baseBranch,
  );
  if (existing) return { number: existing.number, created: false, reason: "existing" };

  const createUrl = `${base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/pulls`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: dcsHeaders(env),
    body: JSON.stringify({
      head: headBranch,
      base: baseBranch,
      title: `Nightly snapshot: ${headBranch} → ${baseBranch}`,
      body: `Automated PR opened by bible-editor's post-export step so the validate-and-merge workflow has something to merge.`,
    }),
  });
  if (createRes.ok) {
    const created = (await createRes.json()) as { number: number };
    return { number: created.number, created: true, reason: "created" };
  }
  const errText = await createRes.text();
  // Idempotency / common no-op outcomes that we treat as soft-success:
  //   422 — "no commits between" (master is already at live-snapshot), or
  //         a PR is already open (race between list and create).
  if (createRes.status === 422) {
    // Try the list once more to either pick up the racing PR or confirm
    // there's nothing to merge.
    const r2 = await fetch(listUrl, { method: "GET", headers: dcsHeaders(env) });
    if (r2.ok) {
      const ps = (await r2.json()) as Array<{
        number: number;
        head?: { ref?: string };
        base?: { ref?: string };
      }>;
      const ex = ps.find(
        (p) => p.head?.ref === headBranch && p.base?.ref === baseBranch,
      );
      if (ex) return { number: ex.number, created: false, reason: "raced" };
    }
    return { number: null, created: false, reason: `no_op:${errText.slice(0, 200)}` };
  }
  throw new Error(`pull_create_failed: ${createRes.status} ${errText}`);
}

async function getRunStatus(
  env: Env,
  cfg: ValidatorConfig,
  runId: number,
): Promise<RunStatus> {
  const base = env.DCS_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/runs/${runId}`;
  const res = await fetch(url, { method: "GET", headers: dcsHeaders(env) });
  if (!res.ok) {
    throw new Error(`get_run_failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    status?: string;
    conclusion?: string | null;
    html_url?: string;
  };
  return {
    status: body.status ?? "unknown",
    conclusion: body.conclusion ?? null,
    htmlUrl: body.html_url ?? "",
  };
}

async function recordFailureAlert(
  env: Env,
  cfg: ValidatorConfig,
  runUrl: string | null,
  reason: string,
): Promise<void> {
  // Dedup: a second consecutive failure replaces the first so the banner
  // doesn't pile up.
  await env.DB.prepare(
    `DELETE FROM system_alerts
      WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
  )
    .bind(cfg.alertTargetUsername, validateAlertSource(cfg))
    .run();
  const message = `Benjamin fix this — ${cfg.repo} validate-and-merge ${reason}`;
  await env.DB.prepare(
    `INSERT INTO system_alerts (username, severity, source, message, link_url)
     VALUES (?1, 'error', ?2, ?3, ?4)`,
  )
    .bind(cfg.alertTargetUsername, validateAlertSource(cfg), message, runUrl)
    .run();
}

async function clearAlertsForSource(env: Env, source: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE system_alerts
        SET dismissed_at = unixepoch()
      WHERE source = ?1 AND dismissed_at IS NULL`,
  )
    .bind(source)
    .run();
}

// Orchestrates dispatch / poll / act for one validator. Called from
// ExportWorkflow.run after the resource's per-book export steps finish.
//
// dcsAllowed mirrors the export workflow's gate: when the run is a dry-run
// or no DCS_SERVICE_TOKEN is configured, we skip the whole post-export flow
// because there's nothing on the live-snapshot branch to validate.
export async function runPostExport(
  env: Env,
  step: WorkflowStep,
  cfg: ValidatorConfig,
  dcsAllowed: boolean,
): Promise<void> {
  // 1. Skip check. Do NOT skip on "no new commit this run" — the validate
  //    workflow merges the open live-snapshot PR, which may exist from a
  //    prior night's commit that never got validated.
  const skip = await step.do(`post-export-skip-${cfg.repo}`, async () => {
    if (!dcsAllowed) return { skip: true, reason: "dcs_disabled" };
    if (!env.DCS_SERVICE_TOKEN) return { skip: true, reason: "no_service_token" };
    const any = await env.DB.prepare(`SELECT 1 AS x FROM book_imports LIMIT 1`)
      .first<{ x: number }>();
    if (!any) return { skip: true, reason: "no_books_imported" };
    return { skip: false, reason: "" };
  });
  if (skip.skip) return;

  // 2a. Ensure a live-snapshot → master PR exists. The validate workflow's
  //     first step is "find open PR" — without one it logs "nothing to do"
  //     and exits clean, which means master never gets the snapshot. Our
  //     export pushes commits to live-snapshot but never opens a PR, so we
  //     do it here. If there's no diff (master == live-snapshot, 422), we
  //     soft-skip the dispatch since there's nothing meaningful to validate.
  const prInfo = await step.do(
    `ensure-pr-${cfg.repo}`,
    { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
    async () => ensureSnapshotPr(env, cfg),
  );
  if (prInfo.number === null) {
    // Nothing to validate (master already matches live-snapshot, or PR
    // couldn't be opened for a benign reason). Clear any stale validation
    // alert and skip the dispatch + reimport entirely.
    await step.do(`act-${cfg.repo}-no-pr`, async () => {
      await clearAlertsForSource(env, validateAlertSource(cfg));
      return { acted: "no_pr", reason: prInfo.reason };
    });
    return;
  }

  // 2b. Dispatch. Wrapped in try/catch so a dispatch failure (e.g. service
  //     token lacks Actions writer permission on the repo) becomes a
  //     banner rather than a silently errored workflow instance.
  let dispatched: DispatchResult;
  try {
    dispatched = await step.do(
      `dispatch-${cfg.repo}`,
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => dispatchValidate(env, cfg),
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await step.do(`act-${cfg.repo}-dispatch-failed`, async () => {
      await recordFailureAlert(
        env,
        cfg,
        `${env.DCS_BASE_URL}/${cfg.owner}/${cfg.repo}/actions?workflow=${cfg.workflowFile}`,
        `dispatch failed: ${reason.slice(0, 160)}`,
      );
      return { acted: "dispatch_failed", reason };
    });
    return;
  }

  // 3. Poll until completed or budget exhausted. Each tick is its own
  //    step.do WITH retries so a single transient 5xx from DCS doesn't
  //    abort the whole workflow before we get a chance to record an alert.
  let final: { conclusion: string; htmlUrl: string } | null = null;
  for (let i = 0; i < POLL_MAX_ITERATIONS; i++) {
    await step.sleep(`poll-wait-${cfg.repo}-${i}`, POLL_INTERVAL_SECONDS);
    const tick = await step.do(
      `poll-${cfg.repo}-${i}`,
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const s = await getRunStatus(env, cfg, dispatched.workflowRunId);
        if (s.status !== "completed") return { done: false as const };
        return {
          done: true as const,
          conclusion: s.conclusion ?? "no_conclusion",
          htmlUrl: s.htmlUrl || dispatched.htmlUrl,
        };
      },
    );
    if (tick.done) {
      final = { conclusion: tick.conclusion, htmlUrl: tick.htmlUrl };
      break;
    }
  }

  // 4. Decide what to do based on validation outcome. Validation success
  //    clears the validation alert immediately — reimport failures get
  //    their own source (`reimport:${repo}`), so a stale validate_merge
  //    alert hanging around alongside a fresh reimport alert would be a
  //    lie about what just succeeded.
  const decision = await step.do(`act-${cfg.repo}-validation`, async () => {
    const source = validateAlertSource(cfg);
    if (final === null) {
      await recordFailureAlert(env, cfg, dispatched.htmlUrl, "no_completion");
      return { next: "stop" as const, reason: "timeout" };
    }
    if (final.conclusion === "success") {
      await clearAlertsForSource(env, source);
      return { next: "reimport" as const, reason: "success" };
    }
    if (final.conclusion === "skipped") {
      // Workflow validly chose to no-op (e.g. no open live-snapshot PR).
      // Clear any stale validation alert; reimport isn't safe to run when
      // we don't know whether master matches what we just pushed.
      await clearAlertsForSource(env, source);
      return { next: "stop" as const, reason: "skipped" };
    }
    await recordFailureAlert(env, cfg, final.htmlUrl, final.conclusion);
    return { next: "stop" as const, reason: final.conclusion };
  });

  if (decision.next !== "reimport") return;

  // 5. Reimport — one step.do per book, with retries. Persisting per book
  //    means a single flaky DCS fetch retries that one step instead of
  //    forcing the whole post-export back to square one. JS try/catch
  //    collects the outcome so one bad book doesn't fail the workflow.
  const books = await step.do(`list-reimport-books-${cfg.repo}`, async () => {
    const rs = await env.DB.prepare(`SELECT book FROM book_imports ORDER BY book`)
      .all<{ book: string }>();
    return (rs.results ?? []).map((r) => r.book);
  });

  const failedBooks: string[] = [];
  for (const book of books) {
    try {
      await step.do(
        `reimport-${cfg.resource}-${book}`,
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          await reimportOneBook(env, cfg.resource, book);
          return { book, ok: true };
        },
      );
    } catch (e) {
      console.error("post-export reimport failed", {
        resource: cfg.resource,
        book,
        error: e instanceof Error ? e.message : String(e),
      });
      failedBooks.push(book);
    }
  }

  // 6. Finalize: manages ONLY the reimport alert. The validation alert
  //    was already cleared in step 4 the moment validation succeeded —
  //    that's the right answer regardless of how reimport goes, because
  //    leaving a stale validate_merge alert alongside a fresh reimport
  //    alert would misrepresent which step actually failed.
  await step.do(`finalize-reimport-${cfg.repo}`, async () => {
    if (failedBooks.length === 0) {
      await clearAlertsForSource(env, reimportAlertSource(cfg));
      return { ok: true, books: books.length, failed: 0 };
    }
    await recordReimportFailureAlert(env, cfg, failedBooks, books.length);
    return { ok: false, books: books.length, failed: failedBooks.length };
  });
}

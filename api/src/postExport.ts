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
// Returns 200 with {workflow_run_id, html_url, run_url} thanks to DCS's
// return_run_details extension. Throws on non-2xx so the wrapping step.do
// retries; raises an Error with the response body so wrangler tail shows
// what went wrong (typically a 403 = service token lacks Actions writer).
async function dispatchValidate(env: Env, cfg: ValidatorConfig): Promise<DispatchResult> {
  const base = env.DCS_BASE_URL.replace(/\/$/, "");
  const url = `${base}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${encodeURIComponent(cfg.workflowFile)}/dispatches?return_run_details=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: dcsHeaders(env),
    body: JSON.stringify({ ref: cfg.ref }),
  });
  if (!res.ok) {
    throw new Error(`dispatch_failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    workflow_run_id?: number;
    html_url?: string;
  };
  if (typeof body.workflow_run_id !== "number" || !body.html_url) {
    throw new Error(`dispatch_unexpected_body: ${JSON.stringify(body)}`);
  }
  return { workflowRunId: body.workflow_run_id, htmlUrl: body.html_url };
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

  // 2. Dispatch.
  const dispatched = await step.do(
    `dispatch-${cfg.repo}`,
    { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
    async () => dispatchValidate(env, cfg),
  );

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

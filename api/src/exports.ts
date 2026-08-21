// Admin endpoints for the nightly export.
//   POST /api/exports/run         — kick off an export instance now (auth required)
//   GET  /api/exports             — list recent snapshot rows
//   GET  /api/exports/instance/:id — read a Workflow instance's status by id

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAdmin } from "./auth";
import { ALL_RESOURCES, exportBranchOverrideValid, type Resource } from "./export";

export const exports = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

import { RunExportBody as RunBody } from "./exportRequestBodies";

exports.post("/run", requireAdmin, async (c) => {
  // Read the body unconditionally — gating on content-length silently dropped
  // chunked bodies, turning an intended single-book dry run into a full
  // export. Empty body still means "run everything"; non-empty garbage 400s.
  let body: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
  }
  const parsed = RunBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }
  if (parsed.data.allowShrink && !(parsed.data.book && parsed.data.resource)) {
    return c.json({ error: "allow_shrink_requires_book_and_resource" }, 400);
  }
  if (parsed.data.allowMergeRefusal && !(parsed.data.book && parsed.data.resource)) {
    return c.json({ error: "allow_merge_refusal_requires_book_and_resource" }, 400);
  }
  if (parsed.data.allowLocked && !(parsed.data.book && parsed.data.resource)) {
    return c.json({ error: "allow_locked_requires_book_and_resource" }, 400);
  }
  if (parsed.data.branchName && !(parsed.data.book && parsed.data.resource)) {
    return c.json({ error: "branch_name_requires_book_and_resource" }, 400);
  }
  // Rejected at the route, not silently dropped in the workflow: an operator who
  // asked for a specific branch and got the generated `-be-` one anyway would
  // have their published-book fix auto-merged by DCS without noticing.
  if (parsed.data.branchName && !exportBranchOverrideValid(parsed.data.branchName)) {
    return c.json({ error: "invalid_branch_name" }, 400);
  }
  const params = {
    book: parsed.data.book?.toUpperCase(),
    resource: parsed.data.resource as Resource | undefined,
    dryDcs: parsed.data.dryDcs,
    validateAndMerge: parsed.data.validateAndMerge,
    allowShrink: parsed.data.allowShrink,
    allowMergeRefusal: parsed.data.allowMergeRefusal,
    allowLocked: parsed.data.allowLocked,
    branchName: parsed.data.branchName,
  };
  // Deterministic id (millisecond precision) so a double-submitted manual run
  // rejects on the duplicate instead of racing the first. Second precision
  // used to collide when two admin runs landed in the same second; the
  // nightly cron uses `nightly-${day}` ids — see scheduled() in index.ts.
  const id = `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    const instance = await c.env.EXPORT_WORKFLOW.create({ id, params });
    return c.json({ id: instance.id, status: "queued" }, 202);
  } catch (e) {
    return c.json(
      { error: "workflow_create_failed", details: e instanceof Error ? e.message : String(e) },
      409,
    );
  }
});

// Plain listing of the last N snapshot rows. Useful for an /admin/exports
// view and for verification after a manual run.
exports.get("/", requireAdmin, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const bookFilter = c.req.query("book")?.toUpperCase();
  const stmt = bookFilter
    ? c.env.DB.prepare(
        `SELECT id, book, resource, branch, commit_sha, committed_at, rows_exported, error, pr_number, pr_error
           FROM export_snapshots WHERE book = ?1
           ORDER BY id DESC LIMIT ?2`,
      ).bind(bookFilter, limit)
    : c.env.DB.prepare(
        `SELECT id, book, resource, branch, commit_sha, committed_at, rows_exported, error, pr_number, pr_error
           FROM export_snapshots
           ORDER BY id DESC LIMIT ?1`,
      ).bind(limit);
  const rs = await stmt.all<{
    id: number;
    book: string;
    resource: string;
    branch: string | null;
    commit_sha: string | null;
    committed_at: number;
    rows_exported: number;
    error: string | null;
    pr_number: number | null;
    pr_error: string | null;
  }>();
  return c.json({ snapshots: rs.results });
});

// Workflow instance status. The Workflow's own `status()` returns a structured
// payload that includes step-level state — useful for the admin UI later.
exports.get("/instance/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  try {
    const instance = await c.env.EXPORT_WORKFLOW.get(id);
    const status = await instance.status();
    return c.json({ id, status });
  } catch (e) {
    return c.json({ error: "not_found", details: e instanceof Error ? e.message : String(e) }, 404);
  }
});

// Convenience: list the available resources (for an admin UI dropdown).
exports.get("/resources", requireAdmin, async (c) => {
  return c.json({ resources: ALL_RESOURCES });
});

// Admin endpoints for the nightly export.
//   POST /api/exports/run         — kick off an export instance now (auth required)
//   GET  /api/exports             — list recent snapshot rows
//   GET  /api/exports/instance/:id — read a Workflow instance's status by id

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAuth } from "./auth";
import { ALL_RESOURCES, type Resource } from "./export";

export const exports = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const RunBody = z.object({
  book: z.string().min(1).max(8).optional(),
  resource: z.enum(["tn", "tq", "twl", "ult", "ust"]).optional(),
  dryDcs: z.boolean().optional(),
});

exports.post("/run", requireAuth, async (c) => {
  let body: unknown = {};
  try {
    if (c.req.header("content-length")) body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = RunBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }
  const params = {
    book: parsed.data.book?.toUpperCase(),
    resource: parsed.data.resource as Resource | undefined,
    dryDcs: parsed.data.dryDcs,
  };
  const instance = await c.env.EXPORT_WORKFLOW.create({ params });
  return c.json({ id: instance.id, status: "queued" }, 202);
});

// Plain listing of the last N snapshot rows. Useful for an /admin/exports
// view and for verification after a manual run.
exports.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const bookFilter = c.req.query("book")?.toUpperCase();
  const stmt = bookFilter
    ? c.env.DB.prepare(
        `SELECT id, book, resource, commit_sha, committed_at, rows_exported, error
           FROM export_snapshots WHERE book = ?1
           ORDER BY id DESC LIMIT ?2`,
      ).bind(bookFilter, limit)
    : c.env.DB.prepare(
        `SELECT id, book, resource, commit_sha, committed_at, rows_exported, error
           FROM export_snapshots
           ORDER BY id DESC LIMIT ?1`,
      ).bind(limit);
  const rs = await stmt.all<{
    id: number;
    book: string;
    resource: string;
    commit_sha: string | null;
    committed_at: number;
    rows_exported: number;
    error: string | null;
  }>();
  return c.json({ snapshots: rs.results });
});

// Workflow instance status. The Workflow's own `status()` returns a structured
// payload that includes step-level state — useful for the admin UI later.
exports.get("/instance/:id", requireAuth, async (c) => {
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
exports.get("/resources", async (c) => {
  return c.json({ resources: ALL_RESOURCES });
});

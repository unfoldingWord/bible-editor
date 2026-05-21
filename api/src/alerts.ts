// User-targeted banner alerts. The post-export validator writes failure
// rows here; the SPA polls GET /api/alerts/me on auth-ready and renders
// each undismissed row as a top-of-app MUI Alert.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth } from "./auth";

export const alerts = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

alerts.use("*", requireAuth);

interface AlertRow {
  id: number;
  severity: string;
  message: string;
  link_url: string | null;
  created_at: number;
}

alerts.get("/me", async (c) => {
  const username = c.get("username");
  if (!username) return c.json({ alerts: [] });
  const rs = await c.env.DB.prepare(
    `SELECT id, severity, message, link_url, created_at
       FROM system_alerts
      WHERE username = ?1 AND dismissed_at IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(username)
    .all<AlertRow>();
  const list = (rs.results ?? []).map((r) => ({
    id: r.id,
    severity: r.severity,
    message: r.message,
    linkUrl: r.link_url,
    createdAt: r.created_at,
  }));
  return c.json({ alerts: list });
});

// 200 with { ok: true } rather than 204 — the frontend request<T> helper
// unconditionally parses JSON on success and would throw on empty bodies.
alerts.post("/:id/dismiss", async (c) => {
  const username = c.get("username");
  if (!username) return c.json({ error: "unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const r = await c.env.DB.prepare(
    `UPDATE system_alerts
        SET dismissed_at = unixepoch()
      WHERE id = ?1 AND username = ?2 AND dismissed_at IS NULL`,
  )
    .bind(id, username)
    .run();
  if ((r.meta.changes ?? 0) === 0) {
    return c.json({ ok: true, changed: false });
  }
  return c.json({ ok: true, changed: true });
});

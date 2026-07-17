// Admin-only CRUD over the user_roles allowlist (api/migrations/0016_user_roles.sql).
// Until now the only way to grant/revoke admin/editor access was raw SQL
// against D1; this gives admins an in-app REST surface, modeled on
// projectConfigRoutes.ts (zod validation, {error:"snake_code"} bodies).

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
// Explicit .ts extension (tsconfig has allowImportingTsExtensions) so this
// module can also be loaded directly by node's strip-types test runner —
// see adminUsers.test.mjs, which imports this file rather than re-testing
// its logic in isolation.
import { requireAuth, requireAdmin, currentUserId } from "./auth.ts";

export const adminUsers = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

adminUsers.use("*", requireAuth, requireAdmin);

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// GET /api/admin/users — the allowlist, admins first then alpha (COLLATE
// NOCASE matches the PK's collation so casing doesn't affect sort order).
adminUsers.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ur.dcs_username AS username, ur.role AS role, ur.added_at AS addedAt,
            u.dcs_username AS addedBy
       FROM user_roles ur
       LEFT JOIN users u ON u.id = ur.added_by
      ORDER BY CASE ur.role WHEN 'admin' THEN 0 ELSE 1 END, ur.dcs_username COLLATE NOCASE`,
  ).all<{ username: string; role: string; addedAt: number; addedBy: string | null }>();

  return c.json({
    users: results.map((r) => ({
      username: r.username,
      role: r.role,
      addedAt: r.addedAt ?? null,
      addedBy: r.addedBy ?? null,
    })),
  });
});

const PutBody = z.object({
  role: z.enum(["admin", "editor"]),
});

// PUT /api/admin/users/:username — add or change a user's role. Order of
// checks matters (see CLAUDE task spec): body shape, then username shape,
// then DCS existence (canonicalizes casing, fails open on network error),
// then the last-admin guard, then the upsert.
adminUsers.put("/:username", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsedBody = PutBody.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: "invalid_body", detail: parsedBody.error.issues }, 400);
  }
  const newRole = parsedBody.data.role;

  const pathUsername = c.req.param("username");
  if (!USERNAME_RE.test(pathUsername)) {
    return c.json({ error: "invalid_username" }, 400);
  }

  // DCS existence + canonical-casing lookup. No auth required to call this
  // endpoint, but attach the service token when configured (helps with rate
  // limits / private profiles) — same pattern as auth.ts's isViewerOrgMember.
  let canonicalUsername = pathUsername;
  let dcsVerified = true;
  try {
    const headers: Record<string, string> = {};
    if (c.env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${c.env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(
      `${c.env.DCS_BASE_URL}/api/v1/users/${encodeURIComponent(pathUsername)}`,
      { headers },
    );
    if (res.status === 404) {
      return c.json({ error: "dcs_user_not_found" }, 404);
    }
    if (!res.ok) {
      // Non-404 error status: treat like a network failure — fail open.
      dcsVerified = false;
    } else {
      const dcsUser = (await res.json()) as { login?: string };
      if (dcsUser.login) canonicalUsername = dcsUser.login;
    }
  } catch {
    // Network error: fail open, proceed with the path-param username.
    dcsVerified = false;
  }

  // Last-admin guard: refuse to demote the sole remaining admin.
  const current = await c.env.DB.prepare(
    `SELECT role FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(canonicalUsername)
    .first<{ role: string }>();

  if (current?.role === "admin" && newRole === "editor") {
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM user_roles WHERE role = 'admin'`,
    ).first<{ n: number }>();
    if ((count?.n ?? 0) <= 1) {
      return c.json({ error: "last_admin" }, 409);
    }
  }

  // added_by is only set on first insert; ON CONFLICT only touches role, so
  // re-promoting/demoting an existing user preserves who originally added them.
  await c.env.DB.prepare(
    `INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?1, ?2, ?3)
     ON CONFLICT(dcs_username) DO UPDATE SET role = excluded.role`,
  )
    .bind(canonicalUsername, newRole, currentUserId(c))
    .run();

  const row = await c.env.DB.prepare(
    `SELECT ur.dcs_username AS username, ur.role AS role, ur.added_at AS addedAt,
            u.dcs_username AS addedBy
       FROM user_roles ur
       LEFT JOIN users u ON u.id = ur.added_by
      WHERE ur.dcs_username = ?1`,
  )
    .bind(canonicalUsername)
    .first<{ username: string; role: string; addedAt: number; addedBy: string | null }>();

  return c.json({
    user: {
      username: row?.username ?? canonicalUsername,
      role: row?.role ?? newRole,
      addedAt: row?.addedAt ?? null,
      addedBy: row?.addedBy ?? null,
    },
    dcsVerified,
  });
});

// DELETE /api/admin/users/:username — remove from the allowlist. Doesn't
// touch the `users` table (that's the DCS-account cache, unrelated).
adminUsers.delete("/:username", async (c) => {
  const username = c.req.param("username");

  const row = await c.env.DB.prepare(
    `SELECT role FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(username)
    .first<{ role: string }>();
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  if (row.role === "admin") {
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM user_roles WHERE role = 'admin'`,
    ).first<{ n: number }>();
    if ((count?.n ?? 0) <= 1) {
      return c.json({ error: "last_admin" }, 409);
    }
  }

  await c.env.DB.prepare(`DELETE FROM user_roles WHERE dcs_username = ?1`)
    .bind(username)
    .run();

  return c.json({ ok: true });
});

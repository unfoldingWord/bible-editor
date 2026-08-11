// Admin panel backend — everything here is admin-gated (requireAdmin below).
//   GET    /api/admin/sync-status        — D1-only view of pull/export state per book x resource.
//   GET    /api/admin/prs                — live DCS read: open `-be-` export PRs across all 5 repos.
//   GET    /api/admin/users              — list the editor/admin allowlist (user_roles).
//   POST   /api/admin/users              — upsert a user's role.
//   DELETE /api/admin/users/:username    — remove a user from the allowlist.
//   POST   /api/admin/import             — on-demand DCS→D1 pull, inline (chapter-scoped) or via Workflow (whole book).
//
// Mirrors comments.ts: Hono sub-app, requireAdmin module-wide (default-closed
// if a route is added later), zod bodies, CSRF handled globally via
// requireCsrf in index.ts (so mutating routes here need no extra CSRF work).

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAdmin } from "./auth";
import { ALL_RESOURCES, RESOURCE_TARGETS, getCommitStatus, listOpenPrs, type Resource } from "./export";
import {
  reimportBookFromDcs,
  BookNotImportedError,
  ImportInProgressError,
  type Resource as ReimportResource,
} from "./bookReimport";
import { BOOK_NUMBERS } from "./dcsSources";

export const admin = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string; role?: string };
}>();

admin.use("*", requireAdmin);

// ── GET /sync-status ─────────────────────────────────────────────────────────

interface ResourceSyncStatus {
  pulledSha: string | null;
  pulledAt: number | null;
  pullOrigin: string | null;
  lastExportAt: number | null;
  lastExportSha: string | null;
  lastExportError: string | null;
  lastExportRows: number | null;
  branch: string | null;
  prNumber: number | null;
}

admin.get("/sync-status", async (c) => {
  const bookFilter = c.req.query("book")?.toUpperCase();

  // Three queries total (not N+1): books, all pull watermarks, and the
  // newest export_snapshots row per (book, resource) via a window function.
  // Assembly happens in JS below.
  const booksRs = await (bookFilter
    ? c.env.DB.prepare(`SELECT book, imported_at FROM book_imports WHERE book = ?1 ORDER BY book`).bind(
        bookFilter,
      )
    : c.env.DB.prepare(`SELECT book, imported_at FROM book_imports ORDER BY book`)
  ).all<{ book: string; imported_at: number }>();

  const syncsRs = await (bookFilter
    ? c.env.DB.prepare(
        `SELECT book, resource, source_sha, synced_at, origin FROM book_resource_syncs WHERE book = ?1`,
      ).bind(bookFilter)
    : c.env.DB.prepare(`SELECT book, resource, source_sha, synced_at, origin FROM book_resource_syncs`)
  ).all<{ book: string; resource: string; source_sha: string | null; synced_at: number; origin: string }>();

  const exportsRs = await (bookFilter
    ? c.env.DB.prepare(
        `SELECT book, resource, commit_sha, committed_at, rows_exported, error, branch, pr_number FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY book, resource ORDER BY committed_at DESC, id DESC) rn
             FROM export_snapshots WHERE book = ?1
         ) WHERE rn = 1`,
      ).bind(bookFilter)
    : c.env.DB.prepare(
        `SELECT book, resource, commit_sha, committed_at, rows_exported, error, branch, pr_number FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY book, resource ORDER BY committed_at DESC, id DESC) rn
             FROM export_snapshots
         ) WHERE rn = 1`,
      )
  ).all<{
    book: string;
    resource: string;
    commit_sha: string | null;
    committed_at: number;
    rows_exported: number | null;
    error: string | null;
    branch: string | null;
    pr_number: number | null;
  }>();

  const syncsByKey = new Map<string, (typeof syncsRs.results)[number]>();
  for (const row of syncsRs.results ?? []) {
    syncsByKey.set(`${row.book}/${row.resource}`, row);
  }
  const exportsByKey = new Map<string, (typeof exportsRs.results)[number]>();
  for (const row of exportsRs.results ?? []) {
    exportsByKey.set(`${row.book}/${row.resource}`, row);
  }

  const books = (booksRs.results ?? []).map((b) => {
    const resources: Record<Resource, ResourceSyncStatus | null> = {} as Record<
      Resource,
      ResourceSyncStatus | null
    >;
    for (const resource of ALL_RESOURCES) {
      const key = `${b.book}/${resource}`;
      const sync = syncsByKey.get(key);
      const exp = exportsByKey.get(key);
      // No rows on either side → null, not an all-null object.
      if (!sync && !exp) {
        resources[resource] = null;
        continue;
      }
      resources[resource] = {
        pulledSha: sync?.source_sha ?? null,
        pulledAt: sync?.synced_at ?? null,
        pullOrigin: sync?.origin ?? null,
        lastExportAt: exp?.committed_at ?? null,
        lastExportSha: exp?.commit_sha ?? null,
        // Carried through verbatim — it encodes the skip reason
        // (stale_master:*, shrink_guard:*, no_rows, unchanged, dry_run,
        // error:* ...); this route never interprets it.
        lastExportError: exp?.error ?? null,
        lastExportRows: exp?.rows_exported ?? null,
        branch: exp?.branch ?? null,
        prNumber: exp?.pr_number ?? null,
      };
    }
    return { book: b.book, importedAt: b.imported_at, resources };
  });

  return c.json({ books });
});

// ── GET /prs ──────────────────────────────────────────────────────────────

interface AdminPr {
  resource: Resource;
  repo: string;
  book: string;
  number: number;
  title: string;
  branch: string;
  headSha: string;
  baseRef: string;
  mergeable: boolean | null;
  url: string;
  checkState: string | null;
  updatedAt: string | null;
}

admin.get("/prs", async (c) => {
  const token = c.env.DCS_SERVICE_TOKEN;
  if (!token) return c.json({ error: "dcs_not_configured" }, 503);

  const owner = c.env.DCS_EXPORT_OWNER ?? "unfoldingWord";
  const baseUrl = c.env.DCS_BASE_URL;
  const withChecks = c.req.query("checks") !== "0";

  const prs: AdminPr[] = [];
  const errors: Array<{ repo: string; message: string }> = [];

  for (const resource of ALL_RESOURCES) {
    const repo = RESOURCE_TARGETS[resource].repo;
    try {
      const openPrs = await listOpenPrs({ baseUrl, token, owner, repo });
      // `-be-` requires the TRAILING dash — a `{BOOK}-be` branch (no
      // contributor suffix) matches neither the DCS validate workflow nor the
      // merge workflow (see export.ts:41-51), so it's never a real export PR.
      const bePrs = openPrs.filter((pr) => pr.headRef.includes("-be-"));

      const checkStates = withChecks
        ? await Promise.all(bePrs.map((pr) => getCommitStatus({ baseUrl, token, owner, repo }, pr.headSha)))
        : bePrs.map(() => null);

      bePrs.forEach((pr, i) => {
        prs.push({
          resource,
          repo,
          book: pr.headRef.split("-be-")[0].toUpperCase(),
          number: pr.number,
          title: pr.title,
          branch: pr.headRef,
          headSha: pr.headSha,
          baseRef: pr.baseRef,
          mergeable: pr.mergeable,
          url: pr.htmlUrl,
          checkState: checkStates[i],
          updatedAt: pr.updatedAt,
        });
      });
    } catch (e) {
      // One repo's failure (rate limit, network blip) must not fail the
      // whole response — the other 4 repos' PRs are still useful.
      errors.push({ repo, message: e instanceof Error ? e.message : String(e) });
    }
  }

  prs.sort((a, b) => (a.book === b.book ? a.resource.localeCompare(b.resource) : a.book.localeCompare(b.book)));

  return c.json({ prs, errors });
});

// ── User role management ─────────────────────────────────────────────────

// Note: 'viewer' is NOT stored in user_roles — it's derived at auth time from
// DCS org membership (see auth.ts isViewerOrgMember). This table only ever
// holds 'admin' or 'editor'.
admin.get("/users", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT dcs_username, role, added_at, added_by FROM user_roles ORDER BY role, dcs_username`,
  ).all<{ dcs_username: string; role: string; added_at: number; added_by: number | null }>();
  const users = (rs.results ?? []).map((r) => ({
    username: r.dcs_username,
    role: r.role,
    addedAt: r.added_at,
    addedBy: r.added_by,
  }));
  return c.json({ users });
});

const UpsertUserBody = z.object({
  username: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  role: z.enum(["admin", "editor"]),
});

async function countAdmins(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM user_roles WHERE role = 'admin'`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

admin.post("/users", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = UpsertUserBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const { username, role } = parsed.data;

  // dcs_username is COLLATE NOCASE at the DB, so the SELECT/UPSERT below are
  // already case-insensitive; this JS-side compare needs its own lowercasing
  // since `c.get("username")` is a plain string with no collation.
  const callerUsername = c.get("username") ?? "";
  if (username.toLowerCase() === callerUsername.toLowerCase() && role !== "admin") {
    return c.json({ error: "cannot_demote_self" }, 409);
  }

  const existing = await c.env.DB.prepare(`SELECT role FROM user_roles WHERE dcs_username = ?1`)
    .bind(username)
    .first<{ role: string }>();
  if (existing?.role === "admin" && role !== "admin") {
    const admins = await countAdmins(c.env.DB);
    if (admins <= 1) return c.json({ error: "last_admin" }, 409);
  }

  const addedBy = c.get("userId") ?? null;
  await c.env.DB.prepare(
    `INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?1, ?2, ?3)
     ON CONFLICT(dcs_username) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`,
  )
    .bind(username, role, addedBy)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT dcs_username, role, added_at, added_by FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(username)
    .first<{ dcs_username: string; role: string; added_at: number; added_by: number | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ username: row.dcs_username, role: row.role, addedAt: row.added_at, addedBy: row.added_by });
});

admin.delete("/users/:username", async (c) => {
  const username = c.req.param("username");
  const callerUsername = c.get("username") ?? "";
  if (username.toLowerCase() === callerUsername.toLowerCase()) {
    return c.json({ error: "cannot_remove_self" }, 409);
  }

  const existing = await c.env.DB.prepare(`SELECT role FROM user_roles WHERE dcs_username = ?1`)
    .bind(username)
    .first<{ role: string }>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  if (existing.role === "admin") {
    const admins = await countAdmins(c.env.DB);
    if (admins <= 1) return c.json({ error: "last_admin" }, 409);
  }

  await c.env.DB.prepare(`DELETE FROM user_roles WHERE dcs_username = ?1`).bind(username).run();
  return c.json({ ok: true });
});

// ── On-demand DCS→D1 pull ────────────────────────────────────────────────

const ImportBody = z.object({
  book: z.string().min(1).max(8),
  resources: z.array(z.enum(["ult", "ust", "tn", "tq", "twl"])).min(1),
  // >= 0 so chapter 0 (front:intro) is a valid target. Absent/empty means
  // "whole book" — see the mode split below.
  chapters: z.array(z.number().int().min(0)).optional(),
});

// No force flag here (deliberately out of scope for this PR) — normal
// pristine-row protections apply same as POST /api/books/:book/reimport.
admin.post("/import", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = ImportBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const book = parsed.data.book.toUpperCase();
  // Reject a non-canonical book code up front, matching POST
  // /api/books/:book/reimport (bookImport.ts). Without this the code falls
  // through to reimportBookFromDcs, which throws a plain Error("unknown book")
  // and surfaces as a generic 502 — indistinguishable to the panel from a real
  // DCS failure, when it is actually a typo the user can fix.
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);
  const resources = parsed.data.resources as ReimportResource[];
  const chapters = parsed.data.chapters ?? [];
  const userId = c.get("userId") ?? null;

  // Two modes:
  //   - chapters present  → inline, via the same non-destructive per-chapter
  //     logic as POST /api/books/:book/reimport (bookImport.ts). Cheap enough
  //     to run in one request.
  //   - chapters absent   → whole book, via the Workflow. A single-request
  //     whole-book reimport blows Cloudflare's 10-minute step limit on a big
  //     book (documented failure on Isaiah — see
  //     bookReimport.ts:1717-1728); the Workflow chunks the same work across
  //     separate steps instead.
  if (chapters.length > 0) {
    try {
      const result = await reimportBookFromDcs(c.env, book, chapters, resources, userId, { source: "user" });
      return c.json({ mode: "inline", result });
    } catch (e) {
      if (e instanceof BookNotImportedError) return c.json({ error: "book_not_imported", book }, 404);
      if (e instanceof ImportInProgressError) return c.json({ error: "in_progress", book }, 409);
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: "reimport_failed", book, message: msg }, 502);
    }
  }

  const id = `reimport-${book}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    const instance = await c.env.EXPORT_WORKFLOW.create({
      id,
      params: { book, resources, reimportOnly: true },
    });
    return c.json({ mode: "workflow", id: instance.id }, 202);
  } catch (e) {
    return c.json(
      { error: "workflow_create_failed", details: e instanceof Error ? e.message : String(e) },
      409,
    );
  }
});

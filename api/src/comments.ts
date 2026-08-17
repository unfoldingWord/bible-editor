// Internal comments/notes — human-to-human, never exported to DCS. See
// migrations/0037_comments.sql for the schema rationale. Follows the alerts.ts
// conventions: Hono sub-app, requireEditor module-wide (see below), zod
// bodies, 200 JSON always (never 204 — request<T> parses JSON
// unconditionally), CSRF handled globally.
//
// Hard rule: this module writes NOTHING to edit_log. The comments table's own
// author_id/created_at/deleted_at is the complete audit trail.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireEditor, currentUserId, currentUserRole } from "./auth";
import { broadcastChapter } from "./wsEvents";
import type { CommentDto } from "./types";
import { resolveMentions } from "./mentions";

export type { CommentDto };

export const comments = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

// Editors-only for the whole module, reads included. These are internal
// editor-to-editor notes; a read-only viewer can't write one and can't be
// mentioned in one, so they have no business reading the discussion either.
// Gating at the module level (rather than per route) keeps this default-closed
// if another route is added later.
comments.use("*", requireEditor);

interface CommentRow {
  id: number;
  book: string;
  chapter: number;
  verse: number;
  row_kind: "tn" | "tq" | "twl" | null;
  row_id: string | null;
  parent_id: number | null;
  kind: "question" | "note";
  body: string;
  mentions_json: string | null;
  author_id: number;
  author_name: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolved_by: number | null;
  resolved_by_name: string | null;
  deleted_at: number | null;
}

// NULLIF(TRIM(...), '') so an empty-string dcs_full_name (DCS sends "" for
// users with no display name) falls back to the username, not to blank. Plain
// COALESCE only catches NULL, so pre-#385 rows stored a literal "" and rendered
// a blank author. This makes the fallback robust for existing data on read.
const SELECT_COMMENT = `
  SELECT c.*,
         COALESCE(NULLIF(TRIM(a.dcs_full_name), ''), a.dcs_username) AS author_name,
         COALESCE(NULLIF(TRIM(r.dcs_full_name), ''), r.dcs_username) AS resolved_by_name
    FROM comments c
    JOIN users a ON a.id = c.author_id
    LEFT JOIN users r ON r.id = c.resolved_by
`;

function mapRow(row: CommentRow): CommentDto {
  return {
    id: row.id,
    book: row.book,
    chapter: row.chapter,
    verse: row.verse,
    rowKind: row.row_kind,
    rowId: row.row_id,
    parentId: row.parent_id,
    kind: row.kind,
    body: row.body,
    // Guarded parse — one corrupt row must not 500 the whole chapter GET
    // (and a client retry of the 500 would duplicate comments). See
    // parseMentionsJson below.
    mentions: parseMentionsJson(row.mentions_json),
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    deletedAt: row.deleted_at,
  };
}

async function loadComment(db: D1Database, id: number): Promise<CommentDto | null> {
  const row = await db
    .prepare(`${SELECT_COMMENT} WHERE c.id = ?1`)
    .bind(id)
    .first<CommentRow>();
  return row ? mapRow(row) : null;
}

// Every user we could mention. Small trusted roster (the users table only holds
// role-allowlisted accounts), so no filtering or pagination.
comments.get("/mention-users", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT id, dcs_username, dcs_full_name FROM users ORDER BY COALESCE(dcs_full_name, dcs_username)`,
  ).all<{ id: number; dcs_username: string; dcs_full_name: string | null }>();
  const users = (rs.results ?? []).map((r) => ({
    id: r.id,
    // Empty string, not just null — see SELECT_COMMENT (#385).
    username: r.dcs_username,
    fullName: r.dcs_full_name && r.dcs_full_name.trim() ? r.dcs_full_name : r.dcs_username,
  }));
  return c.json({ users });
});

comments.get("/:book/:chapter", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  if (!book || !Number.isFinite(chapter)) {
    return c.json({ error: "invalid_params" }, 400);
  }
  const rs = await c.env.DB.prepare(
    `${SELECT_COMMENT} WHERE c.book = ?1 AND c.chapter = ?2 AND c.deleted_at IS NULL
     ORDER BY c.created_at ASC, c.id ASC`,
  )
    .bind(book, chapter)
    .all<CommentRow>();
  const list = (rs.results ?? []).map(mapRow);
  return c.json({ comments: list });
});

// Book-wide roll-up of open (unresolved) top-level threads, grouped by
// location. Powers the TopBar "notes in this book" indicator (issue #441) so
// editors can find and review comments across a whole book without opening
// each chapter — including on published/locked books, where comments stay
// writable. 3-segment path so it never collides with `/:book/:chapter`.
comments.get("/:book/notes/summary", async (c) => {
  const book = c.req.param("book").toUpperCase();
  if (!book) return c.json({ error: "invalid_params" }, 400);
  const rs = await c.env.DB.prepare(
    `SELECT chapter, verse, row_kind, kind, COUNT(*) AS n
       FROM comments
      WHERE book = ?1
        AND deleted_at IS NULL
        AND parent_id IS NULL
        AND resolved_at IS NULL
      GROUP BY chapter, verse, row_kind, kind
      ORDER BY chapter ASC, verse ASC`,
  )
    .bind(book)
    .all<{
      chapter: number;
      verse: number;
      row_kind: "tn" | "tq" | "twl" | null;
      kind: "question" | "note";
      n: number;
    }>();
  let questions = 0;
  let notes = 0;
  const locations = (rs.results ?? []).map((r) => {
    if (r.kind === "question") questions += r.n;
    else notes += r.n;
    return {
      chapter: r.chapter,
      verse: r.verse,
      rowKind: r.row_kind,
      kind: r.kind,
      count: r.n,
    };
  });
  return c.json({ locations, questions, notes, total: questions + notes });
});

const CreateBody = z.object({
  book: z.string().min(1),
  chapter: z.number().int().min(0),
  verse: z.number().int().min(0),
  rowKind: z.enum(["tn", "tq", "twl"]).optional(),
  rowId: z.string().min(1).optional(),
  parentId: z.number().int().positive().optional(),
  kind: z.enum(["question", "note"]),
  body: z.string().trim().min(1).max(5000),
});

async function allUsernames(db: D1Database): Promise<string[]> {
  const rs = await db.prepare(`SELECT dcs_username FROM users`).all<{ dcs_username: string }>();
  return (rs.results ?? []).map((r) => r.dcs_username);
}

// mentions_json is always written by this module as JSON.stringify(string[]),
// but the reply-notify parse runs AFTER the reply row is inserted: a single
// corrupted row would 500 the request, and a client retry would then create a
// duplicate comment. Swallow a bad parse rather than risk that.
function parseMentionsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

comments.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const data = parsed.data;

  if ((data.rowKind == null) !== (data.rowId == null)) {
    return c.json({ error: "invalid_anchor" }, 400);
  }

  let book = data.book.toUpperCase();
  let chapter = data.chapter;
  let verse = data.verse;
  let rowKind: "tn" | "tq" | "twl" | null = data.rowKind ?? null;
  let rowId: string | null = data.rowId ?? null;
  let kind = data.kind;
  let parentId: number | null = null;

  if (data.parentId != null) {
    const parent = await c.env.DB.prepare(
      `SELECT * FROM comments WHERE id = ?1 AND deleted_at IS NULL AND parent_id IS NULL`,
    )
      .bind(data.parentId)
      .first<CommentRow>();
    if (!parent) return c.json({ error: "invalid_parent" }, 400);
    // Reply inherits the parent's anchor/kind — ignore any conflicting client values.
    parentId = parent.id;
    book = parent.book;
    chapter = parent.chapter;
    verse = parent.verse;
    rowKind = parent.row_kind;
    rowId = parent.row_id;
    kind = parent.kind;
  }

  const userId = currentUserId(c);
  const username = c.get("username");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const knownUsernames = await allUsernames(c.env.DB);
  const mentions = resolveMentions(data.body, knownUsernames, username);

  const insert = await c.env.DB.prepare(
    `INSERT INTO comments (book, chapter, verse, row_kind, row_id, parent_id, kind, body, mentions_json, author_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      book,
      chapter,
      verse,
      rowKind,
      rowId,
      parentId,
      kind,
      data.body,
      mentions.length > 0 ? JSON.stringify(mentions) : null,
      userId,
    )
    .run();
  const newId = insert.meta.last_row_id as number;

  const comment = await loadComment(c.env.DB, newId);
  if (!comment) return c.json({ error: "not_found" }, 404);

  const linkUrl = `/#/${book}/${chapter}/${verse}?c=${parentId ?? newId}`;
  const mentionedLower = new Set(mentions.map((u) => u.toLowerCase()));

  if (mentions.length > 0) {
    const message = `${comment.authorName} mentioned you in ${book} ${chapter}:${verse}`;
    await c.env.DB.batch(
      mentions.map((mentionedUsername) =>
        c.env.DB.prepare(
          `INSERT INTO system_alerts (username, severity, source, message, link_url)
           VALUES (?1, 'info', 'comment_mention', ?2, ?3)`,
        ).bind(mentionedUsername, message, linkUrl),
      ),
    );
  }

  // Reply → notify everyone already in the thread (issue #441: "people are not
  // receiving notifications of responses"). Prior mentions only ever alerted
  // the person @-tagged, so a plain reply reached nobody. Notify the root
  // author + every prior participant + everyone previously @-mentioned in the
  // thread, minus the replier themselves and minus anyone this reply already
  // @-mentioned (they get the mention alert above, not a duplicate).
  if (parentId != null) {
    const rootId = parentId;
    const rows = await c.env.DB.prepare(
      `SELECT u.dcs_username AS username, c.mentions_json AS mentions_json
         FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE (c.id = ?1 OR c.parent_id = ?1) AND c.deleted_at IS NULL`,
    )
      .bind(rootId)
      .all<{ username: string; mentions_json: string | null }>();
    const selfLower = (username ?? "").toLowerCase();
    const recipients = new Map<string, string>(); // lower → canonical
    for (const r of rows.results ?? []) {
      if (r.username) recipients.set(r.username.toLowerCase(), r.username);
      for (const m of parseMentionsJson(r.mentions_json)) {
        recipients.set(m.toLowerCase(), m);
      }
    }
    recipients.delete(selfLower);
    for (const lower of mentionedLower) recipients.delete(lower);
    if (recipients.size > 0) {
      const message = `${comment.authorName} replied to a ${kind} in ${book} ${chapter}:${verse}`;
      await c.env.DB.batch(
        [...recipients.values()].map((recipient) =>
          c.env.DB.prepare(
            `INSERT INTO system_alerts (username, severity, source, message, link_url)
             VALUES (?1, 'info', 'comment_reply', ?2, ?3)`,
          ).bind(recipient, message, linkUrl),
        ),
      );
    }
  }

  c.executionCtx.waitUntil(broadcastChapter(c.env, book, chapter, { type: "comment.updated", comment }));
  return c.json(comment);
});

const UpdateBody = z.object({ body: z.string().trim().min(1).max(5000) });

comments.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "invalid_params" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = UpdateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const existing = await c.env.DB.prepare(`SELECT * FROM comments WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<CommentRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const userId = currentUserId(c);
  if (existing.author_id !== userId) {
    return c.json({ error: "forbidden", reason: "not_author" }, 403);
  }

  const username = c.get("username");
  const knownUsernames = await allUsernames(c.env.DB);
  const newMentions = resolveMentions(parsed.data.body, knownUsernames, username);
  // Guarded parse — a corrupt mentions_json must not 500 the edit (see
  // parseMentionsJson); worst case every mention counts as newly added.
  const oldMentions: string[] = parseMentionsJson(existing.mentions_json);
  const oldLower = new Set(oldMentions.map((u) => u.toLowerCase()));
  const addedMentions = newMentions.filter((u) => !oldLower.has(u.toLowerCase()));

  await c.env.DB.prepare(
    `UPDATE comments SET body = ?1, mentions_json = ?2, updated_at = unixepoch() WHERE id = ?3`,
  )
    .bind(parsed.data.body, newMentions.length > 0 ? JSON.stringify(newMentions) : null, id)
    .run();

  const comment = await loadComment(c.env.DB, id);
  if (!comment) return c.json({ error: "not_found" }, 404);

  if (addedMentions.length > 0) {
    const rootId = comment.parentId ?? comment.id;
    const message = `${comment.authorName} mentioned you in ${comment.book} ${comment.chapter}:${comment.verse}`;
    const linkUrl = `/#/${comment.book}/${comment.chapter}/${comment.verse}?c=${rootId}`;
    await c.env.DB.batch(
      addedMentions.map((mentionedUsername) =>
        c.env.DB.prepare(
          `INSERT INTO system_alerts (username, severity, source, message, link_url)
           VALUES (?1, 'info', 'comment_mention', ?2, ?3)`,
        ).bind(mentionedUsername, message, linkUrl),
      ),
    );
  }

  c.executionCtx.waitUntil(
    broadcastChapter(c.env, comment.book, comment.chapter, { type: "comment.updated", comment }),
  );
  return c.json(comment);
});

const ResolveBody = z.object({ resolved: z.boolean() });

comments.post("/:id/resolve", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "invalid_params" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = ResolveBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const existing = await c.env.DB.prepare(`SELECT * FROM comments WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<CommentRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.parent_id !== null) return c.json({ error: "not_top_level" }, 400);

  const userId = currentUserId(c);
  if (parsed.data.resolved) {
    await c.env.DB.prepare(
      `UPDATE comments SET resolved_at = unixepoch(), resolved_by = ?1, updated_at = unixepoch()
        WHERE id = ?2 AND deleted_at IS NULL`,
    )
      .bind(userId, id)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE comments SET resolved_at = NULL, resolved_by = NULL, updated_at = unixepoch()
        WHERE id = ?1 AND deleted_at IS NULL`,
    )
      .bind(id)
      .run();
  }

  const comment = await loadComment(c.env.DB, id);
  if (!comment) return c.json({ error: "not_found" }, 404);

  c.executionCtx.waitUntil(
    broadcastChapter(c.env, comment.book, comment.chapter, { type: "comment.updated", comment }),
  );
  return c.json(comment);
});

comments.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "invalid_params" }, 400);

  const existing = await c.env.DB.prepare(`SELECT * FROM comments WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<CommentRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const userId = currentUserId(c);
  const role = currentUserRole(c);
  if (existing.author_id !== userId && role !== "admin") {
    return c.json({ error: "forbidden", reason: "not_author" }, 403);
  }

  // Batched so a root can never end up deleted while its replies survive as
  // orphans (stored, invisible to the client's orphan guard, and un-deletable).
  const deletes = [
    c.env.DB
      .prepare(`UPDATE comments SET deleted_at = unixepoch() WHERE id = ?1 AND deleted_at IS NULL`)
      .bind(id),
  ];
  if (existing.parent_id === null) {
    deletes.push(
      c.env.DB
        .prepare(
          `UPDATE comments SET deleted_at = unixepoch() WHERE parent_id = ?1 AND deleted_at IS NULL`,
        )
        .bind(id),
    );
  }
  await c.env.DB.batch(deletes);

  const deletedRow = await c.env.DB.prepare(`${SELECT_COMMENT} WHERE c.id = ?1`).bind(id).first<CommentRow>();
  if (deletedRow) {
    const comment = mapRow(deletedRow);
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, comment.book, comment.chapter, { type: "comment.updated", comment }),
    );
  }

  return c.json({ ok: true });
});

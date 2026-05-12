import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { RowKind, TnRow, TqRow, TwlRow } from "./types";

export const rows = new Hono<{ Bindings: Env }>();

const KIND_TO_TABLE: Record<RowKind, string> = {
  tn: "tn_rows",
  tq: "tq_rows",
  twl: "twl_rows",
};

const isRowKind = (k: string): k is RowKind => k in KIND_TO_TABLE;

// Reuse the Hono request lifecycle to pull "expected version" off the
// If-Match header. We accept a bare integer ("If-Match: 7") for simplicity.
function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const n = parseInt(header.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

const TnPatch = z.object({
  ref_raw: z.string().optional(),
  tags: z.string().nullable().optional(),
  support_reference: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
});

const TqPatch = z.object({
  ref_raw: z.string().optional(),
  tags: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  question: z.string().nullable().optional(),
  response: z.string().nullable().optional(),
});

const TwlPatch = z.object({
  ref_raw: z.string().optional(),
  tags: z.string().nullable().optional(),
  orig_words: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  tw_link: z.string().nullable().optional(),
});

const PATCH_SCHEMA = { tn: TnPatch, tq: TqPatch, twl: TwlPatch };

// Generate a 4-char alphanumeric ID matching the DCS sticky-id convention.
function newRowId(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const CreateTn = z.object({
  book: z.string(),
  chapter: z.number().int().nonnegative(),
  verse: z.number().int().nonnegative(),
  ref_raw: z.string(),
  tags: z.string().nullable().optional(),
  support_reference: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
});
const CreateTq = z.object({
  book: z.string(),
  chapter: z.number().int().nonnegative(),
  verse: z.number().int().nonnegative(),
  ref_raw: z.string(),
  tags: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  question: z.string().nullable().optional(),
  response: z.string().nullable().optional(),
});
const CreateTwl = z.object({
  book: z.string(),
  chapter: z.number().int().nonnegative(),
  verse: z.number().int().nonnegative(),
  ref_raw: z.string(),
  tags: z.string().nullable().optional(),
  orig_words: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  tw_link: z.string().nullable().optional(),
});
const CREATE_SCHEMA = { tn: CreateTn, tq: CreateTq, twl: CreateTwl };

rows.post("/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = CREATE_SCHEMA[kind].safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  const data = parsed.data as Record<string, unknown>;

  // Generate ids until we miss any existing collision. With 32^4 = ~1M space
  // a collision is rare; this loop is paranoia.
  let id = newRowId();
  for (let i = 0; i < 8; i++) {
    const exists = await c.env.DB.prepare(`SELECT 1 FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`).bind(id).first();
    if (!exists) break;
    id = newRowId();
  }

  const cols = ["id", ...Object.keys(data)];
  const placeholders = cols.map((_c, i) => `?${i + 1}`).join(", ");
  const values: unknown[] = [id, ...Object.values(data)];
  await c.env.DB.prepare(
    `INSERT INTO ${KIND_TO_TABLE[kind]} (${cols.join(", ")}) VALUES (${placeholders})`,
  )
    .bind(...values)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action, payload_json) VALUES (?1, ?2, NULL, 1, 'create', ?3)`,
  )
    .bind(kind, id, JSON.stringify(data))
    .run();

  const created = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`,
  )
    .bind(id)
    .first();
  return c.json(created, 201);
});

rows.get("/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`,
  )
    .bind(id)
    .first<TnRow | TqRow | TwlRow>();
  if (!row || row.deleted_at) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

// Single-row PATCH with optimistic concurrency via If-Match.
rows.patch("/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);

  const expected = parseIfMatch(c.req.header("if-match"));

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const schema = PATCH_SCHEMA[kind];
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }
  const patch = parsed.data;

  const current = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`,
  )
    .bind(id)
    .first<{ version: number; deleted_at: number | null }>();
  if (!current || current.deleted_at) return c.json({ error: "not_found" }, 404);

  if (expected !== null && expected !== current.version) {
    // Conflict — caller's expected version doesn't match. Return the fresh row.
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`,
    )
      .bind(id)
      .first();
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }

  const fields = Object.keys(patch);
  if (fields.length === 0) {
    return c.json({ error: "empty_patch" }, 400);
  }

  const newVersion = current.version + 1;
  const now = Math.floor(Date.now() / 1000);
  const setClauses = fields.map((f, i) => `${f} = ?${i + 1}`);
  setClauses.push(`version = ?${fields.length + 1}`);
  setClauses.push(`updated_at = ?${fields.length + 2}`);
  const values = [
    ...fields.map((f) => (patch as Record<string, unknown>)[f]),
    newVersion,
    now,
  ];

  await c.env.DB.prepare(
    `UPDATE ${KIND_TO_TABLE[kind]} SET ${setClauses.join(", ")} WHERE id = ?${values.length + 1}`,
  )
    .bind(...values, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action, payload_json) VALUES (?1, ?2, ?3, ?4, 'update', ?5)`,
  )
    .bind(kind, id, current.version, newVersion, JSON.stringify(patch))
    .run();

  const updated = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`,
  )
    .bind(id)
    .first();
  return c.json(updated);
});

// Soft delete.
rows.delete("/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  const expected = parseIfMatch(c.req.header("if-match"));

  const current = await c.env.DB.prepare(
    `SELECT version, deleted_at FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1`,
  )
    .bind(id)
    .first<{ version: number; deleted_at: number | null }>();
  if (!current || current.deleted_at) return c.json({ error: "not_found" }, 404);
  if (expected !== null && expected !== current.version) {
    return c.json({ error: "version_mismatch" }, 409);
  }
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `UPDATE ${KIND_TO_TABLE[kind]} SET deleted_at = ?1, version = version + 1, updated_at = ?1 WHERE id = ?2`,
  )
    .bind(now, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action) VALUES (?1, ?2, ?3, ?4, 'delete')`,
  )
    .bind(kind, id, current.version, current.version + 1)
    .run();
  return c.json({ ok: true });
});

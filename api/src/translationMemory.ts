// Translation preferences & memory routes (migration 0040; design in
// docs/preferences-panel-design.md). Three surfaces:
//   /prefs     — singleton brief + instructions + register + assisted flag
//   /terms     — concept-oriented termbase CRUD + CSV import/export
//   /examples  — read-only browse over validated rows (the few-shot memory)
// PATCH/PUT mirror the articles.ts version-CAS/If-Match/409 mechanics. Pure
// logic (CSV, picklists) lives in translationMemoryLib.ts so it stays testable.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireEditor, requireAdmin } from "./auth";
import {
  REGISTERS,
  TERM_STATUSES,
  isTermStatus,
  parseTermsCsv,
  serializeTermsCsv,
  dedupeTerms,
  termKey,
  type TermImport,
} from "./translationMemoryLib.ts";

export const translationMemory = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^"?(\d+)"?$/.exec(header.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Preferences singleton (brief + instructions + register + assisted flag).
// ---------------------------------------------------------------------------

type PrefsRow = {
  id: number;
  audience: string | null;
  purpose: string | null;
  register: string;
  script_notes: string | null;
  instructions_md: string | null;
  notes: string | null;
  assisted_mode: number;
  version: number;
  updated_at: number;
  updated_by: number | null;
};

const DEFAULT_PREFS: PrefsRow = {
  id: 1,
  audience: null,
  purpose: null,
  register: "default",
  script_notes: null,
  instructions_md: null,
  notes: null,
  assisted_mode: 0,
  version: 0, // 0 = never written; the first PUT must send If-Match: 0
  updated_at: 0,
  updated_by: null,
};

// GET /prefs — editor-readable (drives the panel + the assisted-mode toggle).
// Returns the default (version 0) shape when the row has never been written, so
// the client always has a stable object and the first PUT sends If-Match: 0.
translationMemory.get("/prefs", requireEditor, async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
  return c.json({ prefs: row ?? DEFAULT_PREFS });
});

const PutPrefsBody = z.object({
  audience: z.string().max(4000).nullable().optional(),
  purpose: z.string().max(4000).nullable().optional(),
  register: z.enum(REGISTERS).optional(),
  script_notes: z.string().max(8000).nullable().optional(),
  instructions_md: z.string().max(20000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  assisted_mode: z.boolean().optional(),
});

// PUT /prefs — admin-only. If-Match version CAS. Upserts the singleton: on the
// first write (row absent) the INSERT fires with version 1; thereafter the
// UPDATE bumps version guarded on the expected value.
translationMemory.put("/prefs", requireAdmin, async (c) => {
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PutPrefsBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const existing = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();

  if (!existing) {
    // First write: only valid against If-Match: 0. Coalesce omitted fields to defaults.
    if (expected !== 0) return c.json({ error: "version_mismatch", current: DEFAULT_PREFS }, 409);
    const d = parsed.data;
    await c.env.DB.prepare(
      `INSERT INTO translation_prefs
         (id, audience, purpose, register, script_notes, instructions_md, notes, assisted_mode, version, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)`,
    )
      .bind(
        d.audience ?? null,
        d.purpose ?? null,
        d.register ?? "default",
        d.script_notes ?? null,
        d.instructions_md ?? null,
        d.notes ?? null,
        d.assisted_mode ? 1 : 0,
        now,
        userId ?? null,
      )
      .run();
    const row = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
    return c.json({ prefs: row });
  }

  // Merge omitted fields from the existing row (partial update semantics).
  const merged = {
    audience: parsed.data.audience !== undefined ? parsed.data.audience : existing.audience,
    purpose: parsed.data.purpose !== undefined ? parsed.data.purpose : existing.purpose,
    register: parsed.data.register ?? existing.register,
    script_notes: parsed.data.script_notes !== undefined ? parsed.data.script_notes : existing.script_notes,
    instructions_md:
      parsed.data.instructions_md !== undefined ? parsed.data.instructions_md : existing.instructions_md,
    notes: parsed.data.notes !== undefined ? parsed.data.notes : existing.notes,
    assisted_mode: parsed.data.assisted_mode !== undefined ? (parsed.data.assisted_mode ? 1 : 0) : existing.assisted_mode,
  };
  const res = await c.env.DB.prepare(
    `UPDATE translation_prefs
        SET audience = ?1, purpose = ?2, register = ?3, script_notes = ?4,
            instructions_md = ?5, notes = ?6, assisted_mode = ?7,
            version = version + 1, updated_at = ?8, updated_by = ?9
      WHERE id = 1 AND version = ?10`,
  )
    .bind(
      merged.audience,
      merged.purpose,
      merged.register,
      merged.script_notes,
      merged.instructions_md,
      merged.notes,
      merged.assisted_mode,
      now,
      userId ?? null,
      expected,
    )
    .run();
  if (!res.meta.changes) return c.json({ error: "version_mismatch", current: existing }, 409);
  const row = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
  return c.json({ prefs: row });
});

// ---------------------------------------------------------------------------
// Terminology CRUD + CSV.
// ---------------------------------------------------------------------------

type TermRow = TermImport & {
  id: number;
  source_status: string;
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: number | null;
};

const TERM_COLS = `id, concept_id, source_term, target_term, status, replacement, comment, tw_link,
                   source_status, version, created_at, updated_at, updated_by`;

// GET /terms — list (optional status / q filters). Excludes soft-deleted.
translationMemory.get("/terms", requireEditor, async (c) => {
  const status = c.req.query("status");
  const q = c.req.query("q");
  const conds = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (status && isTermStatus(status)) {
    binds.push(status);
    conds.push(`status = ?${binds.length}`);
  }
  if (q) {
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
    conds.push(`(source_term LIKE ?${binds.length - 2} OR target_term LIKE ?${binds.length - 1} OR concept_id LIKE ?${binds.length})`);
  }
  const rows = await c.env.DB.prepare(
    `SELECT ${TERM_COLS} FROM terminology WHERE ${conds.join(" AND ")}
      ORDER BY concept_id, source_term, id`,
  )
    .bind(...binds)
    .all<TermRow>();
  return c.json({ terms: rows.results ?? [] });
});

const TermBody = z.object({
  concept_id: z.string().min(1).max(200),
  source_term: z.string().min(1).max(500),
  target_term: z.string().max(1000).nullable().optional(),
  status: z.enum(TERM_STATUSES).optional(),
  replacement: z.string().max(1000).nullable().optional(),
  comment: z.string().max(4000).nullable().optional(),
  tw_link: z.string().max(500).nullable().optional(),
});

// POST /terms — create one term row.
translationMemory.post("/terms", requireEditor, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TermBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const d = parsed.data;
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.prepare(
    `INSERT INTO terminology
       (concept_id, source_term, target_term, status, replacement, comment, tw_link, source_status, version, created_at, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'manual', 1, ?8, ?8, ?9)`,
  )
    .bind(
      d.concept_id,
      d.source_term,
      d.target_term ?? null,
      d.status ?? "preferred",
      d.replacement ?? null,
      d.comment ?? null,
      d.tw_link ?? null,
      now,
      userId ?? null,
    )
    .run();
  const id = res.meta.last_row_id;
  const row = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1`)
    .bind(id)
    .first<TermRow>();
  return c.json(row, 201);
});

// PATCH /terms/:id — If-Match version CAS.
translationMemory.patch("/terms/:id", requireEditor, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TermBody.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const existing = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<TermRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);
  const d = parsed.data;
  const merged = {
    concept_id: d.concept_id ?? existing.concept_id,
    source_term: d.source_term ?? existing.source_term,
    target_term: d.target_term !== undefined ? d.target_term : existing.target_term,
    status: d.status ?? existing.status,
    replacement: d.replacement !== undefined ? d.replacement : existing.replacement,
    comment: d.comment !== undefined ? d.comment : existing.comment,
    tw_link: d.tw_link !== undefined ? d.tw_link : existing.tw_link,
  };
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.prepare(
    `UPDATE terminology
        SET concept_id = ?1, source_term = ?2, target_term = ?3, status = ?4,
            replacement = ?5, comment = ?6, tw_link = ?7,
            version = version + 1, updated_at = ?8, updated_by = ?9
      WHERE id = ?10 AND deleted_at IS NULL AND version = ?11`,
  )
    .bind(
      merged.concept_id,
      merged.source_term,
      merged.target_term,
      merged.status,
      merged.replacement,
      merged.comment,
      merged.tw_link,
      now,
      userId ?? null,
      id,
      expected,
    )
    .run();
  if (!res.meta.changes) {
    const cur = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1 AND deleted_at IS NULL`)
      .bind(id)
      .first<TermRow>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "version_mismatch", current: cur }, 409);
  }
  const row = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1`).bind(id).first<TermRow>();
  return c.json(row);
});

// DELETE /terms/:id — soft delete.
translationMemory.delete("/terms/:id", requireEditor, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.prepare(
    `UPDATE terminology SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`,
  )
    .bind(now, id)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// GET /terms/export — CSV download of the whole live termbase.
translationMemory.get("/terms/export", requireEditor, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT concept_id, source_term, target_term, status, replacement, comment, tw_link
       FROM terminology WHERE deleted_at IS NULL ORDER BY concept_id, source_term, id`,
  ).all<TermImport>();
  const csv = serializeTermsCsv(rows.results ?? []);
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="terminology.csv"',
  });
});

// POST /terms/import — CSV upsert. Body is raw CSV text. ?dryRun=1 returns the
// parsed diff (added/updated counts + parse errors) without writing.
translationMemory.post("/terms/import", requireEditor, async (c) => {
  const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
  const text = await c.req.text();
  if (!text.trim()) return c.json({ error: "empty_body" }, 400);
  const { terms, errors } = parseTermsCsv(text);
  const deduped = dedupeTerms(terms);

  // Which of these already exist (by termKey) → update vs add.
  const existingRows = await c.env.DB.prepare(
    `SELECT concept_id, source_term, status FROM terminology WHERE deleted_at IS NULL`,
  ).all<{ concept_id: string; source_term: string; status: string }>();
  const existingKeys = new Set((existingRows.results ?? []).map((r) => termKey(r)));
  let added = 0;
  let updated = 0;
  for (const t of deduped) (existingKeys.has(termKey(t)) ? updated++ : added++);

  if (dryRun) return c.json({ dryRun: true, added, updated, parseErrors: errors, total: deduped.length });

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  // Upsert each row: UPDATE by (concept_id, source_term, status); INSERT if none.
  for (const t of deduped) {
    const upd = await c.env.DB.prepare(
      `UPDATE terminology
          SET target_term = ?1, replacement = ?2, comment = ?3, tw_link = ?4,
              source_status = 'imported', version = version + 1, updated_at = ?5, updated_by = ?6
        WHERE deleted_at IS NULL AND concept_id = ?7 AND source_term = ?8 AND status = ?9`,
    )
      .bind(t.target_term, t.replacement, t.comment, t.tw_link, now, userId ?? null, t.concept_id, t.source_term, t.status)
      .run();
    if (!upd.meta.changes) {
      await c.env.DB.prepare(
        `INSERT INTO terminology
           (concept_id, source_term, target_term, status, replacement, comment, tw_link, source_status, version, created_at, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'imported', 1, ?8, ?8, ?9)`,
      )
        .bind(t.concept_id, t.source_term, t.target_term, t.status, t.replacement, t.comment, t.tw_link, now, userId ?? null)
        .run();
    }
  }
  return c.json({ dryRun: false, added, updated, parseErrors: errors, total: deduped.length });
});

// GET /terms/count — cheap count for the language-memory chip.
translationMemory.get("/terms/count", requireEditor, async (c) => {
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM terminology WHERE deleted_at IS NULL`).first<{
    n: number;
  }>();
  return c.json({ count: row?.n ?? 0 });
});

// ---------------------------------------------------------------------------
// Validated examples (read-only browse). No table — validated rows ARE the
// examples. The English source pairing is resolved client-side (useSourceNotes),
// so this returns the target rows + their sticky rowId.
// ---------------------------------------------------------------------------

translationMemory.get("/examples", requireEditor, async (c) => {
  const resource = c.req.query("resource") ?? "tn";
  const supportRef = c.req.query("supportReference");
  const q = c.req.query("q");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);

  if (resource === "tn") {
    const conds = ["translation_state = 'validated'", "deleted_at IS NULL"];
    const binds: unknown[] = [];
    if (supportRef) {
      binds.push(supportRef);
      conds.push(`support_reference = ?${binds.length}`);
    }
    if (q) {
      binds.push(`%${q}%`, `%${q}%`);
      conds.push(`(note LIKE ?${binds.length - 1} OR quote LIKE ?${binds.length})`);
    }
    binds.push(limit);
    const rows = await c.env.DB.prepare(
      `SELECT id, book, ref_raw, support_reference, quote, occurrence, note, translation_state, updated_at
         FROM tn_rows WHERE ${conds.join(" AND ")}
        ORDER BY updated_at DESC LIMIT ?${binds.length}`,
    )
      .bind(...binds)
      .all();
    return c.json({ resource: "tn", examples: rows.results ?? [] });
  }
  if (resource === "tq") {
    const conds = ["translation_state = 'validated'", "deleted_at IS NULL"];
    const binds: unknown[] = [];
    if (q) {
      binds.push(`%${q}%`, `%${q}%`);
      conds.push(`(question LIKE ?${binds.length - 1} OR response LIKE ?${binds.length})`);
    }
    binds.push(limit);
    const rows = await c.env.DB.prepare(
      `SELECT id, book, ref_raw, quote, occurrence, question, response, translation_state, updated_at
         FROM tq_rows WHERE ${conds.join(" AND ")}
        ORDER BY updated_at DESC LIMIT ?${binds.length}`,
    )
      .bind(...binds)
      .all();
    return c.json({ resource: "tq", examples: rows.results ?? [] });
  }
  return c.json({ error: "unknown_resource" }, 400);
});

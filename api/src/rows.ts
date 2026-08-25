import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { CheckLane, RowKind, TnRow, TqRow, TwlRow } from "./types";
import { currentUserId, requireEditor } from "./auth";
import { activePipelineForChapter, lockedResponseBody } from "./chapterLock";
import { broadcastChapter } from "./wsEvents";
import { newRowId } from "./rowId";
import { blankStubClause } from "./blankStub";
import { contentPatchClearClauses } from "./contentPatchClauses";
import { reopenLaneChecks } from "./laneReopen";
import { refParts, coveredVersesFromRef } from "./importParsers";
import { requiredOccurrence } from "./occurrenceRule";
import { findRawTabField } from "./rawTabGuard";
import { isValidChapterZeroRef } from "./chapterZeroGuard";
import { normalizeBookCode, CHAPTER_EXISTS_SQL } from "./rowsCreateGuard";
import { boundHistoryToLastCreate } from "./rowHistoryBoundary";

export const rows = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const KIND_TO_TABLE: Record<RowKind, string> = {
  tn: "tn_rows",
  tq: "tq_rows",
  twl: "twl_rows",
};

const isRowKind = (k: string): k is RowKind => k in KIND_TO_TABLE;

// "Edits reopen the checkoff": a successful tn/tq write reopens its own lane
// ('tn'/'tq'). twl is intentionally null — adding/removing a TWL link is the
// Words work itself, not an edit that should reopen the Words sign-off ('tw').
const KIND_TO_REOPEN_LANE: Record<RowKind, CheckLane | null> = {
  tn: "tn",
  tq: "tq",
  twl: null,
};

// The quote field per kind — the cell whose content decides whether a blank
// Occurrence is legal (see requiredOccurrence in occurrenceRule.ts).
const QUOTE_FIELD: Record<RowKind, "quote" | "orig_words"> = {
  tn: "quote",
  tq: "quote",
  twl: "orig_words",
};

// The Occurrence invariant (which occurrence a saved row must carry, and why
// each kind's rule differs) lives in occurrenceRule.ts — a pure leaf shared
// with export.ts's renderer so save-time and render-time cannot drift apart.
// Its `requiredOccurrence` is applied in BOTH handlers below: the create POST
// and the patch.

// Adds a book filter to a WHERE clause. After the composite-(book, id) PK
// migration (0015), every row lookup MUST be scoped by book — the same 4-char
// id can exist in two books with different content. Handlers guarantee a
// non-null book before threading the value through to bind position `paramN`.
function bookClause(paramN: number): string {
  return ` AND book = ?${paramN}`;
}

// Re-select a row after a write, carrying the same derived `latest_source`
// column chapters.ts computes on read (tn/tq only — twl has no AI chip). A
// plain `SELECT *` omits it, and the client REPLACES its whole cached row
// with whatever this endpoint returns (both the direct PATCH response and
// the row.upserted WS broadcast) rather than merging — so returning a row
// without this column wiped out an accurate "AI" chip on every write,
// including non-versioning ones like a reorder's sort_order-only patch,
// where the true latest_source (edit_log is untouched) hadn't changed at
// all. Computing it here keeps the response honest either way: unchanged
// across a reorder, correctly cleared to NULL after a real content edit.
async function selectRowWithLatestSource(
  env: Env,
  kind: RowKind,
  id: string,
  book: string,
): Promise<Record<string, unknown> | null> {
  if (kind === "twl") {
    return env.DB.prepare(`SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`)
      .bind(id, book)
      .first();
  }
  return env.DB.prepare(
    `SELECT t.*, (
       SELECT source FROM edit_log
        WHERE kind = ?3 AND row_key = t.id
          AND (book = t.book OR book IS NULL)
        ORDER BY id DESC LIMIT 1
     ) AS latest_source
        FROM ${KIND_TO_TABLE[kind]} t
       WHERE t.id = ?1${bookClause(2)}`,
  )
    .bind(id, book, kind)
    .first();
}

// Reuse the Hono request lifecycle to pull "expected version" off the
// If-Match header. We accept a bare integer ("If-Match: 7") for simplicity.
function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Accept bare integers or quoted ETags; reject anything else so a
  // malformed header isn't silently treated as "no precondition".
  const m = /^"?(\d+)"?$/.exec(trimmed);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

const TnPatch = z.object({
  ref_raw: z.string().optional(),
  // Retarget a note to a different verse within its chapter (the "change
  // reference" action). chapter stays implicit — the move UI is same-chapter
  // only — so the broadcast on a successful PATCH still covers one chapter.
  // Sent alongside a recomputed ref_raw + sort_order, so it never hits the
  // reorder-only fast path and correctly bumps the version + logs history.
  verse: z.number().int().nonnegative().optional(),
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
  sort_order: z.number().nullable().optional(),
});

const PATCH_SCHEMA = { tn: TnPatch, tq: TqPatch, twl: TwlPatch };

// Row-id generation/validation/repair live in rowId.ts (pure leaf module, shared
// with pipelineImport's id validation and the reimport's coerceRowId guard).

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
  sort_order: z.number().nullable().optional(),
});
const CREATE_SCHEMA = { tn: CreateTn, tq: CreateTq, twl: CreateTwl };

// Hardcoded per-kind allowlist of INSERT-able column names. The create path
// interpolates column names directly into the SQL string (D1 can't bind
// identifiers), so the set of names must NEVER be derived from request-shaped
// data. Today the closed Zod schemas above already bound the keys, but this
// allowlist is a defense-in-depth gate so a future schema widening can't open
// a SQL-injection path through `Object.keys(data)`. Each entry must mirror the
// corresponding Create* schema's fields (sort_order is server-defaulted but
// still a valid column). Keep these two lists in sync.
const INSERT_COLS: Record<RowKind, readonly string[]> = {
  tn: [
    "book", "chapter", "verse", "ref_raw", "tags", "support_reference",
    "quote", "occurrence", "note", "sort_order",
  ],
  tq: [
    "book", "chapter", "verse", "ref_raw", "tags", "quote", "occurrence",
    "question", "response",
  ],
  twl: [
    "book", "chapter", "verse", "ref_raw", "tags", "orig_words", "occurrence",
    "tw_link", "sort_order",
  ],
};

rows.post("/:kind", requireEditor, async (c) => {
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

  // See rowsCreateGuard.ts for why both of these are needed and what each
  // one closes off (issue #491).
  data.book = normalizeBookCode(data.book as string);
  const chapterExists = await c.env.DB.prepare(CHAPTER_EXISTS_SQL)
    .bind(data.book, data.chapter)
    .first<{ ok: number }>();
  if (!chapterExists) return c.json({ error: "not_found", reason: "unknown_chapter" }, 404);

  // A raw TAB in any text field is structural corruption (see rawTabGuard.ts)
  // — reject it before it ever reaches D1.
  const tabField = findRawTabField(data);
  if (tabField) {
    return c.json(
      { error: "invalid_body", message: `Field '${tabField}' contains a raw TAB character, which is not allowed.` },
      400,
    );
  }

  // Chapter 0 is only ever legal as verse 0 with ref_raw "front:intro", and
  // only for tn (see chapterZeroGuard.ts — this is the ISA ee2w "0:1"
  // incident; tq/twl have no legal chapter-0 shape at all).
  if (!isValidChapterZeroRef(kind, data.chapter as number, data.verse as number, data.ref_raw as string)) {
    return c.json(
      {
        error: "invalid_body",
        message:
          kind === "tn"
            ? `Chapter 0 rows must use ref_raw "front:intro" (got ${JSON.stringify(data.ref_raw)}).`
            : `Chapter 0 is not valid for ${kind} rows.`,
      },
      400,
    );
  }

  const userId = currentUserId(c);

  // Block new rows while an AI pipeline that writes THIS kind is running for
  // this chapter — its auto-apply step will overwrite or rearrange that kind's
  // row set when it lands. A run on another resource is none of our business.
  const lock = await activePipelineForChapter(
    c.env,
    parsed.data.book,
    parsed.data.chapter,
    kind,
  );
  if (lock) return c.json(lockedResponseBody(lock), 409);

  // A new row must carry a sort_order. Without one it lands NULL, and the
  // export's `ORDER BY ... sort_order ASC NULLS LAST, id` dumps it at the end
  // of its verse keyed by id — scrambling file order in the nightly DCS diff
  // (pure-reorder churn). Honor a client-supplied value; otherwise place the
  // row at the end of its verse (max + 100), matching the import spacing.
  if (data.sort_order == null) {
    const maxRow = await c.env.DB.prepare(
      `SELECT MAX(sort_order) AS m FROM ${KIND_TO_TABLE[kind]}
        WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND deleted_at IS NULL`,
    )
      .bind(data.book, data.chapter, data.verse)
      .first<{ m: number | null }>();
    data.sort_order = (maxRow?.m ?? 0) + 100;
  }

  // Same idea for occurrence: `CreateTwl`/`CreateTn` make it optional and the
  // column has no DB default, so an omitted occurrence lands NULL and renders a
  // blank Occurrence cell that its validator hard-rejects. The "add word"
  // action posts no occurrence at all, which is how prod twl DAN 3:5 `xf8f` came
  // to sit blank and quietly fail DAN TWL's validation. Defaulting here rather
  // than in the client is deliberate: this POST is the only writer that can
  // leave the column ABSENT, so one server-side default covers every current
  // and future caller of it, and unlike a DB `DEFAULT 1` it can express tn's
  // quote-conditional rule and stays visible in review.
  //
  // The other writers bind an explicit value and are handled per their source:
  // bookImport and bookReimport round-trip DCS master and must preserve its
  // blanks verbatim (the export-time `hardRejectGuard` is what catches those),
  // while pipelineImport carries freshly generated AI content and so applies
  // `requiredOccurrence` at ingest the same way this handler does.
  const seedOcc = requiredOccurrence(kind, data[QUOTE_FIELD[kind]], data.occurrence);
  if (seedOcc != null) data.occurrence = seedOcc;

  // Retry around PK collision: insert under a fresh id and let the DB be the
  // source of truth instead of SELECT-then-INSERT (which races between two
  // concurrent POSTs). 32^4 ≈ 1M ids; ~8 tries covers any plausible book.
  // Build the column list from the hardcoded allowlist, not from
  // Object.keys(data), so a request can never inject an identifier. Only keys
  // actually present in `data` are included (preserving the prior behavior
  // where unsupplied optional fields fall through to DB defaults). The
  // matching values are read in the SAME order so placeholders line up.
  const dataCols = INSERT_COLS[kind].filter((name) =>
    Object.prototype.hasOwnProperty.call(data, name),
  );
  const cols = ["id", ...dataCols, "updated_by"];
  const placeholders = cols.map((_c, i) => `?${i + 1}`).join(", ");
  let id = "";
  let lastErr: unknown = null;
  for (let i = 0; i < 8; i++) {
    id = newRowId();
    const values: unknown[] = [id, ...dataCols.map((name) => data[name]), userId];
    try {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `INSERT INTO ${KIND_TO_TABLE[kind]} (${cols.join(", ")}) VALUES (${placeholders})`,
          )
          .bind(...values),
        c.env.DB
          .prepare(
            `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json) VALUES (?1, ?2, ?3, ?4, NULL, 1, 'create', ?5)`,
          )
          .bind(kind, id, data.book, userId, JSON.stringify(data)),
      ]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // Only retry on a unique-constraint collision. Anything else is a real
      // failure that should bubble up.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  if (lastErr) {
    return c.json({ error: "id_collision_exhausted" }, 503);
  }

  const created = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1 AND book = ?2`,
  )
    .bind(id, data.book)
    .first();
  if (created) {
    const row = created as unknown as TnRow | TqRow | TwlRow;
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
    );
    const lane = KIND_TO_REOPEN_LANE[kind];
    if (lane) {
      // Reopen the lane on every verse a bridged ref covers (not just the
      // leading verse), matching where the note now renders. Singletons → one.
      const verses = coveredVersesFromRef(row.ref_raw, row.verse);
      c.executionCtx.waitUntil(
        Promise.all(verses.map((v) => reopenLaneChecks(c.env, row.book, row.chapter, v, [lane]))),
      );
    }
  }
  return c.json(created, 201);
});

rows.get("/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
  )
    .bind(id, book)
    .first<TnRow | TqRow | TwlRow>();
  if (!row || row.deleted_at) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

// Per-kind content fields that the history endpoint exposes in each
// version's snapshot. Identity fields (book/chapter/verse/ref_raw) and
// transient fields like sort_order are deliberately omitted — they aren't
// what users mean when they say "switch to an older version".
const HISTORY_FIELDS: Record<RowKind, string[]> = {
  tn: ["quote", "note", "support_reference", "occurrence", "tags"],
  tq: ["quote", "question", "response", "occurrence", "tags"],
  twl: ["orig_words", "tw_link", "occurrence", "tags"],
};

// Replay edit_log entries forward to reconstruct the snapshot of each
// version. `create` carries the full posted body; `update` carries only the
// patch. Either way we merge into a running snapshot so the value at
// version N is whatever survived after the Nth log entry.
//
// Imported rows never went through POST so they have no `create` entry. We
// detect this and synthesize a v1 baseline from the current row's content.
// For never-patched fields this baseline is exact; for fields that were
// edited later, the synthesized v1 still reflects the current value (the
// real pre-edit value is lost), but the higher-version reconstructions are
// correct because patches always override the baseline going forward.
rows.get("/:kind/:id/history", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);

  const currentRow = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
  )
    .bind(id, book)
    .first<Record<string, unknown> & { version: number; deleted_at: number | null; updated_at: number }>();
  if (!currentRow || currentRow.deleted_at) {
    return c.json({ error: "not_found" }, 404);
  }

  // edit_log.book was backfilled in migration 0017. Legacy entries with no
  // book column (kind = 'tn'/'tq'/'twl' from before the migration) fall back
  // to (kind, row_key) only — the `el.book IS NULL` branch — so pre-migration
  // audit trails still display, just without cross-book disambiguation.
  //
  // preserve/hint/keep toggles are audited as new_version = prev_version
  // (the row's version column doesn't actually change). The history dialog
  // is a version picker, not an audit log — surfacing those entries as
  // duplicate-version rows confuses the user and triggers React key
  // collisions. Filter to actions that genuinely advance the version.
  const rs = await c.env.DB.prepare(
    `SELECT el.new_version AS version,
            el.action,
            el.created_at,
            el.payload_json,
            el.restored_from_version,
            u.id AS user_id,
            u.dcs_username AS username,
            u.dcs_full_name AS full_name
       FROM edit_log el
       LEFT JOIN users u ON u.id = el.user_id
      WHERE el.kind = ?1 AND el.row_key = ?2
        AND (el.book = ?3 OR el.book IS NULL)
        AND el.new_version IS NOT NULL
        AND el.action IN ('create', 'update', 'delete', 'restore')
      ORDER BY el.new_version ASC`,
  )
    .bind(kind, id, book)
    .all<{
      version: number;
      action: string;
      created_at: number;
      payload_json: string | null;
      restored_from_version: number | null;
      user_id: number | null;
      username: string | null;
      full_name: string | null;
    }>();

  const logEntries = boundHistoryToLastCreate(rs.results ?? []);
  const fields = HISTORY_FIELDS[kind];

  // Always anchor the list with a v1 entry. If a real `create` survived
  // bounding above, use it; otherwise synthesize one from the current row.
  const hasCreate = logEntries.some((e) => e.action === "create");
  type Entry = (typeof logEntries)[number] & { synthetic?: boolean };
  const entries: Entry[] = hasCreate
    ? logEntries
    : [
        {
          version: 1,
          action: "imported",
          created_at: currentRow.updated_at,
          payload_json: JSON.stringify(
            Object.fromEntries(fields.map((f) => [f, currentRow[f] ?? null])),
          ),
          restored_from_version: null,
          user_id: null,
          username: null,
          full_name: null,
          synthetic: true,
        },
        ...logEntries.filter((e) => e.version > 1),
      ];

  const snapshot: Record<string, unknown> = {};
  const versions = entries.map((e) => {
    let payload: Record<string, unknown> = {};
    if (e.payload_json) {
      try {
        payload = JSON.parse(e.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    if (e.action !== "delete") {
      for (const k of Object.keys(payload)) {
        snapshot[k] = payload[k];
      }
    }
    const trimmedSnapshot: Record<string, unknown> = {};
    for (const f of fields) {
      trimmedSnapshot[f] = snapshot[f] ?? null;
    }
    const trimmedPatch: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in payload) trimmedPatch[f] = payload[f];
    }
    return {
      version: e.version,
      action: e.action,
      created_at: e.created_at,
      user: e.user_id
        ? { id: e.user_id, username: e.username, full_name: e.full_name }
        : null,
      patch: trimmedPatch,
      snapshot: trimmedSnapshot,
      synthetic: e.synthetic ?? false,
      restored_from_version: e.restored_from_version ?? null,
    };
  });

  // Drop reorder-churn from the version list. Before the write path stopped
  // versioning sort_order (see PATCH above), every drag wrote an `update`
  // entry that touched no content field — these reconstruct to a snapshot
  // identical to their predecessor and read as duplicate "versions" in the
  // dialog. An update whose trimmedPatch is empty changed only excluded fields
  // (sort_order), so hide it. Always keep non-update actions (create/imported/
  // delete/restore) and the row's current version, so the snapshot replay's
  // anchor and the dialog's "current" marker / diff target still resolve.
  const displayVersions = versions.filter(
    (v) =>
      v.action !== "update" ||
      Object.keys(v.patch).length > 0 ||
      v.version === currentRow.version,
  );

  return c.json({ versions: displayVersions });
});

// Single-row PATCH with optimistic concurrency. If-Match is mandatory and
// the version check is enforced inside the UPDATE itself — a SELECT-then-
// UPDATE pair would race between two concurrent writers, both seeing the
// same version and both committing, silently losing one user's edit.
rows.patch("/:kind/:id", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);

  const expected = parseIfMatch(c.req.header("if-match"));
  if (expected === null) {
    return c.json({ error: "if_match_required" }, 428);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  // restored_from_version is a metadata flag sent alongside the content
  // patch when the user picks "switch to v{N}" from the history dialog. The
  // row's DB version still climbs monotonically (needed for optimistic
  // concurrency), but this flag lets the UI display the chip as v{N}. Any
  // normal edit comes in without this flag, which clears the marker.
  let restoredFromVersion: number | null = null;
  if (body && typeof body === "object" && "restored_from_version" in body) {
    const raw = (body as Record<string, unknown>).restored_from_version;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
      restoredFromVersion = Math.floor(raw);
    }
    delete (body as Record<string, unknown>).restored_from_version;
  }

  const schema = PATCH_SCHEMA[kind];
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }
  const patch = parsed.data;

  // A raw TAB in any text field is structural corruption (see rawTabGuard.ts)
  // — reject it before it ever reaches D1.
  const tabField = findRawTabField(patch as Record<string, unknown>);
  if (tabField) {
    return c.json(
      { error: "invalid_body", message: `Field '${tabField}' contains a raw TAB character, which is not allowed.` },
      400,
    );
  }

  let fields = Object.keys(patch);
  if (fields.length === 0) {
    return c.json({ error: "empty_patch" }, 400);
  }

  // Pull the current row once — used for the lock-scope lookup, the no-op
  // short-circuit, and to disambiguate 404 vs 409 if the UPDATE later misses.
  // Carries latest_source (see selectRowWithLatestSource) because a true
  // no-op PATCH returns this object as-is below — it must reflect the row's
  // real AI-provenance chip, not silently drop it.
  const current = (await selectRowWithLatestSource(c.env, kind, id, book)) as
    | (Record<string, unknown> & {
        version: number;
        deleted_at: number | null;
        book: string;
        chapter: number;
        restored_from_version: number | null;
      })
    | null;
  if (!current || current.deleted_at) return c.json({ error: "not_found" }, 404);

  // Same chapter-0 guard as the create path (see chapterZeroGuard.ts), applied
  // here because the "change reference" PATCH can retarget ref_raw (or verse)
  // to an illegal shape just as easily as a create can mint one. Chapter
  // itself is never patched (same-chapter moves only — see the ref_raw
  // comment below), so current.chapter is the row's real chapter for this
  // check. Only runs when the patch actually touches verse or ref_raw — a
  // patch that touches neither can't introduce this defect, so it falls back
  // to the row's current (already-valid) verse/ref_raw untouched.
  if (
    ("verse" in patch || "ref_raw" in patch) &&
    !isValidChapterZeroRef(
      kind,
      current.chapter,
      ("verse" in patch ? (patch as { verse?: number }).verse : current.verse) as number,
      ("ref_raw" in patch ? patch.ref_raw : (current.ref_raw as string)) as string,
    )
  ) {
    return c.json(
      {
        error: "invalid_body",
        message:
          kind === "tn"
            ? `Chapter 0 rows must use verse 0 and ref_raw "front:intro" (got verse=${JSON.stringify("verse" in patch ? patch.verse : current.verse)}, ref_raw=${JSON.stringify("ref_raw" in patch ? patch.ref_raw : current.ref_raw)}).`
            : `Chapter 0 is not valid for ${kind} rows.`,
      },
      400,
    );
  }

  // Backstop for the blank-note data-loss bug (NUM 22:10 v4→v5). The client
  // (NoteCard.flushPending) already blocks this with a confirm dialog, but any
  // other writer of a tn `note` PATCH — a future bug, a stale tab, a direct API
  // call — must not be allowed to overwrite a substantive note with "": that
  // exports to DCS and PUBLISHES, because the validator raises a blank Note at
  // severity="warning" and exits 0. Nothing downstream catches it, so this
  // backstop is the last line of defense. Scoped strictly to the
  // non-empty→empty transition, so already-blank rows and legitimate deletes
  // (which go through the /trash route, not a note-blanking PATCH) are
  // untouched. 422 is a non-retryable client error the outbox drops with a
  // toast rather than looping.
  if (kind === "tn" && "note" in patch) {
    const nextBlank =
      (typeof patch.note === "string" ? patch.note : "").replace(/\\n/g, "\n").trim() === "";
    const currentNote = (current.note as string | null) ?? "";
    const currentHadText = currentNote.replace(/\\n/g, "\n").trim() !== "";
    if (nextBlank && currentHadText) {
      return c.json(
        {
          error: "blank_note",
          message: "Refusing to blank a note that has text — delete the note instead.",
        },
        422,
      );
    }
  }

  // Enforce the occurrence invariant at the source (see requiredOccurrence).
  // Only fires when this patch actually touches the quote or occurrence — a
  // reorder, note-only edit, or tag toggle must never trigger a retroactive
  // heal (and the version bump it carries). The check runs on the values as
  // they will be AFTER this patch applies, so setting a quote and clearing an
  // occurrence in one request is judged on the result, not on the inputs.
  const p = patch as Record<string, unknown>;
  const quoteField = QUOTE_FIELD[kind];
  if (quoteField in p || "occurrence" in p) {
    const forced = requiredOccurrence(
      kind,
      quoteField in p ? p[quoteField] : current[quoteField],
      "occurrence" in p ? p.occurrence : current.occurrence,
    );
    if (forced != null) {
      p.occurrence = forced;
      fields = Object.keys(patch);
    }
  }

  // A ref_raw edit (retyping the REF field) must re-derive the `verse` integer
  // column — grouping and the read/export sort key run off chapter/verse, not
  // ref_raw. Without this the row renders its new ref while staying grouped
  // under its old verse (HOS 12 TQ v3xj). refParts collapses a range to its
  // leading verse ("12:11-12" -> [12, 11]), matching the import parser, so a
  // legitimate verse bridge keeps its leading verse for grouping while ref_raw
  // still carries the full range for display. Scope this to SAME-CHAPTER edits
  // only: cross-chapter moves aren't supported by the surrounding machinery
  // (the lock check, WS broadcast, and client caches below are all keyed to
  // one chapter), so never write a changed `chapter` here — a cross-chapter
  // ref just passes through untouched, exactly as before. The tn "change
  // reference" move sends `verse` explicitly; leave that authoritative.
  if (typeof p.ref_raw === "string" && !("verse" in p)) {
    const [ch, vs] = refParts(p.ref_raw);
    if (ch === current.chapter && vs !== current.verse) {
      p.verse = vs;
      fields = Object.keys(patch);
    }
  }

  // Lock check for non-tn kinds. TN edits are always allowed during a run —
  // the first PATCH on an updated_by-NULL row implicitly "keeps" it; further
  // PATCHes on already-kept rows are normal edits. tq has no such carve-out:
  // the questions run overwrites them. (twl is never locked at all.)
  if (kind !== "tn") {
    const lock = await activePipelineForChapter(c.env, current.book, current.chapter, kind);
    if (lock) return c.json(lockedResponseBody(lock), 409);
  }

  // No-op short-circuit: if the precondition still holds and every patched
  // field already matches the stored value, return the row unchanged.
  // Identical re-saves are common — picker re-commit, AI completion echoing
  // the same content, an explicit Save click against a row whose draft was
  // just cleared — and shouldn't burn a version. The version check guards
  // against the TOCTOU window: if someone else moved the row forward, fall
  // through and let the UPDATE's version=expected predicate produce the proper
  // 409.
  //
  // The restore marker is deliberately NOT part of this test (issue #539 item
  // 3). It used to be: a "switch to v{N}" whose snapshot equalled the row's
  // current content still failed `restoreMatches` and fell through to a full
  // versioned write, so picking a version the row already held burnt a version
  // and pushed a phantom entry into the history dialog — the same restore the
  // dialog then had to hide, which is how a real human version went missing.
  // `restored_from_version` records where the row's CURRENT content came from,
  // and this branch is reached only when that content did not move, so the
  // marker still describes the row exactly as well as it did a moment ago.
  // Leaving it alone is therefore not a stale-marker bug: it is the same answer
  // to an unchanged question. (The two directions this now covers are a restore
  // arriving at content that already matches, and an ordinary no-op save on a
  // row that carries a marker — both used to bump.)
  //
  // ONE CARVE-OUT, and it is data-loss-shaped rather than cosmetic. A trashed tn
  // row is queued for the 05:30 finalize, which promotes trashed_at ->
  // deleted_at unconditionally. The full write path below applies
  // contentPatchClearClauses, which sets `trashed_at = NULL` for tn — an edit is
  // the strongest signal the row should live (see trashedRowPatch.test.mjs and
  // the incident it pins). Before this change, a trashed row carrying a restore
  // marker failed `restoreMatches` and fell through to that write even on
  // identical content, so it got revived as a side effect. Short-circuiting
  // would leave it heading for deletion instead. A saved version is not worth a
  // deleted note, so a trashed tn row keeps the pre-existing full-write path
  // even when nothing about its content moved.
  const trashedTnRow =
    kind === "tn" && (current as Record<string, unknown>).trashed_at != null;
  if (current.version === expected && !trashedTnRow) {
    const allMatch = fields.every(
      (f) => (patch as Record<string, unknown>)[f] === current[f],
    );
    if (allMatch) {
      // A re-save that changes no content still acknowledges a review flag:
      // clear it (no version bump, like a bit-toggle) so the cleanup chip
      // drops. Covers "proofreader verified the adapted quote, it was fine".
      // EXCLUDE a sort_order-only patch — a drag/reorder must not acknowledge a
      // review (that path is handled separately below and never reaches here on
      // a non-no-op). Guard the clear on version + deleted_at so a concurrent
      // edit/delete in the SELECT→UPDATE window still yields 409/404, not a
      // false 200 no-op.
      const reorderOnly = fields.length === 1 && fields[0] === "sort_order";
      if (!reorderOnly && (current as Record<string, unknown>).review_kind != null) {
        const now = Math.floor(Date.now() / 1000);
        const res = await c.env.DB.prepare(
          `UPDATE ${KIND_TO_TABLE[kind]} SET review_kind = NULL, review_reason = NULL, updated_at = ?1
             WHERE id = ?2 AND version = ?3 AND deleted_at IS NULL${bookClause(4)}`,
        )
          .bind(now, id, expected, book)
          .run();
        if (res.meta.changes) {
          const fresh = await selectRowWithLatestSource(c.env, kind, id, book);
          return c.json(fresh ?? current);
        }
        // Row moved or was deleted between the SELECT and this UPDATE — surface
        // the normal concurrency response instead of a stale 200.
        const fresh = await c.env.DB.prepare(
          `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
        )
          .bind(id, book)
          .first<{ version: number; deleted_at: number | null }>();
        if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
        return c.json({ error: "version_mismatch", current: fresh }, 409);
      }
      return c.json(current);
    }
  }

  // Reorder-only fast path: sort_order is positional metadata, not content. A
  // drag must not count as a new version — otherwise the row's version climbs
  // and the history dialog fills with entries that reconstruct to identical
  // content (sort_order is excluded from the snapshot), reading as duplicate
  // "versions". Apply it under the same optimistic-concurrency guard, but skip
  // the version bump AND the edit_log entry. Mirrors the preserve/hint/trash
  // bit-toggles, which are likewise non-versioning. updated_at still moves so
  // mtime views reflect the activity; updated_by stays put (standing authorship
  // is whoever wrote the note, not whoever reordered it). Only tn/twl carry
  // sort_order — a tq patch can never reach here (its schema has no field).
  if (fields.length === 1 && fields[0] === "sort_order") {
    const now = Math.floor(Date.now() / 1000);
    const res = await c.env.DB.prepare(
      `UPDATE ${KIND_TO_TABLE[kind]}
         SET sort_order = ?1, updated_at = ?2
       WHERE id = ?3 AND version = ?4 AND deleted_at IS NULL${bookClause(5)}`,
    )
      .bind((patch as Record<string, unknown>).sort_order, now, id, expected, book)
      .run();
    if (!res.meta.changes) {
      // Version moved on under us (a content edit landed first). Surface 409
      // so the outbox auto-heals against the server version and retries — the
      // same path a content-field mismatch takes.
      const fresh = await c.env.DB.prepare(
        `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
      )
        .bind(id, book)
        .first<{ version: number; deleted_at: number | null }>();
      if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
      return c.json({ error: "version_mismatch", current: fresh }, 409);
    }
    const updated = await selectRowWithLatestSource(c.env, kind, id, book);
    if (updated) {
      const row = updated as unknown as TnRow | TqRow | TwlRow;
      c.executionCtx.waitUntil(
        broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
      );
    }
    return c.json(updated);
  }

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const setClauses = fields.map((f, i) => `${f} = ?${i + 1}`);
  // Any content edit clears a pending review flag, and (tn only) also
  // UN-trashes the row — a versioned edit landing on a trashed row must not
  // be silently tombstoned by the nightly finalize (see
  // contentPatchClauses.ts for the full rationale and the SQL-backed
  // regression test). Literal NULLs — no bind params, so positional indices
  // below are unaffected. The reorder-only fast path above returns before
  // here, so a drag never clears a flag or revives a trashed note.
  setClauses.push(...contentPatchClearClauses(kind));
  const baseParams = fields.length;
  // version bump and metadata go after the patch fields, then the WHERE
  // params (id + expected version + book) tail the bindings.
  setClauses.push(`version = version + 1`);
  setClauses.push(`updated_at = ?${baseParams + 1}`);
  setClauses.push(`updated_by = ?${baseParams + 2}`);
  setClauses.push(`restored_from_version = ?${baseParams + 3}`);
  const values = [
    ...fields.map((f) => (patch as Record<string, unknown>)[f]),
    now,
    userId,
    restoredFromVersion,
    id,
    expected,
    book,
  ];

  // Atomic: the audit INSERT is conditional on the UPDATE matching, so a
  // version-mismatch never leaves an orphan audit row. D1 batch() commits
  // both statements together and runs them sequentially on one connection,
  // so changes() in the second statement is the row count of THIS batch's
  // UPDATE. (An EXISTS probe on version = expected+1 is NOT equivalent: a
  // racing writer can move the row to expected+1, which would log the
  // rejected patch into history and corrupt version snapshots.)
  const newVersion = expected + 1;
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE ${KIND_TO_TABLE[kind]}
           SET ${setClauses.join(", ")}
         WHERE id = ?${baseParams + 4}
           AND version = ?${baseParams + 5}
           AND deleted_at IS NULL${bookClause(baseParams + 6)}`,
      )
      .bind(...values),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, restored_from_version)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'update', ?7, ?8
         WHERE changes() > 0`,
      )
      .bind(kind, id, book, userId, expected, newVersion, JSON.stringify(patch), restoredFromVersion),
  ]);

  if (!updateRes.meta.changes) {
    // No row updated: either gone, soft-deleted, or version moved on. Fetch
    // current to distinguish 404 vs 409 for the client.
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ version: number; deleted_at: number | null }>();
    if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }

  const updated = await selectRowWithLatestSource(c.env, kind, id, book);
  if (updated) {
    const row = updated as unknown as TnRow | TqRow | TwlRow;
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
    );
    // Edits reopen the checkoff. The reorder-only and no-op paths return
    // before here, so reaching this point means real content changed and the
    // version bumped. Best-effort and non-blocking; see reopenLaneChecks.
    const lane = KIND_TO_REOPEN_LANE[kind];
    if (lane) {
      // Reopen the lane on every verse the note covers NOW and every verse it
      // covered BEFORE this edit — a narrowed span ("1:2-3" → "1:2") or a verse
      // move must clear the lane on verses it no longer renders under, not just
      // the ones it lands on. `current` is the pre-edit row. Singletons → one.
      const verses = new Set<number>([
        ...coveredVersesFromRef(row.ref_raw, row.verse),
        ...coveredVersesFromRef(current.ref_raw as string | null, current.verse as number),
      ]);
      c.executionCtx.waitUntil(
        Promise.all(
          [...verses].map((v) => reopenLaneChecks(c.env, row.book, row.chapter, v, [lane])),
        ),
      );
    }
  }
  return c.json(updated);
});

// Soft delete with the same atomic version guard as PATCH.
rows.delete("/:kind/:id", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);
  const expected = parseIfMatch(c.req.header("if-match"));
  if (expected === null) {
    return c.json({ error: "if_match_required" }, 428);
  }

  // Lock check applies to all kinds on delete — no carve-out for tn here.
  // The auto-apply step is responsible for removing un-kept TNs; manual
  // deletion mid-run would race with it.
  const scope = await c.env.DB.prepare(
    `SELECT book, chapter, verse, ref_raw FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
  )
    .bind(id, book)
    .first<{ book: string; chapter: number; verse: number; ref_raw: string | null }>();
  if (scope) {
    const lock = await activePipelineForChapter(c.env, scope.book, scope.chapter, kind);
    if (lock) return c.json(lockedResponseBody(lock), 409);
  }

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const newVersion = expected + 1;
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE ${KIND_TO_TABLE[kind]}
           SET deleted_at = ?1, version = version + 1, updated_at = ?1, updated_by = ?2
         WHERE id = ?3 AND version = ?4 AND deleted_at IS NULL${bookClause(5)}`,
      )
      .bind(now, userId, id, expected, book),
    c.env.DB
      .prepare(
        // changes()-gated like PATCH: the audit lands only when THIS batch's
        // UPDATE soft-deleted the row, not when a racing writer matched the
        // probed end state.
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'delete'
         WHERE changes() > 0`,
      )
      .bind(kind, id, book, userId, expected, newVersion),
  ]);

  if (!updateRes.meta.changes) {
    const fresh = await c.env.DB.prepare(
      `SELECT version, deleted_at FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ version: number; deleted_at: number | null }>();
    if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }
  if (scope) {
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, scope.book, scope.chapter, {
        type: "row.deleted",
        kind,
        id,
        version: newVersion,
      }),
    );
    // Edits reopen the checkoff: a successful delete (reached only after the
    // changes()-gated soft-delete above landed) reopens the row's lane.
    // Best-effort and non-blocking; see reopenLaneChecks.
    const lane = KIND_TO_REOPEN_LANE[kind];
    if (lane) {
      // Reopen on every verse the deleted note covered, matching where it
      // rendered (a bridged "1:2-3" was checkable on verses 2 and 3).
      const verses = coveredVersesFromRef(scope.ref_raw, scope.verse);
      c.executionCtx.waitUntil(
        Promise.all(verses.map((v) => reopenLaneChecks(c.env, scope.book, scope.chapter, v, [lane]))),
      );
    }
  }
  return c.json({ ok: true });
});

// Shared body shape for /preserve and /hint. Both toggle a bit on tn_rows
// and append an audit row; neither touches `updated_by` (these are intent
// signals, not content edits) or `version` (collisions on these bits are
// idempotent in practice). Lock-exempt for the same reason the legacy
// /keep was — the translator must be able to claim/release a row mid-run.
const TnBitBody = z.object({ value: z.union([z.literal(0), z.literal(1), z.boolean()]) });

async function setTnBit(
  env: Env,
  id: string,
  book: string,
  userId: number | null,
  column: "preserve" | "hint",
  value: 0 | 1,
): Promise<TnRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const action = value === 1 ? column : `un${column}`;
  const [updateRes] = await env.DB.batch([
    env.DB
      .prepare(
        // updated_at moves so the row sorts to "recently touched" in any
        // mtime-based view, but updated_by stays NULL — standing authorship
        // is whoever wrote the note content, not whoever toggled the bit.
        `UPDATE tn_rows
           SET ${column} = ?1, updated_at = ?2
         WHERE id = ?3 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(value, now, id, book),
    env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT 'tn', ?1, book, ?2, version, version, ?3
           FROM tn_rows
          WHERE id = ?1 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(id, userId ?? null, action, book),
  ]);
  if (!updateRes.meta.changes) return null;
  return env.DB.prepare(`SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TnRow>();
}

function coerceBitValue(raw: 0 | 1 | boolean): 0 | 1 {
  return raw === true || raw === 1 ? 1 : 0;
}

// Flip the visible "trash" state on a tn row. Like setTnBit (preserve/hint),
// this does NOT bump `version` — it's a reversible state flip, not a content
// edit — so in-flight If-Match preconditions on the same row stay valid and no
// 409 friction is introduced. `trashed_at` is distinct from `deleted_at`: a
// trashed row stays visible (grayed, sorted last) and restorable until the
// nightly job promotes it to a deleted_at tombstone. updated_by is left alone
// (standing authorship is whoever wrote the note content). The audit action is
// 'trash'/'untrash' — deliberately NOT in the history version filter, so these
// flips don't surface as duplicate-version rows in the history dialog.
async function setTnTrashed(
  env: Env,
  id: string,
  book: string,
  userId: number | null,
  trashed: boolean,
  // When true, the UPDATE only lands if the row is still an abandoned blank
  // stub. A no-op result means the row changed under us; the caller turns that
  // into a 409 rather than silently reporting success.
  onlyIfBlankStub = false,
): Promise<TnRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const action = trashed ? "trash" : "untrash";
  const auditStmt = env.DB
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
       SELECT 'tn', ?1, book, ?2, version, version, ?3
         FROM tn_rows
        WHERE id = ?1 AND deleted_at IS NULL${bookClause(4)}`,
    )
    .bind(id, userId ?? null, action, book);

  // The guarded path keeps the batch — it is an implicit transaction, so the
  // trashed_at UPDATE and its audit row land together or not at all. A trashed
  // row with no `action='trash'` edit_log entry is exactly the shape the export
  // shrink-guard treats as an UNEXPLAINED removal, which fails the nightly
  // export closed for that book+resource; splitting the two writes across
  // separate awaits could produce it.
  //
  // What the batch can't do is skip the audit insert when the guarded UPDATE
  // no-ops: both statements always run. So the audit SELECT is gated on
  // `trashed_at = ?5` — the value the UPDATE just wrote. Statements run in
  // order, so that matches only if the UPDATE actually applied, and never on a
  // refusal (the clause requires trashed_at IS NULL going in, so a row
  // that was already trashed carries some earlier timestamp).
  if (onlyIfBlankStub) {
    // No caller identity means no ownership proof, so there is nothing this can
    // safely discard. requireEditor should make this unreachable; fail closed.
    if (userId == null) return null;
    const [guardedUpdate] = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE tn_rows
             SET trashed_at = ?1, updated_at = ?2
           WHERE id = ?3 AND deleted_at IS NULL${bookClause(4)}${blankStubClause(5)}`,
        )
        .bind(now, now, id, book, userId),
      env.DB
        .prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
           SELECT 'tn', ?1, book, ?2, version, version, ?3
             FROM tn_rows
            WHERE id = ?1 AND deleted_at IS NULL${bookClause(4)} AND trashed_at = ?5`,
        )
        .bind(id, userId ?? null, action, book, now),
    ]);
    if (!guardedUpdate.meta.changes) return null;
    return env.DB.prepare(`SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TnRow>();
  }

  const [updateRes] = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE tn_rows
           SET trashed_at = ?1, updated_at = ?2
         WHERE id = ?3 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(trashed ? now : null, now, id, book),
    auditStmt,
  ]);
  if (!updateRes.meta.changes) return null;
  return env.DB.prepare(`SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TnRow>();
}

// POST /api/rows/tn/:id/preserve — toggle the "survive future AI pipeline
// sweeps" bit. Body: { value: 0 | 1 | boolean }. Lock-exempt. Idempotent.
rows.post("/tn/:id/preserve", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TnBitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  const updated = await setTnBit(c.env, id, book, userId, "preserve", coerceBitValue(parsed.data.value));
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/hint — toggle the "queue as AI-pipeline hint" bit.
// hint=1 rows are sent into the next /api/pipelines/start as options.hints
// and are excluded from deleteUnkeptTns; AI expansion clears the bit.
rows.post("/tn/:id/hint", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TnBitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  const value = coerceBitValue(parsed.data.value);
  // A hint with no note gives bp-assistant's tn-writer no framing to expand
  // from — the hint's `seed` is this row's note, and an empty quote + empty
  // seed has neither a source phrase nor any guidance (a path that has never
  // run end-to-end). Require note text before a row can be queued as a hint.
  if (value === 1) {
    const row = await c.env.DB.prepare(
      `SELECT note FROM tn_rows WHERE id = ?1 AND deleted_at IS NULL${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ note: string | null }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    if (!row.note || !row.note.trim()) {
      return c.json(
        { error: "note_required", message: "Add note text before queuing this row as an AI hint." },
        400,
      );
    }
  }
  const updated = await setTnBit(c.env, id, book, userId, "hint", value);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/keep — legacy alias for /preserve with value=1.
// The old semantics ("claim a row during a run by setting updated_by") are
// folded into the always-on preserve bit. Kept so external callers and
// in-flight outbox ops keep working without a coordinated migration.
rows.post("/tn/:id/keep", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  const updated = await setTnBit(c.env, id, book, userId, "preserve", 1);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/trash — the note delete button. Moves the note to the
// visible "trash" state: the card grays out, drops to the bottom of the verse,
// and gains a Restore button. Reversible via /restore; finalized to a
// permanent deleted_at tombstone by the nightly 06:00 UTC job. Lock-exempt and
// non-version-bumping, like /preserve. No If-Match — idempotent state flip.
rows.post("/tn/:id/trash", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  // `onlyIfBlankStub=1` is the auto-discard of an abandoned blank note stub,
  // not a user pressing delete. The client decides from a cached row, so make
  // the server re-assert the predicate atomically (blankStubClause) and
  // refuse if the row gained content under us — otherwise a collaborator
  // filling the stub mid-flight would get their note binned, and the nightly
  // job would promote that to a permanent tombstone. Distinguish it from
  // not_found: the row exists, it simply is no longer discardable.
  const onlyIfBlankStub = c.req.query("onlyIfBlankStub") === "1";
  const updated = await setTnTrashed(c.env, id, book, userId, true, onlyIfBlankStub);
  if (!updated && onlyIfBlankStub) {
    const exists = await c.env.DB.prepare(
      `SELECT id FROM tn_rows WHERE id = ?1 AND deleted_at IS NULL${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ id: string }>();
    if (exists) {
      return c.json(
        {
          error: "not_blank_stub",
          message: "Note is no longer an empty stub — leaving it alone.",
        },
        409,
      );
    }
  }
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/restore — bring a trashed note back to the live set.
rows.post("/tn/:id/restore", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  const updated = await setTnTrashed(c.env, id, book, userId, false);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

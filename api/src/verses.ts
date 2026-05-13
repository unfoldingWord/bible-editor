import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { VerseRow } from "./types";
import { currentUserId, requireAuth } from "./auth";

export const verses = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const PatchSchema = z.object({
  content: z.unknown(),
  plain_text: z.string().nullable().optional(),
});

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const m = /^"?(\d+)"?$/.exec(trimmed);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Canonical list per docs/plan.md. Anything else gets a 400 so we don't
// quietly start storing rows for `XYZ` or `..` via a typo'd path.
const ALLOWED_BIBLE_VERSIONS = new Set(["ULT", "UST", "UHB", "UGNT"]);
function isAllowedBibleVersion(v: string): boolean {
  return ALLOWED_BIBLE_VERSIONS.has(v);
}

verses.get("/:book/:chapter/:verse/:bibleVersion", async (c) => {
  const { book, chapter, verse, bibleVersion } = c.req.param();
  const bv = bibleVersion.toUpperCase();
  if (!isAllowedBibleVersion(bv)) {
    return c.json({ error: "invalid_bible_version" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book.toUpperCase(), parseInt(chapter, 10), parseInt(verse, 10), bv)
    .first<VerseRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content_json);
  } catch {
    parsed = null;
  }
  return c.json({ ...row, content: parsed });
});

verses.patch("/:book/:chapter/:verse/:bibleVersion", requireAuth, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const bibleVersion = c.req.param("bibleVersion").toUpperCase();
  if (!isAllowedBibleVersion(bibleVersion)) {
    return c.json({ error: "invalid_bible_version" }, 400);
  }
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
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }

  if (bibleVersion === "UHB" || bibleVersion === "UGNT") {
    return c.json({ error: "source_text_is_read_only" }, 403);
  }

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const newVersion = expected + 1;
  const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;
  // Atomic write + audit, conditional on the version check matching. See
  // rows.ts for the matching pattern; the audit row only lands when the
  // UPDATE successfully bumped the version to expected+1.
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE verses
           SET content_json = ?1, plain_text = ?2, version = version + 1,
               updated_at = ?3, updated_by = ?4
         WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
           AND version = ?9`,
      )
      .bind(
        JSON.stringify(parsed.data.content),
        parsed.data.plain_text ?? null,
        now,
        userId,
        book,
        chapter,
        verse,
        bibleVersion,
        expected,
      ),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, user_id, prev_version, new_version, action, payload_json)
         SELECT 'verse', ?1, ?2, ?3, ?4, 'update', ?5
         WHERE EXISTS (
           SELECT 1 FROM verses
            WHERE book = ?6 AND chapter = ?7 AND verse = ?8 AND bible_version = ?9
              AND version = ?4
         )`,
      )
      .bind(
        rowKey,
        userId,
        expected,
        newVersion,
        JSON.stringify(parsed.data),
        book,
        chapter,
        verse,
        bibleVersion,
      ),
  ]);

  if (!updateRes.meta.changes) {
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
    )
      .bind(book, chapter, verse, bibleVersion)
      .first<VerseRow>();
    if (!fresh) return c.json({ error: "not_found" }, 404);
    let freshParsed: unknown = null;
    try {
      freshParsed = JSON.parse(fresh.content_json);
    } catch {
      /* ignore */
    }
    return c.json(
      { error: "version_mismatch", current: { ...fresh, content: freshParsed } },
      409,
    );
  }

  const updated = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book, chapter, verse, bibleVersion)
    .first<VerseRow>();
  let updatedParsed: unknown = null;
  try {
    if (updated) updatedParsed = JSON.parse(updated.content_json);
  } catch {
    /* ignore */
  }
  return c.json(updated ? { ...updated, content: updatedParsed } : null);
});

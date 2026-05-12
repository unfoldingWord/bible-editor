import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { VerseRow } from "./types";

export const verses = new Hono<{ Bindings: Env }>();

const PatchSchema = z.object({
  content: z.unknown(),
  plain_text: z.string().nullable().optional(),
});

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const n = parseInt(header.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

verses.get("/:book/:chapter/:verse/:bibleVersion", async (c) => {
  const { book, chapter, verse, bibleVersion } = c.req.param();
  const row = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book.toUpperCase(), parseInt(chapter, 10), parseInt(verse, 10), bibleVersion.toUpperCase())
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

verses.patch("/:book/:chapter/:verse/:bibleVersion", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const bibleVersion = c.req.param("bibleVersion").toUpperCase();
  const expected = parseIfMatch(c.req.header("if-match"));

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

  const current = await c.env.DB.prepare(
    `SELECT version FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book, chapter, verse, bibleVersion)
    .first<{ version: number }>();
  if (!current) return c.json({ error: "not_found" }, 404);
  if (expected !== null && expected !== current.version) {
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
    )
      .bind(book, chapter, verse, bibleVersion)
      .first<VerseRow>();
    let freshParsed: unknown = null;
    try {
      if (fresh) freshParsed = JSON.parse(fresh.content_json);
    } catch {
      /* ignore */
    }
    return c.json(
      {
        error: "version_mismatch",
        current: fresh ? { ...fresh, content: freshParsed } : null,
      },
      409,
    );
  }

  const newVersion = current.version + 1;
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `UPDATE verses
     SET content_json = ?1, plain_text = ?2, version = ?3, updated_at = ?4
     WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8`,
  )
    .bind(
      JSON.stringify(parsed.data.content),
      parsed.data.plain_text ?? null,
      newVersion,
      now,
      book,
      chapter,
      verse,
      bibleVersion,
    )
    .run();

  await c.env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action, payload_json) VALUES ('verse', ?1, ?2, ?3, 'update', ?4)`,
  )
    .bind(`${book}/${chapter}/${verse}/${bibleVersion}`, current.version, newVersion, JSON.stringify(parsed.data))
    .run();

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

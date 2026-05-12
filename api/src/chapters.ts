import { Hono } from "hono";
import type { Env } from "./index";
import type { ChapterPayload, TnRow, TqRow, TwlRow, VerseRow, VerseDto } from "./types";

export const chapters = new Hono<{ Bindings: Env }>();

// Bulk read everything for a chapter.
chapters.get("/:book/:chapter", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  if (!book || !Number.isFinite(chapter) || chapter < 0) {
    return c.json({ error: "invalid_params" }, 400);
  }
  const db = c.env.DB;

  const [verses, tn, tq, twl] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 ORDER BY verse, bible_version",
      )
      .bind(book, chapter)
      .all<VerseRow>(),
    db
      .prepare(
        "SELECT * FROM tn_rows WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL ORDER BY verse, id",
      )
      .bind(book, chapter)
      .all<TnRow>(),
    db
      .prepare(
        "SELECT * FROM tq_rows WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL ORDER BY verse, id",
      )
      .bind(book, chapter)
      .all<TqRow>(),
    db
      .prepare(
        "SELECT * FROM twl_rows WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL ORDER BY verse, id",
      )
      .bind(book, chapter)
      .all<TwlRow>(),
  ]);

  // Reshape verses → verses[bibleVersion][verseNum] = VerseDto for easy client lookup.
  const verseMap: Record<string, Record<number, VerseDto>> = {};
  for (const v of verses.results) {
    if (!verseMap[v.bible_version]) verseMap[v.bible_version] = {};
    const { content_json, ...rest } = v;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content_json);
    } catch {
      parsed = null;
    }
    verseMap[v.bible_version][v.verse] = { ...rest, content: parsed };
  }

  const payload: ChapterPayload = {
    book,
    chapter,
    verses: verseMap,
    tn: tn.results,
    tq: tq.results,
    twl: twl.results,
  };
  return c.json(payload);
});

// Book-level summary: chapter list + row counts. Useful for the timeline.
chapters.get("/:book", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const db = c.env.DB;
  const summary = await db
    .prepare(
      `SELECT chapter,
              SUM(CASE WHEN kind='verse' THEN 1 ELSE 0 END) AS verses,
              SUM(CASE WHEN kind='tn' THEN 1 ELSE 0 END) AS tn,
              SUM(CASE WHEN kind='tq' THEN 1 ELSE 0 END) AS tq,
              SUM(CASE WHEN kind='twl' THEN 1 ELSE 0 END) AS twl
       FROM (
         SELECT chapter, 'verse' AS kind FROM verses WHERE book = ?1 AND bible_version = 'ULT'
         UNION ALL
         SELECT chapter, 'tn' FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT chapter, 'tq' FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT chapter, 'twl' FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
       )
       GROUP BY chapter ORDER BY chapter`,
    )
    .bind(book)
    .all<{ chapter: number; verses: number; tn: number; tq: number; twl: number }>();
  return c.json({ book, chapters: summary.results });
});

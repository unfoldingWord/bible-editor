import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { VerseRow } from "./types";
import { currentUserId, requireEditor } from "./auth";
import { activePipelineForChapter, lockedResponseBody } from "./chapterLock";
import { broadcastChapter } from "./wsEvents";
import { recomputeTargetOccurrences } from "./importParsers";
import {
  CorruptContentJsonError,
  corruptContentJsonBody,
  logCorruptContentJson,
  parseVerseContentJson,
} from "./contentJson.ts";

// Verse content can carry malformed/missing `\w` occurrence data — colliding
// `(text, occurrence)` pairs from a bad import or AI alignment (ULT/UST), or no
// x-occurrence at all on imported source `\w` (UHB/UGNT, where usfm-js leaves
// it undefined → every copy defaults to `text|1`). Features that key words by
// `${text}|${occurrence}` (note-quote highlight, chip colors, quote builder)
// break on it. Renumber from document position so the served content is always
// self-consistent. No-op on clean verses; matches the source's own occurrence
// semantics, so source highlight (e.g. the two כָל in ZEC 5:3) disambiguates.
function normalizeOccurrences(parsed: unknown): void {
  const vos = (parsed as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (Array.isArray(vos)) recomputeTargetOccurrences(vos);
}

export const verses = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// content must be the usfm-js verse-objects tree (at minimum, a non-empty
// verseObjects array). The whole tree is replaced on every PATCH; a malformed
// body that passed validation as `unknown` would brick the verse — the
// alignment dialog walks verseObjects without null-guarding.
const VerseObjectSchema = z.object({}).passthrough();
const PatchSchema = z.object({
  content: z
    .object({
      verseObjects: z.array(VerseObjectSchema).min(1),
    })
    .passthrough(),
  // Optional, but NOT nullable: the SQL uses COALESCE(?2, plain_text), so an
  // explicit null would silently mean "keep" rather than "clear". Restrict to
  // string|absent so the API contract matches the SQL (omit to keep).
  plain_text: z.string().optional(),
});

// Valid USFM marker names are alphanumeric (e.g. "p", "q1", "zaln", "ts"); a
// marker `tag` carrying an HTML metacharacter has no legitimate origin and is
// the only thing that could turn a stored paragraph marker into injected
// markup when the editable renderer builds its chip span (see chipForTag in
// web/src/lib/highlight.ts). Reject such tags on write — defense-in-depth
// behind the renderer's own escaping. The `.passthrough()` schema otherwise
// stores arbitrary verse-object structure verbatim.
const UNSAFE_MARKER_TAG = /[<>&"'`]/;
function hasUnsafeMarkerTag(nodes: unknown[]): boolean {
  for (const node of nodes) {
    const o = node as Record<string, unknown> | null;
    if (!o || typeof o !== "object") continue;
    if (typeof o["tag"] === "string" && UNSAFE_MARKER_TAG.test(o["tag"])) return true;
    if (Array.isArray(o["children"]) && hasUnsafeMarkerTag(o["children"] as unknown[])) {
      return true;
    }
  }
  return false;
}

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
    parsed = parseVerseContentJson(row);
  } catch (err) {
    if (err instanceof CorruptContentJsonError) {
      logCorruptContentJson(err);
      return c.json(corruptContentJsonBody(err), 500);
    }
    throw err;
  }
  // All versions on read: source UHB/UGNT needs it too (no x-occurrence in the
  // imported source — see normalizeOccurrences). Display-only; storage/export
  // emit source verbatim, so round-trip fidelity is unaffected.
  normalizeOccurrences(parsed);
  return c.json({ ...row, content: parsed });
});

verses.patch("/:book/:chapter/:verse/:bibleVersion", requireEditor, async (c) => {
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

  if (hasUnsafeMarkerTag(parsed.data.content.verseObjects)) {
    return c.json({ error: "invalid_content", reason: "unsafe_marker_tag" }, 400);
  }

  // Lock verse writes while an AI pipeline targets this chapter. The
  // auto-apply step overwrites verse content on completion; concurrent edits
  // would race with it and silently lose to the AI result.
  const lock = await activePipelineForChapter(c.env, book, chapter);
  if (lock) return c.json(lockedResponseBody(lock), 409);

  // Self-heal the occurrence numbering before it lands in D1 (and therefore in
  // the nightly DCS export). Reaches this point only for ULT/UST — UHB/UGNT
  // were rejected above. Mutates parsed.data.content.verseObjects in place.
  normalizeOccurrences(parsed.data.content);

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const newVersion = expected + 1;
  const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;
  // Atomic write + audit, conditional on the version check matching. See
  // rows.ts for the matching pattern; changes() in the second statement is
  // the row count of THIS batch's UPDATE, so the audit row only lands when
  // our own write bumped the version (an EXISTS probe on expected+1 could be
  // satisfied by a racing writer, logging the rejected patch into history).
  // plain_text uses COALESCE so an omitted field keeps the stored value
  // instead of nulling the column (null here means "absent" — current
  // callers always send it).
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE verses
           SET content_json = ?1, plain_text = COALESCE(?2, plain_text), version = version + 1,
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
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6
         WHERE changes() > 0`,
      )
      .bind(
        rowKey,
        book,
        userId,
        expected,
        newVersion,
        JSON.stringify(parsed.data),
      ),
  ]);

  if (!updateRes.meta.changes) {
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
    )
      .bind(book, chapter, verse, bibleVersion)
      .first<VerseRow>();
    if (!fresh) return c.json({ error: "not_found" }, 404);
    let freshParsed: unknown;
    try {
      freshParsed = parseVerseContentJson(fresh);
    } catch (err) {
      if (err instanceof CorruptContentJsonError) {
        logCorruptContentJson(err);
        return c.json(corruptContentJsonBody(err), 500);
      }
      throw err;
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
    if (updated) updatedParsed = parseVerseContentJson(updated);
  } catch (err) {
    if (err instanceof CorruptContentJsonError) {
      logCorruptContentJson(err);
      return c.json(corruptContentJsonBody(err), 500);
    }
    throw err;
  }
  if (updated) {
    const verseDto = { ...updated, content: updatedParsed };
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, updated.book, updated.chapter, {
        type: "verse.updated",
        verse: verseDto,
      }),
    );
  }
  return c.json(updated ? { ...updated, content: updatedParsed } : null);
});

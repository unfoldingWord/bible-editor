import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { VerseDto, VerseRow } from "./types";
import { currentUserId, requireEditor } from "./auth";
import { activePipelineForChapter, lockedResponseBody } from "./chapterLock";
import { broadcastChapter } from "./wsEvents";
import { recomputeTargetOccurrences } from "./importParsers";
import {
  CorruptContentJsonError,
  corruptContentJsonBody,
  logCorruptContentJson,
  parseVerseContentJson,
  refusesEmptyVerseObjects,
} from "./contentJson.ts";
import {
  analyzeAlignmentDelta,
  guardBlocksSave,
  type AlignmentIntent,
} from "./alignmentDelta.ts";
import { buildVerseHistory, type VerseHistoryLogRow } from "./verseHistory.ts";
import { lanesToReopenOnVerseEdit, reopenLaneChecks } from "./laneReopen.ts";
import { RESOLVE_VERSE_MERGE_CONFLICT_SQL, VERSE_PATCH_UPDATE_SQL } from "./verseMergeConflictSql.ts";
import { clearResolvedConflictBannerIfLast } from "./verseMergeConflicts.ts";
import { provenanceValues, resolveActorUsername } from "./rowProvenance.ts";
import {
  absorbedVerseNumbers,
  BRIDGE_DELETE_NEXT_SQL,
  BRIDGE_UPDATE_START_SQL,
  computeBridgeEnd,
  DELETE_VERSE_LANE_CHECKS_RANGE_SQL,
  DELETE_VERSE_STATUSES_RANGE_SQL,
  expectedNextStart,
  hasVerseObjectsArray,
  isBridge,
  mergeVerseObjects,
  splitSeedVerseObjects,
  SPLIT_INSERT_EDITLOG_RANGE_SQL,
  SPLIT_INSERT_VERSES_RANGE_SQL,
  SPLIT_UPDATE_START_SQL,
} from "./verseBridge.ts";

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

export const verses = new Hono<{ Bindings: Env; Variables: { userId?: number; username?: string } }>();

// content must be the usfm-js verse-objects tree. The whole tree is replaced on
// every PATCH; a malformed body that passed validation as `unknown` would brick
// the verse — the alignment dialog walks verseObjects without null-guarding.
// Emptiness is NOT checked here: whether an empty tree is legal depends on the
// verse number, which zod never sees, so it is enforced at the call site below.
const VerseObjectSchema = z.object({}).passthrough();
const PatchSchema = z.object({
  content: z
    .object({
      verseObjects: z.array(VerseObjectSchema),
    })
    .passthrough(),
  // Optional, but NOT nullable: the SQL uses COALESCE(?2, plain_text), so an
  // explicit null would silently mean "keep" rather than "clear". Restrict to
  // string|absent so the API contract matches the SQL (omit to keep).
  plain_text: z.string().optional(),
  alignment_intent: z
    .enum(["text_edit", "find_replace", "section_edit", "alignment_edit", "confirmed_text_edit"])
    .optional(),
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

// One verse row by its full primary key. The same SELECT is open-coded at several
// points in this file; new code should call this so the column list and key stay
// in one place. (The pre-existing call sites are deliberately left alone — folding
// them in is a separate, wider change.)
function loadVerseRow(
  db: D1Database,
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): Promise<VerseRow | null> {
  return db
    .prepare(
      `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
    )
    .bind(book, chapter, verse, bibleVersion)
    .first<VerseRow>();
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
  // Non-numeric path segments parse to NaN, and a NaN bind 500s inside D1 —
  // validate up front and 400 instead (mirrors chapters.ts).
  const chapterNum = parseInt(chapter, 10);
  const verseNum = parseInt(verse, 10);
  if (!Number.isFinite(chapterNum) || !Number.isFinite(verseNum)) {
    return c.json({ error: "invalid_params" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book.toUpperCase(), chapterNum, verseNum, bv)
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

// Version history for a ULT/UST verse. requireEditor — same gate as note
// history (api/src/rows.ts); there is no admin-only versioning to "open up",
// so every editor sees and can restore verse versions, exactly like notes.
//
// Unlike the rows history endpoint, no forward-replay is needed: each
// `kind='verse'` edit_log payload is a full snapshot. buildVerseHistory maps
// the rows and anchors "current" with the live row content. The SELECT mirrors
// rows.ts (users join, book-or-null for pre-0017 entries, version-advancing
// actions). Path length differs from the verse GET above, so no route clash.
verses.get("/:book/:chapter/:verse/:bibleVersion/history", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const bibleVersion = c.req.param("bibleVersion").toUpperCase();
  if (!isAllowedBibleVersion(bibleVersion)) {
    return c.json({ error: "invalid_bible_version" }, 400);
  }
  // NaN binds 500 inside D1 — 400 up front instead (mirrors chapters.ts).
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) {
    return c.json({ error: "invalid_params" }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book, chapter, verse, bibleVersion)
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

  const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;
  const rs = await c.env.DB.prepare(
    `SELECT el.new_version AS version,
            el.action,
            el.source,
            el.created_at,
            el.payload_json,
            u.id AS user_id,
            u.dcs_username AS username,
            u.dcs_full_name AS full_name
       FROM edit_log el
       LEFT JOIN users u ON u.id = el.user_id
      WHERE el.kind = 'verse' AND el.row_key = ?1
        AND (el.book = ?2 OR el.book IS NULL)
        AND el.new_version IS NOT NULL
      ORDER BY el.new_version ASC, el.created_at ASC`,
  )
    .bind(rowKey, book)
    .all<VerseHistoryLogRow>();

  const versions = buildVerseHistory(rs.results ?? [], {
    version: row.version,
    content: parsed,
    plain_text: row.plain_text,
    updated_at: row.updated_at,
  });
  return c.json({ versions });
});

verses.patch("/:book/:chapter/:verse/:bibleVersion", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const bibleVersion = c.req.param("bibleVersion").toUpperCase();
  if (!isAllowedBibleVersion(bibleVersion)) {
    return c.json({ error: "invalid_bible_version" }, 400);
  }
  // NaN binds 500 inside D1 — 400 up front instead (mirrors chapters.ts).
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) {
    return c.json({ error: "invalid_params" }, 400);
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

  // Empty verseObjects is legal for the chapter-front pseudo-verse only —
  // see refusesEmptyVerseObjects for the full rationale (#366).
  if (refusesEmptyVerseObjects(verse, parsed.data.content.verseObjects)) {
    return c.json({ error: "invalid_body", reason: "empty_verse_objects" }, 400);
  }

  if (hasUnsafeMarkerTag(parsed.data.content.verseObjects)) {
    return c.json({ error: "invalid_content", reason: "unsafe_marker_tag" }, 400);
  }

  // Lock verse writes while a scripture-generating run targets this chapter.
  // Its auto-apply step overwrites verse content on completion; concurrent
  // edits would race with it and silently lose to the AI result. Notes and
  // questions runs never write verses, so they don't lock this.
  const lock = await activePipelineForChapter(c.env, book, chapter, "verse");
  if (lock) return c.json(lockedResponseBody(lock), 409);

  // Self-heal the occurrence numbering before it lands in D1 (and therefore in
  // the nightly DCS export). Reaches this point only for ULT/UST — UHB/UGNT
  // were rejected above. Mutates parsed.data.content.verseObjects in place.
  normalizeOccurrences(parsed.data.content);

  const existing = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book, chapter, verse, bibleVersion)
    .first<VerseRow>();

  // Create the chapter-intro row on first write (#379). A chapter's opening
  // paragraph marker lives BEFORE `\v 1`, so it is stored on the chapter-front
  // pseudo-verse (verse 0) — and a chapter whose source USFM had no such marker
  // has no verse-0 row at all. See lintChapterOpeningMarkers in lint.ts for the
  // full background. Without this branch there is nothing to PATCH, so the flag
  // that lint raises would be unfixable in-app.
  //
  // Deliberately narrow. Creation is allowed ONLY for verse 0, and only with
  // `If-Match: 0` — an explicit "I expect no row here" assertion, so a create
  // racing another create loses on the primary key instead of silently
  // overwriting. Real verses still 404: inventing scripture verses that the
  // source doesn't have would feed fabricated rows into the nightly export.
  // Every guard above still applies (UHB/UGNT rejected, empty verseObjects
  // legal for verse 0 only, unsafe marker tags rejected, pipeline lock honoured).
  if (!existing) {
    if (verse !== 0 || expected !== 0) return c.json({ error: "not_found" }, 404);
    // The chapter must already exist in this resource. On the UPDATE path "the row
    // is there" implicitly proved the reference was real; a create has no such
    // proof, and book/chapter come straight off the URL. Without this probe an
    // editor could PATCH /api/verses/MIC/999/0/ULT and mint a row that the nightly
    // export renders as a genuine `\c 999` in the DCS commit (exportWorkflow reads
    // every verse row for the book, in chapter order). Requiring a sibling verse in
    // the same (book, chapter, bible_version) closes both the bogus-chapter and
    // bogus-book cases without a canon table.
    const sibling = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM verses
         WHERE book = ?1 AND chapter = ?2 AND bible_version = ?3 AND verse > 0
         LIMIT 1`,
    )
      .bind(book, chapter, bibleVersion)
      .first<{ ok: number }>();
    if (!sibling) return c.json({ error: "not_found", reason: "unknown_chapter" }, 404);
    const userId = currentUserId(c);
    const actor = await resolveActorUsername(c.env.DB, userId, c.get("username"));
    const now = Math.floor(Date.now() / 1000);
    const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;
    const contentJson = JSON.stringify(parsed.data.content);
    let insertRes;
    try {
      [insertRes] = await c.env.DB.batch([
        c.env.DB
          .prepare(
            `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text,
                                 version, updated_at, updated_by, last_change_action, last_change_source, last_change_actor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11)`,
          )
          .bind(
            book,
            chapter,
            verse,
            bibleVersion,
            contentJson,
            parsed.data.plain_text ?? null,
            now,
            userId,
            ...provenanceValues({ action: "create", source: "user", actor }),
          ),
        c.env.DB
          .prepare(
            `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
             VALUES ('verse', ?1, ?2, ?3, NULL, 1, 'create', ?4)`,
          )
          .bind(rowKey, book, userId, JSON.stringify(parsed.data)),
      ]);
    } catch (err) {
      // A concurrent create landed first, so the primary key rejected ours. Report
      // it as a version conflict against the row that won, which sends the client
      // through the same re-read-and-retry path a normal verse 409 uses (the
      // outbox's silent auto-heal is row-only, so this surfaces the merge prompt).
      //
      // Re-probe rather than pattern-match the driver's error string: if the row is
      // now there, a racing create is the only thing that could have put it there,
      // and if it is NOT there the failure was something else (transient D1 error)
      // and must keep propagating as a 5xx instead of being reported as a conflict.
      const fresh = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
      if (!fresh) throw err;
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
      return c.json({ error: "version_mismatch", current: { ...fresh, content: freshParsed } }, 409);
    }
    if (!insertRes.meta.changes) return c.json({ error: "verse_create_failed" }, 500);
    // Re-read rather than synthesizing the response from the INSERT binds. It costs
    // one query on a rare, human-triggered write, and in exchange the created row
    // is returned by exactly the same shape as the UPDATE path below — including
    // any column a hand-built literal would silently start getting wrong.
    const created = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
    if (!created) return c.json({ error: "verse_create_failed" }, 500);
    const createdDto = { ...created, content: parsed.data.content };
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, created.book, created.chapter, {
        type: "verse.updated",
        verse: createdDto,
      }),
    );
    // No lane reopen: verse 0 carries no checkoff lanes of its own, and the
    // marker it now holds introduces verse 1 without changing verse 1's words.
    return c.json(createdDto);
  }
  if (existing.version !== expected) {
    let freshParsed: unknown;
    try {
      freshParsed = parseVerseContentJson(existing);
    } catch (err) {
      if (err instanceof CorruptContentJsonError) {
        logCorruptContentJson(err);
        return c.json(corruptContentJsonBody(err), 500);
      }
      throw err;
    }
    return c.json(
      { error: "version_mismatch", current: { ...existing, content: freshParsed } },
      409,
    );
  }
  let existingParsed: unknown;
  try {
    existingParsed = parseVerseContentJson(existing);
  } catch (err) {
    if (err instanceof CorruptContentJsonError) {
      logCorruptContentJson(err);
      return c.json(corruptContentJsonBody(err), 500);
    }
    throw err;
  }
  const alignmentIntent = (parsed.data.alignment_intent ?? "text_edit") as AlignmentIntent;
  const delta = analyzeAlignmentDelta(existingParsed, parsed.data.content);
  // Block any save that collaterally de-aligns untouched words. The enforced
  // predicate lives in guardBlocksSave — DO NOT inline a narrowing such as
  // `delta.wordSequenceUnchanged` here. That narrowing (commit 6980fd72) is
  // exactly what let 1CH 4:21 / NUM 24 ship: a one-word spelling edit flips
  // wordSequenceUnchanged to false, so the narrowed guard never fired and the
  // collateral loss reached master. See guardBlocksSave for the full rationale.
  if (guardBlocksSave(delta, alignmentIntent)) {
    return c.json(
      {
        error: "unexpected_alignment_loss",
        intent: alignmentIntent,
        delta,
      },
      409,
    );
  }

  const userId = currentUserId(c);
  const actor = await resolveActorUsername(c.env.DB, userId, c.get("username"));
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
  const [updateRes, , resolveRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(VERSE_PATCH_UPDATE_SQL)
      .bind(
        JSON.stringify(parsed.data.content),
        parsed.data.plain_text ?? null,
        now,
        userId,
        ...provenanceValues({ action: "update", source: "user", actor }),
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
        JSON.stringify({ ...parsed.data, alignment_delta: delta }),
      ),
    // A human saving this verse RESOLVES (not deletes) any merge conflict the
    // nightly sync flagged for it (see verseMergeConflicts.ts / verseMerge.ts)
    // — in the same batch so it costs no extra subrequest. Mirrors rows.ts's
    // review-flag auto-clear precedent (line ~666). NOTE this is honestly
    // "touched", not "reviewed": ANY save of this verse resolves the flag,
    // even an unrelated typo fix that never looked at the flagged collision,
    // so a refusal/conflict can read as "resolved" without anyone having
    // reviewed it. The book-level system_alerts banner is NOT cleared by this
    // UPDATE — it is derived fresh from verse_merge_conflicts on the next
    // sync (see raiseVerseMergeConflictAlert, which now also filters on
    // resolved_at IS NULL), so a stale banner entry for THIS verse simply
    // won't reappear next time, but nothing here proactively clears an
    // already-posted banner mid-run.
    //
    // This used to be a DELETE, which erased the row — and with it the
    // overwritten_version recovery pointer and the whole audit trail — the
    // instant a human re-saved their own overwritten work. Measured on prod
    // 2026-08-14: at least 14 rows already gone this way. Marking instead of
    // deleting (migration 0049) keeps the row (and the pointer) for the
    // audit trail while still removing it from every "active conflicts" view
    // (this file's GET route, the banner query) via `resolved_at IS NULL`.
    //
    // Guarded on THIS request's UPDATE having actually landed, via the same
    // `changes() > 0` chain the edit_log statement above uses. The guard
    // chains correctly because that INSERT itself only fires when the UPDATE
    // fired: UPDATE changes 1 → INSERT inserts 1 → changes() is 1 here;
    // UPDATE changes 0 → INSERT inserts 0 → changes() is 0 here.
    //
    // It deliberately does NOT test `verses.version = newVersion`. That looks
    // equivalent and is not: if the nightly sync's own adoption wins the CAS
    // race and bumps this verse to newVersion first, our UPDATE changes
    // nothing and the request 409s — yet the row would already sit at
    // newVersion, so a version test would fire and mark-resolve the conflict
    // row that very sync just created. That would erase the pointer to the
    // overwritten text on a save that never landed, which is the exact
    // failure this table exists to prevent.
    //
    // `resolved_at IS NULL` in the WHERE keeps a later, unrelated save from
    // re-stamping (and reassigning resolved_by on) a conflict a previous save
    // already resolved.
    c.env.DB
      .prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL)
      .bind(now, userId, book, bibleVersion.toLowerCase(), chapter, verse),
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
    // Edits reopen the checkoff. 'text' always reopens; 'tw' reopens only for a
    // ULT edit that actually changed a word (not a comma / moved brace /
    // whitespace) — see lanesToReopenOnVerseEdit. Best-effort and non-blocking
    // (the write already landed above); see reopenLaneChecks.
    const lanes = lanesToReopenOnVerseEdit(bibleVersion, delta.wordSequenceUnchanged);
    c.executionCtx.waitUntil(
      reopenLaneChecks(c.env, updated.book, updated.chapter, updated.verse, lanes),
    );
    // Issue #626: this save just resolved the merge-conflict row for this
    // verse (RESOLVE_VERSE_MERGE_CONFLICT_SQL's own `changes() > 0` guard
    // above only fires when it did) — clear the book+resource sync-warning
    // banner if that was the last active conflict outstanding, so a human
    // working the list isn't sent back to a verse that needs nothing.
    // Best-effort and non-blocking, same as the two waitUntil calls above:
    // the save already landed either way.
    if (resolveRes?.meta?.changes) {
      c.executionCtx.waitUntil(clearResolvedConflictBannerIfLast(c.env, updated.book, bibleVersion.toLowerCase()));
    }
  }
  return c.json(updated ? { ...updated, content: updatedParsed } : null);
});

// ─── Verse bridges (create / break) ──────────────────────────────────────────
// A verse bridge is a `\v a-b` block stored as ONE row (start verse carries
// verse_end; see verseBridge.ts). These two routes are the only way to set or
// clear verse_end from the app. They are deliberate, whole-verse structural
// operations (not per-keystroke), so they are plain POSTs the client awaits,
// NOT durable-outbox PATCHes — the outbox's per-row silent auto-heal is wrong
// for a two-row atomic change. Both mirror the PATCH route's guards.

// The verseObjects array off a parsed content tree, or [] if malformed.
function verseObjectsOf(parsed: unknown): unknown[] {
  const vos = (parsed as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vos) ? vos : [];
}

const BridgeBodySchema = z.object({
  start_version: z.number().int().nonnegative(),
  next_version: z.number().int().nonnegative(),
});

// POST /:book/:chapter/:verse/:bibleVersion/bridge — combine this verse with the
// immediately following verse (or, if this is already a bridge, extend it by the
// next block). Body carries BOTH expected versions because two rows are CAS'd.
verses.post("/:book/:chapter/:verse/:bibleVersion/bridge", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const bibleVersion = c.req.param("bibleVersion").toUpperCase();
  if (!isAllowedBibleVersion(bibleVersion)) return c.json({ error: "invalid_bible_version" }, 400);
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return c.json({ error: "invalid_params" }, 400);
  // Structural verse ops are UST-only (mirrors the UST-only toolbar) and must
  // never touch the chapter-front pseudo-verse (verse 0): buildUsfm serializes
  // verse 0 as usfm-js's "front" key IGNORING verse_end, so bridging there
  // would silently drop the absorbed real verse from the export. The UST-only
  // check also subsumes the UHB/UGNT read-only rejection.
  if (bibleVersion !== "UST") return c.json({ error: "bridge_ust_only" }, 403);
  if (verse < 1) return c.json({ error: "invalid_params", reason: "verse_must_be_positive" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = BridgeBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  const { start_version: startVersion, next_version: nextVersion } = parsed.data;

  // Same lock as a verse edit: an AI scripture run's auto-apply would race a
  // structural rewrite of this chapter's verse rows.
  const lock = await activePipelineForChapter(c.env, book, chapter, "verse");
  if (lock) return c.json(lockedResponseBody(lock), 409);

  const start = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
  if (!start) return c.json({ error: "not_found" }, 404);
  const nextVerse = expectedNextStart(start);
  const next = await loadVerseRow(c.env.DB, book, chapter, nextVerse, bibleVersion);
  if (!next) return c.json({ error: "no_adjacent_verse" }, 422);

  // Pre-check versions for a clean 409 (the SQL's CAS/EXISTS is the real guard).
  if (start.version !== startVersion || next.version !== nextVersion) {
    return c.json(
      {
        error: "version_mismatch",
        current: {
          start: { ...start, content: safeParseOrNull(start) },
          next: { ...next, content: safeParseOrNull(next) },
        },
      },
      409,
    );
  }

  let startParsed: unknown;
  let nextParsed: unknown;
  try {
    startParsed = parseVerseContentJson(start);
    nextParsed = parseVerseContentJson(next);
  } catch (err) {
    if (err instanceof CorruptContentJsonError) {
      logCorruptContentJson(err);
      return c.json(corruptContentJsonBody(err), 500);
    }
    throw err;
  }

  // A row whose content_json parsed but is NOT `{ verseObjects: [...] }` (a bare
  // array, a typo'd key) would have its half silently dropped by verseObjectsOf
  // while BRIDGE_DELETE_NEXT_SQL still deletes it. Refuse — same posture as the
  // corrupt-JSON path above, which never deletes. Normal writes (PATCH, import)
  // always produce the in-shape tree, so this only guards a pre-existing
  // off-shape row.
  if (!hasVerseObjectsArray(startParsed) || !hasVerseObjectsArray(nextParsed)) {
    return c.json({ error: "invalid_content", reason: "missing_verse_objects" }, 422);
  }

  const mergedVos = mergeVerseObjects(verseObjectsOf(startParsed), verseObjectsOf(nextParsed));
  const mergedContent = { verseObjects: mergedVos };
  // Keep `${text}|${occurrence}` consistent across the now-combined verse (a
  // word repeated across the two halves must renumber) — same self-heal the
  // PATCH path runs (STATE.md's occurrence-collision lesson).
  normalizeOccurrences(mergedContent);
  const mergedJson = JSON.stringify(mergedContent);
  const bridgeEnd = computeBridgeEnd(next);
  const absorbed = absorbedVerseNumbers(next);
  const mergedPlain = [start.plain_text, next.plain_text].filter(Boolean).join(" ") || null;

  const userId = currentUserId(c);
  const actor = await resolveActorUsername(c.env.DB, userId, c.get("username"));
  const now = Math.floor(Date.now() / 1000);
  const startKey = `${book}/${chapter}/${verse}/${bibleVersion}`;
  const nextKey = `${book}/${chapter}/${nextVerse}/${bibleVersion}`;

  // One atomic batch. Statement 1 CAS's the start row AND requires the next row
  // to still be at nextVersion (EXISTS); every later statement chains on
  // changes() > 0, so a lost race on EITHER version deletes/writes nothing (a
  // D1 batch does NOT roll back a zero-match statement, only an error — see
  // verseBridge.ts's SQL header). Status/lane cleanup is deliberately NOT in
  // this chain: it can legitimately match zero rows, which would break the
  // chain — it runs post-confirm below.
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(BRIDGE_UPDATE_START_SQL)
      .bind(
        mergedJson,
        bridgeEnd,
        now,
        userId,
        ...provenanceValues({ action: "bridge", source: "user", actor }),
        book,
        chapter,
        verse,
        bibleVersion,
        startVersion,
        nextVerse,
        nextVersion,
        mergedPlain,
      ),
    c.env.DB.prepare(BRIDGE_DELETE_NEXT_SQL).bind(book, chapter, nextVerse, bibleVersion),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'bridge', ?6 WHERE changes() > 0`,
      )
      .bind(startKey, book, userId, startVersion, startVersion + 1, JSON.stringify({ content: mergedContent, verse_end: bridgeEnd })),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         SELECT 'verse', ?1, ?2, ?3, ?4, NULL, 'delete', ?5 WHERE changes() > 0`,
      )
      .bind(nextKey, book, userId, next.version, JSON.stringify({ content: nextParsed, absorbed_into: verse })),
  ]);

  if (!updateRes.meta.changes) {
    // Lost the race between the pre-check read and the batch. Re-read and 409.
    const freshStart = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
    const freshNext = await loadVerseRow(c.env.DB, book, chapter, nextVerse, bibleVersion);
    return c.json(
      {
        error: "version_mismatch",
        current: {
          start: freshStart ? { ...freshStart, content: safeParseOrNull(freshStart) } : null,
          next: freshNext ? { ...freshNext, content: safeParseOrNull(freshNext) } : null,
        },
      },
      409,
    );
  }

  const updated = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
  const bridgeDto = updated ? { ...updated, content: mergedContent } : null;
  c.executionCtx.waitUntil(
    (async () => {
      // Prune the orphaned per-verse status/checkoff for the absorbed verses,
      // then reopen the text lane on the bridge (its content changed), then tell
      // open tabs. Best-effort, off the response path — same shape as the PATCH
      // route's lane reopen.
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(DELETE_VERSE_STATUSES_RANGE_SQL).bind(book, chapter, next.verse, bridgeEnd),
          c.env.DB.prepare(DELETE_VERSE_LANE_CHECKS_RANGE_SQL).bind(book, chapter, next.verse, bridgeEnd),
        ]);
      } catch {
        // orphan cleanup is non-critical; a stale row keyed at an absent verse
        // is simply unused until (unless) the bridge is split again.
      }
      await reopenLaneChecks(c.env, book, chapter, verse, ["text"]);
      if (bridgeDto) {
        await broadcastChapter(c.env, book, chapter, {
          type: "verse.bridged",
          verse: bridgeDto,
          removedVerse: next.verse,
          absorbedVerses: absorbed,
        });
      }
    })(),
  );
  return c.json({ verse: bridgeDto, removed_verse: next.verse, absorbed_verses: absorbed });
});

// POST /:book/:chapter/:verse/:bibleVersion/split — break a `\v a-b` bridge back
// into separate verses. ALL content stays in the first verse; the later verses
// are (re)created empty for the translator to redistribute by hand. Single row
// CAS → If-Match, exactly like PATCH.
verses.post("/:book/:chapter/:verse/:bibleVersion/split", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const bibleVersion = c.req.param("bibleVersion").toUpperCase();
  if (!isAllowedBibleVersion(bibleVersion)) return c.json({ error: "invalid_bible_version" }, 400);
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return c.json({ error: "invalid_params" }, 400);
  // UST-only, verse > 0 — same rationale as the bridge route above (verse 0 is
  // the chapter-front pseudo-verse; the UST-only check subsumes UHB/UGNT).
  if (bibleVersion !== "UST") return c.json({ error: "bridge_ust_only" }, 403);
  if (verse < 1) return c.json({ error: "invalid_params", reason: "verse_must_be_positive" }, 400);
  const expected = parseIfMatch(c.req.header("if-match"));
  if (expected === null) return c.json({ error: "if_match_required" }, 428);

  const lock = await activePipelineForChapter(c.env, book, chapter, "verse");
  if (lock) return c.json(lockedResponseBody(lock), 409);

  const bridge = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
  if (!bridge) return c.json({ error: "not_found" }, 404);
  if (bridge.version !== expected) {
    return c.json({ error: "version_mismatch", current: { ...bridge, content: safeParseOrNull(bridge) } }, 409);
  }
  if (!isBridge(bridge)) return c.json({ error: "not_a_bridge" }, 400);

  const bridgeEnd = bridge.verse_end as number; // isBridge above guarantees non-null
  const seedContent = { verseObjects: splitSeedVerseObjects() };
  const seedJson = JSON.stringify(seedContent);

  const userId = currentUserId(c);
  const actor = await resolveActorUsername(c.env.DB, userId, c.get("username"));
  const now = Math.floor(Date.now() / 1000);
  const startKey = `${book}/${chapter}/${verse}/${bibleVersion}`;

  // Exactly FOUR statements regardless of how many verses the bridge spans (D1
  // caps a batch at 100 statements): de-bridge the start row (CAS on version +
  // still-a-bridge), then two CTE-driven multi-row INSERTs — all seeded verses,
  // then all their 'create' audit rows — each chained on changes() > 0 so a lost
  // CAS mints nothing and the split stays atomic all-or-nothing.
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(SPLIT_UPDATE_START_SQL)
      .bind(now, userId, ...provenanceValues({ action: "split", source: "user", actor }), book, chapter, verse, bibleVersion, expected),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'split', ?6 WHERE changes() > 0`,
      )
      .bind(startKey, book, userId, expected, expected + 1, JSON.stringify({ content: safeParseOrNull(bridge), verse_end: null })),
    c.env.DB
      .prepare(SPLIT_INSERT_VERSES_RANGE_SQL)
      .bind(book, chapter, bibleVersion, seedJson, now, userId, verse, bridgeEnd, ...provenanceValues({ action: "split", source: "user", actor }), expected),
    c.env.DB
      .prepare(SPLIT_INSERT_EDITLOG_RANGE_SQL)
      .bind(book, chapter, bibleVersion, verse, bridgeEnd, userId, JSON.stringify({ content: seedContent }), expected),
  ]);
  if (!updateRes.meta.changes) {
    const fresh = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
    return c.json({ error: "version_mismatch", current: fresh ? { ...fresh, content: safeParseOrNull(fresh) } : null }, 409);
  }

  const updated = await loadVerseRow(c.env.DB, book, chapter, verse, bibleVersion);
  const startDto = updated ? { ...updated, content: safeParseOrNull(updated) } : null;
  // Re-read the recreated verses for their ACTUAL versions — the split no longer
  // mints them at a literal 1 (see SPLIT_INSERT_VERSES_RANGE_SQL), so a hand-built
  // `version: 1` DTO would leave the client with a stale expected_version and
  // 409 its first edit. Rows are keyed verse > start AND verse <= bridgeEnd.
  const createdRes = await c.env.DB.prepare(
    `SELECT verse, version, updated_at, updated_by FROM verses
      WHERE book = ?1 AND chapter = ?2 AND bible_version = ?3 AND verse > ?4 AND verse <= ?5
      ORDER BY verse`,
  )
    .bind(book, chapter, bibleVersion, verse, bridgeEnd)
    .all<{ verse: number; version: number; updated_at: number; updated_by: number | null }>();
  const newDtos: VerseDto[] = createdRes.results.map((r) => ({
    book,
    chapter,
    verse: r.verse,
    verse_end: null,
    bible_version: bibleVersion,
    plain_text: null,
    version: r.version,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
    content: seedContent,
  }));
  c.executionCtx.waitUntil(
    (async () => {
      await reopenLaneChecks(c.env, book, chapter, verse, ["text"]);
      if (startDto) {
        await broadcastChapter(c.env, book, chapter, {
          type: "verse.split",
          verse: startDto,
          newVerses: newDtos,
        });
      }
    })(),
  );
  return c.json({ verse: startDto, new_verses: newDtos });
});

// Parse a verse row's content_json, returning null on corruption rather than
// throwing — used only when building a 409/echo body where a corrupt row must
// not mask the real (version) error. The primary write paths above still use
// parseVerseContentJson so a corrupt row on the happy path 500s loudly.
function safeParseOrNull(row: VerseRow): unknown {
  try {
    return parseVerseContentJson(row);
  } catch {
    return null;
  }
}

// Book list + on-demand import from DCS.
//
// GET  /api/books              — list imported books (existing behaviour).
// POST /api/books/:book/import — pull ULT/UST/UHB-or-UGNT/tn/tq/twl for a
//   single book from DCS, parse, and write into D1. Idempotent: if the
//   book is already in book_imports we short-circuit and return ok.
//
// This is the Worker equivalent of `scripts/import-book.mjs`. Same shape,
// just running server-side so the editor's dropdown can auto-import a book
// on first selection instead of asking the operator to run a CLI.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import {
  extractUsfmHeaders,
  extractVersesForRange,
  makeVerseSortOrder,
  parseTsv,
  refParts,
} from "./importParsers";
import { requireAuth, requireEditor, currentUserId } from "./auth";
import { BOOK_NUMBERS, dcsUrls, dcsResourceFile, fileCommitSha, fetchText } from "./dcsSources";
import { reimportBookFromDcs, recordResourceSync, ALL_RESOURCES, type Resource } from "./bookReimport";
import { lintChapterOpeningMarkers, lintTnRows, lintTqRows, lintTwlRows, lintUsfmVerses } from "./lint";
import { effectiveBookLock, canManageLocks, type BookLock } from "./bookLock";
import { isPublishedBook } from "./publishedGuard";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";

export const books = new Hono<{ Bindings: Env; Variables: { userId?: number; username?: string } }>();

// GET /api/books also reports each book's lock state (published-default or
// explicit override — see bookLock.ts) so the book picker can render a lock
// badge without a second request per book, plus whether the current user can
// change locks at all (used to show/hide the lock/unlock control).
books.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports ORDER BY book`,
  ).all<{ book: string; imported_at: number }>();

  // One query for every book's explicit lock row, not one per book (D1
  // subrequest budget — same discipline as lockedBooksIn in bookLock.ts).
  const lockRows = await c.env.DB.prepare(
    `SELECT book, locked, reason FROM book_locks`,
  ).all<{ book: string; locked: number; reason: string | null }>();
  const explicit = new Map<string, { locked: number; reason: string | null }>();
  for (const row of lockRows.results ?? []) explicit.set(row.book, row);

  const booksOut = (rs.results ?? []).map((b) => {
    const override = explicit.get(b.book);
    let locked: boolean;
    let lockReason: string | null;
    let lockSource: "published" | "explicit" | null;
    if (override) {
      // An explicit row always wins, including locked=0 (a deliberate
      // unlock of an otherwise-published book).
      locked = override.locked === 1;
      lockReason = locked ? override.reason : null;
      lockSource = locked ? "explicit" : null;
    } else if (isPublishedBook(b.book)) {
      locked = true;
      lockReason = null;
      lockSource = "published";
    } else {
      locked = false;
      lockReason = null;
      lockSource = null;
    }
    return { ...b, locked, lockReason, lockSource };
  });

  const username = c.get("username");
  const canManage = await canManageLocks(c.env, username);
  return c.json({ books: booksOut, canManageLocks: canManage });
});

const LockBody = z.object({
  reason: z.string().max(200).optional(),
});

// Shared response shape for PUT/DELETE .../lock — the resulting lock state,
// in the same shape effectiveBookLock returns (null when unlocked).
function lockStateResponse(book: string, lock: BookLock | null) {
  return {
    book,
    locked: lock !== null,
    lockReason: lock?.reason ?? null,
    lockSource: lock?.source ?? null,
  };
}

// Who last changed a book's lock, and when, is recorded by `book_locks.set_by`
// / `set_at` — that upsert IS the audit record. Deliberately no system_alerts
// row: those render as persistent top-of-app banners addressed to a username
// (see alerts.ts), so auditing there would hand the acting maintainer a banner
// to dismiss after every lock — noise for a user-initiated action that already
// has immediate UI feedback. If a full lock/unlock *history* is ever needed,
// that wants its own append-only table, not the banner channel.

// PUT /api/books/:book/lock — explicitly lock a book (freezes app edits and
// export, independent of whether it's published). requireEditor gates any
// write at all; the narrower canManageLocks check below gates this
// particular write to the small admin allowlist in book_lock_admins.
books.put("/:book/lock", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const username = c.get("username");
  if (!(await canManageLocks(c.env, username))) {
    return c.json({ error: "forbidden", reason: "not_a_lock_admin" }, 403);
  }

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body is fine — reason is optional */
  }
  const parsed = LockBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  const reason = parsed.data.reason ?? null;

  await c.env.DB.prepare(
    `INSERT INTO book_locks (book, locked, reason, set_at, set_by)
     VALUES (?1, 1, ?2, unixepoch(), ?3)
     ON CONFLICT (book) DO UPDATE SET
       locked = 1, reason = ?2, set_at = unixepoch(), set_by = ?3`,
  )
    .bind(book, reason, userId)
    .run();

  const lock = await effectiveBookLock(c.env, book);
  return c.json(lockStateResponse(book, lock));
});

// DELETE /api/books/:book/lock — explicitly unlock a book. Writes an
// explicit locked=0 row rather than deleting any existing row: a delete
// would let a published book fall straight back to locked via the default,
// which defeats the whole point of unlocking a published book for a
// maintainer cleanup pass.
books.delete("/:book/lock", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const username = c.get("username");
  if (!(await canManageLocks(c.env, username))) {
    return c.json({ error: "forbidden", reason: "not_a_lock_admin" }, 403);
  }

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  await c.env.DB.prepare(
    `INSERT INTO book_locks (book, locked, reason, set_at, set_by)
     VALUES (?1, 0, NULL, unixepoch(), ?2)
     ON CONFLICT (book) DO UPDATE SET
       locked = 0, reason = NULL, set_at = unixepoch(), set_by = ?2`,
  )
    .bind(book, userId)
    .run();

  const lock = await effectiveBookLock(c.env, book);
  return c.json(lockStateResponse(book, lock));
});

// POST /api/books/:book/lock/push — push a just-locked book to Door43 right
// now, across every resource, instead of waiting for the nightly export.
// Scenario this exists for: a book is unlocked for an editor to fix
// something, then re-locked — without this, those edits sit in D1 until the
// next 05:30 UTC cron, or someone remembers to trigger a manual export.
//
// Gated on canManageLocks (the book_lock_admins allowlist), NOT requireAdmin:
// the caller is whoever just locked the book, and for Perry (pjoakes) that's
// a *narrower* allowlist than requireAdmin — he's a book_lock_admin but only
// an `editor` in user_roles, so he can't reach POST /api/exports/run (the
// admin panel's manual push). Requires the book to actually be locked right
// now (no recency check beyond that — a lock admin could call this on any
// currently-locked book, not only one they just re-locked; that is an
// intentional widening of what the 3-person book_lock_admins allowlist can
// trigger on Door43, accepted because they already hold the power to
// unlock+relock any book at will, so a recency gate would not add a real
// barrier, only complexity).
//
// Also requires the book to have actually been imported — effectiveBookLock
// doesn't check that (a book can be locked purely via the PUBLISHED_BOOKS
// default without a book_imports row), and without this check the Workflow's
// own book resolution would find zero books, silently do nothing, and still
// report every resource as "queued".
//
// Fires one Workflow instance per resource, each explicitly naming book +
// resource, because lockOverrideAllowed only honors `allowLocked` for an
// exactly-one-book-one-resource run (see publishedGuard.ts) — a single
// instance with resource omitted would resolve to all 5 resources and the
// override would be silently ignored, leaving every resource skipped as
// book_locked. validateAndMerge mirrors the nightly cron so this actually
// lands on master rather than leaving a PR for someone to merge by hand.
books.post("/:book/lock/push", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const username = c.get("username");
  if (!(await canManageLocks(c.env, username))) {
    return c.json({ error: "forbidden", reason: "not_a_lock_admin" }, 403);
  }

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const lock = await effectiveBookLock(c.env, book);
  if (!lock) return c.json({ error: "book_not_locked", book }, 400);

  const imported = await c.env.DB.prepare(`SELECT 1 FROM book_imports WHERE book = ?1`)
    .bind(book)
    .first();
  if (!imported) return c.json({ error: "book_not_imported", book }, 400);

  // Each resource lives in its own DCS repo (RESOURCE_TARGETS in export.ts —
  // en_tn/en_tq/en_twl/en_ult/en_ust), so the 5 creates below share no
  // mutable state and can safely run concurrently rather than one at a time.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pushed = await Promise.all(
    ALL_RESOURCES.map(async (resource) => {
      try {
        const instance = await c.env.EXPORT_WORKFLOW.create({
          id: `lock-push-${book}-${resource}-${stamp}`,
          params: { book, resource, allowLocked: true, validateAndMerge: true },
        });
        return { resource, instanceId: instance.id };
      } catch (e) {
        return { resource, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  return c.json({ book, pushed });
});

// GET /api/books/:book/lint — the in-app "issues to clean up" feed for a book.
// Runs the flag/escalate lint (the DCS checks the export can't auto-fix) over the
// book's live D1 rows and returns the issues, each with a ref + (for TN) a row id
// so the UI can jump straight to it. Read-only; any authed user can view.
books.get("/:book/lint", requireAuth, async (c) => {
  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const tn = await c.env.DB.prepare(
    `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TnRow>();
  // tq/twl have no trashed_at column (only tn does), so filter deleted_at only.
  const tq = await c.env.DB.prepare(
    `SELECT * FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TqRow>();
  const twl = await c.env.DB.prepare(
    `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TwlRow>();
  const ult = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'ULT' ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();
  const ust = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'UST' ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();

  const issues = [
    ...lintTnRows(tn.results ?? []).map((i) => ({ ...i, resource: "tn" })),
    ...lintTqRows(tq.results ?? []).map((i) => ({ ...i, resource: "tq" })),
    ...lintTwlRows(twl.results ?? []).map((i) => ({ ...i, resource: "twl" })),
    ...lintUsfmVerses(ult.results ?? []).map((i) => ({ ...i, resource: "ult" })),
    ...lintUsfmVerses(ust.results ?? []).map((i) => ({ ...i, resource: "ust" })),
    ...lintChapterOpeningMarkers(ult.results ?? []).map((i) => ({ ...i, resource: "ult" })),
    ...lintChapterOpeningMarkers(ust.results ?? []).map((i) => ({ ...i, resource: "ust" })),
  ];
  const flagCount = issues.filter((i) => i.bucket === "flag").length;
  const escalateCount = issues.filter((i) => i.bucket === "escalate").length;
  return c.json({ book, total: issues.length, flagCount, escalateCount, issues });
});

books.post("/:book/import", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  const num = BOOK_NUMBERS[book];
  if (!num) return c.json({ error: "unknown_book", book }, 400);

  // Idempotency: already imported → fast path.
  const existing = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first<{ book: string; imported_at: number }>();
  if (existing) {
    return c.json({ ok: true, book, alreadyImported: true, imported_at: existing.imported_at });
  }

  // Orphan recovery: a prior import inserted rows but crashed before writing the
  // final book_imports marker. That marker is the LAST write, so a clean crash
  // leaves the FULL resource set present — only then is it safe to re-register
  // without re-fetching. We therefore require ULT, UST, TN, TQ and TWL to all be
  // non-empty. A partial leftover (e.g. the original-language source survived a
  // delete but the translations/notes were removed) must NOT be mistaken for a
  // recoverable import: it falls through to the clean wipe-and-import below,
  // which re-fetches every resource from DCS.
  //
  // (Previously this checked only "any verse exists", so a book left with just
  // its UHB/UGNT source got stamped source_url='recovered' and could never be
  // re-imported — the marker made every later POST hit the alreadyImported fast
  // path above. This is exactly how ISA got stuck with Hebrew-only content.)
  const present = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM verses   WHERE book = ?1 AND bible_version = 'ULT') AS ult,
       (SELECT COUNT(*) FROM verses   WHERE book = ?1 AND bible_version = 'UST') AS ust,
       (SELECT COUNT(*) FROM tn_rows  WHERE book = ?1 AND deleted_at IS NULL)    AS tn,
       (SELECT COUNT(*) FROM tq_rows  WHERE book = ?1 AND deleted_at IS NULL)    AS tq,
       (SELECT COUNT(*) FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL)    AS twl`,
  )
    .bind(book)
    .first<{ ult: number; ust: number; tn: number; tq: number; twl: number }>();
  const looksComplete =
    !!present &&
    present.ult > 0 &&
    present.ust > 0 &&
    present.tn > 0 &&
    present.tq > 0 &&
    present.twl > 0;
  if (looksComplete) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO book_imports (book, source_url, imported_at, imported_by)
       VALUES (?1, 'recovered', unixepoch(), ?2)`,
    )
      .bind(book, userId)
      .run();
    return c.json({ ok: true, book, recovered: true });
  }

  // Cross-isolate import lock — `INSERT OR IGNORE` on the PK gives us an
  // atomic "first writer wins" handshake. The previous in-memory Set was
  // per-Worker-isolate, so a second POST that happened to land on a
  // different edge node would have raced the DELETE-then-INSERT pipeline
  // below and double-imported the book. A stale lock from a crashed Worker
  // is reclaimed by the */5 sweep in api/src/index.ts.
  const lock = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, unixepoch(), ?2)`,
  )
    .bind(book, userId)
    .run();
  if (!lock.meta.changes) {
    return c.json({ error: "in_progress", book }, 409);
  }

  try {
    const result = await importBookFromDcs(c.env, book, num, userId);
    return c.json({ ok: true, book, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "import_failed", book, message: msg }, 502);
  } finally {
    await c.env.DB.prepare(
      `DELETE FROM book_import_locks WHERE book = ?1`,
    )
      .bind(book)
      .run();
  }
});

// POST /api/books/:book/reimport — non-destructive per-chapter, per-resource
// re-import from DCS. Required body: { chapters: number[], resources: Resource[] }.
// Skips rows that have been edited locally (see bookReimport.ts for the
// pristine predicate). Requires the book to be bootstrapped (404 otherwise);
// reuses book_import_locks (409 in_progress if held).
const ALLOWED_RESOURCES: ReadonlyArray<Resource> = ["ult", "ust", "tn", "tq", "twl"];

books.post("/:book/reimport", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  let body: { chapters?: unknown; resources?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_body" }, 422);
  }
  // >= 0, not >= 1: chapter 0 (refParts("front:intro") in importParsers.ts)
  // is a real, syncable chapter — the book-level intro TN/TQ/TWL row — so a
  // maintainer must be able to ask this route to pull it back from master too.
  // NaN/negative are still rejected (malformed input, not a valid chapter).
  const chapters = Array.isArray(body.chapters)
    ? body.chapters
        .map((n) => (typeof n === "number" ? Math.floor(n) : NaN))
        .filter((n) => Number.isFinite(n) && n >= 0)
    : [];
  const resources = Array.isArray(body.resources)
    ? body.resources.filter((r): r is Resource =>
        typeof r === "string" && (ALLOWED_RESOURCES as readonly string[]).includes(r),
      )
    : [];
  if (chapters.length === 0) {
    return c.json({ error: "invalid_body", detail: "chapters must be a non-empty list of non-negative integers" }, 422);
  }
  if (resources.length === 0) {
    return c.json({ error: "invalid_body", detail: "resources must include at least one of ult/ust/tn/tq/twl" }, 422);
  }

  try {
    const result = await reimportBookFromDcs(c.env, book, chapters, resources, userId, { source: "user" });
    return c.json({ ok: true, ...result });
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : "";
    if (name === "BookNotImportedError") return c.json({ error: "book_not_imported", book }, 404);
    if (name === "ImportInProgressError") return c.json({ error: "in_progress", book }, 409);
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "reimport_failed", book, message: msg }, 502);
  }
});

interface ImportCounts {
  verses: number;
  tn: number;
  tq: number;
  twl: number;
  fetched: { ult: boolean; ust: boolean; orig: boolean; tn: boolean; tq: boolean; twl: boolean };
}

async function importBookFromDcs(
  env: Env,
  book: string,
  _num: string,
  userId: number,
): Promise<ImportCounts> {
  const urls = dcsUrls(env, book);
  if (!urls) throw new Error(`unknown book: ${book}`);
  const origVersion = urls.origVersion;

  // Fire all six fetches in parallel. unfoldingWord's repos carry every
  // resource for every supported book, so any null here is a transient DCS
  // issue (timeout, 5xx, partial outage). Marking the book as imported with
  // a critical resource missing leaves it silently broken — see the ZEC
  // bootstrap that landed without TWLs. Fail loudly so the next attempt
  // succeeds cleanly.
  const [ultRaw, ustRaw, origRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    fetchText(urls.ult),
    fetchText(urls.ust),
    fetchText(urls.orig),
    fetchText(urls.tn),
    fetchText(urls.tq),
    fetchText(urls.twl),
  ]);

  const missing: string[] = [];
  if (!ultRaw) missing.push(`ult (${urls.ult})`);
  if (!ustRaw) missing.push(`ust (${urls.ust})`);
  if (!origRaw) missing.push(`${origVersion.toLowerCase()} (${urls.orig})`);
  if (!tnRaw) missing.push(`tn (${urls.tn})`);
  if (!tqRaw) missing.push(`tq (${urls.tq})`);
  if (!twlRaw) missing.push(`twl (${urls.twl})`);
  if (missing.length > 0) {
    throw new Error(`DCS fetch failed for ${missing.length} resource(s); retry: ${missing.join("; ")}`);
  }

  // Wipe any partial leftovers from a prior failed run. book_imports stays
  // empty until the very end so a midway failure leaves the book in an
  // unimported state (the next POST retries cleanly).
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM tn_rows  WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM tq_rows  WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM twl_rows WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM verses   WHERE book = ?1`).bind(book),
    env.DB.prepare(`DELETE FROM book_usfm_meta WHERE book = ?1`).bind(book),
    // Manual TWL order locks go too. They deliberately SURVIVE a reimport (the
    // rows are matched by id and the human's order still applies), but a full
    // import is a reset to DCS truth: every twl row above is deleted and
    // re-inserted in file order, so a surviving lock would pin whatever DCS
    // happened to ship and label it "a human ordered this" with no human
    // involved — and permanently exclude those verses from canonical ordering.
    env.DB.prepare(`DELETE FROM twl_order_locks WHERE book = ?1`).bind(book),
  ]);

  const counts: ImportCounts = {
    verses: 0,
    tn: 0,
    tq: 0,
    twl: 0,
    fetched: {
      ult: !!ultRaw,
      ust: !!ustRaw,
      orig: !!origRaw,
      tn: !!tnRaw,
      tq: !!tqRaw,
      twl: !!twlRaw,
    },
  };

  counts.verses += await insertVerses(env, book, "ULT", ultRaw);
  counts.verses += await insertVerses(env, book, "UST", ustRaw);
  counts.verses += await insertVerses(env, book, origVersion, origRaw);

  counts.tn = await insertTnRows(env, book, tnRaw, userId);
  counts.tq = await insertTqRows(env, book, tqRaw, userId);
  counts.twl = await insertTwlRows(env, book, twlRaw, userId);

  // Final marker — the read path keys off this row's presence.
  const sources = Object.entries(counts.fetched)
    .filter(([, ok]) => ok)
    .map(([k]) => k)
    .join(",");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO book_imports (book, source_url, imported_at, imported_by)
     VALUES (?1, ?2, unixepoch(), ?3)`,
  )
    .bind(book, `dcs:${sources}`, userId)
    .run();

  // Seed per-resource SHA watermarks so the nightly self-heal can skip files
  // that haven't changed since this import (see book_resource_syncs +
  // bookReimport.ts). Best-effort — a missing watermark just means the first
  // nightly reimports that resource.
  for (const resource of ["ult", "ust", "tn", "tq", "twl"] as Resource[]) {
    if (!counts.fetched[resource]) continue;
    const file = dcsResourceFile(book, resource);
    if (!file) continue;
    const sha = await fileCommitSha(env, file.repo, file.path);
    if (sha) await recordResourceSync(env, book, resource, sha, "import");
  }

  return counts;
}

// D1 batch() caps at 100 statements per call. Keep chunks well under that.
const CHUNK = 80;

async function insertVerses(
  env: Env,
  book: string,
  bibleVersion: string,
  rawUsfm: string | null,
): Promise<number> {
  if (!rawUsfm) return 0;

  const headers = extractUsfmHeaders(rawUsfm);
  if (headers) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, headers_json)
       VALUES (?1, ?2, ?3)`,
    )
      .bind(book, bibleVersion, JSON.stringify(headers))
      .run();
  }

  // Whole-book extract; the [1, 999] range covers any chapter that exists.
  const verses = extractVersesForRange(rawUsfm, 1, 999);
  if (verses.length === 0) return 0;

  const stmt = env.DB.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );
  for (let i = 0; i < verses.length; i += CHUNK) {
    const slice = verses.slice(i, i + CHUNK);
    await env.DB.batch(
      slice.map((v) =>
        stmt.bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText),
      ),
    );
  }
  return verses.length;
}

async function insertTnRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tn_rows
       (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     VALUES ('tn', ?1, ?2, ?3, NULL, 1, 'create', ?4)`,
  );

  let count = 0;
  const nextSort = makeVerseSortOrder();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.batch(batch);
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      support_reference: r["SupportReference"] || null,
      quote: r["Quote"] || null,
      occurrence,
      note: r["Note"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.support_reference, payload.quote, payload.occurrence, payload.note,
        nextSort(ch, v),
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    count++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return count;
}

async function insertTqRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tq_rows
       (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     VALUES ('tq', ?1, ?2, ?3, NULL, 1, 'create', ?4)`,
  );

  let count = 0;
  const nextSort = makeVerseSortOrder();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.batch(batch);
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      quote: r["Quote"] || null,
      occurrence,
      question: r["Question"] || null,
      response: r["Response"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.quote, payload.occurrence, payload.question, payload.response,
        nextSort(ch, v),
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    count++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return count;
}

async function insertTwlRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     VALUES ('twl', ?1, ?2, ?3, NULL, 1, 'create', ?4)`,
  );

  let count = 0;
  const nextSort = makeVerseSortOrder();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await env.DB.batch(batch);
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      orig_words: r["OrigWords"] || null,
      occurrence,
      tw_link: r["TWLink"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.orig_words, payload.occurrence, payload.tw_link,
        nextSort(ch, v),
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    count++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  return count;
}

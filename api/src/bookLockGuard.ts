// Hono middleware that refuses writes to a locked book. A locked book —
// published in the latest DCS release, or explicitly locked via
// `PUT /api/books/:book/lock` — is frozen: no app edits, no export to Door43.
// See bookLock.ts for the precedence rule between the two lock sources.
//
// Deliberately NOT gated by this guard:
//   - Review comments (comments.ts). A finished book can still be discussed;
//     a comment thread isn't an edit to the book's content.
//   - The NIGHTLY cron/Workflow DCS→D1 reimport (bookReimport.ts /
//     exportWorkflow.ts). That path only pulls Door43 master INTO D1, and
//     keeping a locked book's local copy matching master is desirable even
//     while it's frozen for local editing. This guard only runs in the Hono
//     request pipeline, which the nightly reimport's own code paths (cron,
//     Workflow step) never pass through.
//
// IS gated by this guard (mounted on `/api/books/:book/*` in index.ts):
//   - The MANUAL `POST /api/books/:book/import` and `/reimport` routes. These
//     are a different code path from the nightly reimport above — they run
//     inside this Hono pipeline, so the guard sees them — and blocking them
//     for a locked book is intentional, not a gap: `/import` does
//     `DELETE FROM tn_rows WHERE book = ?` (and the equivalent for
//     tq/twl/verses/book_usfm_meta) before reinserting, a destructive D1
//     write we don't want landing on a book that's supposed to be frozen;
//     `/reimport` is itself non-destructive but still a fresh, deliberate
//     write action a translator triggers by hand, so the same refusal
//     applies for consistency.

import type { MiddlewareHandler } from "hono";
import type { Env } from "./index";
import { effectiveBookLock, bookLockedResponseBody, BOOK_LOCKED_STATUS } from "./bookLock";
import { currentUserId } from "./auth";

export const bookLockGuard: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  // The lock/unlock endpoints themselves (PUT/DELETE /api/books/:book/lock),
  // plus the "push this locked book to Door43 now" action
  // (POST /api/books/:book/lock/push), must never be blocked by the guard
  // they configure or act on — otherwise a locked book could never be
  // unlocked, and the push route (whose only precondition is that the book
  // IS locked) would 423 on every call before its own handler ever ran.
  // Matched precisely rather than with endsWith("/lock"): a loose suffix test
  // would silently exempt any future route ending in "/lock" from lock
  // enforcement, which is the kind of hole nobody would notice. (Note
  // `/twl-order-lock` ends in "-lock", not "/lock", so it was never exempt —
  // but that is luck, not design.)
  if (/^\/api\/books\/[^/]+\/lock(\/push)?$/.test(c.req.path)) {
    return next();
  }

  let book: string | undefined = c.req.param("book") || c.req.query("book") || undefined;
  if (!book) {
    // Hono caches the parsed body on the Request, so this read doesn't
    // consume it for the downstream handler — a later `c.req.json()` call
    // still resolves normally.
    try {
      const body = await c.req.json<{ book?: unknown }>();
      if (typeof body?.book === "string" && body.book) book = body.book;
    } catch {
      // No JSON body (or not JSON) — fall through to the "no book" case below.
    }
  }

  // This guard is not an authorization boundary. If a route's shape doesn't
  // tell us which book it's writing, we must not break it — let it through.
  if (!book) return next();

  // This guard runs before route-level auth (requireAuth / requireEditor).
  // Skipping the lock check for an anonymous caller here is not about
  // secrecy — lock state is not a secret; `GET /api/books` returns
  // `locked`/`lockReason`/`lockSource` for every book with no auth
  // middleware at all (see bookImport.ts), so it is already anonymously
  // readable. The real reason is layering: this guard has no way to know
  // whether the route ahead of it would even authorize the caller, so
  // answering here (423, or anything else) would preempt the route's own
  // auth check. Deferring lets every book-scoped write route's existing
  // requireEditor produce the correct 401/403 for an anonymous caller — this
  // guard only needs to run at all once we know a caller is authenticated.
  if (!currentUserId(c)) return next();

  const lock = await effectiveBookLock(c.env as Env, book.toUpperCase());
  if (lock) {
    return c.json(bookLockedResponseBody(lock), BOOK_LOCKED_STATUS);
  }
  return next();
};

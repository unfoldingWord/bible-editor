// Centralized book-lock check. A locked book is read-only for both app edits
// and export to Door43. Lock state comes from two sources, in precedence
// order: an explicit row in `book_locks` (migration 0043) always wins; absent
// a row, a book falls back to the published-books default in
// api/src/publishedGuard.ts. See that module's header for the evidence behind
// the default and migration 0043's header for why `locked=0` is a deliberate
// unlock, not the same as "no row."

import type { Env } from "./index";
import { autoMergeConfirmationRequired, isPublishedBook, PUBLISHED_RELEASE_TAG } from "./publishedGuard.ts";

export interface BookLock {
  book: string;
  reason: string | null;
  source: "published" | "explicit";
}

// Resolves whether `book` is currently locked. Returns null when unlocked.
export async function effectiveBookLock(env: Env, book: string): Promise<BookLock | null> {
  const upper = book.toUpperCase();
  const row = await env.DB.prepare(
    `SELECT locked, reason FROM book_locks WHERE book = ?1`,
  )
    .bind(upper)
    .first<{ locked: number; reason: string | null }>();
  if (row) {
    // An explicit locked=0 row is a deliberate unlock of an otherwise-published
    // book and wins over the published default.
    return row.locked === 1 ? { book: upper, reason: row.reason, source: "explicit" } : null;
  }
  if (isPublishedBook(upper)) {
    return { book: upper, reason: `published in ${PUBLISHED_RELEASE_TAG}`, source: "published" };
  }
  return null;
}

// Shape of the confirmation-required response when an allowLocked:true export
// against a locked/published book carries neither branchName nor an explicit
// allowAutoMerge acknowledgement — see publishedGuard.ts's
// autoMergeConfirmationRequired for why this matters (a branchless export
// lands on a `-be-` branch DCS auto-merges unattended).
export interface AutoMergeConfirmationRequired {
  book: string;
  reason: string | null;
}

// The single choke point every route that can create an allowLocked:true
// export Workflow must call before EXPORT_WORKFLOW.create — issue #602:
// POST /exports/run consulted publishedGuard.ts's autoMergeConfirmationRequired
// inline, but POST /books/:book/lock/push created the same kind of branchless
// locked-book export without ever calling it, because the policy lived at one
// call site instead of here. Resolves the lock itself (D1), so callers no
// longer duplicate that lookup only to re-derive the same verdict.
export async function requireAutoMergeConfirmation(
  env: Env,
  book: string,
  params: { allowLocked?: boolean; branchName?: string; allowAutoMerge?: boolean },
): Promise<AutoMergeConfirmationRequired | null> {
  if (params.allowLocked !== true) return null;
  const lock = await effectiveBookLock(env, book);
  if (!lock) return null;
  if (!autoMergeConfirmationRequired(params, true)) return null;
  return { book: lock.book, reason: lock.reason };
}

// Shape of the response body when a write is rejected because the book is
// locked. The client uses this to render "this book is locked" without a
// second request.
export interface BookLockedError {
  error: "book_locked";
  book: string;
  reason: string | null;
  source: "published" | "explicit";
}

export function bookLockedResponseBody(lock: BookLock): BookLockedError {
  return {
    error: "book_locked",
    book: lock.book,
    reason: lock.reason,
    source: lock.source,
  };
}

// 423 Locked, not 409/429/5xx. The web outbox (web/src/sync/outbox.ts) treats
// 423 as non-retryable: the op parks as `failed` and stays visible to the
// user rather than being silently retried or dropped. 409 must NOT be used
// here — an unrecognized 409 body drops the op into the conflict-resolution
// machinery with no `current` version to reconcile against, which shows the
// user an unresolvable merge prompt. 429 and 5xx must not be used either,
// because the outbox retries both with backoff, and a locked book will never
// stop being locked on retry.
export const BOOK_LOCKED_STATUS = 423;

// Checked live against D1 rather than from the caller's JWT because the JWT's
// username/role claims carry a 1-hour TTL — a claims-based allowlist would lag
// a lock-admin change (grant or revoke) by up to an hour.
export async function canManageLocks(
  env: Env,
  username: string | undefined | null,
): Promise<boolean> {
  if (!username) return false;
  // COLLATE NOCASE on the column (migration 0043) means no manual case
  // handling is needed here.
  const row = await env.DB.prepare(
    `SELECT 1 FROM book_lock_admins WHERE dcs_username = ?1`,
  )
    .bind(username)
    .first();
  return row != null;
}

// Resolves lock state for many books in one query — used by the nightly
// export workflow, which must not issue one query per book (see
// exportWorkflow.ts's subrequest-budget comments elsewhere in this codebase).
export async function lockedBooksIn(env: Env, books: string[]): Promise<Set<string>> {
  if (books.length === 0) return new Set();
  const upperBooks = books.map((b) => b.toUpperCase());
  const placeholders = upperBooks.map((_, i) => `?${i + 1}`).join(", ");
  const rs = await env.DB.prepare(
    `SELECT book, locked FROM book_locks WHERE book IN (${placeholders})`,
  )
    .bind(...upperBooks)
    .all<{ book: string; locked: number }>();
  const explicit = new Map<string, number>();
  for (const row of rs.results ?? []) explicit.set(row.book, row.locked);

  const locked = new Set<string>();
  for (const book of upperBooks) {
    if (explicit.has(book)) {
      if (explicit.get(book) === 1) locked.add(book);
      continue;
    }
    if (isPublishedBook(book)) locked.add(book);
  }
  return locked;
}

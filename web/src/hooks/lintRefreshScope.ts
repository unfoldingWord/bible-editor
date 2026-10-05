// Which request a book-lint refresh makes (#888). Pure, so a node test can
// load it (lintRefreshScope.test.mjs).

/** How old the last whole-book lint may be before a refresh must re-lint the
 *  whole book. Shared by the post-save path (below) and Shell's focus refresh. */
export const WHOLE_BOOK_LINT_MAX_AGE_MS = 60_000;

export interface PendingLintScope {
  /** Someone asked for the whole book. */
  whole: boolean;
  /** Chapters whose saves are waiting for a refresh. */
  chapters: Set<number>;
}

/**
 * The chapter to re-lint and merge, or undefined for the whole book.
 *
 * A chapter request refreshes nothing outside that chapter, so changes made
 * elsewhere (another user, AI auto-apply, the nightly sync) reach the chip only
 * through a whole-book fetch. Shell's focus refresh provides one, but a tab
 * that stays focused never fires it; so once the last whole-book lint is
 * WHOLE_BOOK_LINT_MAX_AGE_MS old, a post-save refresh re-lints the whole book.
 * `lastWholeAt` is 0 before the first whole-book fetch lands and after a
 * failed fetch.
 */
export function lintRefreshScope(
  pending: PendingLintScope,
  hasBase: boolean,
  lastWholeAt: number,
  now: number,
): number | undefined {
  if (pending.whole || pending.chapters.size !== 1 || !hasBase) return undefined;
  if (lastWholeAt <= 0 || now - lastWholeAt >= WHOLE_BOOK_LINT_MAX_AGE_MS) return undefined;
  return [...pending.chapters][0];
}

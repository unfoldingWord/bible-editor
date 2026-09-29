// "Last copy, locked" (#892). On a chapter change useChapter keeps the
// previous chapter's payload on screen until the new one lands, instead of
// blanking the view. That copy belongs to a different chapter than the route,
// so it is shown locked: no edit may be typed into it or queued against it
// (the #531 rule). These helpers are the one place that decides "is the
// payload on screen the route's own chapter".

export interface ChapterRoute {
  book: string;
  chapter: number;
}

interface ChapterKeyed {
  book: string;
  chapter: number;
}

/**
 * True when a payload is on screen but belongs to a different (book, chapter)
 * than the route: the tab navigated and the fresh payload has not landed yet.
 * `null` is not stale; it is the plain loading state.
 */
export function isStaleChapter(data: ChapterKeyed | null, route: ChapterRoute): boolean {
  if (!data) return false;
  return data.chapter !== route.chapter || data.book.toUpperCase() !== route.book.toUpperCase();
}

/**
 * Apply a local mutation only to the route's own payload. A stale payload (or
 * null) is returned as the same object, so a React state updater skips the
 * render. This matches what happened when the payload was cleared on
 * navigation: every local apply in that window was a no-op.
 */
export function updateIfCurrent<T extends ChapterKeyed>(
  prev: T | null,
  route: ChapterRoute,
  fn: (prev: T) => T,
): T | null {
  if (!prev || isStaleChapter(prev, route)) return prev;
  return fn(prev);
}

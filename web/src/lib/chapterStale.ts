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

/** The route key plus a counter bumped on every navigation to a new route. */
export interface NavigationGen {
  key: string;
  gen: number;
}

/**
 * Advance the navigation generation when the route changes; return `prev`
 * itself when it hasn't, so a re-render (or StrictMode's double render) never
 * counts as a navigation. Returning to a chapter just left IS a new
 * navigation (A → B → A bumps twice).
 */
export function trackNavigation(prev: NavigationGen | null, route: ChapterRoute): NavigationGen {
  const key = `${route.book.toUpperCase()}:${route.chapter}`;
  if (prev && prev.key === key) return prev;
  return { key, gen: (prev?.gen ?? 0) + 1 };
}

/**
 * Whether the payload on screen must be shown locked: when it belongs to
 * another chapter than the route, and also when it matches the route but the
 * fetch started for the current navigation hasn't landed yet (`landedGen`).
 * After A → B → A, A's old copy can carry pre-save versions, because outbox
 * results and WS updates for A were filtered while the route was B.
 */
export function isChapterLocked(
  data: ChapterKeyed | null,
  route: ChapterRoute,
  landedGen: number,
  currentGen: number,
): boolean {
  if (!data) return false;
  return isStaleChapter(data, route) || landedGen !== currentGen;
}

// Throttle for the "refetch when the tab comes back" handlers (#897).
// Translators alt-tab to Logos and Paratext constantly; without this, every
// return fires one request per focus-refresh hook, and the first click after
// returning competes with them.
//
// Only markSuccess(), called after a fetch succeeds, moves the timestamp.
// Stamping when the request starts would let a failed fetch (offline, 5xx)
// block the next refocus retry for the whole window.
//
// Each hook keeps its throttle at module level, not in a ref, so a remount
// (Shell is keyed by book) does not reset it.

export interface RefocusThrottle {
  /** True when a refocus may refetch: no successful fetch within the window. */
  shouldRun(now?: number): boolean;
  /** Record a successful fetch. Call it from every fetch path, not just refocus. */
  markSuccess(now?: number): void;
}

export function createRefocusThrottle(windowMs: number): RefocusThrottle {
  let lastSuccessAt = -Infinity;
  return {
    shouldRun(now = Date.now()) {
      return now - lastSuccessAt >= windowMs;
    },
    markSuccess(now = Date.now()) {
      lastSuccessAt = now;
    },
  };
}

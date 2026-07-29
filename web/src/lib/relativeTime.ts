// Compact relative-time formatting for comment timestamps. No date library
// exists in this repo (see PipelineStatusBar.tsx / PipelineMenu.tsx for the
// two ad-hoc one-off copies) — this is the shared version for comments only.
// Those two are NOT refactored to use this; leave them alone.

/** Compact relative time from a unix-SECONDS timestamp, e.g. "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - unixSeconds * 1000;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay <= 30) return `${diffDay}d ago`;

  return new Date(unixSeconds * 1000).toLocaleDateString();
}

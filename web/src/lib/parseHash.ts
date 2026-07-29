// Parses the URL hash into a navigable Location. Extracted from App.tsx so
// it's unit-testable without a DOM/location global.

export interface Location {
  book: string;
  chapter: number;
  verse: number;
  // Present when the hash carries a `?c=<id>` suffix, e.g. from a mention
  // alert deep link (`#/ZEC/5/3?c=12`). Undefined when absent or non-numeric.
  commentId?: number;
}

// Strip only the `c=<id>` query param from a hash, preserving any other params
// and repairing the `?`/`&` separator — so `#/X/1/2?c=1&y=2` becomes
// `#/X/1/2?y=2` rather than leaving a dangling `&y=2`.
export function stripCommentParam(hash: string): string {
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return hash;
  const base = hash.slice(0, qIdx);
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  params.delete("c");
  const rest = params.toString();
  return rest ? `${base}?${rest}` : base;
}

export function parseHashString(hash: string, defaultBook: string): Location {
  const m = hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?/);
  const cm = hash.match(/[?&]c=(\d+)/);
  const commentId = cm ? parseInt(cm[1], 10) : undefined;
  if (!m) return { book: defaultBook, chapter: 1, verse: 1, commentId };
  return {
    book: m[1].toUpperCase(),
    chapter: m[2] ? parseInt(m[2], 10) : 1,
    verse: m[3] ? parseInt(m[3], 10) : 1,
    commentId,
  };
}

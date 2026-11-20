// glOccurrence for TWL suggestions (api/src/twlSuggest.ts). Kept out of the
// route file because that one imports hono, which a plain-node unit test cannot
// load.

/**
 * The glOccurrence of each match, in document order: the 1-based index of each
 * exact (case-insensitive) span among its occurrences in the verse.
 */
export function glOccurrences(_text: string, matches: { matchedText: string }[]): number[] {
  const occCount = new Map<string, number>();
  return matches.map((m) => {
    const key = m.matchedText.toLowerCase();
    const glOccurrence = (occCount.get(key) ?? 0) + 1;
    occCount.set(key, glOccurrence);
    return glOccurrence;
  });
}

// Pure @mention parsing for comments. No DB access here — comments.ts resolves
// extracted tokens against the users table.

// DCS username charset. `@` must not be preceded by a word character so
// `foo@bar.com` doesn't parse "bar.com" as a mention of user "bar.com" (and
// more importantly doesn't false-positive on ordinary email addresses pasted
// into a comment body).
const MENTION_RE = /(?<![\w])@([A-Za-z0-9._-]+)/g;

// Trailing punctuation that's almost always sentence punctuation, not part of
// the username, even though '.' and '-' are otherwise valid mid-token chars.
const TRAILING_PUNCT_RE = /[.,!?:;)]+$/;

/** Extract raw @token strings (without the @) from a comment body, in order of appearance. */
export function extractMentionTokens(body: string): string[] {
  const tokens: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const token = m[1].replace(TRAILING_PUNCT_RE, "");
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Resolve extracted tokens against the known username list, case-insensitively,
 * returning the canonical casing from knownUsernames. Deduped, preserving
 * first-appearance order. Unknown tokens are dropped. selfUsername (if given)
 * is excluded case-insensitively so authors don't alert themselves.
 */
export function resolveMentions(
  body: string,
  knownUsernames: string[],
  selfUsername?: string,
): string[] {
  const byLower = new Map<string, string>();
  for (const u of knownUsernames) {
    if (!byLower.has(u.toLowerCase())) byLower.set(u.toLowerCase(), u);
  }
  const selfLower = selfUsername?.toLowerCase();
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const token of extractMentionTokens(body)) {
    const lower = token.toLowerCase();
    if (selfLower && lower === selfLower) continue;
    const canonical = byLower.get(lower);
    if (!canonical) continue;
    if (seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    resolved.push(canonical);
  }
  return resolved;
}

// Client-side rendering helper: splits a comment body into plain/mention
// segments so the UI can style `@username` runs. Pure, no fetching — the
// caller supplies the known-username list (from GET /api/comments/mention-users).
// Mirrors the mention token charset AND the trailing-punctuation strip used by
// api/src/mentions.ts — these two must stay in sync, or the highlighted set
// drifts from the notified set (e.g. "@bob." would notify Bob server-side but
// render unhighlighted here).

export interface MentionSegment {
  text: string;
  isMention: boolean;
}

const MENTION_RE = /@([A-Za-z0-9._-]+)/g;

// Trailing punctuation that's almost always sentence punctuation, not part of
// the username, even though '.' and '-' are otherwise valid mid-token chars.
// Keep in sync with TRAILING_PUNCT_RE in api/src/mentions.ts.
const TRAILING_PUNCT_RE = /[.,!?:;)]+$/;

export function splitMentions(body: string, known: string[]): MentionSegment[] {
  const knownLower = new Set(known.map((u) => u.toLowerCase()));
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(body)) !== null) {
    const start = match.index;
    // Don't match inside an email — the `@` is preceded by a word char.
    const precedingChar = start > 0 ? body[start - 1] : "";
    if (/\w/.test(precedingChar)) continue;

    // Strip sentence punctuation the same way the server does, so "@bob." is
    // highlighted as a mention of "bob" with the period left as plain text.
    const username = match[1].replace(TRAILING_PUNCT_RE, "");
    if (!username) continue;
    if (!knownLower.has(username.toLowerCase())) continue;

    if (start > lastIndex) {
      segments.push({ text: body.slice(lastIndex, start), isMention: false });
    }
    segments.push({ text: `@${username}`, isMention: true });
    lastIndex = start + 1 + username.length;
  }

  if (lastIndex < body.length) {
    segments.push({ text: body.slice(lastIndex), isMention: false });
  }
  return segments;
}

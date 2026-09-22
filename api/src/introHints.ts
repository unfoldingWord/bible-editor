// Chapter-intro hint notes (issue #819): free-text guidance an editor leaves
// on a chapter's intro — via the *existing* internal-comments UI, anchored to
// verse 0 with no row (see comments.ts's CreateBody: rowKind/rowId are both
// optional, and omitting them yields exactly this anchor) — that gets folded
// into the outbound notes-pipeline request alongside the existing per-verse
// TN hints (docs/bp-assistant-tn-hints-contract.md).
//
// Unlike a verse hint there is no id to round-trip: a verse hint expands one
// specific TN stub in place, but the chapter intro isn't generated from a
// single anchor row, so there's nothing for bp-assistant to echo back. These
// are a prompt-context bundle for the intro step, not a row to update — hence
// the plain (chapter, note) shape rather than the richer per-hint object
// `options.hints[]` uses.
//
// Review finding on the original version of this PR: a comment anchored to
// verse 0 is not necessarily AI guidance — it's the same anchor an ordinary
// "looks good" or unrelated editor-to-editor discussion note would use, so
// treating every unresolved one as a hint would leak arbitrary chatter into
// the generation prompt (and, worse, auto-resolve it — see comments.ts's
// history for the resolve mechanism this PR removed for the same reason).
// A comment only becomes a hint when its body opts in with a leading "AI:"
// marker (case-insensitive) — the same in-body-syntax idea this feature's
// own comments already use for @mentions (see mentions.ts).
//
// Kept dependency-free (no Hono/D1 imports) so it's testable under plain
// `node --experimental-strip-types` — see pipelines.ts for the route wiring.

const HINT_MARKER = /^ai:\s*/i;

// Review finding: an unbounded set of marked comments (each up to the
// internal-comment body's 5000-char cap) could push the outbound request
// past bp-assistant's ~32 KiB body limit and 413 the whole job. There's no
// per-run cap on how many intro-hint comments can exist, so bound the total
// forwarded here instead — well under that limit, with room left for the
// rest of the request body (book/chapters/the existing options.hints[]).
// Hints beyond the budget are dropped, not truncated mid-sentence; earliest
// (by chapter, then created_at — the row order buildIntroHints receives)
// wins, so the drop is deterministic.
const MAX_TOTAL_HINT_CHARS = 8000;

export interface IntroHintCommentRow {
  id: number;
  chapter: number;
  body: string;
}

export interface IntroHint {
  chapter: number;
  note: string;
}

// Returns the marker-stripped note text, or null if `body` isn't an
// intro-hint comment at all (no marker, or a marker with nothing after it —
// a bare "AI:" has nothing to forward).
function stripIntroHintMarker(body: string): string | null {
  const trimmed = body.trim();
  if (!HINT_MARKER.test(trimmed)) return null;
  const note = trimmed.replace(HINT_MARKER, "").trim();
  return note || null;
}

export function isIntroHintComment(body: string): boolean {
  return stripIntroHintMarker(body) !== null;
}

export function buildIntroHints(rows: IntroHintCommentRow[]): IntroHint[] {
  const hints: IntroHint[] = [];
  let totalChars = 0;
  for (const r of rows) {
    const note = stripIntroHintMarker(r.body);
    if (note === null) continue;
    if (totalChars + note.length > MAX_TOTAL_HINT_CHARS) break;
    hints.push({ chapter: r.chapter, note });
    totalChars += note.length;
  }
  return hints;
}

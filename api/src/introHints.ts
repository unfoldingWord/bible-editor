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
  for (const r of rows) {
    const note = stripIntroHintMarker(r.body);
    if (note !== null) hints.push({ chapter: r.chapter, note });
  }
  return hints;
}

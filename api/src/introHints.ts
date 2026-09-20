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
// Kept dependency-free (no Hono/D1 imports) so it's testable under plain
// `node --experimental-strip-types` without a fake D1 stub — see
// pipelines.ts for the route wiring and comments.ts's `resolveIntroHintComments`
// for the D1-touching half.

export interface IntroHintCommentRow {
  id: number;
  chapter: number;
  body: string;
}

export interface IntroHint {
  chapter: number;
  note: string;
}

export function buildIntroHints(rows: IntroHintCommentRow[]): IntroHint[] {
  return rows.map((r) => ({ chapter: r.chapter, note: r.body }));
}

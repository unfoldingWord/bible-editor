// Shared types across handlers. Mirrors api/migrations/0001_init.sql.

export type RowKind = "tn" | "tq" | "twl";

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  support_reference: string | null;
  quote: string | null;
  occurrence: number | null;
  note: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /**
   * Visible, restorable soft-delete. Set via /trash (the delete button),
   * cleared via /restore. Distinct from deleted_at: a trashed note stays in
   * the chapter read (grayed, sorted last) until the 06:00 UTC nightly job
   * promotes it to a permanent deleted_at tombstone. NULL means "not trashed".
   */
  trashed_at: number | null;
  /** Explicit "survive future AI pipeline sweeps" bit. Set via /preserve. */
  preserve: 0 | 1;
  /**
   * Editor-authored stub queued for the next chapter-wide AI pipeline run:
   * the proxy gathers these into options.hints, the sweep excludes them,
   * and applyTnHintExpansion updates the row in place when the AI returns.
   */
  hint: 0 | 1;
  /**
   * Workflow-only review flag (NOT exported to DCS — buildTnTsv emits an
   * explicit column list). Set when a note was adapted from a parallel passage
   * and needs a human check: review_kind categorizes it ('quote' | 'xref' |
   * 'sundial' | …) and review_reason is the human-readable detail shown in the
   * "issues to clean up" chip. Cleared on the next TN content save.
   * NULL = no review needed.
   */
  review_kind: string | null;
  review_reason: string | null;
  /**
   * Source label from the row's most recent edit_log entry. 'ai_pipeline'
   * when the last write came from the AI auto-apply step (which means the
   * chip should show); NULL after any subsequent human edit/keep wipes it.
   * Computed at read time — there's no column on tn_rows.
   */
  latest_source?: string | null;
}

export interface TqRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  quote: string | null;
  occurrence: number | null;
  question: string | null;
  response: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /** See TnRow.latest_source. */
  latest_source?: string | null;
}

export interface TwlRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  orig_words: string | null;
  occurrence: number | null;
  tw_link: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export interface VerseRow {
  book: string;
  chapter: number;
  verse: number;
  // Inclusive end of a multi-verse block (e.g. `\v 6-9` → verse=6, verse_end=9).
  // NULL for singleton verses.
  verse_end: number | null;
  bible_version: string;
  content_json: string;
  plain_text: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
}

export interface VerseStatus {
  book: string;
  chapter: number;
  verse: number;
  done: 0 | 1;
  updated_at: number;
}

export interface ChapterPayload {
  book: string;
  chapter: number;
  verses: Record<string, Record<number, VerseDto>>; // verses[ULT][1] = VerseDto
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  verseStatuses: VerseStatus[];
}

export interface VerseDto extends Omit<VerseRow, "content_json"> {
  content: unknown; // parsed usfm-js verse object
}

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
  /** Explicit "survive future AI pipeline sweeps" bit. Set via /preserve. */
  preserve: 0 | 1;
  /**
   * Editor-authored stub queued for the next chapter-wide AI pipeline run:
   * the proxy gathers these into options.hints, the sweep excludes them,
   * and applyTnHintExpansion updates the row in place when the AI returns.
   */
  hint: 0 | 1;
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

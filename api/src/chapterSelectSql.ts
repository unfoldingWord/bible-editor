// Extracted from chapters.ts's chapter GET handler (#906) purely so
// chapters.test.mjs can run the exact SQL text against real SQLite and
// assert the column set stays in sync with the schema — without dragging in
// D1 or the rest of the Hono app. Dependency-free on purpose.

export const TN_CHAPTER_SELECT_SQL = `SELECT t.id, t.book, t.chapter, t.verse, t.ref_raw, t.tags, t.support_reference,
                t.quote, t.occurrence, t.note, t.sort_order, t.version, t.restored_from_version,
                t.updated_by, t.updated_at, t.deleted_at, t.trashed_at, t.preserve, t.hint,
                t.review_kind, t.review_reason, t.last_change_action, t.last_change_source,
                t.last_change_actor, (
           SELECT source FROM edit_log
            WHERE kind = 'tn' AND row_key = t.id
              AND (book = t.book OR book IS NULL)
            ORDER BY id DESC LIMIT 1
         ) AS latest_source
            FROM tn_rows t
           WHERE t.book = ?1 AND t.chapter = ?2 AND t.deleted_at IS NULL
           ORDER BY verse, sort_order ASC NULLS LAST, id`;

export const TQ_CHAPTER_SELECT_SQL = `SELECT t.id, t.book, t.chapter, t.verse, t.ref_raw, t.tags, t.quote, t.occurrence,
                t.question, t.response, t.sort_order, t.version, t.restored_from_version,
                t.updated_by, t.updated_at, t.deleted_at, t.review_kind, t.review_reason,
                t.last_change_action, t.last_change_source, t.last_change_actor, (
           SELECT source FROM edit_log
            WHERE kind = 'tq' AND row_key = t.id
              AND (book = t.book OR book IS NULL)
            ORDER BY id DESC LIMIT 1
         ) AS latest_source
            FROM tq_rows t
           WHERE t.book = ?1 AND t.chapter = ?2 AND t.deleted_at IS NULL
           ORDER BY verse, sort_order ASC NULLS LAST, id`;

export const TWL_CHAPTER_SELECT_SQL = `SELECT id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link,
                sort_order, version, restored_from_version, updated_by, updated_at, deleted_at,
                review_kind, review_reason, last_change_action, last_change_source, last_change_actor
           FROM twl_rows
          WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL
          ORDER BY verse, sort_order ASC NULLS LAST, id`;

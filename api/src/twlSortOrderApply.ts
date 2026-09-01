// Shared D1 apply for TWL canonical sort_order updates. Used by BOTH the nightly
// export (exportWorkflow.applyTwlSortOrderUpdates) and the reimport canonical
// post-pass (bookReimport). Sets sort_order to the computed value and bumps
// version (for audit) — it does NOT touch content/updated_by and does NOT write
// edit_log (a reorder is transient last-write-wins, not a versioned content
// edit). Idempotent (same updates → same result) and best-effort: a failure is
// logged and swallowed so a sort-order update can never fail the caller.

import { provenanceSet, provenanceValues, type RowProvenance } from "./rowProvenance.ts";

// D1 caps a batch at 100 statements and 100 bound params per statement; 90 stays
// safely under both (mirrors bookReimport's WRITE_BATCH — kept local so this leaf
// module has no dependency on bookReimport). A book-level reorder can touch
// hundreds of rows, so chunk into ≤90-statement batches (one subrequest each) —
// a single CASE...WHEN over all rows would blow the 100-param cap, and one batch
// of all rows would blow the 100-statement cap.
const D1_MAX_STATEMENTS = 90;

// Default provenance: this helper has three callers and only one of them is a
// signed-in human (chapters.ts's interactive order-lock dismiss, #686). The
// other two — bookReimport.ts's nightly canonicalizeTwlOrder and
// exportWorkflow.ts's nightly export — are unattended Door43 sync, which is
// what this default states. Given as a default (not required) so those two
// existing call sites compile and behave unchanged without passing anything;
// chapters.ts must pass `{ action: 'sync_reorder', source: 'user', actor }`
// explicitly for its human-initiated dismiss.
const DEFAULT_PROVENANCE: RowProvenance = {
  action: "sync_reorder",
  source: "dcs_sync",
  actor: "Door43 sync",
};

export async function applyTwlSortOrderUpdates(
  db: D1Database,
  book: string,
  updates: Array<{ id: string; sort_order: number }>,
  provenance: RowProvenance = DEFAULT_PROVENANCE,
): Promise<void> {
  if (updates.length === 0) return;
  // One UPDATE per row (3 bound values each, now +3 for provenance), chunked
  // into batches. Scoped to (book, id): the 4-char ids are unique per book, NOT
  // globally (migration 0015), so the filter MUST include book or it would
  // clobber a same-id row in another book.
  const stmt = db.prepare(
    `UPDATE twl_rows SET sort_order = ?1, version = version + 1, ${provenanceSet(4)} WHERE book = ?2 AND id = ?3`,
  );
  const provenanceParams = provenanceValues(provenance);
  try {
    for (let i = 0; i < updates.length; i += D1_MAX_STATEMENTS) {
      const slice = updates.slice(i, i + D1_MAX_STATEMENTS);
      await db.batch(slice.map((u) => stmt.bind(u.sort_order, book, u.id, ...provenanceParams)));
    }
  } catch (e) {
    console.error("applyTwlSortOrderUpdates failed", { book, updateCount: updates.length, error: e });
    // Non-fatal: a sort order update failure doesn't block the caller (export or
    // reimport). The TSV is already rendered in the correct order; future
    // operations just won't have the updated sort_order in D1.
  }
}

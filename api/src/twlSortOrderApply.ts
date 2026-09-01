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

export async function applyTwlSortOrderUpdates(
  db: D1Database,
  book: string,
  updates: Array<{ id: string; sort_order: number }>,
  // REQUIRED, with no default, and that is the point (#686 review F2). This
  // helper's three callers are three DIFFERENT answers to "who reordered these
  // rows", and they are not interchangeable:
  //   bookReimport.ts  canonicalizeTwlOrder → dcs_sync, master's file order
  //   exportWorkflow.ts nightly export     → system, OUR OWN computed order
  //   chapters.ts      order-lock dismiss  → user, a translator's click
  // The first cut gave this parameter a dcs_sync default so the two nightly
  // call sites compiled untouched — and that default immediately did the exact
  // harm this issue exists to remove: the EXPORT's locally-computed canonical
  // reorder stamped "Door43 sync", telling translators Door43 had changed rows
  // that Bible Editor changed. A default here cannot be safe, because the wrong
  // answer is silent and looks plausible. Making it required means a new caller
  // must state who it is or fail to compile.
  provenance: RowProvenance,
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

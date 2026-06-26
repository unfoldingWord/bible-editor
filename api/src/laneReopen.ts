import type { CheckLane } from "./types";

// "Edits reopen the checkoff": when a verse's underlying content advances, the
// affected lane's sign-off (verse_lane_checks) should reopen so checkers re-see
// it. This is a best-effort helper — fire it via waitUntil AFTER the write has
// already succeeded, never on the request's critical path. It must NEVER throw
// into the save response, so it swallows its own errors as a second layer of
// defense behind the caller's try/catch. Only call it when the write actually
// changed something.
//
// One DELETE clears every checker's row for the given (verse, lane[s]) — the
// PK is (book, chapter, verse, lane, checked_by), so removing by
// (book, chapter, verse, lane) reopens the lane for all checkers at once.
export async function reopenLaneChecks(
  db: D1Database,
  book: string,
  chapter: number,
  verse: number,
  lanes: CheckLane[],
): Promise<void> {
  if (lanes.length === 0) return;
  try {
    const placeholders = lanes.map((_l, i) => `?${i + 4}`).join(", ");
    await db
      .prepare(
        `DELETE FROM verse_lane_checks
          WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND lane IN (${placeholders})`,
      )
      .bind(book, chapter, verse, ...lanes)
      .run();
  } catch {
    // Best-effort: a failure here must never surface to the caller. The
    // checkoff simply stays as-is; a later edit reopens it.
  }
}

import type { Env } from "./index";
import type { CheckLane } from "./types";
import { broadcastChapter } from "./wsEvents";

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
//
// CRITICAL: it also broadcasts `lane_check.updated` with an EMPTY checker set
// for each cleared lane. Unlike an explicit toggle (which broadcasts from the
// route handler), the reopen is a side effect of a content save, so without
// this the editing tab — and every other open tab — would keep showing the
// now-stale check (and, for 'tw', keep TWL suggestions paused) until a reload.
// The empty-set event drives the same client reconcile path as a toggle.
export async function reopenLaneChecks(
  env: Env,
  book: string,
  chapter: number,
  verse: number,
  lanes: CheckLane[],
): Promise<void> {
  if (lanes.length === 0) return;
  try {
    const placeholders = lanes.map((_l, i) => `?${i + 4}`).join(", ");
    const res = await env.DB
      .prepare(
        `DELETE FROM verse_lane_checks
          WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND lane IN (${placeholders})`,
      )
      .bind(book, chapter, verse, ...lanes)
      .run();
    // Nothing was checked here → nothing reopened → no need to notify anyone.
    if (!res.meta.changes) return;
    for (const lane of lanes) {
      await broadcastChapter(env, book, chapter, {
        type: "lane_check.updated",
        check: { book, chapter, verse, lane, checkers: [] },
      });
    }
  } catch {
    // Best-effort: a failure here must never surface to the caller. The
    // checkoff simply stays as-is; a later edit reopens it.
  }
}

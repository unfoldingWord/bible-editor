import type { Env } from "./index";
import type { CheckLane } from "./types";
import { broadcastChapter } from "./wsEvents.ts";

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
// Which lanes a verse content-save reopens. A content edit always reopens the
// 'text' lane (the verse text changed, so the text sign-off is stale). A ULT
// edit ALSO reopens 'tw' (Words/TWL) — but only when a `\w` word actually
// changed. TWL sign-off tracks the aligned words, so a punctuation-only edit (a
// comma, a moved `{…}` implied-word brace, whitespace) leaves every word in
// place and must NOT clear the Words checkoff. `wordSequenceUnchanged` from
// analyzeAlignmentDelta is exactly "no `\w` text added/removed/changed", so it
// is the right gate: a comma keeps Words checked; a genuine word edit trickles
// down and reopens it. UST edits never touch 'tw'.
export function lanesToReopenOnVerseEdit(
  bibleVersion: string,
  wordSequenceUnchanged: boolean,
): CheckLane[] {
  if (bibleVersion === "ULT" && !wordSequenceUnchanged) return ["text", "tw"];
  return ["text"];
}

// FIX C: bound on how many verses in ONE reopenLaneChecks bulk run may fire
// their broadcastChapter Durable-Object fetch. reopenLaneChecks itself issues
// one DELETE + up to one DO fetch PER LANE per verse (a ULT adoption that
// changed a word reopens two lanes: "text" and "tw"), and nothing upstream
// caps how many adoptions land in one bookReimport.ts run — Cloudflare's
// ~1000-subrequest cap has bitten this codebase twice already (see
// STATE.md's nightly-sync-subrequest-cap lesson). Past this many landed
// adoptions in one call, the DELETE (which reopens the checkoff — the
// correctness-bearing half) still runs for every verse, but the broadcast
// (the live-tab notification — best-effort, a stale checkoff self-heals on
// the next page load) is skipped for the excess and the drop is logged
// rather than silently truncated.
export const LANE_REOPEN_BROADCAST_CAP = 200;

export async function reopenLaneChecks(
  env: Env,
  book: string,
  chapter: number,
  verse: number,
  lanes: CheckLane[],
  // Whether to fire the per-lane broadcastChapter Durable-Object fetch after
  // the DELETE lands. Defaults true (every existing call site is a single
  // request-scoped save, where the live-tab notification matters). A bulk
  // caller processing hundreds of verses in one run (bookReimport.ts's
  // master-adoption reopen) passes false past its own subrequest cap — see
  // LANE_REOPEN_BROADCAST_CAP — so the DELETE (the correctness-bearing half:
  // the checkoff itself reopens) still runs for every verse, and only the
  // best-effort live-notification half is dropped for the excess.
  broadcast: boolean = true,
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
    if (!res.meta.changes || !broadcast) return;
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

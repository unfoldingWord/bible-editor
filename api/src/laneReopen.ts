import type { Env } from "./index";
import type { CheckLane } from "./types";
import { broadcastChapter } from "./wsEvents.ts";
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";
import { collapseWhitespaceForCompare } from "./verseMerge.ts";

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

// FIX 4: which lanes a master-adoption (bookReimport.ts's applyVerseRows)
// should reopen, given the verse's content before/after. Pure — testable
// without a D1/Workflow context, same convention as
// lanesToReopenOnVerseEdit itself. Extracted so the decision isn't
// duplicated inline in applyVerseRows.
//
// This used to be a single early return: if plain text was unchanged
// (collapseWhitespaceForCompare — Task 3's guard against reopening 'text'
// for a spurious "adopt" that never touched the verse's actual text), the
// function returned BEFORE `lanesToReopenOnVerseEdit` was even called — so
// it dropped the 'tw' (Words) lane too. That's wrong whenever the adopted
// content's `\w` TOKENIZATION changed while its plain text did not — e.g.
// D1 `[w("and"), text " ", w("the")]` vs master `[w("and the")]`: identical
// plain text ("and the"), but `wordSequenceUnchanged: false` (2 `\w` nodes
// vs 1), so `lanesToReopenOnVerseEdit("ULT", false)` returns `["text",
// "tw"]` and Words SHOULD reopen. The old guard fired first and reopened
// neither, leaving a Words checkoff signed off against a changed
// aligned-word set. Fix: compute wordSequenceUnchanged and the candidate
// lanes UNCONDITIONALLY, then drop only the 'text' lane when plain text
// didn't change — 'tw' stays gated purely on wordSequenceUnchanged, as
// lanesToReopenOnVerseEdit intends. Note: plain_text is already
// whitespace-collapsed at extraction time (importParsers.ts's
// collectPlainText, ~line 980), so collapseWhitespaceForCompare here is
// defensive only, not the primary equality check.
export function lanesForAdoption(
  bibleVersion: string,
  beforePlainText: string | null,
  afterPlainText: string | null,
  beforeContentJson: string,
  afterContentJson: string,
): CheckLane[] {
  let wordSequenceUnchanged = false;
  try {
    const delta = analyzeAlignmentDelta(JSON.parse(beforeContentJson), JSON.parse(afterContentJson));
    wordSequenceUnchanged = delta.wordSequenceUnchanged;
  } catch {
    // unparseable either side — fail toward "changed" (reopen), never
    // toward a stale check.
  }
  let lanes = lanesToReopenOnVerseEdit(bibleVersion, wordSequenceUnchanged);
  const beforeText = collapseWhitespaceForCompare(beforePlainText);
  const afterText = collapseWhitespaceForCompare(afterPlainText);
  if (beforeText === afterText) lanes = lanes.filter((l) => l !== "text");
  return lanes;
}

// FIX 3 CORRECTION: this used to claim it bounds "ONE reopenLaneChecks bulk
// run" against the ~1000-subrequest cap. That was never actually reachable:
// every caller of the bulk path (bookReimport.ts's applyVerseRows) passes
// exactly ONE chapter's verses, and the largest chapter in the canon (Psalm
// 119) is 176 verses — under this cap of 200 even with two lanes each. The
// real per-Workflow-step exposure is REIMPORT_CHAPTER_CHUNK (8 chapters) x 2
// verse resources = up to 16 applyVerseRows calls per nightly step, each
// able to broadcast for every landed adoption in its chapter. bookReimport.ts
// closes that two ways: (1) reopenLaneChecksBulk below batches the DELETEs
// via env.DB.batch (one subrequest per WRITE_BATCH-sized slice, not one per
// verse — the correctness-bearing half, so the checkoff reopens regardless
// of the broadcast decision), and (2) the nightly chunked path
// (reimportStagedChunk) passes `broadcast: false` to skip the Durable-Object
// notifications entirely — WS messages are hints (CLAUDE.md), and nobody has
// a tab open at 05:30 UTC for the nightly path, so a dropped broadcast there
// is free. The user-triggered path (runReimport / reimportVersesForChapter)
// still passes `broadcast: true`, where this cap remains a defensive ceiling
// per applyVerseRows call (i.e. per chapter) — in practice unreachable today
// given the 176-verse maximum, but retained in case a future caller ever
// batches more than one chapter into a single call.
export const LANE_REOPEN_BROADCAST_CAP = 200;

export async function reopenLaneChecks(
  env: Env,
  book: string,
  chapter: number,
  verse: number,
  lanes: CheckLane[],
  // Whether to fire the per-lane broadcastChapter Durable-Object fetch after
  // the DELETE lands. Defaults true — every call site of THIS single-verse
  // function is a request-scoped save, where the live-tab notification
  // matters. A caller reopening many verses in one run (bookReimport.ts's
  // master-adoption reopen) uses reopenLaneChecksBulk below instead, which
  // batches the DELETEs and applies LANE_REOPEN_BROADCAST_CAP itself.
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

// D1 caps a batch at 100 statements / 100 params each; 90 stays safely under
// both — same convention as bookReimport.ts's WRITE_BATCH.
const REOPEN_WRITE_BATCH = 90;

// Bulk variant for a caller reopening lanes for MANY verses from one run
// (bookReimport.ts's applyVerseRows master-adoption reopen). FIX 3: the
// DELETEs are batched via env.DB.batch — one subrequest per
// REOPEN_WRITE_BATCH-sized slice instead of one per verse — so the
// correctness-bearing half (the checkoff actually reopens) always runs at a
// bounded subrequest cost regardless of how many verses land in one call.
// The broadcast half stays best-effort and is controlled by the `broadcast`
// flag (see LANE_REOPEN_BROADCAST_CAP's updated doc for which caller passes
// which value and why) plus the cap, applied across this WHOLE call — once
// LANE_REOPEN_BROADCAST_CAP broadcasts have fired, the rest are dropped and
// counted, never silently truncated.
export async function reopenLaneChecksBulk(
  env: Env,
  book: string,
  entries: Array<{ chapter: number; verse: number; lanes: CheckLane[] }>,
  broadcast: boolean,
): Promise<void> {
  const withLanes = entries.filter((e) => e.lanes.length > 0);
  if (withLanes.length === 0) return;
  let broadcastCount = 0;
  let droppedBroadcasts = 0;
  for (let i = 0; i < withLanes.length; i += REOPEN_WRITE_BATCH) {
    const slice = withLanes.slice(i, i + REOPEN_WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((e) => {
          const placeholders = e.lanes.map((_l, j) => `?${j + 4}`).join(", ");
          return env.DB.prepare(
            `DELETE FROM verse_lane_checks
              WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND lane IN (${placeholders})`,
          ).bind(book, e.chapter, e.verse, ...e.lanes);
        }),
      );
      if (!broadcast) continue;
      for (let j = 0; j < slice.length; j++) {
        // Nothing was checked for this verse → nothing reopened → no need to
        // notify anyone (mirrors reopenLaneChecks's single-verse guard).
        if (!results[j]?.meta.changes) continue;
        const e = slice[j];
        for (const lane of e.lanes) {
          if (broadcastCount >= LANE_REOPEN_BROADCAST_CAP) {
            droppedBroadcasts++;
            continue;
          }
          broadcastCount++;
          try {
            await broadcastChapter(env, book, e.chapter, {
              type: "lane_check.updated",
              check: { book, chapter: e.chapter, verse: e.verse, lane, checkers: [] },
            });
          } catch {
            // Best-effort: a single dropped broadcast must never fail the batch.
          }
        }
      }
    } catch {
      // Best-effort: a batch failure here just leaves those checkoffs as-is;
      // a later edit reopens them.
    }
  }
  if (droppedBroadcasts > 0) {
    console.error("reopenLaneChecksBulk: broadcast dropped past cap", {
      book,
      dropped: droppedBroadcasts,
      cap: LANE_REOPEN_BROADCAST_CAP,
    });
  }
}

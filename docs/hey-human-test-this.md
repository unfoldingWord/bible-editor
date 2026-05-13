# Hey Human, Test This

Living checklist of things that need eyes-on verification — UI behaviors, live pipeline runs, anything an autonomous session can compile + reason about but can't actually exercise. Check items as you verify them; add notes under an item if something looks off and the next session will pick it up.

## How to use this doc

- **Open items** sit in "Pending verification." Check the box once you've confirmed the behavior.
- **Failures** go under their item as a sub-bullet — what you saw vs what was expected. The next session triages.
- **Done items** can be moved to "Verified" with the date + PR reference, or just left checked. Either is fine.
- **New items**: when you ship a PR that changes user-facing behavior or anything that needs a live pipeline run, add a checklist entry here as part of the PR.

---

## Pending verification

### Phase 2d — PR #14 (asymmetric alignment, AI chip, stage bar, cron polling)

The four items below shipped on 2026-05-13. Type-checks pass and the logic was reasoned through, but none of them have been exercised against a live `uw-bt-bot.fly.dev` run yet. The first live verification is the highest-risk path.

#### Asymmetric ULT/UST alignment

- [ ] **Dialog warning shows when alignment is asymmetric.** Open AI pipelines → Generate ULT + UST. Tick ULT + ULT-alignment + UST (leave UST-alignment unticked). The italic line "Asymmetric alignment: runs as two pipelines back-to-back (ULT first)." appears below the checkboxes. Untick UST-alignment + tick ULT-alignment for the mirror case — same warning shows.
- [ ] **Asymmetric start creates two `pipeline_jobs` rows in sequence.** With the dialog warning visible, click Start. Run this query immediately:
  ```sh
  wrangler d1 execute bible_editor --local --command \
    "SELECT job_id, pipeline_type, session_key, state, follow_up_options IS NOT NULL AS has_followup, follow_up_job_id FROM pipeline_jobs ORDER BY created_at DESC LIMIT 4"
  ```
  Expect: one row, `state='running'`, `has_followup=1`, `follow_up_job_id=NULL`, `session_key` matches the browser's `bible-editor.pipeline.sessionKey`.
- [ ] **Follow-up fires on the parent's `done` transition.** After the parent reports `state='done'` (status panel pill turns green), re-run the same query. Expect: TWO rows now. Parent's `follow_up_job_id` matches the second row's `job_id`. Second row's `session_key` ends in `/followup`. Parent's `follow_up_options` should still be set (we don't clear it; the `follow_up_job_id` is the idempotency guard).
- [ ] **Chapter lock re-engages for the follow-up.** While the follow-up is running, the chapter banner shows again ("AI generate run in progress…") and TN cards are read-only. (~5-10s gap between parent-done and follow-up-running is expected; the chapter is briefly unlocked.)
- [ ] **Both content types land correctly.** When the follow-up completes, ULT verses should be ALIGNED (zaln markers visible in `content_json`) and UST verses should be PLAIN (no zaln). Verify with:
  ```sh
  wrangler d1 execute bible_editor --local --command \
    "SELECT bible_version, SUBSTR(content_json, 1, 200) FROM verses WHERE book='ZEC' AND chapter=<N> AND verse=1"
  ```

#### AI provenance chip

- [ ] **Chip shows after a pipeline run.** Trigger any `tqs` or `notes` run on an untouched chapter. After completion, navigate to a TN or TQ that the AI wrote. Notes should carry a small outlined "AI" chip next to the 4-char id. Questions should show a sparkle icon next to the Ref input.
- [ ] **Chip clears after a human edit.** Edit a TN's quote or note field; save (blur or navigate away). Reload the chapter. The chip is gone on that row.
- [ ] **Chip persists across reloads when no human edit happened.** Reload the page without editing. Chip is still there on all AI-authored rows.
- [ ] **Chip clears after a Keep action.** During the run (locked chapter), click Keep on a TN. After the run completes and you reload, the chip should NOT show on that row — Keep counts as a human action.
- [ ] **No chip on rows that pre-date the AI run.** TNs the user created manually before the AI run shouldn't carry the chip (they're absent from the AI's new TN set; the delete sweep removes them only if `updated_by IS NULL`).

#### Per-stage progress bar

- [ ] **Generate run shows the 3-stage stepper.** Trigger a `generate` run. Open the PipelineStatusBar's expanded panel (click the pill). Three dots labeled Draft / Align / Push appear under the job. Early in the run, Draft is filled blue (current); Align + Push are outlined.
- [ ] **Stepper advances as the run progresses.** Mid-run (~30 min in), Draft should be filled green and Align should be filled blue. Late, Align green + Push blue. (You may need to wait between checks.)
- [ ] **Done state fills everything green.** When the run completes, all three dots are green.
- [ ] **Notes run shows tn-writer / parallel-batch / repo-insert.** Trigger a `notes` run; the panel shows Draft → Batch → Push.
- [ ] **Tqs run shows the 2-stage version.** Trigger a `tqs` run; the panel shows Draft → Push.
- [ ] **Unrecognized skill falls back gracefully.** If the bot reports a `current.skill` that isn't in our STAGES list, the stage bar stays dim (no dot highlighted) and the textual status line includes the raw skill name. (Hard to force on purpose — note any natural occurrence.)

#### Worker-side cron polling

- [ ] **Closed-tab `done` transition auto-applies within 5 minutes.** Trigger a `tqs` run. Once the bot starts (state=`running`), close the browser. Wait until you'd expect the bot to be done (poll bp-assistant directly or check Cloudflare logs). After completion, wait ~5 minutes more, then open the editor again. The chapter should already have the AI's TQs applied + edit_log rows with `source='ai_pipeline'`. **This is the highest-value verification — the whole point of Phase 2d.**
- [ ] **Cron tail shows the poller running.** With `wrangler tail` connected, watch for scheduled-handler invocations every 5 minutes. They should print quickly when no non-terminal jobs exist; spend longer when polling each non-terminal job.
- [ ] **Cron skips when there's nothing to poll.** With no running pipelines, the scheduled handler should return in <1s. Confirm via `wrangler tail` that we don't see upstream-fetch errors when the table is empty.

### Phase 2c — PR #12 (lock + auto-apply + TN keep marks)

Originally shipped 2026-05-13; sanity-check that PR #14's refactor of `pollPipelineJob` didn't regress anything.

- [ ] **Chapter lock still 409s row edits.** During any pipeline run, attempt `curl -X PATCH ...` against a TN's note field. Response is `{"error":"chapter_locked", "jobId":"...", ...}` with status 409.
- [ ] **Keep checkbox still works.** During the run, on an unkept TN card, click Keep. Card flips to editable, "Kept" chip appears, no error in the console.
- [ ] **Auto-apply runs once per `done` transition.** After a completed run, check `SELECT count(*), source FROM edit_log WHERE row_key LIKE 'ZEC/<N>%' GROUP BY source` — only one batch of `source='ai_pipeline'` rows, not duplicates.

---

## Verified

_Move items here once they've been confirmed end-to-end. Date + PR ref helps the next person._

- ✅ **Phase 1 — pipeline trigger + poll + status surface** (2026-05-?? · #11). Verified live with a `tqs` run for ZEC 3 against `uw-bt-bot.fly.dev`. Output landed on Door43; editor polling surfaced state transitions correctly.
- ✅ **Phase 2a — parser smoke** (2026-05-?? · #11 follow-up). Parser test against `docs/samples/` produces 10 ULT verses, 49 TN rows, 9 TQ rows for ZEC 3. Run via `node --experimental-strip-types --no-warnings api/src/importParsers.test.mjs`.

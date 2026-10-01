// Change key for pipelineStore.notify() (#897). The store re-lists every
// 120 s; without a dedupe each tick hands subscribers a fresh array and Shell
// re-renders even when nothing changed.
//
// The key covers every field of every job, plus the queue summary that
// PipelineStatusBar reads through getQueueSummary() on render. An earlier
// attempt (PR #953) keyed only on (job_id, state, updated_at) and dropped
// locks_resources: start() seeds a row with no locks_resources, the list
// refresh that follows often carries the same updated_at second, and the AI
// run's chapter lock then did not reach Shell until some other field changed.
// Keying on the whole row covers any field added later without anyone having
// to remember this function.
//
// The one field left out is last_polled_at: rowFromStatus() sets it to "now"
// on every per-job poll, so including it would defeat the dedupe for every
// active job, and no component reads it.

export function pipelineNotifyKey(jobs: readonly object[], queueSummary: unknown): string {
  return JSON.stringify({
    jobs: jobs.map((j) => ({ ...j, last_polled_at: undefined })),
    queueSummary: queueSummary ?? null,
  });
}

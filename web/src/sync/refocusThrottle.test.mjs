// Tests for the refocus throttle and the pipeline notify key (#897). Run from
// repo root:
//   node --experimental-strip-types --no-warnings web/src/sync/refocusThrottle.test.mjs

import { createRefocusThrottle } from "./refocusThrottle.ts";
import { pipelineNotifyKey } from "./pipelineNotifyKey.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log("refocusThrottle");
{
  const t = createRefocusThrottle(60_000);
  assert(t.shouldRun(1_000), "runs before any fetch has succeeded");
  t.markSuccess(1_000);
  assert(!t.shouldRun(1_001), "skips right after a successful fetch");
  assert(!t.shouldRun(60_999), "skips until the window has passed");
  assert(t.shouldRun(61_000), "runs once the window has passed");
}
{
  // A failed fetch never calls markSuccess, so the very next refocus retries.
  const t = createRefocusThrottle(60_000);
  assert(t.shouldRun(5_000), "first refocus runs");
  // (fetch fails: no markSuccess)
  assert(t.shouldRun(5_500), "a failed fetch does not block the next refocus");
}
{
  // Five alt-tabs within a minute collapse to one request.
  const t = createRefocusThrottle(60_000);
  let fetches = 0;
  for (const now of [0, 10_000, 20_000, 35_000, 50_000]) {
    if (t.shouldRun(now)) {
      fetches++;
      t.markSuccess(now);
    }
  }
  assert(fetches === 1, `5 refocuses in a minute give 1 fetch (got ${fetches})`);
}

console.log("pipelineNotifyKey");
const base = {
  job_id: "j1",
  upstream_job_id: null,
  user_id: 7,
  pipeline_type: "generate",
  book: "ZEC",
  start_chapter: 1,
  end_chapter: 1,
  session_key: "s",
  state: "running",
  priority: 0,
  current_skill: null,
  current_status: null,
  error_kind: null,
  error_message: null,
  output_json: null,
  follow_up_job_id: null,
  updated_at: 1_790_000_000,
  created_at: 1_790_000_000,
  last_polled_at: null,
  notified_user_at: null,
};
{
  assert(
    pipelineNotifyKey([], null) === pipelineNotifyKey([], null),
    "an idle tick with zero jobs keeps the same key",
  );
  assert(
    pipelineNotifyKey([base], null) === pipelineNotifyKey([{ ...base }], null),
    "an unchanged job keeps the same key",
  );
  assert(
    pipelineNotifyKey([base], null) ===
      pipelineNotifyKey([{ ...base, last_polled_at: 1_790_000_100 }], null),
    "a last_polled_at bump alone keeps the same key",
  );
}
{
  // PR #953's review finding: start() seeds a row without locks_resources and
  // the list refresh that adds them lands in the same updated_at second.
  const seeded = pipelineNotifyKey([base], null);
  const listed = pipelineNotifyKey([{ ...base, locks_resources: ["verse", "tn"] }], null);
  assert(seeded !== listed, "adding locks_resources at the same updated_at changes the key");
}
{
  const cases = [
    ["queue_position", { queue_position: 2 }],
    ["queue_ahead", { queue_ahead: 1 }],
    ["current_skill", { current_skill: "notes" }],
    ["current_status", { current_status: "drafting" }],
    ["error_message", { error_message: "boom" }],
    ["follow_up_job_id", { follow_up_job_id: "j2" }],
    ["output_json", { output_json: "[]" }],
    ["notified_user_at", { notified_user_at: 1_790_000_050 }],
  ];
  for (const [field, patch] of cases) {
    assert(
      pipelineNotifyKey([base], null) !== pipelineNotifyKey([{ ...base, ...patch }], null),
      `a ${field} change at the same updated_at changes the key`,
    );
  }
}
{
  const q1 = { activeJob: null, queuedCount: 0 };
  const q2 = { activeJob: null, queuedCount: 1 };
  assert(
    pipelineNotifyKey([], q1) !== pipelineNotifyKey([], q2),
    "a queue summary change alone changes the key (PipelineStatusBar reads it on render)",
  );
}

console.log("all refocusThrottle / pipelineNotifyKey tests passed");

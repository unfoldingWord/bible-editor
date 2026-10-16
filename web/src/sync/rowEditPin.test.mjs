// Tests for web/src/sync/rowEditPin.ts (#1115): a tq/twl row keeps a refused
// or unsaved edit pinned to the server version it was typed against.

import assert from "node:assert/strict";
import { rebaseRowPin, rowPinDiff, rowPinBaseline, rowSaveInFlight } from "./rowEditPin.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const keys = ["question", "response"];
const pinOf = (version, question, response) => ({
  version,
  shown: { question, response },
  raw: { question, response },
});
const v1 = pinOf(1, "q1", "r1");

// Rebase rules.
check(
  rebaseRowPin({ pin: v1, row: pinOf(1, "typed", "r1"), local: { question: "typed", response: "r1" }, submitted: null, keys }) === null,
  "same version (an optimistic cache echo) never moves the pin",
);
{
  const r = rebaseRowPin({ pin: v1, row: pinOf(2, "q2", "r1"), local: { question: "q1", response: "r1" }, submitted: null, keys });
  check(r && r.pin.version === 2 && r.local.question === "q2", "an untouched row follows the server");
}
{
  const r = rebaseRowPin({ pin: v1, row: pinOf(2, "q2", "r1"), local: { question: "q1", response: "mine" }, submitted: null, keys });
  check(
    r && r.pin.version === 2 && r.local.question === "q2" && r.local.response === "mine",
    "another user's change to a different field: re-pin, keep the typing, show their field",
  );
}
check(
  rebaseRowPin({ pin: v1, row: pinOf(2, "theirs", "r1"), local: { question: "mine", response: "r1" }, submitted: null, keys }) === null,
  "another user's change to the SAME field keeps the old pin (Save goes to the conflict path)",
);
check(
  rebaseRowPin({ pin: v1, row: pinOf(5, "theirs", "r1"), local: { question: "draft", response: "r1" }, submitted: null, keys }) === null,
  "a kept draft hydrated over a newer row that changed its field stays pinned (no silent overwrite after remount)",
);
{
  const r = rebaseRowPin({
    pin: v1, row: pinOf(2, "mine", "r1"), local: { question: "mine", response: "r1" },
    submitted: { version: 1, shown: { question: "mine" } }, keys,
  });
  check(r && r.pin.version === 2, "own save landed: re-pin");
}
{
  const r = rebaseRowPin({
    pin: v1, row: pinOf(2, "mine", "r1"), local: { question: "mine more", response: "r1" },
    submitted: { version: 1, shown: { question: "mine" } }, keys,
  });
  check(
    r && r.pin.version === 2 && r.local.question === "mine more",
    "own save landed while more typing followed: re-pin, keep the newer typing",
  );
}
check(
  rebaseRowPin({
    pin: v1, row: pinOf(2, "mine", "r1"), local: { question: "mine more", response: "r1" },
    submitted: { version: 0, shown: { question: "mine" } }, keys,
  }) === null,
  "a submission against an older pin does not count as ours",
);

// Diff and baseline.
{
  const pin = { version: 3, shown: { question: "", response: "r" }, raw: { question: null, response: "r" } };
  const d = rowPinDiff(pin, { question: "x", response: "r" }, keys);
  check(d.question === "x" && !("response" in d), "diff is against the pin, not the cache");
  check(rowPinBaseline(pin, d).question === null, "baseline carries the raw server value");
}

// In-flight gate.
{
  const sub = { version: 1, shown: { question: "mine" } };
  const local = { question: "mine", response: "r1" };
  const optimistic = pinOf(1, "mine", "r1");
  check(rowSaveInFlight({ pin: v1, row: optimistic, local, submitted: sub, keys }), "the optimistic cache at the pinned version means the save is in flight");
  check(!rowSaveInFlight({ pin: v1, row: v1, local, submitted: sub, keys }), "a refusal rollback (cache back to server text) reopens Save");
  check(!rowSaveInFlight({ pin: v1, row: optimistic, local, submitted: null, keys }), "no submission from this mount: Save stays available (retry after remount)");
  check(
    !rowSaveInFlight({ pin: v1, row: pinOf(1, "mine", "r1"), local: { question: "mine2", response: "r1" }, submitted: sub, keys }),
    "new typing after the click is a new edit",
  );
}

console.log(`rowEditPin: ${passed} passed`);

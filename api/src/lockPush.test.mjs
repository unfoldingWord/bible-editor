// Issue #1406: lock & push lets the admin choose which resources go to Door43.
// The route used to create an export for every resource no matter what; it now
// creates one for exactly the resources asked for, each once. That dispatch is
// a pure helper so it can be checked here against a fake EXPORT_WORKFLOW,
// without a route harness or a real export ever running.
//
//   node --experimental-strip-types --no-warnings src/lockPush.test.mjs
import { dispatchLockPush, lockPushAuditReason } from "./lockPush.ts";
import { LockPushBody } from "./exportRequestBodies.ts";

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

// Records every create() call; `fail` names resources whose create throws.
function fakeWorkflow(fail = []) {
  const calls = [];
  return {
    calls,
    async create({ id, params }) {
      calls.push({ id, params });
      if (fail.includes(params.resource)) throw new Error(`boom ${params.resource}`);
      return { id };
    },
  };
}

const STAMP = "2026-11-17T00-00-00-000Z";

console.log("\n[exactly the chosen resources are dispatched, once each]");
{
  const wf = fakeWorkflow();
  const pushed = await dispatchLockPush(wf, { book: "ZEC", resources: ["tn", "ult"], stamp: STAMP });
  const created = wf.calls.map((c) => c.params.resource);
  assert(created.length === 2, `two creates for two resources (got ${created.length})`);
  assert(created.includes("tn") && created.includes("ult"), `tn and ult created (got ${created.join(",")})`);
  assert(!created.some((r) => ["ust", "tq", "twl"].includes(r)), `unchosen resources not created`);
  assert(pushed.length === 2 && pushed.every((p) => "instanceId" in p), `both reported queued`);
  assert(
    wf.calls.every((c) => c.id === `lock-push-ZEC-${c.params.resource}-${STAMP}`),
    `instance ids keep the lock-push-{book}-{resource}-{stamp} shape`,
  );
  assert(
    wf.calls.every((c) => c.params.allowLocked === true && c.params.validateAndMerge === true && c.params.branchName === undefined),
    `publish-now params unchanged (allowLocked, validateAndMerge, no branch)`,
  );
}

{
  const wf = fakeWorkflow();
  await dispatchLockPush(wf, { book: "ZEC", resources: ["tq", "tq", "tq"], stamp: STAMP });
  assert(wf.calls.length === 1, `a repeated resource is dispatched once (got ${wf.calls.length})`);
}

{
  const wf = fakeWorkflow();
  await dispatchLockPush(wf, {
    book: "PSA",
    resources: ["twl"],
    branchName: "BibleEditor-restoration-PSA",
    stamp: STAMP,
  });
  assert(
    wf.calls.length === 1 &&
      wf.calls[0].params.branchName === "BibleEditor-restoration-PSA" &&
      wf.calls[0].params.validateAndMerge === false,
    `staging intent carries to the one chosen resource`,
  );
}

{
  const wf = fakeWorkflow(["ust"]);
  const pushed = await dispatchLockPush(wf, { book: "ZEC", resources: ["ult", "ust"], stamp: STAMP });
  const ust = pushed.find((p) => p.resource === "ust");
  assert(ust && ust.error === "boom ust", `a failed create is reported, not thrown`);
  assert(pushed.find((p) => p.resource === "ult")?.instanceId, `the other resource still queues`);
}

console.log("\n[the audit reason names the resources]");
assert(
  lockPushAuditReason([{ resource: "tn", instanceId: "a" }, { resource: "ult", instanceId: "b" }]) ===
    "dispatched 2/2 (tn, ult)",
  `publish-now names what was dispatched`,
);
assert(
  lockPushAuditReason(
    [{ resource: "tn", instanceId: "a" }, { resource: "ult", error: "x" }],
    "BibleEditor-restoration-ZEC",
  ) === "dispatched 1/2 (tn; failed: ult) staged on BibleEditor-restoration-ZEC",
  `staging names the dispatched and the failed`,
);
assert(
  lockPushAuditReason([{ resource: "tq", error: "x" }], "BibleEditor-restoration-ZEC") ===
    "dispatched 0/1 (none; failed: tq) (intended to stage on BibleEditor-restoration-ZEC)",
  `nothing dispatched never claims it staged`,
);

console.log("\n[the body accepts a resources list, and only a sane one]");
assert(LockPushBody.safeParse({}).success, `no resources = old clients, still valid`);
const sub = LockPushBody.safeParse({ resources: ["tn", "ult"] });
assert(sub.success && sub.data.resources?.join(",") === "tn,ult", `a subset parses`);
assert(
  LockPushBody.safeParse({ resources: ["ult", "ust", "tn", "tq", "twl"], branchName: "BibleEditor-restoration-ZEC" }).success,
  `all five plus a branch parses`,
);
assert(!LockPushBody.safeParse({ resources: [] }).success, `an empty list is rejected (would push nothing)`);
assert(!LockPushBody.safeParse({ resources: ["tqq"] }).success, `an unknown resource is rejected`);
assert(!LockPushBody.safeParse({ resources: "tn" }).success, `a bare string is rejected`);
assert(!LockPushBody.safeParse({ resource: ["tn"] }).success, `singular "resource" typo is rejected, not ignored`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll lockPush checks passed.");

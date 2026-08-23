// Both locked-book push routes reject unknown keys.
//
// This test exists because the fix it covers is invisible without it: adding
// .strict() changes nothing a typechecker or a happy-path test can see, and the
// failure it prevents is silent by construction. A misspelled `branchName` on a
// non-strict schema parses clean, loses the key, and publishes a locked book to
// master auto-merged — returning 200 to an operator who believed they had staged
// it for review. Removing .strict() must fail here, or the guard is decoration.
//
//   node --experimental-strip-types --no-warnings src/exportRequestBodies.test.mjs
import { LockPushBody, RunExportBody } from "./exportRequestBodies.ts";

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

console.log("\n[unknown keys are rejected, not silently dropped]");
// The realistic typos. Each one, under a non-strict schema, yields a valid parse
// with branchName undefined — i.e. publish-now.
for (const [label, body] of [
  ["snake_case branch_name", { book: "PSA", resource: "tn", allowLocked: true, branch_name: "BibleEditor-restoration-PSA" }],
  ["plural branchNames", { book: "PSA", resource: "tn", allowLocked: true, branchNames: "BibleEditor-restoration-PSA" }],
  ["lowercased branchname", { book: "PSA", resource: "tn", allowLocked: true, branchname: "BibleEditor-restoration-PSA" }],
  ["an entirely unknown key", { book: "PSA", resource: "tn", nonsense: 1 }],
  ["snake_case allow_id_blocked", { book: "PSA", resource: "tq", allow_id_blocked: true }],
]) {
  const parsed = RunExportBody.safeParse(body);
  assert(!parsed.success, `/exports/run rejects ${label}`);
}
for (const [label, body] of [
  ["snake_case branch_name", { branch_name: "BibleEditor-restoration-PSA" }],
  ["plural branchNames", { branchNames: "BibleEditor-restoration-PSA" }],
]) {
  const parsed = LockPushBody.safeParse(body);
  assert(!parsed.success, `/lock/push rejects ${label}`);
}

console.log("\n[legitimate bodies still parse]");
// The shapes the app and the documented curl actually send. If .strict() broke
// any of these it would be worse than the bug it fixes.
const staged = RunExportBody.safeParse({
  book: "PSA",
  resource: "tn",
  allowLocked: true,
  branchName: "BibleEditor-restoration-PSA",
});
assert(staged.success && staged.data.branchName === "BibleEditor-restoration-PSA", `the staging body parses`);

const publishNow = RunExportBody.safeParse({ book: "PSA", resource: "tn", allowLocked: true });
assert(publishNow.success && publishNow.data.branchName === undefined, `the publish-now body parses`);

// Every field the admin UI can send, together — guards against .strict()
// rejecting a combination no single-field test would catch.
const everything = RunExportBody.safeParse({
  book: "MIC",
  resource: "twl",
  dryDcs: true,
  validateAndMerge: false,
  allowShrink: true,
  allowMergeRefusal: true,
  allowIdBlocked: true,
  allowLocked: true,
  branchName: "BibleEditor-restoration-MIC",
});
assert(everything.success, `every known field together parses`);

assert(RunExportBody.safeParse({}).success, `an empty body still means "run everything"`);
assert(LockPushBody.safeParse({}).success, `an empty lock-push body still means publish-now`);

console.log("\n[the branchName bounds hold]");
assert(!RunExportBody.safeParse({ branchName: "" }).success, `empty branchName rejected`);
assert(!RunExportBody.safeParse({ branchName: "x".repeat(81) }).success, `over-long branchName rejected`);
assert(RunExportBody.safeParse({ branchName: "x".repeat(80) }).success, `80 chars is still allowed`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll exportRequestBodies checks passed.");

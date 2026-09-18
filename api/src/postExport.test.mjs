// Unit tests for postExport.ts's DCS response schemas (issue #841).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/postExport.test.mjs
//
// Not a test framework; a failed assert exits non-zero. Mirrors
// publishedGuard.test.mjs's pattern.
//
// ensureSnapshotPr/dispatchValidate/findDispatchedRun aren't exported (they
// need a live-ish env + fetch to drive end to end, and this PR flow is
// documented as dormant — VALIDATORS = []), so these tests exercise the two
// schemas directly: what they accept and what they reject.

import { DcsPullListSchema, DcsCreatedPullSchema } from "./postExport.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- DcsPullListSchema ---
assert(
  DcsPullListSchema.safeParse([
    { number: 12, head: { ref: "live-snapshot" }, base: { ref: "master" } },
  ]).success,
  "a normal pulls list parses",
);
assert(
  DcsPullListSchema.safeParse([{ number: 12 }]).success,
  "head/base are optional — a pull with neither still parses",
);
assert(
  DcsPullListSchema.safeParse([]).success,
  "an empty pulls list parses (no open PRs)",
);
assert(
  !DcsPullListSchema.safeParse([{ head: { ref: "live-snapshot" } }]).success,
  "a pull missing 'number' is rejected — ensureSnapshotPr returns it as the PR identity",
);
assert(
  !DcsPullListSchema.safeParse({ message: "Not Found" }).success,
  "a non-array body (e.g. a DCS error object) is rejected up front, instead of throwing at .find()",
);
assert(
  !DcsPullListSchema.safeParse(null).success,
  "a null body is rejected",
);

// --- DcsCreatedPullSchema ---
assert(
  DcsCreatedPullSchema.safeParse({ number: 34 }).success,
  "a create-PR response with a number parses",
);
assert(
  !DcsCreatedPullSchema.safeParse({}).success,
  "a create-PR response missing 'number' is rejected, rather than returned to the caller as { number: undefined }",
);
assert(
  !DcsCreatedPullSchema.safeParse({ number: "34" }).success,
  "number as a string is rejected",
);

console.log("postExport: all assertions passed");

// Regression coverage for the export-side transient alert lifecycle.
//
// ExportWorkflow cannot be imported by Node's strip-types runner because it
// extends Cloudflare's WorkflowEntrypoint. The observation-CAS behavior itself
// is exercised end-to-end in reviewAlerts.test.mjs; this source-wiring test
// verifies that every transient export gate actually uses that shared raise /
// measured-clean resolve path. This follows the established source-check
// convention in exportLockDryRun.test.mjs and laneReopen.test.mjs.

import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./exportWorkflow.ts", import.meta.url), "utf8");

let failed = 0;
function ok(value, message) {
  if (!value) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  ok: ${message}`);
  }
}

function contains(snippet, message) {
  ok(source.includes(snippet), message);
}

console.log("\n[transient export alerts retire on a newer measured-clean run]");

contains(
  "this.resolveExportAlert(`export_sync_fail:${book}`, alertObservedAt",
  "a normally completed reimport retires the prior exceptional sync-failure condition",
);
contains(
  'if (status === "success")',
  "only a watermark-stamping successful reimport retires the sync-failure warning",
);
contains(
  'fresh.detail === "current" || fresh.detail === "own_publish"',
  "only positively measured Door43 freshness retires export_stale",
);
contains(
  "this.resolveExportAlert(`export_shrink:${book}:${resource}`, alertObservedAt",
  "a clean or authorized TSV shrink measurement retires export_shrink",
);
contains(
  "this.resolveExportAlert(`export_hard_reject:${book}:${resource}`, alertObservedAt",
  "a clean validator measurement retires export_hard_reject",
);
contains(
  "this.resolveExportAlert(`export_usfm_invalid:${book}:${resource}`, alertObservedAt",
  "a clean USFM validation retires export_usfm_invalid",
);
contains(
  "this.resolveExportAlert(`export_align_shrink:${book}:${resource}`, observedAt",
  "a clean alignment comparison retires export_align_shrink",
);
contains(
  "this.resolveExportAlert(`export_pr:${target.repo}:${book}:${resource}`, alertObservedAt",
  "a successful or no-longer-needed PR retires its pair-scoped export_pr warning",
);
contains(
  "`export_conflict:${target.repo}:${book}:${resource}`",
  "a successful branch update retires its pair-scoped export_conflict warning",
);
contains(
  'action: "clear_pr_conflict_without_pr"',
  "a successful no-diff PR ensure also retires the obsolete conflict warning",
);

console.log("\n[transient export alerts use generation-ordered transitions]");

for (const family of ["export_stale", "export_sync_fail", "export_shrink", "export_hard_reject", "export_usfm_invalid", "export_align_shrink", "export_pr", "export_conflict"]) {
  ok(
    new RegExp(`reviewConditionKey\\(\\s*"${family}"`).test(source),
    `${family} raises a stable condition through reconcileReviewAlert`,
  );
}
contains(
  "resolveReviewAlert(\n        this.env,\n        source,\n        Math.floor(observedAt / 1000),\n        EXPORT_ALERT_USERNAME,\n        observedAt",
  "clean transitions carry the workflow observation generation",
);

if (failed) {
  console.error(`\n${failed} export transient-alert assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll export transient-alert assertions passed.");

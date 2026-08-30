// Regression for issue #653: 63 identical "Unmerged Door43 edit - verify" TN
// flags in JER gave a proofreader nothing to act on. groupLintIssues collapses
// a run of (check, message)-identical issues into one group so the popup can
// render them as a single collapsible entry instead of dozens of duplicates.

import assert from "node:assert/strict";
import { groupLintIssues } from "./bookLintGrouping.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

const issue = (overrides = {}) => ({
  check: "Unmerged Door43 edit — verify",
  bucket: "flag",
  ref: "1:1",
  rowId: "r1",
  message: "No ancestor was recoverable to merge this row against Door43 — verify it.",
  resource: "tn",
  ...overrides,
});

console.log("[no issues: no groups]");
{
  const groups = groupLintIssues([]);
  check(groups.length === 0, "empty input produces empty output");
}

console.log("[all-distinct issues: one group per issue, in order]");
{
  const issues = [
    issue({ ref: "1:1", check: "Empty question", message: "a" }),
    issue({ ref: "1:2", check: "Empty response", message: "b" }),
    issue({ ref: "1:3", check: "13. Paired Square Bracket", message: "c" }),
  ];
  const groups = groupLintIssues(issues);
  check(groups.length === 3, `3 distinct issues -> 3 groups (got ${groups.length})`);
  check(groups.every((g) => g.issues.length === 1), "each group holds exactly its one issue");
  check(
    groups.map((g) => g.issues[0].ref).join(",") === "1:1,1:2,1:3",
    "groups preserve first-seen order",
  );
}

console.log("[the #653 shape: many identical (check, message) issues collapse into one group]");
{
  const issues = Array.from({ length: 63 }, (_, i) =>
    issue({ ref: `${1 + Math.floor(i / 10)}:${i % 10}`, rowId: `r${i}`, resource: "tn" }),
  );
  const groups = groupLintIssues(issues);
  check(groups.length === 1, `63 identical issues -> 1 group (got ${groups.length})`);
  check(groups[0].issues.length === 63, "the group holds all 63 issues");
  check(
    groups[0].issues[0].ref === "1:0" && groups[0].issues[62].ref === "7:2",
    "individual issues (and their distinct refs) are preserved inside the group",
  );
}

console.log("[same check, different message: NOT grouped together]");
{
  const issues = [
    issue({ ref: "2:1", check: "Unmerged Door43 edit — verify", message: "custom reason A" }),
    issue({ ref: "2:2", check: "Unmerged Door43 edit — verify", message: "custom reason B" }),
  ];
  const groups = groupLintIssues(issues);
  check(groups.length === 2, "differing message text keeps issues in separate groups");
}

console.log("[same check+message across resources: grouped together, resources preserved]");
{
  const issues = [
    issue({ ref: "3:1", resource: "tn" }),
    issue({ ref: "3:2", resource: "tq" }),
  ];
  const groups = groupLintIssues(issues);
  check(groups.length === 1, "identical check+message groups across resource types");
  check(
    groups[0].issues.map((i) => i.resource).join(",") === "tn,tq",
    "each issue's own resource is preserved for display",
  );
}

console.log("[mixed: duplicates and singletons interleave, order preserved]");
{
  const issues = [
    issue({ ref: "1:1", check: "A", message: "dup" }),
    issue({ ref: "1:2", check: "B", message: "unique" }),
    issue({ ref: "1:3", check: "A", message: "dup" }),
  ];
  const groups = groupLintIssues(issues);
  check(groups.length === 2, "2 groups: one dup pair, one singleton");
  check(groups[0].issues.length === 2, "the 'A'/'dup' group comes first (first-seen) and holds both");
  check(groups[1].issues.length === 1, "the singleton 'B' group holds its one issue");
}

console.log(`\n  bookLintGrouping: ${passed} assertions passed`);

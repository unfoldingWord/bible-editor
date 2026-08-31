// Groups BookLintIndicator's flag issues by (check, message) so a run of
// identical entries - e.g. issue #653's 63 "Unmerged Door43 edit - verify" TN
// rows in JER, every one carrying the exact same generic hedge because
// there's no per-row detail the merge could give - collapses into one
// entry with a count instead of forcing a translator to scroll past dozens
// of indistinguishable items. A group of size 1 renders exactly as before.
// Order is first-seen (stable), so the popup's overall ordering doesn't churn.

import type { BookLintIssue } from "../sync/api";

export interface LintIssueGroup {
  key: string;
  check: string;
  message: string;
  issues: BookLintIssue[];
}

export function groupLintIssues(issues: BookLintIssue[]): LintIssueGroup[] {
  const groups: LintIssueGroup[] = [];
  const byKey = new Map<string, LintIssueGroup>();
  for (const issue of issues) {
    const key = issue.check + "|" + issue.message;
    let group = byKey.get(key);
    if (!group) {
      group = { key, check: issue.check, message: issue.message, issues: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.issues.push(issue);
  }
  return groups;
}

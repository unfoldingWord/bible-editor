// Groups BookLintIndicator's flag issues by (check, message) so a run of
// identical entries - e.g. issue #653's 63 "Unmerged Door43 edit - verify" TN
// rows in JER, every one carrying the exact same generic hedge because
// there's no per-row detail the merge could give - collapses into one
// entry with a count instead of forcing a translator to scroll past dozens
// of indistinguishable items. A group of size 1 renders exactly as before.
// Order is first-seen (stable), so the popup's overall ordering doesn't churn.

import type { BookLintIssue, RowKind } from "../sync/api";

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

// --- Door43-vs-here diff (issue #653 direction 2) ---
//
// A dismissible issue carries `door43` (Door43's row values at flag time) and
// `ours` (the same fields from the live row). We show a translator which
// fields actually differ rather than dumping both objects. null/undefined/""
// are treated as equivalent "empty" so a field that's merely absent on one
// side doesn't read as a spurious difference.

export interface FieldDiff {
  field: string;
  door43: string;
  ours: string;
}

function normalizeForCompare(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  // Object/array fields would otherwise collapse to the useless "[object
  // Object]" via String() and silently compare equal to any other object —
  // JSON.stringify keeps a real structural difference visible.
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Returns the fields where `door43` and `ours` differ (after empty-normalizing
 * both sides), each carrying the raw String()-coerced display values. Returns
 * an empty array when nothing differs, or when `door43` is null/undefined
 * (nothing to compare against).
 */
export function diffDoor43Fields(
  door43: Record<string, unknown> | null | undefined,
  ours: Record<string, unknown> | null | undefined,
): FieldDiff[] {
  if (!door43) return [];
  const fields = new Set([...Object.keys(door43), ...Object.keys(ours ?? {})]);
  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    const d = door43[field];
    const o = ours?.[field];
    if (normalizeForCompare(d) !== normalizeForCompare(o)) {
      diffs.push({ field, door43: normalizeForCompare(d), ours: normalizeForCompare(o) });
    }
  }
  return diffs;
}

// dismiss-review only exists for row-backed resources (tn/tq/twl) — ult/ust
// issues are scripture-text findings with no row to dismiss against. Returns
// the resource narrowed to a RowKind, or null when it isn't one.
export function dismissibleKind(resource: BookLintIssue["resource"]): RowKind | null {
  return resource === "tn" || resource === "tq" || resource === "twl" ? resource : null;
}

/**
 * True when every issue in a group is dismissible, carries a rowId, and has
 * a row-backed resource — the precondition for showing a group-level
 * "Dismiss all" affordance.
 */
export function isGroupFullyDismissible(issues: BookLintIssue[]): boolean {
  return (
    issues.length > 0 &&
    issues.every((i) => i.dismissible && i.rowId && dismissibleKind(i.resource) !== null)
  );
}

// Visible axes of an adopt_conflict write (issue #633).
//
// computeVerseMerge decides "both sides moved" via stableKey on the full
// verseObjects tree. That tree can differ when nothing a translator can see
// changed — same plain wording, same alignment groups — because of parse
// churn (empty nextChar / empty text nodes after #627, milestone nesting,
// attribute order, etc.). Raising Door43's overwrite banner in that case
// tells an editor their work was replaced and to recover it from history,
// which is the wrong response to a cosmetic write.
//
// classifyVisibleAdoptionChange answers only what a reader cares about:
//   - plain text (whitespace-collapsed, same lens as lane-reopen)
//   - alignment groups (each target \w's text + sourceKey chain)
// Record-time refinement in bookReimport.ts turns a no-visible-change
// adopt_conflict into action `adopt_no_visible_change` so the audit row
// stays and the banner filter (SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL)
// excludes it the same way it already excludes a clean `adopt`.

import { collectAlignmentWords } from "./alignmentDelta.ts";
import { extractPlainText } from "./importParsers.ts";
import { collapseWhitespaceForCompare } from "./verseMerge.ts";

export interface VisibleAdoptionChange {
  wordingChanged: boolean;
  alignmentChanged: boolean;
}

function parseContent(content: unknown): unknown {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return content;
}

/** Stable fingerprint of target words + their zaln sourceKey chains. */
export function alignmentGroupsFingerprint(content: unknown): string {
  return collectAlignmentWords(content)
    .map((w) => `${w.text}\0${w.sourceKey ?? ""}`)
    .join("\n");
}

export function classifyVisibleAdoptionChange(
  oursRaw: unknown,
  theirsRaw: unknown,
): VisibleAdoptionChange {
  const ours = parseContent(oursRaw);
  const theirs = parseContent(theirsRaw);
  const wordingChanged =
    collapseWhitespaceForCompare(extractPlainText(ours)) !==
    collapseWhitespaceForCompare(extractPlainText(theirs));
  const alignmentChanged = alignmentGroupsFingerprint(ours) !== alignmentGroupsFingerprint(theirs);
  return { wordingChanged, alignmentChanged };
}

/** Reason strings persisted on verse_merge_conflicts for adopt_conflict family. */
export const REASON_BOTH_CHANGED = "both_changed";
export const REASON_BOTH_CHANGED_WORDING = "both_changed_wording";
export const REASON_BOTH_CHANGED_ALIGNMENT = "both_changed_alignment";
export const REASON_BOTH_CHANGED_NO_VISIBLE = "both_changed_no_visible";

export const ACTION_ADOPT_NO_VISIBLE_CHANGE = "adopt_no_visible_change";

/**
 * Refine an adopt_conflict decision after we know the bytes we would store.
 * Callers pass the D1 content being replaced and the (post-canonize) content
 * about to be written. Clean `adopt` and keep-* actions are left untouched.
 */
export function refineAdoptConflictForVisibleChange(
  action: string,
  reason: string,
  oursRaw: unknown,
  theirsRaw: unknown,
): { action: string; reason: string; visible: VisibleAdoptionChange } {
  if (action !== "adopt_conflict") {
    return {
      action,
      reason,
      visible: { wordingChanged: true, alignmentChanged: true },
    };
  }
  const visible = classifyVisibleAdoptionChange(oursRaw, theirsRaw);
  if (!visible.wordingChanged && !visible.alignmentChanged) {
    return {
      action: ACTION_ADOPT_NO_VISIBLE_CHANGE,
      reason: REASON_BOTH_CHANGED_NO_VISIBLE,
      visible,
    };
  }
  if (visible.wordingChanged && visible.alignmentChanged) {
    return { action: "adopt_conflict", reason: REASON_BOTH_CHANGED, visible };
  }
  if (visible.wordingChanged) {
    return { action: "adopt_conflict", reason: REASON_BOTH_CHANGED_WORDING, visible };
  }
  return { action: "adopt_conflict", reason: REASON_BOTH_CHANGED_ALIGNMENT, visible };
}

/** True when the stored reason names a wording change a reader can see. */
export function reasonImpliesWordingChange(reason: string | null | undefined): boolean {
  // Unknown / legacy adopt_conflict reasons default to "wording" so we never
  // under-warn (the recovery-from-history sentence is the safe default).
  if (reason == null || reason === "") return true;
  if (reason === REASON_BOTH_CHANGED_ALIGNMENT || reason === REASON_BOTH_CHANGED_NO_VISIBLE) {
    return false;
  }
  return reason === REASON_BOTH_CHANGED || reason === REASON_BOTH_CHANGED_WORDING || reason.startsWith("both_changed");
}

/** True when the stored reason names an alignment-group change. */
export function reasonImpliesAlignmentChange(reason: string | null | undefined): boolean {
  if (reason == null || reason === "") return true;
  if (reason === REASON_BOTH_CHANGED_WORDING || reason === REASON_BOTH_CHANGED_NO_VISIBLE) {
    return false;
  }
  return reason === REASON_BOTH_CHANGED || reason === REASON_BOTH_CHANGED_ALIGNMENT || reason.startsWith("both_changed");
}

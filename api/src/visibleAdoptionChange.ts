// Visible axes of an adopt_conflict write (issue #633 / #788).
//
// The three axes deliberately answer different reader questions:
//   - wording: letters/numbers/marks/symbols/braces, ignoring whitespace and
//              Unicode punctuation;
//   - punctuation: Unicode punctuation itself (whitespace alone is not one);
//   - alignment: the ordered sourceKey chain for each target word, never the
//                target word's surface text.
//
// The split keeps a real comma/quote correction from being described as wording
// while still treating a mark, symbol, or brace as wording. It is also
// deliberately fail-closed: malformed JSON or an unusable verseObjects shape
// reports every axis as changed, so an alert can over-describe an unknown input
// but can never suppress a genuine overwrite warning.

import { collectAlignmentWords } from "./alignmentDelta.ts";
import { extractPlainText } from "./importParsers.ts";

export interface VisibleAdoptionChange {
  wordingChanged: boolean;
  punctuationChanged: boolean;
  alignmentChanged: boolean;
}

type VerseContent = { verseObjects: unknown[] };

function validNodes(nodes: unknown[], depth: number = 0): boolean {
  // This is not a schema validator. It merely establishes the minimum shape
  // both extractPlainText and collectAlignmentWords can inspect honestly. A
  // hostile/deep payload is not a reason to silently call an overwrite visible.
  if (depth > 1000) return false;
  for (const node of nodes) {
    if (node == null || typeof node !== "object" || Array.isArray(node)) return false;
    const obj = node as Record<string, unknown>;
    // A node must expose content one of the readers can inspect, OR be one of
    // usfm-js's legitimate marker-only shapes. Paragraph/quote/section nodes
    // routinely carry only `{type, tag, nextChar?}`; extractPlainText uses
    // their tag as an in-flow separator, so rejecting them would turn nearly
    // every real verse into a false all-axes warning. Conversely an arbitrary
    // `{type:"opaque", value:"changed"}` remains uninspectable and fails closed.
    const markerOnlyType = obj.type === "paragraph" || obj.type === "quote" || obj.type === "section" || obj.type === "milestone";
    if (!("text" in obj) && !("children" in obj) && !(markerOnlyType && typeof obj.tag === "string")) return false;
    if ("type" in obj && typeof obj.type !== "string") return false;
    if ("tag" in obj && typeof obj.tag !== "string") return false;
    if ("text" in obj && typeof obj.text !== "string") return false;
    if ("nextChar" in obj && typeof obj.nextChar !== "string") return false;
    if ("children" in obj) {
      if (!Array.isArray(obj.children) || !validNodes(obj.children, depth + 1)) return false;
    }
  }
  return true;
}

function parseContent(content: unknown): VerseContent | null {
  let parsed = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const verseObjects = (parsed as { verseObjects?: unknown }).verseObjects;
  if (!Array.isArray(verseObjects) || !validNodes(verseObjects)) return null;
  return { verseObjects };
}

const PUNCTUATION_RE = /^\p{P}$/u;
const WHITESPACE_RE = /^\s$/u;

function nfc(text: string): string {
  return text.normalize("NFC");
}

// Braces are intentionally retained on the wording axis. They are punctuation
// in Unicode's general categories, but in Bible-editor text they can delimit a
// literal construct; silently discarding them would make a brace edit invisible.
function wordingFingerprintFromText(text: string): string {
  let out = "";
  for (const char of nfc(text)) {
    if (WHITESPACE_RE.test(char)) continue;
    if (PUNCTUATION_RE.test(char) && char !== "{" && char !== "}") continue;
    out += char;
  }
  return out;
}

function punctuationFingerprintFromText(text: string): string {
  let out = "";
  // Mask each uninterrupted run of wording-significant characters as one
  // token. This preserves punctuation's structural position (`a,b` != `ab,`)
  // without coupling the punctuation axis to spelling or word length
  // (`cat, now` == `elephant, later`). Whitespace is intentionally invisible.
  // Braces ride inside the masked run because this app treats them as semantic
  // supplied-word notation, not disposable punctuation.
  let inWordingRun = false;
  for (const char of nfc(text)) {
    if (WHITESPACE_RE.test(char)) continue;
    const ordinaryPunctuation = PUNCTUATION_RE.test(char) && char !== "{" && char !== "}";
    if (ordinaryPunctuation) {
      out += char;
      inWordingRun = false;
    } else if (!inWordingRun) {
      out += "\0";
      inWordingRun = true;
    }
  }
  return out;
}

/** Stable fingerprint of sourceKey chains in target-word order, never target text. */
export function alignmentGroupsFingerprint(content: unknown): string {
  // JSON removes delimiter ambiguity (a sourceKey itself may contain punctuation)
  // while preserving order and distinguishing an unaligned word from an empty key.
  return JSON.stringify(collectAlignmentWords(content).map((w) => w.sourceKey ?? null));
}

export function classifyVisibleAdoptionChange(
  oursRaw: unknown,
  theirsRaw: unknown,
): VisibleAdoptionChange {
  const ours = parseContent(oursRaw);
  const theirs = parseContent(theirsRaw);
  if (ours == null || theirs == null) {
    return { wordingChanged: true, punctuationChanged: true, alignmentChanged: true };
  }
  try {
    const oursText = extractPlainText(ours);
    const theirsText = extractPlainText(theirs);
    return {
      wordingChanged: wordingFingerprintFromText(oursText) !== wordingFingerprintFromText(theirsText),
      punctuationChanged: punctuationFingerprintFromText(oursText) !== punctuationFingerprintFromText(theirsText),
      alignmentChanged: alignmentGroupsFingerprint(ours) !== alignmentGroupsFingerprint(theirs),
    };
  } catch {
    return { wordingChanged: true, punctuationChanged: true, alignmentChanged: true };
  }
}

/** Reason strings persisted on verse_merge_conflicts for adopt_conflict family. */
export const REASON_BOTH_CHANGED = "both_changed"; // legacy: wording + alignment
export const REASON_BOTH_CHANGED_WORDING = "both_changed_wording";
export const REASON_BOTH_CHANGED_PUNCTUATION = "both_changed_punctuation";
export const REASON_BOTH_CHANGED_ALIGNMENT = "both_changed_alignment";
export const REASON_BOTH_CHANGED_WORDING_PUNCTUATION = "both_changed_wording_punctuation";
export const REASON_BOTH_CHANGED_WORDING_ALIGNMENT = "both_changed_wording_alignment";
export const REASON_BOTH_CHANGED_PUNCTUATION_ALIGNMENT = "both_changed_punctuation_alignment";
export const REASON_BOTH_CHANGED_WORDING_PUNCTUATION_ALIGNMENT = "both_changed_wording_punctuation_alignment";
export const REASON_BOTH_CHANGED_NO_VISIBLE = "both_changed_no_visible";

export const ACTION_ADOPT_NO_VISIBLE_CHANGE = "adopt_no_visible_change";

export interface AdoptionReasonAxes {
  wording: boolean;
  punctuation: boolean;
  alignment: boolean;
}

const LEGACY_SAFE_AXES: AdoptionReasonAxes = { wording: true, punctuation: false, alignment: true };
const ALL_AXES: AdoptionReasonAxes = { wording: true, punctuation: true, alignment: true };
const NO_AXES: AdoptionReasonAxes = { wording: false, punctuation: false, alignment: false };
const REASON_AXES: Record<string, AdoptionReasonAxes> = {
  // Old persisted rows said only "both_changed" and predate the punctuation
  // axis. Preserve their known wording+alignment meaning without inventing a
  // punctuation claim that was never measured.
  [REASON_BOTH_CHANGED]: LEGACY_SAFE_AXES,
  [REASON_BOTH_CHANGED_WORDING]: { wording: true, punctuation: false, alignment: false },
  [REASON_BOTH_CHANGED_PUNCTUATION]: { wording: false, punctuation: true, alignment: false },
  [REASON_BOTH_CHANGED_ALIGNMENT]: { wording: false, punctuation: false, alignment: true },
  [REASON_BOTH_CHANGED_WORDING_PUNCTUATION]: { wording: true, punctuation: true, alignment: false },
  [REASON_BOTH_CHANGED_WORDING_ALIGNMENT]: { wording: true, punctuation: false, alignment: true },
  [REASON_BOTH_CHANGED_PUNCTUATION_ALIGNMENT]: { wording: false, punctuation: true, alignment: true },
  [REASON_BOTH_CHANGED_WORDING_PUNCTUATION_ALIGNMENT]: ALL_AXES,
  [REASON_BOTH_CHANGED_NO_VISIBLE]: NO_AXES,
};

// Compatibility boundary for stored pre-axis rows. Unknown reasons retain the
// old fail-safe wording+alignment warning, but never claim punctuation unless a
// reason minted by the new classifier positively measured it.
export function adoptionReasonAxes(reason: string | null | undefined): AdoptionReasonAxes {
  if (reason == null || reason === "") return { ...LEGACY_SAFE_AXES };
  return { ...(Object.hasOwn(REASON_AXES, reason) ? REASON_AXES[reason] : LEGACY_SAFE_AXES) };
}

function canonicalReason(visible: VisibleAdoptionChange): string {
  const { wordingChanged: wording, punctuationChanged: punctuation, alignmentChanged: alignment } = visible;
  if (wording && punctuation && alignment) return REASON_BOTH_CHANGED_WORDING_PUNCTUATION_ALIGNMENT;
  if (wording && punctuation) return REASON_BOTH_CHANGED_WORDING_PUNCTUATION;
  if (wording && alignment) return REASON_BOTH_CHANGED_WORDING_ALIGNMENT;
  if (punctuation && alignment) return REASON_BOTH_CHANGED_PUNCTUATION_ALIGNMENT;
  if (wording) return REASON_BOTH_CHANGED_WORDING;
  if (punctuation) return REASON_BOTH_CHANGED_PUNCTUATION;
  if (alignment) return REASON_BOTH_CHANGED_ALIGNMENT;
  return REASON_BOTH_CHANGED_NO_VISIBLE;
}

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
      visible: { wordingChanged: true, punctuationChanged: true, alignmentChanged: true },
    };
  }
  const visible = classifyVisibleAdoptionChange(oursRaw, theirsRaw);
  const canonical = canonicalReason(visible);
  if (canonical === REASON_BOTH_CHANGED_NO_VISIBLE) {
    return { action: ACTION_ADOPT_NO_VISIBLE_CHANGE, reason: canonical, visible };
  }
  return { action: "adopt_conflict", reason: canonical, visible };
}

/** True when the stored reason names a wording change a reader can see. */
export function reasonImpliesWordingChange(reason: string | null | undefined): boolean {
  return adoptionReasonAxes(reason).wording;
}

/** True when the stored reason names a punctuation change a reader can see. */
export function reasonImpliesPunctuationChange(reason: string | null | undefined): boolean {
  return adoptionReasonAxes(reason).punctuation;
}

/** True when the stored reason names an alignment-group change. */
export function reasonImpliesAlignmentChange(reason: string | null | undefined): boolean {
  return adoptionReasonAxes(reason).alignment;
}

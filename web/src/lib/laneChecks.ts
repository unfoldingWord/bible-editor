// Shared logic for the per-resource verse checkoff "lanes".
//
// A lane is checked independently per verse, and EACH checker gets their own
// row (see migration 0033), so the UI shades by who: "you" / "someone else" /
// "you + others". This module is the single source of that derivation so the
// rail, the resource panels, the column/book toolbar, and the board all agree.

import type { CheckLane, VerseLaneCheck } from "../sync/api";

// "waiting" (#1218): my Text-lane done mark is set on this screen but not yet
// sent, because an earlier save of the verse's text was turned down
// (outboxTargeting.ts laneCheckHeld). The server and teammates still see it
// open until that save is retried, discarded, or replaced by a newer save.
export type LaneShade = "open" | "me" | "others" | "both" | "waiting";

export const LANE_WAITING_NOTE =
  "Waiting: this verse's text was turned down. Retry or discard it in the status bar.";

// Per-verse Text-lane check control, threaded into the column/book scripture
// views so the dense flowing/blocked text can show + toggle the Text check
// without dragging in the full rail/panel check plumbing.
export interface TextLaneCheck {
  canCheck: boolean;
  shade: (verse: number) => LaneShade;
  attribution: (verse: number) => string;
  onToggle: (verse: number) => void;
}

export const LANE_LABELS: Record<CheckLane, string> = {
  text: "Text",
  tn: "Notes",
  tw: "Words",
  tq: "Questions",
};

// Fill + on-fill text per shade, drawn from the Cultivate-teal family
// (theme secondary.light/main/dark) so "you" matches today's check color.
export const LANE_FILL: Record<Exclude<LaneShade, "open">, { bg: string; fg: string }> = {
  others: { bg: "#A0DEDF", fg: "#014263" },
  me: { bg: "#70C9CC", fg: "#014263" },
  both: { bg: "#3F9CA0", fg: "#FFFFFF" },
  // Kindle amber, so a mark that has not reached the server stands apart.
  waiting: { bg: "#E59D33", fg: "#231F20" },
};

export function laneKey(verse: number, lane: CheckLane): string {
  return `${verse}:${lane}`;
}

// Index the flat check list into verse:lane -> checker user ids.
export function indexLaneChecks(checks: VerseLaneCheck[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const c of checks) {
    const k = laneKey(c.verse, c.lane);
    const arr = m.get(k);
    if (arr) arr.push(c.checked_by);
    else m.set(k, [c.checked_by]);
  }
  return m;
}

export function shadeFromCheckers(checkers: number[] | undefined, meId: number | null): LaneShade {
  if (!checkers || checkers.length === 0) return "open";
  const hasMe = meId != null && checkers.includes(meId);
  const hasOther = checkers.some((id) => id !== meId);
  if (hasMe && hasOther) return "both";
  if (hasMe) return "me";
  return "others";
}

// Whether a lane is applicable for a verse. text/tw always apply (every verse
// has ULT/UST + can be word-checked); notes/questions only when the verse
// actually has rows of that kind — otherwise it's "nothing to check", not
// "unchecked".
export function laneApplicable(lane: CheckLane, hasTn: boolean, hasTq: boolean): boolean {
  if (lane === "text" || lane === "tw") return true;
  if (lane === "tn") return hasTn;
  return hasTq;
}

// user id -> DCS username, from every check row in the chapter that carries one
// (`checked_by_name`, sent by the server since the lane-names change).
export function indexCheckerNames(checks: VerseLaneCheck[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const c of checks) if (c.checked_by_name) m.set(c.checked_by, c.checked_by_name);
  return m;
}

// Human attribution string: "you", "bwright", "you + bwright, jsmith". A
// checker whose name is unknown (older server, deleted user) is counted
// instead: "someone else", "3 people", "you + 1 other", "bwright, 1 other".
export function laneAttribution(
  checkers: number[] | undefined,
  meId: number | null,
  names?: Map<number, string>,
): string {
  if (!checkers || checkers.length === 0) return "open";
  const others = checkers.filter((id) => id !== meId);
  const mine = meId != null && checkers.includes(meId);
  if (mine && others.length === 0) return "you";
  const known = others.map((id) => names?.get(id)).filter((n): n is string => !!n);
  const unknown = others.length - known.length;
  if (!mine && known.length === 0) return unknown === 1 ? "someone else" : `${unknown} people`;
  const parts = unknown === 0 ? known : [...known, unknown === 1 ? "1 other" : `${unknown} others`];
  return mine ? `you + ${parts.join(", ")}` : parts.join(", ");
}

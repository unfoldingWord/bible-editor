// Shared logic for the per-resource verse checkoff "lanes".
//
// A lane is checked independently per verse, and EACH checker gets their own
// row (see migration 0033), so the UI shades by who: "you" / "someone else" /
// "you + others". This module is the single source of that derivation so the
// rail, the resource panels, the column/book toolbar, and the board all agree.

import type { CheckLane, VerseLaneCheck } from "../sync/api";

export type LaneShade = "open" | "me" | "others" | "both";

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

// Human attribution string. We only have user ids client-side (no name map yet),
// so others render as counts rather than names.
export function laneAttribution(checkers: number[] | undefined, meId: number | null): string {
  if (!checkers || checkers.length === 0) return "open";
  const others = checkers.filter((id) => id !== meId).length;
  const mine = meId != null && checkers.includes(meId);
  if (mine && others === 0) return "you";
  if (mine) return others === 1 ? "you + 1 other" : `you + ${others} others`;
  return others === 1 ? "someone else" : `${others} people`;
}

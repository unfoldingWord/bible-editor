// Convert a user's click-to-select Hebrew/Greek word set into the TN
// quote format used by row.quote + row.occurrence. Tokens get sorted into
// document order, runs of consecutive document positions become a single
// space-joined sub-quote, and disjoint runs are joined with " & " — the
// same gap marker findSourceHighlights / findTargetHighlights consume.
//
// Occurrence is best-effort: we walk the verse looking for the same
// gap-separated pattern and report 1-based index of the FIRST run start
// that matches the user's selection range. For unambiguous selections
// (the picked tokens are the only instance in the verse), the result is
// always 1, matching how new TNs are typically written.

import type { HighlightKey } from "./highlight";

interface UhbWord {
  text: string;
  occurrence: number;
  // 0-based document position among all \w tokens in this verse. Stable
  // across re-render because the verseObjects tree is immutable while
  // the user is selecting.
  position: number;
}

function collectUhbWords(verseObjects: unknown[]): UhbWord[] {
  const out: UhbWord[] = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const occurrence = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        out.push({ text, occurrence, position: out.length });
      } else if (o["type"] === "milestone") {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return out;
}

export interface BuiltQuote {
  quote: string;
  occurrence: number;
}

export function buildQuoteFromSelection(
  verseObjects: unknown[] | undefined | null,
  selectedKeys: Set<HighlightKey>,
): BuiltQuote | null {
  if (!Array.isArray(verseObjects) || selectedKeys.size === 0) return null;
  const all = collectUhbWords(verseObjects);
  const selected = all.filter((w) => selectedKeys.has(`${w.text}|${w.occurrence}`));
  if (selected.length === 0) return null;

  // selected is already in document order — collectUhbWords walks in order
  // and selected preserves that. Group runs of consecutive positions.
  const groups: UhbWord[][] = [];
  let current: UhbWord[] = [selected[0]];
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].position === selected[i - 1].position + 1) {
      current.push(selected[i]);
    } else {
      groups.push(current);
      current = [selected[i]];
    }
  }
  if (current.length > 0) groups.push(current);

  const quote = groups.map((g) => g.map((w) => w.text).join(" ")).join(" & ");

  // Occurrence — count how many positions in `all` start a matching
  // pattern. A pattern matches when scanning forward from `start`: for
  // each group, find a sub-position whose text equals the group's
  // sequence; subsequent groups can start anywhere after the previous
  // group ends (the `&` gap). 1-based; the first match is the selection.
  const matches: number[] = [];
  for (let start = 0; start < all.length; start++) {
    if (matchGroupsAt(start, groups, all)) matches.push(start);
  }
  // Which match starts at our first selected position?
  const firstSelectedPos = selected[0].position;
  const occurrence = Math.max(1, matches.indexOf(firstSelectedPos) + 1);
  return { quote, occurrence };
}

function matchGroupsAt(
  start: number,
  groups: UhbWord[][],
  all: UhbWord[],
): boolean {
  let pos = start;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (gi === 0) {
      if (pos + group.length > all.length) return false;
      for (let wi = 0; wi < group.length; wi++) {
        if (all[pos + wi].text !== group[wi].text) return false;
      }
      pos = pos + group.length;
    } else {
      let found = -1;
      for (let s = pos; s + group.length <= all.length; s++) {
        let ok = true;
        for (let wi = 0; wi < group.length; wi++) {
          if (all[s + wi].text !== group[wi].text) {
            ok = false;
            break;
          }
        }
        if (ok) {
          found = s;
          break;
        }
      }
      if (found < 0) return false;
      pos = found + group.length;
    }
  }
  return true;
}

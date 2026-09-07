// Correct malformed `\zaln-s` source-occurrence numbering against the real
// source verse.
//
// An AI aligner sometimes stamps a source token that appears ONCE in the
// UHB/UGNT with x-occurrences="2" — one bogus occurrence per repeated target
// phrase. JER 28:1 UST does this for חֲנַנְיָה, אָמַר, אֵלַי and לְעֵינֵי: two
// milestones reference the single physical Hebrew token as occ 1/2 and 2/2, so
// the aligner renders the Hebrew word twice and the exported USFM claims a
// source count that doesn't exist.
//
// This is a DATA fix: it edits the stored verse tree (used by the remediation
// script in scripts/scan-source-occurrences.mjs). It is intentionally NOT wired
// into the alignment hot path — the display already collapses these via
// mergeSamePositionGroups. The export emits stored content_json verbatim, so
// only rewriting the stored tree cleans the exported USFM.
//
// Conservative by design:
//   - Keyed by x-content (NFC). occurrence/occurrences are unreliable here, and
//     strong is NOT unique per surface form (same-Strong different-pointing
//     words collide), so a content match is the only safe anchor.
//   - ONLY the appears-once case is corrected: a source token that occurs
//     exactly ONCE in the verse must be referenced as occ 1/1, so every
//     milestone for it that says otherwise is unambiguously wrong → 1/1. When a
//     token appears 2+ times but a milestone over-claims (e.g. four `וְאֶת`
//     milestones over a source that has it twice — 1CH genealogies), the correct
//     occurrence-to-token mapping is genuinely ambiguous and needs real
//     re-alignment, NOT a clamp, so those are LEFT ALONE (the display still
//     collapses same-position duplicates via mergeSamePositionGroups).
//   - Content-less / drifted (content not found in source) milestones, and
//     already-correct ones, are never touched, so clean data doesn't churn.

import { nfc } from "./hebrew.ts";
import { isCharacterWrapper } from "./usfm.ts";

type Node = Record<string, unknown>;

export interface SourceOccurrenceCorrection {
  content: string;
  from: { occurrence: string; occurrences: string };
  to: { occurrence: string; occurrences: string };
}

// Total appearances of each source \w (keyed by NFC text) in the source verse.
function sourceTextTotals(sourceVerseObjects: unknown[]): Map<string, number> {
  const totals = new Map<string, number>();
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Node | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const key = nfc(String(o["text"] ?? ""));
        totals.set(key, (totals.get(key) ?? 0) + 1);
      } else if (
        o["type"] === "milestone" ||
        // \d (Psalm superscription) carries alignable verse body — descend
        // like collectSourceWords / buildSourceIndexMap do. Tag alone, not
        // `type:"section"`: usfm-js emits a real `\d` with no `type` field
        // at all, so the old predicate matched nothing real data has.
        o["tag"] === "d" ||
        // \qs (Selah) wraps its aligned content from OUTSIDE — not
        // descending it undercounts the wrapped source word's total.
        isCharacterWrapper(o)
      ) {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(sourceVerseObjects ?? []);
  return totals;
}

// Returns a deep-cloned target tree with over-counted source milestones
// renumbered to the token's true source count, plus the list of corrections.
// `changed` is false (and the clone equals the input shape) when nothing was
// over-counted.
export function correctSourceOccurrences(
  targetVerseObjects: unknown[],
  sourceVerseObjects: unknown[],
): { changed: boolean; verseObjects: unknown[]; corrections: SourceOccurrenceCorrection[] } {
  const totals = sourceTextTotals(sourceVerseObjects);
  const clone = JSON.parse(JSON.stringify(targetVerseObjects ?? [])) as Node[];
  const corrections: SourceOccurrenceCorrection[] = [];

  const walk = (nodes: Node[]) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (
        n["type"] === "milestone" &&
        n["tag"] === "zaln" &&
        typeof n["content"] === "string" &&
        (n["content"] as string).length > 0 &&
        "occurrences" in n
      ) {
        const content = n["content"] as string;
        const trueTotal = totals.get(nfc(content));
        // Only the unambiguous appears-once case: the token occurs exactly once
        // in the source, so any milestone for it must be occ 1/1. trueTotal > 1
        // over-counts are ambiguous (which physical token?) and left alone;
        // unmatched content (drift / not in source) is skipped.
        if (
          trueTotal === 1 &&
          (String(n["occurrence"]) !== "1" || String(n["occurrences"]) !== "1")
        ) {
          const from = {
            occurrence: String(n["occurrence"] ?? ""),
            occurrences: String(n["occurrences"] ?? ""),
          };
          n["occurrence"] = "1";
          n["occurrences"] = "1";
          corrections.push({
            content,
            from,
            to: { occurrence: "1", occurrences: "1" },
          });
        }
      }
      if (Array.isArray(n["children"])) walk(n["children"] as Node[]);
    }
  };
  walk(clone);
  return { changed: corrections.length > 0, verseObjects: clone, corrections };
}

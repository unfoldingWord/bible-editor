// Mirror of api/src/alignmentDelta.ts. Keep behavior in sync: the web copy
// prevents optimistic local/outbox writes, and the API copy is the backstop.
export type AlignmentIntent =
  | "text_edit"
  | "find_replace"
  | "section_edit"
  | "alignment_edit"
  // Issue #575: an escalated "Save anyway" on a text_edit that collaterally
  // de-aligned words (Shell.tsx's pendingAlignmentLoss confirm) used to climb
  // as plain "alignment_edit" — indistinguishable from a real aligner-panel
  // re-alignment save. The translator's INTENT was still a text edit; the
  // alignment loss is accepted collateral, not the point of the save. Guard
  // behavior is identical to alignment_edit (both are exempt from
  // guardBlocksSave); this exists so the two can be told apart wherever that
  // distinction matters (e.g. verse history, future rebase-eligibility
  // logic), without changing today's guard outcome for either.
  | "confirmed_text_edit";

export interface AlignmentLoss {
  index: number;
  text: string;
  reason: "lost" | "changed_source";
}

export interface AlignmentDelta {
  beforeAligned: number;
  afterAligned: number;
  wordSequenceUnchanged: boolean;
  unexpectedLosses: AlignmentLoss[];
}

interface WordInfo {
  text: string;
  sourceKey: string | null;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").normalize("NFC");
}

function sourcePart(node: Record<string, unknown>): string {
  return [
    normalizedText(node["strong"]),
    normalizedText(node["occurrence"] ?? "1"),
    normalizedText(node["occurrences"] ?? "1"),
    normalizedText(node["content"]),
  ].join("|");
}

function verseObjectsOf(content: unknown): unknown[] {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vos) ? vos : [];
}

export function collectAlignmentWords(content: unknown): WordInfo[] {
  const words: WordInfo[] = [];
  const walk = (nodes: unknown[], sourceChain: string[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const isZaln = o["type"] === "milestone" && o["tag"] === "zaln";
      const nextChain = isZaln ? [...sourceChain, sourcePart(o)] : sourceChain;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        words.push({
          text: normalizedText(o["text"]),
          sourceKey: sourceChain.length > 0 ? sourceChain.join(">") : null,
        });
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children, nextChain);
    }
  };
  walk(verseObjectsOf(content), []);
  return words;
}

function countsByText(words: WordInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word.text, (counts.get(word.text) ?? 0) + 1);
  return counts;
}

function lcsLinks(before: WordInfo[], after: WordInfo[]): number[] {
  const m = before.length;
  const n = after.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = before[i].text === after[j].text
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const links = Array(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i].text === after[j].text) {
      links[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return links;
}

export function analyzeAlignmentDelta(beforeContent: unknown, afterContent: unknown): AlignmentDelta {
  const before = collectAlignmentWords(beforeContent);
  const after = collectAlignmentWords(afterContent);
  const beforeAligned = before.filter((w) => w.sourceKey !== null).length;
  const afterAligned = after.filter((w) => w.sourceKey !== null).length;
  const wordSequenceUnchanged =
    before.length === after.length && before.every((w, i) => w.text === after[i]?.text);
  const unexpectedLosses: AlignmentLoss[] = [];

  if (wordSequenceUnchanged) {
    for (let i = 0; i < before.length; i++) {
      if (!before[i].sourceKey) continue;
      if (!after[i]?.sourceKey) {
        unexpectedLosses.push({ index: i, text: before[i].text, reason: "lost" });
      } else if (after[i].sourceKey !== before[i].sourceKey) {
        unexpectedLosses.push({ index: i, text: before[i].text, reason: "changed_source" });
      }
    }
    return { beforeAligned, afterAligned, wordSequenceUnchanged, unexpectedLosses };
  }

  const beforeCounts = countsByText(before);
  const afterCounts = countsByText(after);
  const links = lcsLinks(before, after);
  for (let i = 0; i < before.length; i++) {
    const oldWord = before[i];
    if (!oldWord.sourceKey) continue;
    const j = links[i];
    if (j < 0) continue;
    // Repeated surfaces are allowed to become ambiguous after real text edits.
    if ((beforeCounts.get(oldWord.text) ?? 0) > 1 || (afterCounts.get(oldWord.text) ?? 0) > 1) {
      continue;
    }
    const newWord = after[j];
    if (!newWord.sourceKey) {
      unexpectedLosses.push({ index: i, text: oldWord.text, reason: "lost" });
    } else if (newWord.sourceKey !== oldWord.sourceKey) {
      unexpectedLosses.push({ index: i, text: oldWord.text, reason: "changed_source" });
    }
  }

  return { beforeAligned, afterAligned, wordSequenceUnchanged, unexpectedLosses };
}

export function intentAllowsUnexpectedAlignmentLoss(intent: AlignmentIntent): boolean {
  return intent === "alignment_edit" || intent === "confirmed_text_edit";
}

// The single enforced predicate: should this save be BLOCKED for collateral
// alignment loss? Both the API PATCH handler (api/src/verses.ts) and the web
// outbox guard (web/src/components/Shell.tsx) call this so there is exactly one
// definition of "too much alignment loss" — and so the tests assert the real
// thing, not a re-derived copy.
//
// DO NOT re-add a `delta.wordSequenceUnchanged` (or any similar) narrowing
// here. That exact narrowing (commit 6980fd72) is what let 1CH 4:21 / NUM 24
// ship: a one-word spelling edit (e.g. Lekah→Lecah) flips
// wordSequenceUnchanged to false, the narrowed guard never fired, and the
// editor collaterally de-aligned untouched neighbors straight onto master.
// analyzeAlignmentDelta's LCS path only reports unexpectedLosses for words that
// existed before AND still exist after (same surface + occurrence) but lost or
// changed their \zaln source — i.e. genuine collateral loss, never the word the
// translator actually edited. The guard MUST fire on collateral loss regardless
// of whether the word sequence also changed. The only exemption is
// alignment_edit (re-aligning in the aligner panel legitimately changes
// sources).
export function guardBlocksSave(delta: AlignmentDelta, intent: AlignmentIntent): boolean {
  return delta.unexpectedLosses.length > 0 && !intentAllowsUnexpectedAlignmentLoss(intent);
}

// Words that HAD a \zaln source before and are now fully bare (reason "lost"),
// i.e. a previously-aligned word that an alignment_edit just unaligned. This is
// the signal the aligner-panel "you're about to unalign X" confirm fires on —
// alignment_edit is exempt from guardBlocksSave (re-aligning legitimately
// removes/repoints sources), so a silent accidental unlink would otherwise sail
// through and only surface when the nightly export's shrink guard blocks it
// (the JER 30:1 "Jeremiah" incident). `changed_source` (a re-pointed source) is
// excluded — that is normal re-alignment, not a loss worth warning about.
export function lostAlignedWords(beforeContent: unknown, afterContent: unknown): string[] {
  return analyzeAlignmentDelta(beforeContent, afterContent)
    .unexpectedLosses.filter((l) => l.reason === "lost")
    .map((l) => l.text);
}

// Byte-identity check for two verse `content` values (the { verseObjects }
// shape on VerseDto). Used by AlignmentPanel to tell a genuine content change
// (a foreign edit landing, a different verse) apart from a version-only bump
// — the panel's own save round-tripping through the outbox re-arrives with
// identical content under version+1 (#488). Both sides are the same
// usfm-js verseObjects tree with deterministic key order, so JSON string
// comparison is sufficient; this is the same "deepEqual" idiom already used
// by this module's own tests.
export function sameVerseContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// Should a re-sync REBASE the aligner panel's baseline in place (keep any
// in-flight drags, and the crash-draft tracking them) rather than doing a
// full reset (dropping drags back to the freshly-parsed content)? True only
// when BOTH the target verse's content and its source (UHB/UGNT) verse's
// content are byte-identical to what the panel last synced to — a genuine
// version-only bump with nothing else changed (#488).
//
// The source side matters as much as the target side: a UHB/UGNT source
// reimport landing while the panel has pending drags changes what
// `computedInitial` re-parses against, even though the TARGET verse's own
// content/version pair looks like an ordinary bump. Rebasing in that case
// would leave `state` (from the old source tree) attached to `initial` (the
// new source tree) — a save could then serialize alignment data pointing at
// source milestones the new tree no longer has. Requiring both sides to
// match forces that case onto the full-reset path instead (#508).
export function isVersionOnlyRebase(
  lastSynced: { content: unknown; sourceContent: unknown } | null,
  current: { content: unknown; sourceContent: unknown },
): boolean {
  if (!lastSynced) return false;
  return (
    sameVerseContent(lastSynced.content, current.content) &&
    sameVerseContent(lastSynced.sourceContent, current.sourceContent)
  );
}

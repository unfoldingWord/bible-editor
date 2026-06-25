// Resolve a matched English (ULT) span into the original-language quote +
// occurrence a TWL row needs — the in-browser equivalent of node-twl-generator's
// tsv-quote-converters step. This is the hard half of TWL suggestions: turning an
// automatically-matched English span into the exact {orig_words, occurrence}
// without a human click. It is BEST-EFFORT — `confident` is false (or the result
// is null) whenever the alignment is missing/ambiguous, and the Suggestions UI
// then opens the quote-builder pre-seeded so the editor confirms.
//
// Reuses the same machinery the quote-builder picker relies on:
//   collectTargetTokens  — ULT \w tokens + their \zaln-s source-ancestor chains
//   buildQuoteFromSelection — source-key set -> {quote, occurrence}

import { collectTargetTokens, buildQuoteFromSelection } from "./quoteBuilder.ts";
import type { HighlightKey } from "./highlight.ts";

export interface ResolvedQuote {
  orig_words: string;
  occurrence: number;
  // true only when a unique run was found AND every matched English word was
  // aligned to a source word. false ⇒ the editor should verify in the picker.
  confident: boolean;
}

// Normalize one word for comparison — lowercase, drop everything but letters/
// digits. Mirrors findSourceForTargetText's per-token fold so "Armies," and
// "Armies" compare equal and "{are}" reduces to "are".
function normWord(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Split an English span into comparison words. Strips USFM markers a pasted span
// might carry (\q1, \p, …) before the punctuation pass — same as
// findSourceForTargetText.
function spanWords(span: string): string[] {
  return span
    .replace(/\\[a-z]+\d*\*?/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function resolveSpanToSource(
  ultVerseObjects: unknown[] | null | undefined,
  uhbVerseObjects: unknown[] | null | undefined,
  englishSpan: string,
  glOccurrence: number,
): ResolvedQuote | null {
  if (!Array.isArray(ultVerseObjects) || !Array.isArray(uhbVerseObjects)) return null;
  const want = spanWords(englishSpan);
  if (want.length === 0) return null;

  const tokens = collectTargetTokens(ultVerseObjects);
  if (tokens.length === 0) return null;
  const normTokens = tokens.map((t) => normWord(t.text));

  // Every contiguous ULT token run that equals the span, in document order.
  const runStarts: number[] = [];
  for (let i = 0; i + want.length <= normTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (normTokens[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) runStarts.push(i);
  }
  if (runStarts.length === 0) return null;

  // Pick the glOccurrence-th run; fall back to the first (not confident) if the
  // occurrence index overshoots (counts can drift between the matcher's text
  // scan and the aligned token list).
  const occ = Math.max(1, glOccurrence | 0);
  let confident = true;
  let chosenStart = runStarts[occ - 1];
  if (chosenStart === undefined) {
    chosenStart = runStarts[0];
    confident = false;
  }

  const runTokens = tokens.slice(chosenStart, chosenStart + want.length);
  const keys = new Set<HighlightKey>();
  let allHaveSources = true;
  for (const t of runTokens) {
    if (t.sources.length === 0) allHaveSources = false;
    for (const s of t.sources) keys.add(s.key);
  }
  // Matched the English but none of it aligns to a source word — unusable.
  if (keys.size === 0) return null;

  const built = buildQuoteFromSelection(uhbVerseObjects, keys);
  if (!built) return null;

  return {
    orig_words: built.quote,
    occurrence: built.occurrence,
    confident: confident && allHaveSources,
  };
}

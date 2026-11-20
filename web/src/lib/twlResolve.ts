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

import { collectTargetTokens, buildQuoteFromSelection, type TargetToken } from "./quoteBuilder.ts";
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

// The ULT token run a suggestion's span names: every contiguous run that equals
// `want`, in document order, then the glOccurrence-th; the first (not
// confident) when the occurrence overshoots (counts can drift between the
// matcher's text scan and the aligned token list). Shared by the resolver and
// the bridge regroup below, so both always pick the same run.
function pickRun(
  tokens: TargetToken[],
  want: string[],
  glOccurrence: number,
): { start: number; confident: boolean } | null {
  if (tokens.length === 0 || want.length === 0) return null;
  const normTokens = tokens.map((t) => normWord(t.text));
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
  const occ = Math.max(1, glOccurrence | 0);
  const chosen = runStarts[occ - 1];
  return chosen === undefined ? { start: runStarts[0], confident: false } : { start: chosen, confident: true };
}

export function resolveSpanToSource(
  ultVerseObjects: unknown[] | null | undefined,
  uhbVerseObjects: unknown[] | null | undefined,
  englishSpan: string,
  glOccurrence: number,
  // The verse `uhbVerseObjects` is ("9:12"), when the ULT row is a bridge
  // resolved against one of its verses. English under a milestone whose x-ref
  // names another verse then contributes no source, so it can't resolve to
  // this verse's copy of the same word. Those tokens stay in the list, so the
  // run count still matches glOccurrence, which the suggest route counts over
  // the row's whole text (#1426).
  sourceRef?: string,
): ResolvedQuote | null {
  if (!Array.isArray(ultVerseObjects) || !Array.isArray(uhbVerseObjects)) return null;
  const want = spanWords(englishSpan);
  if (want.length === 0) return null;

  // Pass the UHB verse: collectTargetTokens needs it to pin joiner-variant
  // source twins and to apply the appears-once collapse. Without it, DAN 6:3's
  // two כָּל milestones (כָּ⁠ל with U+2060, then bare כָּל) both mint `כָּל|1`,
  // while buildQuoteFromSelection below keys the UHB tokens 1 and 2 — so the
  // SECOND English "all" resolved to the FIRST Hebrew word and returned it as
  // confident, writing the wrong orig_words onto a TWL row.
  const tokens = collectTargetTokens(ultVerseObjects, uhbVerseObjects, sourceRef);
  const run = pickRun(tokens, want, glOccurrence);
  if (!run) return null;
  let confident = run.confident;

  const runTokens = tokens.slice(run.start, run.start + want.length);
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

// Per-verse TWL suggestions for a bridged ULT row (#1432). The suggest route
// reads one D1 row per verse number, and a bridge is stored once under its
// start verse, so every suggestion for 9:10-12 arrives in the 9:10 group and
// 9:11 / 9:12 get none. Where tCore named each milestone's source verse
// (x-ref), move each suggestion to the verse its English is aligned in, so it
// is shown, resolved (with that verse's sourceRef) and added there.
// glOccurrence is left as is: it counts over the whole row, which is what
// resolveSpanToSource expects. A suggestion stays where it was fetched when its
// run is not found, is unaligned, carries no x-ref, mixes verses, or names a
// verse with no group. Never split by text position: a bridge's English need
// not follow verse order (2CH 9:10-12 UST reads 9:12, 9:10, then 9:11).
// `bridgedUltFor(verse)` returns the ULT verseObjects only when that verse's
// ULT row is a bridge; otherwise the group is left alone. Returns `groups`
// itself when nothing moves.
export function regroupTwlSuggestionsByXref<S extends { matchedText: string; glOccurrence: number }>(
  groups: { verse: number; suggestions: S[] }[],
  chapter: number,
  bridgedUltFor: (verse: number) => unknown[] | null | undefined,
): { verse: number; suggestions: S[] }[] {
  const has = new Set(groups.map((g) => g.verse));
  const moves: { from: number; s: S; to: number }[] = [];
  for (const g of groups) {
    const ult = bridgedUltFor(g.verse);
    if (!Array.isArray(ult) || g.suggestions.length === 0) continue;
    const tokens = collectTargetTokens(ult);
    for (const s of g.suggestions) {
      const want = spanWords(s.matchedText);
      const run = pickRun(tokens, want, s.glOccurrence);
      if (!run || !run.confident) continue;
      const refs = new Set<string>();
      let unnamed = false;
      for (const t of tokens.slice(run.start, run.start + want.length)) {
        for (const src of t.sources) {
          if (src.ref === undefined) unnamed = true;
          else refs.add(src.ref);
        }
      }
      if (unnamed || refs.size !== 1) continue;
      const m = /^(\d+):(\d+)$/.exec([...refs][0]);
      if (!m || Number(m[1]) !== chapter) continue;
      const to = Number(m[2]);
      if (to !== g.verse && has.has(to)) moves.push({ from: g.verse, s, to });
    }
  }
  if (moves.length === 0) return groups;
  const leaving = new Set(moves.map((x) => x.s));
  return groups.map((g) => ({
    verse: g.verse,
    suggestions: [
      ...g.suggestions.filter((s) => !leaving.has(s)),
      ...moves.filter((x) => x.to === g.verse).map((x) => x.s),
    ],
  }));
}

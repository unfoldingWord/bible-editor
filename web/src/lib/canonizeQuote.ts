// Mirror of api/src/canonizeHebrew.ts canonizeQuote — keep behavior in sync,
// including the fail-closed look-alike rules (byte-identical kept, ambiguous
// tier left as-is) that both copies carry since #959.
//
// Rewrites each word of a TN quote to the UHB's exact bytes. The quick note
// writer needs this at send time: the bp-assistant validator behind
// /api/tn-quick compares `hebrewGuess` to the UHB byte-for-byte without NFC,
// so an NFC-ordered word (e.g. כֹּ֥ה with holam before dagesh) is silently
// dropped (issue #959). Only canonizeQuote and the helpers it needs are
// mirrored; the alignment half (canonizeAlignmentSource) stays api-only.
//
// MATCHING. For each quote token, look up the UHB word by three progressively
// looser tiers and stop at the first hit:
//   1. exact      — NFC + joiners removed (only combining-mark ORDER differs)
//   2. stripped   — vowel points / cantillation removed (consonants + order)
//   3. wordJoiner — stripped, then U+2060 removed (quotes routinely drop it)
// A word already byte-identical to a UHB word is kept. Otherwise a tier hit is
// adopted only when every UHB word in that bucket has ONE surface; two distinct
// surfaces are AMBIGUOUS and the word is left as-is (no looser tier is tried).
// This is decided per word, independent of the quote's other words, so word
// order cannot change the outcome. Picking one of two look-alikes would move a
// quote onto another word, and translationCore counts occurrences per
// byte-distinct surface (see quoteExact in lint.ts). An unmatched token is
// LEFT AS-IS — the transform never guesses.

// Mirror of api/src/importParsers.ts SourceWord.
export interface SourceWord {
  text: string;
  strong: string;
  lemma: string;
  morph: string;
}

// Invisible joiners that carry no linguistic content but break byte equality:
// word joiner (U+2060), ZWJ (U+200D), BOM/ZWNBSP (U+FEFF).
const INVISIBLE_JOINERS = /[⁠‍﻿]/g;
const WORD_JOINER = /⁠/g;
// HEBREW PUNCTUATION MAQAF (U+05BE) — the "hyphen" that joins Hebrew words.
const MAQAF = "־";

// NFC + drop invisible joiners. Two strings that differ ONLY in combining-mark
// order (legacy UHB vs. NFC) fold together here.
function canonicalHebrew(text: string): string {
  return text.replace(INVISIBLE_JOINERS, "").normalize("NFC");
}

// Remove Hebrew points (vowels) and accents (cantillation) + the Masora circle,
// leaving consonants.
function stripHebrewMarks(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x0591 && c <= 0x05bd) || // accents + most points
      c === 0x05bf || // rafe
      (c >= 0x05c1 && c <= 0x05c2) || // shin/sin dot
      (c >= 0x05c4 && c <= 0x05c5) || // upper/lower dot
      c === 0x05c7 // qamats qatan
    ) {
      continue;
    }
    out += ch;
  }
  return out.normalize("NFC");
}

// Consonant skeleton with the word-joiner also removed.
function wordJoinerFold(text: string): string {
  return stripHebrewMarks(text).replace(WORD_JOINER, "");
}

// One UHB word, ready to be adopted.
interface UhbEntry {
  form: string; // UHB surface `\w text` — the exact bytes we adopt
}

// One tier's bucket, resolved fail-closed: undefined = no candidate (try the
// next tier); null = more than one distinct surface (ambiguous: stop, as
// canonizeAlignmentSource's pickCanonical does); otherwise the surface to adopt.
function soleForm(entries: UhbEntry[] | undefined): string | null | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.every((e) => e.form === entries[0].form) ? entries[0].form : null;
}

function push(map: Map<string, UhbEntry[]>, key: string, entry: UhbEntry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

interface TieredLookup {
  exact: Map<string, UhbEntry[]>;
  stripped: Map<string, UhbEntry[]>;
  joiner: Map<string, UhbEntry[]>;
}

// Quotes have no lemma/morph, so they key on the surface form alone.
function buildShortLookup(words: SourceWord[]): TieredLookup {
  const lk: TieredLookup = { exact: new Map(), stripped: new Map(), joiner: new Map() };
  for (const w of words) {
    const e: UhbEntry = { form: w.text };
    push(lk.exact, canonicalHebrew(w.text), e);
    push(lk.stripped, stripHebrewMarks(w.text), e);
    push(lk.joiner, wordJoinerFold(w.text), e);
  }
  return lk;
}

// Rewrite each word of a quote to the exact UHB bytes, preserving the original
// separators (space / maqaf). Returns the canonicalized quote, or the input
// unchanged if nothing matched. `strict` limits matching to the exact tier
// (for verse-RANGE quotes, where looser folds risk the wrong verse's word).
export function canonizeQuote(
  quote: string,
  uhbWords: SourceWord[],
  opts: { strict?: boolean } = {},
): string {
  if (!quote || uhbWords.length === 0) return quote;
  const strict = opts.strict ?? false;
  const lk = buildShortLookup(uhbWords);
  // Split keeping separators: even indices are words, odd indices are the
  // space/maqaf between them.
  const tokens = quote.split(new RegExp(`([ ${MAQAF}])`));
  let changed = false;
  for (let i = 0; i < tokens.length; i += 2) {
    const word = tokens[i];
    if (!word) continue;
    // A word already byte-identical to a UHB word is already canonical: keep it.
    const exact = lk.exact.get(canonicalHebrew(word));
    if (exact?.some((x) => x.form === word)) continue;
    let form = soleForm(exact);
    if (form === undefined && !strict) form = soleForm(lk.stripped.get(stripHebrewMarks(word)));
    if (form === undefined && !strict) form = soleForm(lk.joiner.get(wordJoinerFold(word)));
    if (form) {
      tokens[i] = form;
      changed = true;
    }
  }
  return changed ? tokens.join("") : quote;
}

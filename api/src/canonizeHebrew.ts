// Canonize resource Hebrew to byte-match the UHB source.
//
// Adapted from Stephen Wunrow's standalone `canonizeHebrew.mjs`. The original
// read `.usfm`/`.tsv` off disk and rewrote them line-by-line; this port keeps
// the matching ALGORITHM (the valuable part) and drops the file I/O — it works
// on the in-memory shapes bible-editor already has: usfm-js `verseObjects` for
// ULT/UST alignment, and a plain quote string for TN/TWL rows. The UHB is read
// from D1 by the caller (see collectSourceWords / loadUhbSourceWords) and passed
// in as SourceWord[], so this module is pure and unit-testable.
//
// WHY. The UHB stores combining marks in traditional Tanakh order (dagesh before
// vowel); AI-emitted `\zaln-s x-content`, TN quotes, and ZEC/LAM milestones come
// out in NFC order. They're visually identical but fail byte equality, which is
// why every Hebrew↔Hebrew compare currently has to fold to NFC on the fly
// (docs/hebrew-normalization.md). This is "the upstream fix" that doc names:
// rewrite the resource's Hebrew to the UHB's EXACT bytes so downstream storage,
// export, and comparison all see one representation. It complements — does not
// replace — the compare-layer nfc() folds, which stay as a safety net.
//
// MATCHING. For each resource token we look up the UHB word by three
// progressively looser tiers and STOP at the first hit:
//   1. exact      — NFC + joiners removed (only combining-mark ORDER differs)
//   2. stripped   — vowel points / cantillation removed (consonants + order)
//   3. wordJoiner — stripped, then U+2060 removed (quotes routinely drop it)
// A matched UHB word is CONSUMED (found flag) so a second resource token can't
// claim it — this keeps two same-skeleton-but-differently-pointed words mapping
// to distinct UHB words. On a hit we adopt the UHB's exact surface (and lemma,
// for alignment); an unmatched token is LEFT AS-IS — the transform never guesses.
// canonizeQuote also keeps a word that is already byte-identical to a UHB word,
// and fails closed when a tier's unused candidates have more than one distinct
// surface (see pickUnused).

import type { SourceWord } from "./importParsers";

// ── Folds (mirror the three tiers) ──────────────────────────────────────────

// Invisible joiners that carry no linguistic content but break byte equality:
// word joiner (U+2060), ZWJ (U+200D), BOM/ZWNBSP (U+FEFF).
const INVISIBLE_JOINERS = /[⁠‍﻿]/g;
const WORD_JOINER = /⁠/g;
// HEBREW PUNCTUATION MAQAF (U+05BE) — the "hyphen" that joins Hebrew words.
const MAQAF = "־";

// NFC + drop invisible joiners. Two strings that differ ONLY in combining-mark
// order (legacy UHB vs. NFC) fold together here. Strips nothing linguistic.
function canonicalHebrew(text: string): string {
  return text.replace(INVISIBLE_JOINERS, "").normalize("NFC");
}

// Remove Hebrew points (vowels) and accents (cantillation) + the Masora circle,
// leaving consonants. Mirrors the Python/mjs original's ranges exactly.
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

// Consonant skeleton with the word-joiner also removed. TN/TQ quotes routinely
// omit the U+2060 the UHB token carries (e.g. ZEC 4:10), so this is the loosest
// tier that still keys on real letters.
function wordJoinerFold(text: string): string {
  return stripHebrewMarks(text).replace(WORD_JOINER, "");
}

// ── Lookup tables ───────────────────────────────────────────────────────────

// One UHB word, ready to be adopted. `found` is consumed as tokens match it.
interface UhbEntry {
  form: string; // UHB surface `\w text` — the exact bytes we adopt
  lemma: string; // UHB lemma — adopted for alignment milestones
  found: boolean;
}

const SEP = " "; // key separator that can't occur inside a Hebrew word

// The unused entries of one tier's bucket, resolved fail-closed: undefined = no
// candidate (try the next tier); null = candidates with more than one distinct
// surface (ambiguous: leave the word as-is and stop, as canonizeAlignmentSource's
// pickCanonical does); otherwise the entry to adopt. Picking the first of two
// look-alikes would move the quote onto another word, and translationCore
// counts occurrences per byte-distinct surface (see quoteExact in lint.ts).
function pickUnused(entries: UhbEntry[] | undefined): UhbEntry | null | undefined {
  const free = entries?.filter((e) => !e.found) ?? [];
  if (free.length === 0) return undefined;
  return free.every((e) => e.form === free[0].form) ? free[0] : null;
}

function push(map: Map<string, UhbEntry[]>, key: string, entry: UhbEntry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

// A three-tier lookup keyed by the same fold family. Alignment keys include
// lemma + morph; quotes key on the surface alone (see the two builders below).
interface TieredLookup {
  exact: Map<string, UhbEntry[]>;
  stripped: Map<string, UhbEntry[]>;
  joiner: Map<string, UhbEntry[]>;
}

function emptyLookup(): TieredLookup {
  return { exact: new Map(), stripped: new Map(), joiner: new Map() };
}

// Key an alignment milestone to its UHB word by Strong's number + surface form
// (folded), NOT lemma/morph. This codebase's source identity is Strong-based
// (see milestoneSourceKey / healReplacementChars in importParsers.ts), and valid
// `\zaln-s` milestones may omit x-lemma / x-morph while always carrying x-strong
// + x-content — keying on lemma/morph would silently skip those rows and leave
// their bad byte order. Strong narrows homographs; the fold tiers + the
// fail-closed ambiguity guard (pickCanonical) cover the rest. The original's
// (lemma, form, morph) key was for a file-based script without Strong's to hand.
function buildFullLookup(words: SourceWord[]): TieredLookup {
  const lk = emptyLookup();
  for (const w of words) {
    const e: UhbEntry = { form: w.text, lemma: w.lemma, found: false };
    push(lk.exact, w.strong + SEP + canonicalHebrew(w.text), e);
    push(lk.stripped, w.strong + SEP + stripHebrewMarks(w.text), e);
    push(lk.joiner, w.strong + SEP + wordJoinerFold(w.text), e);
  }
  return lk;
}

// TSV quotes have no lemma/morph, so they key on the surface form alone
// (mirrors the original's "short" lookups). Fresh entries → their own `found`
// flags, independent of any alignment lookup.
function buildShortLookup(words: SourceWord[]): TieredLookup {
  const lk = emptyLookup();
  for (const w of words) {
    const e: UhbEntry = { form: w.text, lemma: w.lemma, found: false };
    push(lk.exact, canonicalHebrew(w.text), e);
    push(lk.stripped, stripHebrewMarks(w.text), e);
    push(lk.joiner, wordJoinerFold(w.text), e);
  }
  return lk;
}

// ── Public API ──────────────────────────────────────────────────────────────

// Rewrite each `\zaln-s` milestone's x-content (and x-lemma) to the exact UHB
// bytes. Mutates `verseObjects` in place (like healReplacementChars) — it only
// reassigns string attributes on existing milestone nodes, so it can never
// unalign a word. Returns the number of milestones actually changed (0 = no-op).
// Adopt a fold bucket's canonical (form, lemma) ONLY when every UHB word matching
// that fold key is byte-identical. Returns `undefined` when the tier has no
// match (try the next tier), `null` when the match is AMBIGUOUS (fail closed —
// leave the milestone untouched), or the value to adopt.
//
// Why fail closed: target-alignment order can differ from source order, so a
// walk-order "take the next unused entry" scheme can hand a milestone the WRONG
// source word — e.g. a verse with בֹא (occ 1) and בָא (occ 2), both stripping to
// the skeleton בא, whose English reorders occ 2 before occ 1: consuming by walk
// order writes occ 1's pointing onto occ 2 (silent corruption of `x-content`).
// We can't disambiguate two same-skeleton words from a bare surface without
// trusting occurrence (unreliable here — see project_source_words_no_occurrence),
// so we don't guess. The EXACT tier keeps pointing, so distinct-pointing words
// land in distinct buckets and still canonize; only under-pointed surfaces over
// an ambiguous skeleton fall through to a fail-closed no-op.
function pickCanonical(bucket: UhbEntry[] | undefined): { form: string; lemma: string } | null | undefined {
  if (!bucket || bucket.length === 0) return undefined;
  const first = bucket[0];
  for (const e of bucket) {
    if (e.form !== first.form || e.lemma !== first.lemma) return null;
  }
  return { form: first.form, lemma: first.lemma };
}

export function canonizeAlignmentSource(verseObjects: unknown[], uhbWords: SourceWord[]): number {
  if (!Array.isArray(verseObjects) || uhbWords.length === 0) return 0;
  const lk = buildFullLookup(uhbWords);
  let changed = 0;
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      const o = node as Record<string, unknown> | null;
      if (!o || typeof o !== "object") continue;
      if (o["type"] === "milestone" && o["tag"] === "zaln" && typeof o["content"] === "string") {
        const form = o["content"] as string;
        const lemma = typeof o["lemma"] === "string" ? (o["lemma"] as string) : "";
        const strong = typeof o["strong"] === "string" ? (o["strong"] as string) : "";
        // Fall through tiers only on "no match" (undefined); an AMBIGUOUS tier
        // (null) stops the search and fails closed — a looser tier can only be
        // more ambiguous. Buckets are read statelessly, so a source word aligned
        // to non-contiguous target words (repeated milestones, e.g. אָמַר split
        // around "Moses" in "And Moses said") resolves the same for every repeat.
        let adopt = pickCanonical(lk.exact.get(strong + SEP + canonicalHebrew(form)));
        if (adopt === undefined) {
          adopt = pickCanonical(lk.stripped.get(strong + SEP + stripHebrewMarks(form)));
        }
        if (adopt === undefined) {
          adopt = pickCanonical(lk.joiner.get(strong + SEP + wordJoinerFold(form)));
        }
        if (adopt) {
          let hit = false;
          if (o["content"] !== adopt.form) {
            o["content"] = adopt.form;
            hit = true;
          }
          // Only adopt the UHB lemma when the milestone already carries one and
          // it differs — never invent a lemma on a milestone that lacks it.
          if (lemma !== "" && adopt.lemma !== "" && o["lemma"] !== adopt.lemma) {
            o["lemma"] = adopt.lemma;
            hit = true;
          }
          if (hit) changed += 1;
        }
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(verseObjects);
  return changed;
}

// Rewrite each word of a TN/TWL quote to the exact UHB bytes, preserving the
// original separators (space / maqaf). Returns the canonicalized quote, or the
// input unchanged if nothing matched.
//
// `strict` limits matching to the exact tier — use it for verse-RANGE quotes,
// where the looser consonant folds risk grabbing a same-skeleton word from the
// wrong verse (mirrors the original's verse-range guard).
export function canonizeQuote(
  quote: string,
  uhbWords: SourceWord[],
  opts: { strict?: boolean } = {},
): string {
  if (!quote || uhbWords.length === 0) return quote;
  const strict = opts.strict ?? false;
  const lk = buildShortLookup(uhbWords);
  // Split keeping separators: even indices are words, odd indices are the
  // space/maqaf between them. Rebuilding from this array avoids the original's
  // regex-replace-on-Hebrew (which could match the wrong occurrence).
  const tokens = quote.split(new RegExp(`([ ${MAQAF}])`));
  let changed = false;
  for (let i = 0; i < tokens.length; i += 2) {
    const word = tokens[i];
    if (!word) continue;
    // A word already byte-identical to a UHB word is already canonical: keep it.
    const exact = lk.exact.get(canonicalHebrew(word));
    let e: UhbEntry | null | undefined = exact?.find((x) => !x.found && x.form === word);
    if (!e) {
      e = pickUnused(exact);
      if (e === undefined && !strict) e = pickUnused(lk.stripped.get(stripHebrewMarks(word)));
      if (e === undefined && !strict) e = pickUnused(lk.joiner.get(wordJoinerFold(word)));
    }
    if (e) {
      e.found = true;
      if (word !== e.form) {
        tokens[i] = e.form;
        changed = true;
      }
    }
  }
  return changed ? tokens.join("") : quote;
}

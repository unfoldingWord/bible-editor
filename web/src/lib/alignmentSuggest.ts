// Pure scoring/matching for non-AI alignment suggestions (the "ghost" chips).
//
// Extracted from AlignmentPanel so this same logic runs both in the app and in
// the offline eval harness (scripts/eval-aligner.mjs, via Node
// --experimental-strip-types) — the eval is only honest if it scores exactly
// what ships. NO React/MUI imports here; AlignmentGroup is a type-only import
// so Node strips it and never loads the React-bearing modules.
//
// Scoring follows wordMAP's real design (node_modules/wordmap/dist): confidence
// is a weighted AVERAGE of independent [0,1] signals
// (Engine.calculateWeightedConfidence), NOT a product — so a weak signal is
// diluted, never zeroing an otherwise-strong candidate. We reproduce the subset
// of wordMAP's metrics that need only the current verse (no corpus):
//   • memory frequency share   (the endpoint's per-candidate confidence)
//   • alignment position       (AlignmentPosition: 1 - |srcRel - tgtRel|)
//   • occurrence balance       (AlignmentOccurrences: min/max of in-verse counts)
// Uniqueness/IDF arrives in Phase 2 as one more averaged term; corpus
// co-occurrence in Phase 3. See docs/alignment-suggestions.md.

import type { AlignmentGroup } from "./alignment";

export interface AlignCandidate {
  surface: string; // lowercased target surface, e.g. "beginning"
  confidence: number; // 0..1
  source: "memory" | "lexicon";
  count?: number; // corpus frequency (memory only)
}

export interface AlignPhrase {
  phrase: string; // e.g. "the earth"
  tokens: string[]; // ["the","earth"]
  confidence: number; // 0..1
  count: number;
}

export interface AlignSuggestion {
  words: AlignCandidate[];
  phrases: AlignPhrase[];
}

export interface Ghost {
  groupId: string;
  wordIds: string[]; // one word, or several for a phrase ("the earth")
  text: string; // display label — the matched words, original case
  confidence: number;
  source: "memory" | "lexicon";
}

export type StreamWord = { id: string; text: string; aligned: boolean };

// Coarse morph class for the (strong, morph) suggestion key. MIRROR of
// scripts/lib/align-corpus.mjs `morphClass` — the trainer builds align_freq_morph
// with the same function, so keep the two in sync. Full head-morpheme feature
// string after the language prefix and any clitic ":" (e.g. "He,Ncmsc" ->
// "Ncmsc").
export function morphClass(morph: string | undefined): string {
  if (!morph) return "";
  const parts = String(morph).split(",");
  const body = parts.length > 1 ? parts.slice(1).join(",") : parts[0];
  return body.split(":").pop() || body;
}

// The per-source-word suggestion key the endpoint expects: "<rawStrong>~<morph>".
export function suggestKey(strong: string, morph: string | undefined): string {
  return `${strong}~${morphClass(morph)}`;
}

export function ghostPipColor(c: number): string {
  if (c >= 0.6) return "#4caf50"; // confident
  if (c >= 0.35) return "#E59D33"; // plausible (brand Kindle)
  return "#9e9e9e"; // weak
}

// Light stemmer so "besprinkled" ↔ "sprinkle"-ish and plural/tense variants
// still match. The memory path mostly matches exactly (same translation), so
// this only rescues inflection and the lexicon-gloss fallback.
function stemWord(w: string): string {
  let s = w.toLowerCase().normalize("NFC").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  s = s.replace(/'s$/, "");
  for (const suf of ["ing", "edly", "ed", "es", "ly", "s"]) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) return s.slice(0, -suf.length);
  }
  return s;
}
export function surfaceMatch(candidate: string, word: string): boolean {
  const a = candidate.toLowerCase().normalize("NFC");
  const b = word.toLowerCase().normalize("NFC");
  if (a === b) return true;
  const sa = stemWord(a);
  return sa.length >= 3 && sa === stemWord(b);
}

// ── the blend ─────────────────────────────────────────────────────────────
// Weights seeded from wordMAP (alignmentPosition 0.7, frequency 0.7,
// occurrences 0.4) but tuned against the held-out eval (scripts/eval-aligner).
// Kept in one place so retuning — or serving them from the Worker later — is a
// single edit.
export const BLEND_WEIGHTS = { freq: 0.7, position: 0.7, occurrence: 0.4 };

function weightedAverage(parts: { score: number; weight: number }[]): number {
  let scoreSum = 0;
  let weightSum = 0;
  for (const p of parts) {
    scoreSum += p.score * p.weight;
    weightSum += p.weight;
  }
  return weightSum ? scoreSum / weightSum : 0;
}

// AlignmentOccurrences: reward a source word that occurs N times aligning to a
// target that also occurs ~N times. Both counts are >= 1 in practice.
function occurrenceBalance(srcOcc: number, tgtOcc: number): number {
  if (srcOcc <= 0 || tgtOcc <= 0) return 0;
  return Math.min(srcOcc, tgtOcc) / Math.max(srcOcc, tgtOcc);
}

// rel position of a token, mirroring wordMAP AlignmentPosition: (1 + i) / len.
function rel(index: number, length: number): number {
  return length > 0 ? (index + 1) / length : 0;
}

function blend(
  freqConf: number,
  srcRel: number,
  tgtRel: number,
  srcOcc: number,
  tgtOcc: number,
): number {
  const position = 1 - Math.abs(srcRel - tgtRel);
  return weightedAverage([
    { score: freqConf, weight: BLEND_WEIGHTS.freq },
    { score: position, weight: BLEND_WEIGHTS.position },
    { score: occurrenceBalance(srcOcc, tgtOcc), weight: BLEND_WEIGHTS.occurrence },
  ]);
}

// Stable identity for a dismissed ghost — "the user rejected suggesting
// <target text> for <this source group>". The source side mirrors
// AlignmentPanel's sourceKey (each source word's content + occurrence); the
// target side is the matched surface normalized the way surfaceMatch compares
// (lowercase + NFC) so casing / cantillation don't fork the key. Lives here so
// the dismiss handler (AlignmentPanel) and the suppression (computeGhosts)
// derive the exact same string from the same group objects. The \u0001
// separator can't appear in content or target text, so src/text never blur.
export function dismissedGhostKey(group: AlignmentGroup, text: string): string {
  const src = group.source
    .map((s) => `${(s.content ?? "").normalize("NFC")}|${s.occurrence}`)
    .join("~");
  return `${src}\u0001${text.toLowerCase().normalize("NFC")}`;
}

// ── Hebrew direct object marker (Strong's H0853, אֵת / אֶת) ─────────────────
// The accusative particle carries no independent English meaning
// ("[as such unrepresented in English]"), so on its own it must never draw a
// target suggestion. Two carve-outs, both decided from morph/strong:
//   • a conjunction vav (וְאֵת — strong "c:H0853", morph "He,C:To") may align to
//     "and", and ONLY "and";
//   • a pronominal suffix (אֹתוֹ "him", morph "He,To:Sp3ms") gives it real
//     English content, so it keeps normal suggestions.
// Fires ONLY for an *ungrouped* marker (a one-source-word group). When the
// marker is grouped with its object noun, the group inherits the noun's
// suggestion — so we leave compound groups alone.
function isObjectMarkerStrong(strong: string | undefined): boolean {
  const m = /([HG])0*(\d+)/i.exec(strong ?? "");
  return !!m && m[1].toUpperCase() === "H" && m[2] === "853";
}

export type ObjectMarkerRule = "skip" | "andOnly" | null;
export function objectMarkerRule(group: AlignmentGroup): ObjectMarkerRule {
  if (group.source.length !== 1) return null; // grouped → inherits the other word
  const s = group.source[0];
  if (!isObjectMarkerStrong(s.strong)) return null;
  // A pronominal suffix (…:Sp…) makes it "him"/"them"/… — real content; leave it.
  if (/:Sp/i.test(s.morph ?? "")) return null;
  // Conjunction vav → "and" only; otherwise nothing. The vav shows up as the
  // "c:" strong clitic, a "C" morph segment, or a leading waw in the surface.
  const hasVav =
    /(^|:)c:/i.test(s.strong ?? "") ||
    /(^|,)C(:|,|$)/.test(s.morph ?? "") ||
    (s.content ?? "").normalize("NFC").startsWith("ו");
  return hasVav ? "andOnly" : "skip";
}

// The single permitted candidate for a vav-prefixed object marker.
const AND_ONLY_CANDIDATES: AlignCandidate[] = [
  { surface: "and", confidence: 1, source: "memory" },
];

// Build ghosts for empty groups. Two passes (phrases first so "the earth" stays
// whole, then single words), each claiming words immediately so repeated source
// words distribute across their occurrences. Within a pass, every candidate is
// scored at every still-unclaimed match location by the blend and the group
// takes its single best-scoring option — this is the principled, position-aware
// version of the old source-order greedy: the 1st instance of a repeated word
// prefers the earlier target occurrence, the 2nd the later.
export function computeGhosts(
  groups: AlignmentGroup[],
  streamWords: StreamWord[],
  suggestions: Record<string, AlignSuggestion>,
  // Session-scoped rejections, keyed by dismissedGhostKey(group, text). A
  // dismissed candidate is skipped during scoring so the NEXT-best suggestion
  // surfaces (or the group goes blank) — never the rejected one again.
  dismissed: Set<string> = new Set(),
): Map<string, Ghost> {
  const result = new Map<string, Ghost>();
  const claimed = new Set<string>();
  const numStream = streamWords.length;
  if (numStream === 0) return result;
  const numGroups = groups.length || 1;

  // In-verse occurrence counts: per source strong (across groups) and per
  // target surface (across the word bank), for the occurrence-balance signal.
  const srcOccByStrong = new Map<string, number>();
  for (const g of groups) {
    const seen = new Set<string>();
    for (const s of g.source) {
      if (seen.has(s.strong)) continue;
      seen.add(s.strong);
      srcOccByStrong.set(s.strong, (srcOccByStrong.get(s.strong) ?? 0) + 1);
    }
  }
  const tgtOccCache = new Map<string, number>();
  const tgtOcc = (surface: string): number => {
    const hit = tgtOccCache.get(surface);
    if (hit !== undefined) return hit;
    let n = 0;
    for (const w of streamWords) if (surfaceMatch(surface, w.text)) n++;
    tgtOccCache.set(surface, n);
    return n;
  };

  const groupOrder = new Map<string, number>();
  groups.forEach((g, i) => groupOrder.set(g.id, i));
  const srcRelOf = (g: AlignmentGroup) => rel(groupOrder.get(g.id) ?? 0, numGroups);

  const emptyGroups = groups.filter((g) => g.targets.length === 0);

  // Object-marker rule, computed once per empty group (see objectMarkerRule).
  const omRule = new Map<string, Exclude<ObjectMarkerRule, null>>();
  for (const g of emptyGroups) {
    const r = objectMarkerRule(g);
    if (r) omRule.set(g.id, r);
  }

  // Pass 1 — phrases.
  for (const g of emptyGroups) {
    // The object marker only ever takes the single word "and" (or nothing), so
    // it's resolved entirely in the word pass — never a phrase.
    if (omRule.has(g.id)) continue;
    const srcRel = srcRelOf(g);
    let best: { score: number; run: StreamWord[] } | null = null;
    for (const s of g.source) {
      const srcOcc = srcOccByStrong.get(s.strong) ?? 1;
      for (const p of suggestions[suggestKey(s.strong, s.morph)]?.phrases ?? []) {
        const len = p.tokens.length;
        for (let i = 0; i + len <= numStream; i++) {
          let ok = true;
          for (let j = 0; j < len; j++) {
            const w = streamWords[i + j];
            if (w.aligned || claimed.has(w.id) || !surfaceMatch(p.tokens[j], w.text)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          const run = streamWords.slice(i, i + len);
          if (dismissed.has(dismissedGhostKey(g, run.map((w) => w.text).join(" ")))) continue;
          const tgtRel = rel(i + (len - 1) / 2, numStream);
          // occurrence neutral for phrases (they're effectively unique)
          const score = blend(p.confidence, srcRel, tgtRel, srcOcc, srcOcc);
          if (!best || score > best.score) best = { score, run };
        }
      }
    }
    if (best) {
      best.run.forEach((w) => claimed.add(w.id));
      result.set(g.id, {
        groupId: g.id,
        wordIds: best.run.map((w) => w.id),
        text: best.run.map((w) => w.text).join(" "),
        confidence: best.score,
        source: "memory",
      });
    }
  }

  // Pass 2 — single-word fallback for still-empty groups.
  for (const g of emptyGroups) {
    if (result.has(g.id)) continue;
    const rule = omRule.get(g.id);
    if (rule === "skip") continue; // bare object marker → no suggestion at all
    const srcRel = srcRelOf(g);
    let best: { score: number; word: StreamWord; source: "memory" | "lexicon" } | null = null;
    for (const s of g.source) {
      const srcOcc = srcOccByStrong.get(s.strong) ?? 1;
      const cands =
        rule === "andOnly" ? AND_ONLY_CANDIDATES : suggestions[suggestKey(s.strong, s.morph)]?.words ?? [];
      for (const cand of cands) {
        const occ = tgtOcc(cand.surface);
        for (let wi = 0; wi < numStream; wi++) {
          const w = streamWords[wi];
          if (w.aligned || claimed.has(w.id) || !surfaceMatch(cand.surface, w.text)) continue;
          if (dismissed.has(dismissedGhostKey(g, w.text))) continue;
          const score = blend(cand.confidence, srcRel, rel(wi, numStream), srcOcc, occ);
          if (!best || score > best.score) best = { score, word: w, source: cand.source };
        }
      }
    }
    if (best) {
      claimed.add(best.word.id);
      result.set(g.id, {
        groupId: g.id,
        wordIds: [best.word.id],
        text: best.word.text,
        confidence: best.score,
        source: best.source,
      });
    }
  }
  return result;
}

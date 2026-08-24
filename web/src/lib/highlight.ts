// When a tn row is "active," its `quote` field (a sequence of Hebrew/Greek
// source words) should be visually mapped onto the active verse:
//
//   - In ULT / UST (which carry \zaln-s milestones): highlight the target
//     gateway-language `\w` tokens that are children of the milestone(s)
//     whose `content` matches each quote word.
//   - In UHB / UGNT (which ARE the source): highlight the `\w` tokens whose
//     text matches each quote word directly.
//
// Quotes may include gap markers — "&", "...", "…" — for non-contiguous
// references. Gap markers split the quote into GROUPS; within a group
// (words joined by whitespace or maqaf ־) the match must be exactly
// adjacent in document order, but between groups we tolerate intervening
// unmatched tokens. That distinction is what stops "כָּל־הַגֹּנֵב" from
// grabbing an earlier stray "כָּל" that sits several words upstream of
// "הַגֹּנֵב". `occurrence` (1-based) picks the Nth match when the same
// phrase appears multiple times in a verse.
//
// Hebrew note: TN/TQ quote text typically arrives NFC-normalized while UHB
// stores legacy combining-mark order (see lib/hebrew.ts), so all source-
// text equality checks go through `matchNorm()` (NFC + joiner stripping).
// The Set keys still carry the RAW verseObjects text — the consumer
// (HebrewLine, renderHighlightedHTML) reads from the same tree, so raw
// matches raw with no further work.

import { nfc } from "./hebrew.ts";
import { isInFlowMarker, isTsMilestone, liftMarkerText, SECTION_HEADER_TAGS } from "./usfm.ts";

// U+2060 WORD JOINER glues UHB clitic morphemes to their host word
// (הָ⁠אֶ֧בֶן); U+200D ZERO WIDTH JOINER plays the same role in some corpora.
// They are format characters — nfc() does NOT fold them away — and TN/TQ
// quote text routinely omits them (5 of 302 seeded ZEC quotes, e.g. ZEC
// 4:10's הָאֶ֧בֶן), so every quote↔token EQUALITY check strips them from
// BOTH sides. Matching only: stored text, rendered text, and HighlightKey
// sets keep the raw joiners.
export function matchNorm(s: string): string {
  return nfc(s).replace(/[\u2060\u200d]/g, "");
}

// `occurrence` is the token's OWN `x-occurrence` attribute (defaulting to 1).
// `surfaceOccurrence` — set only for SOURCE tokens (collectBareWords) — is the
// token's 1-based position among same-surface tokens in the verse, counted
// here rather than read. They agree on well-formed data, but imported UHB/UGNT
// `\w` tokens carry NO x-occurrence at all, so only the counted value can name
// "the 2nd לֹא" — which is exactly what a GL `\zaln-s` x-occurrence refers to.
export type WordToken = { text: string; occurrence: number; surfaceOccurrence?: number };
type Run = { source: string; occurrence: number; targets: WordToken[] };

const GAP = /[&…]+|\.{3}/g;

// Parse quote into contiguous-word groups separated by explicit gap markers.
// Inside a group, words must be exactly adjacent in the verse; between groups,
// the matcher allows any number of intervening tokens — the next group may sit
// anywhere later in the verse. That matches quoteBuilder's matchGroupsAt (the
// reverse direction that authors the quote + occurrence), so a discontinuous
// quote it produces always highlights back. Discontinuous quotes routinely
// span most of a verse (e.g. ZEC 5:4 וּבָאָה & וְלָנֶה & וְכִלַּתּוּ — first,
// middle, and near-last word), so any fixed cap produces false negatives.
function quoteGroups(quote: string): string[][] {
  if (!quote) return [];
  return quote
    .split(GAP)
    .map((segment) =>
      segment
        .split(/[\s־]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    )
    .filter((g) => g.length > 0);
}

// Try to match `groups` against `normSources` starting at index `start`.
// Returns the list of matched indices (document order) on success, or null.
// First group must align at `start`; later groups slide forward looking for
// an exact-adjacent run, anywhere up to the end of `normSources`.
function matchGroupsAt(
  start: number,
  groups: string[][],
  normSources: string[],
): number[] | null {
  const matched: number[] = [];
  let pos = start;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    let runStart: number;
    if (gi === 0) {
      if (pos + group.length > normSources.length) return null;
      for (let wi = 0; wi < group.length; wi++) {
        if (normSources[pos + wi] !== group[wi]) return null;
      }
      runStart = pos;
    } else {
      const maxStart = normSources.length - group.length;
      let found = -1;
      for (let s = pos; s <= maxStart; s++) {
        let ok = true;
        for (let wi = 0; wi < group.length; wi++) {
          if (normSources[s + wi] !== group[wi]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          found = s;
          break;
        }
      }
      if (found < 0) return null;
      runStart = found;
    }
    for (let wi = 0; wi < group.length; wi++) matched.push(runStart + wi);
    pos = runStart + group.length;
  }
  return matched;
}

function nodeIsMilestone(n: unknown): n is Record<string, unknown> {
  const o = n as Record<string, unknown> | null;
  return !!o && o["type"] === "milestone" && o["tag"] === "zaln";
}

function nodeIsWord(n: unknown): n is Record<string, unknown> {
  const o = n as Record<string, unknown> | null;
  return !!o && o["type"] === "word" && o["tag"] === "w";
}

// \d (Psalm superscription) is `type:"section"` but its content IS
// alignable Hebrew verse body — the renderer already descends into it
// (see segmentByParagraphs); the matchers must too or a quote on a
// superscription word never highlights.
function nodeIsPsalmTitle(n: unknown): n is Record<string, unknown> {
  const o = n as Record<string, unknown> | null;
  return !!o && o["type"] === "section" && o["tag"] === "d";
}

// Collect every `\w` token in a subtree (descending through nested milestones
// and \d sections), in document order. A merge group serializes as a chain of
// nested `\zaln-s` with ALL its target words at the innermost level, so a run's
// `targets` must be its whole subtree — see collectMilestoneRuns / atomic-group
// note below.
function collectSubtreeWords(children: unknown[]): WordToken[] {
  const out: WordToken[] = [];
  function walk(nodes: unknown[]) {
    for (const c of nodes ?? []) {
      if (nodeIsWord(c)) {
        out.push({
          text: String((c as Record<string, unknown>)["text"] ?? ""),
          occurrence:
            parseInt(String((c as Record<string, unknown>)["occurrence"] ?? "1"), 10) || 1,
        });
      } else if (nodeIsMilestone(c) || nodeIsPsalmTitle(c)) {
        walk(((c as Record<string, unknown>)["children"] as unknown[] | undefined) ?? []);
      }
    }
  }
  walk(children);
  return out;
}

// Flatten the verse tree into one Run per zaln milestone (nested milestones
// become their own runs in document order). Each run's `targets` is its FULL
// subtree of `\w` tokens, not just direct children. Nested `\zaln-s` encode a
// MERGE GROUP (N source words ↔ M target words) whose target words all sit at
// the innermost level; treating each level's targets as the whole subtree makes
// the highlight ATOMIC — quoting ANY source word in the chain lights the whole
// group, regardless of nesting depth (matching tC / gatewayEdit). With only the
// direct children, an outer source word (whose direct children are the nested
// milestone, not words) would highlight nothing while the innermost lit
// everything — an indefensible depth-dependent asymmetry. Disjoint sibling
// alignments stay disjoint because each subtree is scoped to its own milestone.
//
// Split-gloss healing: an AI/tC aligner sometimes renders a single source
// token whose target words are NON-CONTIGUOUS as two separate `\zaln-s` runs
// with the same content. Two shapes occur in prod:
//   1. ZEC 6:2 בַּ⁠מֶּרְכָּבָה → "In the" … (interrupted by "first") … "chariot",
//      where the 2nd span is stamped occurrence="2" while occurrences stays
//      "1" — impossible ("the 2nd of 1").
//   2. ZEC 6:5 וַ⁠יַּעַן → "And" … (interrupted by "the angel") … "answered",
//      where EVERY span keeps occurrence="1"/occurrences="1".
// Both describe the same logical token. Fold each run into the nearest
// preceding run with the SAME content AND the same EFFECTIVE occurrence
// (clamped into [1, occurrences]), so the matcher sees ONE token carrying
// ALL its target words. A genuinely repeated word carries a DISTINCT
// occurrence (occ=1/2 vs 2/2 → effective 1 vs 2), so it never false-merges.
// Mirrors effectiveOccurrence / sameSourceChain in lib/alignment.ts.
//
// Shape 1 above assumes the bogus continuation over-claims `occurrence` while
// `occurrences` stays honest, so clamping into [1, occurrences] folds it back.
// A third prod shape defeats that: BOTH are inflated. ZEC 11:16 UST stamps
// וּבְשַׂר, וּפַרְסֵיהֶן and וְהַנִּשְׁבֶּרֶת as 1/2 AND 2/2 even though each
// occurs exactly ONCE in the UHB verse, so the clamp is a no-op, the two spans
// stay separate runs, and the second one ("the meat of", "their hooves") never
// joins — the visible bug in issue #371. `sourceTotals` (when the OL verse is
// available) supplies the real count so the clamp becomes
// [1, min(occurrences, trueTotal)]. This is the same appears-once rule
// lib/sourceOccurrences.ts applies as a data fix, and it is equally
// conservative: a token that genuinely appears 2+ times is left alone, because
// which physical token an over-claiming milestone meant is unknowable.
//
// Raw (unmerged) milestone entry, document order — Pass 1 of
// collectMilestoneRuns below.
interface RawRun {
  source: string;
  occurrence: number;
  occurrences: number;
  targets: WordToken[];
}

// Pass 1: walk the tree exactly as the old single-pass implementation did
// (same recursion into nested milestones, same \d handling), but WITHOUT
// merging — just record every milestone's raw (content, occurrence,
// occurrences, targets) in document order. Pass 2/3 below operate on this
// flat list.
function collectRawRuns(verseObjects: unknown[]): RawRun[] {
  const out: RawRun[] = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      if (nodeIsPsalmTitle(node)) {
        walk((node["children"] as unknown[] | undefined) ?? []);
        continue;
      }
      if (!nodeIsMilestone(node)) continue;
      const source = String(node["content"] ?? "");
      const occurrence = parseInt(String(node["occurrence"] ?? "1"), 10) || 1;
      const occurrences = parseInt(String(node["occurrences"] ?? "1"), 10) || 1;
      const children = (node["children"] as unknown[] | undefined) ?? [];
      const targets = collectSubtreeWords(children);
      out.push({ source, occurrence, occurrences, targets });
      // Recurse into nested milestones as their own runs.
      for (const c of children) {
        if (nodeIsMilestone(c)) walk([c]);
      }
    }
  }
  walk(verseObjects);
  return out;
}

// Pass 2: PIN a milestone entry to a specific source TOKEN by raw (joiner-
// preserving) surface, disambiguating same-`matchNorm` source words that
// differ only by a word joiner. DAN 6:3 has כָּל twice: the first is כָּ⁠ל
// (U+2060 WORD JOINER), the second bare כָּל. matchNorm strips the joiner for
// comparison (by design — TN/TQ quotes often omit it), so both milestones'
// x-content fold to the same string and — being legitimately stamped 1/1
// each, since before folding they WERE distinct — both get effOcc 1 and
// merge into one run, lighting the second instance's English words too
// (issue: note `fhez` lighting "all before that" AND "all of").
//
// nfc() (NFC only — does NOT strip the joiner, see lib/hebrew.ts) is the
// tie-breaker: it tells the two apart. It is used ONLY when ALL of the
// following hold for a same-matchNorm group of entries, so a genuine split
// gloss (two milestones sharing identical raw content for ONE source token,
// e.g. ZEC 6:5 וַ⁠יַּעַן) is never pinned apart and still merges via the
// existing effOcc logic in Pass 3:
//   - the OL verse holds the surface more than once (single-occurrence
//     surfaces need no disambiguation — trueTotal === 1 already forces
//     effOcc 1 in Pass 3);
//   - the entries' nfc(source) values are pairwise DISTINCT (identical raw
//     content across entries IS the split-gloss shape — must still merge);
//   - each distinct nfc(source) matches exactly ONE source token by
//     nfc(token.text);
//   - those matched source tokens are distinct from each other.
// When pinned, the entry's effective occurrence becomes the matched token's
// COUNTED `surfaceOccurrence` (source \w carries no real x-occurrence — see
// collectBareWords).
//
// Corroboration requirement: a group must have 2+ entries to be eligible for
// pinning at all. A single milestone's raw x-content is an UNVERIFIED claim —
// AI-generated content has a documented mangling class where a word's joiner
// gets dropped (e.g. כ⁠ל written bare as כל), so one milestone's nfc match
// against an ambiguous (2+ occurrence) source surface may be naming the WRONG
// token. Requiring two competing milestones raises the bar: each must
// nfc-match a DIFFERENT source token, so the pins account for the surface's
// instances rather than resting on one unverifiable guess. A single entry
// falls through to the existing [1, occurrences] clamp in Pass 3, exactly as
// before pinning existed.
//
// This is a bar, NOT a proof. Two entries that nfc-match distinct tokens still
// pin even if one is really a mangled continuation of the OTHER's token (its
// joiner dropped), which would split a pair that ought to merge. No such verse
// exists in the corpus — measured, 0 emptied and 0 changed across 33,522
// quote×resource cases — and the pre-pinning clamp got that shape wrong too,
// so this is a narrowed risk rather than an eliminated one.
//
// Exported so quoteBuilder.ts's collectTargetTokens (picker's English chips —
// same collision, same fix) can reuse this decision instead of
// reimplementing it. Takes the milestones' raw `content` strings, in the same
// traversal order the caller will re-walk in, rather than a highlight.ts-
// internal entry shape — the only thing the decision needs.
export function pinSourceOccurrences(
  sources: string[],
  sourceTotals: Map<string, number>,
  sourceTokens: WordToken[],
): Map<number, number> {
  const pins = new Map<number, number>();
  const groups = new Map<string, number[]>();
  sources.forEach((source, i) => {
    if (!source) return;
    const norm = matchNorm(source);
    const list = groups.get(norm);
    if (list) list.push(i);
    else groups.set(norm, [i]);
  });
  for (const [norm, idxs] of groups) {
    if ((sourceTotals.get(norm) ?? 0) <= 1) continue;
    if (idxs.length < 2) continue; // lone milestone — no corroboration, fall through to clamp
    const nfcs = idxs.map((i) => nfc(sources[i]));
    if (new Set(nfcs).size !== nfcs.length) continue; // split gloss — must merge
    const candidates = sourceTokens.filter((t) => matchNorm(t.text) === norm);
    const usedTokens = new Set<number>();
    const matchedTokenForEntry = new Map<number, number>();
    let ok = true;
    for (let k = 0; k < idxs.length; k++) {
      const matches = candidates
        .map((t, ti) => ({ ti, t }))
        .filter(({ t }) => nfc(t.text) === nfcs[k]);
      if (matches.length !== 1 || usedTokens.has(matches[0].ti)) {
        ok = false;
        break;
      }
      usedTokens.add(matches[0].ti);
      matchedTokenForEntry.set(idxs[k], matches[0].ti);
    }
    if (!ok) continue;
    for (const [entryIdx, ti] of matchedTokenForEntry) {
      const tok = candidates[ti];
      pins.set(entryIdx, tok.surfaceOccurrence ?? tok.occurrence);
    }
  }
  return pins;
}

// Pass 3 + entry point: apply pins where computed, otherwise the EXISTING
// effOcc logic (unchanged), then run the existing merge loop (same
// content-norm + same effOcc folds together). Pinned entries participate in
// the same merge loop; because their effOccs are distinct source-token
// positions they naturally stay separate rather than needing a separate
// code path.
function collectMilestoneRuns(
  verseObjects: unknown[],
  sourceTotals?: Map<string, number>,
  sourceTokens?: WordToken[],
): Run[] {
  const entries = collectRawRuns(verseObjects);
  const pins =
    sourceTotals && sourceTokens && sourceTokens.length > 0
      ? pinSourceOccurrences(
          entries.map((e) => e.source),
          sourceTotals,
          sourceTokens,
        )
      : new Map<number, number>();
  const out: Run[] = [];
  entries.forEach((e, i) => {
    const { source, occurrence, occurrences, targets } = e;
    const want = source ? matchNorm(source) : "";
    const pinned = pins.get(i);
    let effOcc: number;
    if (pinned !== undefined) {
      effOcc = pinned;
    } else {
      const trueTotal = source ? sourceTotals?.get(want) : undefined;
      // Appears-once ONLY. When the OL verse holds the word exactly once,
      // every milestone for it must mean that one token, so any occurrence
      // collapses to 1. When it holds the word 2+ times, an over-claiming
      // milestone ("the 3rd of 3" over a source with two) is genuinely
      // ambiguous — which physical token? — so it is left to the
      // [1, occurrences] clamp rather than dragged onto a neighbour it may
      // have nothing to do with.
      effOcc = trueTotal === 1 ? 1 : Math.min(Math.max(occurrence, 1), Math.max(occurrences, 1));
    }
    let merged = false;
    if (source) {
      for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].occurrence === effOcc && matchNorm(out[j].source) === want) {
          out[j].targets.push(...targets);
          merged = true;
          break;
        }
      }
    }
    if (!merged) out.push({ source, occurrence: effOcc, targets });
  });
  return out;
}

// One `\w` token of a SOURCE (UHB/UGNT) verse, with every field any consumer
// of the source word list needs. See collectSourceWords for why this is a
// single shape rather than three similar ones.
export interface SourceWordToken {
  // Raw `\w` text, untouched — needed for rendering and for quote strings.
  text: string;
  // The token's own `x-occurrence` attribute, defaulting to 1. Effectively
  // always 1 on imported UHB/UGNT (they carry no such attribute); kept because
  // WordToken consumers expect the field.
  occurrence: number;
  // 1-based index among tokens sharing this matchNorm-folded surface. COUNTED,
  // not read — see the note on WordToken and collectSourceWords below.
  surfaceOccurrence: number;
  // 0-based document position among all `\w` tokens in this verse. Stable
  // across re-render because the verseObjects tree is immutable while the
  // user is selecting.
  position: number;
  // Text node(s) sitting between this `\w` and the next — usually a single
  // space, but a Hebrew maqqef (־) for joined words like כָל־הַגֹּנֵב. Lets a
  // consecutive run be rejoined with its ORIGINAL separator instead of a flat
  // space, so a built quote reads כָל־הַגֹּנֵב (matching how TN quotes are
  // written) and not כָל הַגֹּנֵב.
  trailing: string;
  // The raw usfm-js node, so a caller needing attributes this shape does not
  // carry (strong / lemma / morph for the picker's lexicon hovercard) can read
  // them itself instead of forking the walk to add a field.
  node: Record<string, unknown>;
}

// THE source-word walker. Flatten a SOURCE (UHB/UGNT) verse tree into one
// `\w` token per entry, in document order.
//
// This is deliberately the ONLY walk of a source verse tree in the codebase.
// There were three near-identical copies (here, quoteBuilder's collectUhbWords,
// QuoteBuilderPopper's collectUhbWords), differing only in which fields they
// bothered to capture. PR #389 had to fix the same occurrence-counting bug in
// each one separately and missed a copy twice: once leaving the picker painting
// its chips from a colliding key (four chips lit for a three-word selection,
// and clicking the phantom fourth would have dropped a real word from the
// quote), and once leaving the TWL span resolver keying on the old numbering.
// Callers now DECORATE this result rather than re-walking, so the next change
// to this logic cannot land in one place and silently miss the others.
//
// `surfaceOccurrence` is COUNTED here, not read off the node: imported UHB/UGNT
// `\w` tokens carry no `x-occurrence` attribute at all (hbo_uhb master has
// none), so the attribute reads 1 for every token — including the 2nd and 3rd
// לֹא of a verse. The GL `\zaln-s` x-occurrence that the OL-anchored join
// compares against DOES number them, so without counting, every source word
// past its first appearance fails to join and its GL words never highlight
// (ZEC 11:16 ULT: the 2nd and 4th "not"). Counting is keyed on matchNorm so it
// uses the same canonical surface form as the join. It is also the only way to
// name "the 2nd כָּל" in DAN 6:3, where the first is כָּ⁠ל (carrying U+2060
// WORD JOINER) and the second is bare כָּל — matchNorm folds the joiner away,
// so a read (always-1) attribute keys both tokens identically.
//
// Descend rule: ANY milestone, plus `\d`. The three former copies disagreed
// here — this file's descended only `zaln` milestones while the other two
// descended any milestone — so the difference had to be reconciled rather than
// preserved. Measured across all 66 books of UHB and UGNT, neither resource
// contains a single milestone node of ANY tag, so the rule is currently moot
// and either choice is behavior-preserving. The looser rule wins on merits:
// the domain here is exclusively source verses, which by construction hold no
// ALIGNMENT milestones, so the only milestone that could ever appear is a
// non-alignment one. Skipping it would silently drop its `\w` children, and
// because `position` and `surfaceOccurrence` are counted, a dropped word
// shifts the index of every word after it — corrupting quotes that don't
// contain the missing word at all. Descending an unexpected milestone costs
// nothing by comparison, so prefer recovery over silent loss.
export function collectSourceWords(verseObjects: unknown[]): SourceWordToken[] {
  const out: SourceWordToken[] = [];
  const seen = new Map<string, number>();
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (nodeIsWord(o)) {
        const text = String(o["text"] ?? "");
        const norm = matchNorm(text);
        const surfaceOccurrence = (seen.get(norm) ?? 0) + 1;
        seen.set(norm, surfaceOccurrence);
        out.push({
          text,
          occurrence: parseInt(String(o["occurrence"] ?? "1"), 10) || 1,
          surfaceOccurrence,
          position: out.length,
          trailing: "",
          node: o,
        });
      } else if (o["type"] === "text") {
        // Attach to the most recent word as its separator. usfm-js emits the
        // maqqef / inter-word space as a bare text sibling of the \w tokens.
        const prev = out[out.length - 1];
        if (prev) prev.trailing += String(o["text"] ?? "");
      } else if (o["type"] === "milestone" || nodeIsPsalmTitle(o)) {
        // \d (Psalm superscription) is `type:"section"` but its content IS
        // alignable verse body — descend it like the highlight matchers do.
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  }
  walk(verseObjects);
  return out;
}

// WordToken projection of collectSourceWords, for the OL-anchored highlight
// join and quote matchers that want only the comparison fields. A projection,
// not a second walk.
export function collectBareWords(verseObjects: unknown[]): WordToken[] {
  return collectSourceWords(verseObjects).map((w) => ({
    text: w.text,
    occurrence: w.occurrence,
    surfaceOccurrence: w.surfaceOccurrence,
  }));
}

export type HighlightKey = string; // `${text}|${occurrence}`
const k = (text: string, occurrence: number): HighlightKey => `${text}|${occurrence}`;

// During a note reorder (drag held, or for a few seconds after an arrow move)
// the active verse paints a "stoplight": the moved note keeps the normal yellow
// fill (its quote is the existing activeNoteQuote), while its candidate
// predecessor and successor light up on SEPARATE visual channels — green
// underline (prev) and red overline (next). Carried as quote + occurrence so
// each cell resolves them against its own version (and OL-anchors ULT/UST).
export interface ReorderHighlight {
  // The moved/hovered note itself (yellow fill). Carried explicitly so a HOVER
  // over the grip/arrows can light the note even when it isn't the active
  // selection; during a drag/arrow move it equals the active note.
  movedQuote: string | null;
  movedOccurrence: number | null;
  prevQuote: string | null;
  prevOccurrence: number | null;
  nextQuote: string | null;
  nextOccurrence: number | null;
}

// Per-token role sets handed to the renderers alongside the active highlight
// set. A word can sit in more than one set at once (overlap is common — two
// adjacent notes routinely quote the same or nested spans); each role rides its
// own CSS channel (see markHighlightSx) so overlaps compose instead of one
// colour clobbering another.
export interface RoleHighlightSets {
  prev?: Set<HighlightKey> | null;
  next?: Set<HighlightKey> | null;
}

// Build the per-word renderer shared by renderHighlightedHTML /
// renderEditableHTML. A token gets `be-hl` (active/yellow fill), `be-hl-prev`
// (green underline) and/or `be-hl-next` (red overline); the classes stack on a
// single <mark> so a multiply-claimed word shows every role at once.
function markRenderer(
  highlights: Set<HighlightKey>,
  roles?: RoleHighlightSets,
): (text: string, occurrence: number) => string {
  return (text, occurrence) => {
    const key = k(text, occurrence);
    const cls: string[] = [];
    if (highlights.has(key)) cls.push("be-hl");
    if (roles?.prev?.has(key)) cls.push("be-hl-prev");
    if (roles?.next?.has(key)) cls.push("be-hl-next");
    if (cls.length === 0) return escapeHtml(text);
    return `<mark class="${cls.join(" ")}">${escapeHtml(text)}</mark>`;
  };
}

// For ULT/UST: returns target-word keys that should be highlighted.
//
// CANONICAL APPROACH (OL-anchored), matching gatewayEdit / tcCreate /
// tsv-quote-converters: a TN quote is written in the SOURCE language, so we
// resolve it against the SOURCE (UHB/UGNT) verse FIRST — giving the exact
// (content, occurrence) source-word instances — then highlight the GL words
// whose alignment scope (`\zaln-s` content + x-occurrence) matches one of
// those instances. This is ORDER-INDEPENDENT: it never assumes the quoted
// words stay adjacent (or even in source order) in the target. They usually
// DON'T — the English freely permutes and interleaves the source words
// (HOS 6:2 UST drops the verb between "after two days" and "on the third day";
// ISA 28:1 UST scatters the four quoted words across the whole verse). The
// `(content, occurrence)` join is the same one the quote-builder picker already
// relies on (lib/quoteBuilder.ts `collectTargetTokens` + `tokenKey`).
//
// `sourceVerseObjects` (the OL verse) is required for the canonical path. When
// it is absent — or the quote can't be resolved within it — we fall back to a
// GL-only set match keyed on the milestones' own (content, occurrence); see the
// degradation block below.
export function findTargetHighlights(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
  sourceVerseObjects?: unknown[],
): Set<HighlightKey> {
  const sourceTokens = Array.isArray(sourceVerseObjects)
    ? collectBareWords(sourceVerseObjects)
    : undefined;
  const sourceTotals = sourceTokens ? surfaceTotalsFromTokens(sourceTokens) : undefined;
  const runs = collectMilestoneRuns(verseObjects, sourceTotals, sourceTokens);
  const out = new Set<HighlightKey>();
  if (runs.length === 0) return out;
  // `occurrence: -1` means "every occurrence of the quote" (TSV spec).
  const allOcc = (occurrence | 0) === -1;
  const wantOcc = Math.max(1, occurrence | 0);

  // Stage 1 + 2 (canonical): resolve the quote to source instances, join GL
  // milestones by (content, occurrence). Split-gloss duplicates share a key,
  // so every fragment of a discontinuous gloss lights up together.
  if (Array.isArray(sourceVerseObjects)) {
    const olTokens = matchSourceTokens(sourceVerseObjects, quote, occurrence);
    if (olTokens.length > 0) {
      const olKeys = new Set(
        olTokens.map((t) => `${matchNorm(t.text)}|${t.surfaceOccurrence ?? t.occurrence}`),
      );
      for (const r of runs) {
        if (olKeys.has(`${matchNorm(r.source)}|${r.occurrence}`)) {
          for (const t of r.targets) out.add(k(t.text, t.occurrence));
        }
      }
      // An empty result is RETURNED, not retried more loosely. Counting source
      // occurrences (above) makes it newly possible for a quote to resolve in
      // the OL yet join to nothing — but the honest reading of that is "the GL
      // never aligned this instance", and the GL usually hasn't: the UST is
      // idiomatic and routinely drops tokens. Falling back to a content-only
      // match there would light the FIRST instance's words for a quote on the
      // second — a confidently wrong highlight, and (via
      // extractTargetSelectionText) a confidently wrong AI selection payload.
      // Measured on en_tn master × ZEC/HOS/ISA/JER — 19,750 quote×resource
      // cases — counting blanks nothing that used to light, so there is no
      // regression here to paper over.
      return out;
    }
  }

  // Degradation: no source verse (e.g. UHB failed to load), the quote didn't
  // resolve in it, or it resolved but joined to no GL span (see above). Match
  // the quote as a SET of source words against the GL
  // milestones' own (content, occurrence). Correct for the common
  // single-occurrence case and lockstep repeats; for a quoted word whose source
  // occurrence differs from the phrase occurrence it can pick the wrong instance
  // — but that is unresolvable without the source verse, which the canonical
  // path above uses whenever available.
  const groups = quoteGroups(quote);
  if (groups.length === 0) return out;
  const wantWords = new Set(groups.flat().map(matchNorm));
  for (const r of runs) {
    if (wantWords.has(matchNorm(r.source)) && (allOcc || r.occurrence === wantOcc)) {
      for (const t of r.targets) out.add(k(t.text, t.occurrence));
    }
  }
  return out;
}

// Reverse of findTargetHighlights: given an English support phrase
// (the user-typed text in the QUOTE field BEFORE AI runs), find the
// Hebrew/Greek source words that align to those English target words
// via the verse's \zaln-s milestones. Matching is case-insensitive,
// strips non-letter chars ("{with}" -> "with", "jealousy." -> "jealousy"),
// and looks for the LONGEST CONTIGUOUS run of input words that appears
// consecutively in the verse's target words.
//
// Nested milestones are handled: each target word carries its full chain
// of ancestor milestone sources (outer to inner), so a match inside a
// deeply-nested `\zaln-s` pulls all enclosing source words too.
//
// Returns the Hebrew snippet as space-joined source words in document
// order (outer to inner within a chain), de-duped. Returns "" when no
// input word matches — callers use empty to short-circuit the AI call
// with a clearer message than the bot's 422 no_rtl.
export function findSourceForTargetText(
  verseObjects: unknown[],
  englishText: string,
): string {
  const wantedWords = englishText
    // Proofreaders paste straight from the ULT, which can carry USFM
    // markers (\q1, \q2, \p, \m, …) when the quote spans a poetry line
    // or paragraph break. Strip them before the punctuation pass below —
    // that pass removes the backslash but would leave the marker's
    // letters/digits (q1, q2, p) behind as bogus words that break the
    // contiguous-run match against the target.
    .replace(/\\[a-z]+\d*\*?/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (wantedWords.length === 0) return "";

  type Target = { norm: string; sources: string[] };
  const targets: Target[] = [];
  function walk(nodes: unknown[], stack: string[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (nodeIsMilestone(o)) {
        const source = String(o["content"] ?? "");
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children, source ? [...stack, source] : stack);
      } else if (nodeIsPsalmTitle(o)) {
        // \d (Psalm superscription) is type:"section" but its content IS
        // alignable verse body — walk its children like a milestone (no
        // source contribution of its own). Mirrors collectMilestoneRuns.
        walk((o["children"] as unknown[] | undefined) ?? [], stack);
      } else if (nodeIsWord(o)) {
        const text = String(o["text"] ?? "");
        const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
        if (norm.length > 0) targets.push({ norm, sources: stack });
      }
    }
  }
  walk(verseObjects, []);
  if (targets.length === 0) return "";

  let bestStart = -1;
  let bestLen = 0;
  for (let ti = 0; ti < targets.length; ti++) {
    for (let wi = 0; wi < wantedWords.length; wi++) {
      if (targets[ti].norm !== wantedWords[wi]) continue;
      let len = 0;
      while (
        ti + len < targets.length &&
        wi + len < wantedWords.length &&
        targets[ti + len].norm === wantedWords[wi + len]
      ) {
        len++;
      }
      if (len > bestLen) {
        bestLen = len;
        bestStart = ti;
      }
    }
  }
  if (bestStart < 0) return "";

  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = bestStart; i < bestStart + bestLen; i++) {
    for (const src of targets[i].sources) {
      if (seen.has(src)) continue;
      seen.add(src);
      out.push(src);
    }
  }
  return out.join(" ");
}

// Walk the verseObjects in document order and pull out the highlighted
// target words for `quote` at `occurrence`, joined with spaces. Used to
// derive the English support phrase from the Hebrew quote when handing
// off to the tn-quick AI endpoint. Returns "" if nothing matches —
// callers should treat empty as "selection unavailable".
// `gapMarker` (opt-in) makes DISCONTINUITY visible. A source word can align to
// non-contiguous target words — ISA 60:6 וּתְהִלֹּת is rendered "and … the
// praises of", with another word's "they will proclaim" sitting in the gap.
// Joined with plain spaces that reads "and the praises of", which looks like a
// contiguous phrase the ULT never says. Pass a marker (the Words-panel gloss
// passes "…") to have it emitted wherever at least one unselected word was
// skipped. Callers that feed machine consumers — tnQuickRequest.ts builds the
// AI payload from this — must NOT pass one, so their strings stay unchanged.
export function extractTargetSelectionText(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
  sourceVerseObjects?: unknown[],
  options?: { gapMarker?: string },
): string {
  const highlights = findTargetHighlights(verseObjects, quote, occurrence, sourceVerseObjects);
  if (highlights.size === 0) return "";
  const gapMarker = options?.gapMarker;
  const seen = new Set<HighlightKey>();
  const words: string[] = [];
  let wordIndex = 0;        // position of every \w walked, selected or not
  let lastSelected: number | null = null;
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (nodeIsWord(o)) {
        const text = String(o["text"] ?? "");
        const occ = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const key = k(text, occ);
        const index = wordIndex++;
        if (highlights.has(key) && !seen.has(key)) {
          seen.add(key);
          if (gapMarker && lastSelected != null && index > lastSelected + 1) {
            words.push(gapMarker);
          }
          lastSelected = index;
          words.push(text);
        }
      } else if (nodeIsMilestone(o) || nodeIsPsalmTitle(o)) {
        // \d (Psalm superscription) descends like a milestone — its inner
        // \w tokens are alignable verse body. Mirrors collectMilestoneRuns.
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return words.join(" ");
}

// Resolve a quote + occurrence against the source/original verse words, in
// SOURCE document order (where the quote IS contiguous and ordered, and gap
// markers mark the real discontinuities). Returns the matched bare-word tokens
// of the chosen occurrence, or [] if it doesn't resolve. Shared by the UHB/UGNT
// highlighter, the OL-anchored target join, and the quote-builder picker's
// pre-seed (lib/quoteBuilder.ts selectionFromQuote).
export function matchSourceTokens(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
): WordToken[] {
  const groups = quoteGroups(quote);
  const tokens = collectBareWords(verseObjects);
  if (groups.length === 0 || tokens.length === 0) return [];
  // `occurrence: -1` means "every occurrence of the quote" (TSV spec).
  const allOcc = (occurrence | 0) === -1;
  const wantOcc = Math.max(1, occurrence | 0);

  const normGroups = groups.map((g) => g.map(matchNorm));
  const normTokens = tokens.map((t) => matchNorm(t.text));

  const matches: number[][] = [];
  for (let start = 0; start < tokens.length; start++) {
    const m = matchGroupsAt(start, normGroups, normTokens);
    if (m) matches.push(m);
  }

  if (allOcc) {
    // Union of every match, de-duped, in document order.
    const union = new Set<number>();
    for (const m of matches) for (const i of m) union.add(i);
    return [...union].sort((a, b) => a - b).map((i) => tokens[i]);
  }
  const chosen = matches[wantOcc - 1];
  if (!chosen) return [];
  return chosen.map((i) => tokens[i]);
}

// For UHB/UGNT: returns source-word keys that should be highlighted. Keys carry
// RAW text — HebrewLine / renderHighlightedHTML read from the same tree.
export function findSourceHighlights(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
): Set<HighlightKey> {
  const out = new Set<HighlightKey>();
  for (const t of matchSourceTokens(verseObjects, quote, occurrence)) {
    out.add(k(t.text, t.occurrence));
  }
  return out;
}

// How many times each source surface form appears in the OL verse, keyed by
// matchNorm. Lets the GL side tell an IMPOSSIBLE `\zaln-s` x-occurrence
// ("the 2nd וּבְשַׂר" in a verse that has exactly one) from a genuine repeat.
export function surfaceTotalsFromTokens(tokens: WordToken[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const t of tokens) {
    const key = matchNorm(t.text);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return totals;
}

// ---------- rendering ----------

function escapeHtml(s: string): string {
  // Escapes quotes as well as &<> so the output is safe in attribute context
  // (chipForTag interpolates the tag into class="…"/data-tag="…"). Harmless in
  // text context — &quot;/&#39; round-trip back to "/' via textContent.
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

// CSS class for a paragraph / poetry / blank marker. Returns a pair of
// classes (one structural, one tag-specific) so the layout stylesheet
// can attach indents per q-level or special spacing per p-variant.
export function paragraphClass(tag: string): { wrapper: string; isBlank: boolean } {
  if (tag === "b") return { wrapper: "be-blank", isBlank: true };
  if (tag === "ts") return { wrapper: "be-ts", isBlank: false };
  if (tag === "q" || tag === "q1") return { wrapper: "be-q be-q-1", isBlank: false };
  if (tag === "q2") return { wrapper: "be-q be-q-2", isBlank: false };
  if (tag === "q3") return { wrapper: "be-q be-q-3", isBlank: false };
  if (tag === "q4") return { wrapper: "be-q be-q-4", isBlank: false };
  if (tag === "qm" || tag === "qm1") return { wrapper: "be-q be-q-1 be-qm", isBlank: false };
  if (tag === "qm2") return { wrapper: "be-q be-q-2 be-qm", isBlank: false };
  if (tag === "qm3") return { wrapper: "be-q be-q-3 be-qm", isBlank: false };
  if (tag === "pi1" || tag === "pi") return { wrapper: "be-para be-pi-1", isBlank: false };
  if (tag === "pi2") return { wrapper: "be-para be-pi-2", isBlank: false };
  if (tag === "pi3") return { wrapper: "be-para be-pi-3", isBlank: false };
  if (tag === "pc") return { wrapper: "be-para be-pc", isBlank: false };
  if (tag === "mi") return { wrapper: "be-para be-mi", isBlank: false };
  if (tag === "m") return { wrapper: "be-para be-m", isBlank: false };
  if (tag === "nb") return { wrapper: "be-para be-nb", isBlank: false };
  return { wrapper: "be-para be-p", isBlank: false };
}

// The active/editable verse renders its OWN verseObjects (so the contentEditable
// text matches the save diff), which drops the paragraph marker drifted from the
// previous verse — and with it the visual line break that introduces the verse.
// Map that drifted marker to the same wrapper class the inactive (display) path
// uses, so the caller can put it directly on the editable span and get the
// break/indent back from CSS without touching the text. Use the marker closest to
// the verse (last in document order).
//
// `\ts\*` never supplies the class: it is its own chunk-boundary block (`be-ts`),
// carrying block display and divider margins that would relayout the whole
// content span if pinned to it. That intent still holds — but note
// the divider branch is currently UNREACHABLE from the one caller, and was doubly
// dead before: DocColumn feeds this extractTrailingMarkers() output, which filters
// through isDriftableMarker, and that returns false for every `\ts\*` shape
// (usfm.ts) because a chunk milestone stays in the verse that holds it rather than
// drifting forward. The old test here was `tag === "ts"`, which additionally could
// not match usfm-js 3.5.0's real shape (`{tag:"ts\\*"}`) — the Micah 4 bug class.
// Kept (via the canonical isTsMilestone predicate) as a cheap guard so that if the
// drift contract ever changes, a divider yields a plain block break instead of
// falling through paragraphClass's default and inheriting a `\p` indent.
export function leadingBreakClass(markers: unknown[] | null | undefined): string {
  if (!Array.isArray(markers)) return "";
  let sawDivider = false;
  for (let i = markers.length - 1; i >= 0; i--) {
    const node = markers[i];
    if (isTsMilestone(node)) {
      sawDivider = true;
      continue;
    }
    const tag = (node as { tag?: unknown } | null)?.tag;
    if (typeof tag !== "string") continue;
    const { wrapper, isBlank } = paragraphClass(tag);
    return isBlank ? "be-line" : wrapper;
  }
  // Only a `\ts\*` chunk divider drifted (no paragraph/poetry marker): the
  // inactive path renders a divider block here, so keep the active verse on
  // its own line with a plain block break rather than letting it run inline.
  return sawDivider ? "be-line" : "";
}

interface Segment {
  // CSS class applied to the wrapper <div>. The first (pre-marker)
  // segment has wrapper="" — emitted without a wrapper div so verses
  // with no paragraph markers render exactly as before.
  wrapper: string;
  // Marker tag that opens this segment, or null for the initial segment.
  tag: string | null;
  // Inner HTML for this segment.
  html: string;
  // \b — emit as an empty block (the html is intentionally empty).
  isBlank: boolean;
}

// Walk the verse tree once and partition into segments separated by
// `type:"paragraph"` nodes. Each segment's html is built using the
// per-word callback so renderers can swap how words render (display
// vs editable) without duplicating tree walking.
function segmentByParagraphs(
  verseObjects: unknown[],
  renderWord: (text: string, occurrence: number) => string,
): Segment[] {
  const segments: Segment[] = [{ wrapper: "", tag: null, html: "", isBlank: false }];
  let current = segments[0];

  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (isInFlowMarker(o)) {
        // Collapse every `\ts\*` node shape to the canonical "ts" tag before it
        // reaches the segment logic. usfm-js 3.5.0 parks the marker in the tag
        // (`{tag:"ts\\*"}`), so the `tag === "ts"` tests below — and the
        // `be-ts` / `be-tok-ts` classes they pick — silently missed every real
        // chunk divider, which is why `\ts\*` rendered nowhere in Micah 4.
        const tag = isTsMilestone(o) ? "ts" : (o["tag"] as string);
        const { wrapper, isBlank } = paragraphClass(tag);
        const seg: Segment = { wrapper, tag, html: "", isBlank };
        segments.push(seg);
        if (tag === "ts") {
          // \ts\* is a standalone chunk divider — anything that follows
          // (text, the next paragraph marker, ...) belongs to a fresh
          // segment, not inside the divider block.
          current = { wrapper: "", tag: null, html: "", isBlank: false };
          segments.push(current);
        } else {
          current = seg;
        }
        continue;
      }
      if (
        o["type"] === "section" &&
        typeof o["tag"] === "string" &&
        SECTION_HEADER_TAGS.has(o["tag"] as string)
      ) {
        continue;
      }
      // \d (Psalm superscription) is `type:"section"` but its text IS
      // alignable Hebrew. Render inline with `.be-d` styling so children
      // (\zaln-s milestones, \w words) still walk and align.
      if (o["type"] === "section" && o["tag"] === "d") {
        current.html += '<span class="be-d">';
        if (Array.isArray(o["children"]) && (o["children"] as unknown[]).length > 0) {
          walk(o["children"] as unknown[]);
        } else if (typeof o["text"] === "string") {
          current.html += escapeHtml(String(o["text"]));
        }
        current.html += "</span>";
        continue;
      }
      if (o["type"] === "text") {
        current.html += escapeHtml(String(o["text"] ?? ""));
      } else if (nodeIsWord(o)) {
        const text = String(o["text"] ?? "");
        const occurrence = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        current.html += renderWord(text, occurrence);
      } else if (nodeIsMilestone(o)) {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  // Split any leading punctuation usfm-js parked on a marker node (`\q2 “…`)
  // into a following text node so it renders at the start of its poetic line
  // instead of vanishing. No-op when no marker carries text.
  walk(liftMarkerText(verseObjects));
  return segments;
}

// Render a paragraph chip — the visible literal "\p" / "\q1" / "\ts\*"
// token shown in the active-verse editor. The chip is left as ordinary
// editable text (no `contenteditable="false"`) so the user can put their
// caret inside it and edit char-by-char — e.g. backspace over the `1`
// in `\q1` and type `2` to convert it to `\q2`. Tokenizer round-trips
// the new text on save.
function chipForTag(tag: string): string {
  const text = tag === "ts" ? "\\ts\\*" : `\\${escapeHtml(tag)}`;
  return `<span class="be-tok be-tok-${escapeHtml(tag)}" data-tag="${escapeHtml(tag)}">${text}</span>`;
}

// Render segments to an HTML string. When the verse has no paragraph
// markers the result is the pre-marker segment's html with no wrapper
// (preserves the inline-flow look for non-poetic verses). When markers
// are present, each segment becomes a block-level `<div>` so the layout
// breaks at the marker. `emitChips` adds visible literal-USFM chips at
// the start of each marker-opened block — used by the editable renderer
// so translators can see and remove markers.
function segmentsToHtml(segments: Segment[], emitChips: boolean): string {
  if (segments.length === 1 && !segments[0].wrapper) {
    return segments[0].html;
  }
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Drop empty wrapper-less segments wherever they fall — these come
    // from the post-\ts\* fresh-segment push when nothing follows the
    // divider, or from the initial pre-marker slot when the verse opens
    // with a marker.
    if (seg.html === "" && !seg.wrapper) continue;
    const cls = seg.wrapper || "be-line";
    if (seg.isBlank) {
      out.push(`<div class="${cls}">${emitChips && seg.tag ? chipForTag(seg.tag) : "&nbsp;"}</div>`);
      continue;
    }
    if (seg.tag === "ts") {
      // \ts\* renders as a chunk-boundary block regardless of edit mode.
      // The chip carries the literal marker text so editing it still
      // round-trips through tokenizeEditableText.
      //
      // `be-ts-quiet` marks the READ-ONLY emission (a verse you are not editing).
      // Every other marker is invisible outside the active verse — `\p` / `\q1`
      // become pure layout — so a `\ts\*` that kept printing its literal label
      // everywhere read as louder than the markers it sits among. The class lets
      // the stylesheet hide just the label there while keeping the block (and so
      // the line break) intact. Book mode restates `div.be-ts` wholesale and
      // therefore keeps its label: it draws the divider at the top of the verse
      // the marker introduces, which is the whole point of that treatment.
      const chip = emitChips ? chipForTag("ts") : `<span class="be-tok be-tok-ts">\\ts\\*</span>`;
      out.push(`<div class="${cls}${emitChips ? "" : " be-ts-quiet"}">${chip}</div>`);
      continue;
    }
    const chip = emitChips && seg.tag ? chipForTag(seg.tag) + " " : "";
    // Empty segments need a zero-width space so contenteditable can put
    // a caret inside them.
    const body = seg.html || (emitChips ? "&#8203;" : "&#8203;");
    out.push(`<div class="${cls}">${chip}${body}</div>`);
  }
  return out.join("");
}

// Render the verse tree as a single HTML string, wrapping highlighted \w
// tokens in <mark>. Paragraph / poetry markers become block-level <div>
// wrappers with CSS classes (be-q-1..4, be-para, be-blank) so all three
// scripture views (rows, columns, book) lay out poetry with proper
// indents and paragraphs with proper breaks. Used for contentEditable
// spans where we want the browser to preserve the cursor between props
// changes.
export function renderHighlightedHTML(
  verseObjects: unknown[],
  highlights: Set<HighlightKey>,
  roles?: RoleHighlightSets,
): string {
  const segments = segmentByParagraphs(verseObjects, markRenderer(highlights, roles));
  return segmentsToHtml(segments, false);
}

// Like renderHighlightedHTML but emits visible literal-USFM chips
// (<span class="be-tok" contenteditable="false">\p</span>) at the start
// of each paragraph-opened block. Used in the active-verse editor so
// translators can see and adjust paragraph / poetry markers as they
// type. The chip's textContent is exactly "\p" / "\q1", so reading the
// containing div's textContent yields the same string format produced
// by extractEditableText — the smartEditVerse diff lines up.
export function renderEditableHTML(
  verseObjects: unknown[],
  highlights: Set<HighlightKey>,
  roles?: RoleHighlightSets,
): string {
  const segments = segmentByParagraphs(verseObjects, markRenderer(highlights, roles));
  return segmentsToHtml(segments, true);
}

// A recognized-but-empty verseObjects tree (or one of only unrecognized/
// marker nodes) renders to "" from segmentsToHtml — that is not paintable
// content. Callers must fall back to the plain_text baseline instead of
// writing "" into the DOM, which blanks the pane with no way to type the
// text back. See issue #529.
//
// A marker-only tree (e.g. a lone \q1 with no following text) does NOT
// render to "": segmentsToHtml fills the empty block with a zero-width
// space (`&#8203;`) so contenteditable has somewhere to put the caret,
// producing non-empty-but-invisible markup like `<div class="be-q-1">
// &#8203;</div>`. That passes a trim()-only check and paints a text-free
// pane in the read-only paths. Strip tags and known invisible entities
// before judging emptiness. See issue #568.
function stripToVisibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#8203;/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function isPaintableHtml(html: string | null | undefined): html is string {
  if (typeof html !== "string" || html.trim() === "") return false;
  return stripToVisibleText(html).trim() !== "";
}

// Convenience: pick the right highlight set for a given bible_version.
// `sourceContent` is the active verse's UHB/UGNT verse content; pass it for
// ULT/UST so the highlighter can OL-anchor the match (see findTargetHighlights).
// Omitting it degrades ULT/UST to GL-only set matching; it's ignored for
// UHB/UGNT (the source IS the verse).
export function highlightsFor(
  bibleVersion: string,
  verseContent: unknown,
  quote: string | null | undefined,
  occurrence: number | null | undefined,
  sourceContent?: unknown,
): Set<HighlightKey> {
  if (!quote) return new Set();
  const verseObjects = (verseContent as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(verseObjects)) return new Set();
  const occ = occurrence ?? 1;
  if (bibleVersion === "UHB" || bibleVersion === "UGNT") {
    return findSourceHighlights(verseObjects, quote, occ);
  }
  const sourceVo = (sourceContent as { verseObjects?: unknown[] } | null)?.verseObjects;
  return findTargetHighlights(verseObjects, quote, occ, Array.isArray(sourceVo) ? sourceVo : undefined);
}

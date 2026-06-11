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
import { isInFlowMarker, liftMarkerText, SECTION_HEADER_TAGS } from "./usfm.ts";

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

type WordToken = { text: string; occurrence: number };
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
// with the same content — and stamps the second occurrence="2" while
// occurrences stays "1", which is impossible ("the 2nd of 1"). Real case:
// ZEC 6:2 בַּ⁠מֶּרְכָּבָה → "In the" … (interrupted by "first") … "chariot".
// Such a continuation run (occurrence > occurrences) folds its targets back
// into the nearest preceding run with the same content, so the matcher sees
// ONE logical token carrying ALL its target words ("chariot" included). It's
// a no-op for well-formed data (occurrence ≤ occurrences), so genuinely
// repeated words keep their own runs and positions and never false-merge.
// Mirrors effectiveOccurrence / sameSourceChain in lib/alignment.ts.
function collectMilestoneRuns(verseObjects: unknown[]): Run[] {
  const out: Run[] = [];
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
      // Malformed split continuation: merge into the nearest preceding run
      // with the same source content rather than starting a new run.
      let merged = false;
      if (occurrence > occurrences && source) {
        const want = matchNorm(source);
        for (let i = out.length - 1; i >= 0; i--) {
          if (matchNorm(out[i].source) === want) {
            out[i].targets.push(...targets);
            merged = true;
            break;
          }
        }
      }
      if (!merged) out.push({ source, occurrence, targets });
      // Recurse into nested milestones as their own runs.
      for (const c of children) {
        if (nodeIsMilestone(c)) walk([c]);
      }
    }
  }
  walk(verseObjects);
  return out;
}

// Flatten the verse tree into one bare \w token per entry, in document
// order. Used for UHB/UGNT highlighting where the verse IS the source.
function collectBareWords(verseObjects: unknown[]): WordToken[] {
  const out: WordToken[] = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      if (nodeIsWord(node)) {
        out.push({
          text: String((node as Record<string, unknown>)["text"] ?? ""),
          occurrence:
            parseInt(String((node as Record<string, unknown>)["occurrence"] ?? "1"), 10) || 1,
        });
      } else if (nodeIsMilestone(node) || nodeIsPsalmTitle(node)) {
        const children = ((node as Record<string, unknown>)["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return out;
}

export type HighlightKey = string; // `${text}|${occurrence}`
const k = (text: string, occurrence: number): HighlightKey => `${text}|${occurrence}`;

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
  const runs = collectMilestoneRuns(verseObjects);
  const out = new Set<HighlightKey>();
  if (runs.length === 0) return out;
  // `occurrence: -1` means "every occurrence of the quote" (TSV spec).
  const allOcc = (occurrence | 0) === -1;
  const wantOcc = Math.max(1, occurrence | 0);

  // Stage 1 + 2 (canonical): resolve the quote to source instances, join GL
  // milestones by (content, occurrence). Split-gloss duplicates share a key,
  // so every fragment of a discontinuous gloss lights up together.
  if (Array.isArray(sourceVerseObjects)) {
    const olKeys = sourceInstanceKeys(sourceVerseObjects, quote, occurrence);
    if (olKeys.size > 0) {
      for (const r of runs) {
        if (olKeys.has(`${matchNorm(r.source)}|${r.occurrence}`)) {
          for (const t of r.targets) out.add(k(t.text, t.occurrence));
        }
      }
      return out;
    }
  }

  // Degradation: no source verse (e.g. UHB failed to load) or the quote didn't
  // resolve in it. Match the quote as a SET of source words against the GL
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
export function extractTargetSelectionText(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
  sourceVerseObjects?: unknown[],
): string {
  const highlights = findTargetHighlights(verseObjects, quote, occurrence, sourceVerseObjects);
  if (highlights.size === 0) return "";
  const seen = new Set<HighlightKey>();
  const words: string[] = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (nodeIsWord(o)) {
        const text = String(o["text"] ?? "");
        const occ = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const key = k(text, occ);
        if (highlights.has(key) && !seen.has(key)) {
          seen.add(key);
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
// highlighter and the OL-anchored target join.
function matchSourceTokens(
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

// OL instance keys for the ULT/UST alignment join: `${matchNorm(content)}|occurrence`.
// Match-normalized because UHB \w text is in legacy combining-mark order while
// \zaln-s x-content is NFC (see lib/hebrew.ts), and joiner presence can drift
// — the join must compare the canonical form on both sides.
function sourceInstanceKeys(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
): Set<string> {
  const out = new Set<string>();
  for (const t of matchSourceTokens(verseObjects, quote, occurrence)) {
    out.add(`${matchNorm(t.text)}|${t.occurrence}`);
  }
  return out;
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
function paragraphClass(tag: string): { wrapper: string; isBlank: boolean } {
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
        const tag = o["tag"] as string;
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
      // \ts\* renders as a horizontal divider regardless of edit mode.
      // The chip carries the literal marker text so editing it still
      // round-trips through tokenizeEditableText.
      const chip = emitChips ? chipForTag("ts") : `<span class="be-tok be-tok-ts">\\ts\\*</span>`;
      out.push(`<div class="${cls}">${chip}</div>`);
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
): string {
  const segments = segmentByParagraphs(verseObjects, (text, occurrence) => {
    const key = k(text, occurrence);
    if (highlights.has(key)) {
      return `<mark class="be-hl">${escapeHtml(text)}</mark>`;
    }
    return escapeHtml(text);
  });
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
): string {
  const segments = segmentByParagraphs(verseObjects, (text, occurrence) => {
    const key = k(text, occurrence);
    if (highlights.has(key)) {
      return `<mark class="be-hl">${escapeHtml(text)}</mark>`;
    }
    return escapeHtml(text);
  });
  return segmentsToHtml(segments, true);
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

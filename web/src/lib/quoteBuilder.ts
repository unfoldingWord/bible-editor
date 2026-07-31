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

import type { HighlightKey, WordToken } from "./highlight";
import {
  matchNorm,
  matchSourceTokens,
  collectBareWords,
  surfaceTotalsFromTokens,
  pinSourceOccurrences,
} from "./highlight.ts";

// Build a HighlightKey from a Hebrew/Greek string + 1-based occurrence.
// All callers (picker + buildQuoteFromSelection + collectTargetTokens)
// MUST go through this — UHB \w text is stored in legacy combining-mark
// order while UST/ULT zaln x-content is NFC, so a raw `${text}|${occ}`
// comparison loses the join. Use matchNorm (NFC + word-joiner U+2060 /
// U+200D stripping) — the SAME fold the highlighter joins by in
// matchSourceTokens / matchGroupsAt. nfc() alone left the joiner in, so a
// UHB token carrying a U+2060 (הָ⁠אֶבֶן) and an AI-generated x-content that
// omitted it minted two different keys: clicking the English chip toggled a
// phantom key the UHB row could never match, and the quote never built. One
// fold must govern every quote/selection equality.
export function tokenKey(text: string, occurrence: number): HighlightKey {
  return `${matchNorm(text)}|${occurrence}`;
}

interface UhbWord {
  text: string;       // raw text, preserved for quote string rendering
  key: HighlightKey;  // matchNorm-normalized lookup key (see tokenKey)
  occurrence: number;
  // 0-based document position among all \w tokens in this verse. Stable
  // across re-render because the verseObjects tree is immutable while
  // the user is selecting.
  position: number;
  // Text node(s) sitting between this \w and the next one — usually a
  // single space, but a Hebrew maqqef (־) for joined words like
  // כָל־הַגֹּנֵב. Used to rejoin a consecutive run with the ORIGINAL
  // separator instead of a flat space, so a built quote reads כָל־הַגֹּנֵב
  // (matching how TN quotes are written) and not כָל הַגֹּנֵב.
  trailing: string;
}

// `occurrence` here is COUNTED, not read off the node's `x-occurrence`
// attribute: imported UHB/UGNT `\w` tokens carry no x-occurrence at all
// (hbo_uhb master has none), so the attribute reads 1 for every token — even
// the 2nd instance of a repeated surface. DAN 6:3 has כָּל twice: the first
// is כָּ⁠ל (with U+2060 WORD JOINER), the second is bare כָּל, and matchNorm
// folds the joiner away so both collapse to the same string. Reading the
// (always-1) attribute keyed both tokens as `כָּל|1`, so selecting the first
// also selected the second — a click produced the phantom quote
// "כָּ⁠ל־קֳבֵ֗ל דִּ֣י & כָּל". Counting (mirrors collectBareWords in
// highlight.ts) is the only way to name "the 2nd כָּל".
function collectUhbWords(verseObjects: unknown[]): UhbWord[] {
  const out: UhbWord[] = [];
  const seen = new Map<string, number>();
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const norm = matchNorm(text);
        const occurrence = (seen.get(norm) ?? 0) + 1;
        seen.set(norm, occurrence);
        out.push({ text, key: tokenKey(text, occurrence), occurrence, position: out.length, trailing: "" });
      } else if (o["type"] === "text") {
        // Attach to the most recent word as its separator. usfm-js emits the
        // maqqef / inter-word space as a bare text sibling of the \w tokens.
        const prev = out[out.length - 1];
        if (prev) prev.trailing += String(o["text"] ?? "");
      } else if (
        o["type"] === "milestone" ||
        // \d (Psalm superscription) is `type:"section"` but its content IS
        // alignable verse body — descend like the highlight matchers do.
        (o["type"] === "section" && o["tag"] === "d")
      ) {
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

// Reverse of buildQuoteFromSelection: resolve a stored quote + occurrence
// against the UHB/UGNT verse and return the picker selection keys (tokenKey
// format) for the matched source words. Used to PRE-SEED the picker when
// "build from source" opens on a note that already carries a quote — the
// translator keeps the existing words selected and just adds more, rather
// than starting from scratch. Returns an empty set when the quote doesn't
// resolve in this verse (e.g. it was typed by hand as English support text
// and never converted to source), so the picker simply starts fresh.
//
// Keys go through tokenKey (matchNorm) so they match what
// buildQuoteFromSelection / collectUhbWords look up — matchSourceTokens
// returns the same per-word (text, occurrence) the builder keys by.
//
// Key by `surfaceOccurrence` (matchSourceTokens' COUNTED value), not
// `occurrence` (the node's own, always-1, x-occurrence attribute) — same
// reasoning as collectUhbWords above. Using the raw attribute would key
// DAN 6:3's two כָּל tokens identically and pre-select both when the picker
// opens on a quote resolving to only the first.
export function selectionFromQuote(
  verseObjects: unknown[] | undefined | null,
  quote: string | null | undefined,
  occurrence: number | null | undefined,
): Set<HighlightKey> {
  const out = new Set<HighlightKey>();
  if (!Array.isArray(verseObjects) || !quote) return out;
  for (const t of matchSourceTokens(verseObjects, quote, occurrence ?? 1)) {
    out.add(tokenKey(t.text, t.surfaceOccurrence ?? t.occurrence));
  }
  return out;
}

// Separator to place after `w` when rejoining it with the next word in the
// same run. A maqqef in the trailing text wins (joined Hebrew word); anything
// else is a plain space.
function separatorAfter(w: UhbWord): string {
  return w.trailing.includes("־") ? "־" : " ";
}

export function buildQuoteFromSelection(
  verseObjects: unknown[] | undefined | null,
  selectedKeys: Set<HighlightKey>,
): BuiltQuote | null {
  if (!Array.isArray(verseObjects) || selectedKeys.size === 0) return null;
  const all = collectUhbWords(verseObjects);
  const selected = all.filter((w) => selectedKeys.has(w.key));
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

  // Join each consecutive run with the original inter-word separator so a
  // maqqef-joined pair (כָל־הַגֹּנֵב) round-trips with its maqqef. Any other
  // separator (a normal space, cantillation gaps) collapses to a single
  // space — the highlight matcher splits on /[\s־]+/ either way.
  const quote = groups
    .map((g) =>
      g
        .map((w, i) => (i === 0 ? w.text : separatorAfter(g[i - 1]) + w.text))
        .join(""),
    )
    .join(" & ");

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

// One source ancestor: the content + occurrence from a \zaln-s milestone.
// The picker turns a click on a target word into a set of these so the
// existing UHB-keyed selection (used by buildQuoteFromSelection) can be
// fed without translating between formats. The `key` field is the
// matchNorm-normalized selection key — always compare keys, never raw
// content, since UHB \w text and zaln x-content can drift in combining-mark
// order AND in word-joiner presence.
export interface SourceAncestor {
  content: string;     // raw, for display in tooltips
  occurrence: number;
  key: HighlightKey;   // matchNorm-normalized, for selection set lookups
}

// Per-token shape returned by collectTargetTokens. Outer-to-inner ancestor
// chain — same direction findSourceForTargetText emits, so the picker can
// preserve the convention.
export interface TargetToken {
  text: string;
  occurrence: number;
  position: number;
  sources: SourceAncestor[];
}

// Walk a milestone tree collecting just each \zaln-s node's raw `content`,
// in the exact traversal order collectTargetTokens's real walk (below) visits
// them — parent before its nested children, document order otherwise. Used
// ONLY to feed pinSourceOccurrences (which needs every milestone's content up
// front, before deciding any single one's occurrence); the real walk below
// re-derives the same sequence of milestone visits and consumes the pins by
// matching index, so the two walks MUST stay structurally identical (same
// branches, same recursion) to each other.
function collectMilestoneContents(nodes: unknown[]): string[] {
  const out: string[] = [];
  function walk(ns: unknown[]) {
    for (const node of ns ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "milestone" && o["tag"] === "zaln") {
        out.push(String(o["content"] ?? ""));
        walk((o["children"] as unknown[] | undefined) ?? []);
      } else if (o["type"] === "section" && o["tag"] === "d") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  }
  walk(nodes);
  return out;
}

// Walk a ULT/UST verseObjects tree. For each \w token, capture its
// enclosing \zaln-s ancestor chain (outer first) as SourceAncestor[].
// Mirrors findSourceForTargetText's stack-based walk but emits per-token
// records instead of merging into one string. Used by the picker so a
// click on "first" inside zaln(בַחֹדֶשׁ) > zaln(הָרִאשׁוֹן) > w(first)
// can toggle both Hebrew words at their correct occurrence indices.
//
// `sourceVerseObjects` (optional — the UHB/UGNT verse) enables the same
// word-joiner pinning highlight.ts's collectMilestoneRuns applies: DAN 6:3
// has כָּל twice (כָּ⁠ל with U+2060 WORD JOINER, then bare כָּל), both
// milestones legitimately stamped occurrence="1"/occurrences="1" before
// matchNorm folds the joiner away, so without pinning both would key
// identically and clicking the FIRST chip ("all") would select the SECOND
// (bare כָּל)'s Hebrew token too. Reuses highlight.ts's pinSourceOccurrences
// rather than reimplementing the decision — see that function for the full
// pin-eligibility rules (split glosses are deliberately excluded).
export function collectTargetTokens(
  verseObjects: unknown[] | undefined | null,
  sourceVerseObjects?: unknown[] | undefined | null,
): TargetToken[] {
  if (!Array.isArray(verseObjects)) return [];
  const pins: Map<number, number> = (() => {
    if (!Array.isArray(sourceVerseObjects) || sourceVerseObjects.length === 0) {
      return new Map();
    }
    const sourceTokens: WordToken[] = collectBareWords(sourceVerseObjects);
    if (sourceTokens.length === 0) return new Map();
    const sourceTotals = surfaceTotalsFromTokens(sourceTokens);
    const contents = collectMilestoneContents(verseObjects);
    return pinSourceOccurrences(contents, sourceTotals, sourceTokens);
  })();
  let milestoneIndex = 0;
  const out: TargetToken[] = [];
  function walk(nodes: unknown[], stack: SourceAncestor[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "milestone" && o["tag"] === "zaln") {
        const content = String(o["content"] ?? "");
        // Clamp occurrence into [1, occurrences]. A split-gloss continuation —
        // one source token whose target words are NON-CONTIGUOUS — is stamped
        // occurrence="2" while occurrences stays "1", which is impossible ("the
        // 2nd of 1"). Real case: ZEC 6:2 בַּ⁠מֶּרְכָּבָה → "In the" … (interrupted
        // by "first") … "chariot", where "chariot" sits under the occurrence="2"
        // milestone. Left raw, its source key (…|2) names a phantom the single
        // UHB token (…|1) can never match, so the picker neither selects nor
        // highlights "chariot" with its "In the" siblings. No-op on well-formed
        // data. Mirrors effectiveOccurrence in alignment.ts and the split-run
        // merge in highlight.ts.
        const rawOcc = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const total = parseInt(String(o["occurrences"] ?? "1"), 10) || 1;
        const clamped = Math.min(Math.max(rawOcc, 1), Math.max(total, 1));
        const idx = milestoneIndex++;
        const pinned = pins.get(idx);
        const occurrence = pinned !== undefined ? pinned : clamped;
        const children = (o["children"] as unknown[] | undefined) ?? [];
        // Skip ancestors with no content — defensive: a malformed milestone
        // without x-content would otherwise insert empty selection keys.
        const nextStack = content
          ? [...stack, { content, occurrence, key: tokenKey(content, occurrence) }]
          : stack;
        walk(children, nextStack);
      } else if (o["type"] === "section" && o["tag"] === "d") {
        // \d (Psalm superscription) is type:"section" but its content IS
        // alignable verse body — descend, carrying the current ancestor
        // stack unchanged (it contributes no source of its own). Mirrors
        // collectMilestoneRuns / collectUhbWords.
        walk((o["children"] as unknown[] | undefined) ?? [], stack);
      } else if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const occurrence = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        out.push({
          text,
          occurrence,
          position: out.length,
          sources: stack.slice(),
        });
      }
    }
  }
  walk(verseObjects, []);
  return out;
}

function matchGroupsAt(
  start: number,
  groups: UhbWord[][],
  all: UhbWord[],
): boolean {
  // Compare via matchNorm (NFC + joiner stripping) so the occurrence this
  // builder stamps counts the same matches the highlighter's
  // matchSourceTokens will find — legacy-vs-NFC drift AND word-joiner
  // presence both tolerated, keeping built quotes round-tripping.
  const norm = (w: UhbWord) => matchNorm(w.text);
  let pos = start;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (gi === 0) {
      if (pos + group.length > all.length) return false;
      for (let wi = 0; wi < group.length; wi++) {
        if (norm(all[pos + wi]) !== norm(group[wi])) return false;
      }
      pos = pos + group.length;
    } else {
      let found = -1;
      for (let s = pos; s + group.length <= all.length; s++) {
        let ok = true;
        for (let wi = 0; wi < group.length; wi++) {
          if (norm(all[s + wi]) !== norm(group[wi])) {
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

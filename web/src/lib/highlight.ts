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
// text equality checks go through `nfc()`. The Set keys still carry the
// RAW verseObjects text — the consumer (HebrewLine, renderHighlightedHTML)
// reads from the same tree, so raw matches raw with no further work.

import { nfc } from "./hebrew.ts";
import { isInFlowMarker, SECTION_HEADER_TAGS } from "./usfm.ts";

type WordToken = { text: string; occurrence: number };
type Run = { source: string; occurrence: number; targets: WordToken[] };

const GAP = /[&…]+|\.{3}/g;
const MAX_RUN_GAP = 6; // bail out if too many unrelated milestones between matched groups

// Parse quote into contiguous-word groups separated by explicit gap markers.
// Inside a group, words must be exactly adjacent in the verse; between groups,
// the matcher allows up to MAX_RUN_GAP intervening tokens.
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
// an exact-adjacent run, bounded by MAX_RUN_GAP from the previously matched
// index.
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
      const lastMatched = matched[matched.length - 1];
      const maxStart = Math.min(
        normSources.length - group.length,
        lastMatched + MAX_RUN_GAP,
      );
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

// Flatten the verse tree into one Run per zaln milestone (nested milestones
// become their own runs in document order). Each run's `targets` is only
// its DIRECT `\w` children — that way compound (nested) alignments stay
// disjoint and the matcher can highlight each level on its own.
function collectMilestoneRuns(verseObjects: unknown[]): Run[] {
  const out: Run[] = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      if (!nodeIsMilestone(node)) continue;
      const source = String(node["content"] ?? "");
      const occurrence = parseInt(String(node["occurrence"] ?? "1"), 10) || 1;
      const targets: WordToken[] = [];
      const children = (node["children"] as unknown[] | undefined) ?? [];
      for (const c of children) {
        if (nodeIsWord(c)) {
          targets.push({
            text: String((c as Record<string, unknown>)["text"] ?? ""),
            occurrence:
              parseInt(String((c as Record<string, unknown>)["occurrence"] ?? "1"), 10) || 1,
          });
        }
      }
      out.push({ source, occurrence, targets });
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
      } else if (nodeIsMilestone(node)) {
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
export function findTargetHighlights(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
): Set<HighlightKey> {
  const runs = collectMilestoneRuns(verseObjects);
  const groups = quoteGroups(quote);
  const out = new Set<HighlightKey>();
  if (runs.length === 0 || groups.length === 0) return out;
  const wantOcc = Math.max(1, occurrence | 0);

  const normGroups = groups.map((g) => g.map(nfc));
  const normSources = runs.map((r) => nfc(r.source));

  const matches: number[][] = [];
  for (let start = 0; start < runs.length; start++) {
    const m = matchGroupsAt(start, normGroups, normSources);
    if (m) matches.push(m);
  }

  const chosen = matches[wantOcc - 1];
  if (!chosen) return out;
  for (const i of chosen) {
    for (const t of runs[i].targets) out.add(k(t.text, t.occurrence));
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
): string {
  const highlights = findTargetHighlights(verseObjects, quote, occurrence);
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
      } else if (nodeIsMilestone(o)) {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return words.join(" ");
}

// For UHB/UGNT: returns source-word keys that should be highlighted.
export function findSourceHighlights(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
): Set<HighlightKey> {
  const groups = quoteGroups(quote);
  const tokens = collectBareWords(verseObjects);
  const out = new Set<HighlightKey>();
  if (groups.length === 0 || tokens.length === 0) return out;
  const wantOcc = Math.max(1, occurrence | 0);

  const normGroups = groups.map((g) => g.map(nfc));
  const normTokens = tokens.map((t) => nfc(t.text));

  const matches: number[][] = [];
  for (let start = 0; start < tokens.length; start++) {
    const m = matchGroupsAt(start, normGroups, normTokens);
    if (m) matches.push(m);
  }

  const chosen = matches[wantOcc - 1];
  if (!chosen) return out;
  for (const i of chosen) {
    out.add(k(tokens[i].text, tokens[i].occurrence));
  }
  return out;
}

// ---------- rendering ----------

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
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
  walk(verseObjects);
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
export function highlightsFor(
  bibleVersion: string,
  verseContent: unknown,
  quote: string | null | undefined,
  occurrence: number | null | undefined,
): Set<HighlightKey> {
  if (!quote) return new Set();
  const verseObjects = (verseContent as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(verseObjects)) return new Set();
  const occ = occurrence ?? 1;
  if (bibleVersion === "UHB" || bibleVersion === "UGNT") {
    return findSourceHighlights(verseObjects, quote, occ);
  }
  return findTargetHighlights(verseObjects, quote, occ);
}

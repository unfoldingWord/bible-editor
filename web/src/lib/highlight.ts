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
// references. We strip those to get a flat sequence of words; matching
// tolerates intervening unmatched runs so non-contiguous quotes still hit.
// `occurrence` (1-based) picks the Nth match when the same phrase appears
// multiple times in a verse.

type WordToken = { text: string; occurrence: number };
type Run = { source: string; occurrence: number; targets: WordToken[] };

const GAP = /[&…]+|\.{3}/g;
const MAX_RUN_GAP = 6; // bail out if too many unrelated milestones between matched words

function quoteWords(quote: string): string[] {
  if (!quote) return [];
  return quote
    .replace(GAP, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
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
  const words = quoteWords(quote);
  const out = new Set<HighlightKey>();
  if (runs.length === 0 || words.length === 0) return out;
  const wantOcc = Math.max(1, occurrence | 0);

  const matches: number[][] = [];
  for (let start = 0; start < runs.length; start++) {
    if (runs[start].source !== words[0]) continue;
    let runIdx = start;
    let wordIdx = 0;
    const matched: number[] = [];
    while (runIdx < runs.length && wordIdx < words.length) {
      if (runs[runIdx].source === words[wordIdx]) {
        matched.push(runIdx);
        wordIdx++;
        runIdx++;
      } else {
        if (matched.length === 0) break;
        if (runIdx - matched[matched.length - 1] > MAX_RUN_GAP) break;
        runIdx++;
      }
    }
    if (wordIdx === words.length) matches.push(matched);
  }

  const chosen = matches[wantOcc - 1];
  if (!chosen) return out;
  for (const i of chosen) {
    for (const t of runs[i].targets) out.add(k(t.text, t.occurrence));
  }
  return out;
}

// For UHB/UGNT: returns source-word keys that should be highlighted.
export function findSourceHighlights(
  verseObjects: unknown[],
  quote: string,
  occurrence: number,
): Set<HighlightKey> {
  const words = quoteWords(quote);
  const tokens = collectBareWords(verseObjects);
  const out = new Set<HighlightKey>();
  if (words.length === 0 || tokens.length === 0) return out;
  const wantOcc = Math.max(1, occurrence | 0);

  const matches: number[][] = [];
  for (let start = 0; start < tokens.length; start++) {
    if (tokens[start].text !== words[0]) continue;
    let tIdx = start;
    let wIdx = 0;
    const matched: number[] = [];
    while (tIdx < tokens.length && wIdx < words.length) {
      if (tokens[tIdx].text === words[wIdx]) {
        matched.push(tIdx);
        wIdx++;
        tIdx++;
      } else {
        if (matched.length === 0) break;
        if (tIdx - matched[matched.length - 1] > MAX_RUN_GAP) break;
        tIdx++;
      }
    }
    if (wIdx === words.length) matches.push(matched);
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

// Render the verse tree as a single HTML string, wrapping highlighted \w
// tokens in <mark>. Used for contentEditable spans where we want the
// browser to preserve the cursor between props changes.
export function renderHighlightedHTML(
  verseObjects: unknown[],
  highlights: Set<HighlightKey>,
): string {
  let html = "";
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "text") {
        html += escapeHtml(String(o["text"] ?? ""));
      } else if (nodeIsWord(o)) {
        const text = String(o["text"] ?? "");
        const occ = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const key = k(text, occ);
        if (highlights.has(key)) {
          html += `<mark class="be-hl">${escapeHtml(text)}</mark>`;
        } else {
          html += escapeHtml(text);
        }
      } else if (nodeIsMilestone(o)) {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  // Collapse repeated whitespace just enough to keep punctuation tight.
  return html;
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

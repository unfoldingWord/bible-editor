// Structural USFM validator — a faithful TS port of the deterministic,
// serialization-shaped subset of DCS's `validate_usfm_files.py` that OUR export
// renderer fully controls: Check 7 ("Consecutive Paragraph Markers") and Check 8
// ("USFM Formatting"). It runs on the final rendered USFM string (after
// `normalizeUsfmFormatting`) so the export HOLD gate can refuse to ship a book
// whose USFM DCS's CI would reject — the same failure that let a stray `\p`
// accumulate at the front of EZK 8/11 (one per nightly) go unnoticed on our write
// path until DCS's `validate-usfm-files` action flagged it.
//
// Scope is deliberately the structural/formatting checks, NOT verse/chapter
// coverage (Check 4/5, which false-positive on legitimate verse bridges) or
// footnote balance (Check 6, already escalated via lint.ts). Those stay out of the
// HOLD gate so a healthy book is never blocked; this validator only fires on the
// serialization corruption our own renderer can produce. It is pure and has no
// imports, mirroring the constant set of DCS's PARAGRAPH_MARKERS frozenset and
// _VERSE_PREFIX_RE exactly.

export type UsfmValidationRule =
  | "consecutive-paragraph-markers" // DCS Check 7
  | "chapter-marker-not-isolated" // DCS Check 8: `\c N` must be alone on its line
  | "paragraph-marker-not-isolated" // DCS Check 8: `\p` must be alone on its line
  | "ts-marker-not-isolated" // DCS Check 8: `\ts\*` must be alone on its line
  | "b-marker-not-isolated" // DCS Check 8: `\b` must be alone on its line
  | "b-marker-after-ts" // DCS Check 8: `\b` must precede `\ts\*`, not follow it
  | "multiple-verses-per-line" // DCS Check 8: at most one `\v` per line
  | "invalid-content-before-verse"; // DCS Check 8: only a paragraph/poetry marker may precede `\v`

export interface UsfmValidationIssue {
  rule: UsfmValidationRule;
  line: number; // 1-based line number in the rendered USFM
  ref: string | null; // chapter or chapter:verse context, when known
  message: string;
}

// EXACT DCS PARAGRAPH_MARKERS frozenset. `\q`/`\qN` are intentionally absent:
// DCS allows consecutive poetry markers.
const PARAGRAPH_MARKERS = new Set(["\\p", "\\m", "\\pi", "\\mi", "\\nb", "\\cls"]);

// `\c N` alone on its line (DCS: `re.match(r"\\c\s+\d+\s*$", stripped)`).
const CHAPTER_LINE_RE = /^\\c\s+\d+\s*$/;
// A `\c N` appearing anywhere in the line (DCS: `re.search(r"\\c\s+\d+")`).
const CHAPTER_ANY_RE = /\\c\s+\d+/;
// A `\p` not immediately followed by a letter/digit — so `\pi`/`\pc` don't match
// (DCS: `re.search(r"\\p(?!\w)", stripped)`).
const PARAGRAPH_P_RE = /\\p(?![A-Za-z0-9])/;
// The `\ts\*` section-chunk milestone, matched literally (DCS: `"\\ts\\*" in stripped`).
const TS_MARKER = "\\ts\\*";
// A `\b` not immediately followed by a word char (DCS: `re.search(r"\\b(?!\w)")`).
// The class spells out Python's `\w`, which includes `_`, so `\b_` is not a match
// there and must not be one here either.
const B_MARKER_RE = /\\b(?![A-Za-z0-9_])/;
// Every `\v N` occurrence on the line (DCS: `re.findall(r"\\v\s+\d+")`).
const VERSE_G_RE = /\\v\s+\d+/g;
const VERSE_NUM_RE = /\\v\s+(\d+)/;

// Markers permitted before a `\v` on the same line — mirrors DCS's
// `_VERSE_PREFIX_RE` exactly, and the two ways it is easy to get wrong both make
// us ship USFM that DCS then hard-rejects:
//
//   - It is `$`-ANCHORED, and DCS applies it with `re.match` to the WHOLE trimmed
//     text before the `\v`. A word-boundary anchor instead of `$` passes
//     `\p “And he said\v 5` — the marker matches and the leaked text after it is
//     never examined. That is precisely the usfm-js shape this codebase already
//     knows about (an opening quote parked on a marker node's `text`), so the
//     permissive form silently waves through the one defect most likely to occur.
//   - `b` is NOT in DCS's alternation. `\b\v 5` is an error there, so it must be
//     one here too.
//
// Getting either wrong does not "let a book through" — DCS still rejects it, the
// `-be-` PR check goes red, and `merge-be-pr.yaml` never merges. The only thing
// a permissive port buys is that the book is withheld with no banner naming why.
const VERSE_PREFIX_RE =
  /^\\(q[0-9]?|qm[0-9]?|qr|qc|qa|qd|li[0-9]?|pi[0-9]?|ph[0-9]?|p|m|mi|nb|pc|cls)$/;

/**
 * Validate rendered USFM against the ported DCS structural checks. Returns every
 * issue found (empty array = valid). Line numbers are 1-based.
 */
export function validateUsfm(usfmText: string): UsfmValidationIssue[] {
  const issues: UsfmValidationIssue[] = [];
  const lines = usfmText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let currentChapter: number | null = null;
  let currentVerse: number | null = null;
  let prevWasParagraph = false;
  let prevParagraphLine = 0;
  // Check 8 only. In DCS these are two SEPARATE functions with different header
  // handling: Check 7 (`validate_usfm_content`) walks every line from line 1,
  // while Check 8 (`validate_usfm_formatting`) skips the header — "everything
  // before the first blank line" — and never re-enters header mode afterwards.
  // Running Check 8 over the header too (as this port used to) is the one
  // divergence that could withhold a book DCS would have merged, so the skip is
  // placed below Check 7, not above it.
  let inHeader = true;
  // Previous line's trimmed text, for the `\b`-after-`\ts\*` ordering rule.
  // Faithful to DCS's own `prev_non_blank`, which — despite the name — is
  // reassigned on EVERY iteration including blank lines, so a blank line between
  // `\ts\*` and `\b` clears it and the pair is not flagged. Our renderer's
  // blankLinePass inserts exactly such a blank line, so replicate the behaviour
  // rather than the name.
  let prevNonBlank = "";

  const refOf = (): string | null => {
    if (currentChapter == null) return null;
    return currentVerse == null ? `${currentChapter}` : `${currentChapter}:${currentVerse}`;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const stripped = lines[i].trim();

    // Track chapter/verse context for issue refs.
    const cMatch = stripped.match(/\\c\s+(\d+)/);
    if (cMatch) {
      currentChapter = Number(cMatch[1]);
      currentVerse = null;
    }
    const vMatch = stripped.match(VERSE_NUM_RE);
    if (vMatch) currentVerse = Number(vMatch[1]);

    // ── Check 7: consecutive paragraph markers ──────────────────────────────
    // A blank line resets the run (DCS: stripped "" is not in PARAGRAPH_MARKERS).
    const isParagraph = PARAGRAPH_MARKERS.has(stripped);
    if (isParagraph && prevWasParagraph) {
      issues.push({
        rule: "consecutive-paragraph-markers",
        line: lineNumber,
        ref: currentChapter == null ? null : `${currentChapter}`,
        message: `Consecutive paragraph marker "${stripped}" at line ${lineNumber} (previous at line ${prevParagraphLine}).`,
      });
    }
    if (isParagraph) {
      prevWasParagraph = true;
      prevParagraphLine = lineNumber;
    } else {
      prevWasParagraph = false;
    }

    // ── Check 8: USFM formatting ────────────────────────────────────────────
    // Header skip (DCS: `if in_header: if not stripped: in_header = False; continue`).
    // Blank lines past the header are deliberately NOT skipped: DCS has no
    // blank-line `continue` here, and letting them fall through is what clears
    // `prevNonBlank` below.
    if (inHeader) {
      if (stripped === "") inHeader = false;
      continue;
    }

    // `\c N` must be alone on its line.
    if (CHAPTER_ANY_RE.test(stripped) && !CHAPTER_LINE_RE.test(stripped)) {
      issues.push({
        rule: "chapter-marker-not-isolated",
        line: lineNumber,
        ref: refOf(),
        message: `Chapter marker must be alone on its line: "${stripped}".`,
      });
    }

    // `\p` must be alone on its line.
    if (PARAGRAPH_P_RE.test(stripped) && stripped !== "\\p") {
      issues.push({
        rule: "paragraph-marker-not-isolated",
        line: lineNumber,
        ref: refOf(),
        message: `Paragraph marker \\p must be alone on its line: "${stripped}".`,
      });
    }

    // `\ts\*` must be alone on its line. Ported because the LAM `\ts\*` pump is
    // a live shape in this repo (collapseConsecutiveTsMarkers exists for it), and
    // a `\ts\*` fused onto a content line is a DCS hard error we were not seeing.
    if (stripped.includes(TS_MARKER) && stripped !== TS_MARKER) {
      issues.push({
        rule: "ts-marker-not-isolated",
        line: lineNumber,
        ref: refOf(),
        message: `\\ts\\* must be alone on its line: "${stripped}".`,
      });
    }

    // `\b` must be alone on its line.
    if (B_MARKER_RE.test(stripped) && stripped !== "\\b") {
      issues.push({
        rule: "b-marker-not-isolated",
        line: lineNumber,
        ref: refOf(),
        message: `\\b must be alone on its line: "${stripped}".`,
      });
    }

    // `\b` must come before `\ts\*`, not after it.
    if (stripped === "\\b" && prevNonBlank === TS_MARKER) {
      issues.push({
        rule: "b-marker-after-ts",
        line: lineNumber,
        ref: refOf(),
        message: `\\b appears immediately after \\ts\\* (line ${lineNumber}); \\b must come before it.`,
      });
    }

    // At most one `\v` per line.
    const verses = stripped.match(VERSE_G_RE);
    if (verses && verses.length > 1) {
      issues.push({
        rule: "multiple-verses-per-line",
        line: lineNumber,
        ref: refOf(),
        message: `Multiple verse markers on one line (${verses.length}): "${stripped}".`,
      });
    }

    // Only a paragraph/poetry marker may precede `\v` on its line.
    const vIndex = stripped.search(/\\v\s+\d+/);
    if (vIndex > 0) {
      const beforeV = stripped.slice(0, vIndex).trim();
      if (beforeV && !VERSE_PREFIX_RE.test(beforeV)) {
        issues.push({
          rule: "invalid-content-before-verse",
          line: lineNumber,
          ref: refOf(),
          message: `Content before verse marker on its line: "${beforeV}".`,
        });
      }
    }

    prevNonBlank = stripped;
  }

  return issues;
}

/** Convenience: true when the rendered USFM has any structural validation error. */
export function hasUsfmValidationErrors(usfmText: string): boolean {
  return validateUsfm(usfmText).length > 0;
}

/** Compact one-line summary of issues for a HOLD alert / snapshot reason. */
export function summarizeUsfmIssues(issues: UsfmValidationIssue[]): string {
  if (issues.length === 0) return "none";
  const byRule = new Map<UsfmValidationRule, number>();
  for (const it of issues) byRule.set(it.rule, (byRule.get(it.rule) ?? 0) + 1);
  const parts = [...byRule.entries()].map(([rule, n]) => `${rule}×${n}`);
  const first = issues[0];
  return `${parts.join(", ")} (first: line ${first.line}${first.ref ? ` ${first.ref}` : ""})`;
}

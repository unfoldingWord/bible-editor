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
// Every `\v N` occurrence on the line (DCS: `re.findall(r"\\v\s+\d+")`).
const VERSE_G_RE = /\\v\s+\d+/g;
const VERSE_NUM_RE = /\\v\s+(\d+)/;

// Markers permitted before a `\v` on the same line — mirrors DCS's
// `_VERSE_PREFIX_RE`. A poetry/paragraph marker token (optionally the sole token
// before the verse) is allowed; anything else before `\v` is leaked prior-verse
// content DCS flags.
const VERSE_PREFIX_RE =
  /^\\(q[0-9]?|qm[0-9]?|qr|qc|qa|qd|li[0-9]?|pi[0-9]?|ph[0-9]?|m|mi|nb|pc|cls|p|b)\b/;

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

    if (stripped === "") continue;

    // ── Check 8: USFM formatting ────────────────────────────────────────────
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

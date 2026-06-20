// Export-side normalizers for TSV (tn/tq/twl) rows, mirroring the mechanical
// (auto-fixable) DCS checks in validate_tn_files.py so the exported snapshot is
// valid by construction. Pure string/array transforms — no D1 knowledge.
//
// Covers the "clear case" auto-fixes (user decision 2026-06-20): trailing literal
// `\n` (Check 10 Note Ending), straight quotes -> curly (Check 15), the
// Alternate-translation label spelling/case/spacing (Check 12), and reference
// ordering (Check 11). The judgement-call checks — unmatched square brackets
// (13), a missing sentence terminator before a label (12), malformed references
// (6), broken rc:// links (7) — are NOT touched here; they surface in the in-app
// per-book issues flag (see docs/export-validation-cleanup.md).

// ── Note text normalizers ────────────────────────────────────────────────────

// Strip a trailing run of literal `\n` (the two-char escape TN uses for line
// breaks) plus any trailing whitespace. Check 10: "Note must not end with \n".
export function trimTrailingLiteralN(s: string): string {
  return s.replace(/(?:\\n|\s)+$/u, "");
}

// Convert straight quotes to curly (SmartyPants-style). Apostrophes between
// letters (person's), opening quotes after whitespace/brackets, and closing
// quotes elsewhere. Only touches ASCII ' and " — existing curly quotes and all
// other content (Hebrew, markdown, rc:// links) are left untouched.
export function educateQuotes(s: string): string {
  if (!s.includes("'") && !s.includes('"')) return s;
  return (
    s
      // opening double quote: at start, or after whitespace / open bracket /
      // an existing opening curly quote / a dash
      .replace(/(^|[\s([{<‘“—–-])"/gu, "$1“")
      // any remaining double quote -> closing
      .replace(/"/gu, "”")
      // opening single quote: same leading contexts
      .replace(/(^|[\s([{<“—–-])'/gu, "$1‘")
      // any remaining single quote -> apostrophe / closing
      .replace(/'/gu, "’")
  );
}

// Canonicalize the "Alternate translation" label: fix the "Alternative" spelling,
// a capital T, and zero/extra spaces between the two words; and collapse 2+
// spaces immediately before the label to one. Mirrors the auto-fixable subset of
// Check 12. The case-sensitive leading "Alternat" matches the validator's regex.
export function normalizeAltLabel(s: string): string {
  if (!s.includes("Alternat")) return s;
  let out = s.replace(/Alternat(?:e|ive)( *)([Tt])ranslation/g, "Alternate translation");
  out = out.replace(/(\S) {2,}(Alternate translation)/g, "$1 $2");
  return out;
}

// Compose the prose-cell normalizers. Idempotent and a no-op on clean text.
export function normalizeNoteText(s: string | null): string | null {
  if (s == null) return s;
  return trimTrailingLiteralN(normalizeAltLabel(educateQuotes(s)));
}

// ── Reference ordering (Check 11) ─────────────────────────────────────────────

// Port of validate_tn_files.py parse_reference_order_key. Returns a numeric sort
// key, or null when the reference doesn't parse (a malformed ref — left in place
// and surfaced by Check 6 / the flag UI).
export function parseRefOrderKey(reference: string): number[] | null {
  const colon = reference.indexOf(":");
  if (colon < 0) return null;
  const chapterText = reference.slice(0, colon);
  const verseRaw = reference.slice(colon + 1);

  let chapterValue: number;
  if (chapterText === "front") chapterValue = -1;
  else if (/^\d+$/.test(chapterText)) chapterValue = parseInt(chapterText, 10);
  else return null;

  // Within a chapter: intro (0), front (1), then verses (2).
  if (verseRaw === "intro") return [chapterValue, 0, 0, 0, 0];
  if (verseRaw === "front") return [chapterValue, 1, 0, 0, 0];

  const firstSegment = verseRaw.split(",", 1)[0];
  const hasExtra = verseRaw.includes(",");
  let firstVerse: number;
  let lastVerse: number;
  if (firstSegment.includes("-")) {
    const dash = firstSegment.indexOf("-");
    const startMatch = firstSegment.slice(0, dash).match(/^\d+/);
    const endMatch = firstSegment.slice(dash + 1).match(/^\d+/);
    if (!startMatch) return null;
    firstVerse = parseInt(startMatch[0], 10);
    lastVerse = endMatch ? parseInt(endMatch[0], 10) : firstVerse;
  } else {
    const startMatch = firstSegment.match(/^\d+/);
    if (!startMatch) return null;
    firstVerse = parseInt(startMatch[0], 10);
    lastVerse = firstVerse;
  }
  // Negate lastVerse so a larger range sorts first within the same first verse.
  return [chapterValue, 2, firstVerse, -lastVerse, hasExtra ? 0 : 1];
}

function compareRefKey(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// Stable-sort rows into DCS reference order. Rows with the same reference keep
// their original (sort_order) order, so human note ordering within a verse is
// preserved; only cross-reference order violations (e.g. a `1:5-15` range row
// stored after the `1:5` single-verse row) are corrected. Rows whose reference
// doesn't parse fall back to a key built from the numeric chapter/verse fields.
export function sortRowsByReference<
  T extends { ref_raw: string; chapter: number; verse: number },
>(rows: T[]): T[] {
  const decorated = rows.map((r, idx) => ({
    r,
    idx,
    key: parseRefOrderKey(r.ref_raw) ?? [r.chapter, 2, r.verse, -r.verse, 1],
  }));
  decorated.sort((a, b) => compareRefKey(a.key, b.key) || a.idx - b.idx);
  return decorated.map((d) => d.r);
}

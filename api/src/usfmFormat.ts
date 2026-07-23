// Line-reflow normalizer for exported USFM.
//
// `usfm-js` toUSFM({forcedNewLines:true}) does NOT match the line layout DCS's
// `validate_usfm_files.py` Check 8 ("USFM Formatting") requires: it omits the
// blank lines before `\b`/`\p`/`\ts\*`/`\c`, leaves those markers sharing a line
// with following content, glues `\ts\*`/`\b` onto the `\v` line, sometimes fails
// to break the line at a mid-verse `\v`, and emits the editor's malformed `\ts*`
// (no backslash before the star) verbatim. Every one of those is a Check-8 error.
//
// This is the export-side fix: a faithful port of DCS's own
// `fix_usfm_formatting.py` (blank-line rules + `\b`/`\ts\*` swap), EXTENDED to
// also put `\c`/`\p`/`\b`/`\ts\*` on their own line, lift those markers off the
// `\v` line, break a line so each `\v` starts its own line, and repair `\ts*` ->
// `\ts\*`. Running it on `buildUsfm`'s output makes BE emit DCS-valid USFM by
// construction (see docs/export-validation-cleanup.md).
//
// SAFETY: this only inserts newlines/blank lines, moves standalone milestone
// markers (`\c`/`\p`/`\b`/`\ts\*`) onto their own lines, and repairs `\ts*`. It
// never reorders, splits, or edits `\w`/`\zaln-s`/`\zaln-e`/`\f` inline content,
// so word alignment is untouched. It is idempotent and a no-op on already-clean
// files (so it is safe to run on every export, clean books included).

const CHAPTER_RE = /^\\c\s+\d+\s*$/;

// Standalone structural markers DCS requires to sit ALONE on their own line,
// matched WHEREVER they appear in a line (leading, trailing, or embedded —
// usfm-js does all three). The `(?![A-Za-z0-9])` / `(?![A-Za-z])` guards keep
// `\p` from matching `\pi`/`\pn`/`\fp` and `\b` from matching `\bd`/`\bk`; `\c`
// requires a following integer so `\ca`/`\cls` don't match. `\ts\*` only (the
// malformed `\ts*` is repaired to `\ts\*` before this runs).
const STANDALONE_MARKER_RE = /\\ts\\\*|\\b(?![A-Za-z])|\\p(?![A-Za-z0-9])|\\c\s+\d+/;

// Paragraph/poetry markers that MAY precede `\v` on the same line (mirrors
// `_VERSE_PREFIX_RE` in validate_usfm_files.py) — EXCLUDING `\p`, which is a
// standalone marker (extracted above) and must always be on its own line.
// Shared by ATTACHABLE_PREFIX_RE (whole-string test) and POETRY_PREFIX_RE
// (matched anywhere in a line) so the marker set can't drift between the two.
// Alternative order doesn't matter for correctness: the `(?![A-Za-z0-9])`
// lookahead in POETRY_PREFIX_RE rejects a too-short alternative (e.g. `q`
// matching inside `qm2`) and regex backtracking then tries the next
// alternative at the same position until one satisfies the lookahead.
const POETRY_MARKER_ALTERNATION =
  "q[0-9]?|qm[0-9]?|qr|qc|qa|qd|li[0-9]?|pi[0-9]?|ph[0-9]?|m|mi|nb|pc|cls";

const ATTACHABLE_PREFIX_RE = new RegExp(String.raw`^\\(${POETRY_MARKER_ALTERNATION})$`);

// Same marker family as ATTACHABLE_PREFIX_RE, but matched WHEREVER it appears
// in a line, not just as a whole-string prefix.
const POETRY_PREFIX_RE = new RegExp(
  String.raw`\\(${POETRY_MARKER_ALTERNATION})(?![A-Za-z0-9])`,
  "g",
);

const VERSE_RE = /\\v\s+\d+/;

// DCS `validate_usfm_files.py` Check 7 ("Consecutive Paragraph Markers") flags
// two back-to-back lines each equal to one of these markers. This is EXACTLY the
// set the validator uses (PARAGRAPH_MARKERS frozenset). `\q`/`\qN` are NOT here:
// DCS allows consecutive poetry markers, so we must never collapse those.
const PARAGRAPH_MARKERS = new Set(["\\p", "\\m", "\\pi", "\\mi", "\\nb", "\\cls"]);

// Repair the editor's malformed `\ts*` (missing backslash before the star) to
// the proper self-closing milestone `\ts\*`. The pattern only matches `\ts*`,
// never a well-formed `\ts\*` (which has a backslash before the star).
function repairTsStar(s: string): string {
  return s.replace(/\\ts\*/g, "\\ts\\*");
}

// Pull every standalone structural marker out of a line onto its own line, in
// order, leaving the surrounding content (which is never modified) as its own
// line(s). E.g. `\w drink\w*\zaln-e\*!” \p` -> [`\w drink\w*\zaln-e\*!”`, `\p`];
// `…?”\p\zaln-s …` -> [`…?”`, `\p`, `\zaln-s …`].
function extractStandaloneMarkers(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (;;) {
    const m = rest.match(STANDALONE_MARKER_RE);
    if (!m || m.index === undefined) {
      const tail = rest.trim();
      if (tail) out.push(tail);
      break;
    }
    const before = rest.slice(0, m.index).trim();
    if (before) out.push(before);
    out.push(m[0].trim());
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// Break `rest` so each `\v` starts its own line, keeping at most a single
// attachable prefix marker (e.g. `\q1`) on the verse line. Content that precedes
// the first `\v` but is NOT a lone prefix marker (the tail of the previous verse
// that usfm-js failed to break) becomes its own line.
function splitAtVerses(rest: string): string[] {
  if (!VERSE_RE.test(rest)) return [rest];
  const parts = rest.split(/(?=\\v\s+\d+)/); // each part after [0] starts with \v
  const head = parts[0].trim();
  const verses = parts.slice(1).map((p) => p.trim());
  const out: string[] = [];
  if (head === "") {
    // nothing before the first \v
  } else if (ATTACHABLE_PREFIX_RE.test(head)) {
    verses[0] = `${head} ${verses[0]}`;
  } else {
    out.push(head); // tail of previous verse → its own line
  }
  out.push(...verses);
  return out;
}

// Break `seg` before every mid-line occurrence of a poetry/paragraph prefix
// marker (e.g. `\q2`), leaving a marker that starts at position 0 attached to
// whatever follows it (that leading case is `splitAtVerses`'s job — it decides
// whether the marker attaches to an immediately-following `\v`). Fixes the
// usfm-js shape where a poetry marker lands mid-line after a `\zaln-e`/`\w*`
// with no newline before it (e.g. `…\zaln-e\*,\q2\zaln-s …`), which DCS
// requires to start its own line.
function splitMidlinePoetryMarkers(seg: string): string[] {
  const s = seg.trim();
  if (s === "") return [""];
  POETRY_PREFIX_RE.lastIndex = 0;
  const out: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = POETRY_PREFIX_RE.exec(s))) {
    if (m.index === cursor) continue; // marker starts this segment — leave attached
    const before = s.slice(cursor, m.index).trim();
    if (before) out.push(before);
    cursor = m.index;
  }
  const tail = s.slice(cursor).trim();
  if (tail) out.push(tail);
  return out.length ? out : [s];
}

// Split one physical line into the structural lines DCS expects: each standalone
// marker on its own line, then verse lines (one `\v` each).
function splitStructuralLine(raw: string): string[] {
  const s = repairTsStar(raw.trim());
  if (s === "") return [""];
  const out: string[] = [];
  for (const seg of extractStandaloneMarkers(s)) {
    for (const sub of splitMidlinePoetryMarkers(seg)) {
      out.push(...splitAtVerses(sub));
    }
  }
  return out.length ? out : [""];
}

// Canonical order for adjacent standalone markers: `\b` < `\ts\*` < `\c` < `\p`.
// (From uW USFM: `\b` precedes `\ts\*` per fix_usfm_formatting.py, and a section
// opens `\ts\* \c \p` per real ULT files.) -1 = not a standalone marker.
function markerPriority(line: string): number {
  const s = line.trim();
  if (s === "\\b") return 0;
  if (s === "\\ts\\*") return 1;
  if (CHAPTER_RE.test(s)) return 2;
  if (s === "\\p") return 3;
  return -1;
}

// Reorder each run of adjacent standalone markers into canonical order, dropping
// any blank lines inside the run (the blank-line pass re-adds the correct ones).
// This subsumes the fix_usfm_formatting.py `\ts\*`/`\b` swap and also repairs the
// usfm-js `\p \ts\*` shape (a paragraph glued before a section milestone), which
// neither order can satisfy until `\ts\*` is moved before `\p`. A "run" is broken
// by any verse/content line, so markers around real content are never moved.
function reorderMarkerRuns(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (markerPriority(lines[i]) < 0) {
      out.push(lines[i]);
      i++;
      continue;
    }
    // Collect a run of standalone markers, skipping interspersed blank lines but
    // stopping at the first content line (or trailing blank that ends the run).
    const run: string[] = [];
    let j = i;
    while (j < lines.length) {
      if (markerPriority(lines[j]) >= 0) {
        run.push(lines[j]);
        j++;
      } else if (lines[j].trim() === "") {
        let k = j;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k < lines.length && markerPriority(lines[k]) >= 0) {
          j = k; // blank(s) between two markers — skip, run continues
        } else break;
      } else break;
    }
    // Stable sort by priority (Array.prototype.sort is stable in Node 24).
    run.sort((a, b) => markerPriority(a) - markerPriority(b));
    // NB: consecutive duplicate `\p` inside this run (the EZK 8/11 chapter-front
    // pile-up) are collapsed by the general collapseConsecutiveParagraphMarkers
    // pass below, which also handles the `\m`/`\pi`/`\mi`/`\nb`/`\cls` family and
    // blank-separated runs — so we don't dedupe here.
    out.push(...run);
    i = j;
  }
  return out;
}

// Collapse a run of consecutive IDENTICAL paragraph-family markers to one
// (`\p \p` -> `\p`). This is the export-side auto-fix for DCS Check 7
// ("Consecutive Paragraph Markers") and the direct fix for the EZK 8/11 front-`\p`
// pump — a stray extra `\p` accumulated at the chapter front one per nightly
// export and only DCS CI ever caught it. Blank lines between the markers are
// treated as separators for emission but do NOT reset the run, so `\p`+blank+`\p`
// collapses too (the following blankLinePass re-adds any canonical blank line).
// Any real content line (a `\v`, text, or a non-paragraph marker) resets the run,
// so two `\p` on either side of actual paragraph content are always preserved.
// Only identical markers collapse: a genuinely mixed `\p`/`\m` adjacency is left
// intact for the validator to HOLD on rather than silently guessing which to drop.
function collapseConsecutiveParagraphMarkers(lines: string[]): string[] {
  const out: string[] = [];
  let prevParagraph: string | null = null;
  for (const line of lines) {
    const s = line.trim();
    if (s === "") {
      out.push(line); // blank: keep, don't reset the run
      continue;
    }
    if (PARAGRAPH_MARKERS.has(s)) {
      if (prevParagraph === s) continue; // drop the duplicate
      prevParagraph = s;
      out.push(line);
      continue;
    }
    prevParagraph = null; // any real content ends the run
    out.push(line);
  }
  return out;
}

// Add/remove blank lines around `\b`/`\ts\*`/`\p`/`\c`. Ported faithfully from
// fix_usfm_formatting.py's main pass.
function blankLinePass(lines: string[]): string[] {
  const result: string[] = [];
  let inHeader = true;

  for (const rawLine of lines) {
    const stripped = rawLine.trim();

    if (inHeader) {
      result.push(rawLine);
      if (!stripped) inHeader = false;
      continue;
    }

    // Previous non-blank line in the result so far + whether a blank precedes here.
    let prevNonBlank = "";
    let prevLineBlank = false;
    for (let j = result.length - 1; j >= 0; j--) {
      if (result[j].trim() === "") {
        prevLineBlank = true;
        continue;
      }
      prevNonBlank = result[j].trim();
      break;
    }

    const isB = stripped === "\\b";
    const isTs = stripped === "\\ts\\*";
    const isP = stripped === "\\p";
    const isC = CHAPTER_RE.test(stripped);

    // Remove blank lines after \c, \b, \ts\*, \p.
    if (!stripped) {
      const prevIsC = CHAPTER_RE.test(prevNonBlank);
      const prevIsB = prevNonBlank === "\\b";
      const prevIsTs = prevNonBlank === "\\ts\\*";
      const prevIsP = prevNonBlank === "\\p";
      if (prevIsC || prevIsB || prevIsTs || prevIsP) continue;
    }

    // Add blank lines where needed.
    if (isB) {
      if (!prevLineBlank) result.push("");
    } else if (isTs) {
      if (!prevLineBlank && prevNonBlank !== "\\b" && prevNonBlank !== "\\ts\\*") result.push("");
    } else if (isP) {
      if (
        !prevLineBlank &&
        prevNonBlank !== "\\ts\\*" &&
        !CHAPTER_RE.test(prevNonBlank) &&
        prevNonBlank !== "\\b"
      )
        result.push("");
    } else if (isC) {
      if (
        !prevLineBlank &&
        prevNonBlank !== "\\ts\\*" &&
        prevNonBlank !== "\\p" &&
        prevNonBlank !== "\\b"
      )
        result.push("");
    }

    result.push(rawLine);
  }

  return result;
}

// Normalize a rendered USFM blob to DCS's line layout. Trailing newline is
// preserved (usfm-js emits one).
export function normalizeUsfmFormatting(usfmText: string): string {
  const hadTrailingNewline = usfmText.endsWith("\n");
  const normalizedEols = usfmText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalizedEols.split("\n");

  let lines: string[] = [];
  for (const raw of rawLines) lines.push(...splitStructuralLine(raw));
  lines = reorderMarkerRuns(lines);
  lines = collapseConsecutiveParagraphMarkers(lines);
  lines = blankLinePass(lines);

  let out = lines.join("\n");
  if (hadTrailingNewline && !out.endsWith("\n")) out += "\n";
  return out;
}

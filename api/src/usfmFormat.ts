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

// usfm-js's own line-builder (jsonToUsfm.js) deliberately omits the space
// between a marker and an immediately-following `w`/`k`/`zaln` tag, e.g.
// `\q2\zaln-s |x-strong="H1"\*…`. DCS Check 8 requires the space. Matches a
// leading poetry/paragraph marker (same family as ATTACHABLE_PREFIX_RE) glued
// directly to a following backslash, so we can re-insert the missing space.
// The `(?!\\\*)` guard keeps this from firing on a legitimate closing-star
// form (`\ts\*`, `\qs\*`) — those markers aren't even in this alternation, but
// the guard is kept general rather than relying on that alone. Verified scale:
// 748 occurrences on en_ust master (`\q2` x461, `\q1` x287, all before
// `\zaln-s`); Rich fixed the en_ult analog in commit 543e3ee9 (2026-08-05).
const MARKER_GLUED_TO_NEXT_RE = new RegExp(
  String.raw`^\\(${POETRY_MARKER_ALTERNATION})(?![A-Za-z0-9])(?=\\)(?!\\\*)`,
);

function insertSpaceAfterGluedMarker(line: string): string {
  const m = line.match(MARKER_GLUED_TO_NEXT_RE);
  if (!m) return line;
  return `${m[0]} ${line.slice(m[0].length)}`;
}

// `splitMidlinePoetryMarkers` treats every mid-line poetry-marker occurrence as
// a split point, so a line already carrying a doubled leading marker (e.g. the
// usfm-js shape `\q1 \q1 \v 1 …`) gets split into two lines — `\q1` alone, then
// `\q1 \v 1 …` — which is worse than the original doubling. Collapse an
// immediately-repeated identical leading marker before that split runs.
function collapseDuplicateLeadingMarker(seg: string): string {
  return seg.replace(/^(\\[A-Za-z0-9]+)(\s+)\1(?=\s|$)/, "$1");
}

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
    const deduped = collapseDuplicateLeadingMarker(seg);
    for (const sub of splitMidlinePoetryMarkers(deduped)) {
      out.push(...splitAtVerses(sub).map(insertSpaceAfterGluedMarker));
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

// A line whose ENTIRE content is `\v N` (optionally with a `-M` bridge and/or
// a single leading marker) and nothing else. Matched against a trimmed line.
const DANGLING_VERSE_RE = /^(?:(\\[A-Za-z0-9]+)\s+)?(\\v\s+\d+(?:-\d+)?)\s*$/;

// A leading attachable marker on a content line, e.g. `\q2 <text>` -> marker
// `\q2`, rest `<text>`. Only strips markers from the same attachable family as
// ATTACHABLE_PREFIX_RE — this is the marker that may end up displaced onto the
// merged `\v` line, never an arbitrary backslash token.
const LEADING_CONTENT_MARKER_RE = /^(\\[A-Za-z0-9]+)\s+(\S.*)$/;

function stripLeadingAttachableMarker(line: string): { marker: string | null; rest: string } {
  const s = line.trim();
  const m = s.match(LEADING_CONTENT_MARKER_RE);
  if (m && ATTACHABLE_PREFIX_RE.test(m[1])) return { marker: m[1], rest: m[2] };
  return { marker: null, rest: s };
}

// A line that carries nothing but a standalone structural marker (`\p`, `\b`,
// `\ts\*`, `\c N`) or a bare attachable poetry/paragraph marker (`\q1`, etc,
// with nothing following it on the line).
function isMarkerOnlyLine(line: string): boolean {
  const s = line.trim();
  if (s === "") return false;
  return markerPriority(s) >= 0 || ATTACHABLE_PREFIX_RE.test(s);
}

// usfm-js sometimes emits a `\v N` with no verse text on its own line, the
// text instead landing on the next physical line (occasionally after one or
// more structural marker lines and/or blank lines). DCS requires the verse
// number to lead its actual content. Verified against all 680 of Rich Mahn's
// 2026-08-07 hand-fixes (659 in NUM alone) — this single rule explains 679 of
// them; the 680th (27-DAN.usfm 1:1) is a one-off editorial deletion of a stray
// `\q2` and is deliberately NOT special-cased here.
//
// For each dangling `\v` line, walk forward: blank lines are held as pending
// (deleted unless a kept marker line follows); a marker-only line is kept,
// along with any blanks pending before it, and the walk continues; the first
// line with real text is the merge target and ends the walk. Running off the
// end leaves the `\v` line untouched. The marker already on the `\v` line
// always wins over one stripped from the target; if only the target has a
// leading marker, that marker moves above the verse number.
function joinDanglingVerses(lines: string[]): string[] {
  const out: string[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const dv = lines[i].trim().match(DANGLING_VERSE_RE);
    if (!dv) {
      out.push(lines[i]);
      continue;
    }
    const dvMarker = dv[1] ?? null;
    const dvVerse = dv[2];

    let pending: number[] = [];
    const keep: number[] = [];
    let targetIdx = -1;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j].trim() === "") {
        pending.push(j);
        j++;
        continue;
      }
      if (isMarkerOnlyLine(lines[j])) {
        keep.push(...pending, j);
        pending = [];
        j++;
        continue;
      }
      targetIdx = j;
      break;
    }

    if (targetIdx === -1) {
      out.push(lines[i]); // ran off the end — leave untouched
      continue;
    }

    const { marker: targetMarker, rest: targetRest } = stripLeadingAttachableMarker(
      lines[targetIdx],
    );
    const winningMarker = dvMarker ?? targetMarker;
    const merged = winningMarker
      ? `${winningMarker} ${dvVerse} ${targetRest}`
      : `${dvVerse} ${targetRest}`;

    for (const idx of keep) out.push(lines[idx]);
    out.push(merged);
    // Everything between the dangling \v line and its target is spoken for now
    // — either re-emitted above (kept marker lines) or deliberately dropped
    // (pending blanks that never preceded a kept marker) — so mark the WHOLE
    // span consumed, not just the indices we re-pushed.
    for (let idx = i + 1; idx <= targetIdx; idx++) consumed.add(idx);
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

// Collapse a run of consecutive `\ts\*` section-chunk milestones to one. Same
// shape as collapseConsecutiveParagraphMarkers, but for the `\ts\*` self-closing
// milestone, which is NOT a DCS Check-7 paragraph marker (so that pass leaves it
// alone) yet piles up the same way: an extra `\ts\*` accumulated at LAM chapter
// boundaries (trailing on the last verse, just before `\c`) one per nightly
// export. BE renders `\ts\*` idempotently and never created the extra one — the
// DCS-side merge of the never-rebased `-be-` export branch re-injects it — but BE
// never collapsed the stack either, so it carried the growth forward. This is the
// exact analog of the EZK 8/11 front-`\p` pump (see collapseConsecutiveParagraph
// Markers + STATE.md). Two adjacent `\ts\*` mark the same chunk boundary twice and
// are always redundant, so collapsing to one is safe. `repairTsStar` has already
// normalized any malformed `\ts*` to `\ts\*` by the time this runs, so matching
// the well-formed token is sufficient. Blank lines between the markers are
// separators that do NOT reset the run (the following blankLinePass re-adds the
// canonical blank line); any real content line resets it, so a `\ts\*` on either
// side of genuine content is always preserved.
function collapseConsecutiveTsMarkers(lines: string[]): string[] {
  const out: string[] = [];
  let prevWasTs = false;
  for (const line of lines) {
    const s = line.trim();
    if (s === "") {
      out.push(line); // blank: keep, don't reset the run
      continue;
    }
    if (s === "\\ts\\*") {
      if (prevWasTs) continue; // drop the duplicate
      prevWasTs = true;
      out.push(line);
      continue;
    }
    prevWasTs = false; // any real content ends the run
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

// Collapse any run of 2+ consecutive blank lines to exactly one. Mirrors
// blankLinePass's header handling: everything up to and including the first
// blank line (the header/ID block) is passed through untouched, since that
// region's blank-line layout is not this normalizer's concern.
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let inHeader = true;
  let prevBlank = false;
  for (const line of lines) {
    if (inHeader) {
      out.push(line);
      if (line.trim() === "") inHeader = false;
      continue;
    }
    const isBlank = line.trim() === "";
    if (isBlank && prevBlank) continue; // drop the extra blank
    out.push(line);
    prevBlank = isBlank;
  }
  return out;
}

// Normalize a rendered USFM blob to DCS's line layout. Output always ends
// with exactly one trailing newline, regardless of the input's.
export function normalizeUsfmFormatting(usfmText: string): string {
  const normalizedEols = usfmText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalizedEols.split("\n");

  let lines: string[] = [];
  for (const raw of rawLines) lines.push(...splitStructuralLine(raw));
  lines = reorderMarkerRuns(lines);
  lines = joinDanglingVerses(lines);
  lines = collapseConsecutiveParagraphMarkers(lines);
  lines = collapseConsecutiveTsMarkers(lines);
  lines = blankLinePass(lines);
  lines = collapseBlankRuns(lines);

  let out = lines.join("\n");
  out = out.replace(/\n*$/, "\n");
  return out;
}

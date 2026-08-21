// MIRROR of api/src/usfmFormat.ts — keep the two in sync.
//
// This is a verbatim copy of the server's DCS line-reflow normalizer, duplicated
// into the web workspace because the client USFM download (web/src/lib/exportUsfm.ts)
// must produce the same DCS-valid line layout the nightly export does, and the
// server module can't be imported across the api↔web workspace boundary (the same
// reason recomputeTargetOccurrences / synthesizeHeaders are mirrored). It has no
// imports and is pure, so the copy is exact. If you change one, change both.
//
// ── original doc ─────────────────────────────────────────────────────────────
// Line-reflow normalizer for exported USFM.
//
// `usfm-js` toUSFM({forcedNewLines:true}) does NOT match the line layout DCS's
// `validate_usfm_files.py` Check 8 ("USFM Formatting") requires: it omits the
// blank lines before `\b`/`\p`/`\ts\*`/`\c`, leaves those markers sharing a line
// with following content, glues `\ts\*`/`\b` onto the `\v` line, sometimes fails
// to break the line at a mid-verse `\v`, and emits the editor's malformed `\ts*`
// (no backslash before the star) verbatim. Every one of those is a Check-8 error.
//
// SAFETY: this only inserts newlines/blank lines, moves standalone milestone
// markers (`\c`/`\p`/`\b`/`\ts\*`) onto their own lines, and repairs `\ts*`. It
// never reorders, splits, or edits `\w`/`\zaln-s`/`\zaln-e`/`\f` inline content,
// so word alignment is untouched. It is idempotent and a no-op on already-clean
// files (so it is safe to run on every export, clean books included).

const CHAPTER_RE = /^\\c\s+\d+\s*$/;

// `\s`/`\s1`-`\s5` section headings. Unlike the other markers in
// `markerPriority` these always carry heading text on the same line (there is
// no bare/standalone form to match against), so this is matched by leading
// marker rather than a whole-line equality check — same approach as the
// `\s`-family branch of `ABORT_LEADING_RE` below.
const SECTION_HEADING_RE = /^\\s[1-5]?(?![A-Za-z0-9])/;

// Paragraph-family markers that DCS requires to sit ALONE on their own line
// and NEVER attached to following content or a `\v` line — same requirement
// as `\p`, extended to the rest of PARAGRAPH_MARKERS (declared below) plus
// numbered variants (`\pi1`, `\pi2`, `\mi1`...). Measured directly: in Rich
// Mahn's hand-cleaned files, `\m` is own-line 4/4 (joined 0 times), `\p`
// own-line 452/452, `\pi1` own-line 13/13 — never once fused to following
// content. `\mi`/`\nb`/`\cls` have zero occurrences in the sampled corpus, so
// their inclusion here is an EXTRAPOLATION from the same paragraph-marker
// principle, not direct measurement.
const PARAGRAPH_FAMILY_ALTERNATION = "m|pi[0-9]?|mi[0-9]?|nb|cls";

// Standalone structural markers DCS requires to sit ALONE on their own line,
// matched WHEREVER they appear in a line (leading, trailing, or embedded —
// usfm-js does all three). The `(?![A-Za-z0-9])` / `(?![A-Za-z])` guards keep
// `\p` from matching `\pi`/`\pn`/`\fp`, `\b` from matching `\bd`/`\bk`, and
// `\m` from matching `\mi`/`\mt`/`\ms`; `\c` requires a following integer so
// `\ca`/`\cls` don't match. `\ts\*` only (the malformed `\ts*` is repaired to
// `\ts\*` before this runs).
const STANDALONE_MARKER_RE = new RegExp(
  String.raw`\\ts\\\*|\\b(?![A-Za-z])|\\p(?![A-Za-z0-9])|\\c\s+\d+|\\(${PARAGRAPH_FAMILY_ALTERNATION})(?![A-Za-z0-9])`,
);

// Poetry markers that MAY precede `\v` on the same line (mirrors
// `_VERSE_PREFIX_RE` in validate_usfm_files.py) — EXCLUDING `\p` and the
// PARAGRAPH_FAMILY_ALTERNATION markers, which are standalone (extracted
// above) and must always be on their own line, never attached to a `\v`.
// Shared by ATTACHABLE_PREFIX_RE (whole-string test) and POETRY_PREFIX_RE
// (matched anywhere in a line) so the marker set can't drift between the two.
// Alternative order doesn't matter for correctness: the `(?![A-Za-z0-9])`
// lookahead in POETRY_PREFIX_RE rejects a too-short alternative (e.g. `q`
// matching inside `qm2`) and regex backtracking then tries the next
// alternative at the same position until one satisfies the lookahead.
const POETRY_MARKER_ALTERNATION = "q[0-9]?|qm[0-9]?|qr|qc|qa|qd|li[0-9]?|ph[0-9]?|pc";

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
// `\q1 \v 1 …` — which is worse than the original doubling. Collapse a run of
// 2+ immediately-repeated identical leading markers before that split runs.
//
// Narrowed to exactly the observed defect: a naive "any marker family, any
// following content" version also turned `\s1 \s1 Heading` into `\s1 Heading`
// and `\q1 \q1 text` into `\q1 text` — but in USFM `\q1 \q1 text` legitimately
// means "an empty poetry line, then a poetry line with text", so collapsing it
// deletes a rendered line. So this only fires when (a) the repeated marker is
// from the attachable poetry family (ATTACHABLE_PREFIX_RE's set — `\s1` is
// not in it) AND (b) a `\v` follows the doubled marker — the only two real
// instances found were both `\q1 \q1 \v 1 …` in `30-AMO.usfm` (lines 1334,
// 2393), each immediately after a `\c N`.
function collapseDuplicateLeadingMarker(seg: string): string {
  const lead = seg.match(/^(\\[A-Za-z0-9]+)(?=\s|$)/);
  if (!lead || !ATTACHABLE_PREFIX_RE.test(lead[1])) return seg;
  const marker = lead[1];
  let rest = seg;
  let repeats = 0;
  while (rest.startsWith(marker)) {
    const after = rest.slice(marker.length);
    const ws = after.match(/^\s+/);
    if (!ws) break; // marker not followed by whitespace — not a bare repeat
    rest = after.slice(ws[0].length);
    repeats++;
  }
  if (repeats < 2) return seg; // nothing doubled
  if (!/^\\v\s+\d+(?:\s|$)/.test(rest)) return seg; // only collapse before a \v
  return `${marker} ${rest}`;
}

// A line whose ENTIRE trimmed content is a plain poetry marker — `\q`,
// `\q1`-`\q4` — and nothing else. Deliberately its OWN regex rather than a
// reuse of ATTACHABLE_PREFIX_RE: that alternation also covers `\m`, `\mi`,
// `\nb`, `\pc`, `\cls`, `\li[0-9]?`, `\pi[0-9]?`, `\ph[0-9]?`, `\qm[0-9]?`,
// `\qa`, `\qc`, `\qr`, `\qd`, and a corpus census of the DCS master books we
// export found the maintainer NEVER joins those onto the following `\v`
// (`\m` 0/187, `\pi1` 0/81, `\mi` 0/3) — only the plain `\q`/`\qN` family gets
// this treatment. Widening to the full attachable set would be a regression.
const LONE_POETRY_MARKER_RE = /^\\q[1-4]?$/;

// A line the join target may be: the next verse (`\v N …`, including a
// bridge like `\v 6-9`), or content that continues the CURRENT verse across a
// physical line break — inline alignment/word/footnote/figure markup, or bare
// text/punctuation carrying no marker at all. Deliberately a WHITELIST, not a
// blacklist, so an unrecognized backslash marker never silently becomes a
// join target: `\ts\*`, `\b`, `\c`, the whole paragraph family, `\s1`-`\s3`,
// `\d`, `\qs`, and another `\q*` are all excluded by omission, not by name.
function isJoinableContentLine(line: string): boolean {
  const s = line.trim();
  if (s === "") return false;
  if (/^\\v\s+\d/.test(s)) return true;
  if (/^\\zaln-s\b/.test(s)) return true;
  if (/^\\w[ *]/.test(s)) return true;
  if (/^\\f\b/.test(s)) return true;
  if (/^\\fig\b/.test(s)) return true;
  if (!s.startsWith("\\")) return true; // bare text/punctuation continuation
  return false;
}

// Join a lone poetry-marker line (`\q1` by itself) forward onto the next
// joinable content line, producing the maintainer's hand-fixed shape
// `\q1 \v N …` (or `\q2 \zaln-s …` — see below) instead of two separate
// lines. A run of blank and/or `\ts\*` lines between the marker and its
// target is skipped OVER — but ONLY when that run contains at least one
// `\ts\*` line (blanks dropped, `\ts\*` line(s) re-emitted first, in order).
// A run made of blanks ALONE (no `\ts\*` in it) does NOT get crossed — see
// "Skipping a `\ts\*` run" below for why the two cases are treated
// differently despite looking similar. Any other line in between aborts the
// join outright.
//
// Corpus evidence (the exported ULT/UST books only, i.e. the ones this
// normalizer actually runs on): 302 occurrences of this exact lone-`\q*`-
// then-`\v` shape on ULT master vs. just 1 in the 39 non-exported books;
// 308 vs. 10 for UST. The DCS maintainer hand-fixes every one of them to the
// joined form shown above (see the CLAUDE.md task that introduced this pass),
// so emitting it pre-joined removes 620 nightly-recreated diffs.
//
// Skipping a `\ts\*` run: Rich Mahn requested this shape on 2026-08-11 —
// measured 9 occurrences of a lone `\q*` stranded above a `\ts\*` (with the
// following `\v` never joined) in current master (en_ust/28-HOS.usfm x4,
// en_ult/33-MIC.usfm x5) vs. 0 in his hand-cleaned files. A blank line may
// still appear WITHIN such a run (blankLinePass can have placed one there on
// an earlier pass — this pass itself never sees one at first-pass join time,
// since the three lines are physically adjacent before blankLinePass runs;
// see the pipeline order in normalizeUsfmFormatting), so blanks are tolerated
// inside a `\ts\*`-containing run without being what triggers the skip.
//
// NOT skipping a pure-blank run (corrected 2026-08-11): an earlier version of
// this comment argued that all 33 lone-`\q*` lines in Rich's 8 hand-cleaned
// files get immediately joined, so a lone `\q*` "never survives" and a blank
// run should be crossed too. That was wrong — those 33 lines ARE the
// surviving, un-joined shape (a lone `\q*` line and a joined `\q<n> \v N`
// line are mutually exclusive; Rich's files also contain hundreds of the
// joined form). So his files DO contain lone `\q*` markers he deliberately
// left unjoined, and separately, 0 of those 33 are followed by a blank line
// before their `\v` — meaning there is no corpus evidence either way for the
// blank-only case. Rich asked specifically for the `\ts\*` shape and said
// nothing about blanks, so this pass changes only that: a bare blank-then-`\v`
// with no `\ts\*` in between is left exactly as before, unjoined.
//
// Widening the target to non-`\v` content (FIX C): 0 occurrences in Rich's
// files vs. 32 in current master (en_ult/38-ZEC.usfm — 24x `\q2`, 8x `\q1`),
// all a lone `\q*` immediately above a `\zaln-s`/`\w` continuation of the
// SAME verse rather than a following `\v`. isJoinableContentLine's whitelist
// covers this target shape directly.
//
// A lone `\q*` that cannot be joined is always preserved. Its absence from a
// later corpus revision is not enough evidence that the editor intended to
// delete it; export formatting must not discard authored structure.
//
// This is NOT the same shape as collapseDuplicateLeadingMarker's target
// (`\q1 \q1 text` on one line, a doubled marker with no `\v` involved) —
// that pass is untouched, and this one only ever sees the marker alone on
// its own physical line.
//
// No empty-poetry-line hazard: USFM already has a dedicated marker for a
// stanza break (`\b` — "Blank line. Use for stanza breaks in poetry"), so a
// lone `\q*` line directly above a `\v` carries no meaning of its own that
// joining it destroys.
//
// MUST run before joinDanglingVerses (see that function's ordering note and
// the header guard below, which mirrors it exactly): joinDanglingVerses's
// forward walk treats a bare attachable marker as crossable. Joining first
// keeps the original marker attached to its verse; joinDanglingVerses then
// preserves both lines if the following content has a different marker.
//
// Header guard: mirrors joinDanglingVerses/blankLinePass/collapseBlankRuns —
// everything up to and including the first blank line (the header/ID block)
// is passed through untouched.
function joinPoetryMarkerToVerse(lines: string[]): string[] {
  const out: string[] = [];
  let inHeader = true;
  for (let i = 0; i < lines.length; i++) {
    if (inHeader) {
      out.push(lines[i]);
      if (lines[i].trim() === "") inHeader = false;
      continue;
    }
    const isLoneMarker = LONE_POETRY_MARKER_RE.test(lines[i].trim());
    if (isLoneMarker) {
      const skippedTsLines: string[] = [];
      let sawTs = false;
      let j = i + 1;
      while (j < lines.length) {
        const s = lines[j].trim();
        if (s === "") {
          j++;
          continue;
        }
        if (s === "\\ts\\*") {
          skippedTsLines.push(lines[j]);
          sawTs = true;
          j++;
          continue;
        }
        break;
      }
      // A run crossed via blanks alone (no \ts\* in it) does NOT license the
      // join — only immediate adjacency (j === i + 1) or a run containing at
      // least one \ts\* does. See the doc comment above for why.
      const blockedByBlankOnlyRun = j > i + 1 && !sawTs;
      if (!blockedByBlankOnlyRun && j < lines.length && isJoinableContentLine(lines[j])) {
        out.push(...skippedTsLines);
        out.push(`${lines[i].trim()} ${lines[j].trim()}`);
        i = j; // consume through the target line
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
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

// Canonical order for adjacent standalone markers: `\b` < `\ts\*` < `\c` <
// `\s`-family heading < `\p`. (From uW USFM: `\b` precedes `\ts\*` per
// fix_usfm_formatting.py, a section opens `\ts\* \c \p` per real ULT files,
// and the USFM manual places a section heading between the chapter marker and
// the paragraph that introduces its first verse — issue #384: usfm-js can
// emit `\c` / `\p` / `\s1 Heading` order, which is legal USFM but reads to a
// naive front-matter scan as a heading with no paragraph marker behind it.)
// -1 = not a standalone marker.
function markerPriority(line: string): number {
  const s = line.trim();
  if (s === "\\b") return 0;
  if (s === "\\ts\\*") return 1;
  if (CHAPTER_RE.test(s)) return 2;
  if (SECTION_HEADING_RE.test(s)) return 3;
  if (s === "\\p") return 4;
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

// A bare paragraph-family marker line (`\m`, `\pi1`, `\mi`, `\nb`, `\cls`, …
// — same family as `\p`). These are extracted onto their own line by
// STANDALONE_MARKER_RE (FIX A) and, unlike the poetry markers in
// POETRY_MARKER_ALTERNATION, must never be attached to a `\v` line (so they
// are deliberately absent from ATTACHABLE_PREFIX_RE). But a bare one must
// still be CROSSABLE in joinDanglingVerses's forward walk — see
// isCrossableMarkerLine below — exactly like `\p`: the walk steps over it,
// keeps it on its own line, and keeps looking for the actual verse content.
// Treating it as an abort instead (an earlier version of this pass did) left
// a `\v` stranded alone on its own line whenever a bare `\m`/`\pi1`/etc. sat
// between it and its text — regression against main, caught in pre-merge
// review 2026-08-11.
const PARAGRAPH_FAMILY_BARE_RE = new RegExp(String.raw`^\\(${PARAGRAPH_FAMILY_ALTERNATION})$`);

// A line that joinDanglingVerses's forward walk may cross AND KEEP in place:
// a bare `\p`, a bare paragraph-family marker (`\m`, `\pi1`, etc — see
// PARAGRAPH_FAMILY_BARE_RE above), or a bare attachable poetry marker (`\q1`,
// etc) with nothing following it on the line. Deliberately narrow —
// `\b`/`\ts\*`/`\c` used to be crossable here too, which is exactly what let
// the walk merge a verse into the wrong chapter (see isAbortLine and the doc
// comment on joinDanglingVerses below).
function isCrossableMarkerLine(line: string): boolean {
  const s = line.trim();
  if (s === "\\p") return true;
  if (PARAGRAPH_FAMILY_BARE_RE.test(s)) return true;
  return ATTACHABLE_PREFIX_RE.test(s);
}

// Markers/lines that ABORT a dangling-`\v` join outright: the forward walk
// stops immediately and the original dangling `\v` line is emitted completely
// untouched (nothing is consumed). `\c`/`\ts\*`/`\b` are always alone on their
// own line by the time this runs (extractStandaloneMarkers guarantees it), so
// an exact-equality check suffices for those; the `\s`-family headings/`\d`
// are NOT extracted onto their own line by anything upstream, so they're
// matched by leading marker instead, whatever text follows them. Another `\v`
// line (dangling or not) always aborts too — a join must never swallow a
// second verse. Bare paragraph-family markers (`\m`, `\pi1`, etc) are NOT an
// abort — they're crossable instead, per isCrossableMarkerLine above.
// `\qa`/`\qc`/`\qr`/`\qd` are in POETRY_MARKER_ALTERNATION, so without an
// explicit abort they are worse than merely crossable: stripLeadingAttachableMarker
// peels them off and the join hoists the verse number INTO the heading —
// `\v 1` + `\qa Aleph` becomes `\qa \v 1 Aleph`, making "Aleph" the first word of
// verse 1. Same silent-corruption class as the `\s1`/`\d` case (no validator
// complains). Not reachable in today's data — a sweep of all 144 corpus books
// through the real render path found zero such adjacencies — but the acrostic
// letters (`\qa`) and speaker/major-section headings do exist in the corpus, so
// this is guarded rather than left to chance.
const ABORT_LEADING_RE =
  // `\ms\*` needs no branch of its own: `\\ms[1-3]?` already matches the `\ms`
  // with the digit absent, and the lookahead is satisfied by the following `\`.
  /^(?:\\sr|\\s[1-5]?|\\r|\\ms[1-3]?|\\mr|\\d|\\qa|\\qc|\\qr|\\qd|\\sp|\\cl)(?![A-Za-z0-9])/;

function isAbortLine(line: string): boolean {
  const s = line.trim();
  if (s === "") return false; // blank lines are handled by the caller, not here
  // Another `\v` ANYWHERE in the line — never cross or swallow it. This must be
  // the unanchored test: a verse line normally carries its paragraph marker
  // first (`\q1 \v 2 …`), so an anchored `^\\v` check misses it and the join
  // merrily produces `\q1 \v 1 \v 2 …` — two verses on one line, which
  // validateUsfm rejects and which withholds the whole book from export.
  if (VERSE_RE.test(s)) return true;
  if (CHAPTER_RE.test(s)) return true;
  if (s === "\\ts\\*") return true;
  if (s === "\\b") return true;
  // headings and titles: \s / \s1-\s5 / \sr / \r / \ms / \ms1-3 / \ms\* / \mr /
  // \d / \qa / \qc / \qr / \qd / \sp / \cl
  return ABORT_LEADING_RE.test(s);
}

// usfm-js sometimes emits a `\v N` with no verse text on its own line, the
// text instead landing on the next physical line (occasionally after one or
// more structural marker lines and/or blank lines). DCS requires the verse
// number to lead its actual content. Verified against all 680 of Rich Mahn's
// 2026-08-07 hand-fixes (659 in NUM alone) — this single rule explains 679 of
// them; the 680th (27-DAN.usfm 1:1) is a one-off editorial deletion of a stray
// `\q2` and is deliberately NOT special-cased here.
//
// The walk is deliberately conservative and bounded: across all 680 of those
// real cases, it only ever needed to cross blank lines (50 cases) and exactly
// one bare `\p` — it never needed to cross a `\c`, `\ts\*`, `\b`, a heading, or
// another `\v`. So those five now ABORT the join rather than being crossed: an
// earlier version treated `\c N`/`\ts\*`/`\b` as markers safe to hop over (via
// isMarkerOnlyLine's use of markerPriority), which let the walk sail across a
// chapter boundary and merge a verse into the WRONG chapter (e.g.
// `\v 10 / \c 2 / \p / \v 1 next` merging 1:10 into chapter 2), and treated
// `\s`-family headings/`\d` as ordinary text, silently absorbing a section
// heading into the previous verse with zero validator complaint.
//
// For each dangling `\v` line, walk forward: blank lines are held as pending
// (deleted unless a kept marker line follows); a crossable marker-only line
// (bare `\p` or bare attachable poetry marker) is kept, along with any blanks
// pending before it, and the walk continues; an abort line stops the walk
// immediately with the dangling `\v` line emitted untouched and nothing
// consumed; otherwise the first line with real text is the merge target and
// ends the walk. Running off the end also leaves the `\v` line untouched. The
// marker already on the `\v` line always wins over one stripped from the
// target; if only the target has a leading marker, that marker moves above
// the verse number.
//
// Header guard: mirrors blankLinePass/collapseBlankRuns exactly — everything
// up to and including the first blank line is passed through untouched, with
// no dangling-`\v` check ever attempted inside that region. This keeps a `\v`
// in the header from being hoisted, and — just as importantly — keeps a join
// from ever consuming the header-terminating blank line itself, which would
// otherwise leave blankLinePass thinking the whole rest of the file is still
// header and stop inserting required blank lines before every `\c`/`\p`.
function joinDanglingVerses(lines: string[]): string[] {
  const out: string[] = [];
  const consumed = new Set<number>();
  let inHeader = true;
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;

    if (inHeader) {
      out.push(lines[i]);
      if (lines[i].trim() === "") inHeader = false;
      continue;
    }

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
    let aborted = false;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j].trim() === "") {
        pending.push(j);
        j++;
        continue;
      }
      if (isAbortLine(lines[j])) {
        aborted = true;
        break;
      }
      if (isCrossableMarkerLine(lines[j])) {
        keep.push(...pending, j);
        pending = [];
        j++;
        continue;
      }
      targetIdx = j;
      break;
    }

    if (aborted || targetIdx === -1) {
      out.push(lines[i]); // abort, or ran off the end — leave untouched, consume nothing
      continue;
    }

    const { marker: targetMarker, rest: targetRest } = stripLeadingAttachableMarker(
      lines[targetIdx],
    );
    // Different poetry levels are distinct editor-authored structure, not
    // duplicates. There is no lossless way to merge this shape, so preserve
    // both source lines instead of silently choosing one marker and deleting
    // the other.
    if (dvMarker && targetMarker && dvMarker !== targetMarker) {
      out.push(lines[i]);
      continue;
    }

    // Identical markers are redundant around the same dangling verse and can
    // still be safely collapsed while joining the verse to its content.
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
      // The header-terminating blank IS a blank line: seed prevBlank from it, or
      // a body that opens with more blanks keeps one too many (a 3-blank run
      // after the header collapsed to 2, not 1).
      if (line.trim() === "") {
        inHeader = false;
        prevBlank = true;
      }
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
  lines = joinPoetryMarkerToVerse(lines);
  lines = joinDanglingVerses(lines);
  lines = collapseConsecutiveParagraphMarkers(lines);
  lines = collapseConsecutiveTsMarkers(lines);
  lines = blankLinePass(lines);
  lines = collapseBlankRuns(lines);

  let out = lines.join("\n");
  out = out.replace(/\n*$/, "\n");
  return out;
}

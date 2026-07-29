// Flag/escalate lint for the bible-editor side — the DCS checks that the export
// normalizers CANNOT auto-fix because they need a human decision. Run pre-export
// (escalate integrity issues to system_alerts) and on demand via
// GET /api/books/:book/lint (the in-app per-book "issues to clean up" flag).
//
// The Worker can't run DCS's Python validators, so this is a focused TS port of
// the judgement-call subset of validate_tn_files.py / validate_usfm_files.py:
//   TN: unmatched/mismatched square brackets (13), an Alternate-translation label
//       with no sentence terminator before it (12), a malformed Reference (6), a
//       malformed rc:// SupportReference (7).
//   USFM: unbalanced \f / \f* footnotes (6), missing verses (5).
// The MECHANICAL checks (formatting, trailing \n, straight quotes, label spacing,
// reference order, ids, occurrence) are auto-fixed at export and are NOT linted
// here. See docs/export-validation-cleanup.md.

import type { RowKind, TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { parseRefOrderKey } from "./tsvFormat.ts";

export type IssueBucket = "flag" | "escalate";

export interface LintIssue {
  check: string; // DCS check name
  bucket: IssueBucket; // flag = human decision in-app; escalate = admin banner
  ref: string; // chapter:verse (or chapter) for navigation
  rowId?: string; // row id (for jump-to-row)
  message: string;
}

// The `check` values of the blank-required-field lint below. A row whose
// REQUIRED field is blank is REJECTED by DCS's whole-repo validator, so the
// export HOLD gate (exportWorkflow.ts) reuses this set to refuse shipping such a
// row — single source of truth so the in-app flag and the export gate agree.
export const BLANK_REQUIRED_CHECKS: ReadonlySet<string> = new Set([
  "Empty note",
  "Empty question",
  "Empty response",
  "Empty OrigWords",
  "Empty TWLink",
]);

// A required field is "blank" when it is missing or only whitespace. Computed
// dynamically from the live row (NOT persisted as review_kind) so the flag is
// always current and self-clears the instant the field is filled in or the row
// is deleted. This replaces hand-stamping review_kind='blank-note' via SQL.
function isBlankRequired(s: string | null | undefined): boolean {
  return !s || s.trim() === "";
}

const REFERENCE_RE = /^(?:front:intro|\d+:intro|\d+:front|\d+:\d+(?:[,-][\d,:-]*\d+)*)$/;
const SUPPORT_REFERENCE_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;
const ALT_LABEL_RE = /Alternat(?:e|ive)( *)([Tt])ranslation/g;

// Port of validate_tn_files.py validate_paired_square_brackets. Returns the
// human-readable problems with `[ ]` nesting in a note.
function bracketProblems(note: string): string[] {
  const out: string[] = [];
  const stack: Array<{ len: number; pos: number }> = [];
  let i = 0;
  while (i < note.length) {
    const ch = note[i];
    if (ch !== "[" && ch !== "]") {
      i++;
      continue;
    }
    let j = i;
    while (j < note.length && note[j] === ch) j++;
    const runLen = j - i;
    const token = ch.repeat(runLen);
    if (ch === "[") {
      stack.push({ len: runLen, pos: i });
    } else if (stack.length === 0) {
      out.push(`Closing bracket '${token}' at character ${i + 1} has no matching opening bracket.`);
    } else {
      const open = stack.pop()!;
      if (open.len !== runLen) {
        out.push(
          `Opening bracket '${"[".repeat(open.len)}' at character ${open.pos + 1} is closed by '${token}' at character ${i + 1}; bracket sizes must match.`,
        );
      }
    }
    i = j;
  }
  for (const open of stack) {
    out.push(`Opening bracket '${"[".repeat(open.len)}' at character ${open.pos + 1} has no matching closing bracket.`);
  }
  return out;
}

// Port of the JUDGEMENT-CALL subset of validate_alternate_translation_label:
// a label whose preceding text has no sentence terminator (the auto-fix can't
// know which punctuation belongs there). Spacing/spelling/case are auto-fixed at
// export, so they are not reported here.
function altLabelProblems(note: string): string[] {
  const out: string[] = [];
  for (const m of note.matchAll(ALT_LABEL_RE)) {
    const start = m.index ?? 0;
    if (start === 0) continue;
    const precedingTwo = note.slice(Math.max(0, start - 2), start);
    if (precedingTwo === "  ") continue; // double-space → auto-fixed at export
    if (!/^[^a-z] $/.test(precedingTwo)) {
      out.push("An 'Alternate translation' label has no sentence punctuation before it.");
    }
  }
  return out;
}

export function lintTnRows(rows: TnRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = r.ref_raw;
    if (r.ref_raw && !REFERENCE_RE.test(r.ref_raw)) {
      issues.push({ check: "6. Reference", bucket: "flag", ref, rowId: r.id, message: `Reference '${r.ref_raw}' is not a valid format.` });
    }
    if (r.support_reference && !SUPPORT_REFERENCE_RE.test(r.support_reference)) {
      issues.push({ check: "7. SupportReference", bucket: "flag", ref, rowId: r.id, message: `SupportReference '${r.support_reference}' is not a valid rc:// link.` });
    }
    // A tn row with no note fails the DCS validator on export. Section-header
    // rows carry their `# Heading` text IN the note, so a truly empty note is
    // genuinely invalid — there is no legitimately note-less tn row. Use
    // chapter:verse for the ref (jump-to-note loads the chapter parsed from it).
    if (isBlankRequired(r.note)) {
      issues.push({
        check: "Empty note",
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: "Empty note — this row will fail DCS validation. Add a note or delete the row.",
      });
    }
    const note = r.note ?? "";
    for (const msg of bracketProblems(note)) {
      issues.push({ check: "13. Paired Square Bracket", bucket: "flag", ref, rowId: r.id, message: msg });
    }
    for (const msg of altLabelProblems(note)) {
      issues.push({ check: "12. Alternate translation Label", bucket: "flag", ref, rowId: r.id, message: msg });
    }
    // Workflow-only review flag for adapted/migrated notes (review_kind set).
    // Not a DCS check — surfaces the human-verify queue in the same chip.
    // Use chapter:verse for the ref (ref_raw can be a stale/adapted range, and
    // jump-to-note loads the chapter parsed from this ref).
    if (r.review_kind) {
      issues.push({
        check: "Adapted note — verify",
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: r.review_reason ?? "Adapted from a parallel passage — verify the Hebrew quote and wording.",
      });
    }
  }
  return issues;
}

// tq rows: both question and response are REQUIRED; a blank one is rejected by
// DCS on export. (tq has no other flag/escalate DCS check the export can't
// auto-fix, so this is the whole tq lint today.)
export function lintTqRows(rows: TqRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = `${r.chapter}:${r.verse}`;
    if (isBlankRequired(r.question)) {
      issues.push({ check: "Empty question", bucket: "flag", ref, rowId: r.id, message: "Empty question — this row will fail DCS validation. Add a question or delete the row." });
    }
    if (isBlankRequired(r.response)) {
      issues.push({ check: "Empty response", bucket: "flag", ref, rowId: r.id, message: "Empty response — this row will fail DCS validation. Add a response or delete the row." });
    }
  }
  return issues;
}

// twl rows: both OrigWords (orig_words) and TWLink (tw_link) are REQUIRED; a
// blank one is rejected by DCS on export.
export function lintTwlRows(rows: TwlRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = `${r.chapter}:${r.verse}`;
    if (isBlankRequired(r.orig_words)) {
      issues.push({ check: "Empty OrigWords", bucket: "flag", ref, rowId: r.id, message: "Empty OrigWords — this row will fail DCS validation. Add the original-language word(s) or delete the row." });
    }
    if (isBlankRequired(r.tw_link)) {
      issues.push({ check: "Empty TWLink", bucket: "flag", ref, rowId: r.id, message: "Empty TWLink — this row will fail DCS validation. Add a translationWords link or delete the row." });
    }
  }
  return issues;
}

// Refs of rows with a blank REQUIRED field, for the export HOLD gate. Reuses the
// in-app lint above (single source of truth) and keeps only the blank-field
// checks. Deduped, in row order. `kind` selects the resource's lint.
export function blankRequiredRefs(kind: RowKind, rows: TnRow[] | TqRow[] | TwlRow[]): string[] {
  const issues =
    kind === "tn" ? lintTnRows(rows as TnRow[])
    : kind === "tq" ? lintTqRows(rows as TqRow[])
    : lintTwlRows(rows as TwlRow[]);
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const i of issues) {
    if (!BLANK_REQUIRED_CHECKS.has(i.check)) continue;
    if (seen.has(i.ref)) continue;
    seen.add(i.ref);
    refs.push(i.ref);
  }
  return refs;
}

// Count UNCLOSED footnotes in a verse's parsed nodes. usfm-js represents a
// whole footnote as ONE node `{ tag: "f", ... }`: a balanced `\f … \f*` carries
// a non-empty `endTag` ("f*"), an unclosed footnote has `endTag` "" / missing
// (its inner markers live in `content`, NOT as `\f*` text — so counting `\f*` in
// text would never see the close and would flag every normal footnote). Only a
// footnote node without an endTag is an integrity problem.
function footnoteDelta(nodes: unknown[]): number {
  let delta = 0;
  const walk = (list: unknown[]): void => {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["tag"] === "f") {
        const endTag = typeof o["endTag"] === "string" ? (o["endTag"] as string) : "";
        if (!endTag) delta += 1; // open footnote with no matching \f*
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(nodes);
  return delta;
}

// True when any `\zaln-s` in the verse carries an x-content that spans a
// CROSS-WORD joiner — maqqef (U+05BE), minus (U+2212), or a hyphen/dash. That
// glues two original-language words into one source token (carrying only the
// first word's, often wrong, strong), which strands the joined word in the
// aligner — the AI-aligner defect seen in Amos UST. The web aligner re-anchors
// it off the UHB on open, but the stored data can't self-heal until it is
// touched/back-filled, so we flag it for a human. Excludes the zero-width
// joiners (U+2060/U+200D) that legitimately sit INSIDE one UHB word.
function contentHasGlueJoiner(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? -1;
    if (cp === 0x05be || cp === 0x002d || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) return true;
  }
  return false;
}
function hasGluedMilestone(nodes: unknown[]): boolean {
  const walk = (list: unknown[]): boolean => {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (
        o["type"] === "milestone" && o["tag"] === "zaln" &&
        typeof o["content"] === "string" && contentHasGlueJoiner(o["content"] as string)
      ) {
        return true;
      }
      const children = o["children"];
      if (Array.isArray(children) && walk(children)) return true;
    }
    return false;
  };
  return walk(nodes);
}

// Paragraph / poetry tags that legitimately open a chapter. Mirror of
// PARAGRAPH_TAGS in web/src/lib/usfm.ts — keep in sync.
//
// `\ts\*` is DELIBERATELY absent: a chunk divider is a translator-section
// milestone, not a line-layout marker, so a chapter whose only leading node is
// `\ts\*` still has no paragraph and must still flag. Character wrappers
// (`\qs Selah\qs*`) are also `type:"quote"` but carry verse CONTENT rather than
// a break — they're excluded by the tag-set test, since `qs` isn't in the set.
// `b` is DELIBERATELY absent, unlike PARAGRAPH_TAGS: `\b` is a blank line, not a
// paragraph opener, so a chapter whose front matter ends in `\b` still needs a
// real `\p`/`\q` and must keep flagging.
const CHAPTER_OPENING_TAGS: ReadonlySet<string> = new Set([
  "p", "m", "mi", "nb", "pi", "pi1", "pi2", "pi3", "pc",
  "q", "q1", "q2", "q3", "q4", "qm", "qm1", "qm2", "qm3",
]);

function isChapterOpeningMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if (t !== "paragraph" && t !== "quote") return false;
  const tag = o["tag"];
  return typeof tag === "string" && CHAPTER_OPENING_TAGS.has(tag);
}

// Nodes that carry no verse content and so must not stop the edge scans below.
// This mirrors trailingMarkerRunStart in web/src/lib/usfm.ts — keep the two in
// sync, because the app uses that function to decide which markers introduce the
// next verse, and a lint that disagreed would flag chapters the editor already
// shows as correctly marked (or stay silent on ones it shows as bare).
//
// Transparent: whitespace-only text (including U+200B, which the editor's empty
// -block placeholder leaves behind) and `\ts\*` chunk milestones. The `\ts\*`
// case is the Micah 4 lesson: prod stores tails as `\q1` then `\ts\*`, so a scan
// that stopped at the divider would never see the `\q1` behind it and would
// report a marked chapter as bare. Section headings (`\s1`) are deliberately NOT
// transparent — the app stops at them too, so a `\p` sitting BEFORE a heading
// does not introduce the verse that follows the heading.
function isTransparentToEdgeScan(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["text"];
  if (typeof t === "string" && /^[\s​]*$/.test(t)) return true;
  return isTsMilestone(o);
}

// Mirrors isTsMilestone in web/src/lib/usfm.ts and api/src/importParsers.ts.
// Matches every shape usfm-js has produced for `\ts\*`; matching only the legacy
// `{tag:"ts", content:"\\*"}` form was a silent no-op on real 3.5.0 data.
function isTsMilestone(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const tag = o["tag"];
  if (tag === "ts\\*" || tag === "ts*") return true;
  return tag === "ts" && (o["content"] === "\\*" || o["content"] === "*");
}

// POSITION MATTERS, and getting it wrong makes this lint useless. An opening
// marker only counts if it sits at the boundary between the chapter start and
// verse 1: trailing on the front matter, or leading verse 1 itself. Scanning the
// whole array instead (an `Array.some`) silently passes every poetry chapter,
// because verse 1 of a poetic verse carries its own mid-verse `\q1`/`\q2` line
// breaks — MIC 2:1 UST is exactly that, and it hid a real missing-marker defect.
function endsWithOpeningMarker(nodes: unknown[]): boolean {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (isChapterOpeningMarker(nodes[i])) return true;
    if (isTransparentToEdgeScan(nodes[i])) continue;
    return false;
  }
  return false;
}

function startsWithOpeningMarker(nodes: unknown[]): boolean {
  for (const node of nodes) {
    if (isChapterOpeningMarker(node)) return true;
    if (isTransparentToEdgeScan(node)) continue;
    return false;
  }
  return false;
}

// Flag chapters whose verse 1 is not introduced by a paragraph / poetry marker
// (issue #378). USFM puts that marker BEFORE `\v 1`, so usfm-js parks it on the
// chapter-front pseudo-verse that we store as verse 0 — meaning the marker is
// normally the TRAILING content of verse 0, not the leading content of verse 1.
// Two distinct defects produce an unmarked chapter, and both are reported here:
//
//   1. no verse-0 row exists at all (the observed case: MIC 5 ULT, MIC 2 UST) —
//      nothing can hold the marker, and the editor cannot even create it without
//      the verse-0 upsert path in verses.ts;
//   2. a verse-0 row exists but holds no opening marker (e.g. only a `\d` Psalm
//      superscription, or only a `\ts\*` chunk divider).
//
// Checking verse 1's own LEADING nodes as well keeps this from false-positiving
// if usfm-js ever parks the marker inside verse 1 instead of on the front matter.
// Both checks are position-sensitive — see endsWithOpeningMarker for why.
// Bucket is `flag`, not `escalate`: this needs a human to choose WHICH marker
// belongs (`\p` prose vs `\q1` poetry), and it does not corrupt the export.
export function lintChapterOpeningMarkers(verses: VerseRow[]): LintIssue[] {
  const byChapter = new Map<number, { front?: VerseRow; first?: VerseRow }>();
  for (const v of verses) {
    if (v.verse !== 0 && v.verse !== 1) continue;
    const slot = byChapter.get(v.chapter) ?? {};
    if (v.verse === 0) slot.front = v;
    else slot.first = v;
    byChapter.set(v.chapter, slot);
  }
  const issues: LintIssue[] = [];
  for (const chapter of [...byChapter.keys()].sort((a, b) => a - b)) {
    const { front, first } = byChapter.get(chapter)!;
    // A chapter with no verse 1 isn't scripture we can judge (front matter,
    // partial load) — say nothing rather than guess.
    if (!first) continue;
    const nodesOf = (row: VerseRow | undefined): unknown[] => {
      if (!row) return [];
      let parsed: unknown;
      try {
        parsed = parseVerseContentJson(row);
      } catch {
        return [];
      }
      const vos = (parsed as { verseObjects?: unknown[] })?.verseObjects;
      return Array.isArray(vos) ? vos : [];
    };
    if (endsWithOpeningMarker(nodesOf(front))) continue;
    if (startsWithOpeningMarker(nodesOf(first))) continue;
    issues.push({
      check: "Chapter opening marker",
      bucket: "flag",
      // Point at the intro row — that's where the fix goes, and it's a valid
      // navigation target even when the row doesn't exist yet.
      ref: `${chapter}:0`,
      message: front
        ? `chapter ${chapter} starts without a paragraph / poetry marker (\\p, \\q1, …) — add one to the chapter intro.`
        : `chapter ${chapter} has no chapter-intro row, so it starts without a paragraph / poetry marker (\\p, \\q1, …) — add one to the chapter intro.`,
    });
  }
  return issues;
}

// USFM (ult/ust) integrity lint over the stored verse rows: unbalanced footnotes
// and joiner-glued alignment milestones, per verse. (Verse-coverage / chapter-
// count are guarded by the export shrink guard and validated whole-file
// downstream; not duplicated here.)
export function lintUsfmVerses(verses: VerseRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const v of verses) {
    if (v.verse === 0) continue;
    let parsed: unknown;
    try {
      parsed = parseVerseContentJson(v);
    } catch {
      continue;
    }
    const vos = (parsed as { verseObjects?: unknown[] })?.verseObjects;
    if (!Array.isArray(vos)) continue;
    const ref = `${v.chapter}:${v.verse}`;
    const delta = footnoteDelta(vos);
    if (delta !== 0) {
      issues.push({
        check: "6. Footnote Syntax",
        bucket: "escalate",
        ref,
        message: delta > 0 ? `${delta} unclosed footnote(s) (\\f without \\f*).` : `${-delta} extra footnote close(s) (\\f* without \\f).`,
      });
    }
    if (hasGluedMilestone(vos)) {
      issues.push({
        check: "Glued alignment",
        bucket: "escalate",
        ref,
        message: "alignment milestone x-content spans a maqqef/minus (two source words glued into one).",
      });
    }
  }
  return issues;
}

// True when a reference parses (used to keep lint robust to odd inputs).
export function refSortable(ref: string): boolean {
  return parseRefOrderKey(ref) !== null;
}

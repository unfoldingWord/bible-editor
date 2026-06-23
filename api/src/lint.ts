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

import type { TnRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { parseRefOrderKey } from "./tsvFormat.ts";

export type IssueBucket = "flag" | "escalate";

export interface LintIssue {
  check: string; // DCS check name
  bucket: IssueBucket; // flag = human decision in-app; escalate = admin banner
  ref: string; // chapter:verse (or chapter) for navigation
  rowId?: string; // TN row id (for jump-to-note)
  message: string;
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

// USFM (ult/ust) integrity lint over the stored verse rows: unbalanced footnotes
// per verse. (Verse-coverage / chapter-count are guarded by the export shrink
// guard and validated whole-file downstream; not duplicated here.)
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
    const delta = footnoteDelta(vos);
    if (delta !== 0) {
      const ref = `${v.chapter}:${v.verse}`;
      issues.push({
        check: "6. Footnote Syntax",
        bucket: "escalate",
        ref,
        message: delta > 0 ? `${delta} unclosed footnote(s) (\\f without \\f*).` : `${-delta} extra footnote close(s) (\\f* without \\f).`,
      });
    }
  }
  return issues;
}

// True when a reference parses (used to keep lint robust to odd inputs).
export function refSortable(ref: string): boolean {
  return parseRefOrderKey(ref) !== null;
}

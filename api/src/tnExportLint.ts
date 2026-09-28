// Non-blocking TN export lint (issue #1015): the subset of DCS's
// validate_tn_files.py checks that are confirmed HARD errors, run against the
// rendered tn TSV so an export Door43 will reject names the row to fix.
//
// Only check 13 (Paired Square Bracket) is here. It is measured: JER 17:4 row
// `ny7v` (an unclosed `[` in its Note) failed Door43's `validate-be` job with
// exactly one error — "[13. Paired Square Bracket Check] ... Opening bracket
// '[' at character 313 does not have a matching closing bracket." — and
// `merge-be-pr` merges only on a green run, so JER TN stayed off master with no
// alert. Checks 6/7/12 are also ported in lint.ts, but their severity in the
// live validator has not been confirmed from this repo, so they are NOT
// alerted on here; add them only once they are confirmed hard errors.
//
// Deliberately NOT a HOLD gate: Door43 already blocks the merge, so holding
// here would withhold nothing extra. The point is an actionable alert.
//
// Judges the RENDERED bytes (same doctrine as hardRejectGuard.ts): the Note
// cell as committed is what Door43 validates.
//
// Pure apart from the injected alert ops, so it is directly testable by the
// --experimental-strip-types runner.

import { bracketProblems } from "./lint.ts";

export interface TnExportFinding {
  ref: string; // Reference cell
  rowId: string; // ID cell
  check: string; // DCS check name
  message: string; // the lint message (DCS's wording, ported)
}

// Rows in a rendered tn TSV that fail check 13. Never throws; an unrecognized
// header returns [] rather than guess at column indexes.
export function tnExportHardErrors(tsv: string): TnExportFinding[] {
  if (!tsv) return [];
  const lines = tsv.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  const refIdx = header.indexOf("Reference");
  const idIdx = header.indexOf("ID");
  const noteIdx = header.indexOf("Note");
  if (refIdx === -1 || idIdx === -1 || noteIdx === -1) return [];
  const out: TnExportFinding[] = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const cells = line.split("\t");
    const note = cells[noteIdx] ?? "";
    for (const message of bracketProblems(note)) {
      out.push({
        ref: cells[refIdx] ?? "",
        rowId: cells[idIdx] ?? "",
        check: "13. Paired Square Bracket",
        message,
      });
    }
  }
  return out;
}

export function tnExportInvalidAlertSource(book: string): string {
  return `export_tn_invalid:${book}:tn`;
}

// States only the measured cause: the rows, the check, and the validator's
// own message. Says plainly this export was NOT held and that Door43 will
// reject it until the rows are fixed.
export function buildTnExportInvalidAlertMessage(book: string, findings: TnExportFinding[]): string {
  const shown = findings
    .slice(0, 6)
    .map((f) => `${book} ${f.ref} (row ${f.rowId}): ${f.message}`)
    .join("; ");
  const more = findings.length > 6 ? `; +${findings.length - 6} more` : "";
  return (
    `Benjamin — ${book} TN: ${findings.length} note problem(s) that Door43's TN validator counts as a hard ` +
    `error (check 13, Paired Square Bracket). ${shown}${more}. The export is not held for this, but Door43 will ` +
    `reject it — the -be- PR's check goes red and the merge bot never merges it — so no ${book} TN edit reaches master ` +
    `until these notes are fixed in the editor.`
  );
}

export interface TnAlertOps {
  write(source: string, message: string): Promise<void>;
  clear(source: string): Promise<void>;
}

// Raise one alert per (book, tn) when the render has findings; otherwise
// clear any undismissed one left by an earlier export. Returns the findings.
export async function reconcileTnExportInvalidAlert(
  book: string,
  tsv: string,
  ops: TnAlertOps,
): Promise<TnExportFinding[]> {
  const findings = tnExportHardErrors(tsv);
  const source = tnExportInvalidAlertSource(book);
  if (findings.length === 0) await ops.clear(source);
  else await ops.write(source, buildTnExportInvalidAlertMessage(book, findings));
  return findings;
}

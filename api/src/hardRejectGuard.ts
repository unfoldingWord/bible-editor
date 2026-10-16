// Export HOLD gate for the rows DCS's validators genuinely HARD-reject.
//
// This replaces the `blank_field_guard` gate, which held a whole book+resource
// for a blank tn Note / tq Question-Response / twl OrigWords-TWLink. That gate
// was wrong: all five of those checks are raised at `severity="warning"` in the
// live validators, and their shared ErrorCollector says "Only hard errors decide
// the exit code. Warnings are advisory … must not stop a book from merging". So
// they publish, and holding a book for them stranded every other edit in it.
//
// Occurrence is the opposite case, and it is the one worth holding for. In the
// same validator files those checks carry NO `severity` kwarg, so they take the
// dataclass default `"error"`, count toward `failures`, and make the run exit 1 —
// which means the `-be-` PR's check goes red and `merge-be-pr.yaml` (which
// merges on `workflow_run.conclusion == 'success'`) never merges it. The book is
// then withheld from master anyway, but with no per-book banner naming the row.
// Better to refuse locally and say exactly which rows are at fault.
//
// The rules below are transcribed from those validators, per resource:
//
//   twl (`validate_twl_files.py`): `if not occurrence` → error, unconditionally;
//        else must match the occurrence pattern. A blank Occurrence is NEVER
//        allowed, even when OrigWords is also blank.
//   tn (`validate_tn_files.py`): `occurrence_is_allowed_blank = (occurrence == ""
//        and _quote == "")` — blank Occurrence is allowed ONLY when Quote is also
//        blank; otherwise it must match the pattern.
//   tq (`validate_tq_files.py`): `if occurrence != "" and not RE.fullmatch(...)`
//        — a blank Occurrence is fine here, so tq has no hard-reject rule and is
//        deliberately absent below.
//
// This operates on the RENDERED TSV, not on the D1 rows, and that is load-bearing.
// `renderOccurrence` (occurrenceRule.ts, called by export.ts) heals an invalid
// Occurrence at render time, so rows that look offending in D1 render perfectly
// valid Occurrence values. (The old text here claimed "~10.7k tn rows"; that
// number described the narrower OL-only coercion and was never re-measured for
// the wider rule, so it is not repeated.) Judging the rows
// instead of the bytes we are about to commit would hold nearly every tn book
// for nothing — exactly the over-broad-gate mistake this module exists to
// correct. Judge the bytes.
//
// Since renderOccurrence applies the same per-kind rule this guard tests,
// it should now find NOTHING: Occurrence is not editable in the UI, so holding a
// book for a defect no translator can fix was never actionable. The guard stays
// as a backstop — a hit here means the render and this module have drifted apart,
// which is worth a HOLD.
//
// tn Note brackets (validate_tn_files.py check 13, `validate_paired_square_brackets`)
// do NOT hold a book. They were a hard error when issue #1015 hit (JER 17:4 `ny7v`,
// an unclosed `[` that failed validate-be), and PR #1023 held for them here. But
// en_tn d6fc28c11c (#7778, 2026-09-28) set every check-13 `errors.add` to
// severity="warning", so Door43 merges those rows, and the hold then stranded every
// other JER TN edit over one unclosed `[` in 34:15 `mgn7` (issue #1149). A
// translator can fix a bracket, so it belongs in the in-app lint, which still
// flags it through `bracketProblems` below.
//
// Pure and import-free so it is directly testable by the --experimental-strip-types
// runner, same shape as shrinkGuard.ts / reimportSyncGate.ts.

// DCS's OCCURRENCE_RE, per resource. tn/tq accept -1 and 0; twl requires a
// positive integer ("never 0 or blank" per its own message).
const TN_OCCURRENCE_RE = /^(?:-1|[0-9]+)$/;
const TWL_OCCURRENCE_RE = /^[1-9][0-9]*$/;

export type HardRejectKind = "tn" | "twl";

export interface HardRejectRow {
  ref: string; // Reference cell, for the operator-facing banner
  rowId: string; // ID cell
  reason: string; // what the DCS validator would say
}

// Rows in a rendered TSV that DCS would reject as a hard error. Returns [] for
// any resource with no hard-reject rule (tq), an unrecognized header, or an empty
// render. Never throws — a malformed render is the USFM/TSV validators' problem,
// not this gate's, and a gate that throws would fail the export step it is
// supposed to be protecting.
export function hardRejectRows(kind: HardRejectKind, tsv: string): HardRejectRow[] {
  if (!tsv) return [];
  const lines = tsv.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  const refIdx = header.indexOf("Reference");
  const idIdx = header.indexOf("ID");
  const occIdx = header.indexOf("Occurrence");
  // A header we don't recognize means we cannot locate the column; stay silent
  // rather than guess at indexes and hold a book on a misread cell.
  if (refIdx === -1 || idIdx === -1 || occIdx === -1) return [];
  const quoteIdx = kind === "tn" ? header.indexOf("Quote") : header.indexOf("OrigWords");
  if (quoteIdx === -1) return [];

  const out: HardRejectRow[] = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue; // trailing newline
    const cells = line.split("\t");
    // Compare the cells RAW, exactly as the validators do. Trimming the Quote
    // was too lax: the validator's test is `_quote == ""` on the unmodified
    // cell, so a Quote of "   " is NOT blank to it and does NOT license a blank
    // Occurrence — yet a trimming guard saw "" and let the row through, which is
    // precisely the silent withhold this module exists to prevent. Verified by
    // running validate_tn_files.py on a "   " Quote with a blank Occurrence: it
    // errors. Same reasoning for Occurrence — " 1 " fails the digits-only regex.
    const occ = cells[occIdx] ?? "";
    const quote = cells[quoteIdx] ?? "";
    const ref = cells[refIdx] ?? "";
    const rowId = cells[idIdx] ?? "";
    if (kind === "twl") {
      if (occ === "") {
        out.push({ ref, rowId, reason: "Occurrence is blank (twl requires a positive integer)" });
      } else if (!TWL_OCCURRENCE_RE.test(occ)) {
        out.push({ ref, rowId, reason: `Occurrence '${occ}' must be a positive integer` });
      }
      continue;
    }
    // tn: blank Occurrence is legal only alongside a blank Quote.
    if (occ === "") {
      if (quote !== "") {
        out.push({ ref, rowId, reason: "Occurrence is blank but Quote is not" });
      }
    } else if (!TN_OCCURRENCE_RE.test(occ)) {
      out.push({ ref, rowId, reason: `Occurrence '${occ}' must be a non-negative integer or -1` });
    }
  }
  return out;
}

// Port of validate_tn_files.py validate_paired_square_brackets. Returns the
// human-readable problems with `[ ]` nesting in a note. Used by lint.ts, which
// shows them in the in-app issues list; the export no longer holds for them.
export function bracketProblems(note: string): string[] {
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

// Banner text for a held export. States only what was measured: WE refused, the
// DCS run has not happened, so it must not say DCS rejected anything.
export function buildHardRejectAlertMessage(
  book: string,
  resource: string,
  rejects: HardRejectRow[],
): string {
  const label = `${book} ${resource.toUpperCase()}`;
  const shown = rejects
    .slice(0, 6)
    .map((r) => `${r.ref} (${r.rowId}): ${r.reason}`)
    .join("; ");
  const more = rejects.length > 6 ? `; +${rejects.length - 6} more` : "";
  // hardRejectRows reports at most one problem per row today, but count rows by
  // ID rather than entries so the banner stays right if a rule is ever added.
  const rowCount = new Set(rejects.map((r) => r.rowId)).size;
  return (
    `Benjamin — nightly export HELD ${label}: ${rowCount} row(s) would fail DCS ` +
    `validation as a hard error, so the -be- PR's check would go red and the merge bot would never merge it. ` +
    `${shown}${more}. Fix those rows (or delete them) in the editor; the next export picks them up, and every other ` +
    `edit in ${label} is waiting on it. Blank notes/questions/OrigWords/TWLink and unpaired [ ] in a Note ` +
    `do NOT cause this — those are validator warnings and ship normally.`
  );
}

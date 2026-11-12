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
//   twl TWLink (`validate_twl_files.py` TWLINK_RE, also no `severity` kwarg):
//        `if not twlink` → warning, so "" ships; any other value must
//        `fullmatch` TWLINK_RE or it is a hard error. The rule itself lives in
//        twLinkShape.ts (`isMalformedTwLink`), shared with the save-path refusal
//        and the lint flag, so this gate cannot drift from them. Added for #1324:
//        #1316 made the editor refuse a malformed link on save and flag any
//        already stored, but a link stored before #1316 still exported and
//        would fail the -be- PR with no banner naming the row.
//   twl straight quotes (`validate_twl_files.py` `_flag_straight_quotes`, def
//        ~629-657, called ~493/507/519 for every data row; en_twl db7ef2aad5,
//        2026-07-24): `if "'" in raw_line or '"' in raw_line` → error (no
//        `severity` kwarg; check 14, on by default since the workflows pass no
//        `--checks`). It reads the whole raw line, so a straight quote in ANY
//        column fails the run; the header row is exempt (`lines[1:]`). Added
//        for #1334: #1327 refused a quote in TWLink, but one in OrigWords, Tags,
//        Reference or ID still turned the -be- PR red with no banner. The
//        reason names the column(s). A TWLink whose only fault is a quote gets
//        this entry alone, not also the TWLink-shape one.
//        en_tn (check 15, inlined ~646-716) and en_tq (check 13, ~604-632) run
//        the same line check, but their render curls quotes only in Note /
//        Question / Response (educateQuotes), so holding them needs its own
//        prod count of the rendered bytes first; not done here.
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
// it should find no Occurrence problem: Occurrence is not editable in the UI, so
// holding a book for a defect no translator can fix was never actionable. That
// check stays as a backstop — a hit means the render and this module have drifted
// apart, which is worth a HOLD. TWLink is different: the export renders the
// stored link as-is (only tsvCell's escaping), so a TWLink hit is a real row a
// translator can fix by picking the article again.
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
// Pure (its only import is the pure twLinkShape.ts leaf) so it is directly
// testable by the --experimental-strip-types runner, same shape as
// shrinkGuard.ts / reimportSyncGate.ts.

import { isMalformedTwLink, STRAIGHT_QUOTE_RE } from "./twLinkShape.ts";

const STRAIGHT_QUOTES_G = /['"]/g;

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
  // twl only. A header without TWLink skips just this rule (same reason as above:
  // never judge a cell we cannot locate).
  const linkIdx = kind === "twl" ? header.indexOf("TWLink") : -1;

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
      // Judged on the rendered cell, so a stored newline already shows as the
      // literal backslash-n Door43 will see. "" is a warning and ships. Straight
      // quotes are left to the whole-row rule below, so a link whose only
      // fault is a quote gets one entry naming TWLink, not "not a full rc://
      // link" (#1334).
      const link = linkIdx === -1 ? "" : (cells[linkIdx] ?? "");
      const unquoted = link.replace(STRAIGHT_QUOTES_G, "");
      if (isMalformedTwLink(unquoted)) {
        out.push({
          ref,
          rowId,
          // Blank space is judged on the link as written: "' " is a quote
          // plus a space, not blank.
          reason:
            link.trim() === ""
              ? `TWLink '${link}' is only blank space, so open the row and clear it or pick the article from the list`
              : `TWLink '${link}' is not a full rc:// link such as rc://*/tw/dict/bible/kt/god, ` +
                `so open the row and pick the article from the list`,
        });
      }
      // Door43's _flag_straight_quotes tests the whole raw data line, so a
      // straight quote in any column fails the run. Checking every cell of the
      // tab-split line covers exactly that line.
      // A curly quote is the fix in OrigWords or Tags, but not in TWLink: no
      // article slug contains a quote, so there the fix is the article itself.
      const quoteIdxs = cells.flatMap((cell, i) => (STRAIGHT_QUOTE_RE.test(cell) ? [i] : []));
      if (quoteIdxs.length > 0) {
        const quotes = ["'", '"'].filter((q) => line.includes(q)).join(" and ");
        const colName = (i: number) => header[i] ?? `column ${i + 1}`;
        const textCols = quoteIdxs.filter((i) => i !== linkIdx).map(colName);
        const inLink = quoteIdxs.includes(linkIdx);
        const fix =
          textCols.length === 0
            ? "remove it from TWLink or pick the article from the list"
            : !inLink
              ? "use a curly quote (’ “ ”) or remove it"
              : `use a curly quote (’ “ ”) or remove it in ${textCols.join(" and ")}, ` +
                `and remove it from TWLink or pick the article from the list`;
        out.push({
          ref,
          rowId,
          reason:
            `straight quote (${quotes}) in ${quoteIdxs.map(colName).join(" and ")}: Door43 accepts only curly quotes, ` +
            `so open the row and ${fix}`,
        });
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
  // hardRejectRows can report several problems for one row (Occurrence,
  // TWLink shape, straight quotes), so group by row ID: one line per row with
  // its reasons joined, and the sample cap and "+N more" count rows.
  const byRow = new Map<string, { ref: string; reasons: string[] }>();
  for (const r of rejects) {
    const row = byRow.get(r.rowId);
    if (row) row.reasons.push(r.reason);
    else byRow.set(r.rowId, { ref: r.ref, reasons: [r.reason] });
  }
  const rows = [...byRow.entries()];
  const shown = rows
    .slice(0, 6)
    .map(([rowId, r]) => `${r.ref} (${rowId}): ${r.reasons.join(" and also ")}`)
    .join("; ");
  const more = rows.length > 6 ? `; +${rows.length - 6} more` : "";
  const rowCount = rows.length;
  return (
    `Benjamin — nightly export HELD ${label}: ${rowCount} row(s) would fail DCS ` +
    `validation as a hard error, so the -be- PR's check would go red and the merge bot would never merge it. ` +
    `${shown}${more}. Fix those rows (or delete them) in the editor; the next export picks them up, and every other ` +
    `edit in ${label} is waiting on it. Blank notes/questions/OrigWords/TWLink and unpaired [ ] in a Note ` +
    `do NOT cause this — those are validator warnings and ship normally.`
  );
}

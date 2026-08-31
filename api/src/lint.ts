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
//   USFM: unbalanced \f / \f* footnotes (6), missing verses (5), unmatched
//       curly quotation marks (“ ”).
// The MECHANICAL checks (formatting, trailing \n, straight quotes, label spacing,
// reference order, ids, occurrence) are auto-fixed at export and are NOT linted
// here. See docs/export-validation-cleanup.md.
//
// A second family of checks (issue #438) is hand-ported from
// unfoldingWord/uw-content-validation — NOT taken as a dependency (bundle-size /
// Worker-compat risk); its check inventory was audited and only the checks an
// editor can fix in-app were carried over: paired/unpaired punctuation across a
// book, straight quotes, invisible characters, doubled spaces/punctuation, and
// punctuation-spacing problems. All are bucket `flag` — none of these block a
// DCS push, they are copy-quality problems a proofreader wants surfaced. Checks
// that only make sense against raw USFM markup (marker structure, attributes,
// versification) are deliberately NOT ported — those are better fixed on DCS.

import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { extractPlainText, isTsMilestone } from "./importParsers.ts";
import { parseRefOrderKey } from "./tsvFormat.ts";

export type IssueBucket = "flag" | "escalate";

export interface LintIssue {
  check: string; // DCS check name
  bucket: IssueBucket; // flag = human decision in-app; escalate = admin banner
  ref: string; // chapter:verse (or chapter) for navigation
  rowId?: string; // row id (for jump-to-row)
  message: string;
  // The next three are present ONLY on review_kind-derived issues (the
  // nightly-merge "verify this" flags) — never on the mechanical/USFM
  // integrity checks below, which have no flag to dismiss.
  /** True when this issue can be cleared via POST .../dismiss-review. */
  dismissible?: boolean;
  /** Door43's row value at flag time (review_master_json), or null when the
   *  column/value is absent — read DEFENSIVELY (see reviewSnapshot below), a
   *  separate in-flight PR owns the migration that populates it. */
  door43?: Record<string, unknown> | null;
  /** The live row's own current value for the same per-kind field set. */
  ours?: Record<string, unknown>;
  /** The row's review_kind at the time this issue was built — the client
   *  echoes this back on dismiss so a stale flag never silently clears a
   *  DIFFERENT one the nightly reimport re-stamped in the meantime (see the
   *  "stale dismiss" guard on the dismiss-review route in rows.ts). */
  reviewKind?: string;
}

// A required field is "blank" when it is missing or only whitespace. Computed
// dynamically from the live row (NOT persisted as review_kind) so the flag is
// always current and self-clears the instant the field is filled in or the row
// is deleted. This replaces hand-stamping review_kind='blank-note' via SQL.
function isBlankRequired(s: string | null | undefined): boolean {
  return !s || s.trim() === "";
}

// Chapter 0 is ONLY ever legal as the literal "front:intro" (see
// chapterZeroGuard.ts) — a book has no chapter numbered 0 with real verses,
// so "0:1", "0:intro", "0:front" etc. have no valid rendering. The negative
// lookahead excludes a leading "0:" from the three numeric-chapter branches
// while leaving "front:intro" itself untouched (see the ISA ee2w "0:1"
// incident, STATE.md).
const REFERENCE_RE = /^(?:front:intro|(?!0:)\d+:intro|(?!0:)\d+:front|(?!0:)\d+:\d+(?:[,-][\d,:-]*\d+)*)$/;
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

// The cleanup chip's title for a workflow review flag. It has to be derived from
// `review_kind`, because the outcomes it covers say OPPOSITE things and the chip
// title is the first — often the only — line a translator reads:
//   merge_conflict — Door43's value replaced theirs.
//   merge_kept     — theirs was kept over Door43's, and the next export
//                    publishes it there (#540 item 2).
//   ref_moved      — nothing was merged at all; the two sides disagree about
//                    where the row belongs.
// Hard-coding "Merged Door43 edit" for every flag, as tq/twl did, told a reader
// of the last two the reverse of what happened. `fallback` preserves each kind's
// pre-existing wording for a flag with no mapping (tn's older "Adapted note").
export function reviewFlagTitle(reviewKind: string | null | undefined, fallback: string): string {
  switch (reviewKind) {
    case "merge_conflict":
      return "Merged Door43 edit — verify";
    case "merge_kept":
      return "Kept over Door43 — verify";
    case "ref_moved":
      return "Reference differs from Door43 — verify";
    default:
      return fallback;
  }
}

// review_master_json (a snapshot of Door43's row value at flag time) is a
// column added by a SEPARATE in-flight PR (migration not yet applied on
// every deploy). Read it DEFENSIVELY: `row.review_master_json` may be
// `undefined` (column doesn't exist yet), NULL (never populated for this
// row), or a JSON string. Any of those — or malformed JSON — yields `null`,
// never a thrown 500. Never reference the column by name in SQL; the caller
// already does `SELECT *`.
function reviewMasterSnapshot(row: Record<string, unknown>): Record<string, unknown> | null {
  const raw = row["review_master_json"];
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // `typeof [] === "object"` in JS — an array is not a row snapshot, so
    // exclude it explicitly rather than let it masquerade as one.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The live row's own value for a per-kind field allowlist — kept narrow so
// `ours` never leaks internal columns (version, updated_by, review_kind,
// etc.) into the lint feed.
function ownFields(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
}

const TN_REVIEW_FIELDS = ["ref_raw", "support_reference", "quote", "occurrence", "note", "tags"] as const;
const TQ_REVIEW_FIELDS = ["ref_raw", "question", "response", "tags"] as const;
const TWL_REVIEW_FIELDS = ["ref_raw", "orig_words", "occurrence", "tw_link", "tags"] as const;

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
    // A tn row with no note is invalid content: section-header rows carry their
    // `# Heading` text IN the note, so there is no legitimately note-less tn
    // row. DCS's validator agrees but only advisorily — `validate_tn_files.py`
    // raises "Note column cannot be blank" at severity="warning", which by its
    // own ErrorCollector ("Only hard errors decide the exit code") exits 0 and
    // merges. So a blank note DOES reach Door43, which is exactly why this flag
    // matters: nothing downstream will stop it. Use chapter:verse for the ref
    // (jump-to-note loads the chapter parsed from it).
    if (isBlankRequired(r.note)) {
      issues.push({
        check: "Empty note",
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: "Empty note — DCS only warns, so this row publishes blank on the next export. Add a note or delete the row.",
      });
    }
    const note = r.note ?? "";
    for (const msg of bracketProblems(note)) {
      issues.push({ check: "13. Paired Square Bracket", bucket: "flag", ref, rowId: r.id, message: msg });
    }
    for (const msg of altLabelProblems(note)) {
      issues.push({ check: "12. Alternate translation Label", bucket: "flag", ref, rowId: r.id, message: msg });
    }
    for (const p of textFieldProblems(note)) {
      issues.push({ check: p.check, bucket: "flag", ref, rowId: r.id, message: p.message });
    }
    // Issue #544: a keep_no_base row (no ancestor recoverable, so the nightly
    // merge couldn't check it against a Door43-side edit) gets its own check
    // label — it must not share "Adapted note — verify" (a different meaning:
    // a migrated/adapted note) or say anything was overwritten, since nothing
    // was. Checked BEFORE the generic review_kind fallback below.
    if (r.review_kind === "merge_no_base") {
      issues.push({
        check: "Unmerged Door43 edit — verify",
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: r.review_reason ?? "No ancestor was recoverable to merge this row against Door43 — verify it.",
        dismissible: true,
        door43: reviewMasterSnapshot(r as unknown as Record<string, unknown>),
        ours: ownFields(r as unknown as Record<string, unknown>, TN_REVIEW_FIELDS),
        reviewKind: r.review_kind,
      });
    } else if (r.review_kind) {
      // Workflow-only review flag for adapted/migrated notes (review_kind set).
      // Not a DCS check — surfaces the human-verify queue in the same chip.
      // Use chapter:verse for the ref (ref_raw can be a stale/adapted range, and
      // jump-to-note loads the chapter parsed from this ref).
      issues.push({
        check: reviewFlagTitle(r.review_kind, "Adapted note — verify"),
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: r.review_reason ?? "Adapted from a parallel passage — verify the Hebrew quote and wording.",
        dismissible: true,
        door43: reviewMasterSnapshot(r as unknown as Record<string, unknown>),
        ours: ownFields(r as unknown as Record<string, unknown>, TN_REVIEW_FIELDS),
        reviewKind: r.review_kind,
      });
    }
  }
  return issues;
}

// tq rows: both question and response are REQUIRED. As with the tn note above,
// DCS's `validate_tq_files.py` reports a blank one at severity="warning", so it
// publishes rather than blocks — this lint is the only thing that flags it. (tq
// has no other flag/escalate DCS check the export can't auto-fix, so this is the
// whole tq lint today.)
export function lintTqRows(rows: TqRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = `${r.chapter}:${r.verse}`;
    if (isBlankRequired(r.question)) {
      issues.push({ check: "Empty question", bucket: "flag", ref, rowId: r.id, message: "Empty question — DCS only warns, so this row publishes blank on the next export. Add a question or delete the row." });
    }
    if (isBlankRequired(r.response)) {
      issues.push({ check: "Empty response", bucket: "flag", ref, rowId: r.id, message: "Empty response — DCS only warns, so this row publishes blank on the next export. Add a response or delete the row." });
    }
    for (const field of [r.question, r.response]) {
      for (const p of textFieldProblems(field ?? "")) {
        issues.push({ check: p.check, bucket: "flag", ref, rowId: r.id, message: p.message });
      }
    }
    // Issue #544: see lintTnRows' matching branch — a keep_no_base row must not
    // reuse "Merged Door43 edit — verify" (that label promises a merge landed;
    // here nothing did) and must not say anything was overwritten.
    if (r.review_kind === "merge_no_base") {
      issues.push({
        check: "Unmerged Door43 edit — verify",
        bucket: "flag",
        ref,
        rowId: r.id,
        message: r.review_reason ?? "No ancestor was recoverable to merge this row against Door43 — verify it.",
        dismissible: true,
        door43: reviewMasterSnapshot(r as unknown as Record<string, unknown>),
        ours: ownFields(r as unknown as Record<string, unknown>, TQ_REVIEW_FIELDS),
        reviewKind: r.review_kind,
      });
    } else if (r.review_kind) {
      // Workflow-only review flag (mirror lintTnRows): set when the nightly
      // Door43->D1 three-way merge adopted a maintainer's edit that conflicted
      // with an app-side edit (tsvMerge.ts). Surfaces in the cleanup chip; the
      // overwritten value is recoverable from row history.
      issues.push({
        check: reviewFlagTitle(r.review_kind, "Merged Door43 edit — verify"),
        bucket: "flag",
        ref,
        rowId: r.id,
        message: r.review_reason ?? "A Door43 edit was merged over your change — verify it.",
        dismissible: true,
        door43: reviewMasterSnapshot(r as unknown as Record<string, unknown>),
        ours: ownFields(r as unknown as Record<string, unknown>, TQ_REVIEW_FIELDS),
        reviewKind: r.review_kind,
      });
    }
  }
  return issues;
}

// twl rows: both OrigWords (orig_words) and TWLink (tw_link) are REQUIRED. Same
// severity story as tn/tq — `validate_twl_files.py` warns on a blank OrigWords
// or TWLink and exits 0, so a blank TWLink publishes as an unresolvable link.
export function lintTwlRows(rows: TwlRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = `${r.chapter}:${r.verse}`;
    if (isBlankRequired(r.orig_words)) {
      issues.push({ check: "Empty OrigWords", bucket: "flag", ref, rowId: r.id, message: "Empty OrigWords — DCS only warns, so this row publishes blank on the next export. Add the original-language word(s) or delete the row." });
    }
    if (isBlankRequired(r.tw_link)) {
      issues.push({ check: "Empty TWLink", bucket: "flag", ref, rowId: r.id, message: "Empty TWLink — DCS only warns, so this row publishes with no link on the next export. Add a translationWords link or delete the row." });
    }
    // Issue #544: see lintTnRows' matching branch.
    if (r.review_kind === "merge_no_base") {
      issues.push({
        check: "Unmerged Door43 edit — verify",
        bucket: "flag",
        ref,
        rowId: r.id,
        message: r.review_reason ?? "No ancestor was recoverable to merge this row against Door43 — verify it.",
        dismissible: true,
        door43: reviewMasterSnapshot(r as unknown as Record<string, unknown>),
        ours: ownFields(r as unknown as Record<string, unknown>, TWL_REVIEW_FIELDS),
        reviewKind: r.review_kind,
      });
    } else if (r.review_kind) {
      // Workflow-only review flag (mirror lintTnRows) — a merged Door43 edit that
      // conflicted with an app-side edit (tsvMerge.ts).
      issues.push({
        check: reviewFlagTitle(r.review_kind, "Merged Door43 edit — verify"),
        bucket: "flag",
        ref,
        rowId: r.id,
        message: r.review_reason ?? "A Door43 edit was merged over your change — verify it.",
        dismissible: true,
        door43: reviewMasterSnapshot(r as unknown as Record<string, unknown>),
        ours: ownFields(r as unknown as Record<string, unknown>, TWL_REVIEW_FIELDS),
        reviewKind: r.review_kind,
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

// True when the verse's alignment data has one physical source token claimed by
// two or more DISTINCT top-level chains — a data defect that renders as
// "doubled" Hebrew in the aligner (see web/src/lib/alignment.ts
// findReusedSourcePositions and the ZEC 14:8 UST case it documents: a compound
// milestone chain wraps בַּקַּיִץ+וּבָחֹרֶף as "throughout the whole year" AND two
// separate single-word chains wrap the same two tokens again as "in the hot
// season" / "and in the cold season"). Lint has no UHB/UGNT rows, so identity is
// keyed on `nfc(x-content)|x-occurrence` rather than resolved source position —
// each TOP-LEVEL `\zaln-s` is a "chain": itself plus every zaln nested inside it,
// in document order (mirrors how hasGluedMilestone/dropDuplicateSourceMilestones
// treat nested zalns as belonging to their outer chain). A key that appears in
// two chains sharing the SAME full chain key (the joined key sequence) is the
// legitimate one-token-to-N-target-runs split (JER 28:1) — not flagged, since
// that is exactly what the aligner panel's mergeSamePositionGroups fuses into
// one card. Only a key shared across chains with DIFFERING full chain keys is a
// real defect. Scope: this is the ACROSS-chain defect only. A single chain that
// wraps the same token twice (the JER 31:33 shape) dedupes to one key here and
// is not reported — detectDoubledSourceMilestones in web/src/lib/alignment.ts
// owns that one.
//
// This check DISAGREES with the aligner's marker in BOTH directions. Measured
// against the whole of prod D1 — 37 books, 51,848 ULT/UST verses with a source
// verse, via scripts/scan-reused-token-visibility.mjs, before and after the
// chain-signature fix below:
//
//              flagged  both  lint-only  marker-only
//   before        58     20      18          20
//   after         50     19      10          21
//
// The lint-only column is this check's false positives. All of them trace to
// identity here being keyed on RAW x-occurrence while findReusedSourceWordIds
// runs after parseAlignment has reformed occurrences against the real UHB/UGNT.
// The CHAIN SIGNATURE fix closes 8 (JER 33:7, 33:11, 35:3, 35:11, 37:9, 37:10,
// MAT 9:20, ZEC 11:11) — two chains over the SAME tokens used to differ only in
// a raw x-occurrence the reform normalizes away (JER 33:7 writes וַהֲשִׁבֹתִי as
// occurrence 1 in one chain and 2 in the other, of a token the UHB contains
// once). The signature now strips the occurrence suffix before comparing chains,
// so that legitimate one-token-to-two-target-runs split no longer looks like two
// distinct chains.
//
// TRUST THE NUMBERS ABOVE, NOT EARLIER ONES. An earlier revision of this comment
// claimed 63 flagged / 12 lint-only / 4 remaining. Those came from a census
// script that paired verse-BRIDGE target rows (`\v 6-9`) with only their FIRST
// source verse, so the marker ran against a truncated source and spuriously
// "flagged" six verses that are in fact lint-only (1CH 8:8, 1CH 8:12, ACT 1:24,
// JOS 14:3, LEV 24:10, MAT 7:13). The script now pairs the full range via the
// app's own concatSourceRange. Any future figure quoted here must come from that
// fixed script.
//
// The 10 that remain are DELIBERATELY still flagged: 1CH 8:8, 1CH 8:12,
// 1CH 22:19, ACT 1:24, JOS 14:3, LEV 24:10, MAT 7:13, PSA 71:9, REV 4:9 all
// stamp two genuinely distinct source tokens with the same x-occurrence, so
// telling them apart needs the real occurrence reform this check cannot run;
// and HAB 1:3 is the reversed-nesting case below. Lint cries wolf on these BY
// CHOICE — see the reverted-suppression note next for what the cheap
// alternative cost.
//
// A source-token-count suppression (count real source `\w` tokens per NFC
// content, suppress when the source holds at least as many as there are chains
// claiming it) was tried and REVERTED, because it silenced lint on verses the
// marker still flags as real. **Its evidence is only partly re-verified.** With
// the fixed script, 1CH 6:78 UST is still a genuine defect it would suppress
// (source has וְאֶת three times, the target stamps FOUR milestones, marker
// flags 4 words) — but LEV 24:10 UST, the other verse originally cited, is
// NOT a real defect at all (marker flags 0; it is one of the 10 lint-only
// false positives above). So the revert rests on 1CH 6:78 alone and has not
// been re-measured end to end against the fixed script. Do not treat "the
// suppressor is definitively wrong" as settled: re-measure both directions
// before either restoring or re-rejecting it. The two regression tests below
// (LEV 24:10 / 1CH 6:78 shapes) pin the LINT behaviour for those shapes, which
// is stable either way — but the LEV one is NOT evidence of a real defect.
// The occurrence-insensitive signature has a KNOWN HOLE, and it is accepted
// deliberately, as a CLASS: any two chains whose unique-key lists agree on
// content sequence but differ in one or more occurrence numbers now sign
// identically, so a token they share is not reported. Instances of the class:
//   - `[A|1, B|1]` + `[A|1, B|2]` both sign as "A,B" (the original case below).
//   - `[A|1, A|2]` + `[A|2, A|3]` both sign as "A,A" (share the A|2 token).
//   - `[A|1, A|2]` + `[A|2, A|1]` both sign as "A,A" (same-content reversal —
//     see the HAB 1:3 note below for why this differs from DIFFERENT-content
//     reversal, which still flags).
//   - `[A|1, B|1, C|1]` + `[A|1, B|2, C|1]` both sign as "A,B,C" (the differing
//     occurrence sits in the middle, not at an edge).
// That shape is STRUCTURALLY IDENTICAL to the JER 33:7 split this fix
// exists to stop flagging — chains differing only in one token's occurrence,
// with the shared tokens being the ones at issue. What separates "one alignment
// written twice" from "two alignments both claiming A" is solely whether the
// source contains the differing word once or twice, which is exactly the
// judgement this check cannot make without running the reform. So the choice is
// only WHICH WAY to be wrong, and it was made on measurement: keeping the old
// behaviour costs 8 false positives, this one costs 1 verse. Corpus-wide,
// exactly 9 verses lost their flag here — 8 with the marker clean (real false
// positives) and ONE, JER 37:5 UST, where the marker still flags and renders
// the defect in red. Do not "close" this hole by restoring the full-key
// signature without re-measuring both directions.
//   - HAB 1:3 — NOT an occurrence artefact at all, and NOT an instance of the
//     class above: the two chains carry the SAME keys but with DIFFERENT
//     x-content (אָוֶן vs וְעָמָל) in REVERSED nesting order, so their signatures
//     genuinely differ and this check still flags. Reversed nesting is only
//     absorbed into the hole above when the reversed tokens share the SAME
//     content (see the same-content-reversal instance above) — in that case
//     the signature collapses just like any other occurrence-only difference.
//     The aligner's marker resolves the HAB 1:3 case to one canonical source
//     order and exempts it as a split. A real encoding oddity, not a false
//     positive — do not weaken either detector to reconcile it.
//
// The single verse this fix stops flagging that the
// right reason: its real reuse (שִׁמְעָם claimed by a compound and a standalone)
// is invisible to a check with no source rows in BOTH the old and new logic —
// the old lint=Y came from an unrelated occurrence artefact in the same verse.
//
// Two further mechanisms still push the other way (marker flags, this check
// silent), both rooted in lint never resolving actual source POSITIONS (only
// content+occurrence identity):
//   1. A merged shared prefix hides reuse. findTopLevelZalns treats an outermost
//      `\zaln-s` plus all nesting as one chain; parseAlignment makes a group per
//      word-bearing chain. So `\zaln-s A\*\zaln-s B\*\w x\w*\zaln-e\*\zaln-s
//      C\*\w y\w*\zaln-e\*\zaln-e\*` reports nothing here and flags A there,
//      while the un-merged encoding of the SAME alignment reports it — whether
//      the defect is seen depends on how the writer nested it.
//   2. A milestone with x-content but no x-occurrence is dropped here (see
//      zalnLintKey) where parseAlignment defaults it to 1, which can collapse
//      two differing chain keys into one and silence a real reuse.
// The aligner's marker remains the more reliable of the two for those two
// mechanisms — do not reconcile by weakening the marker. See
// web/src/lib/alignment.ts's comment on findReusedSourceWordIds, which points
// back here rather than restating counts.
function zalnLintKey(node: Record<string, unknown>): string | null {
  const content = node["content"];
  if (typeof content !== "string" || content === "") return null;
  // A MISSING occurrence is unknown, not 1. Defaulting it would key two
  // genuinely distinct occurrences of a repeated word identically and flag a
  // correctly aligned verse. Unkeyable milestones are simply not evidence.
  const occurrence = node["occurrence"];
  if (occurrence === undefined || occurrence === null || occurrence === "") return null;
  return `${content.normalize("NFC")}|${String(occurrence)}`;
}
function isZalnMilestone(n: unknown): n is Record<string, unknown> {
  return !!n && typeof n === "object" && (n as Record<string, unknown>)["type"] === "milestone" &&
    (n as Record<string, unknown>)["tag"] === "zaln";
}
// Depth-first keys of every zaln in this chain (the node itself, then nested
// zalns reached through it or through non-zaln wrapper children).
function collectZalnChainKeys(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  const key = zalnLintKey(node);
  if (key !== null) out.push(key);
  const children = node["children"];
  if (Array.isArray(children)) out.push(...collectZalnChainKeysFromList(children));
  return out;
}
function collectZalnChainKeysFromList(nodes: unknown[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (isZalnMilestone(n)) {
      out.push(...collectZalnChainKeys(n));
      continue;
    }
    const children = (n as Record<string, unknown> | null)?.["children"];
    if (Array.isArray(children)) out.push(...collectZalnChainKeysFromList(children));
  }
  return out;
}
// Top-level zaln nodes: the first zaln found on any path is a chain root — its
// own nested zalns are NOT separately collected here (they belong to its chain).
function findTopLevelZalns(nodes: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const n of nodes) {
    if (isZalnMilestone(n)) {
      out.push(n);
      continue;
    }
    const children = (n as Record<string, unknown> | null)?.["children"];
    if (Array.isArray(children)) out.push(...findTopLevelZalns(children));
  }
  return out;
}
// Strip the trailing `|<occurrence>` off a zalnLintKey, leaving just the NFC
// content. Used to build the chain SIGNATURE (see below) — token IDENTITY
// (chainKeysByToken's map key) keeps the full key including occurrence.
function stripOccurrenceSuffix(key: string): string {
  const i = key.lastIndexOf("|");
  return i === -1 ? key : key.slice(0, i);
}

function hasReusedSourceToken(nodes: unknown[]): boolean {
  const chains = findTopLevelZalns(nodes).map(collectZalnChainKeys);
  const chainKeysByToken = new Map<string, Set<string>>();
  for (const keys of chains) {
    // De-duplicate WITHIN the chain before taking its identity, exactly as
    // findReusedSourceWordIds does per group (`!tokens.includes(k)`). Without
    // this, a chain that wraps one token twice (the JER 31:33 shape) keyed as
    // "A,A" while a standalone claiming that token keyed as "A" — two distinct
    // sequences, so lint flagged a verse the aligner marks nothing on, because
    // the aligner's group had already collapsed to the single key "A". A
    // translator would click through from the lint feed to a clean-looking
    // verse. The within-chain doubling is real but belongs to
    // detectDoubledSourceMilestones (see the scope note above), not here.
    // RESIDUAL: this dedup is occurrence-SENSITIVE (Set(keys) compares full
    // keys, occurrence included), so it only closes the shape where the
    // repeat is numbered IDENTICALLY: [A|1, A|1, B|1] + [A|1, B|1] silences,
    // but [A|1, A|2, B|1] + [A|1, B|1] still flags (1 issue) — verified. That
    // is the AI doubled-source-milestone defect: the source holds A once, the
    // marker dedups it to one position and stays silent, and lint flags a
    // false positive in a class this check explicitly disclaims owning. Not
    // fixed here; some of the 10 remaining lint-only verses may be this shape
    // (not verified per-verse).
    const uniqueKeys = [...new Set(keys)];
    // The chain SIGNATURE strips occurrence before joining (deliberately NOT
    // deduped again — positional multiplicity must survive, so [A|1, A|2]
    // signs as "A,A" not "A"). This is what lets two chains over the SAME
    // tokens that differ only by a raw, un-reformed occurrence number collapse
    // into the same signature instead of registering as two distinct chains
    // (see the scope comment above).
    // Joined with U+0001, not a comma: x-content can itself legally contain a
    // comma (e.g. a source token "A,B"), and joining with "," would let
    // [X|1, "A,B"|1] and [X|1, A|1, B|1] both sign as "X,A,B", silencing a
    // reused X. U+0001 cannot occur in USFM x-content, so it can't collide.
    const signature = uniqueKeys.map(stripOccurrenceSuffix).join("");
    for (const key of uniqueKeys) {
      const set = chainKeysByToken.get(key) ?? new Set<string>();
      set.add(signature);
      chainKeysByToken.set(key, set);
    }
  }
  for (const set of chainKeysByToken.values()) {
    if (set.size >= 2) return true;
  }
  return false;
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

// A verse row's parsed `verseObjects`, or [] when the row is absent or its stored
// JSON is unreadable. Lint must survive a corrupt row rather than throw and take
// the whole book's report down with it — a corrupt intro simply reads as "carries
// no marker", which is the safe direction (it flags for a human to look).
function verseObjectsOf(row: VerseRow | undefined): unknown[] {
  if (!row) return [];
  let parsed: unknown;
  try {
    parsed = parseVerseContentJson(row);
  } catch {
    return [];
  }
  const vos = (parsed as { verseObjects?: unknown[] })?.verseObjects;
  return Array.isArray(vos) ? vos : [];
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
    if (endsWithOpeningMarker(verseObjectsOf(front))) continue;
    if (startsWithOpeningMarker(verseObjectsOf(first))) continue;
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

// Port of the "matched open/closed quotation marks" judgement call named in
// #438 — narrowed, after two review rounds on PR #483, to the one claim that
// is actually provable from plain text: a CLOSING curly quote (”) with no
// opening quote (“) anywhere earlier in the book. Deliberately narrow in two
// more ways: straight `"` is auto-normalized to curly at export (see
// docs/export-validation-cleanup.md) so it is not linted, and curly single
// quotes (‘ ’) double as apostrophes inside words — a naive pairing check
// cannot tell "don't" from a genuine unmatched single quote.
//
// This deliberately does NOT flag a leftover, never-closed opening quote, and
// deliberately runs BOOK-wide rather than resetting at any boundary. Two real
// ULT/UST conventions make "every opener needs a closer" unprovable from
// plain text alone:
//   - Continuation openers: multi-paragraph dialogue re-opens each paragraph
//     with “ and closes only the final one ("“first paragraph…" "“second
//     paragraph…”") — usfm-js's plain text has no paragraph markers left in
//     it (extractPlainText strips them), so the checker cannot tell a
//     continuation opener from a genuinely unclosed one.
//   - Cross-chapter spans: quoted speech can open near the end of one
//     chapter and close in the next — chapter breaks do not terminate a
//     quotation, so per-chapter scoping (tried and reverted) double-flagged
//     ordinary text at every chapter boundary too.
// A running, never-negative counter sidesteps both: it only ever objects to a
// ” for which there is provably no “ anywhere before it — true regardless of
// how many paragraphs or chapters separate them — and silently accepts any
// number of unconsumed opens. `entries` is sorted defensively (chapter, then
// verse) rather than trusting caller order, since a mis-ordered scan could
// consume a closer against an opener that doesn't actually precede it.
function quoteIssues(verses: VerseRow[]): LintIssue[] {
  const entries: Array<{ ref: string; chapter: number; verse: number; text: string }> = [];
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
    entries.push({ ref: `${v.chapter}:${v.verse}`, chapter: v.chapter, verse: v.verse, text: extractPlainText(parsed) });
  }
  entries.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);

  const issues: LintIssue[] = [];
  let openCount = 0;
  for (const e of entries) {
    for (let i = 0; i < e.text.length; i++) {
      const ch = e.text[i];
      if (ch === "“") {
        openCount++;
      } else if (ch === "”") {
        if (openCount === 0) {
          issues.push({
            check: "Quotation Mark",
            bucket: "flag",
            ref: e.ref,
            message: `Closing quote '”' at character ${i + 1} has no opening quote anywhere earlier in the book.`,
          });
        } else {
          openCount--;
        }
      }
    }
  }
  return issues;
}

// USFM (ult/ust) integrity lint over the stored verse rows: unbalanced footnotes,
// joiner-glued alignment milestones, and unmatched curly quotation marks.
// Footnotes/glued-milestones/reused-tokens are genuinely per-verse; quotation
// marks are not (see quoteIssues) and are checked once across the whole call,
// not inside this per-verse loop. (Verse-coverage / chapter-count are guarded
// by the export shrink guard and validated whole-file downstream; not
// duplicated here.)
export function lintUsfmVerses(verses: VerseRow[]): LintIssue[] {
  const issues: LintIssue[] = [...quoteIssues(verses)];
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
    if (hasReusedSourceToken(vos)) {
      issues.push({
        check: "Reused source token",
        bucket: "flag",
        ref,
        message: "the same source word is aligned in more than one group (renders as doubled Hebrew); re-align the verse.",
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Text-quality checks ported from uw-content-validation (issue #438). These run
// over the PROSE a reader sees, not the USFM markup — flattenVerseProse below
// is what defines "prose". Everything here is bucket `flag`: copy-quality
// problems for a proofreader, none of which block a DCS push.
// ---------------------------------------------------------------------------

// Subtrees that carry no reader-facing verse prose. Footnote/cross-ref bodies
// live in the node's `content` STRING (not children), so skipping the node
// skips the body; they are excluded because footnotes quote source-language
// text and references ("1:2") that would false-positive the prose checks.
const PROSE_EXCLUDED_TAGS: ReadonlySet<string> = new Set(["f", "x", "fe", "ef", "ex", "rem"]);

// Flatten a verse's parsed nodes to the prose a reader sees: word/text node
// text in document order, footnote/cross-ref subtrees dropped, alignment
// milestones transparent (their `content` is SOURCE text and never included).
// Markers can carry text (usfm-js parks an opening quote on the marker node —
// see the usfm-js quirks note in CLAUDE.md), so `text` is taken from every
// non-excluded node, not just word/text nodes.
//
// Break markers emit TWO distinct separators, and lintPairedPunctuation's
// continuation rule depends on the distinction (measured on en_ult ISA 46: the
// stanza re-opening “ sits after `\b`, while ordinary poetry lines are `\q1`s):
//   'U+2029' (paragraph separator) — paragraph-type markers (\p, \b, \m, …) and
//             section heads: positions where an English continuation quote may
//             legitimately re-open.
//   '\n'    — poetry line markers (\q1, \q2, …): a mere line break, NOT a
//             continuation position.
// Both count as \s for the spacing checks, so a line boundary never glues two
// words into a fake "punctuation not followed by space" hit.
export function flattenVerseProse(nodes: unknown[]): string {
  let out = "";
  // Collapse whitespace ACROSS node boundaries: a milestone's inner trailing
  // space plus the following inter-line text node both flatten to spaces, but
  // serialize back to ONE rendered space (measured on JER 23:37 \u2014 raw chapter
  // 23 has zero doubled spaces, the naive flatten reported 17 across JER). A
  // GENUINE doubled space lives inside a single text node and is preserved.
  const append = (s: string): void => {
    if (!s) return;
    if (out !== "" && /\s$/.test(out)) s = s.replace(/^ +/, "");
    out += s;
  };
  const walk = (list: unknown[]): void => {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const tag = typeof o["tag"] === "string" ? (o["tag"] as string) : "";
      if (PROSE_EXCLUDED_TAGS.has(tag)) continue;
      const type = o["type"];
      if (type === "paragraph" || type === "section") out += "\u2029";
      else if (type === "quote") out += "\n";
      const text = o["text"];
      if (typeof text === "string") append(text);
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(nodes);
  return out;
}

// Short context excerpt around a character index, with the invisible characters
// made visible (uw-content-validation's display convention: zero-width → ‡,
// no-break space → ⍽) and line breaks flattened so the excerpt stays one line.
function excerptAround(text: string, index: number, radius = 12): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const raw = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return raw
    .replace(/[\u200B\u2060\u200D]/g, "‡")
    .replace(/[\u00A0\u202F]/g, "⍽")
    // 1:1 replacement (NOT a run-collapse) so a doubled space stays visible
    // in the excerpt of the doubled-space message.
    .replace(/[\n\r\t\u2028\u2029]/g, " ");
}

const INVISIBLE_CHARS: ReadonlyArray<{ ch: string; name: string; hebrewLegal: boolean }> = [
  // hebrewLegal: U+2060/U+200D legitimately sit INSIDE one UHB word (see
  // contentHasGlueJoiner above), so when a note quotes a Hebrew word they are
  // not defects — exempted when either neighbour is Hebrew/Greek.
  { ch: "\u200B", name: "zero-width space", hebrewLegal: false },
  { ch: "\u00A0", name: "no-break space", hebrewLegal: false },
  { ch: "\u202F", name: "narrow no-break space", hebrewLegal: false },
  { ch: "\u2060", name: "word joiner", hebrewLegal: true },
  { ch: "\u200D", name: "zero-width joiner", hebrewLegal: true },
];

function isHebrewOrGreekChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff);
}

// One message per invisible-character KIND present (not per occurrence — a
// verse pasted with 30 NBSPs is one problem to fix, not 30 rows in the feed).
function invisibleCharProblems(text: string, exemptHebrewJoiners: boolean): string[] {
  const out: string[] = [];
  for (const { ch, name, hebrewLegal } of INVISIBLE_CHARS) {
    let count = 0;
    let first = -1;
    for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) {
      if (exemptHebrewJoiners && hebrewLegal && (isHebrewOrGreekChar(text[i - 1]) || isHebrewOrGreekChar(text[i + 1]))) {
        continue;
      }
      count++;
      if (first === -1) first = i;
    }
    if (count > 0) {
      out.push(
        `${count} invisible ${name}${count > 1 ? "s" : ""} (shown as ${ch === "\u00A0" || ch === "\u202F" ? "⍽" : "‡"}): “${excerptAround(text, first)}” — retype the affected words or replace with regular spaces.`,
      );
    }
  }
  return out;
}

// Doubled sentence punctuation. Quotes are NOT in this list — a stray doubled
// closer is reported (with better wording) by lintPairedPunctuation. '..' gets
// the ellipsis hint from uw-content-validation.
const DOUBLED_PUNCT_CHARS = ",.;:!?";
function doubledPunctProblems(text: string): string[] {
  const out: string[] = [];
  for (const ch of DOUBLED_PUNCT_CHARS) {
    for (let i = text.indexOf(ch + ch); i !== -1; i = text.indexOf(ch + ch, i + 2)) {
      const hint = ch === "." ? " (an ellipsis should be the single … character)" : "";
      out.push(`doubled '${ch}': “${excerptAround(text, i)}”${hint} — remove the extra one.`);
    }
  }
  return out;
}

// Port of the BAD_CHARACTER_REGEXES core from uw-content-validation
// text-handling-functions.js, adapted to run over flattened prose: the
// original allows only ' ' after the mark; prose here contains line-break
// separators, so \s replaces the literal space. Closing quotes / brackets /
// dashes stay allowed exactly as upstream. ':' and ',' allow a following
// digit (times, refs, "1,000"); '.' also allows '.', '/' and digits. A
// following '}' is allowed everywhere — ULT/UST wrap implied text in { }, so
// "{that is,}" is normal (measured: the brace convention was 780+ of the 809
// hits in the first corpus scan).
const PUNCT_SPACING_RES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "'?' not followed by a space or closing quote", re: /[?](?![\s"”'’)\]}!—–]|$)/g },
  { label: "'!' not followed by a space or closing quote", re: /[!](?![\s"”'’)\]}—–]|$)/g },
  { label: "',' not followed by a space or digit", re: /[,](?![\s0-9"”'’}—–]|$)/g },
  { label: "':' not followed by a space or digit", re: /[:](?![\s/0-9"”}—–]|$)/g },
  { label: "';' not followed by a space or closing quote", re: /[;](?![\s"”'’}—–]|$)/g },
  { label: "'.' not followed by a space, digit, or closing quote", re: /[.](?![\s./0-9"”'’)\]}—–]|$)/g },
];
// Space directly before closing/sentence punctuation ("word ," / "word ”").
const SPACE_BEFORE_PUNCT_RE = / +([,.;:?!’”)\]}])/g;

function punctSpacingProblems(text: string): string[] {
  const out: string[] = [];
  for (const { label, re } of PUNCT_SPACING_RES) {
    for (const m of text.matchAll(re)) {
      out.push(`${label}: “${excerptAround(text, m.index ?? 0)}” — add the missing space or fix the stray character.`);
    }
  }
  for (const m of text.matchAll(SPACE_BEFORE_PUNCT_RE)) {
    const i = m.index ?? 0;
    // Adjacent closing quotes are conventionally space-separated (JER 27:11
    // ULT ends `.’ ” ’ ” ”`) — a spaced closer PRECEDED by another closer is
    // that convention, not an error.
    if ((m[1] === "’" || m[1] === "”") && /[’”'"]/.test(text[i - 1] ?? "")) continue;
    out.push(`space before '${m[1]}': “${excerptAround(text, i)}” — remove the space.`);
  }
  return out;
}

function doubledSpaceProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/ {2,}/g)) {
    const i = m.index ?? 0;
    // Line-leading runs are indentation, not a doubled space the reader sees —
    // markdown note lists indent nested items with leading spaces (measured:
    // "\n  - item" indentation was nearly all of the 1459 hits in the first
    // corpus scan).
    const before = text[i - 1];
    if (i === 0 || before === "\n" || before === "\u2029") continue;
    out.push(`doubled space: “${excerptAround(text, i)}” — collapse to one space.`);
  }
  return out;
}

// Straight quotes in verse prose. The en resources use typographic marks
// exclusively (“ ” ‘ ’ and the ’ apostrophe), so a straight mark is a typo.
function straightQuoteProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["']/g)) {
    const ch = m[0];
    const wanted = ch === '"' ? "“ or ”" : "‘, ’, or the apostrophe ’";
    out.push(`straight quote (${ch}): “${excerptAround(text, m.index ?? 0)}” — replace with ${wanted}.`);
  }
  return out;
}

// Per-verse prose quality checks (straight quotes, invisible characters,
// doubled spaces/punctuation, punctuation spacing). Pair balance is NOT here —
// quotations legitimately span verses and chapters, so lintPairedPunctuation
// owns that book-wide.
export function lintVerseTextQuality(verses: VerseRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const v of verses) {
    if (v.verse === 0) continue;
    const prose = flattenVerseProse(verseObjectsOf(v));
    if (!prose) continue;
    const ref = `${v.chapter}:${v.verse}`;
    const push = (check: string, messages: string[]): void => {
      for (const message of messages) issues.push({ check, bucket: "flag", ref, message });
    };
    push("Straight quote", straightQuoteProblems(prose));
    push("Invisible character", invisibleCharProblems(prose, false));
    push("Doubled space", doubledSpaceProblems(prose));
    push("Doubled punctuation", doubledPunctProblems(prose));
    push("Punctuation spacing", punctSpacingProblems(prose));
  }
  return issues;
}

// Paired punctuation across the WHOLE BOOK, in verse order — the
// uw-content-validation matched-pairs check (its plain-text nesting scan),
// re-anchored to per-verse refs so the feed is clickable. Book-wide because
// quotations legitimately span verses and chapters; per-verse counting would
// flag half the direct speech in scripture.
//
// Each pair gets its own INDEPENDENT stack (no cross-pair nesting check): a
// strict single-stack nesting scan reports one real error as a cascade of
// confusing mismatches, and "( spanning a ” boundary" style interleave is not
// reliably an error in typography. Same-mark nesting (“ inside “ via an inner
// ‘ level, Jeremiah-style) is handled naturally by pushing every opener.
//
// English continuation convention: a multi-paragraph quotation re-opens “ at
// each paragraph start WITHOUT closing the previous one, and one final ” closes
// the lot. An opener at line start while the same mark is already open is
// therefore treated as a continuation and NOT pushed. This can hide a real
// unclosed “ that happens to precede a paragraph-initial “ — accepted; the
// alternative flags every multi-paragraph speech in the book.
//
// Single quotes: ’ doubles as the apostrophe, so a ’ with no ‘ open is NEVER
// flagged, and a possessive ’ can silently close a real ‘ (false negative,
// accepted — this mirrors uw-content-validation, which only reports ‘ excess).
const PAIRED_MARKS: ReadonlyArray<{ open: string; close: string; name: string; apostropheAmbiguous?: boolean }> = [
  { open: "“", close: "”", name: "double quotation mark" },
  { open: "‘", close: "’", name: "single quotation mark", apostropheAmbiguous: true },
  { open: "«", close: "»", name: "guillemet" },
  { open: "‹", close: "›", name: "single guillemet" },
  { open: "(", close: ")", name: "parenthesis" },
  { open: "[", close: "]", name: "square bracket" },
  { open: "{", close: "}", name: "brace" },
];

export function lintPairedPunctuation(verses: VerseRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const sorted = [...verses].sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  type Open = { ref: string; excerpt: string };
  const stacks = new Map<string, Open[]>();
  for (const { open } of PAIRED_MARKS) stacks.set(open, []);
  // True while only whitespace has been seen since the last PARAGRAPH break
  // (U+2029 from flattenVerseProse — \p/\b/\m/section, NOT a \q poetry line
  // break) — the position where a continuation re-opener is legal. Carries
  // ACROSS verse rows: the separator for a break sits at the tail of the
  // previous verse's prose. A chapter boundary is always a paragraph start
  // (its \p may live on a verse-0 row that is missing entirely — that case is
  // lintChapterOpeningMarkers' business, not a reason to mis-flag quotes).
  let atParagraphStart = true;
  let lastChapter = -1;
  for (const v of sorted) {
    const prose = flattenVerseProse(verseObjectsOf(v));
    const ref = `${v.chapter}:${v.verse}`;
    if (v.chapter !== lastChapter) {
      atParagraphStart = true;
      lastChapter = v.chapter;
    }
    for (let i = 0; i < prose.length; i++) {
      const ch = prose[i]!;
      const pairO = PAIRED_MARKS.find((p) => p.open === ch);
      const pairC = PAIRED_MARKS.find((p) => p.close === ch);
      if (pairO) {
        const stack = stacks.get(pairO.open)!;
        if (!(atParagraphStart && stack.length > 0)) {
          stack.push({ ref, excerpt: excerptAround(prose, i) });
        }
      } else if (pairC) {
        const stack = stacks.get(pairC.open)!;
        if (stack.length > 0) {
          stack.pop();
        } else if (!pairC.apostropheAmbiguous) {
          issues.push({
            check: "Paired punctuation",
            bucket: "flag",
            ref,
            message: `closing ${pairC.close} has no matching opening ${pairC.open}: “${excerptAround(prose, i)}”.`,
          });
        }
      }
      // Openers stay transparent to paragraph start so a nested continuation
      // re-opening ("“ ‘" at a paragraph start) is recognized for BOTH levels.
      // A '\n' poetry line break neither sets nor clears the state.
      if (ch === "\u2029") atParagraphStart = true;
      else if (!pairO && !/[\s\u200B]/.test(ch)) atParagraphStart = false;
    }
  }
  for (const { open, close, name } of PAIRED_MARKS) {
    for (const o of stacks.get(open)!) {
      issues.push({
        check: "Paired punctuation",
        bucket: "flag",
        ref: o.ref,
        message: `opening ${open} (${name}) is never closed — no matching ${close} found by the end of the book: “${o.excerpt}”.`,
      });
    }
  }
  return issues;
}

// Note/question/response text-quality problems (the subset of the verse checks
// that make sense inside a markdown-ish TSV text field). Punctuation-spacing
// is deliberately NOT run here: note text is full of markdown links, rc://
// URIs, and inline code whose punctuation would swamp the feed with false
// positives (uw-content-validation carries a long exception list for exactly
// this; we skip the check instead of porting the list).
const BAD_TEXT_COMBINATIONS = ["\\[\\[", "\\]\\]", "] (http", "] (.", "] (/"] as const;

// Doubled spaces and straight quotes are deliberately NOT checked here: the
// export normalizers auto-fix both in TSV prose cells (normalizeNoteText in
// tsvFormat.ts — normalizeNoteWhitespace + educateQuotes), and the charter at
// the top of this file keeps auto-fixed mechanical issues out of the lint.
// Verse text has no such normalizer, so the verse checks DO cover them.
function textFieldProblems(field: string): Array<{ check: string; message: string }> {
  const out: Array<{ check: string; message: string }> = [];
  for (const msg of invisibleCharProblems(field, true)) {
    out.push({ check: "Invisible character", message: msg });
  }
  // tC Create bug artifacts and space-broken markdown links, verbatim from
  // uw-content-validation BAD_CHARACTER_COMBINATIONS (a single \[ is legal).
  for (const combo of BAD_TEXT_COMBINATIONS) {
    const i = field.indexOf(combo);
    if (i !== -1) {
      out.push({
        check: "Bad character combination",
        message: `unexpected '${combo}': “${excerptAround(field, i)}” — ${combo.startsWith("]") ? "remove the space inside the markdown link" : "remove the stray backslashes"}.`,
      });
    }
  }
  // Curly-quote balance per field, with [ ] spans masked out first: an
  // Alternate-translation suggestion in brackets deliberately quotes a
  // FRAGMENT of the verse, opening “ without closing (e.g. GEN 2:18
  // `[…declared, “It is not good]` — measured: 5/5 sampled "unbalanced"
  // notes in the first corpus scan were this convention, not defects). Notes
  // don't span rows, so counting the remainder is safe (unlike verse text).
  // ’ doubles as the apostrophe, so only ‘ excess is reported, mirroring
  // uw-content-validation.
  const masked = field.replace(/\[[^\]]*\]/g, "");
  const count = (ch: string): number => masked.split(ch).length - 1;
  const dOpen = count("“");
  const dClose = count("”");
  if (dOpen !== dClose) {
    out.push({
      check: "Unbalanced quotation marks",
      message: `${dOpen} opening “ but ${dClose} closing ” outside of [ ] spans — add the missing mark or remove the extra one.`,
    });
  }
  const sOpen = count("‘");
  const sClose = count("’");
  if (sOpen > sClose) {
    out.push({
      check: "Unbalanced quotation marks",
      message: `${sOpen} opening ‘ but only ${sClose} closing ’ outside of [ ] spans — add the missing closing mark.`,
    });
  }
  return out;
}

// True when a reference parses (used to keep lint robust to odd inputs).
export function refSortable(ref: string): boolean {
  return parseRefOrderKey(ref) !== null;
}

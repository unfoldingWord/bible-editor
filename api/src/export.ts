// Pure builders for the nightly export, plus the Gitea commit primitive.
// No D1 or Workflow knowledge lives here — exportWorkflow.ts orchestrates,
// this module just turns rows into bytes and posts bytes to DCS.

import usfm from "usfm-js";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";
import { normalizeUsfmFormatting } from "./usfmFormat.ts";
import { normalizeNoteText, sortRowsByReference } from "./tsvFormat.ts";
import { orderTwlRows } from "./twlCanonicalOrder.ts";

export type Resource = "tn" | "tq" | "twl" | "ult" | "ust";

export const ALL_RESOURCES: Resource[] = ["tn", "tq", "twl", "ult", "ust"];

// Standard unfoldingWord USFM filename prefix.
const BOOK_NUMBERS: Record<string, string> = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19",
  PRO: "20", ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25",
  EZK: "26", DAN: "27", HOS: "28", JOL: "29", AMO: "30", OBA: "31",
  JON: "32", MIC: "33", NAM: "34", HAB: "35", ZEP: "36", HAG: "37",
  ZEC: "38", MAL: "39",
  MAT: "41", MRK: "42", LUK: "43", JHN: "44", ACT: "45",
  ROM: "46", "1CO": "47", "2CO": "48", GAL: "49", EPH: "50",
  PHP: "51", COL: "52", "1TH": "53", "2TH": "54", "1TI": "55",
  "2TI": "56", TIT: "57", PHM: "58", HEB: "59", JAS: "60",
  "1PE": "61", "2PE": "62", "1JN": "63", "2JN": "64", "3JN": "65",
  JUD: "66", REV: "67",
};

export function usfmFilename(book: string): string {
  const num = BOOK_NUMBERS[book] ?? "00";
  return `${num}-${book}.usfm`;
}

// Book-specific export branch name: `{BOOK}-be-{user1}-{user2}-...`, where the
// usernames are everyone who made a human edit to *this* resource of *this*
// book, in first-edit order (see ExportWorkflow.contributorsFor). `be` = bible
// editor. With no human contributors the name is `{BOOK}-be-mechanical` — the
// synthetic "mechanical" contributor stands in for machine-only changes (e.g. a
// TWL reorder). It is NOT cosmetic: the DCS-side validate workflow triggers on
// `push: branches: ['*-be-*']` (see docs/dcs-workflows/*.validate-be-branch.yaml)
// and the merge workflow re-checks for `-be-` — both requiring the *trailing*
// dash. A suffix-less `{BOOK}-be` matches neither, so those branches were never
// validated and never auto-merged, while Gitea still reported a green combined
// status (no/skipped checks count as success). Keep every branch carrying `-be-`.
//
// "mechanical" is a name, not an authority: nothing reads a contributor list back
// out of a branch name (consumers only take the book, splitting on "-be"), so a
// real DCS user named "mechanical" would be indistinguishable here but harmless.
//
// usernames are sanitized to the git ref-safe set (alphanumerics, dot, dash,
// underscore) so a stray character can't produce an unpushable branch. Our DCS
// usernames are already in that set; this is just belt-and-suspenders.
// Stand-in "username" for a machine-only export (no human contributors).
export const MECHANICAL_CONTRIBUTOR = "mechanical";

export function buildExportBranch(book: string, usernames: string[]): string {
  const safe = usernames
    .map((u) => u.replace(/[^A-Za-z0-9._-]/g, ""))
    .filter((u) => u.length > 0);
  return `${book}-be-${safe.length === 0 ? MECHANICAL_CONTRIBUTOR : safe.join("-")}`;
}

// ── TSV builders ─────────────────────────────────────────────────────────────
// Column order matches docs/samples/*.tsv exactly. Downstream tooling is
// positional; reorder and consumers break.

const TN_HEADERS = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence", "Note"];
const TQ_HEADERS = ["Reference", "ID", "Tags", "Quote", "Occurrence", "Question", "Response"];
const TWL_HEADERS = ["Reference", "ID", "Tags", "OrigWords", "Occurrence", "TWLink"];

// Cell escape: TSV is line-oriented, so tab/newline in a cell would corrupt
// the row. unfoldingWord convention encodes real newlines inside a Note as
// the two-character literal "\n" (already how notes are stored in D1). A bare
// \r (no trailing \n) gets the same escape — it would otherwise pass through.
function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\r\n/g, "\n").replace(/\r/g, "\\n").replace(/\n/g, "\\n").replace(/\t/g, " ");
}

function tsvLine(cells: unknown[]): string {
  return cells.map(tsvCell).join("\t");
}

// uW TSV invariant: a Quote / OrigWords cell holding original-language
// (Hebrew or Greek) text must carry Occurrence >= 1. Occurrence 0/empty is
// only valid for Gateway-Language quotes or general notes. Upstream rows and
// in-app quote edits (a GL snippet rewritten to OL words) can leave occurrence
// null/0, which would ship invalid TSV to DCS. Coerce null/0 -> 1 when the
// quote is OL; an existing >= 1 (a real second-occurrence target) is left
// untouched. Mirrored in rows.ts (save path) — keep the two in sync.
// Original-language Unicode blocks: Hebrew (0590-05FF), Hebrew presentation
// forms (FB1D-FB4F), Greek and Coptic (0370-03FF), Greek Extended (1F00-1FFF).
function hasOrigLang(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x0590 && c <= 0x05ff) ||
      (c >= 0xfb1d && c <= 0xfb4f) ||
      (c >= 0x0370 && c <= 0x03ff) ||
      (c >= 0x1f00 && c <= 0x1fff)
    )
      return true;
  }
  return false;
}

function origLangOccurrence(quote: string | null, occurrence: number | null): number | null {
  if (quote && hasOrigLang(quote) && (occurrence == null || occurrence === 0)) return 1;
  return occurrence;
}

// TWL canonical ordering (normalizeWordText / buildUltSequenceMap /
// twlSortPosition / the per-verse sequencing) moved to twlCanonicalOrder.ts so
// the reimport post-pass shares the exact same ordering code path as this
// export. buildTwlTsv below consumes it via orderTwlRows.

export function buildTnTsv(rows: TnRow[]): string {
  const body = sortRowsByReference(rows).map((r) =>
    tsvLine([r.ref_raw, r.id, r.tags, r.support_reference, r.quote, origLangOccurrence(r.quote, r.occurrence), normalizeNoteText(r.note)]),
  );
  return [TN_HEADERS.join("\t"), ...body].join("\n") + "\n";
}

export function buildTqTsv(rows: TqRow[]): string {
  const body = sortRowsByReference(rows).map((r) =>
    tsvLine([r.ref_raw, r.id, r.tags, r.quote, origLangOccurrence(r.quote, r.occurrence), normalizeNoteText(r.question), normalizeNoteText(r.response)]),
  );
  return [TQ_HEADERS.join("\t"), ...body].join("\n") + "\n";
}

export interface TwlTsvResult {
  tsv: string;
  sortOrderUpdates: Array<{ id: string; sort_order: number }>;
}

export function buildTwlTsv(rows: TwlRow[], input?: UsfmInputs): TwlTsvResult {
  // Shared per-verse ordering (moved to twlCanonicalOrder.ts). Produces the
  // reference-ordered rows, each row's canonical index within its verse, and the
  // sort_order diff — the identical code path the reimport canonical post-pass
  // uses, so export and reimport agree on canonical order.
  const { referenceOrdered, versePositions, sortOrderUpdates } = orderTwlRows(
    rows,
    input?.verses ?? [],
    input?.twTitles ?? null,
    input?.lockedVerses ?? null,
  );

  const body = referenceOrdered
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((a, b) => {
      const sameVerse =
        a.row.chapter === b.row.chapter &&
        a.row.verse === b.row.verse;

      if (sameVerse) {
        const aPos = versePositions.get(a.row.id) ?? a.originalIndex;
        const bPos = versePositions.get(b.row.id) ?? b.originalIndex;

        if (aPos !== bPos) {
          return aPos - bPos;
        }
      }

      return a.originalIndex - b.originalIndex;
    })
    .map(({ row }) =>
      tsvLine([
        row.ref_raw,
        row.id,
        row.tags,
        row.orig_words,
        origLangOccurrence(row.orig_words, row.occurrence),
        row.tw_link,
      ]),
    );

  return {
    tsv: [TWL_HEADERS.join("\t"), ...body].join("\n") + "\n",
    sortOrderUpdates,
  };
}

// ── Export shrink guard (truncation backstop) ───────────────────────────────
// Refuse to commit a TSV render that would delete a large fraction of the rows
// currently on master. This is the second line of defense behind fetchText's
// completeness check: the twl_PSA incident shipped a D1 holding 4880 of 7776
// rows over master and silently deleted 2,896. Even if a partial load ever slips
// past the fetch guard, the export must not wipe most of a book off master
// without a human in the loop. A translator legitimately removing >5% of a
// book's rows in a single night is effectively unheard of, so the cost of a
// false positive (one skipped book + a banner alert to review) is negligible
// next to the catastrophe it prevents. Returns true = REFUSE to commit.
//   renderedRows — rows in the about-to-be-committed render (D1 live rows)
//   masterRows   — rows in the current master file (data rows, header excluded)
// Floors: ignore tiny books (>25 rows lost) and require >5% shrink so ordinary
// edits never trip it; PSA lost 2,896 of 7,776 (37%) and trips easily.
export function exportTsvShrinkRefused(renderedRows: number, masterRows: number): boolean {
  if (masterRows <= 0) return false; // nothing on master to protect
  const lost = masterRows - renderedRows;
  if (lost <= 25) return false; // small/no shrink (incl. growth) — fine
  return lost / masterRows > 0.05;
}

// ── Shrink attribution (which of master's rows we can account for) ──────────
// The guard above rightly refuses ANY render that would drop a large share of
// master's rows — but its alert used to unconditionally claim "this looks like
// an incomplete D1 load (truncated fetch), not a real deletion", which was
// wrong for 1CH TQ, where an ID-set diff against production proved all 62 of
// the missing rows carry HUMAN deletion tombstones in D1 (zero unexplained
// residual) — a real, deliberate cleanup of unhelpful genealogy questions,
// not truncation. parseTsvIds pulls master's row IDs out of its raw TSV body
// so the caller (checkTsvShrink) can split "missing" into "D1 deliberately
// removed" vs "D1 simply doesn't have", and judge only the latter half.
//
// Column index 1 is `ID` in all three TSV schemas (see TN_HEADERS/TQ_HEADERS/
// TWL_HEADERS above). Returns null — "unparseable" — when the header or any
// data row doesn't look like what we expect; the caller MUST fall back to the
// count-only guard in that case. Failing closed matters here: a body we can't
// parse must never be allowed to "explain" missing rows.
export function parseTsvIds(raw: string): string[] | null {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const header = lines[0].split("\t");
  if (header[1] !== "ID") return null;
  const ids: string[] = [];
  for (const line of lines.slice(1)) {
    const id = line.split("\t")[1]?.trim();
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

// Defect 5: a duplicated ID within master's own TSV means attribution can't
// tell which physical row owns that ID — collapsing to a Set (as
// attributeTsvShrink does for its own "how many distinct rows are missing"
// bookkeeping) silently treats N duplicate lines as one row, understating the
// real loss. This repo has real history of duplicate/colliding IDs (the ISA 48
// delete+duplicate incident; the digit-first row-id collision bug), so the
// caller (checkTsvShrink) must fail closed on any duplicate BEFORE attempting
// attribution, rather than let attributeTsvShrink's Set quietly dedupe them
// into an explainable loss. Pure so it can be tested directly.
export function countDuplicateMasterIds(masterIds: string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const id of masterIds) {
    if (seen.has(id)) duplicates++;
    else seen.add(id);
  }
  return duplicates;
}

// A removal entry's `source` counts as human-authored intent to remove the
// row. `null` is the in-app human delete (rows.ts:861-865) and trash
// (rows.ts:973-980) — both omit the column. `nightly_finalize` (index.ts:262)
// is machine-EXECUTED but human-AUTHORED: it's the nightly promotion of a
// human's trash to a deleted_at tombstone, so it counts too. Every other
// source is a machine decision (`dcs_reimport` — bookReimport.ts:1810,
// truncated-fetch reimport prune; `ai_pipeline` — pipelineImport.ts:695, AI
// auto-apply) and must NOT be credited.
//
// Deliberately NOT listed, though a human directed them: the one-off repair
// sources in prod's edit_log (`dedup_repair`, `data_repair_isa48`). A shrink
// that traces to one of those will still block, and a human clears it with the
// existing allowShrink override. That's the conservative side of the trade —
// this set only grows on evidence that a source is routinely human-authored,
// because every addition widens what can delete rows from master unattended.
export const HUMAN_INTENT_REMOVAL_SOURCES: ReadonlySet<string | null> = new Set<string | null>([
  null,
  "nightly_finalize",
]);

// Splits master's row loss into "explained" (D1's newest removal entry for
// the row is human-authored, per HUMAN_INTENT_REMOVAL_SOURCES) vs
// "unexplained" (D1 has no record of the row at all, or its newest removal
// entry is machine-authored) — the truncated-fetch signature, e.g. the
// twl_PSA clobber: 2,896 missing rows with zero tombstones.
//
// Three incidents this must resolve:
//   - 1CH TQ:  62 missing rows, all 62 human tombstones (source NULL), 0
//              unexplained — a real, deliberate cleanup. Must SHIP. (Stated as
//              the invariant, not absolute counts: both master and D1 keep
//              growing, so a "master N / render M" snapshot decays. Validated
//              against prod at 464 master / 402 live, where the 62/62/0 split
//              held exactly.)
//   - twl_PSA: master 7,776 / render 4,880 / 2,896 rows absent from D1
//              entirely, zero tombstones — truncated load. Must BLOCK.
//   - HAB (stale trash): a translator trashes a tn row (source NULL), then
//     untrashes it — the 'trash' edit_log entry stays forever, 'untrash' is a
//     separate entry and does not delete it. Weeks later a truncated-fetch
//     reimport prune tombstones the same row with source='dcs_reimport'. The
//     row is now both currently-removed AND has a human removal entry
//     somewhere in its history — crediting on "any historical human entry"
//     wrongly ships this. Keying on the NEWEST removal entry per row (via
//     `removals`, which the caller MUST pass ordered oldest -> newest so
//     last-write-wins) fixes it: newest is 'dcs_reimport' -> unexplained.
//     (The mirror case — trash(NULL) then nightly_finalize(delete) — has
//     newest 'nightly_finalize', which IS human intent, so it's explained.)
//
// Pure — the caller resolves `rowStates` / `removals` from D1, and
// `renderedIds` from the rendered TSV itself (parseTsvIds).
export function attributeTsvShrink(args: {
  masterIds: string[];
  // IDs parsed (via parseTsvIds) from the RENDERED TSV that is about to be
  // committed. This — not a second D1 read — is the authoritative answer to
  // "is this master row in what we're about to ship": the render is captured
  // once, at one point in time, by buildResource; a fresh D1 query taken
  // later (after the R2 put, contributor lookup, freshness fetch, master
  // fetch) is a DIFFERENT point in time and can disagree with what's actually
  // about to be shipped. Concretely: master holds {A,B}; the render includes
  // A because B was tombstoned by a human. Between render and a later D1
  // read, a translator restores B and deletes A. A re-query would see A
  // removed (credited, since a human entry exists) and B live (skipped) and
  // ship — deleting B, the very row the human just restored. Deriving
  // liveness from the render instead makes this race benign either
  // direction: a row restored after the render was captured is simply absent
  // from the render (and not removed in D1 either) → unexplained → blocks
  // (fail-safe, not silently wrong). A row deleted from D1 after the render
  // was captured is still present in the render → still treated as live →
  // shipping does not delete it (correct, since the render is what's actually
  // being committed).
  renderedIds: string[];
  // Every row for this book+kind, exactly as SELECTed from <kind>_rows. Used
  // ONLY to corroborate that a master row missing from the render was a
  // DELIBERATE removal (D1 currently holds it deleted/trashed) — never to
  // determine liveness; the render alone is the source of truth for that
  // (see `renderedIds` above).
  rowStates: Array<{ id: string; deleted_at: number | null; trashed_at?: number | null }>;
  // edit_log removal entries for this book+kind, action IN ('delete','trash').
  // `id` is edit_log's own autoincrement PK — attributeTsvShrink picks each
  // row_key's newest entry itself (by MAX id), so the caller's query order no
  // longer matters (Defect 6: deleting an `ORDER BY` used to be able to
  // silently break the HAB fix below with every test still green, because the
  // tests hand-built already-sorted arrays. The SQL still orders by id ASC —
  // harmless, and it keeps the intent legible — but correctness doesn't lean
  // on it anymore).
  removals: Array<{ row_key: string; source: string | null; id: number }>;
  resource: "tn" | "tq" | "twl";
}): { liveCount: number; missing: number; explained: number; unexplained: number } {
  const { masterIds, renderedIds, rowStates, removals, resource } = args;

  // The render is the sole source of "live" — see `renderedIds` doc above.
  const liveIds = new Set(renderedIds);
  const liveCount = liveIds.size;

  // Defect 1: a row may be credited only when D1 actually holds it in a
  // removed state right now — NOT merely because edit_log has some removal
  // entry for the id. An id absent from `rowStates` entirely is the twl_PSA
  // truncated-fetch signature ("D1 has no row at all"), and that is never
  // explainable by an audit entry: a translator can trash(NULL) a tn row and
  // then untrash it, leaving a permanent stale removal entry on a row that is
  // once again live (untrash is a separate action, not itself a removal
  // entry) — or a human delete+restore (rows.ts) leaves the same shape. If
  // that row's id later vanishes from D1 altogether via a truncated load, it
  // must still read as unexplained, whatever edit_log says about its past.
  const removedIds = new Set<string>();
  for (const row of rowStates) {
    const isRemoved = row.deleted_at != null || (resource === "tn" && row.trashed_at != null);
    if (isRemoved) removedIds.add(row.id);
  }

  // Last-write-wins over `removals`, keyed by each entry's own `id` (not
  // arrival order) so out-of-order input can't invert the HAB stale-trash
  // case.
  const newestRemoval = new Map<string, { source: string | null; id: number }>();
  for (const r of removals) {
    const cur = newestRemoval.get(r.row_key);
    if (!cur || r.id > cur.id) newestRemoval.set(r.row_key, { source: r.source, id: r.id });
  }

  const uniqueMasterIds = new Set(masterIds);
  let explained = 0;
  let unexplained = 0;
  for (const id of uniqueMasterIds) {
    if (liveIds.has(id)) continue;
    // Both conditions required: D1 must currently hold the row removed, AND
    // its newest removal entry must be human-authored. Either alone is not
    // enough — see the Defect 1 comment above.
    const newest = removedIds.has(id) ? newestRemoval.get(id) : undefined;
    const isHumanIntent = newest !== undefined && HUMAN_INTENT_REMOVAL_SOURCES.has(newest.source ?? null);
    if (isHumanIntent) explained++;
    else unexplained++;
  }
  return { liveCount, missing: explained + unexplained, explained, unexplained };
}

// Fix 4: maps a checkTsvShrink refusal `detail` string to the operator-facing
// explanation of what happened and what to do about it. Pulled out as a pure,
// exported function so every refusal kind checkTsvShrink can produce is
// unit-testable directly, rather than only reachable through
// recordShrinkSkipAlert's D1-touching caller (exportWorkflow.ts). The
// previous inline version's fallback branch asserted "Master's ID column
// couldn't be parsed" for ANY unrecognized detail shape — exactly the
// truncated-fetch misdiagnosis this file exists to fix, silently reopened for
// any future refusal kind added to checkTsvShrink without a matching branch
// here. The fallback below is neutral instead: it names the problem as
// "unrecognized" rather than inventing a specific (and possibly wrong) cause.
//
// Note: `render_ids_unreadable` / `render_inconsistent_*` (added alongside
// this function, see FIX 1/2) are deliberately checked for exact/prefix match
// BEFORE the `_ids_unreadable` substring check below — "render_ids_unreadable"
// itself contains the substring "_ids_unreadable", so the more specific check
// must run first or it would be misreported as a MASTER parse failure.
export function describeShrinkRefusal(
  detail: string,
  ctx: { renderedRows: number; masterRows: number | null; explained?: number; unexplained?: number },
): { signature: string; remedy: string } {
  const { masterRows, explained, unexplained } = ctx;
  const lost = masterRows != null ? masterRows - ctx.renderedRows : null;

  if (detail === "master_unreadable") {
    // Master couldn't be FETCHED at all — nothing was parsed, nothing was
    // compared. Distinct from "parsed but the ID column looked wrong".
    return {
      signature: `Master itself couldn't be fetched from DCS, so nothing could be compared at all.`,
      remedy: `Check DCS connectivity/rate limits, then re-export.`,
    };
  }
  if (detail === "render_ids_unreadable") {
    // FIX 2: deliberately NOT `shrink_`-prefixed, so allowShrink's override
    // gate (which only recognizes the `shrink_` prefix as overridable) can
    // never bypass this — same reasoning as `master_unreadable`: a human
    // authorizing "yes, I meant to delete those rows" cannot also be taken as
    // authorizing "and ship a render whose own ID column can't be parsed".
    return {
      signature: `Our own rendered TSV's ID column couldn't be parsed, so the render can't be checked against master at all.`,
      remedy: `Inspect the export snapshot for this book/resource for a malformed render, then re-export.`,
    };
  }
  if (detail.startsWith("render_inconsistent_")) {
    // FIX 2: also NOT `shrink_`-prefixed — an operator's shrink override
    // cannot speak to "our own render disagrees with its own row count",
    // which is a bug in the render, not a deletion needing sign-off.
    return {
      signature:
        `Our own rendered TSV's parsed row count disagrees with the row count captured earlier in the ` +
        `same export run — an inconsistency in OUR render, not a comparison against master.`,
      remedy: `Inspect the export snapshot for this book/resource before re-exporting; this points at a bug in the render itself.`,
    };
  }
  if (detail.includes("_master_duplicate_ids_")) {
    // Defect 5's fail-closed case: master's own ID column has duplicates.
    return {
      signature:
        `Master's file for this book/resource contains duplicate row IDs, so attribution can't tell ` +
        `which physical row owns which ID.`,
      remedy: `Find and resolve the duplicate IDs in master's file, then re-export.`,
    };
  }
  if (detail.includes("_ids_unreadable")) {
    // Master's IDs genuinely couldn't be parsed (bad header / blank ID cell).
    return {
      signature: `Master's ID column couldn't be parsed, so the loss couldn't be attributed.`,
      remedy: `Re-sync from master, verify the row count, then re-export.`,
    };
  }
  if (detail.includes("_unexplained_") && typeof unexplained === "number" && lost != null) {
    // IDs parsed and attribution ran: some (or all) of the loss traces to a
    // human deletion tombstone in D1, but `unexplained` residual remains.
    //
    // Gated on the DETAIL string, not just on `unexplained` being a number.
    // Keying only on the context would hand this attribution wording to any
    // future refusal kind that happens to carry counts, asserting a
    // truncated-load signature nobody measured — the same "state a cause you
    // didn't check" defect this whole function exists to remove. An
    // unrecognized detail must reach the neutral fallback below even when the
    // counts are present.
    const explainedNote =
      explained && explained > 0
        ? ` (${explained} of the ${lost} were human deletions in D1 and were credited)`
        : "";
    return {
      signature:
        `${unexplained} of the ${lost} missing rows aren't accounted for by any deliberate deletion in ` +
        `D1${explainedNote} — that's the truncated-load signature.`,
      remedy: `Re-sync from master, verify the row count, then re-export.`,
    };
  }
  // Unrecognized detail shape — neutral fallback, never guess a cause.
  return {
    signature: `Refusal reason not recognized (${detail}); inspect the export snapshot.`,
    remedy: `Inspect the export snapshot, then decide whether to re-export.`,
  };
}

// ── Export alignment-shrink guard (ULT/UST verse backstop) ───────────────────
// The TSV shrink guard above protects row counts; this protects \zaln word
// alignment on the scripture (verse) resources, where the row==line model
// doesn't apply. The motivating incident: a translator's one-word text edit
// collaterally flattened \zaln milestones on UNTOUCHED words (1CH 4:21,
// NUM 24:7/8/16/19/20/24), the regressed verse landed in D1, and the nightly
// export — which has no alignment check — committed the loss to en_ult master.
// The interactive guard (guardBlocksSave) now catches that at write time, but
// this is the export-path backstop for any aligned verse that is ALREADY
// regressed in D1 (e.g. it landed before the interactive guard existed, or via
// an ingress path the guard doesn't cover).
//
// This used to compare a coarse aligned-WORD COUNT and EXEMPT any verse whose
// plain text changed — which exactly skipped the incident verses (1CH 4:21
// "Lekah"→"Lecah" was a genuine text edit PLUS collateral \zaln loss on
// untouched words; the text-changed exemption let it ship). That was the same
// blind spot as the 6980fd72 `wordSequenceUnchanged` narrowing removed from the
// interactive guard. Now it runs the SAME analyzer the write-time guard uses —
// `analyzeAlignmentDelta` — per verse, so the export net and `guardBlocksSave`
// agree on what "collateral loss" means.
//
// REFUSE if any word present in BOTH master and render (matched by surface +
// occurrence via the LCS path) HAD a \zaln source and is now fully bare
// (`reason === "lost"`) — the flatten / collateral-loss signature — REGARDLESS
// of whether the verse's plain text also changed (that's the whole point). A
// re-pointed source on an otherwise-unchanged word (`reason === "changed_source"`)
// is the signature of a LEGITIMATE aligner-panel re-alignment, so it is NOT
// blocked (blocking it would over-correct, the inverse error); it's only logged.
//
// Calibration rationale: a false positive costs one skipped nightly export plus
// the existing "Benjamin fix this" alert (a human adjudicates and re-exports),
// while a false negative ships silent alignment loss to master. So this backstop
// errs toward flagging `lost`. Returns the list of offending verse refs
// (empty = safe to commit).
interface VerseAlignStat {
  alignedWords: number;
  verseObjects: unknown[];
}

function countAlignedWords(nodes: unknown[]): number {
  let count = 0;
  const walk = (list: unknown[], underZaln: boolean): void => {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const isZaln = o["type"] === "milestone" && o["tag"] === "zaln";
      const nowUnderZaln = underZaln || isZaln;
      if (underZaln && o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        count++;
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children, nowUnderZaln);
    }
  };
  walk(nodes, false);
  return count;
}

// Map every verse in a USFM blob to its aligned-word count + parsed verseObjects.
// Keyed "chapter:verse" (verse keys can be "front", "12-13" — kept verbatim).
// The verseObjects array is retained so the caller can re-run the SAME
// word-level analyzer the interactive guard uses (analyzeAlignmentDelta).
// Returns null on a PARSE FAILURE (distinct from a parsed-but-empty blob,
// which returns an empty Map). The caller must distinguish the two: an empty
// Map means "parsed, no verses to compare", but a null means "we can't trust
// this USFM at all" and must fail closed.
function verseAlignStats(usfmText: string): Map<string, VerseAlignStat> | null {
  const stats = new Map<string, VerseAlignStat>();
  let json: { chapters?: Record<string, Record<string, unknown>> };
  try {
    json = usfm.toJSON(usfmText);
  } catch {
    return null; // unparseable → signal failure so the caller can fail closed
  }
  const chapters = json.chapters ?? {};
  for (const chapterKey of Object.keys(chapters)) {
    const chapterObj = chapters[chapterKey] as Record<string, unknown>;
    for (const verseKey of Object.keys(chapterObj)) {
      if (verseKey === "front") continue; // chapter-front (\d titles) — not aligned verse body
      const verseObj = chapterObj[verseKey] as { verseObjects?: unknown[] };
      const vos = Array.isArray(verseObj?.verseObjects) ? verseObj.verseObjects : [];
      stats.set(`${chapterKey}:${verseKey}`, {
        alignedWords: countAlignedWords(vos),
        verseObjects: vos,
      });
    }
  }
  return stats;
}

export interface AlignmentShrinkResult {
  refused: boolean;
  // Each offending verse names the words that lost their \zaln source so the
  // alert is actionable (which word to re-align), not just a whole-verse aligned
  // count that reads oddly when a verse simultaneously loses one word's source
  // and gains another's (e.g. 3<3, or even 4>3).
  //
  // `sequenceUnchanged` mirrors analyzeAlignmentDelta's own discriminator
  // (index-matched comparison vs the LCS fallback) so the alert can tell
  // apart two very different situations that both surface as "lost words":
  // true collateral de-alignment on text nobody touched (sequence unchanged
  // — the JER 36:11 shape) vs. D1 and master holding two different revisions
  // of the verse, where the named "lost" words are coincidental surface
  // matches between unrelated sentences (sequence changed — the EZK 40
  // shape). This does NOT change the refusal decision above, only what the
  // alert says.
  offenders: Array<{ ref: string; lostWords: string[]; sequenceUnchanged: boolean }>;
}

// Compare a rendered ULT/UST USFM against the current master USFM. For each
// verse present in BOTH (added/removed verses are skipped — genuine content
// change, not collateral loss), run `analyzeAlignmentDelta(masterVos,
// renderedVos)` — the SAME analyzer the interactive write-time guard
// (guardBlocksSave) uses — and REFUSE (refused=true) if any unexpected loss has
// `reason === "lost"`: a word matched in both by surface + occurrence that HAD a
// \zaln source on master and is now fully bare in the render. That is the
// flatten / collateral-loss signature, and it fires REGARDLESS of whether the
// verse's plain text also changed (the incident verses were genuine text edits
// PLUS collateral loss — the old plain-text exemption skipped exactly them).
//
// `reason === "changed_source"` (a re-pointed source on an unchanged word) is
// the signature of a LEGITIMATE aligner-panel re-alignment, so it is NOT a
// refusal — blocking it would over-correct. Empty master (fresh book) has
// nothing aligned to lose. Each offender carries the de-aligned words' text
// (the `lost` losses) so the workflow alert can name which words to re-align
// instead of reporting an opaque whole-verse aligned count.
export function usfmAlignmentShrinkRefused(
  renderedUsfm: string,
  masterUsfm: string,
): AlignmentShrinkResult {
  const rendered = verseAlignStats(renderedUsfm);
  const master = verseAlignStats(masterUsfm);
  // An unparseable RENDER must never be treated as safe to ship: with no
  // comparison data every master verse would be skipped and the guard would
  // fail OPEN. A corrupt render is exactly the case we must refuse. Fail closed.
  if (rendered === null) {
    return { refused: true, offenders: [{ ref: "*", lostWords: ["unparseable_render"], sequenceUnchanged: true }] };
  }
  // An unparseable MASTER (but a parseable render) leaves us with no baseline to
  // compare against — lower risk (we can't prove loss), so we don't refuse on it,
  // but we must not crash. Treat as no comparison data.
  if (master === null) {
    return { refused: false, offenders: [] };
  }
  // The reachable fail-open: usfm.toJSON does NOT throw on a malformed USFM
  // *string* (only on non-string input), so an empty or garbled render surfaces
  // here as a zero-verse Map, not null. A render that parsed to ZERO verses
  // while master still HAS aligned verses is a render failure, not a legitimate
  // full deletion — and the per-verse "absent from render → skip" rule below
  // would otherwise wave it through (every master verse skipped → refused:false).
  // Fail closed. (A genuinely empty master — fresh book — has nothing to lose.)
  if (rendered.size === 0) {
    const masterHasAligned = [...master.values()].some((s) => s.alignedWords > 0);
    if (masterHasAligned) {
      return { refused: true, offenders: [{ ref: "*", lostWords: ["empty_render"], sequenceUnchanged: true }] };
    }
  }
  const offenders: AlignmentShrinkResult["offenders"] = [];
  for (const [ref, masterStat] of master) {
    if (masterStat.alignedWords === 0) continue; // nothing aligned on master to lose
    const renderedStat = rendered.get(ref);
    if (!renderedStat) continue; // verse removed entirely — content change, not our concern
    const delta = analyzeAlignmentDelta(
      { verseObjects: masterStat.verseObjects },
      { verseObjects: renderedStat.verseObjects },
    );
    // Only a fully-lost \zaln source on a word that still exists is collateral
    // loss. changed_source (re-pointing) is legitimate re-alignment — log, allow.
    const lostWords = delta.unexpectedLosses
      .filter((l) => l.reason === "lost")
      .map((l) => l.text);
    if (lostWords.length === 0) continue;
    offenders.push({ ref, lostWords, sequenceUnchanged: delta.wordSequenceUnchanged });
  }
  return { refused: offenders.length > 0, offenders };
}

// Pure classification of `usfmAlignmentShrinkRefused`'s offenders, extracted
// so the nightly alert's wording (exportWorkflow.ts's
// recordAlignmentShrinkSkipAlert) can be tested by the strip-types runner —
// exportWorkflow.ts itself isn't. Three cases the alert must word differently:
//
//   - "none": no offenders at all. Reached from checkUsfmAlignmentShrink's
//     `master_unreadable` path (a fetch failure, not a de-alignment) — with
//     no offenders, generic wording read as "0 verse(s) lost alignment...
//     re-align the affected verse(s)", describing a fetch failure as a
//     translator's mistake with the wrong remedy.
//   - "sentinel": the single `ref: "*"` synthetic offender that
//     usfmAlignmentShrinkRefused emits for `unparseable_render` / `empty_render`
//     — a corrupt or empty RENDER, i.e. a bug in OUR rendering, not anything a
//     translator did. Naming which sentinel it was lets the alert say so.
//   - "genuine": real per-verse offenders, split by `sequenceUnchanged` — the
//     existing collateral-de-alignment vs different-revision distinction.
export type AlignmentShrinkAlertClassification =
  | { kind: "none" }
  | { kind: "sentinel"; which: string }
  | {
      kind: "genuine";
      unchanged: AlignmentShrinkResult["offenders"];
      changed: AlignmentShrinkResult["offenders"];
    };

export function classifyAlignmentShrinkOffenders(
  offenders: AlignmentShrinkResult["offenders"],
): AlignmentShrinkAlertClassification {
  if (offenders.length === 0) return { kind: "none" };
  if (offenders.length === 1 && offenders[0].ref === "*") {
    return { kind: "sentinel", which: offenders[0].lostWords[0] ?? "unknown" };
  }
  return {
    kind: "genuine",
    unchanged: offenders.filter((o) => o.sequenceUnchanged),
    changed: offenders.filter((o) => !o.sequenceUnchanged),
  };
}

// ── USFM rebuilder ───────────────────────────────────────────────────────────

export interface UsfmInputs {
  book: string;
  bibleVersion: string;
  headers: unknown[] | null;   // usfm-js headers array, or null to synthesize
  verses: VerseRow[];
  // tw_link → TW article title, for canonical TWL headword anchoring (see
  // twlCanonicalOrder.ts). Only buildTwlTsv reads it; omitted/empty means
  // ordering falls back to its pre-headword behaviour.
  twTitles?: Map<string, string>;
  // Verses (keys `${chapter}:${verse}`) whose TWL order is manually locked
  // (twl_order_locks via twlOrderLocks.ts). Only buildTwlTsv reads it;
  // omitted/empty means every verse is canonically reordered as before.
  lockedVerses?: Set<string> | null;
}

// Mirror of `recomputeTargetOccurrences` in importParsers.ts (kept local to
// avoid a cross-module value import — export.ts is loaded by the node
// strip-types test runner, which can't resolve extensionless `.ts` imports;
// see import-book.mjs for the same mirror-with-pointer pattern). Renumbers
// target `\w` occurrence/occurrences from document position so a stale stored
// row never ships invalid USFM to DCS. Source `\zaln-s` milestone occurrence
// lives on the milestone, not on `\w`, so it is never touched. No-op on clean
// verses. Mutates `verseObjects` in place.
function recomputeTargetOccurrences(verseObjects: unknown[]): void {
  if (!Array.isArray(verseObjects)) return;
  const words: Array<Record<string, unknown>> = [];
  const collect = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        words.push(o);
      } else if (Array.isArray(o["children"])) {
        collect(o["children"] as unknown[]);
      }
    }
  };
  collect(verseObjects);
  const totals = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const running = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    const n = (running.get(key) ?? 0) + 1;
    running.set(key, n);
    w["occurrence"] = String(n);
    w["occurrences"] = String(totals.get(key) ?? 1);
  }
}

export function buildUsfm(input: UsfmInputs): string {
  // Group verses by chapter, parsing the stored JSON. Corrupt content fails
  // the export; a partial book is worse than no nightly snapshot.
  const chapters: Record<string, Record<string, unknown>> = {};
  for (const v of input.verses) {
    const parsed = parseVerseContentJson(v);
    // Emit valid occurrence numbering even when the stored row is stale.
    // Malformed target `\w` occurrence/occurrences (every "1", colliding
    // (text,occurrence) pairs) would otherwise ship invalid USFM to DCS for
    // any verse not yet re-saved through the self-healing write path. Recompute
    // from document position here so the exported snapshot is always correct;
    // no-op on clean verses, and source text (UHB/UGNT) is left untouched.
    const bv = input.bibleVersion.toUpperCase();
    if ((bv === "ULT" || bv === "UST") && parsed && typeof parsed === "object") {
      const vos = (parsed as { verseObjects?: unknown[] }).verseObjects;
      if (Array.isArray(vos)) recomputeTargetOccurrences(vos);
    }
    const ch = String(v.chapter);
    if (!chapters[ch]) chapters[ch] = {};
    // verse 0 stores the chapter-front pseudo-verse (e.g. `\d` Psalm
    // titles). usfm-js's emitter expects the literal key "front" there;
    // a numeric "0" key wouldn't be recognised and the content would
    // emit incorrectly. See importParsers.ts:extractVersesForRange.
    //
    // Multi-verse blocks (`\v 6-9 <combined>`) are stored as one row with
    // verse=6 and verse_end=9. Round-trip them by reconstructing the
    // hyphenated key — usfm-js.toUSFM emits the `-9` portion verbatim.
    const verseKey =
      v.verse === 0
        ? "front"
        : v.verse_end != null && v.verse_end > v.verse
          ? `${v.verse}-${v.verse_end}`
          : String(v.verse);
    chapters[ch][verseKey] = parsed;
  }

  const headers = input.headers ?? synthesizeHeaders(input.book, input.bibleVersion);
  // usfm-js wants { headers, chapters } where chapters is keyed by string and
  // each chapter's verses are keyed by string. We built it that way above.
  const usfmInput = { headers, chapters };
  const rendered = usfm.toUSFM(usfmInput as unknown as { chapters: Record<string, unknown> }, {
    forcedNewLines: true,
  });
  // usfm-js's line layout doesn't match DCS Check 8 (blank lines, own-line
  // markers, `\v` line breaks, `\ts*` repair). Reflow to the DCS convention so
  // the exported snapshot is valid by construction. Inert markers/whitespace
  // only — alignment is untouched. See usfmFormat.ts.
  return normalizeUsfmFormatting(rendered);
}

function synthesizeHeaders(book: string, bibleVersion: string): unknown[] {
  return [
    { tag: "id", content: `${book} ${bibleVersion} — bible-editor export` },
    { tag: "usfm", content: "3.0" },
    { tag: "ide", content: "UTF-8" },
    { tag: "h", content: book },
    { tag: "toc1", content: book },
    { tag: "toc2", content: book },
    { tag: "toc3", content: book.toLowerCase() },
    { tag: "mt1", content: book },
  ];
}

// ── Resource → repo + path conventions ───────────────────────────────────────
// unfoldingWord splits each resource into its own repo. The exporter assumes
// the same convention; if a deploy ever needs different repo names, the names
// can be overridden via env (see exportWorkflow.ts).

export interface ResourceTarget {
  repo: string;
  path: (book: string) => string;
  bibleVersion?: string;
}

export const RESOURCE_TARGETS: Record<Resource, ResourceTarget> = {
  tn:  { repo: "en_tn",  path: (b) => `tn_${b}.tsv` },
  tq:  { repo: "en_tq",  path: (b) => `tq_${b}.tsv` },
  twl: { repo: "en_twl", path: (b) => `twl_${b}.tsv` },
  ult: { repo: "en_ult", path: usfmFilename, bibleVersion: "ULT" },
  ust: { repo: "en_ust", path: usfmFilename, bibleVersion: "UST" },
};

// ── Gitea contents API ───────────────────────────────────────────────────────

export interface DcsCommitConfig {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface DcsCommitResult {
  contentSha: string;
  commitSha: string;
  changed: boolean;       // false when the file is already at this content
  // false when the rendered content already matches master and the export
  // branch was never created/reset/committed to. Untouched (book × resource)
  // pairs must not mint junk `-be-` branches — the service token can't
  // delete them. Callers skip prune/PR work when this is false.
  branchTouched: boolean;
}

// Encode a UTF-8 string as base64 (the Gitea contents API expects base64).
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Force the export branch to point at the repo's current master HEAD, creating
// it from master if it doesn't exist yet. This is what keeps the nightly PR
// mergeable: the export branch is always a *direct child of current master*, so
// the PR diff is exactly the rendered delta (the human edits) rather than a
// 3-way merge against a frozen merge-base. Without it the branch's base freezes
// the day it was cut and drifts into conflict as master moves underneath it.
//
// PATCH git/refs/{ref} uses `git update-ref` semantics (a `target` SHA, no force
// flag in the option — non-fast-forward moves are allowed), so resetting a
// diverged branch back onto master is a single call that PRESERVES any open PR.
// (delete+recreate would close the PR, so we don't do that.)
async function resetExportBranchToMaster(config: DcsCommitConfig): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `token ${config.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const repoBase = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;

  const masterRes = await fetch(`${repoBase}/git/refs/heads/master`, { method: "GET", headers });
  if (!masterRes.ok) {
    throw new Error(`dcs_master_ref_failed: ${masterRes.status} ${await masterRes.text()}`);
  }
  // An exact ref match may come back as a single object or a one-element array.
  const refData = (await masterRes.json()) as
    | { object?: { sha?: string } }
    | Array<{ object?: { sha?: string } }>;
  const masterSha = Array.isArray(refData) ? refData[0]?.object?.sha : refData.object?.sha;
  if (!masterSha) throw new Error("dcs_master_ref_missing_sha");

  // Try to reset the export branch ref onto master. Happy path; preserves any
  // open PR (delete+recreate would close it).
  const patchRes = await fetch(
    `${repoBase}/git/refs/heads/${encodeURIComponent(config.branch)}`,
    { method: "PATCH", headers, body: JSON.stringify({ target: masterSha }) },
  );
  if (patchRes.ok) {
    await ensureBranchVisible(repoBase, headers, config.branch);
    return;
  }
  // 404 → the branch doesn't exist yet: create it from master.
  if (patchRes.status === 404) {
    await createBranchFromMaster(repoBase, headers, config.branch);
    await ensureBranchVisible(repoBase, headers, config.branch);
    return;
  }
  // 409 / 422 → the ref already exists and Gitea rejected the update via this
  // path (observed: 409 "reference already exists"). The branch being PRESENT
  // is all the commit below needs; it re-bases onto master on a later run. We
  // must NOT throw here (throwing wedged every retry once the branch existed —
  // the ISA-be-* failure) and must NOT delete (that closes the open PR).
  // Confirm it exists, creating only in the contradictory case where the GET
  // reports it actually absent.
  if (patchRes.status === 409 || patchRes.status === 422) {
    if (!(await branchExists(repoBase, headers, config.branch))) {
      await createBranchFromMaster(repoBase, headers, config.branch);
    }
    await ensureBranchVisible(repoBase, headers, config.branch);
    return;
  }
  throw new Error(`dcs_branch_ensure_failed: ${patchRes.status} ${await patchRes.text()}`);
}

// POST a new branch off master. 409 = a concurrent run already created it
// (benign). Any other non-ok status is a real failure.
async function createBranchFromMaster(
  repoBase: string,
  headers: Record<string, string>,
  branch: string,
): Promise<void> {
  const createRes = await fetch(`${repoBase}/branches`, {
    method: "POST",
    headers,
    body: JSON.stringify({ new_branch_name: branch, old_branch_name: "master" }),
  });
  if (!createRes.ok && createRes.status !== 409) {
    throw new Error(`dcs_branch_create_failed: ${createRes.status} ${await createRes.text()}`);
  }
}

// GET /branches/:branch → true on 200, false on 404. Other statuses throw.
async function branchExists(
  repoBase: string,
  headers: Record<string, string>,
  branch: string,
): Promise<boolean> {
  const res = await fetch(`${repoBase}/branches/${encodeURIComponent(branch)}`, {
    method: "GET",
    headers,
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`dcs_branch_get_failed: ${res.status} ${await res.text()}`);
}

// Ensure the branch is a valid, visible branch before the commit. Gitea can be
// read-after-write inconsistent right after a create, so we poll. If it never
// appears but a dangling ref exists (the ref is present yet GET /branches
// 404s — a corrupt leftover from an earlier botched push, e.g. the original
// ISA-be failure), delete the ref, recreate the branch from master, and
// re-poll. Throw dcs_branch_not_visible only if it still can't be made usable:
// a failed step retries, which beats committing to nowhere.
async function ensureBranchVisible(
  repoBase: string,
  headers: Record<string, string>,
  branch: string,
): Promise<void> {
  if (await pollBranchVisible(repoBase, headers, branch)) return;
  if (await refExists(repoBase, headers, branch)) {
    await deleteDanglingRef(repoBase, headers, branch);
    await createBranchFromMaster(repoBase, headers, branch);
    if (await pollBranchVisible(repoBase, headers, branch)) return;
  }
  throw new Error(`dcs_branch_not_visible: ${branch}`);
}

async function pollBranchVisible(
  repoBase: string,
  headers: Record<string, string>,
  branch: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${repoBase}/branches/${encodeURIComponent(branch)}`, {
      method: "GET",
      headers,
    });
    if (res.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// True if refs/heads/:branch exists at the git level — including the corrupt
// case where the ref is present but it's not a valid (visible) branch.
async function refExists(
  repoBase: string,
  headers: Record<string, string>,
  branch: string,
): Promise<boolean> {
  const res = await fetch(`${repoBase}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "GET",
    headers,
  });
  return res.ok;
}

// Remove a dangling ref so a clean branch can be recreated from master. Try the
// git-refs API first (it can delete a ref that has no valid branch), then the
// branches API as a fallback. Best-effort: if both fail, the recreate will too
// and ensureBranchVisible throws.
async function deleteDanglingRef(
  repoBase: string,
  headers: Record<string, string>,
  branch: string,
): Promise<void> {
  const refDel = await fetch(`${repoBase}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "DELETE",
    headers,
  });
  if (refDel.ok || refDel.status === 404) return;
  await fetch(`${repoBase}/branches/${encodeURIComponent(branch)}`, {
    method: "DELETE",
    headers,
  });
}

// GET the file at a ref, returning its blob SHA and whitespace-stripped
// base64 content (Gitea wraps base64 lines). null = the file doesn't exist
// at that ref (404). Shared by the master pre-check and the branch lookup in
// commitToDcs so both use identical comparison semantics.
async function getDcsFileBase64(
  base: string,
  headers: Record<string, string>,
  ref: string,
): Promise<{ sha: string | null; base64: string | null } | null> {
  const res = await fetch(`${base}?ref=${encodeURIComponent(ref)}`, { method: "GET", headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`dcs_lookup_failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { sha?: string; content?: string; encoding?: string };
  return {
    sha: data.sha ?? null,
    base64:
      data.encoding === "base64" && typeof data.content === "string"
        ? data.content.replace(/\s+/g, "")
        : null,
  };
}

// PUT /api/v1/repos/:owner/:repo/contents/:path
// - First compare the rendered content against MASTER. A match means nothing
//   to export: return changed=false WITHOUT creating/resetting the branch —
//   untouched (book × resource) pairs used to mint junk `-be-` branches that
//   the token can't delete. opts.forceBranch skips this pre-check (used when
//   a lingering open PR needs its diff collapsed even though master matches).
// - When changed (or forced): reset the branch onto master, GET to discover
//   the existing SHA on the branch (404 = new file), no-op if the branch file
//   already matches, else PUT/POST.
// - Returns the new content SHA + the resulting commit SHA so the caller can
//   record both for traceability.
export async function commitToDcs(
  config: DcsCommitConfig,
  path: string,
  content: string,
  message: string,
  opts?: { forceBranch?: boolean },
): Promise<DcsCommitResult> {
  const headers: Record<string, string> = {
    Authorization: `token ${config.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const base = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  const contentBase64 = utf8ToBase64(content);
  if (!opts?.forceBranch) {
    const masterFile = await getDcsFileBase64(base, headers, "master");
    if (masterFile?.base64 != null && masterFile.base64 === contentBase64) {
      return { contentSha: masterFile.sha ?? "", commitSha: "", changed: false, branchTouched: false };
    }
  }

  // Re-base the export branch onto current master before reading/committing, so
  // the resulting PR is a clean child of master, not a stale 3-way merge.
  await resetExportBranchToMaster(config);

  // Lookup existing SHA for this path on this branch.
  const branchFile = await getDcsFileBase64(base, headers, config.branch);
  const existingSha = branchFile?.sha ?? null;
  const existingBase64 = branchFile?.base64 ?? null;

  // No-op when the branch file already matches (last night's commit, PR
  // still open). Saves a commit per nightly run.
  if (existingBase64 !== null && existingBase64 === contentBase64) {
    return { contentSha: existingSha ?? "", commitSha: "", changed: false, branchTouched: true };
  }

  const body: Record<string, unknown> = {
    message,
    branch: config.branch,
    content: contentBase64,
  };
  if (existingSha) body.sha = existingSha;

  // resetExportBranchToMaster ensured the branch exists and is visible
  // (idempotent across 200/404/409/422), so a commit failure here is a real
  // error rather than a missing or racing branch.
  const method = existingSha ? "PUT" : "POST";
  const res = await fetch(base, { method, headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`dcs_commit_failed: ${method} ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content?: { sha?: string };
    commit?: { sha?: string };
  };
  return {
    contentSha: data.content?.sha ?? "",
    commitSha: data.commit?.sha ?? "",
    changed: true,
    branchTouched: true,
  };
}

// Rebuild a drifted export branch as a fresh child of CURRENT master so its PR
// stops conflicting. This is the only mechanism that actually resets a branch's
// frozen merge-base on door43: `PATCH /git/refs` can't re-base an existing ref
// (fork existence-guard bug — see resetExportBranchToMaster) and the contents
// API only makes single-parent commits, so we delete + recreate. That needs
// branch-delete scope (the export's DCS_SERVICE_TOKEN 403s — pass an admin PAT
// in config.token). Deleting the head branch auto-CLOSES its open PR; the caller
// re-commits the rendered D1 file (forceBranch) and re-opens a fresh,
// conflict-free PR. The branch comes back as a direct child of master, so the
// new PR diff is exactly the D1 delta. Returns rebuilt=false WITHOUT throwing if
// the delete was forbidden (403) or otherwise failed, so the caller can fall
// back to alerting rather than failing the export step. See
// docs/export-rebase-fix.md.
export async function recreateExportBranchFromMaster(
  config: DcsCommitConfig,
): Promise<{ rebuilt: boolean; detail: string }> {
  const headers: Record<string, string> = {
    Authorization: `token ${config.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const repoBase = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;

  // Delete the diverged branch (needs branch-delete scope). 404 = already gone,
  // which is fine — we recreate it below either way. A 403 means the token can't
  // delete; surface it so the caller alerts instead of throwing.
  const del = await fetch(
    `${repoBase}/branches/${encodeURIComponent(config.branch)}`,
    { method: "DELETE", headers },
  );
  if (!del.ok && del.status !== 404 && del.status !== 204) {
    return { rebuilt: false, detail: `delete_${del.status}` };
  }

  // Recreate from master HEAD (createBranchFromMaster swallows a benign 409),
  // then poll until it's a visible branch the commit can target.
  await createBranchFromMaster(repoBase, headers, config.branch);
  await ensureBranchVisible(repoBase, headers, config.branch);
  return { rebuilt: true, detail: "rebuilt" };
}

// DELETE /api/v1/repos/:owner/:repo/branches/:branch
// Best-effort: returns true if the branch was deleted, false if it was already
// gone (404). Any other status throws so the caller can log it. Used by the
// export workflow to prune branches it superseded (a contributor-set change
// renames the branch) plus the legacy `live-snapshot` branch.
export async function deleteDcsBranch(
  config: Omit<DcsCommitConfig, "branch">,
  branch: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    Authorization: `token ${config.token}`,
    Accept: "application/json",
  };
  const url = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/branches/${encodeURIComponent(branch)}`;
  const res = await fetch(url, { method: "DELETE", headers });
  if (res.ok || res.status === 204) return true;
  if (res.status === 404) return false;
  throw new Error(`dcs_branch_delete_failed: ${res.status} ${await res.text()}`);
}

// Ensure an OPEN pull request exists from `branch` into `base` (default
// "master"). The DCS-side validate-and-merge workflow operates on `-be-` *PRs*
// (it merges the mergeable ones nightly), not on bare branches — so the export
// opens a PR for each branch it pushes, otherwise the branch sits there unmerged
// until someone makes one by hand.
//
// Idempotent: returns the existing open PR if there is one, creates it
// otherwise. HTTP 422 from the create is treated as a benign no-op — it means
// either "no commits between" (the branch matches master, nothing to merge) or
// a PR was opened by a racing run between our lookup and create. HTTP 409 is
// Gitea's "PR already exists" (ErrPullRequestAlreadyExists) and gets the same
// re-lookup treatment.
export interface DcsPrConfig {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;   // head
  base?: string;    // default "master"
}

export interface DcsPrResult {
  number: number | null;
  created: boolean;
  reason: "head_equals_base" | "existing" | "created" | "raced" | "no_diff";
}

function dcsPrHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Exact lookup: GET /repos/{owner}/{repo}/pulls/{base}/{head}. Fast path for
// the common case, but door43 has a confirmed quirk: this endpoint returns
// the OLDEST PR ever opened for a given base/head pair, regardless of state —
// not the open one. A branch that has had multiple PRs over its life (closed,
// reopened under a new PR, etc.) makes the exact lookup return a closed PR
// while a real open PR exists further back in history. Live evidence:
// DAN-be-justplainjane47 had 6 PRs (7347, 7351, 7357, 7365, 7375, 7382); the
// exact lookup returned #7347 (closed, oldest) while #7382 was open. When
// that happens, ensureDcsPr's create 409s/422s ("already exists"), the
// re-lookup hits the same stale result, and the export silently treats the
// branch as having no PR (never rebasing it, never running conflict
// recovery) with no alert ever written.
//
// So: use the exact lookup as the fast path, and only fall back to a paged
// scan of /pulls?state=open (matching on head ref) when the exact lookup
// 404s or returns a non-open PR. The paged scan is intentionally NOT the
// default path — it was the original approach and got replaced because DCS
// caps each page at 50, so an existing PR could fall off page 1 and the
// create would 409 every night; paging bounded to 20 pages (1000 open PRs,
// far beyond real usage) plus running it only as a fallback keeps that
// subrequest cost negligible.
export async function findDcsOpenPr(config: DcsPrConfig): Promise<number | null> {
  const base = config.base ?? "master";
  const apiBase = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const res = await fetch(
    `${apiBase}/pulls/${encodeURIComponent(base)}/${encodeURIComponent(config.branch)}`,
    { method: "GET", headers: dcsPrHeaders(config.token) },
  );
  if (res.ok) {
    const pr = (await res.json()) as { number?: number; state?: string };
    if (pr.state === "open" && typeof pr.number === "number") return pr.number;
  } else if (res.status !== 404) {
    throw new Error(`dcs_pull_lookup_failed: ${res.status} ${await res.text()}`);
  }

  // Fallback: paged scan of open PRs, matching on head ref, base ref, and
  // same-repo head (see below). Gitea clamps the requested `limit` to an
  // instance-configurable MaxResponseItems, so a page is NOT guaranteed to
  // come back with exactly `limit` items even when more pages remain —
  // measured against door43 2026-08-03: `?state=all&limit=10/50/100`
  // returned 10/50/100 respectively, i.e. its clamp is at least 100 today,
  // but we don't rely on that holding. Terminate only on a genuinely empty
  // page; `maxPages` is the real backstop against an unbounded loop.
  const limit = 50;
  const maxPages = 20;
  const sameRepo = `${config.owner}/${config.repo}`;
  for (let page = 1; page <= maxPages; page++) {
    const listRes = await fetch(
      `${apiBase}/pulls?state=open&limit=${limit}&page=${page}`,
      { method: "GET", headers: dcsPrHeaders(config.token) },
    );
    if (!listRes.ok) {
      throw new Error(`dcs_pull_list_failed: ${listRes.status} ${await listRes.text()}`);
    }
    let items: Array<{
      number?: number;
      state?: string;
      head?: { ref?: string; repo?: { full_name?: string } };
      base?: { ref?: string };
    }>;
    try {
      items = await listRes.json();
    } catch {
      throw new Error(`dcs_pull_list_failed: non_array_body (JSON parse error)`);
    }
    if (!Array.isArray(items)) {
      throw new Error(`dcs_pull_list_failed: non_array_body`);
    }
    // Same-repo guard: `?state=open` on this repo's /pulls endpoint also
    // returns PRs opened FROM forks, whose `head.ref` is the bare branch
    // name — the exact lookup could never do this (Gitea requires a
    // `user:branch` head for cross-repo PRs there), so this is a new
    // exposure introduced by the fallback. Without this guard, a
    // same-named branch in any contributor's fork would match and we'd
    // return a stranger's PR number, then run writes (close/update/rebase)
    // against it. A missing/undefined head.repo is NOT a match (fail closed).
    // Parity with the fast path above, which requires state === "open" before
    // trusting a number — not a demonstrated door43 defect, just matching the
    // same guard here since `?state=open` is a request filter, not a promise.
    const match = items.find(
      (pr) =>
        pr.state === "open" &&
        pr.head?.ref === config.branch &&
        pr.base?.ref === base &&
        pr.head?.repo?.full_name === sameRepo,
    );
    if (match && typeof match.number === "number") return match.number;
    if (items.length === 0) break;
  }
  return null;
}

export async function ensureDcsPr(
  config: DcsPrConfig,
  title: string,
  body: string,
): Promise<DcsPrResult> {
  const base = config.base ?? "master";
  if (config.branch === base) return { number: null, created: false, reason: "head_equals_base" };

  const apiBase = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;

  const existing = await findDcsOpenPr(config);
  if (existing != null) return { number: existing, created: false, reason: "existing" };

  const createRes = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers: dcsPrHeaders(config.token),
    body: JSON.stringify({ head: config.branch, base, title, body }),
  });
  if (createRes.ok) {
    const created = (await createRes.json()) as { number?: number };
    return { number: created.number ?? null, created: true, reason: "created" };
  }
  if (createRes.status === 422 || createRes.status === 409) {
    const raced = await findDcsOpenPr(config);
    return raced != null
      ? { number: raced, created: false, reason: "raced" }
      : { number: null, created: false, reason: "no_diff" };
  }
  throw new Error(`dcs_pull_create_failed: ${createRes.status} ${await createRes.text()}`);
}

// POST /repos/{owner}/{repo}/pulls/{index}/update — "merge base into head"
// (Gitea's update-branch button). Heals merge-base drift on long-lived export
// branches: door43's PATCH git/refs 409s whenever the ref exists (fork bug —
// UpdateGitRef carries CreateGitRef's existence guard un-negated), so
// resetExportBranchToMaster never actually re-bases an existing branch and
// its PR drifts to mergeable:False. Default style (merge); the route takes no
// body. Never throws on an HTTP status — expected non-fatal outcomes are 409
// (merge conflict) and 422 (PR merged/closed); callers log and move on.
export async function updateDcsPrBranch(
  config: Omit<DcsCommitConfig, "branch">,
  prNumber: number,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const url = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/pulls/${prNumber}/update`;
  const res = await fetch(url, { method: "POST", headers: dcsPrHeaders(config.token) });
  if (res.ok) return { ok: true, status: res.status, detail: "" };
  return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200) };
}

// PATCH /repos/{owner}/{repo}/pulls/{index} { state: "closed" } — close a PR the
// export opened once its head no longer diverges from master (rendered content
// matches master, so there is nothing to merge). The service token owns these
// PRs, so it can close them even though it can't delete the branch. Closing
// keeps the open-PR set equal to "books with unmerged edits" so empty (0-diff)
// PRs don't accumulate. Never throws on an HTTP status — 404 (already gone) and
// 422 are non-fatal; callers log and move on.
export async function closeDcsPr(
  config: Omit<DcsCommitConfig, "branch">,
  prNumber: number,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const url = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/pulls/${prNumber}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: dcsPrHeaders(config.token),
    body: JSON.stringify({ state: "closed" }),
  });
  if (res.ok) return { ok: true, status: res.status, detail: "" };
  return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200) };
}

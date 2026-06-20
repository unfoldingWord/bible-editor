// Pure builders for the nightly export, plus the Gitea commit primitive.
// No D1 or Workflow knowledge lives here — exportWorkflow.ts orchestrates,
// this module just turns rows into bytes and posts bytes to DCS.

import usfm from "usfm-js";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";
import { normalizeUsfmFormatting } from "./usfmFormat.ts";
import { normalizeNoteText, sortRowsByReference } from "./tsvFormat.ts";

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
// editor. With no human contributors the name collapses to `{BOOK}-be`.
//
// usernames are sanitized to the git ref-safe set (alphanumerics, dot, dash,
// underscore) so a stray character can't produce an unpushable branch. Our DCS
// usernames are already in that set; this is just belt-and-suspenders.
export function buildExportBranch(book: string, usernames: string[]): string {
  const safe = usernames
    .map((u) => u.replace(/[^A-Za-z0-9._-]/g, ""))
    .filter((u) => u.length > 0);
  return safe.length === 0 ? `${book}-be` : `${book}-be-${safe.join("-")}`;
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

export function buildTwlTsv(rows: TwlRow[]): string {
  const body = sortRowsByReference(rows).map((r) =>
    tsvLine([r.ref_raw, r.id, r.tags, r.orig_words, origLangOccurrence(r.orig_words, r.occurrence), r.tw_link]),
  );
  return [TWL_HEADERS.join("\t"), ...body].join("\n") + "\n";
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
  offenders: Array<{ ref: string; lostWords: string[] }>;
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
    return { refused: true, offenders: [{ ref: "*", lostWords: ["unparseable_render"] }] };
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
      return { refused: true, offenders: [{ ref: "*", lostWords: ["empty_render"] }] };
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
    offenders.push({ ref, lostWords });
  }
  return { refused: offenders.length > 0, offenders };
}

// ── USFM rebuilder ───────────────────────────────────────────────────────────

export interface UsfmInputs {
  book: string;
  bibleVersion: string;
  headers: unknown[] | null;   // usfm-js headers array, or null to synthesize
  verses: VerseRow[];
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

// Exact lookup: GET /repos/{owner}/{repo}/pulls/{base}/{head}. (Replaces
// paging /pulls?state=open — DCS caps the page at 50, so an existing PR could
// fall off page 1, after which the create 409s every night.) 404 = no PR for
// this base/head. A 200 can be a closed or merged PR — the endpoint doesn't
// filter by state — so only an "open" one counts.
export async function findDcsOpenPr(config: DcsPrConfig): Promise<number | null> {
  const base = config.base ?? "master";
  const apiBase = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const res = await fetch(
    `${apiBase}/pulls/${encodeURIComponent(base)}/${encodeURIComponent(config.branch)}`,
    { method: "GET", headers: dcsPrHeaders(config.token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`dcs_pull_lookup_failed: ${res.status} ${await res.text()}`);
  const pr = (await res.json()) as { number?: number; state?: string };
  return pr.state === "open" && typeof pr.number === "number" ? pr.number : null;
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

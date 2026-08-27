// ── File-level stale-base gate for the nightly Door43 → D1 verse sync (issue #639) ──
//
// THE INCIDENT. On 2026-08-26 a contributor merged a hand-revised `14-2CH.usfm`
// to `unfoldingWord/en_ult` master (`a1e8182a`, +9777/−9786 on one file). That
// file had been exported out of translationCore from a **Jul 08 2026** snapshot.
// Stephen Wunrow's Ketiv/Qere alignment fix had landed on master a month later
// (`81a00c44`, 2026-08-14, 19 verses), so the merge reverted all 19 of them —
// measured: 0 of 19 corrected lines survived, and the merged file's ketiv/qere
// marker counts matched the PRE-Stephen revision exactly.
//
// The nightly then adopted the revert into D1 with no conflict record and no
// banner, because those 19 rows are PRISTINE (`updated_by IS NULL`) — the large
// majority of the corpus — and the pristine branch of applyVerseRows adopts
// master unconditionally. It has no ancestor comparison and no lineage consult:
// "master differs" is read as "master advanced", and the distinction between
// ADVANCED and REGRESSED is never made. The following export would then have
// republished the revert to Door43 as ours.
//
// ── WHAT THIS GATE MEASURES, AND WHY IT IS THE `\id` LINE ────────────────────
//
// Issue #639 listed three candidate signals. Measured against the real corpus
// (git.door43.org, 2026-08-27) before picking one:
//
//   (a) "a single master commit rewriting a large fraction of the file's
//       verses". UNUSABLE with the machinery we have. The only per-verse
//       evidence in this codebase comes from parseDiffHunksForPath /
//       refsTouchedInUsfm (masterLineage.ts), fed by
//       `…/git/commits/{sha}.diff`, and dcsSources.ts caps that read at
//       MAX_COMMIT_DIFF_BYTES = 2,000,000. The incident commit's diff is
//       **4,268,456 bytes** (measured). So for exactly the shape this gate has
//       to catch, the ref evidence comes back incomplete and can prove nothing.
//       A wholesale replacement is precisely the case that blows the cap.
//
//   (b) "the incoming `\id` line's translationCore export timestamp older than
//       our stored synced_at". PRESENT AND PARSEABLE EVERYWHERE — surveyed all
//       133 USFM files across en_ult + en_ust: 133/133 carry a trailing `… tc`
//       stamp and 133/133 parse as a Date. But the comparison AS STATED fires
//       on essentially the whole corpus and cannot gate anything on its own:
//       the NEWEST tC stamp in either repo is 2026-06-02 (DAN), 88 of 133 are
//       from 2023 or earlier, and every `synced_at` is current — so "incoming
//       tC stamp < synced_at" is true for nearly every book, every night.
//
//   (c) "a changed-verse fraction threshold so ordinary multi-verse edits don't
//       trip it". Not needed once (b) is used in the conjoined form below, and
//       not cheaply measurable at the staging point anyway (D1's content is not
//       in hand there). See the conjunction's own false-positive analysis.
//
// The load-bearing fact the survey turns up is a SEMANTIC one, documented in
// scripts/restore-master-verses.mjs and confirmed against the incident: the
// `\id` tC stamp changes **only** when someone re-exports the whole book out of
// translationCore. A hand edit on Door43, a bp-assistant push, and our own
// `-be-` export all leave it exactly as it was. So:
//
//     the tC stamp CHANGED  ⟺  this window contains a whole-file tC re-export
//
// That is signal (a) — "a single commit rewrote the file" — measured directly,
// for free, out of bytes we already hold, with no diff to parse and no
// threshold to tune. Conjoined with (b) it becomes the whole gate:
//
//     HOLD  ⟺  a tC re-export landed  AND  the snapshot it came from predates
//              the state D1 last adopted from master
//
// Measured on the incident: previous revision `81a00c44` carries
// `Thu Oct 14 2021`, the reverting merge `a1e8182a` carries `Wed Jul 08 2026`,
// and `book_resource_syncs.synced_at` for (2CH, ult) was 2026-08-14. Changed,
// and older than synced_at → HOLD. Note the direction: the incoming stamp is
// five years NEWER than the previous one, so a previous-vs-incoming regression
// test would NOT have caught this. The reference point has to be OUR sync, not
// the file's own history.
//
// WHY `synced_at` IS THE RIGHT REFERENCE POINT. It is stamped only on a night
// where the file actually moved — runChunkedReimport's sync step iterates
// `changed`, and planAndStageBookResources skips a SHA-unchanged resource
// before any fetch. So it marks the moment we adopted `source_sha`, i.e. the
// newest master state D1 holds. A tC snapshot older than that cannot contain
// what we already have; everything between the snapshot and now is dropped.
//
// FALSE POSITIVES, WORKED THROUGH. The conjunction only fires on a tC
// re-export, so an ordinary multi-verse hand fix (Stephen's own 19-verse
// commit) never reaches it — the stamp is unchanged. The remaining case is a
// tC export taken on day 1 and pushed on day 3. If nothing landed on master in
// between we never synced, `synced_at` stays older than the snapshot, and the
// resource adopts. If something DID land we synced it, `synced_at` is newer
// than the snapshot — and that something is genuinely being reverted, so
// holding is the correct answer, not a false positive.
//
// FAILURE DIRECTIONS ARE DELIBERATELY ASYMMETRIC:
//   - Incoming stamp unparseable, previous revision unreadable, no `synced_at`,
//     or no usable previous SHA → NO HOLD. These are the every-night paths; a
//     transient Door43 hiccup must not stall every book. This is also exactly
//     the pre-existing behavior, so the gate can only ever subtract adoptions
//     it has positive evidence against.
//   - Both stamps measured and the conjunction holds → HOLD. Never inferred,
//     never assumed: two parsed timestamps and one stored integer.
//
// ── KNOWN LIMITS. Stated here because each one is a real hole, and a gate whose
// ── blind spots are undocumented gets trusted for more than it measures.
//
// 1. THE STAMP MEASURES WHEN translationCore WROTE THE FILE, NOT HOW OLD ITS
//    PROJECT DATA IS. Someone can open a months-stale tC project this morning,
//    hit export, and push: the stamp says today, `tc_export_current` fires, and
//    the replacement is adopted along with every revert it carries. This gate
//    cannot see that, because nothing in the file records the project's own
//    vintage. It catches the case where the STALENESS IS VISIBLE IN THE FILE,
//    which is the 2CH incident and, on the evidence, the common shape — not the
//    general class. Catching the general class needs per-verse ancestor
//    comparison (issue #639's option B), which this does not replace.
//
// 2. `synced_at` BIASES TOWARD HOLDING, and three writers move it:
//    recordResourceSync on an ordinary sync, recordWithheldSyncIfAbsent's
//    sentinel write, and the own-publish convergence path. All three only ever
//    move it FORWARD, and a later `synced_at` makes `incomingTcExportAt <
//    syncedAt` easier to satisfy — so every drift here pushes toward a false
//    HOLD, never toward a false adopt. That is the safe direction (a hold
//    refuses and alerts; it does not overwrite anything), but it is not free:
//    the cost of the bias is an operator being asked about a file that was
//    fine. Worth revisiting if refusals turn out to be noisy in practice.
//
// 3. REPEATED-SAME-STAMP BLIND SPOT AFTER A FORCE-RELEASE. The "changed"
//    conjunct compares against the revision D1 last synced from. Once an
//    operator force-releases a stale export, THAT export's stamp becomes the
//    stored baseline — so a second push of the same stale tC snapshot reads as
//    `tc_stamp_unchanged` and adopts silently. This is a deliberate consequence
//    of the override (the operator said this file is acceptable), but it means
//    the override is stickier than a one-time consent: it effectively blesses
//    that snapshot for as long as it keeps coming back.
//
// Pure (no D1, no network) so the whole decision is regression-testable without
// a Workflow context — same pattern as reimportSyncGate.ts and shrinkGuard.ts.
// The IO half (reading the previous revision's `\id` line) lives in
// evaluateStaleBaseReplacement below and does nothing but feed this function.
//
// NO UI READER YET. `stale_base_holds` is written and released by this feature
// and queried by nobody: the human-facing surface is the `reimport_stale_base:`
// banner plus the reimport summary counters. The table is there so a refusal is
// queryable after the banner is dismissed, and so a future admin view has
// something to read. Deliberate, not an oversight.

import type { Env } from "./index";
import { dcsRawUrl, fetchFirstLine } from "./dcsSources";

// A commit SHA is only safe to hand to Gitea's `?ref=` when it is the full
// 40 hex characters — a short SHA is silently ignored there and the endpoint
// serves master's tip instead, which here would compare the incoming file
// against ITSELF and report "stamp unchanged" for every stale-base merge.
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// bookReimport.ts's recordWithheldSyncIfAbsent writes this into
// `book_resource_syncs.source_sha` for a pair it withheld that had no row at
// all, so the export's freshness gate has something to refuse against. It is not
// a git ref and must never be handed to `?ref=`. Duplicated here rather than
// imported to keep this module free of a cycle back into bookReimport.ts —
// staleBaseGate is imported BY that file. Keep the two in sync.
const WITHHELD_SYNC_SENTINEL_SHA = "withheld";

// `\id 2CH EN_ULT en_English_ltr Wed Jul 08 2026 06:18:55 GMT-0400 (Eastern Daylight Time) tc`
//       ^book ^resource      ^lang  ^──────────────── the tC export stamp ─────────────────^
//
// Anchored on the trailing ` tc` marker translationCore writes. NO `m` flag and
// no whole-file scan: the match is run against the file's FIRST LINE ONLY (see
// firstLine below). USFM puts `\id` on line one by definition, and letting the
// pattern roam a multi-megabyte body means any `\id`-shaped line anywhere in the
// text — including one a contributor could introduce — decides whether a whole
// book gets adopted or refused. First line, or nothing.
//
// Mirrors scripts/restore-master-verses.mjs's extractTcContentDate, which is the
// only other reader of this stamp in the repo; kept as a separate copy rather
// than imported because that file is a CLI script with top-level side effects
// and cannot be pulled into Worker code.
const TC_ID_LINE_RE = /^\\id\s+\S+\s+\S+\s+\S+\s+(.+?)\s+tc\s*$/;

// The captured text must LOOK like translationCore's `toString()` output —
// `Wed Jul 08 2026 …` — before it is handed to `new Date()`.
//
// This guard exists because `new Date(string)` is not a parser, it is a
// heuristic, and it succeeds on things that are not dates at all. Measured
// against V8: `new Date("Text Mar 5")` yields 2001-03-05, `new Date("2001")`
// yields 2001-01-01, `new Date("Version 12")` yields 2012-01-01. Without this
// guard a `\id` line whose 4th field happens to end in ` tc` could hand the gate
// a year-2001 timestamp, which is older than every `synced_at` and would refuse
// the book.
const TC_STAMP_SHAPE_RE = /^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4}\b/;

// Plausibility window. translationCore did not produce these files before 2015
// (the oldest stamp in the whole en_ult + en_ust corpus is 2020-03-20), and a
// stamp from the future is a clock or parse artifact, not a real export. One
// day of slack absorbs timezone/skew at the upper edge. Anything outside is
// reported as implausible and treated as NOT MEASURED — which means adopt, the
// pre-existing behavior, never a refusal on a number we do not believe.
const TC_STAMP_MIN = Date.UTC(2015, 0, 1) / 1000;
const TC_STAMP_FUTURE_SLACK = 86400;

export type TcStampReason = "ok" | "no_id_line" | "unparseable_date" | "implausible_date";

export interface TcStampResult {
  /** Unix seconds, or null when nothing trustworthy was measured. */
  at: number | null;
  /** Why — so a null never reads as a bare "absent" in the nightly log. */
  reason: TcStampReason;
}

/**
 * The translationCore export stamp on a USFM file's `\id` line.
 *
 * Accepts either a whole file or a single line; either way ONLY the first line
 * is examined (leading BOM and blank lines skipped). Returns the reason
 * alongside the value so "no `\id` line", "the date did not parse", and "the
 * date parsed but is not believable" stay distinguishable in the logs — they
 * have the same effect on the gate but very different meanings for a human
 * debugging why a book did or did not hold.
 */
export function parseTcExportStamp(usfmText: string | null | undefined, now?: number): TcStampResult {
  if (!usfmText) return { at: null, reason: "no_id_line" };
  // Strip a UTF-8 BOM and any leading blank lines, then take one line. `\id` is
  // line one in USFM; anything past it is not the header.
  const head = usfmText.replace(/^﻿/, "").replace(/^[\r\n\s]*/, "");
  const nl = head.indexOf("\n");
  const firstLine = (nl === -1 ? head : head.slice(0, nl)).replace(/\r$/, "");
  const m = TC_ID_LINE_RE.exec(firstLine);
  if (!m) return { at: null, reason: "no_id_line" };
  const raw = m[1];
  if (!TC_STAMP_SHAPE_RE.test(raw)) return { at: null, reason: "unparseable_date" };
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return { at: null, reason: "unparseable_date" };
  const at = Math.floor(t / 1000);
  const ceiling = (now ?? Math.floor(Date.now() / 1000)) + TC_STAMP_FUTURE_SLACK;
  if (at < TC_STAMP_MIN || at > ceiling) return { at: null, reason: "implausible_date" };
  return { at, reason: "ok" };
}

export type StaleBaseReason =
  // ── the three real outcomes ────────────────────────────────────────────────
  | "stale_tc_reexport"
  | "tc_stamp_unchanged"
  | "tc_export_current"
  // ── "we could not measure", each named so a null is never a bare absence ───
  | "no_incoming_stamp"
  | "incoming_stamp_unparseable"
  | "incoming_stamp_implausible"
  | "no_previous_stamp"
  | "previous_stamp_unparseable"
  | "previous_stamp_implausible"
  | "no_synced_at"
  | "no_master_sha"
  | "no_previous_sha"
  // F11: the previous SHA is recordWithheldSyncIfAbsent's sentinel, not a real
  // revision — this pair is ALREADY withheld for some other reason, so there is
  // nothing to compare against and this gate is simply not the one deciding.
  // Distinct from `no_previous_sha` (never synced) on purpose: they look
  // identical in a counter and mean opposite things to whoever is debugging.
  | "previous_sha_withheld_sentinel";

export interface StaleBaseDecision {
  /** True → withhold: do not apply these verses and do not stamp the watermark. */
  hold: boolean;
  /**
   * Machine-readable outcome. Every non-hold reason names which measurement
   * was missing or which conjunct failed, so a log line can never say only
   * "no hold" — the same discipline as reimportSyncGate's absent-vs-zero rule.
   */
  reason: StaleBaseReason;
  incomingTcExportAt: number | null;
  previousTcExportAt: number | null;
  syncedAt: number | null;
}

/**
 * The gate itself. See the module header for the corpus evidence behind each
 * conjunct and for why the failure directions are asymmetric.
 */
export function decideStaleBaseReplacement(input: {
  incomingTcExportAt: number | null;
  previousTcExportAt: number | null;
  syncedAt: number | null;
}): StaleBaseDecision {
  const { incomingTcExportAt, previousTcExportAt, syncedAt } = input;
  const base = { incomingTcExportAt, previousTcExportAt, syncedAt };
  // Not measured is not evidence — and here "not measured" must resolve to the
  // pre-existing adopt, not to a hold, or one unreadable revision would stall
  // a book with no automatic release.
  if (incomingTcExportAt == null) return { hold: false, reason: "no_incoming_stamp", ...base };
  if (previousTcExportAt == null) return { hold: false, reason: "no_previous_stamp", ...base };
  if (syncedAt == null) return { hold: false, reason: "no_synced_at", ...base };
  // Conjunct 1 — signal (a), measured through the `\id` line rather than
  // through a diff we cannot afford to parse. An unchanged stamp means nobody
  // re-exported this book from translationCore, so whatever moved master is an
  // incremental edit on top of the current file and there is no base to be
  // stale.
  if (incomingTcExportAt === previousTcExportAt) return { hold: false, reason: "tc_stamp_unchanged", ...base };
  // Conjunct 2 — signal (b). A snapshot at or after the moment we last adopted
  // master already contains everything D1 holds, so the replacement drops
  // nothing.
  if (incomingTcExportAt >= syncedAt) return { hold: false, reason: "tc_export_current", ...base };
  return { hold: true, reason: "stale_tc_reexport", ...base };
}

/** What a held resource carries on its plan entry, and into the durable record. */
export interface StaleBaseHold {
  book: string;
  resource: string;
  masterSha: string;
  incomingTcExportAt: number;
  previousTcExportAt: number;
  syncedAt: number;
  previousSha: string;
}

/**
 * IO half: read the previous revision's `\id` line and run the pure decision.
 *
 * One extra Door43 subrequest per verse resource whose file actually moved
 * tonight — a ranged read of the first kilobyte, not the whole file, and only
 * for ult/ust (TSV has no `\id` line). The nightly's subrequest budget is tight
 * (see runChunkedReimport's chunking discipline and the nightly-sync cap
 * lesson), which is why this is a ranged read on an already-gated path rather
 * than a second full fetch or a per-verse query.
 *
 * `previousSha` is `book_resource_syncs.source_sha` — the exact revision D1 was
 * last synced from, which is the file state `syncedAt` certifies.
 */
export async function evaluateStaleBaseReplacement(
  env: Env,
  args: {
    book: string;
    resource: string;
    repo: string;
    path: string;
    /** Master's incoming bytes, already fetched and in memory at the staging point. */
    raw: string;
    masterSha: string | null;
    previousSha: string | null;
    syncedAt: number | null;
  },
): Promise<{ decision: StaleBaseDecision; hold: StaleBaseHold | null }> {
  const { book, resource, repo, path, raw, masterSha, previousSha, syncedAt } = args;
  const noHold = (
    reason: StaleBaseReason,
    incomingTcExportAt: number | null = null,
    previousTcExportAt: number | null = null,
  ): { decision: StaleBaseDecision; hold: null } => ({
    decision: { hold: false, reason, incomingTcExportAt, previousTcExportAt, syncedAt },
    hold: null,
  });

  const incoming = parseTcExportStamp(raw);
  // Each unavailable measurement gets its OWN reason rather than collapsing to
  // one "we didn't hold" — see StaleBaseReason. All of them mean adopt, which is
  // the pre-existing behavior, so this gate can only ever subtract adoptions it
  // has positive evidence against.
  if (incoming.at == null) {
    return noHold(
      incoming.reason === "implausible_date"
        ? "incoming_stamp_implausible"
        : incoming.reason === "unparseable_date"
          ? "incoming_stamp_unparseable"
          : "no_incoming_stamp",
    );
  }
  // Short-circuit before spending the subrequest: each of these fixes the answer
  // at "no hold", so reading the old revision cannot change it.
  if (masterSha == null) return noHold("no_master_sha", incoming.at);
  // F11. `withheld` is recordWithheldSyncIfAbsent's sentinel, never a revision.
  if (previousSha === WITHHELD_SYNC_SENTINEL_SHA) return noHold("previous_sha_withheld_sentinel", incoming.at);
  if (!previousSha || !FULL_SHA_RE.test(previousSha)) return noHold("no_previous_sha", incoming.at);
  if (syncedAt == null) return noHold("no_synced_at", incoming.at);

  const previousIdLine = await fetchFirstLine(dcsRawUrl(env, repo, path, previousSha));
  const previous = parseTcExportStamp(previousIdLine);
  if (previous.at == null) {
    return noHold(
      previous.reason === "implausible_date"
        ? "previous_stamp_implausible"
        : previous.reason === "unparseable_date"
          ? "previous_stamp_unparseable"
          : "no_previous_stamp",
      incoming.at,
    );
  }
  const decision = decideStaleBaseReplacement({
    incomingTcExportAt: incoming.at,
    previousTcExportAt: previous.at,
    syncedAt,
  });
  if (!decision.hold) return { decision, hold: null };
  return {
    decision,
    hold: {
      book,
      resource,
      masterSha,
      incomingTcExportAt: incoming.at,
      previousTcExportAt: previous.at,
      syncedAt,
      previousSha,
    },
  };
}

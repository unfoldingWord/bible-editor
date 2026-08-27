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
// Pure (no D1, no network) so the whole decision is regression-testable without
// a Workflow context — same pattern as reimportSyncGate.ts and shrinkGuard.ts.
// The IO half (reading the previous revision's `\id` line) lives in
// evaluateStaleBaseReplacement below and does nothing but feed this function.

import type { Env } from "./index";
import { dcsRawUrl, fetchFirstLine } from "./dcsSources";

// A commit SHA is only safe to hand to Gitea's `?ref=` when it is the full
// 40 hex characters — a short SHA is silently ignored there and the endpoint
// serves master's tip instead, which here would compare the incoming file
// against ITSELF and report "stamp unchanged" for every stale-base merge.
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// `\id 2CH EN_ULT en_English_ltr Wed Jul 08 2026 06:18:55 GMT-0400 (Eastern Daylight Time) tc`
//       ^book ^resource      ^lang  ^──────────────── the tC export stamp ─────────────────^
//
// Anchored on the trailing ` tc` marker translationCore writes, and applied to
// the FIRST line only (`m` flag plus a caller that passes one line) so a `\id`
// appearing anywhere else can't be mistaken for the header. Mirrors
// scripts/restore-master-verses.mjs's extractTcContentDate, which is the only
// other reader of this stamp in the repo; kept as a separate copy rather than
// imported because that file is a CLI script with top-level side effects and
// cannot be pulled into Worker code.
const TC_ID_LINE_RE = /^\\id\s+\S+\s+\S+\s+\S+\s+(.+?)\s+tc\s*$/m;

/**
 * The translationCore export stamp on a USFM file's `\id` line, in unix
 * seconds, or null when the line is absent or the date does not parse.
 * Accepts either a whole file or just its first line.
 */
export function parseTcExportStamp(usfmText: string | null | undefined): number | null {
  if (!usfmText) return null;
  const m = TC_ID_LINE_RE.exec(usfmText);
  if (!m) return null;
  const d = new Date(m[1]);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

export interface StaleBaseDecision {
  /** True → withhold: do not apply these verses and do not stamp the watermark. */
  hold: boolean;
  /**
   * Machine-readable outcome. Every non-hold reason names which measurement
   * was missing or which conjunct failed, so a log line can never say only
   * "no hold" — the same discipline as reimportSyncGate's absent-vs-zero rule.
   */
  reason:
    | "no_incoming_stamp"
    | "no_previous_stamp"
    | "no_synced_at"
    | "tc_stamp_unchanged"
    | "tc_export_current"
    | "stale_tc_reexport";
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
  const incomingTcExportAt = parseTcExportStamp(raw);
  // Short-circuit before spending the subrequest: with no incoming stamp, no
  // resolvable previous revision, or no watermark time, the decision is
  // already fixed at "no hold" and reading the old file cannot change it.
  if (incomingTcExportAt == null || masterSha == null || !previousSha || !FULL_SHA_RE.test(previousSha) || syncedAt == null) {
    const decision = decideStaleBaseReplacement({
      incomingTcExportAt,
      previousTcExportAt: null,
      syncedAt,
    });
    return { decision, hold: null };
  }
  const previousIdLine = await fetchFirstLine(dcsRawUrl(env, repo, path, previousSha));
  const previousTcExportAt = parseTcExportStamp(previousIdLine);
  const decision = decideStaleBaseReplacement({ incomingTcExportAt, previousTcExportAt, syncedAt });
  if (!decision.hold) return { decision, hold: null };
  return {
    decision,
    hold: {
      book,
      resource,
      masterSha,
      incomingTcExportAt,
      // Narrowed by decision.hold — the pure function cannot return hold with
      // either of these null.
      previousTcExportAt: previousTcExportAt as number,
      syncedAt,
      previousSha,
    },
  };
}

// Nightly export — Cloudflare Workflow.
//
// Each (book × resource) is its own step. step.do persists results, so a
// transient DCS rate-limit retries that one step instead of restarting the
// whole run. A failed step that exhausts retries fails *the instance*; the
// next cron tick (or a manual /api/exports/run) starts a fresh instance and
// the unaffected resources land normally.
//
// What it produces per (book, resource):
//   1. Renders the file (TSV or USFM) from D1.
//   2. Stores it under R2 at exports/<instanceId>/<book>/<filename> for
//      inspection and as a local-only backup.
//   3. If DCS_SERVICE_TOKEN is set, commits the file to the conventional
//      unfoldingWord repo on the configured branch.
//   4. Records the outcome in export_snapshots so /api/exports can list it.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";
import {
  ALL_RESOURCES,
  attributeTsvShrink,
  buildExportBranch,
  buildTnTsv,
  buildTqTsv,
  buildTwlTsv,
  buildUsfm,
  closeDcsPr,
  commitToDcs,
  countDuplicateMasterIds,
  deleteDcsBranch,
  describeShrinkRefusal,
  ensureDcsPr,
  exportTsvShrinkRefused,
  findDcsOpenPr,
  parseTsvIds,
  recreateExportBranchFromMaster,
  updateDcsPrBranch,
  usfmAlignmentShrinkRefused,
  buildAlignmentShrinkAlertMessage,
  buildUsfmInvalidAlertMessage,
  classifyAlignmentLossSeverity,
  offenderProvenanceFromLog,
  RESOURCE_TARGETS,
  usfmRevertReport,
  tsvRevertReport,
  shouldRecordRevertReport,
  classifyRevertSeverity,
  type AlignmentShrinkResult,
  type OffenderProvenance,
  type Resource,
  type UsfmRevertEntry,
  type TsvRevertEntry,
} from "./export";

// Banner target for export PR failures — same maintainer the post-export
// validator alerts (see postExport.ts ValidatorConfig.alertTargetUsername).
const EXPORT_ALERT_USERNAME = "deferredreward";

// Legacy export branch, superseded by per-(book,resource) contributor branches.
// Pruned best-effort on each export so it doesn't linger; safe to delete since
// the live-snapshot flow is no longer used (its post-export path is dormant).
const LEGACY_EXPORT_BRANCH = "live-snapshot";

// D1 statement-per-batch chunk size for recordExportReverts. Matches the
// WRITE_BATCH convention already used for bulk D1 writes in bookReimport.ts —
// a book's revert report (one row per differing verse/note row) can exceed a
// batch's safe statement count for a big book, where this feature matters most.
const REVERT_WRITE_BATCH = 90;
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply";
import { loadTwTitles } from "./twTitles";
import { loadTwlOrderLocks } from "./twlOrderLocks";
import { runPostExport, VALIDATORS } from "./postExport";
import { runChunkedReimport, storedResourceSha, ALL_RESOURCES as REIMPORT_RESOURCES } from "./bookReimport";
import { dcsRawUrl, dcsResourceFile, fetchText, fileCommitSha, type ReimportResource } from "./dcsSources";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { lintUsfmVerses } from "./lint";
import { hardRejectRows } from "./hardRejectGuard";
import { validateUsfm, summarizeUsfmIssues } from "./usfmValidate";
import type { UsfmValidationIssue } from "./usfmValidate";
import { shrinkOverrideAllowed } from "./shrinkGuard";

export interface ExportParams {
  // Restrict the run to one book. Useful for manual /api/exports/run.
  book?: string;
  // Restrict the run to one resource family.
  resource?: Resource;
  // Force-skip the DCS commit even if a service token is configured. Lets
  // us test the rendering pipeline against R2 without pushing anything live.
  dryDcs?: boolean;
  // Run the post-export validate-and-merge orchestrator (dispatches a Gitea
  // Actions workflow that auto-merges the live-snapshot PR on DCS). The
  // 05:30 UTC cron sets this true; manual /api/exports/run leaves it false
  // so a single-book test export doesn't accidentally trigger a real merge.
  validateAndMerge?: boolean;
  // Self-heal mode: run only the chunked DCS→D1 reimport for every book, then
  // stop before rendering/committing. Used by the 08:00 REIMPORT_CRON (which
  // has no WorkflowStep context of its own). Runs the reimport even without a
  // service token (reads public raw files) — unlike the pre-export sync, which
  // is gated on dcsAllowed.
  reimportOnly?: boolean;
  // Human override for the TSV shrink guard. The guard can't tell a truncated
  // D1 load from a translator deliberately deleting rows, so a legitimate bulk
  // deletion blocks the nightly forever (1CH tq: 55 rows deleted by hand on
  // 2026-07-24, guard reported shrink_55_of_426 as a "truncated fetch"). Only
  // honored for a single explicitly-named book AND resource — a run that omits
  // either (every cron path) can never disable the guard wholesale.
  allowShrink?: boolean;
}

export interface StepResult {
  book: string;
  resource: Resource;
  rowCount: number;
  bytes: number;
  r2Key: string | null;
  // The per-(book,resource) DCS branch this resource was committed to, named
  // for the book + its human contributors. null only when nothing was rendered.
  branch: string | null;
  dcsCommitSha: string | null;
  dcsChanged: boolean;
  dcsSkippedReason: string | null;
  // The open PR ensured for this branch (so the DCS validate-and-merge workflow
  // can act on it). null when nothing was pushed, the run was dry, or PR
  // creation failed (see prReason).
  prNumber: number | null;
  prReason: string | null;
}

const isResource = (s: string): s is Resource => (ALL_RESOURCES as string[]).includes(s);

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportParams> {
  async run(event: WorkflowEvent<ExportParams>, step: WorkflowStep): Promise<{
    instanceId: string;
    totalSteps: number;
    results: StepResult[];
  }> {
    const params = event.payload ?? {};
    const instanceId = `export-${new Date(event.timestamp).toISOString().replace(/[:.]/g, "-")}`;

    // 1. Resolve the books list.
    const books = await step.do("list-books", async () => {
      const stmt = params.book
        ? this.env.DB.prepare(`SELECT book FROM book_imports WHERE book = ?1 ORDER BY book`).bind(params.book)
        : this.env.DB.prepare(`SELECT book FROM book_imports ORDER BY book`);
      const rs = await stmt.all<{ book: string }>();
      return rs.results.map((r) => r.book);
    });

    const resources: Resource[] = params.resource && isResource(params.resource)
      ? [params.resource]
      : ALL_RESOURCES;

    const dcsAllowed = !params.dryDcs && !!this.env.DCS_SERVICE_TOKEN;

    // Shrink-guard override, deliberately narrow: only a run that names ONE book
    // and ONE resource can carry it. Every cron path omits both, so the nightly
    // keeps the guard no matter what params get passed. Both counts are the
    // RESOLVED lists (not the raw params) so an unrecognized book or resource —
    // which widens to every book / ALL_RESOURCES above — fails safe.
    const shrinkOverride = shrinkOverrideAllowed(params, books.length, resources.length);
    if (params.allowShrink === true && !shrinkOverride) {
      console.log("export: allowShrink ignored — requires an explicit single book + resource");
    }

    // 1b. Sync D1 from current master before rendering. Pulls out-of-band master
    //     edits (other tooling, manual USFM cleanup, the bp-assistant bot) into
    //     D1's *pristine* rows so the export doesn't silently revert them on the
    //     branch; translator-edited rows are skipped by the reimport's pristine
    //     predicate (see bookReimport.ts). Without this, Part 2's reset-onto-
    //     master would make the export look like it's reverting master's edits.
    //
    //     One step.do per book (retries that book alone on a flaky DCS fetch),
    //     wrapped in try/catch so a single book's failure can't abort the whole
    //     export instance — same shape as the post-export reimport loop. Gated
    //     on dcsAllowed: a dry run / no-token run shouldn't mutate D1.
    if (dcsAllowed || params.reimportOnly) {
      for (const book of books) {
        try {
          // Chunked + SHA-gated + diff-aware reimport — steps through chapters so
          // a large book can't blow the 10-min step limit, and skips files whose
          // DCS commit SHA is unchanged. See bookReimport.ts:runChunkedReimport.
          await runChunkedReimport(this.env, step, book, instanceId, [...REIMPORT_RESOURCES], {});
        } catch (e) {
          // Lock contention / transient DCS failure / Cloudflare subrequest cap:
          // this book's D1 is now possibly stale relative to master. The
          // freshness gate in exportOne (masterSha vs watermark) refuses to
          // commit a stale render, so a failed sync no longer reverts master —
          // it just skips this book's export until a later sync succeeds. Alert
          // so the failure is visible rather than silently swallowed.
          const msg = e instanceof Error ? e.message : String(e);
          console.error("export pre-reimport failed", { book, error: msg });
          try {
            await step.do(`reimport-fail-alert-${book}`, async () =>
              this.recordSyncFailureAlert(book, msg),
            );
          } catch {
            /* alert is best-effort; never let it abort the export run */
          }
        }
      }
    }

    // Self-heal mode (08:00 REIMPORT_CRON): D1 is now synced from DCS; there's
    // nothing to render or commit, so stop before the export steps below.
    if (params.reimportOnly) {
      return { instanceId, totalSteps: 0, results: [] };
    }

    // 2. One step per (book, resource). step.do persists, so a single flaky
    //    step retries without re-rendering the entire run.
    //
    //    Resource-major ordering: finish all books for one resource, then
    //    run the post-export validator (if one is configured) before moving
    //    on. Without this, a transient failure on TQ/TWL/ULT/UST would block
    //    TN validation from ever firing even after TN successfully pushed.
    const results: StepResult[] = [];
    for (const resource of resources) {
      for (const book of books) {
        const stepName = `export-${book}-${resource}`;
        try {
          const result = await step.do(
            stepName,
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
            async () => this.exportOne(book, resource, instanceId, dcsAllowed, shrinkOverride),
          );
          results.push(result);
        } catch (e) {
          // A single (book, resource) failure — most commonly a corrupt/dangling
          // DCS branch ref that ensureBranchVisible can't heal — must not abort
          // the whole instance and starve every other book (the resource-major
          // loop means one bad branch on the first book would otherwise block
          // all later books AND all later resources). Log, record the failure as
          // a snapshot for observability, and continue. Same isolation shape as
          // the pre-export reimport loop above.
          const reason = e instanceof Error ? e.message : String(e);
          console.error("export step failed", { book, resource, error: reason });
          try {
            await step.do(`${stepName}-record-fail`, async () =>
              this.recordSnapshot(book, resource, null, null, 0, `error:${reason.slice(0, 180)}`),
            );
          } catch {
            /* recording the failure is best-effort; never let it abort the run */
          }
          results.push({
            book,
            resource,
            rowCount: 0,
            bytes: 0,
            r2Key: null,
            branch: null,
            dcsCommitSha: null,
            dcsChanged: false,
            dcsSkippedReason: `error:${reason.slice(0, 180)}`,
            prNumber: null,
            prReason: null,
          });
        }
      }
      // Post-export validate-and-merge is opt-in via params.validateAndMerge.
      // The nightly cron sets it true; manual /api/exports/run defaults to
      // false so a one-off "render and push my single book" test doesn't
      // also kick off the auto-merge workflow on DCS.
      const validatorCfg = VALIDATORS.find((v) => v.resource === resource);
      if (validatorCfg && params.validateAndMerge === true) {
        await runPostExport(this.env, step, validatorCfg, dcsAllowed);
      }
    }

    // 3. Best-effort escalation of integrity issues the export can't auto-fix.
    //    Footnote (\f/\f*) imbalance is real data corruption a translator must
    //    resolve; surface it as an admin banner. Human-decision content issues
    //    (square brackets, Alternate-translation labels) are NOT nagged here —
    //    they're surfaced in-app via the per-book lint indicator
    //    (GET /api/books/:book/lint). Never aborts the run.
    try {
      await step.do("lint-escalate", async () => this.escalateIntegrityIssues(books));
    } catch (e) {
      console.error("export lint-escalate failed", { error: e instanceof Error ? e.message : String(e) });
    }

    return { instanceId, totalSteps: results.length, results };
  }

  // Lint each book's rendered scripture for footnote imbalance and raise/clear an
  // admin banner accordingly. Per-book source so a fixed book's alert clears on
  // the next run. Returns a small summary for step observability.
  private async escalateIntegrityIssues(books: string[]): Promise<{ flagged: string[] }> {
    const flagged: string[] = [];
    // Raise a per-book admin banner when `offenders` is non-empty, else clear any
    // stale undismissed alert for that source (the issue was fixed). One source
    // per issue category so they raise/clear independently.
    const raiseOrClear = async (source: string, offenders: string[], makeMsg: (n: number, sample: string) => string): Promise<boolean> => {
      if (offenders.length === 0) {
        await this.env.DB.prepare(
          `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
        )
          .bind(EXPORT_ALERT_USERNAME, source)
          .run();
        return false;
      }
      const more = offenders.length > 6 ? `, +${offenders.length - 6} more` : "";
      await this.writeAlert(source, makeMsg(offenders.length, offenders.slice(0, 6).join(", ") + more), `${this.env.DCS_BASE_URL}/unfoldingWord`);
      return true;
    };
    for (const book of books) {
      try {
        const footnoteOffenders: string[] = [];
        const gluedOffenders: string[] = [];
        for (const bv of ["ULT", "UST"]) {
          const rs = await this.env.DB.prepare(
            `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 ORDER BY chapter, verse`,
          )
            .bind(book, bv)
            .all<VerseRow>();
          for (const issue of lintUsfmVerses(rs.results ?? [])) {
            if (issue.bucket !== "escalate") continue;
            if (issue.check === "Glued alignment") gluedOffenders.push(`${bv} ${issue.ref}`);
            else footnoteOffenders.push(`${bv} ${issue.ref}`);
          }
        }
        const f = await raiseOrClear(
          `export_lint:${book}`,
          footnoteOffenders,
          (n, s) => `Benjamin — ${book}: ${n} footnote integrity issue(s) the export can't auto-fix (${s}). Fix the \\f/\\f* pairing in these verses.`,
        );
        const g = await raiseOrClear(
          `export_glued:${book}`,
          gluedOffenders,
          (n, s) => `Benjamin — ${book}: ${n} alignment milestone(s) with maqqef/minus-glued source words (${s}). An AI run glued two OL words into one token; open the verse in the aligner (it re-anchors off the UHB) and save, or run the backfill.`,
        );
        if (f || g) flagged.push(book);
      } catch (e) {
        console.error("escalateIntegrityIssues book failed", { book, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { flagged };
  }

  private async exportOne(
    book: string,
    resource: Resource,
    instanceId: string,
    dcsAllowed: boolean,
    allowShrink: boolean,
  ): Promise<StepResult> {
    // Clear any undismissed banner the removed blank-field HOLD gate left behind
    // (see the long note further down for why that gate is gone). Its text says
    // this export was BLOCKED and tells the operator to fix the rows and
    // re-export, which is no longer true and would mislead about why a book is
    // or is not on master.
    //
    // Deliberately FIRST, before every early return below. The books carrying
    // such a banner are exactly the ones withheld for many nights, which makes
    // them the likeliest to bail out early on a stale watermark, the shrink
    // guard, or no_rows — and a purely corrective delete has no dependency on
    // any of those outcomes. Also not gated on `dcsAllowed`: the banner is false
    // now regardless of whether anything pushes tonight.
    //
    // Best-effort, matching writeAlert's doctrine that an alert-write failure
    // must never fail the step. This runs for every tn/tq/twl book on every run,
    // so letting a cosmetic DELETE throw out of exportOne could withhold a book
    // from Door43 — precisely the failure this commit exists to remove.
    if (resource === "tn" || resource === "tq" || resource === "twl") {
      try {
        await this.env.DB.prepare(
          `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
        )
          .bind(EXPORT_ALERT_USERNAME, `export_blank:${book}:${resource}`)
          .run();
      } catch (err) {
        console.error(`export_blank banner clear failed for ${book} ${resource}:`, err);
      }
    }

    const built = await this.buildResource(book, resource);

    if (built.content === "") {
      await this.recordSnapshot(book, resource, null, null, built.rowCount, "no_rows");
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: 0,
        r2Key: null,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: "no_rows",
        prNumber: null,
        prReason: null,
      };
    }

    // Apply TWL sort order updates computed during export. Persist the sequence
    // so future operations use the optimal ordering from the ULT alignment.
    if (built.sortOrderUpdates.length > 0) {
      await this.applyTwlSortOrderUpdates(book, built.sortOrderUpdates);
    }

    // Book-specific branch named for this resource's human contributors.
    const contributors = await this.contributorsFor(book, resource);
    const branch = buildExportBranch(book, contributors);

    // R2 is the local-only backup. Writing here first means a failed DCS
    // commit still leaves a recoverable artifact.
    const target = RESOURCE_TARGETS[resource];
    const filename = target.path(book);
    const r2Key = `exports/${instanceId}/${book}/${resource}/${filename}`;
    await this.env.BLOBS.put(r2Key, built.content, {
      httpMetadata: { contentType: filename.endsWith(".usfm") ? "text/plain" : "text/tab-separated-values" },
    });

    let dcsCommitSha: string | null = null;
    let dcsChanged = false;
    let dcsSkippedReason: string | null = null;
    let prNumber: number | null = null;
    let prReason: string | null = null;
    let prError: string | null = null;

    // Freshness gate — the single guard against clobbering master. The export
    // renders from D1; if master moved past what D1 last synced (the
    // book_resource_syncs watermark), committing this render would REVERT
    // master's out-of-band edits (the exact LAM 2:17 regression: a gatewayEdit
    // alignment landed on master, the pre-export sync failed on the Cloudflare
    // subrequest cap, and the export silently reverted it). So unless we can
    // POSITIVELY confirm master == watermark, skip the commit and alert. Fail
    // CLOSED on uncertainty (can't fetch master SHA) — a one-night skip beats a
    // silent revert. A fresh book with no watermark has nothing to clobber.
    // Only meaningful when we'd actually commit (dcsAllowed); a dry run renders
    // to R2 only and can't clobber anything.
    const fresh = dcsAllowed ? await this.checkMasterFreshness(book, resource) : { ok: true as const, detail: "dry", masterSha: null, watermark: null };
    if (!fresh.ok) {
      await this.recordStaleSkipAlert(book, resource, fresh.masterSha, fresh.watermark);
      const reason = `stale_master:${fresh.detail}`;
      await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: built.content.length,
        r2Key,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: reason,
        prNumber: null,
        prReason: null,
      };
    }

    // Shrink guard — refuse to commit a TSV render that would delete a large
    // fraction of master's rows (truncation backstop; see exportTsvShrinkRefused).
    // Only when we'd actually commit (dcsAllowed) and only for TSV resources,
    // whose row==line model makes the count exact. This is what would have
    // stopped the twl_PSA clobber (4880 rows shipped over master's 7776).
    let tsvMasterContentForRevertReport: string | null = null;
    if (dcsAllowed && (resource === "tn" || resource === "tq" || resource === "twl")) {
      const guard = await this.checkTsvShrink(book, resource, built.rowCount, built.content);
      tsvMasterContentForRevertReport = guard.masterContent;
      if (!guard.ok && allowShrink && guard.detail.startsWith("shrink_")) {
        // Explicit human override for a verified-intentional deletion. Scoped to
        // a real shrink only — "master_unreadable" still fails closed, since an
        // unverifiable master is exactly the case the override can't speak to.
        // Same reasoning excludes "render_ids_unreadable" / "render_inconsistent_*"
        // (FIX 1/2): those mean OUR OWN render disagrees with itself, which a
        // human's "yes, delete those rows" override cannot possibly authorize —
        // so neither detail carries the `shrink_` prefix this gate checks for.
        console.log(
          `export: shrink guard OVERRIDDEN for ${book} ${resource} (${guard.detail}) by explicit allowShrink`,
        );
        // Clear the stale BLOCKED banner for this (book, resource) first. It is a
        // different alert source than the override notice below, so writeAlert's
        // same-source replace would leave it standing — and its text tells the
        // operator to "Re-sync from master, verify the row count, then
        // re-export", which for an intentional deletion would RESURRECT every
        // deleted row. Leaving a banner up that recommends the one destructive
        // wrong move is worse than leaving no banner. Mirrors the raise/clear
        // idiom in escalateIntegrityIssues.
        await this.env.DB.prepare(
          `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
        )
          .bind(EXPORT_ALERT_USERNAME, `export_shrink:${book}:${resource}`)
          .run();
        // Durable record of the bypass. A console.log lives only as long as a
        // `wrangler tail` session, and the whole point of the override is that a
        // human authorized a destructive push — that decision needs to outlive
        // the terminal it was typed in. severity "info": this is a notice, not a
        // problem, so it must not read as a failure in the alert banner.
        //
        // Worded for what is true HERE: the guard was cleared. The export can
        // still be stopped further down by the alignment-shrink backstop, USFM
        // validation, or a failed DCS commit, so this must not claim the push
        // happened — a durable record that lies about a destructive action is
        // worse than none.
        await this.writeAlert(
          `export_shrink_override:${book}:${resource}`,
          `${book} ${resource.toUpperCase()}: shrink guard bypassed by explicit request ` +
            `(${guard.detail}) — a render of ${built.rowCount} rows was allowed past master's ` +
            `${guard.masterRows ?? "?"}. A human confirmed the deletion was intentional. ` +
            `Check the export snapshot for whether the push itself then succeeded.`,
          `${this.env.DCS_BASE_URL}/unfoldingWord`,
          "info",
        );
      } else if (guard.ok && guard.detail.startsWith("shrink_")) {
        // Auto-credit path: checkTsvShrink's own unexplained===0 case ships
        // without any human in the loop (every missing row traced to a human
        // deletion tombstone in D1 — the 1CH TQ shape). Two gaps that mirror
        // the allowShrink branch above, both left open before this fix:
        //
        // Defect 2: neither branch of this if/else-if ran for this outcome
        // (guard.ok was true, so the `!guard.ok` arm never fired), which meant
        // a night that had previously BLOCKED (raising the
        // `export_shrink:{book}:{resource}` banner below) and later
        // auto-credits ships silently while that stale banner stays up
        // forever — its text tells the operator to "Re-sync from master,
        // verify the row count, then re-export", which for the now-shipped
        // deliberate deletion would RESURRECT every one of those rows. Clear
        // it, same as the allowShrink branch clears it for its own case.
        //
        // Defect 3: the allowShrink branch reasons that "a console.log lives
        // only as long as a wrangler tail session … that decision needs to
        // outlive the terminal it was typed in" and writes a durable alert
        // for its (human-authorized) bypass. This path is strictly less
        // supervised — no human authorized anything, a night's rows were
        // deleted on the strength of an automatic count-and-tombstone
        // check — yet it used to get only a console.log. Give it the same
        // durable, non-error (severity "info") record.
        await this.env.DB.prepare(
          `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
        )
          .bind(EXPORT_ALERT_USERNAME, `export_shrink:${book}:${resource}`)
          .run();
        // Worded for what is true HERE, same discipline as the allowShrink
        // alert: the guard was cleared. The export can still be stopped
        // further down by the alignment-shrink backstop, USFM validation, or a
        // failed DCS commit, so this must not claim the push happened.
        await this.writeAlert(
          `export_shrink_credited:${book}:${resource}`,
          `${book} ${resource.toUpperCase()}: shrink guard auto-credited ${guard.explained ?? "?"} human ` +
            `deletion(s) in D1 (${guard.detail}) — a render of ${built.rowCount} rows was allowed past ` +
            `master's ${guard.masterRows ?? "?"}, with 0 rows unexplained. No human reviewed this; ` +
            `check the export snapshot for whether the push itself then succeeded.`,
          `${this.env.DCS_BASE_URL}/unfoldingWord`,
          "info",
        );
      } else if (!guard.ok) {
        await this.recordShrinkSkipAlert(book, resource, built.rowCount, guard.masterRows, guard.detail, guard.explained, guard.unexplained);
        const reason = `shrink_guard:${guard.detail}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    // Export-revert report for tn/tq/twl is recorded further down, after
    // commitToDcs actually runs — see the comment there for why. (It used to
    // run right here, right after tsvMasterContentForRevertReport was
    // captured, on the false premise that reaching this line meant the
    // export would ship; the hard-reject guard below and the DCS commit
    // itself can still stop it. tsvMasterContentForRevertReport itself is
    // still captured above by checkTsvShrink — only the recording moved.)

    // There is deliberately NO blank required-field HOLD gate here any more.
    //
    // The `blank_field_guard` gate this replaces held an entire book+resource
    // whenever one row had a blank tn note / tq question-response / twl
    // OrigWords-TWLink, on the stated grounds that "DCS's whole-repo validator
    // rejects blank rows, so this render can't merge". That was asserted in five
    // places and never measured, and it is false. In DCS's live validators, all
    // five blank-field checks are raised at severity="warning":
    // `validate_tn_files.py` "Note column cannot be blank", `validate_tq_files.py`
    // Question/Response, `validate_twl_files.py` OrigWords/TWLink. All three
    // share an ErrorCollector whose `has_failures()` reads "Only hard errors
    // decide the exit code. Warnings are advisory: they are printed and
    // annotated, but must not stop a book from merging", and `emit_results`
    // returns `1 if failed else 0`. `merge-be-pr.yaml` then merges on
    // `workflow_run.conclusion == 'success'`, which follows that exit code.
    // Confirming it end to end: en_tn master carries 19 blank-Note rows right
    // now (2CH 5, ECC 8, JER 6) and its push validation is green.
    //
    // So the gate was blocking every other edit in JER/ECC/2CH from reaching
    // Door43 indefinitely to avoid a rejection that does not happen. A blank row
    // is still bad content, and it is still flagged in-app by the blank-field
    // lint (lint.ts) plus the save-path guards (rows.ts 422 blank_note,
    // NoteCard.flushPending) — those are the right place to catch it, before it
    // is ever written. Withholding a whole book afterwards is not.
    //
    // The stale `export_blank:*` banner the old gate left behind is cleared at
    // the top of exportOne, ahead of every early return.
    //
    // The Occurrence column no longer holds a book either, and for the same
    // reason one step further on: Occurrence is not editable anywhere in the UI.
    // Its checks really are hard errors (no `severity` kwarg in the validator
    // files, so they default to "error", fail the run, and the merge bot never
    // merges the PR) — but the alert told translators to "fix the Occurrence on
    // those rows", which they cannot do. Prod held all of DAN TWL on one row
    // (`xf8f`, Occurrence NULL) and all of JER TN on one more (`bfyt`), both
    // arrived-from-master defects. `renderOccurrence` (occurrenceRule.ts) now
    // heals the cell at render time to the one value each validator will accept,
    // so the render is legal by construction and the guard below finds nothing.
    //
    // The guard stays as a drift backstop: a hit here means the renderer and the
    // guard's transcription of the validators have diverged, which IS worth a
    // hold. Note what this shifts — the twl "add word" stub (blank
    // OrigWords/TWLink, NULL occurrence) used to be caught incidentally by its
    // Occurrence and will now ship. That is deliberate and consistent with the
    // paragraphs above: blank OrigWords/TWLink are severity="warning", they merge
    // fine, and lint.ts plus the save-path guards are where a blank row gets
    // caught. Prod carries 0 blank-OrigWords rows today.
    if (dcsAllowed && (resource === "tn" || resource === "twl")) {
      const rejects = hardRejectRows(resource, built.content);
      if (rejects.length > 0) {
        await this.recordHardRejectAlert(book, resource, rejects);
        const reason = `hard_reject_guard:${rejects.length}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    // Alignment-shrink backstop for the scripture (verse) resources. The TSV
    // shrink guard above protects row counts; this protects \zaln word
    // alignment. A verse that lost \zaln milestones on UNTOUCHED words (the
    // 1CH 4:21 / NUM 24 signature) has the same row count but fewer aligned
    // words — invisible to the TSV guard. The interactive guard now catches
    // this at write time, but a verse already regressed in D1 (landed before
    // the guard, or via an ingress path it doesn't cover) would still ship.
    // Conservative: only blocks a verse whose aligned-word count shrank while
    // its plain text is unchanged — a real text rewrite is always allowed.
    //
    // Detecting loss and REFUSING to ship are now separate decisions
    // (classifyAlignmentLossSeverity). A word or two left undragged is worth
    // knowing about, not worth withholding a translator's finished book from
    // Door43 — so that ships with a warning banner and the editor's existing
    // broken-link icon. Only bug-shaped loss (a flattened verse, a gutted
    // verse, systemic scale, a broken render, an unverifiable master) still
    // holds the book back.
    let usfmMasterContentForRevertReport: string | null = null;
    if (dcsAllowed && (resource === "ult" || resource === "ust")) {
      const guard = await this.checkUsfmAlignmentShrink(book, resource, built.content);
      usfmMasterContentForRevertReport = guard.masterContent;
      if (guard.ok && guard.detail === "ok") {
        // Checked this book+resource against master and found no alignment
        // loss — clear any stale rows a PAST export's loss left behind so the
        // app's sticky indicator goes away. `detail === "ok"` (not just
        // `guard.ok`) excludes "no_file" (the book has no ult/ust file at
        // all, so nothing was actually checked) from counting as clean.
        await this.clearAlignmentAttention(book, resource);
      }
      if (!guard.ok) {
        const severity = classifyAlignmentLossSeverity(guard.offenders ?? []);
        await this.recordAlignmentShrinkSkipAlert(
          book,
          resource,
          guard.detail,
          guard.offenders ?? [],
          severity.block,
        );
        if (!severity.block) {
          // A night where the guard found loss and shipped anyway should be
          // visible in the log, not only in a dismissible banner.
          console.log(
            `export: shipping ${book} ${resource} despite translator-scale alignment loss ` +
              `(${severity.reason}; ${guard.detail}) — alerted, not blocked`,
          );
        }
        if (severity.block) {
          const reason = `align_shrink_guard:${severity.reason}:${guard.detail}`;
          await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
          return {
            book,
            resource,
            rowCount: built.rowCount,
            bytes: built.content.length,
            r2Key,
            branch: null,
            dcsCommitSha: null,
            dcsChanged: false,
            dcsSkippedReason: reason,
            prNumber: null,
            prReason: null,
          };
        }
      }
    }

    // Export-revert report for ult/ust is recorded further down, after
    // commitToDcs actually runs — see the comment there for why. (It used to
    // run right here, on the false premise that reaching this line meant the
    // export would ship; the USFM validation HOLD gate immediately below, and
    // the DCS commit itself, can still stop it. usfmMasterContentForRevertReport
    // itself is still captured above by checkUsfmAlignmentShrink — only the
    // recording moved.)

    // USFM structural validation HOLD gate for the scripture resources. Ports
    // DCS's own validate_usfm_files.py Check 7 (consecutive paragraph markers)
    // and Check 8 (formatting) and runs them on the FINAL rendered USFM. This is
    // what would have caught the EZK 8/11 front-`\p` pump on OUR write path
    // instead of only after export via DCS CI. The collapse pass in
    // normalizeUsfmFormatting already auto-fixes the common case, so this is the
    // backstop: if a structural corruption our renderer can't self-heal slips
    // through, refuse to ship it to master rather than produce an unmergeable PR.
    // Same skip + alert + snapshot-reason shape as the guards above.
    if (dcsAllowed && (resource === "ult" || resource === "ust")) {
      const issues = validateUsfm(built.content);
      if (issues.length > 0) {
        const summary = summarizeUsfmIssues(issues);
        await this.recordUsfmInvalidSkipAlert(book, resource, issues);
        const reason = `usfm_invalid_guard:${issues.length}:${summary}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    if (!dcsAllowed) {
      dcsSkippedReason = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token";
    } else {
      const owner = this.env.DCS_EXPORT_OWNER ?? "unfoldingWord";
      const dcsCfg = {
        baseUrl: this.env.DCS_BASE_URL,
        token: this.env.DCS_SERVICE_TOKEN!,
        owner,
        repo: target.repo,
        branch,
      };
      const message = `bible-editor export: ${book} ${resource} → ${branch} (${instanceId})`;
      const commit = await commitToDcs(dcsCfg, filename, built.content, message);
      if (!commit.branchTouched) {
        // Rendered content matches master — nothing to merge. Close any open PR
        // lingering from an earlier night (an edit since reverted in D1, or
        // already merged to master) so empty (0-diff) PRs don't pile up and the
        // validate-and-merge job's worklist stays equal to "books with unmerged
        // edits". We can't delete the branch (the service token lacks
        // branch-delete), but closing the PR is enough; the branch gets a fresh
        // PR the next time this (book, resource) actually diverges from master.
        try {
          const lingering = await findDcsOpenPr(dcsCfg);
          if (lingering != null) await closeDcsPr(dcsCfg, lingering);
        } catch (e) {
          console.error("export close-stale-PR failed", {
            book, resource, repo: target.repo,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      dcsCommitSha = commit.commitSha || null;
      dcsChanged = commit.changed;

      // Export-revert report (observational only — see the "Export-revert
      // report" section in export.ts). Recorded HERE, immediately after the
      // commit itself, not near the shrink/alignment guards that captured
      // master's content earlier in this method: whether this export
      // actually overwrites anything on master is only knowable once
      // commitToDcs has run. The hard-reject guard, the alignment-shrink
      // backstop, and the USFM validation HOLD gate all sit between those
      // guards and here and can still return early with nothing committed —
      // recording used to happen right after the master content was
      // captured, so a book that failed validateUsfm still got an "overwrote
      // master" alert despite pushing nothing.
      //
      // Gated on `dcsChanged`, not merely on reaching this line: dcsChanged
      // is `commit.changed` from the commitToDcs call just above, true only
      // when THIS run pushed new content. A content match
      // (`branchTouched:false`) or a branch that already carried an earlier
      // run's identical commit (`branchTouched:true, changed:false`) means
      // nothing was freshly overwritten tonight — reporting either would be
      // false (nothing changed) or a duplicate of a night that already
      // recorded it. Still no second fetch: usfmMasterContentForRevertReport
      // / tsvMasterContentForRevertReport are the same raw content the
      // shrink/alignment guards captured earlier in this method.
      if (
        (resource === "ult" || resource === "ust") &&
        shouldRecordRevertReport(dcsChanged, usfmMasterContentForRevertReport)
      ) {
        const report = usfmRevertReport(built.content, usfmMasterContentForRevertReport as string);
        await this.recordExportRevertReport(book, resource, "usfm", report.entries);
      } else if (
        (resource === "tn" || resource === "tq" || resource === "twl") &&
        shouldRecordRevertReport(dcsChanged, tsvMasterContentForRevertReport)
      ) {
        const report = tsvRevertReport(
          built.content,
          tsvMasterContentForRevertReport as string,
          resource as "tn" | "tq" | "twl",
        );
        await this.recordExportRevertReport(book, resource, "tsv", report.entries);
      }

      if (!commit.branchTouched) {
        dcsSkippedReason = "unchanged";
      } else {
        // Prune branches this export superseded: any prior {book}-be-* branch for
        // this (book, resource) whose name changed because the contributor set
        // changed, plus the legacy live-snapshot branch. Best-effort — a prune
        // failure must never fail or retry the export step.
        await this.pruneSupersededBranches(book, resource, owner, target.repo, branch);

        // Ensure the branch has an open PR into master so the DCS validate-and-
        // merge workflow can act on it (it merges -be- PRs, not bare branches).
        // Best-effort: the commit already succeeded and the snapshot is recorded,
        // so a PR failure must not fail the export — the PR can be opened later.
        try {
          const pr = await ensureDcsPr(
            dcsCfg,
            `bible-editor: ${book} ${resource} → master`,
            `Auto-opened by the bible-editor nightly export so the DCS validate-and-merge workflow can process \`${branch}\`. Holds the latest ${resource.toUpperCase()} edits for ${book}.`,
          );
          prNumber = pr.number;
          prReason = pr.reason;
          if (pr.number != null) {
            // Merge master into the PR head ("update branch"). door43's PATCH
            // git/refs 409s on existing refs, so this is the only thing that
            // actually re-bases a long-lived branch; without it the PR drifts
            // to mergeable:False. Conflicts are expected sometimes — log, never
            // fail the step.
            try {
              const upd = await updateDcsPrBranch(
                { baseUrl: dcsCfg.baseUrl, token: dcsCfg.token, owner, repo: target.repo },
                pr.number,
              );
              if (!upd.ok) {
                console.log("export PR update-branch skipped", {
                  book, resource, repo: target.repo, pr: pr.number, status: upd.status, detail: upd.detail,
                });
                // 409 = genuine merge conflict: the branch drifted from master
                // (an out-of-band master edit to the same rows) and won't
                // auto-merge. D1 is authoritative, so rebuild the branch as a
                // clean child of CURRENT master carrying the SAME rendered file
                // and re-open the PR — diff becomes exactly the D1 delta, no
                // conflict. built.content already passed the freshness + shrink
                // gates above; we reuse it (never re-render). Gated on an admin
                // token; absent → just alert (today's drift behavior). See
                // docs/export-rebase-fix.md.
                if (upd.status === 409) {
                  const recovered = await this.recoverConflictedBranch(
                    book, resource, owner, target.repo, branch, dcsCfg, filename, built.content, message,
                  );
                  if (recovered) {
                    prNumber = recovered.prNumber;
                    prReason = recovered.prReason;
                    // Record the FRESH rebuilt commit, not the stale one from the
                    // (now deleted) conflicted branch — otherwise the snapshot's
                    // commit_sha is wrong and contributorsFor's `commit_sha IS
                    // NOT NULL` cutoff can't advance.
                    if (recovered.commitSha) dcsCommitSha = recovered.commitSha;
                  }
                }
              }
            } catch (e) {
              console.error("export PR update-branch failed", {
                book, resource, repo: target.repo, pr: pr.number,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        } catch (e) {
          prReason = "error";
          prError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          console.error("export ensure-PR failed", {
            book,
            resource,
            repo: target.repo,
            branch,
            error: prError,
          });
          await this.recordPrFailureAlert(book, resource, target.repo, branch, prError);
        }
      }
    }

    await this.recordSnapshot(book, resource, branch, dcsCommitSha, built.rowCount, dcsSkippedReason, prNumber, prError);

    return {
      book,
      resource,
      rowCount: built.rowCount,
      bytes: built.content.length,
      r2Key,
      branch,
      dcsCommitSha,
      dcsChanged,
      dcsSkippedReason,
      prNumber,
      prReason,
    };
  }

  private async buildResource(
    book: string,
    resource: Resource,
  ): Promise<{ content: string; rowCount: number; sortOrderUpdates: Array<{ id: string; sort_order: number }> }> {
    const db = this.env.DB;
    if (resource === "tn") {
      // trashed_at IS NULL excludes notes pending deletion. The nightly cron
      // promotes trash -> deleted_at before this Workflow's steps read, but
      // this guard also covers anything trashed mid-run (after finalize, before
      // this book's export step).
      const rs = await db
        .prepare(
          `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TnRow>();
      return { content: rs.results.length === 0 ? "" : buildTnTsv(rs.results), rowCount: rs.results.length, sortOrderUpdates: [] };
    }
    if (resource === "tq") {
      const rs = await db
        .prepare(
          `SELECT * FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TqRow>();
      return { content: rs.results.length === 0 ? "" : buildTqTsv(rs.results), rowCount: rs.results.length, sortOrderUpdates: [] };
    }
    if (resource === "twl") {
      const rs = await db
        .prepare(
          `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TwlRow>();
      const ultVerses = await db
        .prepare(
          `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2
           ORDER BY chapter, verse`,
        )
        .bind(book, "ULT")
        .all<VerseRow>();
      if (rs.results.length === 0) {
        return { content: "", rowCount: 0, sortOrderUpdates: [] };
      }
      // Independent reads; object-literal properties evaluate in order, so
      // awaiting them inline would serialize two D1 round-trips per book.
      const [twTitles, lockedVerses] = await Promise.all([
        loadTwTitles(db),
        loadTwlOrderLocks(db, book),
      ]);
      const result = buildTwlTsv(rs.results, {
        book,
        bibleVersion: "ULT",
        headers: null,
        verses: ultVerses.results,
        twTitles,
        lockedVerses,
      });
      return {
        content: result.tsv,
        rowCount: rs.results.length,
        sortOrderUpdates: result.sortOrderUpdates,
      };
    }
    // ult / ust
    const bibleVersion = resource.toUpperCase();
    const rs = await db
      .prepare(
        `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2
         ORDER BY chapter, verse`,
      )
      .bind(book, bibleVersion)
      .all<VerseRow>();
    if (rs.results.length === 0) return { content: "", rowCount: 0, sortOrderUpdates: [] };
    const headersRow = await db
      .prepare(`SELECT headers_json FROM book_usfm_meta WHERE book = ?1 AND bible_version = ?2`)
      .bind(book, bibleVersion)
      .first<{ headers_json: string }>();
    let headers: unknown[] | null = null;
    if (headersRow) {
      try {
        const parsed = JSON.parse(headersRow.headers_json);
        // `length > 0` matters: an EMPTY array is not nullish, so it would skip
        // buildUsfm's `?? synthesizeHeaders(...)` fallback and render a file with
        // no header block and therefore no blank line anywhere. DCS's Check 8
        // (and our port) skip every line until the first blank one, so that file
        // gets ZERO lines of structural validation while the gate still looks
        // alive because Check 7 keeps running — the same fail-open that the
        // synthesizeHeaders blank line closes. `extractUsfmHeaders` returns null
        // rather than [] so bookImport can't store one, but the seeding scripts
        // (scripts/import-book.mjs, scripts/reimport-ust-from-dcs.mjs) persist
        // `JSON.stringify(json.headers)` unfiltered, so [] is reachable.
        if (Array.isArray(parsed) && parsed.length > 0) headers = parsed;
      } catch {
        headers = null;
      }
    }
    return {
      content: buildUsfm({ book, bibleVersion, headers, verses: rs.results }),
      rowCount: rs.results.length,
      sortOrderUpdates: [],
    };
  }

  // Human contributors to one resource of one book, in first-edit order.
  // Drives the export branch name. `source IS NULL` excludes AI-pipeline edits
  // (the only non-null source today is 'ai_pipeline'; see migration 0010).
  //
  //   tn/tq/twl → edit_log.kind matches the resource directly.
  //   ult/ust   → kind='verse'; the bible version lives in the last segment of
  //               row_key ('{book}/{ch}/{v}/{VERSION}'), so match by suffix.
  private async contributorsFor(book: string, resource: Resource): Promise<string[]> {
    const isBible = resource === "ult" || resource === "ust";
    // Only include editors who touched this resource since the last successful
    // export (commit_sha IS NOT NULL). Using COALESCE(..., 0) means "include
    // all edits" when no successful export exists yet.
    const sql = isBible
      ? `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = 'verse' AND e.book = ?1 AND e.source IS NULL
            AND e.row_key LIKE ?2
            AND e.created_at > COALESCE(
              (SELECT committed_at FROM export_snapshots
                WHERE book = ?1 AND resource = ?3 AND commit_sha IS NOT NULL
                ORDER BY committed_at DESC LIMIT 1),
              0
            )
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`
      : `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = ?1 AND e.book = ?2 AND e.source IS NULL
            AND e.created_at > COALESCE(
              (SELECT committed_at FROM export_snapshots
                WHERE book = ?2 AND resource = ?1 AND commit_sha IS NOT NULL
                ORDER BY committed_at DESC LIMIT 1),
              0
            )
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`;
    const stmt = isBible
      ? this.env.DB.prepare(sql).bind(book, `${book}/%/${resource.toUpperCase()}`, resource)
      : this.env.DB.prepare(sql).bind(resource, book);
    const rs = await stmt.all<{ username: string; first_at: number }>();
    return rs.results.map((r) => r.username);
  }

  // Apply TWL sort order updates computed during export. Updates only rows in
  // verses where reordering happened, preserving the alignment-based sequence
  // in the database for future operations. This is idempotent: multiple calls
  // with the same updates produce the same result.
  private async applyTwlSortOrderUpdates(
    book: string,
    updates: Array<{ id: string; sort_order: number }>,
  ): Promise<void> {
    // Delegates to the shared helper (twlSortOrderApply.ts) so the export and the
    // reimport canonical post-pass write sort_order identically.
    await applyTwlSortOrderUpdates(this.env.DB, book, updates);
  }

  // Delete branches this export's branch replaces. Sources:
  //   1. export_snapshots history — any prior branch we recorded for this
  //      (book, resource) that differs from the current one (a contributor
  //      joined/left and the name changed).
  //   2. The legacy live-snapshot branch.
  // Best-effort: per-branch errors are logged and swallowed so a prune failure
  // never fails the export step (which would also retry the commit).
  private async pruneSupersededBranches(
    book: string,
    resource: Resource,
    owner: string,
    repo: string,
    keepBranch: string,
  ): Promise<void> {
    // Steady-state short-circuit: when the most recent snapshot already
    // recorded this same branch, any superseded branches were already pruned
    // (or 403ed — the service token lacks branch-delete) on a previous night.
    // Skipping stops the per-step DELETE calls that fail forever.
    try {
      const last = await this.env.DB.prepare(
        `SELECT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
        .bind(book, resource)
        .first<{ branch: string }>();
      if (last?.branch === keepBranch) return;
    } catch (e) {
      console.error("prune: last-snapshot query failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    }
    let stale: string[] = [];
    try {
      const rs = await this.env.DB.prepare(
        `SELECT DISTINCT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch IS NOT NULL AND branch <> ?3`,
      )
        .bind(book, resource, keepBranch)
        .all<{ branch: string }>();
      stale = rs.results.map((r) => r.branch);
    } catch (e) {
      console.error("prune: history query failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    }
    const targets = [...new Set([...stale, LEGACY_EXPORT_BRANCH])].filter((b) => b && b !== keepBranch);
    for (const b of targets) {
      try {
        await deleteDcsBranch(
          { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner, repo },
          b,
        );
      } catch (e) {
        console.error("prune: branch delete failed", { repo, branch: b, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // Recover a conflicted export PR (updateDcsPrBranch 409). D1 is authoritative,
  // so rebuild the drifted branch as a clean child of CURRENT master carrying
  // the same already-rendered file, then re-open the PR. Reuses `content`
  // (already past the freshness + shrink gates in exportOne — never re-renders),
  // so this can't smuggle a stale/partial render past those guards. Gated on the
  // admin token (DCS_TOKEN); without it we can't delete the branch, so we just
  // alert and leave the conflicted PR for a human (today's behavior). Best-effort
  // throughout: any failure alerts rather than failing the export step (the
  // commit + snapshot already succeeded). Returns the new PR info to record, or
  // null when nothing changed. See docs/export-rebase-fix.md.
  private async recoverConflictedBranch(
    book: string,
    resource: Resource,
    owner: string,
    repo: string,
    branch: string,
    dcsCfg: { baseUrl: string; token: string; owner: string; repo: string; branch: string },
    filename: string,
    content: string,
    message: string,
  ): Promise<{ prNumber: number | null; prReason: string; commitSha: string | null } | null> {
    const adminToken = this.env.DCS_TOKEN;
    if (!adminToken) {
      await this.recordPrConflictAlert(book, resource, repo, branch, "no_admin_token");
      return null;
    }
    try {
      const res = await recreateExportBranchFromMaster({
        baseUrl: dcsCfg.baseUrl,
        token: adminToken,
        owner,
        repo,
        branch,
      });
      if (!res.rebuilt) {
        await this.recordPrConflictAlert(book, resource, repo, branch, res.detail);
        return null;
      }
      // Branch is now master HEAD. Re-commit the rendered D1 file (forceBranch:
      // we know it differs from master — that's what conflicted) → one commit,
      // child of master. The delete auto-closed the old PR, so ensureDcsPr mints
      // a fresh one whose diff is exactly the D1 delta.
      const recommit = await commitToDcs(dcsCfg, filename, content, message, { forceBranch: true });
      const pr = await ensureDcsPr(
        dcsCfg,
        `bible-editor: ${book} ${resource} → master`,
        `Rebuilt by the bible-editor nightly export: \`${branch}\` had drifted into a merge ` +
          `conflict with master, so it was recreated as a clean child of current master carrying ` +
          `the authoritative D1 render of ${book} ${resource.toUpperCase()}. Any rows present only on ` +
          `master (not in D1) are intentionally dropped — D1 is authoritative.`,
      );
      await this.recordBranchRebuiltAlert(book, resource, repo, branch, pr.number);
      return { prNumber: pr.number, prReason: `rebuilt:${pr.reason}`, commitSha: recommit.commitSha || null };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("export conflict-recovery failed", { book, resource, repo, branch, error: detail });
      await this.recordPrConflictAlert(book, resource, repo, branch, detail.slice(0, 120));
      return null;
    }
  }

  private async recordSnapshot(
    book: string,
    resource: Resource,
    branch: string | null,
    commitSha: string | null,
    rowsExported: number,
    skippedReason: string | null,
    prNumber: number | null = null,
    prError: string | null = null,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO export_snapshots (book, resource, branch, commit_sha, rows_exported, error, pr_number, pr_error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(book, resource, branch, commitSha, rowsExported, skippedReason, prNumber, prError)
      .run();
  }

  // Is D1 for this (book, resource) current with master? Compares master's
  // latest file-commit SHA to the book_resource_syncs watermark (what the last
  // successful sync recorded). Returns ok only when we can POSITIVELY confirm
  // freshness:
  //   - no watermark        → fresh book, nothing on master to clobber → ok.
  //   - masterSha == wm      → D1 is current → ok.
  //   - masterSha != wm      → master moved past D1 → STALE → not ok.
  //   - masterSha null (fetch failed) but watermark present → can't confirm →
  //     not ok (fail closed; a skipped night beats a silent revert).
  // Mirror of planAndStageBookResources's SHA gate, used here to gate the
  // EXPORT rather than to skip the reimport.
  private async checkMasterFreshness(
    book: string,
    resource: Resource,
  ): Promise<{ ok: boolean; detail: string; masterSha: string | null; watermark: string | null }> {
    const file = dcsResourceFile(book, resource as ReimportResource);
    // Unknown book/resource → no file to compare; don't block (shouldn't happen
    // for the five real resources).
    if (!file) return { ok: true, detail: "no_file", masterSha: null, watermark: null };
    const watermark = await storedResourceSha(this.env, book, resource);
    if (!watermark) return { ok: true, detail: "no_watermark", masterSha: null, watermark: null };
    const masterSha = await fileCommitSha(this.env, file.repo, file.path);
    if (!masterSha) return { ok: false, detail: "master_sha_unknown", masterSha: null, watermark };
    if (masterSha === watermark) return { ok: true, detail: "current", masterSha, watermark };
    return { ok: false, detail: "master_ahead", masterSha, watermark };
  }

  // Banner alert when the freshness gate skips an export to avoid clobbering
  // master. Same replace-undismissed shape as recordPrFailureAlert.
  private async recordStaleSkipAlert(
    book: string,
    resource: Resource,
    masterSha: string | null,
    watermark: string | null,
  ): Promise<void> {
    const source = `export_stale:${book}:${resource}`;
    const message =
      `Benjamin — nightly export skipped ${book} ${resource.toUpperCase()} to avoid reverting master ` +
      `(D1 is behind: master ${(masterSha ?? "unknown").slice(0, 8)} vs synced ${(watermark ?? "none").slice(0, 8)}). ` +
      `The pre-export sync didn't catch up; re-run the sync for ${book}, then re-export.`;
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/unfoldingWord`);
  }

  // Fetch master's current TSV row count and decide whether this render would
  // shrink it dangerously (see export.ts exportTsvShrinkRefused). Fail closed
  // when master can't be read — a truncated master fetch now returns null from
  // fetchText too, so "unreadable" rightly blocks rather than letting an
  // unverified commit through.
  private async checkTsvShrink(
    book: string,
    resource: Resource,
    renderedRows: number,
    renderedContent: string,
  ): Promise<{
    ok: boolean;
    detail: string;
    masterRows: number | null;
    explained?: number;
    unexplained?: number;
    // Master's raw TSV, exactly as fetched above — carried out so the caller
    // (exportOne) can build the export-revert report (export.ts's
    // tsvRevertReport) WITHOUT a second fetch. null whenever master was never
    // actually read (no_file / master_unreadable).
    masterContent: string | null;
  }> {
    const file = dcsResourceFile(book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file", masterRows: null, masterContent: null };
    const raw = await fetchText(dcsRawUrl(this.env, file.repo, file.path));
    if (raw == null) return { ok: false, detail: "master_unreadable", masterRows: null, masterContent: null };
    // Data rows = non-empty lines minus the header (mirrors parseTsv's model).
    const masterRows = Math.max(0, raw.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
    if (!exportTsvShrinkRefused(renderedRows, masterRows)) {
      return { ok: true, detail: "ok", masterRows, masterContent: raw };
    }

    // Shrink path (rare): don't just refuse on the raw count — attribute the
    // loss. The 1CH TQ incident proved the old unconditional alert wrong:
    // every one of its 62 missing rows carried a HUMAN deletion tombstone in
    // D1 (zero unexplained residual) — a real cleanup of unhelpful genealogy
    // questions, not the twl_PSA truncated-fetch signature
    // (2,896 missing, no tombstones at all). Split "missing" into "D1
    // deliberately removed" (explained) vs "D1 simply doesn't have"
    // (unexplained) via attributeTsvShrink (export.ts).
    const lost = masterRows - renderedRows;
    const masterIds = parseTsvIds(raw);
    if (masterIds == null) {
      // Can't parse master's ID column — never let an unreadable body
      // "explain" a shrink. Fall back to the original count-only refusal.
      return { ok: false, detail: `shrink_${lost}_of_${masterRows}_ids_unreadable`, masterRows, masterContent: raw };
    }

    // Defect 5: fail closed on a master file that itself contains duplicate
    // row IDs (this repo has real history of it — the ISA 48 delete+duplicate
    // incident, the digit-first row-id collision bug). attributeTsvShrink's
    // own bookkeeping collapses masterIds to a Set, so a duplicated id would
    // otherwise be silently counted once — e.g. 464 lines / 402 unique ids,
    // all 402 live, reads as "62 missing, 0 unexplained" and ships, deleting
    // 62 lines unattended. If those duplicate lines carry DIFFERENT content
    // under a colliding id, that's a silent loss of real notes. Attribution
    // is only meaningful when master's IDs are unique in the first place, and
    // a duplicate-id master is itself a defect a human should look at — so
    // refuse before ever calling attributeTsvShrink. Keep the `shrink_` prefix
    // so the allowShrink override gate still recognizes this as a shrink.
    const dupCount = countDuplicateMasterIds(masterIds);
    if (dupCount > 0) {
      return {
        ok: false,
        detail: `shrink_${lost}_of_${masterRows}_master_duplicate_ids_${dupCount}`,
        masterRows,
        masterContent: raw,
      };
    }

    // FIX 1: attribute against the render's OWN ids, not a second D1 read.
    // built.rowCount was captured much earlier in exportOne (before the R2
    // put, contributor lookup, freshness fetch, and the master fetch above),
    // so a fresh D1 query here would be reading D1 at a DIFFERENT point in
    // time than the render — a race that can silently ship the wrong
    // decision (see attributeTsvShrink's `renderedIds` doc comment in
    // export.ts for the concrete scenario). The render itself is the
    // authoritative answer to "is this row in what we're about to commit",
    // so parse the render's ids directly instead.
    //
    // A disagreement here is an inconsistency in OUR OWN render, not a
    // shrink against master — refuse with a detail that deliberately does
    // NOT start with `shrink_` (see the call site in exportOne / FIX 2) so
    // the allowShrink override — which only speaks to "yes, this deletion
    // was intentional" — can never bypass a render that disagrees with
    // itself.
    const renderedIds = parseTsvIds(renderedContent);
    if (renderedIds == null) {
      return { ok: false, detail: "render_ids_unreadable", masterRows, masterContent: raw };
    }
    if (renderedIds.length !== renderedRows) {
      return {
        ok: false,
        detail: `render_inconsistent_${renderedIds.length}_vs_${renderedRows}`,
        masterRows,
        masterContent: raw,
      };
    }

    const table = resource === "tn" ? "tn_rows" : resource === "tq" ? "tq_rows" : "twl_rows";
    const selectTrashed = resource === "tn" ? ", trashed_at" : "";
    const stateRows = await this.env.DB.prepare(
      `SELECT id, deleted_at${selectTrashed} FROM ${table} WHERE book = ?1`,
    )
      .bind(book)
      .all<{ id: string; deleted_at: number | null; trashed_at?: number | null }>();

    // book = ?2 only — no `OR book IS NULL`. The 4-char row ids are unique
    // per book, not globally (migration 0015_composite_row_id.sql), so a
    // pre-0017 book-IS-NULL entry for a delete in one book could credit a
    // same-id row in a different book. This fails closed instead: an
    // uncredited pre-0017 entry just leaves that row unexplained, and
    // pre-0017 entries are purged anyway by the 180-day edit_log retention
    // sweep (index.ts:332-334).
    //
    // `id` (edit_log's own autoincrement PK) is selected so attributeTsvShrink
    // can pick each row_key's newest entry itself (Defect 6) — correctness no
    // longer depends on this query's ordering. ORDER BY id ASC is kept anyway
    // (harmless, and it keeps the intent legible).
    const removalsRs = await this.env.DB.prepare(
      `SELECT row_key, source, id FROM edit_log
        WHERE kind = ?1 AND book = ?2 AND action IN ('delete', 'trash')
        ORDER BY id ASC`,
    )
      .bind(resource, book)
      .all<{ row_key: string; source: string | null; id: number }>();

    const { explained, unexplained } = attributeTsvShrink({
      masterIds,
      renderedIds,
      rowStates: stateRows.results,
      removals: removalsRs.results,
      resource: resource as "tn" | "tq" | "twl",
    });

    // No separate "does this guard's D1 read agree with the render" check is
    // needed anymore: attributeTsvShrink derives liveCount directly from
    // `renderedIds`, which is already verified against `renderedRows` above.
    // The race the old cross-check existed for (a second, later D1 read
    // disagreeing with the render) is closed by construction — see
    // `renderedIds` in attributeTsvShrink's doc comment (export.ts).

    // Ship ONLY when unexplained === 0 — never re-judge exportTsvShrinkRefused
    // a second time here. We are already inside the branch where the count
    // guard refused, so gating on unexplained === 0 can only ever RELAX that
    // refusal, never newly block an export that ships today: "we can account
    // for every single missing row" is the only bar that justifies deleting
    // rows from master. (The old code re-judged
    // exportTsvShrinkRefused(masterRows - unexplained, masterRows), which
    // inherited the 25-row/5% floor onto unexplained rows and let up to 25
    // UNEXPLAINED rows — the truncation signature itself — ship silently.)
    if (unexplained === 0) {
      // A durable notice this run auto-credited deletions belongs in
      // wrangler tail, in the same spirit as the allowShrink override log
      // above — a night where the guard let a real shrink through should be
      // visible, even though nothing here needed a human.
      console.log(
        `export: shrink guard auto-credited ${explained} human deletion(s) for ${book} ${resource} ` +
          `(${lost} of ${masterRows} missing) — proceeding`,
      );
      return {
        ok: true,
        detail: `shrink_${lost}_of_${masterRows}_explained_${explained}`,
        masterRows,
        explained,
        unexplained,
        masterContent: raw,
      };
    }
    return {
      ok: false,
      detail: `shrink_${lost}_of_${masterRows}_unexplained_${unexplained}`,
      masterRows,
      explained,
      unexplained,
      masterContent: raw,
    };
  }

  // Fetch master's current USFM and decide whether this ULT/UST render would
  // silently drop \zaln word alignment (the 1CH 4:21 / NUM 24 signature; see
  // export.ts usfmAlignmentShrinkRefused). Fail closed when master can't be
  // read — a truncated master fetch returns null from fetchText, and an
  // unverifiable master must block rather than let an unchecked render through.
  private async checkUsfmAlignmentShrink(
    book: string,
    resource: Resource,
    renderedUsfm: string,
  ): Promise<{
    ok: boolean;
    detail: string;
    offenders?: AlignmentShrinkResult["offenders"];
    // Master's raw USFM, exactly as fetched above — carried out so the caller
    // (exportOne) can build the export-revert report (export.ts's
    // usfmRevertReport) WITHOUT a second fetch. null whenever master was
    // never actually read (no_file / master_unreadable).
    masterContent: string | null;
  }> {
    const file = dcsResourceFile(book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file", masterContent: null };
    const masterUsfm = await fetchText(dcsRawUrl(this.env, file.repo, file.path));
    if (masterUsfm == null) return { ok: false, detail: "master_unreadable", masterContent: null };
    const result = usfmAlignmentShrinkRefused(renderedUsfm, masterUsfm);
    if (result.refused) {
      const sample = result.offenders
        .slice(0, 5)
        .map((o) => {
          const shown = o.lostWords.slice(0, 3).map((w) => `"${w}"`).join(",");
          const extra = o.lostWords.length - 3;
          const more = extra > 0 ? ` (+${extra} more)` : "";
          return `${o.ref}: lost alignment on ${shown}${more}`;
        })
        .join("; ");
      return {
        ok: false,
        detail: `align_loss_${result.offenders.length}:${sample}`,
        offenders: result.offenders,
        masterContent: masterUsfm,
      };
    }
    return { ok: true, detail: "ok", masterContent: masterUsfm };
  }

  // Banner alert when the alignment-shrink backstop finds an ULT/UST verse that
  // lost \zaln alignment. Same replace-undismissed shape as
  // recordShrinkSkipAlert. `blocking` says whether the export was actually
  // withheld — translator-scale loss ships and gets a `warning` banner, so it
  // must not claim the book was blocked, and it must not shout `error` at
  // Benjamin for a word somebody forgot to drag.
  private async recordAlignmentShrinkSkipAlert(
    book: string,
    resource: Resource,
    detail: string,
    offenders: AlignmentShrinkResult["offenders"],
    blocking: boolean,
  ): Promise<void> {
    const source = `export_align_shrink:${book}:${resource}`;
    const label = `${book} ${resource.toUpperCase()}`;
    const provenance = await this.readOffenderProvenance(book, resource, offenders);
    // Every case that must NOT share generic "lost alignment, re-align it"
    // wording — fetch failure, our own broken render, collateral de-alignment,
    // out-of-sync D1 — is enumerated once, with its rationale, above
    // buildAlignmentShrinkAlertMessage in export.ts. None of it changes the
    // refusal decision above, only what the alert says.
    const message = buildAlignmentShrinkAlertMessage({
      label,
      book,
      resource,
      detail,
      offenders,
      provenance,
      blocking,
    });
    await this.writeAlert(
      source,
      message,
      `${this.env.DCS_BASE_URL}/unfoldingWord`,
      blocking ? "error" : "warning",
    );
    await this.recordAlignmentAttention(book, resource, offenders, provenance);
  }

  // Persist this export's alignment-shrink offenders so the app can render a
  // sticky per-book indicator that survives page reloads (system_alerts above
  // is dismissible and per-user; this isn't). Replace-all per (book,resource):
  // delete then re-insert, same pattern as writeAlert's undismissed-replace,
  // so a book that stops offending goes quiet the next time this fires. Best
  // effort — like writeAlert, a telemetry write must never fail or retry the
  // export, so this is try/catch + console.error, not awaited-critical.
  private async recordAlignmentAttention(
    book: string,
    resource: Resource,
    offenders: AlignmentShrinkResult["offenders"],
    provenance: Map<string, OffenderProvenance>,
  ): Promise<void> {
    // Drop the synthetic `ref: "*"` sentinels (export.ts's unparseable_render /
    // empty_render). They mean OUR OWN render was broken, so no verse was ever
    // compared against master — they are not per-verse evidence, they aren't
    // navigable, and the read endpoint filters them out anyway. Treating them
    // as a snapshot would replace real findings with a row nobody can act on,
    // which is the same erasure the empty-list guard below prevents.
    const perVerse = offenders.filter((o) => o.ref !== "*");
    // An EMPTY offender list here never means "measured and clean" — the clean
    // case is handled by clearAlignmentAttention on the `detail === "ok"` path.
    // It means the guard failed without per-verse detail (master_unreadable:
    // DCS wouldn't give us a readable master), so nothing was compared. Writing
    // the snapshot anyway would DELETE yesterday's real findings and insert
    // nothing, erasing known-broken verses on a night we learned nothing —
    // the export blocks, but the sticky indicator would go quiet, which is
    // exactly the "unmeasured outcome presented as evidence" failure this
    // file's alert wording was already fixed for. Keep the prior evidence.
    if (perVerse.length === 0) return;
    try {
      const statements = [
        this.env.DB.prepare(`DELETE FROM alignment_attention WHERE book = ?1 AND resource = ?2`).bind(
          book,
          resource,
        ),
        ...perVerse.map((o) =>
          this.env.DB.prepare(
            // OR REPLACE, not plain INSERT: the batch is one transaction, so a
            // single duplicate ref in `offenders` would violate the unique
            // index, roll the whole snapshot back, and leave the indicator
            // silently serving the PREVIOUS export's rows with nothing but a
            // console.error. A repeated ref should cost us that one row, not
            // the whole book's findings.
            `INSERT OR REPLACE INTO alignment_attention (book, resource, ref, lost_words, provenance)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          ).bind(book, resource, o.ref, JSON.stringify(o.lostWords), provenance.get(o.ref) ?? null),
        ),
      ];
      // Batched (not one .run() per offender) — this file has already hit
      // Cloudflare's ~1000-subrequest cap once (see the pre-export sync
      // comment above); a book with many offenders must not repeat that.
      await this.env.DB.batch(statements);
    } catch (e) {
      console.error("export alignment attention write failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Clear stale alignment_attention rows for a book+resource that was
  // re-checked against master and found clean. This is the only place rows
  // disappear outside of a fresh offender list replacing them — without it,
  // a translator who fixes every flagged verse would never see the sticky
  // indicator go away. Best-effort, same rationale as recordAlignmentAttention.
  private async clearAlignmentAttention(book: string, resource: Resource): Promise<void> {
    try {
      await this.env.DB.prepare(`DELETE FROM alignment_attention WHERE book = ?1 AND resource = ?2`)
        .bind(book, resource)
        .run();
    } catch (e) {
      console.error("export alignment attention clear failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Persist this export's "we overwrote something on master" findings
  // (export.ts's usfmRevertReport / tsvRevertReport) so a maintainer's
  // hand-edit that our render just superseded is visible without waiting for
  // a complaint (see PR #417). Replace-all per (book,resource): DELETE first,
  // then re-insert in REVERT_WRITE_BATCH-sized chunks (same convention as
  // bookReimport.ts's WRITE_BATCH). Called ONLY when there is at least one
  // entry to record — an empty list here never means "measured and clean"
  // (that's clearExportReverts's job on the genuinely-zero-diff path); see
  // recordAlignmentAttention's own comment for why an empty-list write would
  // erase real prior findings.
  //
  // Returns whether the table now reflects `entries` in full, so the caller
  // can decide what the operator-facing alert is allowed to claim. This used
  // to be one `this.env.DB.batch([DELETE, ...INSERTs])` call — one statement
  // per entry plus the DELETE, all in a single transaction — which is exactly
  // what the comment above the old INSERT (this file's OR-REPLACE-avoids-
  // rollback idiom) assumed: one atomic unit, so any oversized report would
  // throw and the `catch` below would silently log it while the alert still
  // told the operator the report was recorded. There is no single-transaction
  // way to keep that atomicity AND stay under D1's per-batch statement cap, so
  // this now chunks: the DELETE runs alone first (it must land before any
  // INSERT — a stale delete-less write would leave last night's rows mixed
  // with tonight's), then each chunk of inserts is its own `.batch()` call. A
  // chunk failing partway leaves the table holding only the entries from
  // chunks that already committed — a real partial write, not a silently
  // truncated one, because the caller is told `false` and must say so.
  private async recordExportReverts(
    book: string,
    resource: Resource,
    entries: Array<UsfmRevertEntry | TsvRevertEntry>,
  ): Promise<boolean> {
    if (entries.length === 0) return true;
    try {
      await this.env.DB.prepare(`DELETE FROM export_reverts WHERE book = ?1 AND resource = ?2`)
        .bind(book, resource)
        .run();
    } catch (e) {
      console.error("export revert report delete failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
      // Old rows (if any) are left standing — stale, but not silently wrong:
      // the caller must not claim this run's findings were recorded.
      return false;
    }
    for (let i = 0; i < entries.length; i += REVERT_WRITE_BATCH) {
      const slice = entries.slice(i, i + REVERT_WRITE_BATCH);
      try {
        await this.env.DB.batch(
          slice.map((e) =>
            this.env.DB.prepare(
              // OR REPLACE: each chunk's `.batch()` is still one transaction,
              // so a duplicate ref within THIS chunk would otherwise violate
              // the unique index and roll back the rest of the chunk — same
              // rationale as recordAlignmentAttention's INSERT.
              `INSERT OR REPLACE INTO export_reverts (book, resource, ref, class, fields)
               VALUES (?1, ?2, ?3, ?4, ?5)`,
            ).bind(book, resource, e.ref, e.class, "fields" in e && e.fields ? JSON.stringify(e.fields) : null),
          ),
        );
      } catch (e) {
        console.error("export revert report insert batch failed", {
          book,
          resource,
          chunkStart: i,
          chunkSize: slice.length,
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    }
    return true;
  }

  // Clear stale export_reverts rows for a book+resource that was actually
  // compared against master this run and found to have zero reverts — the
  // genuinely-clean case, distinct from "we never compared" (master
  // unreadable), which must NOT clear yesterday's real findings. Callers are
  // responsible for only invoking this when master was readable AND the
  // report came back with 0 entries.
  private async clearExportReverts(book: string, resource: Resource): Promise<void> {
    try {
      await this.env.DB.prepare(`DELETE FROM export_reverts WHERE book = ?1 AND resource = ?2`)
        .bind(book, resource)
        .run();
    } catch (e) {
      console.error("export revert report clear failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Build and record the export-revert report for one (book,resource), then
  // write a non-blocking, observational alert naming only what was measured
  // (class breakdown + refs) — never a cause, per this file's established
  // "state only a cause you measured" discipline (see the comment above
  // buildAlignmentShrinkAlertMessage). severity is always "warning": this
  // never blocks the export, so it must never read as "error".
  private async recordExportRevertReport(
    book: string,
    resource: Resource,
    kind: "usfm" | "tsv",
    entries: Array<UsfmRevertEntry | TsvRevertEntry>,
  ): Promise<void> {
    if (entries.length === 0) {
      await this.clearExportReverts(book, resource);
      return;
    }
    const recorded = await this.recordExportReverts(book, resource, entries);
    const label = `${book} ${resource.toUpperCase()}`;
    if (!recorded) {
      // recordExportReverts already logged the underlying error; the alert
      // must not go on to claim these findings were recorded (see its own
      // comment on why a failed/partial write must not read as success).
      await this.writeAlert(
        `export_revert:${book}:${resource}`,
        `${label}: computed ${entries.length} export-revert finding(s) but failed to fully write them to ` +
          `export_reverts (see worker logs for the D1 error) — this book+resource's revert report may now be ` +
          `missing rows or stale. This does not block the export.`,
        `${this.env.DCS_BASE_URL}/unfoldingWord`,
        "warning",
      );
      return;
    }
    const byClass = new Map<string, number>();
    for (const e of entries) byClass.set(e.class, (byClass.get(e.class) ?? 0) + 1);
    const breakdown = [...byClass.entries()].map(([cls, n]) => `${n} ${cls}`).join(", ");
    const sampleRefs = entries.slice(0, 10).map((e) => e.ref).join(", ");
    const extra = entries.length - 10;
    const severity =
      kind === "usfm"
        ? classifyRevertSeverity(entries as UsfmRevertEntry[], [])
        : classifyRevertSeverity([], entries as TsvRevertEntry[]);
    const escalateNote = severity.escalate
      ? ` This is a larger-than-usual number of reverts for one export (${severity.reason}).`
      : "";
    await this.writeAlert(
      `export_revert:${book}:${resource}`,
      `${label} shipped to Door43 and overwrote master's current content on ${entries.length} row(s)/verse(s) ` +
        `(${breakdown}): ${sampleRefs}${extra > 0 ? ` (+${extra} more)` : ""}.${escalateNote} This does not block ` +
        `the export; it is a record of what changed on master, in case a hand-edit there was lost.`,
      `${this.env.DCS_BASE_URL}/unfoldingWord`,
      "warning",
    );
  }

  // Who owns each offending verse in D1, keyed by the offender's ref. Reads
  // `verses.updated_by` (ownership) alongside bookReimport.ts's `latest_source`
  // sub-select (which of the sync / the AI / a person wrote it last) — see
  // offenderProvenanceFromLog for why ownership has to win over last-writer.
  //
  // Every path that does NOT produce a measurement records `not_checked`
  // rather than leaving the ref to default to `unknown`: a query failure, an
  // unparseable ref, a verse past the cap. "We never looked" and "the edit_log
  // has nothing" are different sentences in the alert, and only the second is
  // a finding.
  private async readOffenderProvenance(
    book: string,
    resource: Resource,
    offenders: AlignmentShrinkResult["offenders"],
  ): Promise<Map<string, OffenderProvenance>> {
    const out = new Map<string, OffenderProvenance>();
    // Only sequence-CHANGED offenders are ever bucketed by provenance, so spend
    // the cap on them — a book-wide collateral de-alignment would otherwise
    // burn all 25 lookups on verses whose wording never consults the result.
    const candidates = offenders.filter((o) => !o.sequenceUnchanged).map((o) => o.ref);
    // A verse-bridge offender's ref is `chapter:start-end` (verseAlignStats
    // keeps the USFM verse key verbatim), but D1 keys the row by the START
    // verse alone — so match the bridge and take its start rather than
    // dropping every bridged verse. Anything else (e.g. a `6a` verse key) is
    // un-lookupable, not un-attributed.
    const refs: string[] = [];
    for (const ref of candidates) {
      if (/^\d+:\d+(-\d+)?$/.test(ref)) refs.push(ref);
      else out.set(ref, "not_checked");
    }
    if (refs.length === 0) return out;
    const LOOKUP_CAP = 25;
    const version = resource.toUpperCase();
    for (const ref of refs.slice(LOOKUP_CAP)) out.set(ref, "not_checked");
    const looked = refs.slice(0, LOOKUP_CAP);
    // Key by `chapter:startVerse` so a bridge and its start verse can't be
    // told apart — if master somehow yields both, neither gets a guess.
    const byKey = new Map<string, string[]>();
    for (const ref of looked) {
      const [ch, v] = ref.split(":");
      const key = `${ch}:${v.split("-")[0]}`;
      byKey.set(key, [...(byKey.get(key) ?? []), ref]);
    }
    for (const ref of looked) out.set(ref, "not_checked");
    const keys = [...byKey.keys()];
    const placeholders = keys.map((_, i) => `?${i + 3}`).join(", ");
    try {
      const rs = await this.env.DB.prepare(
        `SELECT chapter, verse, updated_by,
                (SELECT source FROM edit_log
                  WHERE kind = 'verse'
                    AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                    AND (book = ?1 OR book IS NULL)
                    AND action IN ('create', 'update')
                  ORDER BY id DESC LIMIT 1) AS latest_source
           FROM verses
          WHERE book = ?1 AND bible_version = ?2
            AND chapter || ':' || verse IN (${placeholders})`,
      )
        .bind(book, version, ...keys)
        .all<{ chapter: number; verse: number; updated_by: number | null; latest_source: string | null }>();
      for (const row of rs.results) {
        const refsForRow = byKey.get(`${row.chapter}:${row.verse}`);
        if (!refsForRow || refsForRow.length !== 1) continue;
        out.set(refsForRow[0], offenderProvenanceFromLog(row));
      }
    } catch (err) {
      // Leave the looked-at refs on `not_checked` — a failed query measured
      // nothing, and must not be reported as "the edit_log does not say".
      console.log(`export: offender provenance lookup failed for ${book} ${version}: ${String(err)}`);
    }
    return out;
  }

  // Banner alert when the USFM structural validator blocks an ULT/UST export
  // because the render would fail DCS's own validate_usfm_files.py (Check 7
  // consecutive paragraph markers / Check 8 formatting) — the EZK front-`\p`
  // pump signature. Same replace-undismissed shape as recordShrinkSkipAlert.
  private async recordUsfmInvalidSkipAlert(
    book: string,
    resource: Resource,
    issues: UsfmValidationIssue[],
  ): Promise<void> {
    const source = `export_usfm_invalid:${book}:${resource}`;
    // Wording lives in export.ts so it is unit-testable, and so the alert names
    // the rules the validator actually reported instead of asserting the front-\p
    // stack for every outcome. See buildUsfmInvalidAlertMessage.
    const message = buildUsfmInvalidAlertMessage({
      label: `${book} ${resource.toUpperCase()}`,
      issues,
    });
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/unfoldingWord`);
  }

  // Banner alert when the shrink guard blocks an export to avoid mass-deleting
  // rows on master (the twl_PSA clobber signature). Same replace-undismissed
  // shape as recordStaleSkipAlert.
  private async recordShrinkSkipAlert(
    book: string,
    resource: Resource,
    renderedRows: number,
    masterRows: number | null,
    detail: string,
    explained?: number,
    unexplained?: number,
  ): Promise<void> {
    const source = `export_shrink:${book}:${resource}`;

    // FIX 3: clear a stale "credited" banner from an earlier night. If night N
    // credited the shrink (unexplained === 0, ships without a human) but the
    // export was then stopped further down (the alignment-shrink backstop, USFM
    // validation, a failed DCS commit) so master still holds the rows, and
    // night N+1's attribution changes and the guard now blocks, an operator
    // would otherwise see two contradicting undismissed banners at once: an
    // error saying this export is BLOCKED, right next to an info banner
    // saying the shrink was already auto-credited and allowed past master.
    // A stale banner that contradicts the current one is worse than none —
    // same idiom as the credited path clearing `export_shrink:*` below.
    await this.env.DB.prepare(
      `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
    )
      .bind(EXPORT_ALERT_USERNAME, `export_shrink_credited:${book}:${resource}`)
      .run();

    // The old wording unconditionally claimed "this looks like an incomplete
    // D1 load (truncated fetch), not a real deletion" — which was wrong for
    // 1CH TQ (all 62 of its missing rows carried human deletion tombstones in
    // D1). Say what the numbers actually show instead. Defect 4 moved the
    // detail→explanation mapping into describeShrinkRefusal (export.ts) — a
    // pure, exported, unit-tested function — so an unrecognized refusal kind
    // gets a neutral fallback instead of a guessed (and possibly wrong) cause.
    const { signature, remedy } = describeShrinkRefusal(detail, {
      renderedRows,
      masterRows,
      explained,
      unexplained,
    });
    const message =
      `Benjamin — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render has ${renderedRows} rows ` +
      `but master has ${masterRows ?? "?"} (${detail}). ${signature} Refusing to shrink master. ${remedy}`;
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/unfoldingWord`);
  }

  // Banner alert when the hard-reject gate holds an export because the render
  // contains a row DCS's validator counts as a real error (a blank or malformed
  // Occurrence). Unlike the blank-field banner this replaces, this one states a
  // cause the code measured: it names the offending refs and the validator's own
  // reason for each. Wording claims only that WE refused — the DCS run has not
  // happened, so it must not say DCS rejected anything yet.
  private async recordHardRejectAlert(
    book: string,
    resource: Resource,
    rejects: Array<{ ref: string; rowId: string; reason: string }>,
  ): Promise<void> {
    const source = `export_hard_reject:${book}:${resource}`;
    const shown = rejects
      .slice(0, 6)
      .map((r) => `${r.ref} (${r.rowId}): ${r.reason}`)
      .join("; ");
    const more = rejects.length > 6 ? `; +${rejects.length - 6} more` : "";
    const message =
      `Benjamin — nightly export HELD ${book} ${resource.toUpperCase()}: ${rejects.length} row(s) would fail DCS ` +
      `validation as a hard error, so the -be- PR's check would go red and the merge bot would never merge it. ` +
      `${shown}${more}. Fix the Occurrence on those rows (or delete them) in the editor and re-export; every other ` +
      `edit in ${book} ${resource.toUpperCase()} is waiting on it. Blank notes/questions/OrigWords/TWLink do NOT ` +
      `cause this — those are validator warnings and ship normally.`;
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/unfoldingWord`);
  }

  // Banner alert when the pre-export sync for a book failed outright (e.g. the
  // Cloudflare subrequest cap). The export will skip any book left stale, so
  // this is the heads-up that a manual re-sync is needed.
  private async recordSyncFailureAlert(book: string, detail: string): Promise<void> {
    const source = `export_sync_fail:${book}`;
    const message =
      `Benjamin — nightly pre-export sync failed for ${book}: ${detail.slice(0, 160)}. ` +
      `Any book left behind master is skipped by the freshness gate (not reverted); re-sync ${book} and re-export.`;
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/unfoldingWord`);
  }

  // Replace-undismissed alert writer shared by the export-side alerts. Best
  // effort: an alert-write failure must never fail or retry the export.
  private async writeAlert(
    source: string,
    message: string,
    linkUrl: string,
    severity: "error" | "warning" | "info" = "error",
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
      )
        .bind(EXPORT_ALERT_USERNAME, source)
        .run();
      await this.env.DB.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, link_url)
         VALUES (?1, ?5, ?2, ?3, ?4)`,
      )
        .bind(EXPORT_ALERT_USERNAME, source, message, linkUrl, severity)
        .run();
    } catch (e) {
      console.error("export alert write failed", { source, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Surface a PR-ensure failure as a banner alert (the SPA polls
  // GET /api/alerts/me). Same shape as postExport.recordFailureAlert: replace
  // any undismissed alert for the same source so consecutive failures don't
  // pile up. Best-effort — an alert-write failure must not fail the step.
  private async recordPrFailureAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    detail: string,
  ): Promise<void> {
    const source = `export_pr:${repo}`;
    const message = `Benjamin fix this — nightly export couldn't ensure a PR for ${book} ${resource} (\`${branch}\` on ${repo}): ${detail.slice(0, 160)}`;
    const linkUrl = `${this.env.DCS_BASE_URL}/${this.env.DCS_EXPORT_OWNER ?? "unfoldingWord"}/${repo}/pulls`;
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts
          WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
      )
        .bind(EXPORT_ALERT_USERNAME, source)
        .run();
      await this.env.DB.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, link_url)
         VALUES (?1, 'error', ?2, ?3, ?4)`,
      )
        .bind(EXPORT_ALERT_USERNAME, source, message, linkUrl)
        .run();
    } catch (e) {
      console.error("export PR alert write failed", {
        book, resource, repo, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Error banner when an export PR conflicted but we could NOT auto-recover —
  // no admin token, the delete was forbidden, or the rebuild threw. The PR is
  // left mergeable:false for a human to reconcile (today's behavior).
  private async recordPrConflictAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    detail: string,
  ): Promise<void> {
    const source = `export_conflict:${repo}:${book}:${resource}`;
    const message =
      `Benjamin fix this — nightly export PR for ${book} ${resource.toUpperCase()} (\`${branch}\` on ${repo}) ` +
      `is in merge conflict with master and could NOT be auto-rebuilt (${detail}). Reconcile by hand ` +
      `(merge master, \`git checkout --ours\` the file = D1's render, push), or provision DCS_TOKEN so the ` +
      `export can rebuild the branch automatically.`;
    const linkUrl = `${this.env.DCS_BASE_URL}/${this.env.DCS_EXPORT_OWNER ?? "unfoldingWord"}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "error");
  }

  // Informational banner when an export PR conflict WAS auto-recovered by
  // rebuilding the branch off master. Surfaces (rather than silently swallows)
  // the D1-authoritative resolution so Benjamin can eyeball the rebuilt PR diff
  // and confirm any master-only rows that got dropped were meant to go.
  private async recordBranchRebuiltAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    prNumber: number | null,
  ): Promise<void> {
    const source = `export_rebuilt:${repo}:${book}:${resource}`;
    const prRef = prNumber != null ? `#${prNumber}` : "(PR pending)";
    const message =
      `Heads up — nightly export rebuilt \`${branch}\` (${book} ${resource.toUpperCase()} on ${repo}) onto ` +
      `current master to clear a merge conflict; D1's render is authoritative. Eyeball PR ${prRef} to confirm ` +
      `any master-only rows dropped were intended.`;
    const linkUrl = `${this.env.DCS_BASE_URL}/${this.env.DCS_EXPORT_OWNER ?? "unfoldingWord"}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "warning");
  }
}

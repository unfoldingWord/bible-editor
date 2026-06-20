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
  buildExportBranch,
  buildTnTsv,
  buildTqTsv,
  buildTwlTsv,
  buildUsfm,
  closeDcsPr,
  commitToDcs,
  deleteDcsBranch,
  ensureDcsPr,
  exportTsvShrinkRefused,
  findDcsOpenPr,
  updateDcsPrBranch,
  usfmAlignmentShrinkRefused,
  RESOURCE_TARGETS,
  type Resource,
} from "./export";

// Banner target for export PR failures — same maintainer the post-export
// validator alerts (see postExport.ts ValidatorConfig.alertTargetUsername).
const EXPORT_ALERT_USERNAME = "deferredreward";

// Legacy export branch, superseded by per-(book,resource) contributor branches.
// Pruned best-effort on each export so it doesn't linger; safe to delete since
// the live-snapshot flow is no longer used (its post-export path is dormant).
const LEGACY_EXPORT_BRANCH = "live-snapshot";
import { runPostExport, VALIDATORS } from "./postExport";
import { runChunkedReimport, storedResourceSha, ALL_RESOURCES as REIMPORT_RESOURCES } from "./bookReimport";
import { dcsRawUrl, dcsResourceFile, fetchText, fileCommitSha, type ReimportResource } from "./dcsSources";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { lintUsfmVerses } from "./lint";

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
            async () => this.exportOne(book, resource, instanceId, dcsAllowed),
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
    for (const book of books) {
      const source = `export_lint:${book}`;
      try {
        const offenders: string[] = [];
        for (const bv of ["ULT", "UST"]) {
          const rs = await this.env.DB.prepare(
            `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 ORDER BY chapter, verse`,
          )
            .bind(book, bv)
            .all<VerseRow>();
          for (const issue of lintUsfmVerses(rs.results ?? [])) {
            if (issue.bucket === "escalate") offenders.push(`${bv} ${issue.ref}`);
          }
        }
        if (offenders.length === 0) {
          // Clear any stale undismissed alert for this book (the issue was fixed).
          await this.env.DB.prepare(
            `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
          )
            .bind(EXPORT_ALERT_USERNAME, source)
            .run();
          continue;
        }
        flagged.push(book);
        const sample = offenders.slice(0, 6).join(", ");
        const more = offenders.length > 6 ? `, +${offenders.length - 6} more` : "";
        await this.writeAlert(
          source,
          `Benjamin — ${book}: ${offenders.length} footnote integrity issue(s) the export can't auto-fix (${sample}${more}). Fix the \\f/\\f* pairing in these verses.`,
          `${this.env.DCS_BASE_URL}/unfoldingWord`,
        );
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
  ): Promise<StepResult> {
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
    if (dcsAllowed && (resource === "tn" || resource === "tq" || resource === "twl")) {
      const guard = await this.checkTsvShrink(book, resource, built.rowCount);
      if (!guard.ok) {
        await this.recordShrinkSkipAlert(book, resource, built.rowCount, guard.masterRows, guard.detail);
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

    // Alignment-shrink backstop for the scripture (verse) resources. The TSV
    // shrink guard above protects row counts; this protects \zaln word
    // alignment. A verse that lost \zaln milestones on UNTOUCHED words (the
    // 1CH 4:21 / NUM 24 signature) has the same row count but fewer aligned
    // words — invisible to the TSV guard. The interactive guard now catches
    // this at write time, but a verse already regressed in D1 (landed before
    // the guard, or via an ingress path it doesn't cover) would still ship.
    // Conservative: only blocks a verse whose aligned-word count shrank while
    // its plain text is unchanged — a real text rewrite is always allowed.
    if (dcsAllowed && (resource === "ult" || resource === "ust")) {
      const guard = await this.checkUsfmAlignmentShrink(book, resource, built.content);
      if (!guard.ok) {
        await this.recordAlignmentShrinkSkipAlert(book, resource, guard.detail);
        const reason = `align_shrink_guard:${guard.detail}`;
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
        const lingering = await findDcsOpenPr(dcsCfg);
        if (lingering != null) {
          try {
            await closeDcsPr(dcsCfg, lingering);
          } catch (e) {
            console.error("export close-stale-PR failed", {
              book, resource, repo: target.repo, pr: lingering,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      dcsCommitSha = commit.commitSha || null;
      dcsChanged = commit.changed;

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

  private async buildResource(book: string, resource: Resource): Promise<{ content: string; rowCount: number }> {
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
      return { content: rs.results.length === 0 ? "" : buildTnTsv(rs.results), rowCount: rs.results.length };
    }
    if (resource === "tq") {
      const rs = await db
        .prepare(
          `SELECT * FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TqRow>();
      return { content: rs.results.length === 0 ? "" : buildTqTsv(rs.results), rowCount: rs.results.length };
    }
    if (resource === "twl") {
      const rs = await db
        .prepare(
          `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(book)
        .all<TwlRow>();
      return { content: rs.results.length === 0 ? "" : buildTwlTsv(rs.results), rowCount: rs.results.length };
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
    if (rs.results.length === 0) return { content: "", rowCount: 0 };
    const headersRow = await db
      .prepare(`SELECT headers_json FROM book_usfm_meta WHERE book = ?1 AND bible_version = ?2`)
      .bind(book, bibleVersion)
      .first<{ headers_json: string }>();
    let headers: unknown[] | null = null;
    if (headersRow) {
      try {
        const parsed = JSON.parse(headersRow.headers_json);
        if (Array.isArray(parsed)) headers = parsed;
      } catch {
        headers = null;
      }
    }
    return {
      content: buildUsfm({ book, bibleVersion, headers, verses: rs.results }),
      rowCount: rs.results.length,
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
    const sql = isBible
      ? `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = 'verse' AND e.book = ?1 AND e.source IS NULL
            AND e.row_key LIKE ?2
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`
      : `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = ?1 AND e.book = ?2 AND e.source IS NULL
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`;
    const stmt = isBible
      ? this.env.DB.prepare(sql).bind(book, `${book}/%/${resource.toUpperCase()}`)
      : this.env.DB.prepare(sql).bind(resource, book);
    const rs = await stmt.all<{ username: string; first_at: number }>();
    return rs.results.map((r) => r.username);
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
  ): Promise<{ ok: boolean; detail: string; masterRows: number | null }> {
    const file = dcsResourceFile(book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file", masterRows: null };
    const raw = await fetchText(dcsRawUrl(this.env, file.repo, file.path));
    if (raw == null) return { ok: false, detail: "master_unreadable", masterRows: null };
    // Data rows = non-empty lines minus the header (mirrors parseTsv's model).
    const masterRows = Math.max(0, raw.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
    if (exportTsvShrinkRefused(renderedRows, masterRows)) {
      return { ok: false, detail: `shrink_${masterRows - renderedRows}_of_${masterRows}`, masterRows };
    }
    return { ok: true, detail: "ok", masterRows };
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
  ): Promise<{ ok: boolean; detail: string }> {
    const file = dcsResourceFile(book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file" };
    const masterUsfm = await fetchText(dcsRawUrl(this.env, file.repo, file.path));
    if (masterUsfm == null) return { ok: false, detail: "master_unreadable" };
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
      return { ok: false, detail: `align_loss_${result.offenders.length}:${sample}` };
    }
    return { ok: true, detail: "ok" };
  }

  // Banner alert when the alignment-shrink backstop blocks an ULT/UST export to
  // avoid shipping a silent de-alignment to master. Same replace-undismissed
  // shape as recordShrinkSkipAlert.
  private async recordAlignmentShrinkSkipAlert(
    book: string,
    resource: Resource,
    detail: string,
  ): Promise<void> {
    const source = `export_align_shrink:${book}:${resource}`;
    const message =
      `Benjamin fix this — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render would drop \\zaln ` +
      `word alignment on verses whose text is UNCHANGED (${detail}). This is the 1CH 4:21 / NUM 24 collateral ` +
      `de-alignment signature — refusing to ship it to master. Re-align the affected verse(s) in the editor, then re-export.`;
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
  ): Promise<void> {
    const source = `export_shrink:${book}:${resource}`;
    const message =
      `Benjamin — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render has ${renderedRows} rows ` +
      `but master has ${masterRows ?? "?"} (${detail}). This looks like an incomplete D1 load (truncated fetch), ` +
      `not a real deletion — refusing to shrink master. Re-sync ${book} ${resource.toUpperCase()} from master, ` +
      `verify the row count, then re-export.`;
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
  private async writeAlert(source: string, message: string, linkUrl: string): Promise<void> {
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
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
}

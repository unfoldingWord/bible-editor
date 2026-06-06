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
  commitToDcs,
  deleteDcsBranch,
  RESOURCE_TARGETS,
  type Resource,
} from "./export";

// Legacy export branch, superseded by per-(book,resource) contributor branches.
// Pruned best-effort on each export so it doesn't linger; safe to delete since
// the live-snapshot flow is no longer used (its post-export path is dormant).
const LEGACY_EXPORT_BRANCH = "live-snapshot";
import { runPostExport, VALIDATORS } from "./postExport";
import { reimportBookFromDcs, ALL_RESOURCES as REIMPORT_RESOURCES } from "./bookReimport";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";

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
  // 06:00 UTC cron sets this true; manual /api/exports/run leaves it false
  // so a single-book test export doesn't accidentally trigger a real merge.
  validateAndMerge?: boolean;
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
    if (dcsAllowed) {
      for (const book of books) {
        try {
          await step.do(
            `reimport-${book}`,
            { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
            async () => {
              const maxRow = await this.env.DB
                .prepare(`SELECT MAX(chapter) AS m FROM verses WHERE book = ?1`)
                .bind(book)
                .first<{ m: number | null }>();
              const maxCh = maxRow?.m ?? 0;
              if (maxCh < 1) return { book, reimported: false, reason: "not_seeded" };
              const chapters = Array.from({ length: maxCh }, (_, i) => i + 1);
              const r = await reimportBookFromDcs(
                this.env, book, chapters, [...REIMPORT_RESOURCES], null, { source: "cron" },
              );
              return { book, reimported: true, totals: r.totals };
            },
          );
        } catch (e) {
          // Lock contention / transient DCS failure: render proceeds on whatever
          // D1 holds (possibly slightly stale for this book); next run catches up.
          console.error("export pre-reimport failed", {
            book,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
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
        const result = await step.do(
          stepName,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => this.exportOne(book, resource, instanceId, dcsAllowed),
        );
        results.push(result);
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

    return { instanceId, totalSteps: results.length, results };
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

    if (!dcsAllowed) {
      dcsSkippedReason = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token";
    } else {
      const owner = this.env.DCS_EXPORT_OWNER ?? "unfoldingWord";
      const commit = await commitToDcs(
        {
          baseUrl: this.env.DCS_BASE_URL,
          token: this.env.DCS_SERVICE_TOKEN!,
          owner,
          repo: target.repo,
          branch,
        },
        filename,
        built.content,
        `bible-editor export: ${book} ${resource} → ${branch} (${instanceId})`,
      );
      dcsCommitSha = commit.commitSha || null;
      dcsChanged = commit.changed;

      // Prune branches this export superseded: any prior {book}-be-* branch for
      // this (book, resource) whose name changed because the contributor set
      // changed, plus the legacy live-snapshot branch. Best-effort — a prune
      // failure must never fail or retry the export step.
      await this.pruneSupersededBranches(book, resource, owner, target.repo, branch);
    }

    await this.recordSnapshot(book, resource, branch, dcsCommitSha, built.rowCount, dcsSkippedReason);

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
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO export_snapshots (book, resource, branch, commit_sha, rows_exported, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(book, resource, branch, commitSha, rowsExported, skippedReason)
      .run();
  }
}

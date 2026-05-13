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
  buildTnTsv,
  buildTqTsv,
  buildTwlTsv,
  buildUsfm,
  commitToDcs,
  RESOURCE_TARGETS,
  type Resource,
} from "./export";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";

export interface ExportParams {
  // Restrict the run to one book. Useful for manual /api/exports/run.
  book?: string;
  // Restrict the run to one resource family.
  resource?: Resource;
  // Force-skip the DCS commit even if a service token is configured. Lets
  // us test the rendering pipeline against R2 without pushing anything live.
  dryDcs?: boolean;
}

export interface StepResult {
  book: string;
  resource: Resource;
  rowCount: number;
  bytes: number;
  r2Key: string | null;
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

    // 2. One step per (book, resource). step.do persists, so a single flaky
    //    step retries without re-rendering the entire run.
    const results: StepResult[] = [];
    for (const book of books) {
      for (const resource of resources) {
        const stepName = `export-${book}-${resource}`;
        const result = await step.do(
          stepName,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => this.exportOne(book, resource, instanceId, dcsAllowed),
        );
        results.push(result);
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
      await this.recordSnapshot(book, resource, null, built.rowCount, "no_rows");
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: 0,
        r2Key: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: "no_rows",
      };
    }

    // R2 is the local-only backup. Writing here first means a failed DCS
    // commit still leaves a recoverable artifact.
    const target = RESOURCE_TARGETS[resource];
    const filename = target.path(book);
    const r2Key = `exports/${instanceId}/${book}/${filename}`;
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
      const branch = this.env.DCS_EXPORT_BRANCH ?? "live-snapshot";
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
        `bible-editor export: ${book} ${resource} (${instanceId})`,
      );
      dcsCommitSha = commit.commitSha || null;
      dcsChanged = commit.changed;
    }

    await this.recordSnapshot(book, resource, dcsCommitSha, built.rowCount, dcsSkippedReason);

    return {
      book,
      resource,
      rowCount: built.rowCount,
      bytes: built.content.length,
      r2Key,
      dcsCommitSha,
      dcsChanged,
      dcsSkippedReason,
    };
  }

  private async buildResource(book: string, resource: Resource): Promise<{ content: string; rowCount: number }> {
    const db = this.env.DB;
    if (resource === "tn") {
      const rs = await db
        .prepare(
          `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL
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
           ORDER BY chapter, verse, id`,
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

  private async recordSnapshot(
    book: string,
    resource: Resource,
    commitSha: string | null,
    rowsExported: number,
    skippedReason: string | null,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO export_snapshots (book, resource, commit_sha, rows_exported, error)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(book, resource, commitSha, rowsExported, skippedReason)
      .run();
  }
}

import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { chapters } from "./chapters";
import { rows } from "./rows";
import { verses } from "./verses";
import { catalogs } from "./catalogs";
import { twlSuggest } from "./twlSuggest";
import { twlFilters } from "./twlFilters";
import { noteTemplates } from "./noteTemplates";
import { lexicon } from "./lexicon";
import { align } from "./align";
import { exports as exportsRoutes } from "./exports";
import { tnQuick } from "./tnQuick";
import { pipelines, pollAllNonTerminal } from "./pipelines";
import { pendingImports } from "./pendingImports";
import { alerts } from "./alerts";
import { projectConfig } from "./projectConfigRoutes";
import { orgRoutes } from "./orgRoutes";
import { adminUsers } from "./adminUserRoutes";
import { articles } from "./articles";
import { translationMemory } from "./translationMemory";
import { l10n } from "./l10n";
import { books } from "./bookImport";
import { populateReferencedArticles } from "./articlePopulate";
import { attachAuth, requireAuth, requireCsrf, mintDevToken, startDcsAuth, callbackDcsAuth, authMe, authLogout, refreshToken, updateLastLocation, currentUserId } from "./auth";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  CHAPTER_ROOM: DurableObjectNamespace;
  EXPORT_WORKFLOW: Workflow;
  // Static SPA bundle, served for any non-/api path on production (wrangler
  // builds this binding automatically when [assets] is configured). The
  // SPA's URL hash routes itself; ASSETS just serves index.html + bundle.
  ASSETS: Fetcher;
  DCS_BASE_URL: string;
  DCS_OAUTH_AUTHORIZE_URL: string;
  DCS_OAUTH_TOKEN_URL: string;
  JWT_ISSUER: string;
  JWT_TTL_SECONDS: string;
  ALLOWED_ORIGINS?: string;
  DEV_AUTH_ENABLED?: string;
  DCS_CLIENT_ID?: string;
  DCS_CLIENT_SECRET?: string;
  JWT_SIGNING_KEY?: string;
  DCS_SERVICE_TOKEN?: string;
  // Admin PAT (branch-delete capable) used ONLY to recover a drifted export
  // branch whose PR has conflicted (delete + recreate off current master; the
  // service token 403s on branch-delete). Set via `wrangler secret put
  // DCS_TOKEN`. Absent → the conflict recovery is inert and the PR just gets a
  // banner alert (no behavior change). See docs/export-rebase-fix.md.
  DCS_TOKEN?: string;
  // Owner of the repos nightly exports land on. The branch is no longer
  // configurable — exports go to a per-(book,resource) branch named for the
  // book + its human contributors (see export.ts:buildExportBranch).
  // Defaults to the unfoldingWord canonical owner; override per env.
  DCS_EXPORT_OWNER?: string;
  // DCS org whose members get read-only ("viewer") access when not on the
  // editor allowlist. Defaults to "unfoldingWord" when unset.
  VIEWER_ORG?: string;
  // Shared service token for the uw-bt-bot AI endpoint. Set via
  // `wrangler secret put BT_API_TOKEN`. Absence disables /api/tn-quick.
  BT_API_TOKEN?: string;
  // Override the bot URL (defaults to https://uw-bt-bot.fly.dev/api/tn-quick
  // when unset). Useful for staging / local bot dev.
  TN_QUICK_URL?: string;
  // Base URL for the bp-assistant pipeline API (POST /api/pipeline/start,
  // GET /api/pipeline/:jobId). Defaults to the prod bot at uw-bt-bot.fly.dev
  // when unset.
  PIPELINE_API_BASE?: string;
}

// Cron patterns must match the [env.production.triggers] crons list in
// wrangler.toml (the default env registers no crons — see the note there).
// There's no runtime way to assert they line up (wrangler doesn't expose
// triggers to the Worker), but constants in code give grep something to find
// when the schedule changes.
const EXPORT_CRON = "30 5 * * *";
const POLL_CRON = "*/5 * * * *";
// Dormant: not yet registered in wrangler.toml [env.production.triggers].
// Branch below is unreachable until the cron entry is added there.
// Scheduled for 08:00 UTC — 2 hours after EXPORT_CRON so DCS-side merge of
// our nightly snapshot has time to land before we pull master back.
const REIMPORT_CRON = "0 8 * * *";

const app = new Hono<{ Bindings: Env; Variables: { userId?: number; username?: string } }>();

// CORS — strict allowlist sourced from the ALLOWED_ORIGINS env var (comma
// separated). The previous origin echo + credentials:true combination was a
// CSRF gift: any third-party page could call /api/* on behalf of a logged-in
// user. Now an Origin must match an entry verbatim; misses get no
// Access-Control-Allow-Origin header and the browser blocks the call. The
// dev default covers Vite (5173) and wrangler (8787) on localhost.
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

app.use("*", (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = allowed.length > 0 ? allowed : DEFAULT_DEV_ORIGINS;
  return cors({
    origin: (origin) => (origin && list.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "If-Match", "X-CSRF-Token", "X-Source-Generation"],
    exposeHeaders: ["ETag"],
  })(c, next);
});

app.use("*", attachAuth);
app.use("*", requireCsrf);

// Defense-in-depth response headers. CSP locks the SPA to its own bundle
// (no third-party scripts/styles aside from inline styles emotion/MUI need).
// frame-src allow-lists the swunrow search tool embedded in the Resources
// column's Search tab — without it, frame-src falls back to default-src 'self'
// and the iframe is blocked in prod (but not local Vite, which skips these
// headers). connect-src allow-lists git.door43.org for the same reason: the TW
// article viewer fetches raw markdown directly from Door43 (see twArticle.ts).
// Referrer-Policy keeps querystrings out of cross-origin Referer
// headers. X-Content-Type-Options stops the browser from sniffing a response
// into a different MIME than what we send. Applied to every response.
app.use("*", async (c, next) => {
  await next();
  // connect-src pins WebSockets to this deployment's own host instead of the
  // bare wss:/ws: schemes (any host — which would have handed an XSS a free
  // exfiltration channel). The explicit wss://host + ws://host entries cover
  // browsers that don't extend 'self' to WebSocket upgrades; the only WS the
  // SPA opens is same-host (wsClient.ts builds it from location.host).
  const host = new URL(c.req.url).host;
  c.res.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss://${host} ws://${host} https://git.door43.org; frame-src 'self' https://swunrow.pythonanywhere.com`,
  );
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});

// Global error handler. Without it, an unexpected throw in any handler returns
// Hono's default plain-text 500 — inconsistent with this API's JSON error
// shape and leaking the stack in some runtimes. HTTPException instances carry
// their own intended response, so honor those; everything else becomes a
// generic JSON 500 (details go to the log, not the client).
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(
    "unhandled error",
    c.req.method,
    c.req.path,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  return c.json({ error: "internal_error" }, 500);
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "bible-editor-api",
    time: new Date().toISOString(),
  }),
);

app.route("/api/books", books);

app.get("/api/auth/dcs/start", startDcsAuth);
app.get("/api/auth/dcs/callback", callbackDcsAuth);
app.get("/api/auth/me", authMe);
app.post("/api/auth/refresh", refreshToken);
// Logout intentionally NOT gated by requireAuth — we want it to clear cookies
// even if the Access cookie is missing/expired (the Refresh cookie is what
// gets us to the session row for revocation).
app.post("/api/auth/logout", authLogout);
app.put("/api/users/me/location", requireAuth, updateLastLocation);

// Dev-only: mint a JWT against a known/created users.id. Gated by
// DEV_AUTH_ENABLED so it can't be left on in prod, AND restricted to
// localhost so a plain `wrangler deploy` (which lands on the public
// `bible-editor-api-dev` *.workers.dev worker with DEV_AUTH_ENABLED=true)
// can't be used by anyone on the internet to mint an admin token. Local
// `wrangler dev` serves on 127.0.0.1/localhost and is unaffected.
app.post("/api/auth/dev", async (c) => {
  if (c.env.DEV_AUTH_ENABLED !== "true") {
    return c.json({ error: "disabled" }, 404);
  }
  const host = new URL(c.req.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    return c.json({ error: "disabled" }, 404);
  }
  let body: { username?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    /* allow empty body */
  }
  const username = (body.username ?? "").trim() || "dev";
  return mintDevToken(c, username);
});

app.route("/api/chapters", chapters);
app.route("/api/rows", rows);
app.route("/api/verses", verses);
app.route("/api/catalogs", catalogs);
app.route("/api/twl-suggestions", twlSuggest);
app.route("/api/twl-filters", twlFilters);
app.route("/api/note-templates", noteTemplates);
app.route("/api/lexicon", lexicon);
app.route("/api/align", align);
app.route("/api/exports", exportsRoutes);
app.route("/api/tn-quick", tnQuick);
app.route("/api/pipelines", pipelines);
app.route("/api/pending-imports", pendingImports);
app.route("/api/alerts", alerts);
app.route("/api/project-config", projectConfig);
app.route("/api/orgs", orgRoutes);
app.route("/api/admin/users", adminUsers);
app.route("/api/articles", articles);
app.route("/api/translation-memory", translationMemory);
app.route("/api/l10n", l10n);

// WebSocket upgrade into the ChapterRoom DO. WS handshakes are normal HTTP
// upgrades, so they carry the be_access cookie (same-origin) and attachAuth
// has already stamped userId on the context — that cookie is the only auth
// path (wsClient.ts opens the socket with no subprotocol). The earlier
// bearer.<jwt> subprotocol fallback has been removed alongside the HTTP Bearer
// fallback. Forward the raw request to the DO; it echoes any subprotocol back
// so the handshake completes.
app.get("/api/ws/chapter/:book/:chapter", async (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  if (currentUserId(c) === null) return c.text("unauthorized", 401);

  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  if (!Number.isFinite(chapter)) return c.text("invalid chapter", 400);

  const id = c.env.CHAPTER_ROOM.idFromName(`${book}:${chapter}`);
  return c.env.CHAPTER_ROOM.get(id).fetch(c.req.raw);
});

// /api/* misses get the JSON 404. Anything else falls through to the static
// SPA bundle (when the [assets] binding is configured for production deploy).
// In local dev the ASSETS binding may be undefined; we still return a clean
// 404 in that case so the dev experience matches.
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  const assets = c.env.ASSETS as Fetcher | undefined;
  if (assets) return assets.fetch(c.req.raw);
  return c.json({ error: "not_found", path: c.req.path }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Two crons share this handler — wrangler.toml has the full list. The
    // 05:30 one kicks the nightly DCS-export Workflow; the 5-min one polls
    // every non-terminal pipeline_job so the auto-apply step lands even
    // when no translator has a tab open. Branching on controller.cron
    // keeps the work cheaply separated.
    if (controller.cron === EXPORT_CRON) {
      // Finalize trashed notes before exporting. Trash (trashed_at) is a
      // visible, restorable safety net; the nightly tick promotes it to a
      // permanent deleted_at tombstone — which is hidden from reads, excluded
      // from the export below, and skipped by the daily reimport so it can't
      // resurrect. Keep the original deletion time (deleted_at = trashed_at).
      // Audit first (reads pre-update state), then promote. A finalize failure
      // must not cancel the night's export — buildResource's `trashed_at IS
      // NULL` filter tolerates unfinalized trash, and the next tick retries.
      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
             SELECT 'tn', id, book, NULL, version, version, 'delete', 'nightly_finalize'
               FROM tn_rows WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
          ),
          env.DB.prepare(
            `UPDATE tn_rows SET deleted_at = trashed_at, trashed_at = NULL
              WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
          ),
        ]);
      } catch (e) {
        console.error("nightly trash finalize failed", e instanceof Error ? e.message : String(e));
      }
      // Auto-clean resolved pipeline jobs so failed/done runs don't pile up in
      // the AI-pipelines chip forever (the UI has a manual "mark as seen", this
      // is the safety net for runs nobody dismissed). Failed/cancelled get a
      // day's grace then clear; done keep a week of history. A failure here
      // must not cancel the export — wrap and log.
      //
      // pending_imports.job_id REFERENCES pipeline_jobs(job_id) with no
      // cascade, and a done (or staged-then-failed) job keeps its pending_imports
      // rows as the apply/audit ledger — so the parent can't be deleted while
      // children exist. Drop the children first, in the same batch (D1 runs
      // batch statements sequentially in one transaction), then the jobs.
      const failedCancelledCutoff = `state IN ('failed', 'cancelled') AND updated_at < unixepoch() - 86400`;
      const doneCutoff = `state = 'done' AND updated_at < unixepoch() - (7 * 86400)`;
      try {
        await env.DB.batch([
          env.DB.prepare(
            `DELETE FROM pending_imports
              WHERE job_id IN (SELECT job_id FROM pipeline_jobs WHERE ${failedCancelledCutoff})`,
          ),
          env.DB.prepare(
            `DELETE FROM pending_imports
              WHERE job_id IN (SELECT job_id FROM pipeline_jobs WHERE ${doneCutoff})`,
          ),
          env.DB.prepare(`DELETE FROM pipeline_jobs WHERE ${failedCancelledCutoff}`),
          env.DB.prepare(`DELETE FROM pipeline_jobs WHERE ${doneCutoff}`),
        ]);
      } catch (e) {
        console.error("nightly pipeline_jobs cleanup failed", e instanceof Error ? e.message : String(e));
      }
      // Scheduled run opts into validate-and-merge — the whole point of the
      // 05:30 UTC tick is to land the snapshot on DCS and let the validator
      // merge it. Manual /api/exports/run leaves validateAndMerge unset so
      // tests don't accidentally trigger the auto-merge.
      //
      // Deterministic per-day instance id: a double-fire of the cron (or a
      // retried scheduled event) rejects on the duplicate id instead of
      // running two overlapping nightly exports.
      const day = new Date(controller.scheduledTime).toISOString().slice(0, 10);
      try {
        await env.EXPORT_WORKFLOW.create({ id: `nightly-${day}`, params: { validateAndMerge: true } });
      } catch (e) {
        console.log("nightly export already created for", day, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (controller.cron === POLL_CRON) {
      await pollAllNonTerminal(env);
      // Article-population backstop: auto-import schedules population via
      // waitUntil, but a crashed isolate or a book imported before this feature
      // shipped can leave referenced tW/tA articles unpopulated. Drain one
      // bounded chunk per tick — a cheap no-op once everything is populated.
      // ISOLATED from pipeline polling: neither cron subsystem may starve or
      // abort the other, so this gets its own try/catch.
      try {
        await populateReferencedArticles(env, { maxFetches: 200 });
      } catch (e) {
        console.error("cron populateReferencedArticles failed", e instanceof Error ? e.message : String(e));
      }
      // Stale-lock sweep for book_import_locks. Imports take 5-60s in
      // practice; anything past 10 minutes is a Worker that died mid-import
      // (OOM, isolate eviction) and left the row behind. The next POST for
      // that book would otherwise see the dangling lock and 409 forever.
      await env.DB.prepare(
        `DELETE FROM book_import_locks WHERE started_at < unixepoch() - 600`,
      ).run();
      // Once-per-hour edit_log retention sweep. 180 days is defensive — we
      // don't have a real policy yet, but the table grows without bound
      // otherwise (every keystroke that lands a PATCH writes a row). Gated
      // on minute-of-hour so it fires ~once/hour instead of every 5 min.
      const minuteOfHour = Math.floor(Date.now() / 60_000) % 60;
      if (minuteOfHour < 5) {
        await env.DB.prepare(
          `DELETE FROM edit_log WHERE created_at < unixepoch() - (180 * 86400)`,
        ).run();
      }
      return;
    }
    if (controller.cron === REIMPORT_CRON) {
      // Dormant until wrangler.toml lists "0 8 * * *". Self-heal: pull fresh DCS
      // content into D1 for every imported book. Dispatched as the export
      // Workflow in reimportOnly mode — scheduled() has no WorkflowStep context,
      // and the Workflow path chunks by chapter (so a large book can't blow the
      // 10-min step limit) and SHA-skips unchanged files. See exportWorkflow.ts.
      await env.EXPORT_WORKFLOW.create({ params: { reimportOnly: true } });
      return;
    }
  },
} satisfies ExportedHandler<Env>;

export { ChapterRoom } from "./chapterRoom";
export { ExportWorkflow } from "./exportWorkflow";

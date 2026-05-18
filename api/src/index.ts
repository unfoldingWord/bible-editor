import { Hono } from "hono";
import { cors } from "hono/cors";
import { chapters } from "./chapters";
import { rows } from "./rows";
import { verses } from "./verses";
import { catalogs } from "./catalogs";
import { lexicon } from "./lexicon";
import { exports as exportsRoutes } from "./exports";
import { tnQuick } from "./tnQuick";
import { pipelines, pollAllNonTerminal } from "./pipelines";
import { pendingImports } from "./pendingImports";
import { books } from "./bookImport";
import { attachAuth, mintDevToken, startDcsAuth, callbackDcsAuth, authMe, refreshToken, verifyToken } from "./auth";

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
  // Where nightly exports land on DCS. Owner = the user/org that owns the
  // fork repos (e.g. a service account). Branch = a long-lived fork branch.
  // Defaults below cover the unfoldingWord canonical owner; override per env.
  DCS_EXPORT_OWNER?: string;
  DCS_EXPORT_BRANCH?: string;
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
    allowHeaders: ["Content-Type", "Authorization", "If-Match"],
    exposeHeaders: ["ETag"],
  })(c, next);
});

app.use("*", attachAuth);

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

// Dev-only: mint a JWT against a known/created users.id. Gated by
// DEV_AUTH_ENABLED so it can't be left on in prod.
app.post("/api/auth/dev", async (c) => {
  if (c.env.DEV_AUTH_ENABLED !== "true") {
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
app.route("/api/lexicon", lexicon);
app.route("/api/exports", exportsRoutes);
app.route("/api/tn-quick", tnQuick);
app.route("/api/pipelines", pipelines);
app.route("/api/pending-imports", pendingImports);

// WebSocket upgrade into the ChapterRoom DO. Subprotocol-based bearer auth
// is the only browser-compatible way to carry the JWT on a WS upgrade —
// the standard Authorization header isn't settable on `new WebSocket(...)`.
// Client opens `new WebSocket(url, [\`bearer.${jwt}\`])`; we verify the
// token and forward the raw request to the DO (which echoes the protocol
// back so the handshake completes).
app.get("/api/ws/chapter/:book/:chapter", async (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  const protoHeader = c.req.header("sec-websocket-protocol") ?? "";
  const proto = protoHeader
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("bearer."));
  const token = proto ? proto.slice("bearer.".length) : "";
  if (!token) return c.text("unauthorized", 401);
  const claims = await verifyToken(token, c.env);
  if (!claims) return c.text("unauthorized", 401);

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
    // 06:00 one kicks the nightly DCS-export Workflow; the 5-min one polls
    // every non-terminal pipeline_job so the auto-apply step lands even
    // when no translator has a tab open. Branching on controller.cron
    // keeps the work cheaply separated.
    if (controller.cron === "0 6 * * *") {
      await env.EXPORT_WORKFLOW.create();
      return;
    }
    if (controller.cron === "*/5 * * * *") {
      await pollAllNonTerminal(env);
      return;
    }
  },
} satisfies ExportedHandler<Env>;

export { ChapterRoom } from "./chapterRoom";
export { ExportWorkflow } from "./exportWorkflow";

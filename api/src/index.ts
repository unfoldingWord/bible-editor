import { Hono } from "hono";
import { cors } from "hono/cors";
import { chapters } from "./chapters";
import { rows } from "./rows";
import { verses } from "./verses";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  CHAPTER_ROOM: DurableObjectNamespace;
  DCS_BASE_URL: string;
  DCS_OAUTH_AUTHORIZE_URL: string;
  DCS_OAUTH_TOKEN_URL: string;
  JWT_ISSUER: string;
  JWT_TTL_SECONDS: string;
  DCS_CLIENT_ID?: string;
  DCS_CLIENT_SECRET?: string;
  JWT_SIGNING_KEY?: string;
  DCS_SERVICE_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: (origin) => origin ?? "*", credentials: true }));

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "bible-editor-api",
    time: new Date().toISOString(),
  }),
);

app.route("/api/chapters", chapters);
app.route("/api/rows", rows);
app.route("/api/verses", verses);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Nightly DCS export will live here. Phase 1.
  },
} satisfies ExportedHandler<Env>;

export { ChapterRoom } from "./chapterRoom";

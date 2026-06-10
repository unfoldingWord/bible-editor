// Typed fetch helpers for the editor API. All paths are relative (Vite's
// dev proxy points /api/* at the local Worker; production serves the SPA
// from the same origin as the Worker).

export type RowKind = "tn" | "tq" | "twl";

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  support_reference: string | null;
  quote: string | null;
  occurrence: number | null;
  note: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /**
   * Visible, restorable soft-delete. Set via /trash (the delete button),
   * cleared via /restore. A trashed note stays in the chapter read (grayed,
   * sorted last) until the nightly 06:00 UTC job promotes it to a permanent
   * deleted_at tombstone. NULL means "not trashed".
   */
  trashed_at: number | null;
  /** Explicit "survive future AI pipeline sweeps" bit. Set via /preserve. */
  preserve: 0 | 1;
  /** Editor-authored stub queued for the next chapter-wide AI pipeline run. */
  hint: 0 | 1;
  /**
   * AI provenance: 'ai_pipeline' when the last edit came from the auto-apply
   * step (chip should show), otherwise null. Cleared by any later human
   * edit/keep. Computed at read time from edit_log, not stored on the row.
   */
  latest_source?: string | null;
}

export interface TqRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  quote: string | null;
  occurrence: number | null;
  question: string | null;
  response: string | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /** See TnRow.latest_source. */
  latest_source?: string | null;
}

export interface TwlRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  orig_words: string | null;
  occurrence: number | null;
  tw_link: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export interface VerseDto {
  book: string;
  chapter: number;
  verse: number;
  // Inclusive end of a multi-verse block (e.g. `\v 6-9` → verse=6, verse_end=9).
  // NULL for singleton verses. PR 2 widens UI rendering to span these.
  verse_end: number | null;
  bible_version: string;
  plain_text: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  content: unknown;
}

export interface VerseStatus {
  book: string;
  chapter: number;
  verse: number;
  done: 0 | 1;
  updated_at: number;
}

export interface ChapterPayload {
  book: string;
  chapter: number;
  verses: Record<string, Record<number, VerseDto>>;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  verseStatuses: VerseStatus[];
}

export interface BookSummary {
  book: string;
  chapters: Array<{
    chapter: number;
    verses: number;
    tn: number;
    tq: number;
    twl: number;
  }>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

// 409 body returned by mutation routes when a chapter has a non-terminal
// AI pipeline targeting it. The Worker returns this for POST/PATCH/DELETE on
// rows + PATCH on verses; client widgets can surface "AI run in progress
// (started X min ago)" without a second fetch.
export interface ChapterLockedBody {
  error: "chapter_locked";
  jobId: string;
  pipelineType: PipelineType;
  startedAt: number; // unix seconds
}

export function isChapterLockedBody(body: unknown): body is ChapterLockedBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.error === "chapter_locked" && typeof b.jobId === "string";
}

// 409 body returned by /api/pipelines/start when the upstream rejects the
// request because another sessionKey already has this (pipelineType, scope)
// running. The Worker enriches the bare upstream body with `existing` —
// pulled from D1 so translator B can see who's running it without an
// ownership-bumping endpoint.
export interface PipelineConflictExisting {
  job_id: string;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  state: PipelineState;
  current_skill: string | null;
  current_status: string | null;
  created_at: number;
  updated_at: number;
  started_by_username: string | null;
}
export interface PipelineConflictBody {
  error: "conflict";
  jobId: string;
  /**
   * Present when the conflicting job was started via this editor (it lives
   * in our D1). Absent for jobs started outside the editor (e.g. Zulip).
   */
  existing?: PipelineConflictExisting;
}

// Auth lives in cookies set by the server (be_access HttpOnly + be_refresh
// HttpOnly + be_csrf non-HttpOnly). We never store the JWT on the client.
// All fetches in this module pass `credentials: "include"` so the cookies
// ride along even on cross-origin requests (the prod deployment is same-
// origin, but the credentials flag is harmless either way).
//
// Writes also mirror the be_csrf cookie value into an X-CSRF-Token header so
// the server can validate double-submit.

const CSRF_COOKIE_NAME = "be_csrf";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const t = part.trim();
    if (t.startsWith(prefix)) {
      try {
        return decodeURIComponent(t.slice(prefix.length));
      } catch {
        return t.slice(prefix.length);
      }
    }
  }
  return null;
}

function getCsrfToken(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}

// Read-only flag — set when the current JWT carries role='viewer'. The
// outbox checks this before enqueueing a write so editor UI components that
// haven't been individually gated still can't trigger 403s. UI components
// that want to disable inputs can read this directly.
let readOnly = false;
export function isReadOnly(): boolean {
  return readOnly;
}
export function setReadOnly(v: boolean) {
  readOnly = v;
}

// Surface to the UI that we tried to silently refresh a 401 and it failed.
// App.tsx subscribes to render a "Session expired — sign in again" banner;
// the outbox keeps queuing edits in the meantime so nothing is lost.
type AuthErrorListener = () => void;
const authErrorListeners = new Set<AuthErrorListener>();
export function onAuthError(fn: AuthErrorListener): () => void {
  authErrorListeners.add(fn);
  return () => authErrorListeners.delete(fn);
}
function emitAuthError() {
  for (const fn of authErrorListeners) {
    try { fn(); } catch { /* listener bug — don't break the request pipeline */ }
  }
}

// Fired after a *successful* silent refresh. The outbox subscribes to
// revive ops that were parked as failed (max_attempts_exceeded) while the
// session was dead — a fresh access cookie is exactly the condition change
// that makes them worth a new retry budget.
type AuthRefreshedListener = () => void;
const authRefreshedListeners = new Set<AuthRefreshedListener>();
export function onAuthRefreshed(fn: AuthRefreshedListener): () => void {
  authRefreshedListeners.add(fn);
  return () => authRefreshedListeners.delete(fn);
}
function emitAuthRefreshed() {
  for (const fn of authRefreshedListeners) {
    try { fn(); } catch { /* listener bug — don't break the request pipeline */ }
  }
}

// Concurrent failing requests share a single refresh attempt so we don't
// trigger N refresh calls when N in-flight outbox ops all 401 at once. The
// server reads the be_refresh cookie (SameSite=Strict, sent automatically
// on same-origin POST) and rotates the be_access cookie.
// Exported for wsClient.ts — a WS handshake rejected before `open` can't go
// through request()'s 401 path, so the reconnect loop calls this directly.
let refreshInFlight: Promise<boolean> | null = null;

// A refresh must not hang forever. wsClient.ts runs
// `refreshAuthOnce().then(() => scheduleReconnect())` on a pre-open WS close;
// if the refresh fetch stalls on a half-open socket (post network-change),
// scheduleReconnect never fires *and* refreshInFlight stays pinned, blocking
// every 401 caller behind it. Cap it like request() does. A bit shorter than
// the 30s request default — refresh is a tiny POST, and we'd rather fail fast
// and let the outbox's online/focus retries get another shot.
const REFRESH_TIMEOUT_MS = 12_000;

export async function refreshAuthOnce(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException("timeout", "TimeoutError")),
      REFRESH_TIMEOUT_MS,
    );
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        signal: ctrl.signal,
      });
      if (res.ok) emitAuthRefreshed();
      return res.ok;
    } catch {
      // Timeout or network error — treat as a failed refresh. Resolving
      // false (rather than rejecting) keeps wsClient's `.then()` chain intact
      // so scheduleReconnect still fires.
      return false;
    } finally {
      clearTimeout(timer);
      // Clear after a brief delay so a burst of concurrent 401s coalesce on
      // the same refresh promise. Without the delay we could race a second
      // refresh between resolution and the next call's `if (refreshInFlight)`
      // check.
      setTimeout(() => { refreshInFlight = null; }, 0);
    }
  })();
  return refreshInFlight;
}

// Default 30s. Picked over 15s because verse PATCH with full USFM tree on a
// slow link can legitimately take double-digit seconds. Higher than this and
// a half-open socket starts to block sibling outbox ops (the outbox's per-
// target FIFO means a hung op holds back everything on that row).
// Exported so the outbox can derive its in-flight recovery threshold from it.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface RequestInitWithTimeout extends RequestInit {
  /** Override the default 30s timeout. Pass 0 to disable. */
  timeoutMs?: number;
}

// Compose any number of AbortSignals into one. Aborts as soon as any input
// aborts. We can't use AbortSignal.any directly because Safari < 17.4 and
// Firefox < 124 didn't ship it yet.
function composeSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!;
  const controller = new AbortController();
  const onAbort = (s: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(s.reason);
  };
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s);
      break;
    }
    s.addEventListener("abort", () => onAbort(s), { once: true });
  }
  return controller.signal;
}

async function request<T>(
  path: string,
  init?: RequestInitWithTimeout,
  _retriedAfterRefresh = false,
): Promise<T> {
  // Viewer (read-only) accounts: short-circuit anything that isn't a GET so
  // the server never sees a write attempt. ApiError(403, "read_only") is a
  // distinct sentinel callers can detect; the outbox already treats 403 as
  // fatal so it won't loop.
  const method = (init?.method ?? "GET").toUpperCase();
  if (readOnly && method !== "GET" && method !== "HEAD") {
    throw new ApiError(403, "read_only");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  // Double-submit CSRF on writes. Server matches X-CSRF-Token against the
  // be_csrf cookie and 403s on mismatch. GETs are exempt server-side.
  if (method !== "GET" && method !== "HEAD" && !headers["X-CSRF-Token"]) {
    const csrf = getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const timeoutMs = init?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let signal = init?.signal ?? undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    const timeoutCtrl = new AbortController();
    timer = setTimeout(
      () => timeoutCtrl.abort(new DOMException("timeout", "TimeoutError")),
      timeoutMs,
    );
    signal = signal ? composeSignals([signal, timeoutCtrl.signal]) : timeoutCtrl.signal;
  }

  // Strip our extension before handing to fetch. credentials: "include"
  // means cookies always ride along — same-origin in production, and Vite's
  // dev proxy preserves them too.
  const fetchInit: RequestInit = { ...init, headers, signal, credentials: "include" };
  delete (fetchInit as RequestInitWithTimeout).timeoutMs;

  // The timeout signal must stay armed until the *body* is consumed, not
  // just until headers arrive — a stalled response body would otherwise hang
  // res.json() forever and freeze the globally-serial outbox drain. The
  // finally below is the single release point.
  let res: Response;
  try {
    try {
      res = await fetch(path, fetchInit);
    } catch (e) {
      // Surface our timeout as a plain Error so callers (notably the outbox at
      // outbox.ts dispatch → `e instanceof ApiError === false` branch)
      // classify it as `network`/retry instead of `fatal`.
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error("request timeout");
      }
      throw e;
    }

    if (res.status === 401 && !_retriedAfterRefresh) {
      // First attempt is settled (we never read its body) — release its
      // timer now; the retry below arms its own body-covering timeout.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Silent refresh once per request. Only attempt while online — refreshing
      // through a captive portal would just burn the refresh window. The
      // outbox retries on `online`/`focus` so we'll get another shot then.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        throw new ApiError(401, "HTTP 401");
      }
      const refreshed = await refreshAuthOnce();
      if (refreshed) {
        return await request<T>(path, init, true);
      }
      // Refresh failed — token is dead or user was revoked. Surface to UI so
      // the user sees *why* their edits are queueing forever.
      emitAuthError();
      throw new ApiError(401, "HTTP 401");
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore — status alone is enough to classify the error */
      }
      throw new ApiError(res.status, `HTTP ${res.status}`, body);
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      // A timeout firing mid-body-read aborts the stream with our reason —
      // map it to the same plain Error as the fetch path above.
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error("request timeout");
      }
      throw e;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type Role = "admin" | "editor" | "viewer";

export interface MeResponse {
  userId: number;
  username: string | null;
  role: Role | null;
  // Persisted last-visited location. Used to restore the view after sign-in
  // (which round-trips through DCS OAuth and loses the URL hash).
  lastBook: string | null;
  lastChapter: number | null;
  lastVerse: number | null;
}

export type AlertSeverity = "error" | "warning" | "info";

export interface SystemAlert {
  id: number;
  severity: AlertSeverity;
  message: string;
  linkUrl: string | null;
  createdAt: number;
}

// GET /api/alerts/me — undismissed banner alerts targeted at this user.
// Empty array when there's nothing to show. Used by the App-level banner
// stack rendered above the viewer alert.
export async function fetchAlerts(): Promise<SystemAlert[]> {
  try {
    const res = await request<{ alerts: SystemAlert[] }>(`/api/alerts/me`);
    return res.alerts;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return [];
    throw err;
  }
}

// POST /api/alerts/:id/dismiss — sets dismissed_at = now so the row stops
// showing up in /api/alerts/me. Returns { ok, changed }; we don't surface
// `changed` to callers (dismissing an already-dismissed row is a no-op).
export async function dismissAlert(id: number): Promise<void> {
  await request<{ ok: true; changed: boolean }>(`/api/alerts/${id}/dismiss`, {
    method: "POST",
  });
}

// GET /api/auth/me — confirms the current cookie session's identity + role.
// Returns null on 401 (no cookie / expired) so callers can show the sign-in
// flow. Throws ApiError on other 4xx/5xx.
export async function fetchAuthMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>(`/api/auth/me`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

// POST /api/auth/logout — server-side: revokes the session row, clears
// cookies, best-effort revokes DCS token. Always succeeds from the client's
// perspective; failures don't block the UI.
export async function authLogout(): Promise<void> {
  try {
    await request<{ ok: true }>(`/api/auth/logout`, { method: "POST" });
  } catch {
    /* logout is best-effort — failure should never block the UI */
  }
}

// PUT /api/users/me/location — fire-and-forget; App.tsx debounces calls so
// we don't hammer D1 on every hashchange. Failures are silent — the URL hash
// is still the source of truth in-session; this is just for cross-session.
export async function updateLastLocation(
  book: string,
  chapter: number,
  verse: number,
): Promise<void> {
  try {
    await request<{ ok: true }>(`/api/users/me/location`, {
      method: "PUT",
      body: JSON.stringify({ book, chapter, verse }),
    });
  } catch {
    /* non-critical */
  }
}

// Dev-only sign-in. Sets the session cookies for `username`, creating a
// users row on first use. Only works while the worker has DEV_AUTH_ENABLED=
// true and a JWT_SIGNING_KEY configured. Returns the same shape as
// /api/auth/me so callers can skip a follow-up fetch.
export async function devSignIn(username = "dev"): Promise<MeResponse> {
  const res = await fetch(`/api/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
    credentials: "include",
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, `HTTP ${res.status}`, body);
  }
  return (await res.json()) as MeResponse;
}

export interface RowHistoryUser {
  id: number;
  username: string | null;
  full_name: string | null;
}

export interface RowHistoryEntry {
  version: number;
  // "imported" is synthesized server-side for rows that never had a real
  // `create` entry — the server fills it in from the current row state so
  // every row has a v1 anchor in its history.
  action: "create" | "update" | "delete" | "restore" | "imported";
  created_at: number;
  user: RowHistoryUser | null;
  // Just the fields that changed in this entry, intersected with the
  // kind-specific content fields the server tracks.
  patch: Record<string, unknown>;
  // The full reconstructed value of every content field at this version,
  // after this entry was applied.
  snapshot: Record<string, unknown>;
  synthetic: boolean;
  // Set when this entry was created by "switch to v{N}" from the history
  // dialog. The snapshot is identical to v{N}'s, so the UI hides these
  // phantom entries and surfaces the restored version as current instead.
  restored_from_version: number | null;
}

export interface RowHistory {
  versions: RowHistoryEntry[];
}

export interface Catalogs {
  supportReferences: string[];
  twLinks: string[];
}

// One curated note template for a support reference. `type` is the variant
// label from the sheet ("generic", "plural", …); empty string is the default
// unnamed variant.
export interface NoteTemplate {
  type: string;
  body: string;
}

// Curated note templates keyed by short support reference (e.g. "figs-metaphor"),
// each an ordered list of variants. Sourced from a Google Sheet, edge-cached.
export interface NoteTemplatesResponse {
  templates: Record<string, NoteTemplate[]>;
}

export interface BookListEntry {
  book: string;
  imported_at: number;
}

// Mirrors api/src/bookReimport.ts. Counts of rows/verses touched per
// resource by a single POST /api/books/:book/reimport call.
export type ReimportResource = "ult" | "ust" | "tn" | "tq" | "twl";

export interface ReimportCounts {
  updated: number;
  inserted: number;
  skipped_edited: number;
  skipped_locked: number;
  skipped_noop: number;
  dcs_404: number;
  errors: string[];
}

export interface ReimportResponse {
  ok: true;
  book: string;
  perResource: Record<ReimportResource, ReimportCounts>;
  totals: ReimportCounts;
}

// Translation-note AI draft endpoint (proxied through this Worker; the
// shared bot lives at uw-bt-bot.fly.dev). Schema is the bot's; keep in
// sync with its zod definition. The Worker only adds the BT_API_TOKEN
// bearer and forwards the body verbatim, so types live on this side.
export interface TnQuickRequest {
  ref: {
    book: string;
    chapter: number;
    verse: number;
  };
  issueType: string;
  ult: {
    selection: string;
    verse: string;
    context: { prev5: string[]; next5: string[] };
  };
  ust: {
    selection: string;
    verse: string;
    context: { prev5: string[]; next5: string[] };
  };
  hebrewGuess: string;
  model?: "sonnet" | "opus";
}

export interface TnQuickResponse {
  quote: string;
  note: string;
  warnings: string[];
}

// ── AI pipeline (chapter-scale) — see docs/ai-pipeline-integration.md ──────
// Types mirror the bp-assistant client-side contract; both sides change
// together if the contract is revised.

export type PipelineType = "generate" | "notes" | "tqs";

export type PipelineState =
  // queued: accepted by us, not yet sent to the bot (cancellable).
  // dispatching: claimed the single bot slot; upstream POST in flight.
  // cancelled: a queued job the user withdrew (terminal).
  | "queued"
  | "dispatching"
  | "running"
  | "paused_for_outage"
  | "paused_for_usage_limit"
  | "failed"
  | "cancelled"
  | "done";

export type PipelineErrorKind =
  | "transient_outage"
  | "auth_error"
  | "usage_limit"
  | "sdk_error"
  | "non_success_result"
  | "missing_output"
  | "stale_output"
  | "interrupted"
  | "import_failed";

// Mirrors the bp-assistant contract (docs/ai-pipeline-integration.md §3).
// Server validates with .strict(); unknown keys are rejected. Per-pipeline-type
// flag mixing (e.g. contentTypes on a "notes" run) is also rejected.
export interface PipelineRequestOptions {
  model?: "sonnet" | "opus";
  /** Clear prior checkpoint + outputs. Useful for retrying a failed run. */
  fresh?: boolean;

  // -- generate-only --
  /** Restrict to a subset of content types. Default is both. */
  contentTypes?: ("ult" | "ust")[];
  /** Skip alignment + repo-insert; USFM is NOT pushed to Door43. */
  noAlign?: boolean;
  /** Reuse already-generated USFM and only run alignment + repo-insert. */
  alignOnly?: boolean;
  /** Push the unaligned USFM to Door43 (no alignment performed). */
  textOnly?: boolean;

  // -- notes-only --
  /** Skip the chapter intro generation step. */
  noIntro?: boolean;
  /** Pause before generating Alternate Translations so a human can review. */
  pauseBeforeATs?: boolean;
}

export interface PipelineChainStep {
  pipelineType: PipelineType;
  options?: PipelineRequestOptions;
}

export interface PipelineStartRequest {
  pipelineType: PipelineType;
  book: string;
  startChapter: number;
  endChapter?: number;
  sessionKey: string;
  options?: PipelineRequestOptions;
  /**
   * Optional second pipeline to fire on the parent's done-transition. Used
   * to express asymmetric ULT/UST alignment (e.g. ULT aligned + UST text-
   * only) since the upstream contract can't carry asymmetric align flags
   * in one call. Same scope and pipelineType — only the options differ.
   * Mutually exclusive with followUpChain.
   */
  followUpOptions?: PipelineRequestOptions;
  /**
   * Cross-type follow-up chain. First entry fires on the parent's done-
   * transition; the rest is stored on the child and fires in turn. Used by
   * the chapter macro to chain generate -> notes -> tqs without leaving the
   * chapter unlocked between steps. Mutually exclusive with followUpOptions.
   */
  followUpChain?: PipelineChainStep[];
}

export interface PipelineStartResponse {
  jobId: string;
  scope: { book: string; startChapter: number; endChapter: number };
  status: "running" | "queued" | "already_running";
  /** 1-based position in the global queue when status === "queued". */
  queuePosition?: number;
}

export interface PipelineOutput {
  type: "ult" | "ust" | "tn" | "tq";
  repo: string;
  branch: string;
  path: string;
  rawUrl: string;
  prNumber: number;
  mergedAt: string;
  commitSha: string;
}

export interface PipelineStatusResponse {
  jobId: string;
  pipelineType: PipelineType;
  scope: { book: string; startChapter: number; endChapter: number };
  state: PipelineState;
  current?: {
    chapter: number;
    skill: string;
    status: "running" | "succeeded" | "failed" | "skipped_complete";
    startedAt: string;
    errorKind?: PipelineErrorKind;
    error?: string;
  };
  updatedAt: string;
  createdAt: string;
  interrupted?: boolean;
  output?: PipelineOutput[];
  /**
   * Present on queued/dispatching jobs (which aren't on the bot yet): the
   * Worker synthesizes the status from D1 and includes the live queue
   * position so the chip can show "#N in line" and refresh it each poll.
   */
  queuePosition?: number;
  queueAhead?: number;
}

// AI pipeline proposal staged in pending_imports. The server parses payload
// from TEXT into a JSON object so clients don't repeat that work. Phase 2b
// renders these as a placeholder list; Phase 2c is the real diff UI.
export interface PendingImport {
  id: number;
  jobId: string;
  kind: "tn" | "tq" | "verse";
  book: string;
  chapter: number;
  verse: number;
  bibleVersion: string | null;
  payload: unknown;
  createdAt: number;
  pipelineType: PipelineType;
  startedByUsername: string | null;
}

// Row shape returned by GET /api/pipelines (list). Columns are snake_case —
// this is the persisted D1 row, not the live upstream response shape.
export interface PipelineJobRow {
  job_id: string;
  /**
   * The bot's opaque jobId, assigned on dispatch. NULL while queued/dispatching.
   * job_id (our local UUID) is the stable identity the client keys on — it
   * never changes as a job moves queued → running → done.
   */
  upstream_job_id: string | null;
  user_id: number;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  state: PipelineState;
  /** Follow-up / macro-chain children get priority=1 so they jump the queue. */
  priority: number;
  /** 1-based global queue position; set by the list/status endpoints for queued jobs. */
  queue_position?: number | null;
  /** How many jobs run before this one (active + higher-ranked queued). */
  queue_ahead?: number | null;
  current_skill: string | null;
  current_status: string | null;
  error_kind: PipelineErrorKind | null;
  error_message: string | null;
  output_json: string | null;
  /**
   * Set on a parent row once its asymmetric-alignment follow-up has been
   * spawned. Lets the UI render a "follow-up: jobX" line on the parent and
   * the reciprocal "after: jobY" line on the child (whose row matches this
   * column elsewhere in the list).
   */
  follow_up_job_id: string | null;
  created_at: number;
  updated_at: number;
  last_polled_at: number | null;
  /**
   * Set the first time the browser surfaces a "completed-while-away" toast
   * for this job (via POST /api/pipelines/:id/notified). Null on jobs the
   * user hasn't yet been told about — those drive the toast.
   */
  notified_user_at: number | null;
}

// Global queue context returned alongside GET /api/pipelines so the chip can
// render "what's running ahead of you". activeJob reuses the conflict-dialog
// shape (it's the single job currently on the bot, or null when idle).
export interface PipelineQueueSummary {
  activeJob: PipelineConflictExisting | null;
  queuedCount: number;
}

export const api = {
  getBookSummary: (book: string, signal?: AbortSignal) =>
    request<BookSummary>(`/api/chapters/${encodeURIComponent(book)}`, { signal }),

  getChapter: (book: string, chapter: number, signal?: AbortSignal) =>
    request<ChapterPayload>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}`,
      { signal },
    ),

  getCatalogs: () => request<Catalogs>(`/api/catalogs`),

  getNoteTemplates: () => request<NoteTemplatesResponse>(`/api/note-templates`),

  getBooks: () => request<{ books: BookListEntry[] }>(`/api/books`),

  // Trigger a server-side import of a book from DCS. Long-running: ~5-60s
  // depending on book size, so the caller gets a wider timeout.
  importBook: (book: string) =>
    request<{
      ok: true;
      book: string;
      alreadyImported?: boolean;
      verses?: number;
      tn?: number;
      tq?: number;
      twl?: number;
      fetched?: { ult: boolean; ust: boolean; orig: boolean; tn: boolean; tq: boolean; twl: boolean };
    }>(`/api/books/${encodeURIComponent(book)}/import`, {
      method: "POST",
      timeoutMs: 120_000,
    }),

  // Non-destructive per-chapter, per-resource re-import from Door43. Only
  // overwrites rows that have never been touched by a human; counts are
  // returned per-resource so the dialog can summarize what changed vs. was
  // skipped. Server-side: api/src/bookReimport.ts.
  reimportFromDoor43: (
    book: string,
    body: { chapters: number[]; resources: ReimportResource[] },
  ) =>
    request<ReimportResponse>(
      `/api/books/${encodeURIComponent(book)}/reimport`,
      {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      },
    ),

  setVerseDone: (book: string, chapter: number, verse: number, done: boolean) =>
    request<VerseStatus>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/${verse}/status`,
      { method: "PATCH", body: JSON.stringify({ done }) },
    ),

  createRow: <T = unknown>(kind: RowKind, body: Record<string, unknown>) =>
    request<T>(`/api/rows/${kind}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // book is required after the composite-(book, id) PK migration (0015);
  // the server returns 400 if it's missing because the same 4-char id can
  // exist in two books with different content.
  getRowHistory: (kind: RowKind, id: string, book: string) =>
    request<RowHistory>(
      `/api/rows/${kind}/${encodeURIComponent(id)}/history?book=${encodeURIComponent(book)}`,
    ),

  patchRow: <T = unknown>(
    kind: RowKind,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
    opts: { restoredFromVersion?: number | null; book: string },
  ) =>
    request<T>(`/api/rows/${kind}/${encodeURIComponent(id)}?book=${encodeURIComponent(opts.book)}`, {
      method: "PATCH",
      headers: { "If-Match": String(expectedVersion) },
      body: JSON.stringify(
        typeof opts.restoredFromVersion === "number"
          ? { ...patch, restored_from_version: opts.restoredFromVersion }
          : patch,
      ),
    }),

  deleteRow: (kind: RowKind, id: string, expectedVersion: number, book: string) =>
    request<{ ok: true }>(`/api/rows/${kind}/${encodeURIComponent(id)}?book=${encodeURIComponent(book)}`, {
      method: "DELETE",
      headers: { "If-Match": String(expectedVersion) },
    }),

  // Legacy: alias for setPreserveNote(id, true). Server still accepts it for
  // any in-flight outbox ops; new code should call setPreserveNote.
  keepNote: (id: string, book: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/keep?book=${encodeURIComponent(book)}`, {
      method: "POST",
    }),

  // Toggle the "survive future AI pipeline sweeps" bit. Lock-exempt.
  // Returns the updated row so the caller can refresh local state.
  setPreserveNote: (id: string, book: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/preserve?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }),

  // Toggle the "queue as AI-pipeline hint" bit. Lock-exempt. hint=1 rows
  // are sent into the next pipeline run as options.hints and are excluded
  // from the sweep; AI expansion clears the bit.
  setHintNote: (id: string, book: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/hint?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }),

  // Move a note to the visible "trash" state (the delete button). Returns the
  // updated row with trashed_at set. Reversible via restoreNote; finalized to a
  // deleted_at tombstone by the nightly job. Lock-exempt, no If-Match.
  trashNote: (id: string, book: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/trash?book=${encodeURIComponent(book)}`, {
      method: "POST",
    }),

  // Bring a trashed note back to the live set (trashed_at cleared).
  restoreNote: (id: string, book: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/restore?book=${encodeURIComponent(book)}`, {
      method: "POST",
    }),

  patchVerse: <T = unknown>(
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    expectedVersion: number,
    payload: { content: unknown; plain_text?: string | null },
  ) =>
    request<T>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}`,
      {
        method: "PATCH",
        headers: { "If-Match": String(expectedVersion) },
        body: JSON.stringify(payload),
      },
    ),

  tnQuick: (body: TnQuickRequest, signal?: AbortSignal) =>
    request<TnQuickResponse>(`/api/tn-quick`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      // AI note drafting (bot → Anthropic + Hebrew validation) routinely
      // exceeds the 30s default, which surfaced as a "request timeout" toast.
      // The call is lifecycle-keyed (aborts on Shell unmount) and runs in the
      // background, so a generous ceiling is safe.
      timeoutMs: 120_000,
    }),

  pipelineStart: (body: PipelineStartRequest, signal?: AbortSignal) =>
    request<PipelineStartResponse>(`/api/pipelines/start`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),

  pipelineStatus: (jobId: string, signal?: AbortSignal) =>
    request<PipelineStatusResponse>(
      `/api/pipelines/${encodeURIComponent(jobId)}`,
      { signal },
    ),

  pipelineList: (
    states?: PipelineState[],
    signal?: AbortSignal,
  ) =>
    request<{ jobs: PipelineJobRow[]; queue?: PipelineQueueSummary }>(
      states && states.length > 0
        ? `/api/pipelines?state=${encodeURIComponent(states.join(","))}`
        : `/api/pipelines`,
      { signal },
    ),

  // Withdraw a job that hasn't reached the front of the line. Server returns
  // 409 {error:"cannot_cancel", state} if it's already dispatching/running.
  pipelineCancel: (jobId: string, signal?: AbortSignal) =>
    request<{ ok: boolean; jobId: string; state: "cancelled" }>(
      `/api/pipelines/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", signal },
    ),

  // Acknowledge a "completed-while-away" toast so the server clears its
  // unnotified flag. Fire-and-forget — if it fails the user just sees the
  // toast again on the next reload, which is harmless.
  pipelineNotified: (jobId: string, signal?: AbortSignal) =>
    request<{ ok: boolean; changed: number }>(
      `/api/pipelines/${encodeURIComponent(jobId)}/notified`,
      { method: "POST", signal },
    ),

  getPendingImports: (book: string, chapter: number, signal?: AbortSignal) =>
    request<{ items: PendingImport[] }>(
      `/api/pending-imports?book=${encodeURIComponent(book)}&chapter=${chapter}`,
      { signal },
    ),
};

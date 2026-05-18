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

// Bearer token storage. The token is opaque to the client — it carries the
// user id in its `sub` claim and the worker verifies HS256 against the
// shared JWT_SIGNING_KEY. localStorage is good-enough for a 7-month tactical
// tool; revisit if the app starts handling sensitive data (the obvious next
// step would be httpOnly cookies, which also requires SameSite=Lax + CSRF).
const TOKEN_KEY = "bible-editor.auth.token";
let cachedToken: string | null | undefined;

export function getAuthToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export function setAuthToken(token: string | null) {
  cachedToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode etc. */
  }
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

// Concurrent failing requests share a single refresh attempt so we don't
// trigger N refresh calls when N in-flight outbox ops all 401 at once.
let refreshInFlight: Promise<boolean> | null = null;
async function refreshAuthOnce(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const token = getAuthToken();
      if (!token) return false;
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!data?.token) return false;
      setAuthToken(data.token);
      return true;
    } catch {
      return false;
    } finally {
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
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const token = getAuthToken();
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
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

  // Strip our extension before handing to fetch.
  const fetchInit: RequestInit = { ...init, headers, signal };
  delete (fetchInit as RequestInitWithTimeout).timeoutMs;

  let res: Response;
  try {
    res = await fetch(path, fetchInit);
  } catch (e) {
    if (timer) clearTimeout(timer);
    // Surface our timeout as a plain Error so callers (notably the outbox at
    // outbox.ts dispatch → `e instanceof ApiError === false` branch)
    // classify it as `network`/retry instead of `fatal`.
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error("request timeout");
    }
    throw e;
  }
  if (timer) clearTimeout(timer);

  if (res.status === 401 && !_retriedAfterRefresh) {
    // Silent refresh once per request. Only attempt while online — refreshing
    // through a captive portal would just burn the refresh window. The
    // outbox retries on `online`/`focus` so we'll get another shot then.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ApiError(401, "HTTP 401");
    }
    const refreshed = await refreshAuthOnce();
    if (refreshed) {
      return request<T>(path, init, true);
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
      /* ignore */
    }
    throw new ApiError(res.status, `HTTP ${res.status}`, body);
  }
  return (await res.json()) as T;
}

export interface DevAuthResponse {
  token: string;
  userId: number;
  username: string;
  expiresIn: number;
}

// Dev-only sign-in. Mints a JWT for `username`, creating a users row on
// first use. Only works while the worker has DEV_AUTH_ENABLED=true and a
// JWT_SIGNING_KEY configured. Production should route through DCS OAuth
// (not yet wired — see docs/plan.md).
export async function devSignIn(username = "dev"): Promise<DevAuthResponse> {
  const res = await fetch(`/api/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
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
  const data = (await res.json()) as DevAuthResponse;
  setAuthToken(data.token);
  return data;
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

export interface BookListEntry {
  book: string;
  imported_at: number;
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
  | "running"
  | "paused_for_outage"
  | "paused_for_usage_limit"
  | "failed"
  | "done";

export type PipelineErrorKind =
  | "transient_outage"
  | "auth_error"
  | "usage_limit"
  | "sdk_error"
  | "non_success_result"
  | "missing_output"
  | "stale_output"
  | "interrupted";

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
  status: "running" | "already_running";
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
  user_id: number;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  state: PipelineState;
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

export const api = {
  getBookSummary: (book: string, signal?: AbortSignal) =>
    request<BookSummary>(`/api/chapters/${encodeURIComponent(book)}`, { signal }),

  getChapter: (book: string, chapter: number, signal?: AbortSignal) =>
    request<ChapterPayload>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}`,
      { signal },
    ),

  getCatalogs: () => request<Catalogs>(`/api/catalogs`),

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

  getRowHistory: (kind: RowKind, id: string) =>
    request<RowHistory>(
      `/api/rows/${kind}/${encodeURIComponent(id)}/history`,
    ),

  patchRow: <T = unknown>(
    kind: RowKind,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
    opts?: { restoredFromVersion?: number | null },
  ) =>
    request<T>(`/api/rows/${kind}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "If-Match": String(expectedVersion) },
      body: JSON.stringify(
        opts && typeof opts.restoredFromVersion === "number"
          ? { ...patch, restored_from_version: opts.restoredFromVersion }
          : patch,
      ),
    }),

  deleteRow: (kind: RowKind, id: string, expectedVersion: number) =>
    request<{ ok: true }>(`/api/rows/${kind}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "If-Match": String(expectedVersion) },
    }),

  // Legacy: alias for setPreserveNote(id, true). Server still accepts it for
  // any in-flight outbox ops; new code should call setPreserveNote.
  keepNote: (id: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/keep`, {
      method: "POST",
    }),

  // Toggle the "survive future AI pipeline sweeps" bit. Lock-exempt.
  // Returns the updated row so the caller can refresh local state.
  setPreserveNote: (id: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/preserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }),

  // Toggle the "queue as AI-pipeline hint" bit. Lock-exempt. hint=1 rows
  // are sent into the next pipeline run as options.hints and are excluded
  // from the sweep; AI expansion clears the bit.
  setHintNote: (id: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
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
    request<{ jobs: PipelineJobRow[] }>(
      states && states.length > 0
        ? `/api/pipelines?state=${encodeURIComponent(states.join(","))}`
        : `/api/pipelines`,
      { signal },
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

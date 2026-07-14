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
  /**
   * Translation-mode state machine (migration 0037; returned via `SELECT t.*`).
   * NULL for the English root project and for any row the translate pipeline
   * never touched, so the English workflow is unaffected. 'ai_draft' = the
   * translate pipeline just applied an AI translation; 'edited' = a human
   * changed the draft (set server-side on a content PATCH of a non-NULL row);
   * 'validated' = a human approved it (POST /tn/:id/validate).
   */
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  /** Hash of the EN source row the draft was made from (source-drift detection). */
  source_row_hash?: string | null;
  /** translate-report.json entry for this row (confidence/terms); NULL when the bot ships no sidecar. */
  draft_meta_json?: string | null;
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
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /** Translation-mode state machine (multilingual; mirrors TnRow). */
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  source_row_hash?: string | null;
  draft_meta_json?: string | null;
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

export type AlignmentIntent =
  | "text_edit"
  | "find_replace"
  | "section_edit"
  | "alignment_edit";

export interface VerseStatus {
  book: string;
  chapter: number;
  verse: number;
  done: 0 | 1;
  updated_at: number;
}

// Per-resource checkoff lanes. "text" = ULT + UST together.
export type CheckLane = "text" | "tn" | "tw" | "tq";
export const CHECK_LANES: readonly CheckLane[] = ["text", "tn", "tw", "tq"] as const;

export interface VerseLaneCheck {
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
  checked_by: number;
  checked_at: number;
}

// Response from a lane toggle / WS event: the full checker set for one (verse,
// lane) so the client can recompute its own shade.
export interface LaneCheckState {
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
  checkers: number[];
}

export interface ChapterPayload {
  book: string;
  chapter: number;
  verses: Record<string, Record<number, VerseDto>>;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  verseStatuses: VerseStatus[];
  verseLaneChecks: VerseLaneCheck[];
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

// One DCS-validation finding from GET /api/books/:book/lint. `bucket` splits
// content problems a translator must resolve ("flag") from integrity issues
// like footnotes ("escalate"). `ref` is "chapter:verse" (or "chapter"); `rowId`
// is present for TN findings so the UI can jump straight to the offending note.
export interface BookLintIssue {
  check: string;
  bucket: "flag" | "escalate";
  ref: string;
  rowId?: string;
  message: string;
  resource: "tn" | "ult" | "ust";
}

export interface BookLintReport {
  book: string;
  total: number;
  /** Issues needing a human decision (the "flag" bucket). */
  flagCount: number;
  /** Integrity issues (footnotes) — secondary, count only. */
  escalateCount: number;
  issues: BookLintIssue[];
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
      // csrf_mismatch is recoverable, not fatal: the be_csrf cookie expired
      // (or was cleared) while the session itself is still valid. A refresh
      // re-mints the cookie via setSessionCookies, so the retry reads a fresh
      // value. Same one-shot, online-only refresh-and-retry as the 401 path
      // above. (read_only 403s short-circuit before fetch, so they never land
      // here.)
      if (
        res.status === 403 &&
        !_retriedAfterRefresh &&
        (body as { error?: string } | null)?.error === "csrf_mismatch" &&
        !(typeof navigator !== "undefined" && navigator.onLine === false)
      ) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const refreshed = await refreshAuthOnce();
        if (refreshed) {
          return await request<T>(path, init, true);
        }
        // Refresh failed — the session is dead, not just the CSRF cookie.
        emitAuthError();
        throw new ApiError(401, "HTTP 401");
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

export interface VerseHistoryEntry {
  version: number;
  // 'create' | 'update' | 'baseline' (pre-AI capture) | 'imported' (synthetic
  // anchor for an unedited verse with no log entry).
  action: string;
  // edit_log.source: 'ai_pipeline' | 'dcs_reimport' | 'hint_expansion' | null.
  source: string | null;
  created_at: number;
  user: RowHistoryUser | null;
  plain_text: string | null;
  // Full verse-objects tree at this version, or null when only plain_text was
  // logged (older AI / re-import entries). null ⇒ not restorable.
  content: unknown | null;
  restorable: boolean;
  current: boolean;
}

export interface VerseHistory {
  versions: VerseHistoryEntry[];
}

// One sibling article in a disambiguation group: the full tw_link + its
// human heading (the synonym line that tells the alternatives apart).
export interface DisambiguationOption {
  link: string;
  title: string;
}

export interface Catalogs {
  supportReferences: string[];
  twLinks: string[];
  // Articles that share a word with at least one sibling, grouped. `Index`
  // maps a committed tw_link to its group in `Groups`. Optional so a cached
  // pre-feature payload still validates.
  disambiguationGroups?: DisambiguationOption[][];
  disambiguationIndex?: Record<string, number>;
}

// One per-verse TWL suggestion from GET /api/twl-suggestions/:book/:ch/:v.
// Mirrors api/src/twlSuggest.ts TwlSuggestion.
export interface TwlSuggestion {
  matchedText: string;
  glOccurrence: number;
  articleId: string;
  twLink: string;
  tag: string;
  disambiguation: string[];
}

// TWL suggestion deny-lists from GET /api/twl-filters/:book. Mirrors
// api/src/twlFilters.ts. `unlinked` is global (word+article never linked);
// `deleted` is this book's deleted reference+quote pairs (article-agnostic).
export interface TwlFiltersResponse {
  unlinked: { normOrigWords: string; twLink: string }[];
  deleted: { reference: string; normOrigWords: string }[];
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
  // AI-generated rows (written by the AI pipeline, never human-edited) that were
  // refreshed from master and returned to master-owned. Tracked apart from
  // `updated` so the UI reports them as refreshed, not "skipped (already edited)".
  // Optional: the server always sends it, but an older/cached response may omit it.
  reimported_ai?: number;
  inserted: number;
  skipped_edited: number;
  skipped_locked: number;
  skipped_noop: number;
  // Edited verses whose source-owned `\zaln-s` attrs (x-content/x-lemma/x-morph)
  // were reconciled from master (translator's target text + grouping preserved).
  // Optional: the server always sends it, but an older/cached response may omit it.
  source_attr_reconciled?: number;
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

export type PipelineType = "generate" | "notes" | "tqs" | "translate";

// Translate-pipeline overrides (only meaningful when pipelineType ===
// 'translate'). The server derives the full option set from the active project
// config (buildTranslateOptions) and folds these in; all optional. rowIds
// scopes a single-note / subset translate (INTEGRATION.md §0).
export interface TranslateRequestOptions {
  // Which resource to translate. Row-keyed TSV: 'tn' (default) | 'tq' (book +
  // startChapter scope). Markdown article: 'tw' | 'ta' (articleId/articleUrl
  // scope, no book/chapter). The server picks the matching source repo.
  resourceType?: "tn" | "tq" | "tw" | "ta";
  // Article selector (tw|ta only) — exactly one. articleId is a name
  // ('kt/god', 'translate/figs-aside'); articleUrl a git.door43.org URL.
  articleId?: string;
  articleUrl?: string;
  model?: "sonnet" | "opus";
  delivery?: "path" | "branch";
  branchOnly?: boolean;
  direction?: "ltr" | "rtl";
  rowIds?: string[];
  verseStart?: number;
  verseEnd?: number;
  targetLang?: string;
  targetOrg?: string;
  sourceRef?: string;
  contextRef?: string;
}

// tW / tA markdown article file (article_units). Keyed by (resource, path).
export interface ArticleUnit {
  resource: "tw" | "ta";
  path: string;
  article_id: string;
  part: "body" | "title" | "sub-title";
  source_md: string;
  source_sha: string | null;
  target_md: string | null;
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  draft_meta_json?: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  latest_source?: string | null;
}

// ── Translation preferences & memory (migration 0040) ──
export type TermStatus = "preferred" | "admitted" | "deprecated" | "forbidden" | "do_not_translate";
export type Register = "default" | "formal" | "informal";

export interface TranslationPrefs {
  id: number;
  audience: string | null;
  purpose: string | null;
  register: Register;
  script_notes: string | null;
  instructions_md: string | null;
  notes: string | null;
  assisted_mode: 0 | 1;
  version: number;
  updated_at: number;
  updated_by: number | null;
}
export type TranslationPrefsInput = {
  audience: string | null;
  purpose: string | null;
  register: Register;
  script_notes: string | null;
  instructions_md: string | null;
  notes: string | null;
  assisted_mode: boolean;
};

export interface Term {
  id: number;
  concept_id: string;
  source_term: string;
  target_term: string | null;
  status: TermStatus;
  replacement: string | null;
  comment: string | null;
  tw_link: string | null;
  source_status: string;
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: number | null;
}
export type TermInput = {
  concept_id: string;
  source_term: string;
  target_term?: string | null;
  status?: TermStatus;
  replacement?: string | null;
  comment?: string | null;
  tw_link?: string | null;
};
export interface TermImportResult {
  dryRun: boolean;
  added: number;
  updated: number;
  total: number;
  parseErrors: { line: number; message: string }[];
}
export interface TranslationExample {
  id: string;
  book: string;
  ref_raw: string;
  support_reference?: string | null;
  quote: string | null;
  occurrence: number | null;
  note?: string | null;
  question?: string | null;
  response?: string | null;
  translation_state: string;
  updated_at: number;
}

// Lightweight rail item (source_md/target_md excluded server-side for weight).
export interface ArticleUnitMeta {
  resource: "tw" | "ta";
  path: string;
  article_id: string;
  part: "body" | "title" | "sub-title";
  source_sha: string | null;
  translation_state: "ai_draft" | "edited" | "validated" | null;
  version: number;
  updated_at: number;
  has_target: 0 | 1;
  latest_source?: string | null;
}

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
  // Optional for article translate jobs (tw/ta), which are scoped by
  // translate.articleId, not book/chapter. Row-keyed jobs (generate/notes/
  // tqs and tn/tq translate) still pass both.
  book?: string;
  startChapter?: number;
  endChapter?: number;
  sessionKey: string;
  options?: PipelineRequestOptions;
  /**
   * Translate-pipeline overrides (only meaningful when pipelineType ===
   * 'translate'; ignored otherwise). The server builds the full option set
   * from the active project config and folds these in.
   */
  translate?: TranslateRequestOptions;
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
  /**
   * DCS username of whoever requested the run. Populated on the shared-queue
   * list for jobs that aren't the current user's, so the chip can attribute
   * them ("requested by X"). Undefined/null on the current user's own rows.
   */
  started_by_username?: string | null;
}

// Global queue context returned alongside GET /api/pipelines so the chip can
// render "what's running ahead of you". activeJob reuses the conflict-dialog
// shape (it's the single job currently on the bot, or null when idle).
export interface PipelineQueueSummary {
  activeJob: PipelineConflictExisting | null;
  queuedCount: number;
}

// Per-project source configuration (api/src/projectConfig.ts). Drives UI
// labels, direction, the language-pair switcher, and — via translationSource —
// whether translation-mode UI is shown at all. The English root project has
// translationSource === null.
export interface GlBiblePane {
  repo: string;
  version: string;
  title: string;
}
export interface ProjectConfig {
  preset: string;
  org: string;
  exportOrg: string;
  languageCode: string;
  languageName: string;
  languageTitle: string;
  direction: "ltr" | "rtl";
  repos: Record<string, string>;
  litLabel: string;
  simLabel: string;
  origHebrewLabel: string;
  origGreekLabel: string;
  glBibles: GlBiblePane[];
  translationSource: {
    org: string;
    languageCode: string;
    repos: Record<string, string>;
  } | null;
  reposVerified: boolean;
}
export interface ProjectConfigResponse {
  config: ProjectConfig;
  presets: Array<{
    preset: string;
    org: string;
    languageCode: string;
    languageName: string;
    languageTitle: string;
    direction: "ltr" | "rtl";
    reposVerified: boolean;
  }>;
}

export const api = {
  getBookSummary: (book: string, signal?: AbortSignal) =>
    request<BookSummary>(`/api/chapters/${encodeURIComponent(book)}`, { signal }),

  getChapter: (book: string, chapter: number, signal?: AbortSignal) =>
    request<ChapterPayload>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}`,
      { signal },
    ),

  // DCS-validation summary for a book (issues that need a human decision).
  // Book-level, fetched once per book change by useBookLint.
  getBookLint: (book: string, signal?: AbortSignal) =>
    request<BookLintReport>(`/api/books/${encodeURIComponent(book)}/lint`, { signal }),

  getCatalogs: () => request<Catalogs>(`/api/catalogs`),

  // Per-verse TWL suggestions (links the verse doesn't already carry). The
  // server scans the ULT with the en_tw headword matcher; the client resolves
  // each match's English span to an OL quote + occurrence via twlResolve.
  getTwlSuggestions: (book: string, chapter: number, verse: number, signal?: AbortSignal) =>
    request<{ suggestions: TwlSuggestion[] }>(
      `/api/twl-suggestions/${encodeURIComponent(book)}/${chapter}/${verse}`,
      { signal },
    ),

  // TWL suggestion deny-lists for a book (global unlinked word+article pairs +
  // this book's deleted reference+quotes). Fetched once per book change by
  // useTwlFilters; the client folds + compares against resolved OL quotes.
  getTwlFilters: (book: string, signal?: AbortSignal) =>
    request<TwlFiltersResponse>(`/api/twl-filters/${encodeURIComponent(book)}`, { signal }),

  getNoteTemplates: () => request<NoteTemplatesResponse>(`/api/note-templates`),

  // Active per-project source config (org/language/direction/labels +
  // translationSource). Readable by any authenticated user; drives the
  // translation-mode UI gate. Fetched once per session by useProjectConfig.
  getProjectConfig: () => request<ProjectConfigResponse>(`/api/project-config`),

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

  // Toggle my checkoff stamp on one (verse, lane). Returns the full checker set.
  setLaneCheck: (book: string, chapter: number, verse: number, lane: CheckLane, checked: boolean) =>
    request<LaneCheckState>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/${verse}/lanes/${lane}`,
      { method: "PATCH", body: JSON.stringify({ checked }) },
    ),

  // Bulk "I'm done with <lane> for the chapter": apply across the given verses
  // (client supplies the applicable list). Returns the chapter+lane check set.
  setLaneCheckBulk: (book: string, chapter: number, lane: CheckLane, checked: boolean, verses: number[]) =>
    request<{ book: string; chapter: number; lane: CheckLane; checks: VerseLaneCheck[] }>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/lanes/${lane}/bulk`,
      { method: "PATCH", body: JSON.stringify({ checked, verses }) },
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

  // Translation-mode "Approve" action. value=true → translation_state
  // 'validated'; value=false → 'edited' (un-approve). Lock-exempt, non-version-
  // bumping, mirrors setPreserveNote. Returns the updated row so the caller can
  // refresh local state (the collapsed/green treatment keys off the new state).
  validateNote: (id: string, book: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/validate?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // Translation-mode "Approve" for translationQuestions — the tQ analogue of
  // validateNote. value=true → 'validated'; value=false → 'edited'.
  validateQuestion: (id: string, book: string, value: boolean) =>
    request<TqRow>(`/api/rows/tq/${encodeURIComponent(id)}/validate?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // ── tW / tA articles ──
  // Rail list (metadata only; source_md/target_md excluded server-side).
  getArticles: (resource: "tw" | "ta") =>
    request<{ resource: string; units: ArticleUnitMeta[] }>(`/api/articles/${resource}`),

  // Full unit (source_md + target_md) for the editor.
  getArticle: (resource: "tw" | "ta", path: string) =>
    request<ArticleUnit>(`/api/articles/${resource}/unit?path=${encodeURIComponent(path)}`),

  // Save the translation. If-Match version CAS (409 on mismatch). Editing an
  // ai_draft/validated unit demotes it to 'edited' server-side.
  patchArticle: (resource: "tw" | "ta", path: string, expectedVersion: number, targetMd: string) =>
    request<ArticleUnit>(`/api/articles/${resource}/unit?path=${encodeURIComponent(path)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify({ target_md: targetMd }),
    }),

  // "Approve" — value=true → 'validated'; value=false → 'edited'. Non-version-bumping.
  validateArticle: (resource: "tw" | "ta", path: string, value: boolean) =>
    request<ArticleUnit>(`/api/articles/${resource}/unit/validate?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // ── Translation preferences & memory (migration 0040) ──
  getTranslationPrefs: () => request<{ prefs: TranslationPrefs }>(`/api/translation-memory/prefs`),
  putTranslationPrefs: (expectedVersion: number, patch: Partial<TranslationPrefsInput>) =>
    request<{ prefs: TranslationPrefs }>(`/api/translation-memory/prefs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify(patch),
    }),
  getTerms: (opts?: { status?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.q) qs.set("q", opts.q);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<{ terms: Term[] }>(`/api/translation-memory/terms${suffix}`);
  },
  getTermsCount: () => request<{ count: number }>(`/api/translation-memory/terms/count`),
  createTerm: (body: TermInput) =>
    request<Term>(`/api/translation-memory/terms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  patchTerm: (id: number, expectedVersion: number, patch: Partial<TermInput>) =>
    request<Term>(`/api/translation-memory/terms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify(patch),
    }),
  deleteTerm: (id: number) =>
    request<{ ok: boolean }>(`/api/translation-memory/terms/${id}`, { method: "DELETE" }),
  importTerms: (csvText: string, dryRun: boolean) =>
    request<TermImportResult>(`/api/translation-memory/terms/import${dryRun ? "?dryRun=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csvText,
    }),
  // CSV export is a plain GET (cookie-auth, same-origin); the caller downloads
  // this URL via an anchor rather than parsing a JSON body.
  termsExportPath: () => `/api/translation-memory/terms/export`,
  getExamples: (opts: { resource: "tn" | "tq"; supportReference?: string; q?: string; limit?: number }) => {
    const qs = new URLSearchParams({ resource: opts.resource });
    if (opts.supportReference) qs.set("supportReference", opts.supportReference);
    if (opts.q) qs.set("q", opts.q);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return request<{ resource: string; examples: TranslationExample[] }>(
      `/api/translation-memory/examples?${qs}`,
    );
  },

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

  // Verse version history (ULT/UST), reconstructed from the edit_log audit
  // trail server-side. requireEditor — same gate as note history. Mirrors
  // getRowHistory above.
  getVerseHistory: (book: string, chapter: number, verse: number, bibleVersion: string) =>
    request<VerseHistory>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}/history`,
    ),

  patchVerse: <T = unknown>(
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    expectedVersion: number,
    payload: { content: unknown; plain_text?: string | null; alignment_intent?: AlignmentIntent },
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

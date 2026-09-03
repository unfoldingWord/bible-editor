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
  sort_order: number | null;
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

// Result of creating a verse bridge (merge-with-next). `verse` is the combined
// bridge row; `removed_verse` is the absorbed row's start key to drop locally;
// `removed_version` is the version that row had when it was deleted (the
// tombstone clock — see lib/verseStructure.ts); `absorbed_verses` are all the
// verse numbers that row covered (for pruning orphaned status / lane checks).
export interface MergeBridgeResult {
  verse: VerseDto;
  removed_verse: number;
  removed_version: number;
  absorbed_verses: number[];
}

// Result of breaking a verse bridge. `verse` is the de-bridged start row (all
// content retained); `new_verses` are the freshly seeded empty singletons.
export interface SplitBridgeResult {
  verse: VerseDto;
  new_verses: VerseDto[];
}

export type AlignmentIntent =
  | "text_edit"
  | "find_replace"
  | "section_edit"
  | "alignment_edit"
  // Issue #575: an escalated "Save anyway" on a text_edit — see
  // web/src/lib/alignmentDelta.ts for the full rationale.
  | "confirmed_text_edit";

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

// A verse whose TWL link order a human has taken over. Its presence is the whole
// manual/automatic switch: automatic (ULT-alignment) ordering skips this verse in
// the app, in the nightly export, and in the reimport post-pass, so the stored
// sort_order stands. `dismissed_order` is the automatic id sequence at the moment
// the user last said "keep mine" — the "automatic order differs" hint stays quiet
// until automatic ordering proposes something different from it.
export interface TwlOrderLock {
  verse: number;
  locked_by: number;
  locked_at: number;
  dismissed_order: string | null;
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
  // Optional so a web build running against an older API (which doesn't send the
  // field) simply behaves as "no verse is locked" — today's behaviour.
  twlOrderLocks?: TwlOrderLock[];
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
// is present for tn/tq/twl findings so the UI can jump straight to the
// offending row (Shell's goToLintIssue); ult/ust findings are whole-verse USFM
// checks and carry no rowId.
// `dismissible`/`door43`/`ours`/`reviewKind`/`reviewReason` are present ONLY on
// review_kind-derived issues (the nightly-merge "verify this" flags) — never
// on the mechanical/USFM integrity checks, which have no flag to dismiss (see
// lint.ts's LintIssue for the server-side detail). `door43` is Door43's row
// value at flag time (or null when absent/unparseable — the migration that
// populates it may not be applied yet); `ours` holds the same fields from the
// live row, so the popup can show what changed. `reviewKind`/`reviewReason`
// identify which specific review flag this issue represents (a row can carry
// several independent findings with the same rowId) — sent back on dismiss so
// the server only clears the flag the popup was actually looking at, not
// every flag on the row (`reviewReason` closes a second race the kind alone
// can't: a same-kind re-stamp with different content, see PR #664).
//
// `reviewReason` is `string | null | undefined` with THREE distinct meanings
// — undefined never occurs on a dismissible issue (it's always sent, `null`
// included) but the type allows it for a non-dismissible issue, where the
// whole field is absent. `null` means "this flag genuinely has no reason" —
// a real, distinct observation from "no token was sent". Collapsing null to
// undefined here was the bug PR #664's Codex re-verify caught (the
// absent-vs-wrong trap, see docs/sync-attribution-handoff.md): a null-reason
// flag's dismiss would omit the token entirely, so the server's guard never
// fired, and a stale dismiss could clear a LATER same-kind re-stamp that DID
// have a reason. Always pass reviewReason through to dismissReviewFlag
// exactly as received, never `?? undefined` / `|| undefined` it away.
export interface BookLintIssue {
  check: string;
  bucket: "flag" | "escalate";
  ref: string;
  rowId?: string;
  message: string;
  resource: "tn" | "tq" | "twl" | "ult" | "ust";
  dismissible?: boolean;
  door43?: Record<string, unknown> | null;
  ours?: Record<string, unknown>;
  reviewKind?: string;
  reviewReason?: string | null;
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

// Read-only flags — two independent reasons the app can be read-only, kept
// as separate named switches so they never clobber each other: "viewer" is
// set when the current JWT carries role='viewer', "bookLocked" is set when
// the currently-open book is locked (published, or locked by hand). The
// outbox checks isReadOnly() before enqueueing a write so editor UI
// components that haven't been individually gated still can't trigger 403s.
// UI components that want to disable inputs can read isReadOnly() directly.
export type ReadOnlyReason = "viewer" | "bookLocked";
const readOnlyReasons = new Set<ReadOnlyReason>();
export function isReadOnly(): boolean {
  return readOnlyReasons.size > 0;
}
// Narrower than isReadOnly(): true only for the global viewer role, never for
// a locked book. request()'s write short-circuit must use this, not
// isReadOnly() — a locked book still allows two things server-side: comment
// writes and lock/unlock calls themselves. Blanket-blocking every non-GET on
// isReadOnly() broke both (a lock admin couldn't unlock, since lockBook/
// unlockBook went through request() and got thrown client-side as a fake 403
// before ever reaching the server). isReadOnly() itself keeps gating the
// outbox/draft stores below — those only carry content edits, which must
// stay frozen for a locked book.
export function isViewerReadOnly(): boolean {
  return readOnlyReasons.has("viewer");
}
export function setReadOnlyReason(reason: ReadOnlyReason, active: boolean) {
  if (active) readOnlyReasons.add(reason);
  else readOnlyReasons.delete(reason);
}

// Current user's role — set alongside readOnly, right after /api/auth/me
// resolves. The JWT is HttpOnly so the client can never decode it directly;
// this module-level flag is the only place a role lives client-side.
// Components (e.g. TopBar's admin button) read this directly rather than
// having the role threaded down as a prop through Shell.
let currentRole: Role | null = null;
export function getRole(): Role | null {
  return currentRole;
}
export function setRole(v: Role | null) {
  currentRole = v;
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
  // Viewer accounts: short-circuit anything that isn't a GET so the server
  // never sees a write attempt. ApiError(403, "read_only") is a distinct
  // sentinel callers can detect; the outbox already treats 403 as fatal so
  // it won't loop. Deliberately isViewerReadOnly(), NOT isReadOnly(): a
  // locked book must still reach the server for comment writes and for
  // lock/unlock itself (lockBook/unlockBook are how a lock admin unlocks a
  // book at all) — the server, not this client-side guard, is the authority
  // there and returns 423 for actual content writes to a locked book. A
  // blanket isReadOnly() check here previously threw a fake 403 on those
  // calls before they ever left the browser, which made unlocking impossible.
  const method = (init?.method ?? "GET").toUpperCase();
  if (isViewerReadOnly() && method !== "GET" && method !== "HEAD") {
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
  // Origin of the alert, e.g. "comment_mention" / "comment_reply" (routed to
  // the top-right notifications menu) vs export-failure sources (full-width
  // banner). See App.tsx for the split.
  source: string;
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

// One ULT/UST verse the last nightly export found with lost word alignment.
// `ref` is the display form ("8:4" or "3:5-7" for a verse bridge); `chapter`/
// `verse` are its navigable parse (verse is the bridge's leading verse).
export interface AlignAttentionRef {
  resource: "ult" | "ust";
  ref: string;
  chapter: number;
  verse: number;
  lostWords: string[];
  provenance: string | null;
}

// GET /api/alignment-attention/:book — verses the last nightly export flagged
// as having lost word alignment. This is a point-in-time snapshot from that
// run, not live truth: a translator who has since fixed the verse still shows
// up here until the badge's caller re-derives that locally (see
// useAlignmentAttention / AlignAttentionIndicator's resolvedKeys filtering).
export async function fetchAlignmentAttention(book: string): Promise<AlignAttentionRef[]> {
  try {
    const res = await request<{ refs: AlignAttentionRef[] }>(
      `/api/alignment-attention/${encodeURIComponent(book)}`,
    );
    return res.refs;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return [];
    throw err;
  }
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
  // tw_link → TW article title. Feeds canonicalTwlOrder's headword anchoring
  // (twlCanonicalOrder.ts). Optional so a client hitting an older server (or a
  // cached pre-feature payload) still validates and falls back to tier 2/3.
  twTitles?: Record<string, string>;
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

// A verse's worth of raw TWL suggestions, grouped for the verse-aware panel.
// The Suggestions panel scans every verse of a verse bridge (each via the
// per-verse route) and carries the verse alongside so "Add" can place the link
// on the verse it was scanned from, and the committed-row alternatives merge
// can grab the right verse's alignment.
export interface TwlVerseSuggestions {
  verse: number;
  suggestions: TwlSuggestion[];
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
  locked: boolean;
  lockReason: string | null;
  lockSource: "published" | "explicit" | null;
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
  // Verse whose content was adopted from master via computeVerseMerge (master
  // moved out-of-band on Door43 since our last export). See bookReimport.ts /
  // verseMerge.ts. Optional: older/cached responses may omit it.
  merge_adopted?: number;
  // Verse flagged for human review after a merge (both D1 and master moved,
  // or adopting would have lost alignment). Optional, same reason as above.
  merge_conflicts?: number;
  // The rows this run flagged for human review as a merge conflict — the number
  // the "Pull from Door43" summary renders as "flagged for review (merge
  // conflict)". Read this directly rather than subtracting merge_kept_ai from
  // merge_conflicts: that subtraction only holds on the verse side, and cancelled
  // a real TSV master-wins flag against an unrelated kept-alone row (#706). See
  // bookReimport.ts for the exact set. Optional, same reason as above.
  merge_master_wins?: number;
  // Merge refused to adopt master's edit specifically because it would have
  // lost alignment — a subset of merge_conflicts. Optional, diagnostic.
  merge_refused?: number;
  // Both sides moved since the ancestor, but every Door43 commit to the file
  // since then came from Bible Editor's own export or the unfoldingWord bot
  // account — so the app edit was KEPT and flagged instead of overwritten (issue
  // #540 item 2). A subset of merge_conflicts for VERSES; for tn/tq/twl rows the
  // two only overlap when the same row also adopted a field master moved on its
  // own, because merge_conflicts is incremented there only for an adopting write.
  // This counter does not itself withhold the export (merge_refused does, at
  // scale) — but other gates in the same run still can. Optional, diagnostic.
  merge_kept_ai?: number;
  // Merge attempted but no ancestor was recoverable for this verse from before
  // the book+resource's master-confirmed watermark. D1 was kept, the
  // pre-existing safe default. Optional, diagnostic.
  //
  // Do NOT restate this as "edit_log aged past retention", which is what this
  // comment used to say: measured in prod on 2026-08-19, edit_log spanned 93
  // days, so the 180-day sweep had deleted nothing and explained none of the
  // 190 verses then in this state. Aging out is one possible limb of three (see
  // buildNoBaseSentence in api/src/verseMergeEditorAlerts.ts); the measured
  // fact is only that no ancestor was recoverable.
  merge_no_base?: number;
  // A tn/tq/twl row whose Reference differs between D1 and Door43, split by
  // which side moved it relative to the last published ancestor (see
  // api/src/tsvMerge.ts's classifyTsvRefMove). `ours` is an ordinary app edit
  // the export publishes — no flag, no hold. The other three withhold the
  // resource watermark and flag the row. Optional, diagnostic.
  ref_moved_ours?: number;
  ref_moved_ours_conflict?: number;
  ref_moved_theirs?: number;
  ref_moved_both?: number;
  ref_moved_unattributable?: number;
  // A row whose reference-move flag the run CLEARED because the two sides agree
  // again — a flag-only, version-neutral write that makes a resolved cleanup chip
  // disappear (issue #588). Not a move: it is counted apart from the four above
  // precisely so a resolved flag never reads as a fresh divergence. Optional,
  // diagnostic.
  ref_moved_resolved?: number;
  merge_unavailable?: number;
  // A "keep_converged" verse whose RAW content_json actually differed — a
  // genuine, cosmetic-only Door43 edit that verseMerge.ts's whitespace-
  // insensitive comparison treats as "no change" (and every nightly export
  // then reverts). Optional, diagnostic — see bookReimport.ts's field doc.
  merge_cosmetic_ignored?: number;
  // The same class as `merge_cosmetic_ignored`, on the other side of the corpus:
  // a PRISTINE or AI-only verse whose master bytes differ from D1's only by
  // artifacts the verse-merge lens normalizes away (issue #609), so the sync
  // wrote nothing instead of bumping its version for the Nth consecutive night.
  // Optional, diagnostic — see api/src/bookReimport.ts's field doc.
  skipped_normalized?: number;
  // Issue #639. A whole verse file (ult/ust) the sync REFUSED because Door43's
  // copy is a wholesale translationCore re-export taken from a snapshot older
  // than the state the app last synced from master — adopting it would revert
  // everything that landed in between. Nothing was written for that resource and
  // its watermark was withheld, so the export cannot republish the revert.
  // `stale_base_overridden` is the same detection with an operator's explicit
  // allowStaleBase override, i.e. master WAS adopted anyway. Optional,
  // diagnostic — see api/src/staleBaseGate.ts.
  stale_base_held?: number;
  stale_base_overridden?: number;
  // Door43 master held EXACTLY the file our last export pushed, so master moved
  // because our own `-be-` branch merged, not because anyone edited master — and
  // the merge ancestor was corrected accordingly. Before this was recognized,
  // that situation is what made the sync overwrite app edits (see
  // api/src/ownPublish.ts). Optional, diagnostic.
  own_publish_converged?: number;
  // Master rows this run could NOT land because their (book, id) primary key is
  // already held in D1 — soft-deleted rows keep their id forever. `conflict_
  // skipped` is the INSERT ... ON CONFLICT DO NOTHING refusal; `tombstone_
  // blocked` is a tombstone whose id master has reissued to a row at a
  // DIFFERENT reference and whose automatic reclaim (see tombstone_reclaimed
  // below) lost the version-CAS race (a same-reference tombstone is an
  // ordinary delete awaiting export and is not counted). Either being non-zero
  // also withholds the (book, resource) sync watermark, so the book is not
  // certified current. See api/src/reimportClassify.ts and GitHub issue #427.
  // Optional: an older/cached response may omit them.
  conflict_skipped?: number;
  tombstone_blocked?: number;
  // A reissued tombstone (see tombstone_blocked above) whose slot this run
  // successfully reclaimed for master — deleted_at cleared, content/reference
  // set to master's incoming row, ownership reset to master-owned (issue #427,
  // option 1). Distinct from tombstone_blocked: a landed reclaim means master's
  // row IS now in D1, so it does NOT withhold the watermark by itself. See
  // api/src/bookReimport.ts's tombstone branch of applyTsvRows. Optional: an
  // older/cached response may omit it.
  tombstone_reclaimed?: number;
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
  | "import_failed"
  | "force_stopped";

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
    // Free-form on purpose. Verified against the real bot: it passes the
    // checkpoint's own value through untouched, and that includes at least
    // 'pending', 'chapter_succeeded', 'skipped', 'done' and
    // 'paused_before_at_generation' — none of which a closed union listed. The
    // value is only ever displayed / stored as text, so widen rather than
    // pretend.
    status: string;
    // Optional: the bot omits it on a checkpoint with no timing stamp.
    startedAt?: string;
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
  /**
   * Resources this run will overwrite when it lands — its own pipeline type
   * plus any pending chain steps ("generate everything" = generate → notes →
   * tqs). Server-derived (api/src/chapterLock.ts is the only copy of the map),
   * and what the editor locks. Absent on optimistic rows minted locally by
   * pipelineStore.start() before the first list refresh.
   */
  locks_resources?: ("verse" | "tn" | "tq" | "twl")[];
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

// ── Internal comments & notes (see api/migrations/0037_comments.sql) ──
// D1-only, never exported. GET is a separate fetch (not part of ChapterPayload)
// so a comments failure degrades gracefully without breaking chapter load.

export type CommentKind = "question" | "note";
export type CommentRowKind = "tn" | "tq" | "twl";

export interface CommentDto {
  id: number;
  book: string;
  chapter: number;
  verse: number;
  rowKind: CommentRowKind | null; // null => anchored to the verse itself
  rowId: string | null;
  parentId: number | null; // null => top-level; else a flat reply
  kind: CommentKind;
  body: string;
  mentions: string[]; // canonical dcs_usernames
  authorId: number;
  authorName: string;
  createdAt: number; // unix seconds
  updatedAt: number;
  resolvedAt: number | null;
  resolvedBy: number | null;
  resolvedByName: string | null;
  deletedAt: number | null;
}

export interface MentionUser {
  id: number;
  username: string;
  fullName: string;
}

export interface NewCommentInput {
  book: string;
  chapter: number;
  verse: number;
  rowKind?: CommentRowKind;
  rowId?: string;
  parentId?: number;
  kind: CommentKind;
  body: string;
}

// One location in a book that has open (unresolved) comment threads. Powers
// the TopBar "notes in this book" indicator (issue #441).
export interface BookCommentLocation {
  chapter: number;
  verse: number;
  rowKind: CommentRowKind | null;
  kind: CommentKind;
  count: number;
}

export interface BookCommentSummary {
  locations: BookCommentLocation[];
  questions: number;
  notes: number;
  total: number;
}

// ── Admin panel (see web/src/components/AdminPanel.tsx) ────────────────────
// Types mirror the backend contract in AdminPanel's task spec; the two sides
// are being built together against that shared contract.

export type Resource = "ult" | "ust" | "tn" | "tq" | "twl";

// Per-book, per-resource sync snapshot: what we last pulled from Door43 vs.
// what we last exported to it. null when the book has never touched that
// resource at all.
export interface AdminResourceSyncStatus {
  pulledSha: string | null;
  pulledAt: number | null;
  pullOrigin: string | null;
  lastExportAt: number | null;
  lastExportSha: string | null;
  lastExportError: string | null;
  lastExportRows: number | null;
  branch: string | null;
  prNumber: number | null;
}

export interface AdminBookSyncStatus {
  book: string;
  importedAt: number | null;
  // Frozen from editing AND export (published, or explicitly locked). A
  // locked book will never push to Door43, so the grid has to say so or its
  // export cells look mysteriously stuck.
  locked: boolean;
  resources: Record<Resource, AdminResourceSyncStatus | null>;
}

export interface AdminSyncStatusResponse {
  books: AdminBookSyncStatus[];
}

// GET /api/admin/sync-activity — durable, admin-only log of non-blocking
// "record"-kind alerts (issue #535), e.g. "shipped to Door43 and overwrote
// master's content as expected". These no longer appear in fetchAlerts()'s
// personal feed since they need no decision from anyone.
export interface AdminSyncActivityEntry {
  id: number;
  severity: AlertSeverity;
  source: string;
  message: string;
  linkUrl: string | null;
  createdAt: number;
}

export interface AdminSyncActivityResponse {
  entries: AdminSyncActivityEntry[];
}

export type AdminCheckState = "success" | "failure" | "pending" | null;

export interface AdminPr {
  resource: Resource;
  repo: string;
  book: string;
  number: number;
  title: string;
  branch: string;
  headSha: string;
  baseRef: string;
  mergeable: boolean | null;
  url: string;
  checkState: AdminCheckState;
  updatedAt: number;
}

export interface AdminPrsResponse {
  prs: AdminPr[];
  errors: { repo: string; message: string }[];
}

export interface AdminUser {
  username: string;
  role: "admin" | "editor";
  addedAt: number;
  addedBy: string | null;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

// Mirrors the inline import `result` shape from the task spec. Every field
// is a plain counter except `errors` (message list) and `counts_incomplete`
// (best-effort flag the server sets when it had to bail early).
export interface AdminImportCounts {
  updated: number;
  reimported_ai: number;
  inserted: number;
  deleted: number;
  merged_fields: number;
  // Pristine tn/tq/twl row whose content matched master exactly but whose
  // sort_order didn't, written via a version-neutral statement (issue #610).
  // Optional: an older/cached response may omit it.
  reordered?: number;
  skipped_edited: number;
  skipped_locked: number;
  chapters_locked: number;
  prune_locked: number;
  skipped_noop: number;
  skipped_dup: number;
  // See ReimportCounts above — master rows dropped because their (book, id)
  // primary key was already held (issue #427). Non-zero withholds the sync
  // watermark. Optional: an older/cached response may omit them.
  conflict_skipped?: number;
  tombstone_blocked?: number;
  // See ReimportCounts.tombstone_reclaimed above — a reissued tombstone's slot
  // successfully reclaimed for master (issue #427, option 1). Does NOT withhold
  // the watermark by itself. Optional: an older/cached response may omit it.
  tombstone_reclaimed?: number;
  resurrected: number;
  source_attr_reconciled: number;
  source_attr_divergent: number;
  twl_reordered: number;
  dcs_404: number;
  errors: string[];
  counts_incomplete?: boolean;
}

export interface AdminImportResult {
  book: string;
  perResource: Record<Resource, AdminImportCounts>;
  totals: AdminImportCounts;
}

// POST /api/admin/import responds 200 with mode:"inline" when `chapters` was
// given (the result is ready immediately), or 202 with mode:"workflow" for a
// whole-book import (poll the Workflow instance endpoint instead).
export type AdminImportResponse =
  | { mode: "inline"; result: AdminImportResult }
  | { mode: "workflow"; id: string };

// POST /api/exports/run — reuses the existing export pipeline. `book`/
// `resource` omitted means "everything"; `dryDcs` renders without writing to
// Door43; `allowShrink` overrides the row-deletion guard.
export interface RunExportRequest {
  book?: string;
  resource?: Resource;
  dryDcs?: boolean;
  validateAndMerge?: boolean;
  allowShrink?: boolean;
  // Override the book-lock gate, for a deliberate fix to a frozen (published or
  // explicitly locked) book. Honored only for a single named book AND resource.
  allowLocked?: boolean;
  // Land the export on this branch instead of the generated `{BOOK}-be-…`.
  // Must not contain `-be-` (that substring is what makes DCS auto-merge), so
  // this is how a published-book fix becomes a PR a maintainer reviews rather
  // than a commit on master. Server 400s with `invalid_branch_name` on a bad one.
  branchName?: string;
}

export interface RunExportResponse {
  id: string;
  status: string;
}

// The branch a locked-book fix is staged on, PER BOOK. Used by every surface that
// can stage one (the admin Run tab and the book-locks push prompt) so the name is
// recognizable to whoever finds it on Door43.
//
// The book code is not decoration — a single shared name silently destroys work.
// commitToDcs calls resetExportBranchToMaster unconditionally, which force-moves
// the branch ref to master's SHA, and ensureDcsPr reuses any open PR for that head
// (title and body are written only at creation). So staging MIC tn and then HOS tn
// on one shared branch, in the one en_tn repo, would reset away MIC's commit and
// leave the maintainer reviewing a PR still titled MIC whose diff is HOS — with no
// error anywhere. Per-book names cannot collide; re-staging the SAME book is the
// case where reset-and-reuse is exactly right.
//
// Stays free of the `-be-` substring (the pattern DCS auto-merges): book codes are
// uppercase and the check is case-sensitive, so no code can introduce it.
export function reviewBranchFor(book: string): string {
  return `BibleEditor-restoration-${book.toUpperCase()}`;
}

// POST /api/books/:book/lock/push — one Workflow instance per resource, since
// the server only honors `allowLocked` for an exactly-one-book-one-resource
// run. Each entry is either the created instance id or a create failure.
export type PushLockedBookResult =
  | { resource: Resource; instanceId: string }
  | { resource: Resource; error: string };

export interface PushLockedBookResponse {
  book: string;
  pushed: PushLockedBookResult[];
}

// GET /api/exports?book=&limit= — snapshot rows from past export runs.
// This route predates the admin panel and returns `export_snapshots` rows
// verbatim, so the field names are the D1 column names (snake_case) and the
// array key is `snapshots`. Mirror the server exactly rather than inventing a
// camelCase shape — there is no mapping layer between them.
export interface ExportSnapshotRow {
  id: number;
  book: string;
  resource: Resource;
  branch: string | null;
  commit_sha: string | null;
  committed_at: number;
  rows_exported: number | null;
  // Doubles as the skip-reason channel: `unchanged`, `no_rows`, `dry_run` and
  // the various `*_guard:` prefixes all arrive here, not just real failures.
  error: string | null;
  pr_number: number | null;
  pr_error: string | null;
}

export interface ExportsListResponse {
  snapshots: ExportSnapshotRow[];
}

// GET /api/exports/instance/:id — Workflow status for a run started via
// either /api/exports/run or the whole-book admin import.
// The route returns the Cloudflare Workflow instance's own status object
// verbatim under `status`, so this is NESTED: `status.status` is the state
// string ("queued" | "running" | "complete" | "errored" | …). There is no
// per-step list — Workflows expose only the aggregate state plus the final
// `output`, so the panel reports the state and the output, not a step trace.
export interface ExportInstanceStatus {
  id: string;
  status: {
    status: string;
    output?: unknown;
    error?: unknown;
  };
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

  getBooks: () => request<{ books: BookListEntry[]; canManageLocks: boolean }>(`/api/books`),

  // Lock/unlock a book. Only the three lock admins can call these — the
  // server 403s with { error: "forbidden", reason: "not_a_lock_admin" }
  // otherwise. Any write to a locked book (including this one, for a
  // book locked by a different admin's reason) 423s server-side.
  lockBook: (book: string, reason?: string) =>
    request<{ ok: true }>(`/api/books/${encodeURIComponent(book)}/lock`, {
      method: "PUT",
      body: JSON.stringify(reason !== undefined ? { reason } : {}),
    }),

  unlockBook: (book: string) =>
    request<{ ok: true }>(`/api/books/${encodeURIComponent(book)}/lock`, {
      method: "DELETE",
    }),

  // Push a currently-locked book to Door43 right now, across every resource,
  // instead of waiting for the nightly export. Same lock-admin gate as
  // lockBook/unlockBook above (not requireAdmin) — server 400s with
  // { error: "book_not_locked" } if called on an unlocked book.
  // `branchName` switches the intent from "publish now" (default: pushes to the
  // generated `-be-` branch, which DCS auto-merges onto master) to "stage for
  // review" (pushes to the named branch, no auto-merge, PR left for a
  // maintainer). Use it for a PUBLISHED book, where re-cutting the release is
  // the maintainer's call, not ours.
  pushLockedBookToDoor43: (book: string, branchName?: string) =>
    request<PushLockedBookResponse>(`/api/books/${encodeURIComponent(book)}/lock/push`, {
      method: "POST",
      ...(branchName ? { body: JSON.stringify({ branchName }) } : {}),
    }),

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

  // --- TWL manual-order lock (see TwlOrderLock) ---
  // Take a verse's TW link order manual. Awaited BEFORE the reorder itself is
  // enqueued: if the lock doesn't land, the move would be silently reverted by
  // the next automatic pass, which is the exact failure this feature exists to
  // prevent (STATE.md, the HOS reorder revert).
  lockTwlOrder: (book: string, chapter: number, verse: number) =>
    request<TwlOrderLock>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/twl-order-lock`,
      { method: "PUT", body: JSON.stringify({ verse }) },
    ),

  // Hand the verse back to automatic ordering. The server also re-sequences that
  // verse's sort_order to the automatic order on the way out, so Door43 agrees at
  // the next export rather than the night after.
  unlockTwlOrder: (book: string, chapter: number, verse: number) =>
    request<null>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/twl-order-lock?verse=${verse}`,
      { method: "DELETE" },
    ),

  // "Keep mine": remember the automatic order we just declined, so the hint stays
  // quiet until automatic ordering proposes something genuinely different.
  dismissTwlOrderSuggestion: (book: string, chapter: number, verse: number, dismissed_order: string) =>
    request<TwlOrderLock>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/twl-order-lock`,
      { method: "PATCH", body: JSON.stringify({ verse, dismissed_order }) },
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

  // Clears a dismissible book-lint "review" flag without changing the row
  // itself (issue #653 direction 2). Contract'd by the companion API PR
  // (POST /api/rows/:kind/:id/dismiss-review, body {book, review_kind?,
  // review_reason?}) — that PR, and PR #664 (the stale-popup race fixes
  // reviewKind/reviewReason close), are the source of truth if this drifts.
  // `reviewKind`/`reviewReason` are both optional and independent: when
  // given, the server only clears the flag whose stored value(s) still match
  // what the caller was looking at, instead of every review flag on the row
  // (a row can carry several) or a DIFFERENT flag of the same kind that was
  // re-stamped with new content since the caller last saw it. Returns the
  // fresh row.
  //
  // Both spreads key on `!== undefined`, NEVER truthiness: reviewReason is
  // `string | null`, and `null` ("this flag has no reason") is a value the
  // server's guard must receive and match against, not a falsy signal to
  // drop the key — dropping it is exactly the absent-vs-wrong bug PR #664's
  // Codex re-verify caught (see BookLintIssue's reviewReason doc above). An
  // empty-string reviewKind/reviewReason is likewise a real value, not a
  // reason to omit the key — always pass through what the issue carried.
  dismissReviewFlag: <T = unknown>(
    kind: RowKind,
    book: string,
    id: string,
    reviewKind?: string,
    reviewReason?: string | null,
  ) =>
    request<T>(`/api/rows/${kind}/${encodeURIComponent(id)}/dismiss-review`, {
      method: "POST",
      body: JSON.stringify({
        book,
        ...(reviewKind !== undefined ? { review_kind: reviewKind } : {}),
        ...(reviewReason !== undefined ? { review_reason: reviewReason } : {}),
      }),
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
  // opts.onlyIfBlankStub marks the auto-discard of an abandoned blank stub (as
  // opposed to the user pressing delete). The server re-checks the predicate
  // atomically and 409s `not_blank_stub` if the row gained content since the
  // client decided, so a stale cached row can't bin a collaborator's note.
  trashNote: (id: string, book: string, opts?: { onlyIfBlankStub?: boolean }) =>
    request<TnRow>(
      `/api/rows/tn/${encodeURIComponent(id)}/trash?book=${encodeURIComponent(book)}` +
        (opts?.onlyIfBlankStub ? "&onlyIfBlankStub=1" : ""),
      { method: "POST" },
    ),

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

  // Create a verse bridge: combine `verse` with the following verse into a
  // `\v a-b` block. Both expected versions are sent (two rows are CAS'd) — a
  // 409 echoes { current: { start, next } }. Deliberate POST, not an outbox op.
  mergeVerseBridge: (
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    startVersion: number,
    nextVersion: number,
  ) =>
    request<MergeBridgeResult>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}/bridge`,
      {
        method: "POST",
        body: JSON.stringify({ start_version: startVersion, next_version: nextVersion }),
      },
    ),

  // Break a verse bridge: split `verse` (a `\v a-b` row) back into separate
  // verses, keeping all text in the first. Single-row CAS via If-Match.
  splitVerseBridge: (book: string, chapter: number, verse: number, bibleVersion: string, expectedVersion: number) =>
    request<SplitBridgeResult>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}/split`,
      {
        method: "POST",
        headers: { "If-Match": String(expectedVersion) },
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

  // Ask the bot to pick a paused run back up. Server returns 409
  // {error:"cannot_resume"|"resume_refused", state, message?, pausedAgeSeconds?}
  // when the job isn't in a paused state or the bot won't take it, 502 on an
  // upstream failure.
  //
  // `force` bypasses the bot's 90-minute pause box and is DEFAULT FALSE on
  // purpose: a forced resume republishes cached output generated before any
  // later edits. Only send force after the user has been shown the pause age and
  // confirmed (the bot's 409 'stale_pause' is the expected first answer).
  pipelineResume: (jobId: string, force = false, signal?: AbortSignal) =>
    request<{ ok: boolean; jobId: string; state: "resumed" }>(
      `/api/pipelines/${encodeURIComponent(jobId)}/resume`,
      { method: "POST", body: JSON.stringify({ force }), signal },
    ),

  // Force-stop a wedged `running`/`dispatching` job — the escape hatch
  // `pipelineCancel` deliberately doesn't cover (see issue #398). Requires the
  // typed confirmation phrase the server derives from the job's own book +
  // chapter range (`forceStopPhrase` in api/src/pipelines.ts). The dialog in
  // PipelineStatusBar.tsx mirrors that formula client-side purely to display
  // the phrase and gate its own confirm button — the two copies MUST change
  // in lockstep, or the dialog will show the wrong phrase and the server will
  // reject every attempt with confirm_mismatch. Server returns 400
  // {error:"confirm_mismatch"} on a wrong phrase, 409
  // {error:"cannot_force_fail", state} if the job left running/dispatching
  // before this lands.
  pipelineForceFail: (jobId: string, confirm: string, signal?: AbortSignal) =>
    request<{ ok: boolean; jobId: string; state: "failed" }>(
      `/api/pipelines/${encodeURIComponent(jobId)}/force-fail`,
      { method: "POST", body: JSON.stringify({ confirm }), signal },
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

  // ── Comments ──
  getMentionUsers: (signal?: AbortSignal) =>
    request<{ users: MentionUser[] }>(`/api/comments/mention-users`, { signal }),

  getComments: (book: string, chapter: number, signal?: AbortSignal) =>
    request<{ comments: CommentDto[] }>(
      `/api/comments/${encodeURIComponent(book)}/${chapter}`,
      { signal },
    ),

  getBookCommentSummary: (book: string, signal?: AbortSignal) =>
    request<BookCommentSummary>(
      `/api/comments/${encodeURIComponent(book)}/notes/summary`,
      { signal },
    ),

  createComment: (body: NewCommentInput) =>
    request<CommentDto>(`/api/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateComment: (id: number, body: string) =>
    request<CommentDto>(`/api/comments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),

  resolveComment: (id: number, resolved: boolean) =>
    request<CommentDto>(`/api/comments/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolved }),
    }),

  deleteComment: (id: number) =>
    request<{ ok: true }>(`/api/comments/${id}`, { method: "DELETE" }),

  // ── Admin panel ──
  getAdminSyncStatus: (book?: string, signal?: AbortSignal) =>
    request<AdminSyncStatusResponse>(
      `/api/admin/sync-status${book ? `?book=${encodeURIComponent(book)}` : ""}`,
      { signal },
    ),

  getAdminSyncActivity: (signal?: AbortSignal) =>
    request<AdminSyncActivityResponse>(`/api/admin/sync-activity`, { signal }),

  // `checks` defaults true server-side; the panel's "skip check status
  // (faster)" toggle passes checks=0 to skip the per-PR Gitea status calls.
  getAdminPrs: (opts?: { checks?: boolean }, signal?: AbortSignal) =>
    request<AdminPrsResponse>(
      `/api/admin/prs${opts?.checks === false ? "?checks=0" : ""}`,
      { signal },
    ),

  getAdminUsers: (signal?: AbortSignal) =>
    request<AdminUsersResponse>(`/api/admin/users`, { signal }),

  addAdminUser: (username: string, role: "admin" | "editor") =>
    request<AdminUser>(`/api/admin/users`, {
      method: "POST",
      body: JSON.stringify({ username, role }),
    }),

  removeAdminUser: (username: string) =>
    request<{ ok: true }>(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
    }),

  // 200 {mode:"inline"} when `chapters` is given, 202 {mode:"workflow"} for a
  // whole-book pull. Whole-book imports can run long, so use a wide timeout
  // like importBook above.
  adminImport: (body: {
    book: string;
    resources: Resource[];
    chapters?: number[];
  }) =>
    request<AdminImportResponse>(`/api/admin/import`, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    }),

  // ── Exports (existing pipeline, reused by the admin Run tab) ──
  runExport: (body: RunExportRequest) =>
    request<RunExportResponse>(`/api/exports/run`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getExports: (book?: string, limit?: number, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (book) params.set("book", book);
    if (limit != null) params.set("limit", String(limit));
    const qs = params.toString();
    return request<ExportsListResponse>(
      `/api/exports${qs ? `?${qs}` : ""}`,
      { signal },
    );
  },

  getExportInstance: (id: string, signal?: AbortSignal) =>
    request<ExportInstanceStatus>(
      `/api/exports/instance/${encodeURIComponent(id)}`,
      { signal },
    ),
};

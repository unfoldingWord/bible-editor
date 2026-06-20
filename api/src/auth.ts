// Cookie-based session auth for the editor API.
//
// Cookies set on every successful sign-in (OAuth callback or dev mint):
//   be_access  — HttpOnly, SameSite=Lax, Path=/, short JWT (1h). attachAuth
//                middleware reads this and stamps userId/role on the request.
//   be_refresh — HttpOnly, SameSite=Strict, Path=/api/auth/refresh, 14d.
//                Value is sessions.id; refresh endpoint validates the row,
//                mints a new Access JWT, rotates the cookie.
//   be_csrf    — NOT HttpOnly, SameSite=Lax, Path=/, 14d. Double-submit value
//                the SPA mirrors into X-CSRF-Token on writes.
//
// Bearer-Authorization is still honored as a fallback (non-browser callers
// and the cutover window for any cached localStorage tokens). Plan is to
// drop it a few weeks after this lands.
//
// Writes (POST/PATCH/DELETE) require a valid token AND a matching csrf token.
// Reads are unauthenticated for now because the same content is destined for
// public DCS export. If/when reads need locking down, apply requireAuth too.
//
// Dev-only mint endpoint: POST /api/auth/dev (gated by DEV_AUTH_ENABLED=true).
// DCS OAuth: GET /api/auth/dcs/start → GET /api/auth/dcs/callback.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./index";

const ACCESS_COOKIE = "be_access";
const REFRESH_COOKIE = "be_refresh";
const CSRF_COOKIE = "be_csrf";

// Refresh-cookie path. We use `/` (not the narrower `/api/auth/refresh`) so
// `authLogout` — which has no good way to identify the session otherwise —
// can read the cookie and revoke the row. SameSite=Strict + HttpOnly keeps
// the cookie hidden from cross-site attackers and JS, so the broader path
// doesn't change the threat model meaningfully.
const REFRESH_COOKIE_PATH = "/";

// Access cookie lifetime. Short by design: anyone holding the cookie gets
// an hour of authority before they need a refresh. Refresh is gated on the
// DB session row, so revocation lands within this window.
const ACCESS_COOKIE_TTL_SECONDS = 3600;

// Session lifetime — also the lifetime of the Refresh + CSRF cookies. Past
// this, the user has to re-auth.
const SESSION_TTL_SECONDS = 14 * 86400;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// `secure` is gated on the request URL — localhost in dev is HTTP, so
// Secure cookies would never be set. In any other scheme we set Secure.
function isSecureRequest(c: AppContext): boolean {
  return !c.req.url.startsWith("http://");
}

export type Role = "admin" | "editor" | "viewer";

export interface AuthClaims {
  userId: number;
  username?: string;
  role?: Role;
}

// Org granted read-only access via DCS membership. Lookup is case-insensitive;
// can be overridden per-env via VIEWER_ORG (defaults to "unfoldingWord").
function viewerOrgName(env: Env): string {
  return (env.VIEWER_ORG ?? "unfoldingWord").trim() || "unfoldingWord";
}

// Calls the Gitea API to check whether `dcsUsername` is a member of the
// viewer-eligible org. `accessToken` (the user's OAuth token, when present)
// picks up private memberships; otherwise the unauthenticated call only sees
// public memberships. Returns false on any network/parse failure — we'd
// rather deny ambiguously than mint a token by accident.
async function isViewerOrgMember(
  env: Env,
  dcsUsername: string,
  accessToken: string | null,
): Promise<boolean> {
  const orgName = viewerOrgName(env).toLowerCase();
  try {
    if (accessToken) {
      // Authenticated: lists current user's orgs including private memberships.
      const res = await fetch(`${env.DCS_BASE_URL}/api/v1/user/orgs`, {
        headers: { Authorization: `token ${accessToken}` },
      });
      if (!res.ok) return false;
      const orgs = (await res.json()) as Array<{ username?: string }>;
      return orgs.some((o) => (o.username ?? "").toLowerCase() === orgName);
    }
    // Unauthenticated path (refresh): only sees public memberships, but the
    // uW org membership is public so this is sufficient in practice. If the
    // DCS_SERVICE_TOKEN is configured, use it to also catch private members.
    const headers: Record<string, string> = {};
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(
      `${env.DCS_BASE_URL}/api/v1/users/${encodeURIComponent(dcsUsername)}/orgs`,
      { headers },
    );
    if (!res.ok) return false;
    const orgs = (await res.json()) as Array<{ username?: string }>;
    return orgs.some((o) => (o.username ?? "").toLowerCase() === orgName);
  } catch {
    return false;
  }
}

type AppContext = Context<{
  Bindings: Env;
  Variables: { userId?: number; username?: string; role?: Role };
}>;

// COLLATE NOCASE on user_roles.dcs_username means the WHERE compare is case-
// insensitive without us having to lowercase anywhere. Returns null when the
// user isn't on the allowlist — callers translate that to a denial.
async function lookupUserRole(env: Env, dcsUsername: string): Promise<Role | null> {
  const row = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(dcsUsername)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

function signingKey(env: Env): Uint8Array | null {
  if (!env.JWT_SIGNING_KEY) return null;
  return new TextEncoder().encode(env.JWT_SIGNING_KEY);
}

export async function verifyToken(token: string, env: Env): Promise<AuthClaims | null> {
  const key = signingKey(env);
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
    });
    const sub = payload.sub;
    if (!sub) return null;
    const userId = parseInt(String(sub), 10);
    if (!Number.isFinite(userId)) return null;
    const rawRole = payload.role;
    const role: Role | undefined =
      rawRole === "admin" || rawRole === "editor" || rawRole === "viewer"
        ? rawRole
        : undefined;
    return {
      userId,
      username: typeof payload.username === "string" ? payload.username : undefined,
      role,
    };
  } catch {
    return null;
  }
}

// Pulls an Access JWT off the request — first from the Access cookie (the
// browser flow), falling back to Authorization: Bearer for non-browser
// callers + the cutover window for any still-cached localStorage tokens.
// Doesn't reject on missing/invalid token; that's requireAuth's job. Running
// on every request lets reads become user-aware later without re-plumbing.
export const attachAuth: MiddlewareHandler = async (c, next) => {
  let token: string | undefined;
  const cookieToken = getCookie(c, ACCESS_COOKIE);
  if (cookieToken) {
    token = cookieToken;
  } else {
    const header = c.req.header("authorization");
    if (header && header.toLowerCase().startsWith("bearer ")) {
      token = header.slice(7).trim();
    }
  }
  if (token) {
    const claims = await verifyToken(token, c.env as Env);
    if (claims) {
      (c as AppContext).set("userId", claims.userId);
      if (claims.username) (c as AppContext).set("username", claims.username);
      if (claims.role) (c as AppContext).set("role", claims.role);
    }
  }
  await next();
};

// Double-submit CSRF on writes: client mirrors the non-HttpOnly be_csrf
// cookie into an X-CSRF-Token header. A cross-origin attacker can't read
// the cookie (different origin), so they can't fake the header. Apply this
// middleware AFTER attachAuth so we still get userId stamping on the
// pre-403 request (helpful for logs).
//
// Exempt routes: GET/HEAD/OPTIONS (no state change), OAuth callback (the
// user is being redirected from DCS and doesn't have our cookie yet), and
// /api/auth/dev (dev silent-mint also has no cookie on first call). Refresh
// + logout could in principle CSRF-attack, but Refresh is SameSite=Strict
// (browser refuses to send cross-site anyway) and logout is low-impact.
const CSRF_EXEMPT_PATHS = new Set<string>([
  "/api/auth/dcs/start",
  "/api/auth/dcs/callback",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/dev",
]);

export const requireCsrf: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  if (CSRF_EXEMPT_PATHS.has(c.req.path)) {
    return next();
  }
  const cookieValue = getCookie(c, CSRF_COOKIE);
  const headerValue = c.req.header("x-csrf-token");
  if (!cookieValue || !headerValue || cookieValue !== headerValue) {
    return c.json({ error: "csrf_mismatch" }, 403);
  }
  await next();
};

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const userId = (c as AppContext).get("userId");
  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

// requireEditor: any role allowed on the user_roles table can write.
// requireAdmin: role must be 'admin' (exports + future destructive ops).
// Both still require a valid JWT (401 first), then role (403).
export const requireEditor: MiddlewareHandler = async (c, next) => {
  const userId = (c as AppContext).get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const role = (c as AppContext).get("role");
  if (role !== "admin" && role !== "editor") {
    return c.json({ error: "forbidden", reason: "not_an_editor" }, 403);
  }
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const userId = (c as AppContext).get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const role = (c as AppContext).get("role");
  if (role !== "admin") {
    return c.json({ error: "forbidden", reason: "not_an_admin" }, 403);
  }
  await next();
};

export function currentUserId(c: Context): number | null {
  const v = (c as AppContext).get("userId");
  return typeof v === "number" ? v : null;
}

export function currentUserRole(c: Context): Role | null {
  const v = (c as AppContext).get("role");
  return v === "admin" || v === "editor" || v === "viewer" ? v : null;
}

// ── DCS OAuth ────────────────────────────────────────────────────────────────

const STATE_COOKIE = "dcs_auth_state";

function callbackUrl(requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}/api/auth/dcs/callback`;
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signStateCookie(state: string, key: Uint8Array): Promise<string> {
  return new SignJWT({ state })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(key);
}

async function verifyStateCookie(token: string, key: Uint8Array): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return typeof payload.state === "string" ? payload.state : null;
  } catch {
    return null;
  }
}

// Mints a short-lived (1h) Access JWT for the cookie session. The refresh
// path mints a new one each hour via the be_refresh cookie; revocation lands
// within that hour even though the JWT itself is stateless.
async function mintToken(
  c: AppContext,
  userId: number,
  username: string,
  role: Role,
): Promise<string> {
  const key = signingKey(c.env)!;
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer(c.env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_COOKIE_TTL_SECONDS}s`)
    .sign(key);
}

interface SessionMintResult {
  sessionId: string;
  csrfToken: string;
}

// Inserts a fresh sessions row + returns its id + csrf token. The Refresh
// cookie value is sessionId; the CSRF cookie value is csrfToken. Caller is
// responsible for setting all three cookies (see setSessionCookies).
async function startSession(c: AppContext, userId: number): Promise<SessionMintResult> {
  const sessionId = randomHex(32);
  const csrfToken = randomHex(32);
  const userAgent = (c.req.header("user-agent") ?? "").slice(0, 255) || null;
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, user_agent, ip, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())`,
  )
    .bind(sessionId, userId, csrfToken, expiresAt, userAgent, ip)
    .run();
  return { sessionId, csrfToken };
}

// Sets all three session cookies in one shot. Call after mintToken +
// startSession. Cookie attributes are tuned per cookie — see file header.
function setSessionCookies(
  c: AppContext,
  accessJwt: string,
  sessionId: string,
  csrfToken: string,
) {
  const secure = isSecureRequest(c);
  setCookie(c, ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ACCESS_COOKIE_TTL_SECONDS,
    secure,
  });
  setCookie(c, REFRESH_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: SESSION_TTL_SECONDS,
    secure,
  });
  setCookie(c, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure,
  });
}

// Only rotates the Access cookie (called by refreshToken). The Refresh + CSRF
// cookies stay bound to the same session row.
function rotateAccessCookie(c: AppContext, accessJwt: string) {
  setCookie(c, ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ACCESS_COOKIE_TTL_SECONDS,
    secure: isSecureRequest(c),
  });
}

function clearSessionCookies(c: AppContext) {
  // Path on each delete must match the path the cookie was set on, or the
  // browser leaves the original in place.
  deleteCookie(c, ACCESS_COOKIE, { path: "/" });
  deleteCookie(c, REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
}

// GET /api/auth/dcs/start — redirects to DCS authorization page.
export async function startDcsAuth(c: AppContext): Promise<Response> {
  if (!c.env.DCS_CLIENT_ID) return c.json({ error: "dcs_not_configured" }, 503);
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);

  const state = generateState();
  const stateCookie = await signStateCookie(state, key);
  const isLocalhost = c.req.url.startsWith("http://localhost") || c.req.url.startsWith("http://127.0.0.1");
  setCookie(c, STATE_COOKIE, stateCookie, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/api/auth/dcs",
    maxAge: 600,
    secure: !isLocalhost,
  });

  const authUrl = new URL(c.env.DCS_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", c.env.DCS_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  return c.redirect(authUrl.toString(), 302);
}

// GET /api/auth/dcs/callback — exchanges code, upserts user, mints JWT.
export async function callbackDcsAuth(c: AppContext): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);

  const stateCookie = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth/dcs" });
  if (!stateCookie) return c.json({ error: "missing_state_cookie" }, 400);

  const expectedState = await verifyStateCookie(stateCookie, key);
  const receivedState = c.req.query("state");
  if (!expectedState || expectedState !== receivedState) {
    return c.json({ error: "state_mismatch" }, 400);
  }

  const code = c.req.query("code");
  if (!code) return c.json({ error: "missing_code" }, 400);

  // Exchange authorization code for DCS access token.
  const tokenRes = await fetch(c.env.DCS_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      client_id: c.env.DCS_CLIENT_ID,
      client_secret: c.env.DCS_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(c.req.url),
    }),
  });
  if (!tokenRes.ok) return c.json({ error: "token_exchange_failed" }, 502);
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokenData.access_token;
  if (!accessToken) return c.json({ error: "no_access_token" }, 502);

  // Fetch the DCS user profile.
  const userRes = await fetch(`${c.env.DCS_BASE_URL}/api/v1/user`, {
    headers: { Authorization: `token ${accessToken}` },
  });
  if (!userRes.ok) return c.json({ error: "user_fetch_failed" }, 502);
  const dcsUser = (await userRes.json()) as { id: number; login: string; full_name?: string };

  // Allowlist gate. user_roles is the source of truth for edit access; an
  // account missing from it falls through to a DCS org-membership check so
  // members of the viewer org (default: unfoldingWord) get read-only access.
  // Anything else hits the denied screen.
  const origin = new URL(c.req.url).origin;
  let role: Role | null = await lookupUserRole(c.env, dcsUser.login);
  if (!role) {
    const isMember = await isViewerOrgMember(c.env, dcsUser.login, accessToken);
    if (isMember) {
      role = "viewer";
    } else {
      return c.redirect(
        `${origin}/?_auth_denied=1&u=${encodeURIComponent(dcsUser.login)}`,
        302,
      );
    }
  }

  // Upsert users row keyed by dcs_user_id. We stash the DCS access_token so
  // /api/auth/logout can revoke it server-side (RFC 7009) — without it, the
  // next sign-in silently re-auths against a live DCS cookie session.
  await c.env.DB.prepare(
    `INSERT INTO users (dcs_user_id, dcs_username, dcs_full_name, dcs_access_token)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(dcs_user_id) DO UPDATE SET
       dcs_username = ?2, dcs_full_name = ?3, dcs_access_token = ?4`,
  )
    .bind(dcsUser.id, dcsUser.login, dcsUser.full_name ?? dcsUser.login, accessToken)
    .run();

  const userRow = await c.env.DB.prepare(
    `SELECT id FROM users WHERE dcs_user_id = ?1`,
  )
    .bind(dcsUser.id)
    .first<{ id: number }>();
  if (!userRow) return c.json({ error: "user_create_failed" }, 500);

  const token = await mintToken(c, userRow.id, dcsUser.login, role);
  const { sessionId, csrfToken } = await startSession(c, userRow.id);
  setSessionCookies(c, token, sessionId, csrfToken);

  // Plain redirect to /. Cookies travel with the response automatically.
  // The earlier `#_auth=<jwt>` fragment shape leaked the bearer into
  // history.state + Referer in some edge cases; cookies eliminate the leak
  // surface entirely (HttpOnly = JS can't even read the Access value).
  return c.redirect(`${origin}/`, 302);
}

// GET /api/auth/me — returns identity from the bearer token plus the user's
// last-visited location (used by the SPA to restore where they left off when
// the URL hash is missing — e.g. after the OAuth callback round-trip).
export async function authMe(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  const username = (c as AppContext).get("username");
  const role = (c as AppContext).get("role");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    `SELECT last_book, last_chapter, last_verse FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ last_book: string | null; last_chapter: number | null; last_verse: number | null }>();
  return c.json({
    userId,
    username: username ?? null,
    role: role ?? null,
    lastBook: row?.last_book ?? null,
    lastChapter: row?.last_chapter ?? null,
    lastVerse: row?.last_verse ?? null,
  });
}

// POST /api/auth/refresh — rotates the Access cookie. Driven by the
// be_refresh cookie (SameSite=Strict, path=/api/auth/refresh) holding the
// sessions.id; we look up the row, verify it hasn't been revoked or aged
// out, and mint a fresh 1h JWT. No JWT clockTolerance needed — the DB row
// IS the gate, not the JWT's exp.
export async function refreshToken(c: AppContext): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);

  const sessionId = getCookie(c, REFRESH_COOKIE);
  if (!sessionId) return c.json({ error: "unauthorized" }, 401);

  const session = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.dcs_username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?1`,
  )
    .bind(sessionId)
    .first<{ id: string; user_id: number; expires_at: number; revoked_at: number | null; dcs_username: string }>();
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.revoked_at !== null) return c.json({ error: "unauthorized" }, 401);
  if (session.expires_at < Math.floor(Date.now() / 1000)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Re-check the allowlist on refresh — yanking a user from user_roles takes
  // effect by the next refresh, not via the old JWT's natural expiration.
  // Viewers (org-only access) re-verify org membership via the service token
  // (or public org listing) each refresh so removal from the org also revokes.
  const lookupName = session.dcs_username ?? "";
  let role: Role | null = await lookupUserRole(c.env, lookupName);
  if (!role) {
    const isMember = await isViewerOrgMember(c.env, lookupName, null);
    if (isMember) role = "viewer";
  }
  if (!role) {
    return c.json({ error: "forbidden", reason: "not_an_editor" }, 403);
  }

  const newToken = await mintToken(c, session.user_id, lookupName, role);
  rotateAccessCookie(c, newToken);
  await c.env.DB.prepare(
    `UPDATE sessions SET last_seen_at = unixepoch() WHERE id = ?1`,
  )
    .bind(sessionId)
    .run();
  return c.json({ ok: true, role, expiresIn: ACCESS_COOKIE_TTL_SECONDS });
}

// ── Dev-only token mint ───────────────────────────────────────────────────────

// Looks up (or inserts) a user row by dcs_username and returns a signed JWT.
// Production paths use /api/auth/dcs; this exists so local dev isn't blocked
// on having a DCS OAuth app registered. Dev users that aren't in user_roles
// are auto-granted 'admin' so the local dev experience exercises all role
// paths without needing a manual seed step.
export async function mintDevToken(c: AppContext, username: string): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) {
    return c.json({ error: "jwt_signing_key_not_configured" }, 500);
  }

  let role = await lookupUserRole(c.env, username);
  if (!role) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO user_roles (dcs_username, role) VALUES (?1, 'admin')`,
    )
      .bind(username)
      .run();
    role = "admin";
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM users WHERE dcs_username = ?1`,
  )
    .bind(username)
    .first<{ id: number }>();
  let userId = existing?.id;
  if (!userId) {
    // dcs_user_id is NOT NULL UNIQUE; for dev users we synthesize a random
    // negative integer so it never collides with a real DCS account. Random
    // (rather than a hash of `username`) avoids 32-bit collisions between
    // two dev usernames — the lookup above is by `dcs_username` anyway, so
    // stability across runs isn't required.
    const fakeDcsId = -(Math.floor(Math.random() * 0x7fffffff) + 1);
    await c.env.DB.prepare(
      `INSERT INTO users (dcs_user_id, dcs_username, dcs_full_name) VALUES (?1, ?2, ?2)`,
    )
      .bind(fakeDcsId, username)
      .run();
    const row = await c.env.DB.prepare(
      `SELECT id FROM users WHERE dcs_username = ?1`,
    )
      .bind(username)
      .first<{ id: number }>();
    if (!row) return c.json({ error: "user_create_failed" }, 500);
    userId = row.id;
  }
  const token = await mintToken(c, userId, username, role);
  const { sessionId, csrfToken } = await startSession(c, userId);
  setSessionCookies(c, token, sessionId, csrfToken);
  // Return MeResponse shape — same as /api/auth/me — so the client can take
  // a single round-trip path through devSignIn() without a separate /me
  // follow-up. lastBook/lastChapter/lastVerse are NULL for fresh dev users.
  const loc = await c.env.DB.prepare(
    `SELECT last_book, last_chapter, last_verse FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ last_book: string | null; last_chapter: number | null; last_verse: number | null }>();
  return c.json({
    userId,
    username,
    role,
    lastBook: loc?.last_book ?? null,
    lastChapter: loc?.last_chapter ?? null,
    lastVerse: loc?.last_verse ?? null,
  });
}

// ── Logout ────────────────────────────────────────────────────────────────

// POST /api/auth/logout — revokes the current session row server-side,
// clears all three session cookies, best-effort revokes the DCS access
// token via RFC 7009, and clears the stored DCS token so we don't keep
// sensitive material around.
//
// Note: RFC 7009 revoke only kills the API token; the user's DCS browser
// session cookie remains, so /login/oauth/authorize will silently re-issue
// a NEW token against that session. To switch DCS accounts, the user has
// to sign out of DCS separately (or use an incognito window). We don't
// auto-drive the user through DCS's /user/logout because that would kick
// them out of every other DCS tab they have open — too invasive.
export async function authLogout(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  // Even without userId, clearing cookies is safe + helpful — a client that
  // calls logout with a broken Access cookie still wants the cookies gone.
  // We still try to revoke the session if we can identify it.
  const sessionId = getCookie(c, REFRESH_COOKIE);
  if (sessionId) {
    await c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = unixepoch() WHERE id = ?1 AND revoked_at IS NULL`,
    )
      .bind(sessionId)
      .run();
  }

  if (userId) {
    const row = await c.env.DB.prepare(
      `SELECT dcs_access_token FROM users WHERE id = ?1`,
    )
      .bind(userId)
      .first<{ dcs_access_token: string | null }>();

    if (row?.dcs_access_token && c.env.DCS_CLIENT_ID && c.env.DCS_CLIENT_SECRET) {
      // RFC 7009 token revocation. Gitea/DCS expects the same client creds as
      // the token exchange. Fire-and-forget — a non-2xx here just means the DCS
      // session may persist; the local session is gone either way.
      try {
        await fetch(`${c.env.DCS_BASE_URL}/login/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: row.dcs_access_token,
            client_id: c.env.DCS_CLIENT_ID,
            client_secret: c.env.DCS_CLIENT_SECRET,
          }).toString(),
        });
      } catch {
        /* best-effort */
      }
    }

    // Clear stored token regardless of revoke outcome — keeping a stale
    // token around would do nothing but accumulate sensitive material.
    await c.env.DB.prepare(
      `UPDATE users SET dcs_access_token = NULL WHERE id = ?1`,
    )
      .bind(userId)
      .run();
  }

  clearSessionCookies(c);
  return c.json({ ok: true });
}

// ── Last-position memory ───────────────────────────────────────────────────

// PUT /api/users/me/location — persist where the translator is reading. The
// SPA pushes this on hash change (debounced) so /api/auth/me can hydrate the
// view after sign-in. Stored on the users row directly (1 row per user;
// no history; cheap).
export async function updateLastLocation(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  let body: { book?: unknown; chapter?: unknown; verse?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const book = typeof body.book === "string" ? body.book.toUpperCase() : null;
  const chapter = typeof body.chapter === "number" && Number.isInteger(body.chapter) ? body.chapter : null;
  const verse = typeof body.verse === "number" && Number.isInteger(body.verse) ? body.verse : null;

  if (!book || !/^[A-Z0-9]{1,5}$/.test(book) || chapter === null || chapter < 0 || verse === null || verse < 0) {
    return c.json({ error: "invalid_location" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE users SET last_book = ?1, last_chapter = ?2, last_verse = ?3 WHERE id = ?4`,
  )
    .bind(book, chapter, verse, userId)
    .run();

  return c.json({ ok: true });
}

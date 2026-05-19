// JWT-based auth for the editor API. Tokens are HS256 over the shared
// JWT_SIGNING_KEY env var (set with `wrangler secret put JWT_SIGNING_KEY`).
// The token's `sub` is the numeric users.id; downstream handlers read it via
// c.get("userId") to populate updated_by and edit_log.user_id.
//
// Writes (POST/PATCH/DELETE) require a valid token. Reads are unauthenticated
// for now because the same content is destined for public DCS export. If/when
// reads need locking down (e.g. private repos), apply requireAuth to those
// routes too.
//
// Dev-only mint endpoint: POST /api/auth/dev (gated by DEV_AUTH_ENABLED=true).
// DCS OAuth: GET /api/auth/dcs/start → GET /api/auth/dcs/callback.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./index";

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

// Pulls a Bearer token off the request and stashes the user id in the
// context if it verifies. Doesn't reject on missing/invalid token — that's
// requireAuth's job. This lets us run on every request so reads can become
// user-aware later without re-plumbing.
export const attachAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    const claims = await verifyToken(token, c.env as Env);
    if (claims) {
      (c as AppContext).set("userId", claims.userId);
      if (claims.username) (c as AppContext).set("username", claims.username);
      if (claims.role) (c as AppContext).set("role", claims.role);
    }
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
    const { payload } = await jwtVerify(token, key);
    return typeof payload.state === "string" ? payload.state : null;
  } catch {
    return null;
  }
}

async function mintToken(
  c: AppContext,
  userId: number,
  username: string,
  role: Role,
): Promise<string> {
  const key = signingKey(c.env)!;
  const ttl = parseInt(c.env.JWT_TTL_SECONDS, 10);
  const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 1209600;
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer(c.env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
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

  // Upsert users row keyed by dcs_user_id.
  await c.env.DB.prepare(
    `INSERT INTO users (dcs_user_id, dcs_username, dcs_full_name)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(dcs_user_id) DO UPDATE SET dcs_username = ?2, dcs_full_name = ?3`,
  )
    .bind(dcsUser.id, dcsUser.login, dcsUser.full_name ?? dcsUser.login)
    .run();

  const userRow = await c.env.DB.prepare(
    `SELECT id FROM users WHERE dcs_user_id = ?1`,
  )
    .bind(dcsUser.id)
    .first<{ id: number }>();
  if (!userRow) return c.json({ error: "user_create_failed" }, 500);

  const token = await mintToken(c, userRow.id, dcsUser.login, role);

  // Redirect the SPA back to the root with the token in the query string.
  // App.tsx reads _auth on load, persists it to localStorage, and cleans the URL.
  return c.redirect(`${origin}/?_auth=${encodeURIComponent(token)}`, 302);
}

// GET /api/auth/me — returns identity from the bearer token.
export async function authMe(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  const username = (c as AppContext).get("username");
  const role = (c as AppContext).get("role");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  return c.json({ userId, username: username ?? null, role: role ?? null });
}

// POST /api/auth/refresh — exchanges a current-or-recently-expired bearer
// token for a fresh one. A 7-day clockTolerance lets a translator come back
// from a long offline stretch and silently get a new token before they have
// to re-OAuth. Beyond grace, 401 → client falls back to the sign-in flow.
const REFRESH_GRACE_SECONDS = 7 * 24 * 60 * 60;

export async function refreshToken(c: AppContext): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);
  const header = c.req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = header.slice(7).trim();

  let userId: number | null = null;
  let username: string | null = null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: c.env.JWT_ISSUER,
      clockTolerance: REFRESH_GRACE_SECONDS,
    });
    const sub = payload.sub;
    if (!sub) return c.json({ error: "unauthorized" }, 401);
    const parsed = parseInt(String(sub), 10);
    if (!Number.isFinite(parsed)) return c.json({ error: "unauthorized" }, 401);
    userId = parsed;
    if (typeof payload.username === "string") username = payload.username;
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Verify the user still exists — a refreshed token for a deleted account
  // would let revoked users keep editing for another TTL window.
  const row = await c.env.DB.prepare(
    `SELECT id, dcs_username FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ id: number; dcs_username: string }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);

  // Re-check the allowlist on refresh — yanking a user from user_roles takes
  // effect by the next refresh, not via the old JWT's natural expiration.
  // Viewers (org-only access) re-verify org membership via the service token
  // (or public org listing) each refresh so removal from the org also revokes.
  const lookupName = row.dcs_username ?? username ?? "";
  let role: Role | null = await lookupUserRole(c.env, lookupName);
  if (!role) {
    const isMember = await isViewerOrgMember(c.env, lookupName, null);
    if (isMember) role = "viewer";
  }
  if (!role) {
    return c.json({ error: "forbidden", reason: "not_an_editor" }, 403);
  }

  const newToken = await mintToken(c, row.id, row.dcs_username ?? username ?? "user", role);
  const ttl = parseInt(c.env.JWT_TTL_SECONDS, 10);
  const expiresIn = Number.isFinite(ttl) && ttl > 0 ? ttl : 1209600;
  return c.json({ token: newToken, expiresIn, role });
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
    // dcs_user_id is NOT NULL UNIQUE; for dev users we synthesize a stable
    // negative integer so it never collides with a real DCS account.
    const hash = Array.from(username).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 0);
    const fakeDcsId = -Math.abs(hash) - 1;
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
  const ttl = parseInt(c.env.JWT_TTL_SECONDS, 10);
  const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 1209600;
  const token = await mintToken(c, userId, username, role);
  return c.json({ token, userId, username, role, expiresIn: ttlSeconds });
}

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
// Until the DCS OAuth flow is wired, a dev-only mint endpoint can issue
// tokens against a known users.id when DEV_AUTH_ENABLED=true. Production
// builds set that to false and rely on the real /api/auth/dcs flow (to be
// implemented). The middleware itself is identical in both modes.

import type { Context, MiddlewareHandler } from "hono";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./index";

export interface AuthClaims {
  userId: number;
  username?: string;
}

type AppContext = Context<{ Bindings: Env; Variables: { userId?: number; username?: string } }>;

function signingKey(env: Env): Uint8Array | null {
  if (!env.JWT_SIGNING_KEY) return null;
  return new TextEncoder().encode(env.JWT_SIGNING_KEY);
}

async function verify(token: string, env: Env): Promise<AuthClaims | null> {
  const key = signingKey(env);
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: env.JWT_ISSUER,
    });
    const sub = payload.sub;
    if (!sub) return null;
    const userId = parseInt(String(sub), 10);
    if (!Number.isFinite(userId)) return null;
    return { userId, username: typeof payload.username === "string" ? payload.username : undefined };
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
    const claims = await verify(token, c.env as Env);
    if (claims) {
      (c as AppContext).set("userId", claims.userId);
      if (claims.username) (c as AppContext).set("username", claims.username);
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

export function currentUserId(c: Context): number | null {
  const v = (c as AppContext).get("userId");
  return typeof v === "number" ? v : null;
}

// Dev-only token mint. Looks up (or inserts) a user row by dcs_username and
// returns a signed JWT. Production paths should use /api/auth/dcs once
// implemented; this endpoint exists so local development isn't blocked on
// having a DCS OAuth app configured.
export async function mintDevToken(c: AppContext, username: string): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) {
    return c.json({ error: "jwt_signing_key_not_configured" }, 500);
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
  const token = await new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer(c.env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
  return c.json({ token, userId, username, expiresIn: ttlSeconds });
}

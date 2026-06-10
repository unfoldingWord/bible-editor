# Wave 3 handoff

You are picking up Wave 3 of the security hardening plan. Wave 1 (P0/HIGH) and Wave 2 (P1/MEDIUM) are shipped to production. Wave 3 is the long-tail hardening — lower urgency than Waves 1-2, but contains one architecturally meaningful change (cookie session) and several defensive cleanups.

## Status

Shipped on `main` and deployed to `bible-editor-api.unfoldingword.workers.dev`:

- **Wave 1** (`00407642`-ish range): editor allowlist via `user_roles`, composite-key scoping in `pipelineImport.ts` + `rows.ts`, `edit_log.book` column with backfill, verse `content` Zod schema, JWT `algorithms: ["HS256"]` pin.
- **Wave 2** (`a7a21f79`): OAuth token in URL fragment, outbox max-attempts (20) + failed-ops drawer with Retry/Discard, D1-backed `book_import_locks` (migration `0019`), `latest_source` subquery book-scoping.
- **Two extras shipped alongside Wave 2 that you should know about:**
  - `3085ee62` **viewer role**: members of the `unfoldingWord` DCS org (configurable via `VIEWER_ORG` env var) are minted a `viewer` JWT and get read-only access. `requireEditor` / `requireAdmin` continue to 403 viewers. Client-side gate: `setReadOnly(true)` short-circuits non-GET requests in `web/src/sync/api.ts`, and outbox enqueue methods become no-ops.
  - `df5f37e2` **real sign-out + last-position memory**: `POST /api/auth/logout` revokes the DCS token via RFC 7009 so re-sign-in actually prompts for credentials. `localStorage.signed_out` flag suppresses dev silent re-mint. Migration `0018_user_session.sql` adds `users.dcs_access_token` + `last_book/last_chapter/last_verse`; debounced `PUT /api/users/me/location` keeps it fresh.

Migration high-water mark: `0019_book_import_locks.sql`. Wave 3 starts at `0020`.

## Wave 3 scope

Seven items. Sizes vary widely. Ship 3.1 (cookie session) as its own PR — it touches auth comprehensively and has the highest blast radius. Bundle 3.2-3.6 together. 3.7 is Cloudflare-dashboard config (no code).

### 3.1 Cookie-based session (the big one)

Replace `localStorage`-stored Bearer JWTs with `HttpOnly` cookies. Kills the XSS-driven token theft surface, lets the server revoke individual sessions, and obviates several existing workarounds:
- The dev-mode "stale token has no role claim → drop and re-mint" branch in [web/src/App.tsx](../web/src/App.tsx) `useAuthGate` (verifying state).
- The `localStorage.signed_out` flag (#66) — replaced by an absent session row.
- The `_auth=` fragment handoff after OAuth callback — replaced by setting the cookie server-side.

**Server side:**
- New migration `api/migrations/0020_sessions.sql`:
  ```sql
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                      -- random 32-byte hex; Refresh cookie value
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
  CREATE INDEX sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;
  ```
- [api/src/auth.ts](../api/src/auth.ts) `callbackDcsAuth`: set two cookies, return a plain redirect to `/` (no `#_auth=` fragment). Insert a `sessions` row.
  - `Access`: `Secure HttpOnly SameSite=Lax`, 1h TTL, holds the short-lived JWT.
  - `Refresh`: `Secure HttpOnly SameSite=Strict`, `path=/api/auth/refresh`, 14d TTL, value is the `sessions.id`.
- `attachAuth` middleware: read Access cookie first, fall back to `Authorization: Bearer` for non-browser callers.
- `refreshToken`: load by Refresh cookie's session id; verify `revoked_at IS NULL AND expires_at > now`; mint a new Access JWT + rotate the Access cookie. Touch `last_seen_at`. Drop the existing 7-day `clockTolerance` — refresh is now gated by the DB row, not the JWT expiration.
- `POST /api/auth/logout` (already exists from #66): also `UPDATE sessions SET revoked_at = unixepoch() WHERE id = ?`, then clear both cookies via `Set-Cookie: ... Max-Age=0`.
- Keep `mintDevToken` for local dev — set both cookies the same way the OAuth callback does. `DEV_AUTH_ENABLED=false` in prod still gates it.
- **Viewer role**: same cookie pair, role baked into the JWT. The viewer-org check at refresh time (#65) stays.

**CSRF:**
- Issue a non-HttpOnly `csrf` cookie alongside the Access cookie (random per-session token, stored in `sessions` row).
- New middleware before write routes: require `X-CSRF-Token` header matching the `csrf` cookie value (double-submit). Apply to all POST/PATCH/DELETE under `/api/*` except `/api/auth/dcs/callback` and `/api/auth/logout`.

**Client side:**
- [web/src/sync/api.ts](../web/src/sync/api.ts): switch all `fetch` to `credentials: "include"`. Add `X-CSRF-Token` header on writes, reading from `document.cookie`. Drop `getAuthToken`/`setAuthToken`/`TOKEN_KEY`, drop `bible-editor.auth.token`, drop `bible-editor.signed_out`.
- [web/src/App.tsx](../web/src/App.tsx) `useAuthGate`: simpler now. Boot calls `/api/auth/me`; on 200 with valid role → ready, on 401 → missing (sign-in click). No fragment parser. No verifying state. Existing `signed_out` screen can stay — just key it off a 401 response after a `logout` rather than the localStorage flag.

**Headers (Worker-wide):**
Add to the response middleware in [api/src/index.ts](../api/src/index.ts):
- `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss://bible-editor-api.unfoldingword.workers.dev`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Content-Type-Options: nosniff`

**Cutover plan:**
1. Land migration `0020_sessions.sql` and the new server endpoints. Old localStorage tokens still work via the `Authorization: Bearer` fallback in `attachAuth`.
2. Land the frontend changes (cookies first, header fallback removed).
3. Rotate `JWT_SIGNING_KEY` in production — any lingering localStorage tokens 401, falling to the sign-in flow.
4. Optional: a follow-up commit can drop the `Bearer` fallback in `attachAuth` once you're confident no clients hold tokens.

**Touches:** [api/src/auth.ts](../api/src/auth.ts), [api/src/index.ts](../api/src/index.ts), new [api/migrations/0020_sessions.sql](../api/migrations/0020_sessions.sql), new `api/src/csrf.ts` (or fold into `auth.ts`), [web/src/sync/api.ts](../web/src/sync/api.ts), [web/src/App.tsx](../web/src/App.tsx).

### 3.2 edit_log retention

Append to the `*/5` cron handler in [api/src/index.ts](../api/src/index.ts) (just after `pollAllNonTerminal`):

```ts
// Once-per-hour retention sweep — gate on minute-of-hour so it runs ~12x/day,
// not on every 5-min tick.
const minuteOfHour = Math.floor(Date.now() / 60_000) % 60;
if (minuteOfHour < 5) {
  await env.DB.prepare(
    `DELETE FROM edit_log WHERE created_at < unixepoch() - (180 * 86400)`,
  ).run();
}
```

180 days is defensive; lengthen if/when a real retention policy exists.

### 3.3 ChapterRoom hardening

[api/src/chapterRoom.ts](../api/src/chapterRoom.ts):
- Cap `clients: Set<WebSocket>` at 100. When full, return `503 service_unavailable` from the accept path instead of `server.accept()`.
- Sender exclusion: pass an originating session id (or user id) in the `POST /broadcast` payload from [api/src/wsEvents.ts](../api/src/wsEvents.ts); skip that socket in the fan-out loop. Lower priority — `Shell.tsx` already dedupes broadcasts by `row.version > existing.version`, but server-side exclusion saves redundant round-trips.

### 3.4 mintDevToken random ID

[api/src/auth.ts](../api/src/auth.ts) `mintDevToken` synthesizes a stable negative `dcs_user_id` via a 32-bit hash:

```ts
const hash = Array.from(username).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 0);
const fakeDcsId = -Math.abs(hash) - 1;
```

Two dev usernames hashing to the same 32-bit value would collide on `UNIQUE(dcs_user_id)`. Replace with:

```ts
const fakeDcsId = -(Math.floor(Math.random() * 0x7fffffff) + 1);
```

Dev-only; trivial fix while we're in there.

### 3.5 Pipeline poller attempt cap

New migration `api/migrations/0021_pipeline_attempts.sql`:
```sql
ALTER TABLE pipeline_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
```

[api/src/pipelines.ts](../api/src/pipelines.ts) `pollAllNonTerminal`: increment `attempt_count` on each poll. Auto-fail any job where `attempt_count > 100` (~8 hours at 5min interval). Keeps the existing 48h time-based threshold as a backstop.

### 3.6 Cron pattern constants

[api/src/index.ts](../api/src/index.ts) `scheduled` branches on string literals. Extract:

```ts
const EXPORT_CRON = "0 6 * * *";
const POLL_CRON = "*/5 * * * *";
```

[api/wrangler.toml](../api/wrangler.toml) defines the actual triggers under `[triggers] crons`. There's no runtime way to assert they match, but constants in code make the link explicit and grep-able. Two-minute fix.

### 3.7 Operational rate limits (out of code)

Cloudflare Rate Limiting Rules (dashboard, not in this repo). Suggested defaults:

- `/api/auth/dev` → 5/min/IP (defense-in-depth even though `DEV_AUTH_ENABLED=false` in prod)
- `/api/books/*/import` → 5/min/user
- `/api/pipelines/start` → 10/min/user
- `/api/exports/run` → 2/min/user (admin only anyway)
- `/api/tn-quick` → 30/min/user

Document the rules in [docs/deploy.md](deploy.md) so they survive a Cloudflare account migration.

## Suggested item ordering

1. Land 3.4 + 3.6 first — trivial, no migration, low risk. Single commit.
2. Bundle 3.2 + 3.3 + 3.5 — small surface area, one PR, one new migration (`0021_pipeline_attempts.sql`).
3. Land 3.1 (cookie session) on its own. Test extensively via Chrome MCP — highest blast radius.
4. Configure 3.7 in the Cloudflare dashboard. Smoke-test from a different IP with `curl`.

## Wave-1/2 + recent extras: gotchas to inherit

1. **Three roles, not two.** `Role = "admin" | "editor" | "viewer"`. `requireEditor` allows admin and editor; `requireAdmin` only allows admin; viewers 403 on all writes. The viewer role is granted dynamically via DCS org membership (#65) — not stored in `user_roles`, looked up at sign-in/refresh via Gitea API. The cookie session must preserve this lookup.
2. **`signed_out` flag pattern (#66)**: explicit logout sets `localStorage.signed_out = "1"` to suppress dev silent re-mint. When you replace localStorage with cookies, replace this with either an absent `Refresh` cookie (the natural state after logout) or a separate `signed_out` non-HttpOnly cookie.
3. **`users.dcs_access_token`** (migration 0018) is stored so `POST /api/auth/logout` can call DCS's RFC 7009 revoke. The cookie session shouldn't lose this — keep the column populated on OAuth callback.
4. **Last-position memory** (#66): `users.last_{book,chapter,verse}` is updated via debounced `PUT /api/users/me/location`. `/api/auth/me` returns these so the SPA can land on the right page after sign-in. Don't break this — make sure the new `/me` shape still includes them.
5. **`mintDevToken` auto-grants admin** to unknown dev usernames. Keep that behavior — local dev relies on it.
6. **`edit_log.book` backfill fallback**: history queries in [api/src/rows.ts](../api/src/rows.ts) use `(el.book = ?3 OR el.book IS NULL)`. After 3.2's 180-day retention sweep ages out the pre-Wave-1 entries (which have `book IS NULL` if their row was deleted), the fallback can be dropped — but not before.
7. **`latest_source` subquery in [api/src/chapters.ts](../api/src/chapters.ts)** now uses `(book = t.book OR book IS NULL)` (shipped in #67). Same retention rule — drop the NULL branch after the legacy entries age out.
8. **Vite watches the MAIN checkout, not the worktree.** When live-testing, edit files in `C:\Users\benja\Documents\GitHub\bible-editor\<path>`. See [CLAUDE.md](../CLAUDE.md) "Browser-driven verification".
9. **`npm run dev` runs cleanly in the background** via `Bash run_in_background`. Drive Chrome via Claude-in-Chrome MCP for any frontend-touching wrap-up.
10. **CORS allowlist** in [api/src/index.ts](../api/src/index.ts) already does `credentials: true` against an exact-match allowlist. The cookie session needs this — don't loosen the allowlist or `credentials` interaction.

## Tests to write (overdue)

Called out in earlier plans but skipped. Worth landing alongside Wave 3:

- `tests/concurrency/auth-allowlist.spec.ts` — admin / editor / viewer / denied, exports route gating.
- `tests/concurrency/cross-book.spec.ts` — import two books with overlapping `tn_rows.id`s, run a pipeline on book A, verify book B untouched. Exercises Wave 1's `pipelineImport.ts` book scoping end-to-end.
- `tests/concurrency/outbox-max-attempts.spec.ts` — block `/api/rows`, edit 21 times, confirm transition to `failed` + drawer.
- `tests/concurrency/csrf.spec.ts` (Wave 3.1) — POST without `X-CSRF-Token` → 403; with stale token → 403; matching → 200.
- `tests/concurrency/cookie-session.spec.ts` (Wave 3.1) — full OAuth dance, refresh rotation, logout revocation, replay-after-revoke.

## Verification

Per [CLAUDE.md](../CLAUDE.md) "Browser-driven verification". Wave-3-specific smoke checks:

- **Cookie session**: sign in via DCS, confirm `Access` + `Refresh` are HttpOnly in DevTools → Application → Cookies. `localStorage` is empty (no `bible-editor.auth.token`, no `bible-editor.signed_out`). Editing succeeds. Reload page → still signed in. `document.cookie` shows only `csrf` (non-HttpOnly).
- **CSRF**: `curl -X PATCH ...` from a different origin → 403. From the SPA origin without `X-CSRF-Token` → 403.
- **Logout end-to-end**: click Sign out → POST /api/auth/logout → cookies cleared → next sign-in actually prompts DCS for credentials.
- **Edit-log retention**: insert a fake 200-day-old row, trigger scheduled handler via `wrangler dev --test-scheduled`, confirm row is gone.
- **ChapterRoom cap**: open 101 WebSocket connections in a loop, confirm 101st gets 503.
- **Pipeline attempt cap**: set a job's `attempt_count = 99`, run the poller cron, confirm transition to `failed` with `error_kind = 'interrupted'`.

## Shipping pattern

1. Work on a feature branch in a worktree.
2. `npm run typecheck` + `npm run build` clean.
3. `(cd api && npx wrangler d1 migrations apply bible_editor_dev --local)` for new migrations.
4. Drive Chrome MCP to smoke-test.
5. Commit: `git -c user.email=ju-cldai724@abidinginhesed.com -c user.name=Benjamin commit -m "$(cat <<'EOF' ...)"`.
6. `git push origin <branch>:main`.
7. `cd C:\Users\benja\Documents\GitHub\bible-editor && git pull --ff-only origin main`.
8. **For 3.1 specifically: rotate `JWT_SIGNING_KEY` in prod secrets AFTER the cookie cutover** — invalidates any lingering localStorage tokens, forcing clean re-auth on the cookie path.
9. `(cd api && npx wrangler d1 migrations apply bible_editor --remote --env production) && npm run deploy`.

## Post-Wave-3 cleanup

- Delete this file (`docs/wave-3-handoff.md`). It's scaffolding; once shipped, the canonical handoff is [docs/handoff.md](handoff.md).
- Refresh [docs/handoff.md](handoff.md) "What's in (verified)" to reflect post-hardening state.
- Drop the `(el.book IS NULL)` / `(book IS NULL)` fallbacks in [api/src/rows.ts](../api/src/rows.ts) history and [api/src/chapters.ts](../api/src/chapters.ts) `latest_source` once 3.2's retention sweep has aged out the pre-Wave-1 entries (~180 days after Wave 3.2 ships).
- Drop the `Authorization: Bearer` fallback in `attachAuth` once you're confident no client holds a localStorage Bearer token (give it a few weeks past the 3.1 deploy).

## References

- Plan: `~/.claude/plans/compare-with-these-and-imperative-ember.md` (Wave 3 §)
- Project guide: [CLAUDE.md](../CLAUDE.md)
- Original handoff (pre-Wave-1): [docs/handoff.md](handoff.md)
- All hardening commits: `git log --oneline d726eb49..HEAD`

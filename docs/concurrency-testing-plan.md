# Concurrency Testing Plan (Playwright)

Status: **shipped (v1).** Harness lives at the repo root in `tests/concurrency/`.
Run with `npm run test:e2e`. Current suite covers S1, S2, S5 (×2),
S6 realtime push (×3), S7 offline/retry resilience (×2), and S8 trash/restore:
10 tests total. Notes on what's wired vs. deferred are inline below.

## What we're proving

The editor's headline claim is "multiple editors work the same chapter without
clobbering each other." This suite makes that claim falsifiable. Specifically:

1. **No data loss on adjacent edits.** Two users editing notes on different
   verses, or different notes on the same verse, never lose a write.
2. **Conflicts surface, never silently overwrite.** Two users editing the same
   row see the 409 path — the second writer is told, not steamrolled.
3. **Outbox survives interruption.** Edits queued during a network outage flush
   on recovery, in order, with no duplication.
4. **WebSocket broadcast keeps peers consistent.** A change by user A appears in
   user B's view without a manual reload.

Out of scope for v1: word alignment, USFM body editing, pipeline runs, lexicon.
TN rows only. We can extend once the harness shape is proven.

## Why Playwright, not Claude-in-Chrome

Real concurrency requires **simultaneous** writes from multiple clients. A
single Claude instance acts sequentially — it can't produce the race conditions
we need to falsify the "no clobbering" claim. Playwright launches N
`browserContext`s inside one process, each with isolated cookies/IndexedDB =
genuinely separate "users," with `Promise.all` for interleaved writes. One
command, deterministic, CI-able.

Claude-in-Chrome stays useful for *exploratory* visual testing later. Not this.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Playwright test runner (Node)                                  │
│                                                                 │
│   browser ──┬── context A ── page A ── "Alice"  (cookie session)│
│             ├── context B ── page B ── "Bob"    (cookie session)│
│             ├── context C ── page C ── "Carol"  (cookie session)│
│             └── context D ── page D ── "Dave"   (cookie session)│
│                                                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    http://localhost:5173 (Vite, proxies /api/*)
                               │
                    http://localhost:8787 (wrangler dev, Miniflare)
                               │
                    Local D1 + Durable Objects + R2 stubs
```

Each context is an independent client. Same Durable Object (ChapterRoom)
brokers their WebSocket traffic. Same D1 mediates their PATCH writes via
`If-Match` optimistic concurrency.

## Setup (as shipped)

Tests live at the **repo root** in `tests/concurrency/`, not under `web/` —
they exercise both api and web, so root is the honest home.

### Install

Already done. `@playwright/test` is a root devDependency. To install the
Chromium browser on a fresh checkout:

```
npm install
npx playwright install chromium
```

### Scripts (root `package.json`)

```jsonc
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

### `playwright.config.ts` (root)

Key settings:

- `webServer.command: "npm run dev"` — brings up Wrangler + Vite in parallel.
- `webServer.url: "http://localhost:5173/api/health"` — polls the API
  *through Vite's proxy* so both servers must be up before tests start.
  Polling a bare `/` would clear once Vite is alive even if Wrangler is still
  booting, which then 502s the first `/api/auth/dev` call.
- `webServer.reuseExistingServer: true` — `npm run dev` already running? Use it.
- `use.baseURL: "http://localhost:5173"`.
- `fullyParallel: false`, `workers: 1` — tests share one chapter fixture;
  running them in parallel would cross the streams. Inside each test we run
  multiple **contexts** in parallel, which is the parallelism we want.
- `retries: 0`. A retry-passing concurrency test is a bug.

### API env for testing

`api/.dev.vars` must have:

```
JWT_SIGNING_KEY=<any-non-empty-string>
```

`DEV_AUTH_ENABLED=true` is also required, but it's already the default in
`api/wrangler.toml [vars]`. Production deploys must override it to false (gated
in `api/src/index.ts:104`).

### `tests/package.json` — ESM scope

The root `package.json` isn't `"type": "module"`, but the test files use ESM
imports. A minimal `tests/package.json` with `"type": "module"` scopes ESM
just to this folder without affecting the workspaces.

## Auth: skip OAuth entirely

Browser auth is cookie-based. The API exposes `POST /api/auth/dev` with
`{username}` body; it sets the same `be_access`, `be_refresh`, and `be_csrf`
cookies as DCS OAuth and returns the `/api/auth/me` response shape. This is
the lever for multi-user testing.

Per-context login helper:

```ts
async function loginAs(context: BrowserContext, username: string) {
  const res = await context.request.post("/api/auth/dev", {
    data: { username },
  });
  if (!res.ok()) throw new Error(`dev auth failed: ${res.status()}`);
}
```

Call before each context's first `page.goto()`. The context request shares
cookies with pages in that context, so the app sees the cookie session on first
render and skips the sign-in screen.

## Test fixture: Zechariah, seeded once

`tests/concurrency/global-setup.ts` re-imports **all of Zechariah** from
`docs/samples/` into the local D1 before any test runs. Specifically:

1. If `scripts/out/import-ZEC.sql` doesn't exist, run `node scripts/import-book.mjs ZEC` to generate it.
2. `wrangler d1 execute bible_editor_dev --local --file=scripts/out/import-ZEC.sql` to apply.

The importer is idempotent (DELETE WHERE book='ZEC' + REPLACE INTO), so
re-runs are safe. Each test picks its own row(s) on different verses so
tests don't trample each other — no per-test reseed needed yet. If we
notice flake from accumulated edits across runs, drop a per-test reseed
into `beforeEach`.

Why Zechariah: chapter 6 has 24 TN rows spread across all 15 verses
including multiple notes per verse, which gives us "different rows on
adjacent verses" AND "different rows on the same verse" without needing
to fabricate fixture data.

## Selectors (as built)

`NoteCard` exposes `data-note-id={row.id}`
([web/src/components/NoteCard.tsx:420](web/src/components/NoteCard.tsx:420)) —
that's the scope hook.

Original plan was `getByRole("textbox", { name: "Note" })` with an
`aria-label` added. **In practice MUI's multiline TextField doesn't
propagate `inputProps["aria-label"]` to the accessibility tree** — the
accessible name on the inner `<textarea>` comes up empty. The aria-labels
were added anyway as a small a11y win, but the test selector falls back to
position:

```ts
// tests/concurrency/helpers.ts: noteTextarea()
page.locator(`[data-note-id="${rowId}"]`)
    .locator('textarea:not([aria-hidden="true"])')
    .nth(1);
```

Each MUI multiline TextField actually renders **two** `<textarea>` elements:
the real editable one and a hidden mirror used for autoresize measurement
(`aria-hidden="true" readonly`). Filtering out the hidden ones leaves Quote
(index 0) and Note (index 1).

## Triggering a save in the UI

NoteCard's save logic fires on `active=true→false` (the card loses focus
because another card was clicked) or on **unmount**. Clicking outside the
card doesn't trigger it — `active` is parent-controlled by `activeNoteId`,
not by DOM focus.

The reliable test trigger: `flushByNavigatingAway(page)` navigates to a
different chapter, which unmounts every note card. Each card's unmount-
flush effect ([web/src/components/NoteCard.tsx:229](web/src/components/NoteCard.tsx:229))
runs and queues the pending edit into the outbox.

## Scenarios

Each scenario is one Playwright test. All four users connect to the same
chapter unless noted.

### S1 — Adjacent verses, different users (the headline win) — **SHIPPED**

[tests/concurrency/s1-adjacent-verses.spec.ts](tests/concurrency/s1-adjacent-verses.spec.ts).
Alice navigates to ZEC 6:1, Bob to ZEC 6:2. Each fills their note textarea
concurrently, then navigates away to force unmount-flush. Polls
`/api/chapters/ZEC/6` until both edits appear. Asserts both texts match,
plus a sanity bound on version bumps.

If this passes, the basic isolation works end-to-end through outbox → API → D1.

### S2 — Same verse, different notes — **SHIPPED**

[tests/concurrency/s2-same-verse.spec.ts](tests/concurrency/s2-same-verse.spec.ts).
Same as S1 but both notes hang off ZEC 6:1. Asserts neither row contains
the other user's marker string ("ALICE" / "BOB") — catches verse-level (not
row-level) lock leaks.

### S3 — Same note, simultaneous typing (the conflict case)

- Both Alice and Bob open the *same* note.
- `await Promise.all([alice.type("Alice text"), bob.type("Bob text")])`.
- **Assert:** server state has exactly one of the two texts (whichever PATCH
  landed first wins). The **other** user sees a conflict indicator and their
  text is preserved in the outbox / local state — not silently dropped.

The pass/fail criterion here isn't "both texts merged" — that's a CRDT, and
this codebase deliberately doesn't have one. It's "the loser knows they
lost and their work isn't gone."

### S4 — Outbox survives a network outage

- Alice goes offline: `await context.setOffline(true)`.
- Alice types into a note. Confirm the outbox shows "pending."
- Bob (still online) edits a *different* note successfully.
- Alice goes online: `await context.setOffline(false)`.
- Wait for outbox drain.
- **Assert:** both edits land on the server, in order. Neither was lost.

### S5 — Forced 409 via stale version — **SHIPPED (×2)**

[tests/concurrency/s5-version-mismatch.spec.ts](tests/concurrency/s5-version-mismatch.spec.ts).
Pure-API, no browser. Two tests:

- Two PATCHes with the same `If-Match`: one returns 200, the other 409 with
  body shape `{error: "version_mismatch", current: {...}}` (per
  [api/src/rows.ts:434](api/src/rows.ts:434)). Server state matches the winner.
- Loser re-reads the current version from the 409 body, retries with the fresh
  `If-Match`, succeeds. Proves the recovery contract the outbox relies on.

These are the contract every UI test implicitly depends on.

### S6 — Broadcast: B sees A's edit — **SHIPPED (×3)**

[tests/concurrency/s6-realtime-push.spec.ts](tests/concurrency/s6-realtime-push.spec.ts).
Alice mutates an open chapter while Bob is already viewing it. Covers PATCH,
POST, and DELETE propagation through the ChapterRoom WebSocket path.

### S7 — Offline and retry resilience — **SHIPPED (×2)**

[tests/concurrency/s7-offline-resilience.spec.ts](tests/concurrency/s7-offline-resilience.spec.ts).
One test queues edits while the browser context is offline and asserts they
flush on reconnect. The second injects transient server failure and asserts
retry drains the outbox without duplicate writes.

### S8 — Trash/restore visibility — **SHIPPED**

[tests/concurrency/s8-trash-restore.spec.ts](tests/concurrency/s8-trash-restore.spec.ts).
Alice trashes a TN row; Bob sees it remain visible and restorable. Restore
returns it to the live set before nightly finalization.

## Forcing the race deterministically

Real-clock races are flaky. For S3 and S7, use `page.route` to delay one
client's PATCH until the other has been sent:

```ts
await alicePage.route("**/api/rows/**", async (route) => {
  await new Promise((r) => setTimeout(r, 200));
  await route.continue();
});
```

Now Bob's PATCH always lands first, the conflict resolution is deterministic,
and we assert against a known winner instead of "whoever got there." This is
the trick that turns a 95%-passing concurrency test into a 100% one.

## Assertions: where to read truth from

In order of preference:

1. **Server.** `context.request.get("/api/chapters/OBA/1")` — D1 is the source
   of truth. If the server is right, the system is right.
2. **Other user's UI.** Proves broadcast + read paths, not just write.
3. **The writer's own UI.** Weakest signal; can pass even if the write never
   left the browser. Use only for outbox-state assertions ("pending" / "saved").

For each scenario, write the server check first. UI checks come second.

## Known gotchas (learned during implementation)

- **MUI multiline renders TWO textareas per field.** The hidden one
  (`aria-hidden="true" readonly`) is for autoresize measurement. Always filter
  it out before `.nth()`. See `noteTextarea` in helpers.
- **MUI's `inputProps["aria-label"]` doesn't reach the a11y tree for multiline
  fields.** `getByRole("textbox", { name: "Note" })` won't match — fall back to
  the position selector above.
- **Saves don't fire on blur.** A NoteCard saves only when its `active` prop
  flips false (a different card was focused) or when it unmounts. `body` clicks
  / blur do nothing. Tests use `flushByNavigatingAway` to unmount.
- **`#/ZEC/6` lands on verse 1.** The resource column filters notes to the
  active verse, so a row on v2 isn't even mounted at the default. Navigate
  with `gotoVerse(page, "ZEC", 6, 2)` to make a v2 row addressable.
- **IndexedDB is per-context.** Good — each "user" gets a fresh outbox. But
  always go through `browser.newContext()`, never `browser.newPage()`.
- **Vite + Wrangler startup is ~10s.** `webServer.reuseExistingServer: true`
  so consecutive runs reuse a running dev server. The webServer URL polls
  `/api/health` *through the Vite proxy*, ensuring both servers are up.
- **Cookie session TTL.** Local dev sessions use the same Access/Refresh cookie
  path as production. If tests start failing with 401 mid-run, the signing key
  or local session table probably changed.

## CI (not yet wired)

When this lands in CI, a single job:

```yaml
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npm --workspace api run db:migrate:local
- run: npm run test:e2e
- if: failure()
  uses: actions/upload-artifact@v4
  with: { name: playwright-report, path: playwright-report }
```

The Playwright HTML report (at `playwright-report/`) is the single most
useful artifact when a concurrency test flakes. Always upload it.

## Where to extend next

The remaining scenarios from the original plan, in priority order:

1. **S3 — Same-note conflict UI.** Two users on the same note. Use `page.route`
   to delay one PATCH for determinism. Assert: server has one text, loser's
   UI surfaces a conflict and preserves their attempted text locally.
2. **Four-user chaos.** Once the shipped suite is stable, repeat-each×10 for flake
   surfacing.

## What this does NOT do

- Doesn't test the nightly DCS export path. That's a separate worker, separate
  fixture, and not a concurrency concern.
- Doesn't test alignment UI. Lives in its own modal with its own save protocol;
  needs its own plan when it stabilizes.
- Doesn't replace unit tests for the outbox state machine. Concurrency tests
  prove the system behaves end-to-end; unit tests prove the pieces are right.

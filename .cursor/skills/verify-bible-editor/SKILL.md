---
name: verify-bible-editor
description: Drive the bible-editor web UI (Vite + Wrangler local stack) the way a translator would — launch, doctor, browser interact, capture proof. Use when smoke-testing a frontend change, proving a feature from the map, or wrapping UI work before calling it done. Prefer this over handing a click-through back to the user.
---

# Verify bible-editor

Agent-facing control surface for the **bible-editor** SPA. Primary surface is the web UI at the Vite origin (API proxied under `/api/*`). Secondary surfaces: REST `/api/*` (Hono Worker), Playwright concurrency suite under `tests/concurrency/` (multi-tab races — not the default smoke path).

You are writing for yourself cold: follow Launch → Doctor → Drive → Evidence → Cleanup exactly. Prefer mapped feature recipes under `features/`. Never invent selectors when a feature file already names them.

## Interview facts (ground truth)

| Concern | Fact |
| --- | --- |
| Surface | React SPA (`web/`), hash routes `#/{BOOK}/{chapter}/{verse}` |
| Launch | `npm run dev` = Vite `:5173` + `wrangler dev` `:8787`. On many Windows hosts **svchost holds 5173** — use free ports (helpers default to **5174 / 8788**). |
| Auth | Dev silent mint via `POST /api/auth/dev` when `DEV_AUTH_ENABLED=true` (default in `api/wrangler.toml`). Cookies `be_access` + `be_csrf`. Flag `localStorage['bible-editor.signed_out']==='1'` blocks remint. |
| Seed | ZEC fixture via `node scripts/import-book.mjs ZEC` → `wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-ZEC.sql` from `api/`. |
| Drive | **cursor-ide-browser** MCP (this Cursor session). Fallback: chrome-devtools MCP. Playwright helpers in `tests/concurrency/helpers.ts` are the selector source of truth for notes. |
| Ready | `GET {BASE}/api/health` → JSON `{ ok: true, service: "bible-editor-api" }` (must go through Vite proxy so both processes are up). |
| Isolate | Default ports are machine-shared. **Only drive an instance whose ports match `run/current.json` from a Launch this skill started.** Do not click through the user's everyday tab. |

## Launch

From repo root `C:\GH\bible-editor` (or the worktree under test):

```powershell
powershell -File .cursor/skills/verify-bible-editor/scripts/launch.ps1
```

What it does:

1. Ensures `npm install` has been run once.
2. Applies local D1 migrations (`bible_editor_dev`).
3. Seeds ZEC into local D1 (idempotent).
4. Picks free ports (defaults **web 5174**, **api 8788**; override with `-WebPort` / `-ApiPort`).
5. Starts `wrangler dev --port <api> --ip 127.0.0.1` in `api/` and `vite --port <web> --strictPort` in `web/` with `VITE_API_PROXY=http://127.0.0.1:<api>`.
6. Waits until `{BASE}/api/health` returns `ok`.
7. Writes `run/current.json` (ports, PIDs, base URL, run id) and prints `BASE_URL=...`.

**Ready signal:** health JSON includes `"service":"bible-editor-api"`. Log lines alone are insufficient — Vite can answer `/` while Wrangler is still booting.

**Teardown:** always run Cleanup (below). Do not `Stop-Process -Name node` / `wrangler` by name.

Worktree note: if verifying a worktree, `cd` there first and run the same script (worktree must have its own `npm install` / `scripts/worktree-init.ps1`). Do not point Vite at main while editing a worktree.

## Doctor

Read-only. Run whenever anything looks off, and always before Drive:

```powershell
powershell -File .cursor/skills/verify-bible-editor/scripts/doctor.ps1
```

Exit `0` only when all pass:

1. `run/current.json` exists and names a base URL.
2. Both recorded PIDs are still alive.
3. `GET {BASE}/api/health` → `ok` + `bible-editor-api`.
4. `POST {BASE}/api/auth/dev` with `{"username":"verify"}` → `200` (dev auth live).
5. `GET {BASE}/api/chapters/ZEC/1` with the mint cookies → `200` and at least one `tn` row (seed present).

If Doctor fails: Cleanup, Launch again, Doctor again. Do not Drive a half-up stack.

## Drive

Harness: **cursor-ide-browser** MCP.

Order every session:

1. Doctor.
2. `browser_tabs` → list; open/select a tab.
3. `browser_navigate` to `{BASE}/#/ZEC/1/1` (from `run/current.json`).
4. `browser_lock` `{ action: "lock" }` before interactions.
5. `browser_snapshot` for refs; click/type/fill via refs — not coordinates.
6. On failure: screenshot + filter network to `/api/` + console messages.
7. `browser_lock` `{ action: "unlock" }` when fully done.

Stable handles (prefer these):

| Intent | Handle |
| --- | --- |
| Hash nav | `/#/ZEC/{chapter}/{verse}` |
| Note card | `[data-note-id="{id}"]` |
| Note body edit | inside card, element with `title="click to edit"`, then real `textarea:not([aria-hidden="true"])` (Note field is 2nd; Quote is 1st) |
| Note save | button containing `[data-testid="SaveIcon"]` on that card (only while dirty) |
| Note history | clickable version `Chip` labeled `v{N}` / `v{N}*` on the card |
| Scripture modes | toolbar buttons whose accessible names are the tooltips: `verse-by-verse stacked card (default)`, `parallel-column doc view of the current chapter`, `whole-book scroll across all enabled versions (lazy loads as you scroll)` (visible labels still read `rows` / `columns` / `book`) |
| Go-to ref | TopBar textbox accessible name `go to ref` |
| Find overlay | button `find`, or Ctrl/Cmd+F; fields `placeholder="find"` / `placeholder="replace"`; next/prev aria-labels `next match (Enter)` / `previous match (Shift+Enter)` |
| Versions (columns/book) | `aria-label="visible versions"` |
| Sign-out recovery | clear `localStorage['bible-editor.signed_out']` then reload, or click `Sign in (dev)` |
| Auth toast trap | stale signed-out flag — remove item and reload |

Do **not** prove saves via internal React setters or by writing D1 by hand. Proof path is UI → outbox → `PATCH` → server readback (`GET /api/chapters/...` or reopen the note).

Playwright concurrency (`npm run test:e2e`) is a different harness for multi-user races; use it when the change is concurrency-specific, not as the default single-feature smoke.

## Evidence

Directory: `.cursor/skills/verify-bible-editor/artifacts/<run-id>/`

Required for a pass:

1. **Action + result**, not only a final screen — e.g. before/after screenshot or ARIA snapshot pair.
2. **Side effect** when the feature mutates data — e.g. `GET /api/chapters/ZEC/1` JSON snippet showing the new note text, or network log of `PATCH /api/rows/tn/...` → `200`.
3. `summary.md` naming feature id, entry point used, base URL, and pass/fail.

Screenshots from the browser MCP land under the Cursor temp screenshots folder; **copy them into** `artifacts/<run-id>/` before Cleanup (Cleanup does not move screenshots).

Naming:

```
artifacts/<run-id>/
  summary.md
  01-before.png
  01-before.aria.yml
  02-after.png
  02-after.aria.yml
  side-effect.json   # optional API readback
```

Proof standards: real user path only; no mocks unless the production boundary already isolates the system (DCS OAuth is already bypassed by `/api/auth/dev` in local — that is the intended local auth boundary).

## Cleanup

```powershell
powershell -File .cursor/skills/verify-bible-editor/scripts/cleanup.ps1
```

Stops only the PIDs recorded in `run/current.json`, removes `run/current.json`, leaves `artifacts/` intact. Confirm artifacts still exist after cleanup.

If Launch failed mid-way, still run Cleanup (script is safe when no run file exists).

## Helpers

All under `.cursor/skills/verify-bible-editor/scripts/`:

| Script | Purpose |
| --- | --- |
| `launch.ps1` | Seed + start isolated Vite/Wrangler; write `run/current.json` |
| `doctor.ps1` | Read-only health / auth / seed check |
| `cleanup.ps1` | Kill launched PIDs only; preserve artifacts |
| `seed-zec.ps1` | Generate + apply ZEC SQL to local `bible_editor_dev` (called by launch) |

Examples:

```powershell
powershell -File .cursor/skills/verify-bible-editor/scripts/launch.ps1 -WebPort 5174 -ApiPort 8788
powershell -File .cursor/skills/verify-bible-editor/scripts/doctor.ps1
powershell -File .cursor/skills/verify-bible-editor/scripts/cleanup.ps1
```

## Feature map

See [`features/README.md`](features/README.md). Drive the feature file that matches the change; covering one convenient entry point is incomplete when the map lists others.

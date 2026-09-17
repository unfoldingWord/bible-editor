# bible-editor verification map

Maintained source for verifying user-facing behavior of the bible-editor SPA. Read this index, then the matching feature file.

## Baseline preconditions

- Launch via `powershell -File .cursor/skills/verify-bible-editor/scripts/launch.ps1` from the repo (or worktree) root.
- Doctor via `powershell -File .cursor/skills/verify-bible-editor/scripts/doctor.ps1` must exit 0.
- Base URL comes from `run/current.json` (typically `http://127.0.0.1:5174` — **not** 5173 when Windows svchost holds it).
- Local D1 is seeded with **ZEC** (TN/TQ/TWL + verses). Prefer ZEC for recipes; default cold landing without a hash is OBA and may be empty until imported.
- Dev auth is on (`DEV_AUTH_ENABLED=true`). Cold load silent-mints as `dev` unless `localStorage['bible-editor.signed_out']==='1'`.
- Never drive an instance that was not started by this verification Launch (or whose ports fail Doctor).

## Driving conventions

- Harness: **cursor-ide-browser** MCP (`browser_navigate`, `browser_lock`, `browser_snapshot`, `browser_click`, `browser_type` / `browser_fill`, `browser_take_screenshot`, unlock when done).
- Prefer ARIA names, button labels (`rows` / `columns` / `book` / `find`), and `[data-note-id]` over CSS position.
- Start every recipe from `#/ZEC/...` unless the feature says otherwise.
- Restore mutated fixture notes when a recipe says so. Never delete `artifacts/`.

## Proof and skip reporting

- Capture the user action and the resulting state (before + after).
- UI proof: ARIA snapshot + screenshot with scripture/note identity visible.
- Mutation proof: second view — reopen the note or `GET /api/chapters/ZEC/{chapter}` showing the saved value.
- Record feature ID and entry point in `artifacts/<run-id>/summary.md`.
- An unreachable entry point is a fail for that path, not a pass via a different path.

## Feature entry contract

Each feature file: H1 + one paragraph, then exactly these H2s in order — `Sub-features`, `How to get to it (user POV)`, `Driving it with cursor-ide-browser`, `Gotchas`.

## Features

- [Navigate chapter / verse](./navigate-chapter.md) — hash routing and TopBar go-to.
- [Edit a translation note](./edit-tn-note.md) — activate, edit body, Save, server persist.
- [Find and replace](./find-replace.md) — open Find, match, navigate hits.
- [Scripture view modes](./scripture-modes.md) — rows / columns / book toggles.
- [Note history](./note-history.md) — open version history from the note chip.

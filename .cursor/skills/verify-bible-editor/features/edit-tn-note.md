# Edit a translation note

A translator can open a TN card, edit the note body with a single click on an inactive card, Save, and see the text persist through the outbox to the API.

## Sub-features

- `tn-activate-edit` — one click on the read body focuses the editable textarea.
- `tn-save` — Save icon appears while dirty; click enqueues PATCH.
- `tn-persist` — server chapter payload reflects the new body.

## How to get to it (user POV)

- Navigate to a verse that has TN rows (e.g. `#/ZEC/8/1`).
- Click the note body (`click to edit`).
- Edit text; click the Save control on that card (filled Save icon while dirty).

## Driving it with cursor-ide-browser

Preconditions:

- Doctor passed; BASE from `run/current.json`.
- Prefer a throwaway note: `POST {BASE}/api/rows/tn` with CSRF from a prior `POST /api/auth/dev` (see Playwright `tests/concurrency/s11-note-body-single-click-edit.spec.ts`), **or** edit an existing fixture note and restore the original text afterward.

- **Open verse.** `browser_navigate` → `{BASE}/#/ZEC/8/1`. Wait until `[data-note-id]` nodes exist (`browser_snapshot`).
- **Activate body.** Click the element with `title="click to edit"` inside the target `[data-note-id="…"]`. Snapshot shows a focused textarea (not the read view).
- **Edit.** `browser_fill` / `browser_type` a unique marker string (include a run id).
- **Save.** Click the card button that contains `data-testid="SaveIcon"` (MUI Save icon; only present while dirty).
- **Persist.** Poll `GET {BASE}/api/chapters/ZEC/8` (cookies from the browser session or a fresh dev mint) until that row's `note` contains the marker (up to ~10s for outbox drain).
- **Proof.** `02-after.png` + `side-effect.json` (row snippet) + `summary.md` with feature id `edit-tn-note`.

## Gotchas

- Each MUI multiline field renders two textareas; ignore `aria-hidden="true"`. Quote is the first real textarea; **Note is the second**.
- Notes do not autosave on blur; without Save the PATCH never leaves the draft cache.
- Save icon locator is `button:has([data-testid="SaveIcon"])` — the outlined idle icon is different and means not dirty.
- Stale auth: 401s leave edits in the outbox; do not clear the outbox on auth failure — remint / `Sign in (dev)` and wait for drain.
- Do not use this recipe against a shared everyday browser profile that has unsaved translator work.

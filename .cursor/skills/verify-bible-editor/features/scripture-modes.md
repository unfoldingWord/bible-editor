# Scripture view modes

A translator can switch the scripture column among stacked rows, parallel columns, and whole-book scroll without losing the active verse identity.

## Sub-features

- `mode-rows` — default stacked active-verse card (`rows` button).
- `mode-columns` — parallel doc columns for the chapter (`columns` button).
- `mode-book` — lazy whole-book view (`book` button).
- `mode-versions` — in columns/book, toggle visible versions via `aria-label="visible versions"`.

## How to get to it (user POV)

- In the Scripture toolbar, click the buttons labeled `rows`, `columns`, or `book` (accessible names are the longer tooltips — see Driving).
- In columns/book, use the version toggle group to show UHB/UGNT/ULT/UST (available set depends on book).

## Driving it with cursor-ide-browser

Preconditions:

- Doctor passed; `{BASE}/#/ZEC/1/1` loaded with notes visible.

- **Rows.** Click the button named `verse-by-verse stacked card (default)` if not already selected. Snapshot shows stacked verse UI.
- **Columns.** Click `parallel-column doc view of the current chapter`. Snapshot shows parallel columns; version toggle `aria-label="visible versions"` is present.
- **Book.** Click `whole-book scroll across all enabled versions (lazy loads as you scroll)`. Snapshot shows book-mode scroll surface; lazy load may fetch more chapters on scroll.
- **Return.** Click the rows tooltip-named button again so later recipes start from default.
- **Proof.** One screenshot per mode (`mode-rows.png`, `mode-columns.png`, `mode-book.png`) with `ZEC` visible. `summary.md` lists entry points exercised.

## Gotchas

- Mode persists in localStorage (`ScriptureMode`); a previous session may already be on `book`.
- Version toggles require at least one version selected (UI rejects emptying the group).
- Book mode find/replace semantics differ (loaded chapters only) — see find-replace feature.

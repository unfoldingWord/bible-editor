# Navigate chapter / verse

A translator can open a specific book, chapter, and verse so the scripture column and resource notes focus on that location.

## Sub-features

- `nav-hash` loads a location from the URL hash.
- `nav-goto` jumps via the TopBar reference field (e.g. `8:1` or `zec 8:1`).
- `nav-chapter-arrows` moves to previous/next chapter with the TopBar chevrons.

## How to get to it (user POV)

- Paste or set the hash `#/ZEC/8/1` (verse omitted → verse 1).
- Type a reference in the TopBar textbox named `go to ref` and press Enter (e.g. `1:1`, `zec 5:5`).
- Click the TopBar chapter chevrons (tooltips `previous chapter` / `next chapter`).

## Driving it with cursor-ide-browser

Preconditions:

- Doctor passed; BASE from `run/current.json`.
- ZEC is seeded.

- **Hash entry.** Navigate to `{BASE}/#/ZEC/8/1`. Run `browser_navigate` to that URL, then `browser_snapshot`. TopBar book combobox is `ZEC`, chapter combobox is `8`, and the Scripture panel shows the active stacked card for 8:1 (ULT/UST/UHB). Note: ZEC 8:1 may have **zero TN** rows (`Notes 0`) — that is still a valid nav proof; use `#/ZEC/1/1` when you need note cards.
- **Go-to field.** From `#/ZEC/8/1`, focus the TopBar textbox named `go to ref`, type `1:1`, press Enter. URL becomes `#/ZEC/1` (verse 1 implied), chapter combobox is `1`, and Resources shows note cards when present.
- **Chapter arrow.** From mid-book, click the unlabeled chevron beside the chapter combobox (tooltip `next chapter` / `previous chapter`). Prefer starting at chapter 8 so next → 9.
- **Proof.** Save before/after screenshots + ARIA extracts showing the chapter change. Record entry points in `summary.md`.

## Gotchas

- Default hash-less load is **OBA**, not ZEC — always set the hash for fixture recipes.
- Vite must proxy `/api` or chapter fetch 502s and the UI looks empty.
- `bible-editor.signed_out` in localStorage shows the Door43 sign-in screen; clear it or use `Sign in (dev)`.
- Book codes are uppercase in the hash (`ZEC`, not `zec`) after parse; go-to accepts mixed case.

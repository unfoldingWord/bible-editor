# Find and replace

A translator can search scripture (and optionally TN bodies) in the current chapter or loaded book chapters, step through matches, and replace when the book is unlocked.

## Sub-features

- `find-open` opens the overlay from the toolbar or keyboard.
- `find-match` lists matches for a query in the find field.
- `find-next-prev` moves between matches.
- `find-replace-one` replaces the active match when unlocked (optional deeper proof).

## How to get to it (user POV)

- Click the scripture toolbar button labeled `find`.
- Press Ctrl+F (Windows) / Cmd+F (macOS) while the editor is focused.
- Use fields with placeholders `find` and `replace`; next/prev controls use aria-labels `next match (Enter)` and `previous match (Shift+Enter)`.

## Driving it with cursor-ide-browser

Preconditions:

- Doctor passed; navigate to `{BASE}/#/ZEC/1/1` (known fixture text).
- Book is not locked (replace disabled when locked; find still works).

- **Open.** Click the button named `find` (or press Ctrl+F). Snapshot shows the find overlay with a textbox `placeholder="find"`.
- **Query.** Fill find with a short token known to appear in ZEC 1 ULT/UST (pick from on-screen verse text after snapshot). Matches UI updates (count / highlighted hits).
- **Next.** Click the control with aria-label `next match (Enter)`. Active match chrome moves.
- **Proof (smoke).** Screenshots: overlay open with query + at least one match indicated. `summary.md` feature id `find-replace`, entry `toolbar find`.
- **Optional replace proof.** Fill `replace`, replace one match, then confirm verse text via UI and/or chapter API. Restore original text afterward.

## Gotchas

- Ctrl+F while a different browser chrome has focus may open the browser's own find — click the page first.
- In `book` mode, find spans loaded chapters only; scroll/lazy-load before asserting absence.
- Locked books: find stays available; replace controls are disabled.
- Closing Find clears draft find state intentionally; chapter changes can remount the overlay while keeping session open state.

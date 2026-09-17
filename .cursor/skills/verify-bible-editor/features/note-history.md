# Note history

A translator can open a TN row's version history from the version chip on the note card and inspect prior saved bodies.

## Sub-features

- `history-open` opens the history dialog from the `v{N}` chip.
- `history-list` shows prior versions when edits exist (fresh imports may be empty / first-save only).

## How to get to it (user POV)

- On a note card, click the small outlined chip labeled `v{version}` (or `v{version}*` when unsaved diffs exist). Tooltip mentions history.

## Driving it with cursor-ide-browser

Preconditions:

- Doctor passed; `{BASE}/#/ZEC/1/1` (or a verse with TN).
- Prefer a row that has been saved at least once in this environment; if history is empty, that is still a valid open proof — record it.

- **Locate chip.** Snapshot; find the button whose name starts with `v` and includes `Click to view history` inside the note card (e.g. `v1 — saved 0 times; … Click to view history.`).
- **Open.** Click that chip. Dialog/heading for note history appears (lazy-loaded `NoteHistoryDialog`).
- **Proof.** Screenshot of open dialog + card identity. Close dialog. `summary.md` feature id `note-history`.

## Gotchas

- Unsaved dirty state shows `*` on the chip; opening history does not save.
- History begins at the first saved edit; pristine imports may show little or no prior body — do not fail solely on empty list if the dialog opened.
- Soft-deleted / trash flows are out of scope here (see concurrency `s8-trash-restore`).

# bp-assistant ↔ bible-editor: kept-notes contract

## Status

**Shipped on the bot side** (bp-assistant PR #441, release 507). The editor
sends the list only when `KEPT_NOTES_ENABLED = "true"`; the flag is off until
the live test on EZK 40 passes. Issue: bible-editor#1152.

## Why it exists

The export always blanks the TSV Tags column, so master cannot tell the bot
which notes a translator kept. Before this, every AI notes run deleted the
kept notes from en_tn, let the AI write duplicates, and the next nightly export
re-added the originals from D1 (EZK 40, 2026-10-06: 60 preserved and 2 edited
notes). The editor now sends the list itself.

## What the editor sends

`POST /api/pipeline/start`, notes runs only, in `options.kept`:

```json
{ "rowId": "cyfz", "ref": "40:12", "supportReference": "rc://*/ta/man/translate/figs-metaphor", "quote": "…" }
```

| Field | Rule |
|---|---|
| `rowId` | `/^[a-z][a-z0-9]{3}$/`. Rows with any other id are not sent. |
| `ref` | The row's `ref_raw`: `40:12`, `40:12-14`, `40:48-41:2`, `40:intro`, `40:front`. Max 20 chars, must not run backwards. A row whose ref does not match (e.g. `front:intro`) is not sent. |
| `supportReference` | Cut to 100 characters. |
| `quote` | Sent as `""` when longer than 500 characters. |
| `note` | Not sent. The bot does not use it, and its schema is `.strict()`. |

Limits: at most 3000 entries, no repeated `rowId`, no `rowId` also in
`options.hints`. **One bad entry makes the bot return 400 for the whole run**,
so the editor filters before sending. Over 3000 entries, the job fails with
`kept_notes_unavailable: too many kept notes for one run; run fewer chapters`
instead of truncating.

The bot keeps those rows by id in en_tn, drops AI notes with the same verse
span, support reference (without `rc://`) and normalized quote, and treats
their verses as covered for gap-fill.

## Which notes are kept

`api/src/keptNotes.ts` (`classifyKept`). Candidates are live, not trashed,
`hint = 0`, and `preserve = 1` or `updated_by IS NOT NULL`. Pristine rows are
never kept. A candidate is kept when, in order:

1. `preserve = 1`;
2. it came from the 2 Kings → Isaiah migration (`parallel_migration`) and the AI has not rewritten it since;
3. its latest content write is a hint expansion (`hint_expansion`);
4. a person changed its quote, note or support reference after the AI's last write (or after creation, if the AI never wrote it), and the content now differs from that AI baseline. Comparison is normalized (literal `\n`, NFC, curly vs straight quotes, dashes, whitespace). Reorders, whitespace-only saves, edits reverted to the AI text, and the `quote_repair` / 2026-09-11 repair batch do not count. A saved AI Suggest counts as the person's edit;
5. no create entry in `edit_log` (history pruned after 180 days): kept unless the latest content write was the AI's.

## When the list is built

At dispatch time in `dispatchNext`, never stored in `options_json`. A queued run
gets the current list. The "Generate everything" chain's notes step goes through
the same path. If the list cannot be built, the job fails rather than
dispatching without it.

## Resume

The editor does not send `kept` on `/resume`; the bot reuses the list saved in
its checkpoint. `resumeOptionsFromJson` strips it defensively.

## Flag

`KEPT_NOTES_ENABLED`, exact `"true"` (like `INTRO_HINTS_ENABLED`), in
`wrangler.toml` `[vars]` and `[env.production.vars]`. Set it to `"false"` and
redeploy to switch the feature off at once.

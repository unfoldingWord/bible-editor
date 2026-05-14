# bp-assistant: TN hint expansion contract

## Context

bible-editor (the translator-facing app) now lets editors mark TN rows as "hints" — issue type + quote phrase + optional seed prose — and queue them for the next chapter-wide notes pipeline run. Today, `/api/pipeline/start` from bible-editor sends `{ pipelineType: "notes", book, startChapter, endChapter, username, sessionKey, options? }` and the `notes` skill (`tn-writer`) emits a TSV that bible-editor merges, sweeping every un-kept row first. We're adding `options.hints` so the editor can pre-seed specific notes the AI must produce, and so those specific seed rows aren't clobbered by the sweep.

The bible-editor side is already shipped behind a flag on the API: an editor can mark hints today, but they don't reach you yet because we're gating the upstream change. This brief is the contract bp-assistant needs to land for the end-to-end flow.

## What bible-editor will send

`POST /api/pipeline/start` body gains an optional `options.hints` array:

```json
{
  "pipelineType": "notes",
  "book": "ZEC",
  "startChapter": 7,
  "endChapter": 7,
  "username": "...",
  "sessionKey": "...",
  "options": {
    "hints": [
      {
        "rowId": "ab12",
        "verse": 7,
        "quote": "מֵרֵעֵהוּ",
        "supportReference": "rc://*/ta/man/translate/figs-metaphor",
        "seed": "Could be either the neighbor's view or the speaker's view — need both options."
      },
      {
        "rowId": "cd34",
        "verse": 9,
        "quote": "וְ⁠נִכְרַ֖תָּ",
        "supportReference": "rc://*/ta/man/translate/figs-idiom",
        "seed": null
      }
    ]
  }
}
```

Field semantics:

- `rowId` — opaque 4-char string. bible-editor's stable TN row id. **Must be echoed back unchanged** (see output below).
- `verse` — integer. The verse the hint targets.
- `quote` — string. Source-language phrase the note explains. May be Hebrew, Greek, or empty.
- `supportReference` — string or null. The issue type / TA link.
- `seed` — string or null. Editor's seed prose for the note. May be a stub like `"This could mean: (1) NOTE Alternate translation: [ALT] (2) NOTE Alternate translation: [ALT]"`, a one-line reason, or null. Expand into a fully-formed note when present; write fresh when null.

`hints` may be empty / absent on any run.

## What tn-writer must do

For each hint:

1. **Produce exactly one TN row** whose `verse`, `quote`, and `supportReference` match the hint. Use the `seed` as guidance for content; produce a complete, well-formed note (not just the seed echoed back).
2. **Echo `rowId` as `hintRowId`** in the output (see TSV column below). bible-editor uses this to UPDATE the existing stub row in place rather than INSERT-new + delete.
3. **Suppress competing notes** for the same `(verse, quote)` pair. The translator has already chosen the issue framing — don't generate alternative notes that would conflict.

For verses not covered by a hint: behave exactly as today.

## Output format

Existing notes TSV columns stay as-is. Add one optional column at the end: `HintRowID`.

- For AI-generated rows expanding a hint: `HintRowID` = the hint's `rowId`.
- For all other rows (normal AI output): `HintRowID` empty.

If TSV column addition is awkward, a sidecar JSON `hints-applied.json` with `[{ hintRowId, tnRowIdInTsv }]` is acceptable instead — let us know which you prefer.

## What bible-editor will do on its side

(For your awareness, not your responsibility.)

- Server-side gather: at `/api/pipelines/start` time, bible-editor SELECTs all `hint = 1` rows in scope from D1 and folds them into `options.hints`. The wire shape above is authoritative — what's in D1 at start time, not whatever was in the editor's local cache.
- Sweep filter already excludes `hint = 1` rows, so the stub survives until your output lands.
- Apply phase: when a TN proposal carries `HintRowID`, bible-editor UPDATEs the existing row in place (preserving `updated_by`, version history, sort position). Standing authorship stays with the human; `edit_log` records the AI as the writer of that revision but the row's AI chip is **not** shown (the note's existence is human-attributed).

## Verification

Minimal smoke test from bp-assistant side:

1. Call `tn-writer` (or whichever skill `pipelineType: "notes"` dispatches to) with `options.hints` containing two entries, one with a `seed`, one with `seed: null`.
2. Verify the output TSV has:
   - Exactly one row per hint matching `(verse, quote, supportReference)`.
   - `HintRowID` populated with the corresponding `rowId`.
   - No second note generated for the same `(verse, quote)`.
   - Normal output for un-hinted verses.
3. Confirm `repo-insert` (or however output is committed) carries the `HintRowID` column through unchanged.

## Open coordination points

- Confirm `options` pass-through reaches the skill — bible-editor currently treats it as opaque.
- Confirm column-add vs sidecar-JSON preference for `HintRowID`.
- Confirm there's no concurrency rule that would reject `options.hints` (e.g. existing schema validation in `api-runner/`).

Tag the bible-editor side (`deferredreward/bible-editor`, branch `claude/note-hints-preservation-LrRj7`) when the contract lands so we can wire up Ship 2 (proxy gather + apply-phase routing) against it.

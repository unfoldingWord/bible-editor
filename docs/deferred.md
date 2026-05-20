# Deferred work

These are items from the original plan / red-team review that intentionally
weren't shipped in the current pass. Each carries enough context to pick up
cold. The fixes that *did* land are summarized at the bottom.

## Auth — finish the DCS path

**Status:** A dev-only mint endpoint (`POST /api/auth/dev`, gated by
`DEV_AUTH_ENABLED`) and an `attachAuth` / `requireAuth` middleware exist.
`docs/plan.md §Auth` calls for full DCS OAuth.

**What's missing:**
- `GET /api/auth/dcs/start` — redirect to `DCS_OAUTH_AUTHORIZE_URL` with the
  configured `DCS_CLIENT_ID`, a PKCE challenge, and a state cookie.
- `GET /api/auth/dcs/callback` — exchange the code at
  `DCS_OAUTH_TOKEN_URL` (using `DCS_CLIENT_SECRET`), fetch the user from
  `${DCS_BASE_URL}/api/v1/user`, upsert the `users` row keyed by
  `dcs_user_id`, then mint the same JWT shape that `mintDevToken` returns.
- `GET /api/auth/me` — return `{ userId, username, fullName }` from the
  bearer claim so the SPA can show "signed in as …".
- Silent refresh — at 14-day TTL it doesn't matter for a 7-month tool, but
  shorter TTL + a `/api/auth/refresh` endpoint is the standard upgrade.
- Replace the dev sign-in in `web/src/App.tsx` with a redirect to
  `/api/auth/dcs/start` when no token exists. Keep `devSignIn` behind
  `import.meta.env.DEV` only.

**Bounded by:** needs a registered DCS OAuth app (client id + secret).

## Nightly DCS export

**Status:** Cron is scheduled (`wrangler.toml: crons = ["0 6 * * *"]`) but
`scheduled(...)` in `api/src/index.ts:99` is empty.

**What's missing:**
- A worker module that walks `book_imports`, builds per-resource TSV
  (`tn_<book>.tsv`, `tq_<book>.tsv`, `twl_<book>.tsv`) and USFM
  (`<book>.usfm`) from the current D1 state.
- Commit those files to the corresponding DCS repo branches using
  `DCS_SERVICE_TOKEN`. The DCS API surface: `PUT /api/v1/repos/:owner/:repo/contents/:path`.
- Record the resulting `commit_sha` in `export_snapshots`. The table exists
  ([api/migrations/0001_init.sql:123-132](../api/migrations/0001_init.sql)).
- A `/api/exports` GET that lists recent snapshots so the SPA can show
  "last DCS export: 7 hours ago".

**Until this ships:** D1 is the only copy of edits. Add a manual export
button if delivery slips much past the tool's 7-month horizon.

## Presence — ChapterRoom Durable Object

**Status:** The DO class is exported and bound (`wrangler.toml:22-29`) but
no route forwards to it. The class itself ([api/src/chapterRoom.ts](../api/src/chapterRoom.ts))
echoes incoming WS messages with no auth and no message validation.

**What's missing:**
- A `GET /api/presence/:book/:chapter` route that:
  - Verifies the bearer token via `requireAuth`.
  - Upgrades to WebSocket only on `Upgrade: websocket`.
  - Forwards to `env.CHAPTER_ROOM.get(env.CHAPTER_ROOM.idFromName(\`${book}:${chapter}\`))`.
- DO-side auth: validate a short-lived ticket in the connect URL (the
  worker mints one against the JWT) so an open WS doesn't outlive a logout.
- Message schema (JSON envelope: `{type: "cursor"|"saved"|..., …}`),
  per-client rate limit, max message size, and broadcast-to-others (DO
  currently echoes back to the sender).
- SPA client: open the WS when Shell mounts a chapter, send "cursor at
  tn:xm1w" / "saved" events, render a coloured dot beside any peer's
  active resource. See `docs/plan.md §ChapterRoom` for the intended UX.

**Until this ships:** The yellow-dot rail indicator in
[lib/alignment.ts:233-241](../web/src/lib/alignment.ts) is the only
freshness signal. Peers can't see each other's cursors.

## Service worker + outbox-on-close warning

**Status:** Neither exists. The outbox already survives reload via
IndexedDB, but a `beforeunload` warning would catch the case where the
user closes the tab between drain ticks.

**What's missing:**
- `web/src/sw.ts` registered from `main.tsx`. Cache the SPA shell + drain
  the outbox when the worker wakes (Background Sync API).
- A `beforeunload` listener in `web/src/App.tsx` that calls
  `outbox.list()` and prompts if any op isn't `"ok"`. The user can already
  see the same info via `SyncStatusBar`, but a confirmation dialog
  prevents an accidental close.

## True conflict diff/merge UI

**Status:** `SyncStatusBar.tsx` re-arms a conflicted op with the server's
current version — last-edit-wins. That's safer than the previous "silent
stall", but the user can't see *what* the upstream change was.

**What's missing:**
- A modal that renders the local patch vs `conflictCurrent` side by side,
  with field-level "keep mine" / "take theirs" / "merge" actions.
- Per-field merge rules for the structured fields (`quote` and `occurrence`
  are coupled; `note` is free text; `support_reference` is enum-ish).
- See `docs/plan.md §Save protocol step 4` for the original intent.

## Catalogs from canonical ta/tw repos

**Status:** `api/src/catalogs.ts` bootstraps suggestions from whatever's
already in `tn_rows.support_reference` / `twl_rows.tw_link`. Typos
propagate.

**What's missing:**
- A `book_imports`-style importer that pulls
  `unfoldingWord/en_ta/translate/.../*.md` and
  `unfoldingWord/en_tw/bible/*/*.md` into dedicated tables
  (`ta_articles`, `tw_articles` with id, title, body, last_synced).
- Switch the catalog route to read from those tables.
- Refresh nightly alongside the DCS export.

## Import / export hardening

**Status:** `scripts/import-book.mjs` (referenced by review 2) doesn't
exist in the current tree. The flow is implied but not implemented.

**What's missing:**
- A real importer that ingests USFM (ULT/UST/UHB/UGNT) plus TSV (tn / tq /
  twl) for a book. Should be idempotent: re-importing the same source
  shouldn't bump `version` on rows whose content is unchanged.
- A matching exporter (separate from the nightly cron — useful for ad-hoc
  diffs).
- Round-trip tests against a known-good fixture (e.g. `ZEC` or `OBA`)
  covering split alignments, punctuation, and nested milestones.

## Per-row keystroke write-ahead

**Status:** Notes (`NoteCard.tsx`), words (`WordsTable.tsx`), and
questions (`QuestionsTable.tsx`) batch in refs and flush to the outbox on
blur / session-end / unmount. Verse content edits are debounced (350 ms)
and flushed on unmount.

**Trade-off:** A browser crash mid-typing loses the in-progress keystroke
buffer for notes/words/questions. The outbox safely handles everything
that's been flushed.

**What's missing if it matters:** Convert the row-editor flush path to
enqueue each debounced patch instead of holding it in a ref. Expect more
churn in the outbox (one op per ~350 ms of typing instead of one per
session) but stronger crash safety.

## UX correctness items (smaller scope)

| Item | Where | Notes |
|---|---|---|
| Yellow-dot flags intentionally-unaligned source words | [lib/alignment.ts:233-241](../web/src/lib/alignment.ts) | Function words (Hebrew prepositions, articles) get flagged as "TODO" forever. Need a "deliberately skip" marker. |
| `verseHasUnalignedWork` full-parses every call | same | Cache per (chapter, verse) so the rail isn't re-parsing 30× on chapter swap. |
| Hebrew separator regex | [lib/replace.ts:54](../web/src/lib/replace.ts) | `\s+` doesn't cover maqaf (`־`), paseq (`׀`), sof pasuq (`׃`). Likely irrelevant since find/replace is GL-only, but flagged. |
| `localizedRewriteVerse` NFC mismatch | [lib/replace.ts:381-396](../web/src/lib/replace.ts) | Case-sensitive plain↔raw mapping desyncs on differing NFC forms. Narrow edge. |
| Mixed MUI versions | [web/package.json:14-19](../web/package.json) | `@mui/styles@^6.5.0` is a deprecated v5-era package; safe today because nothing imports it. |
| Spike `AlignerSmoke.tsx` lives in `src/` | [App.tsx:1-2](../web/src/App.tsx) | "intentionally NOT imported" is human-enforced. Move to `spikes/` or gate behind `import.meta.env.DEV`. |
| `AGENTS.md` vs `CLAUDE.md` duplication | repo root | Both files have identical 176-byte content. Pick one and symlink. |
| `tn_rows.sort_order` migration overwrites on rerun | [migrations/0003_tn_sort_order.sql](../api/migrations/0003_tn_sort_order.sql) | Add `WHERE sort_order IS NULL`. Same for `0004_twl_sort_order.sql`. Cheap. |
| JSON parse failures silently → `null` | [api/src/chapters.ts:55-60](../api/src/chapters.ts), [api/src/verses.ts:29-32](../api/src/verses.ts) | A corrupt `content_json` renders as empty verse with no log. Add `console.error` at minimum; consider a server-side counter. |

## Surface `\ts\*` chunk markers from imported USFM

**Status:** Front-end ([PR #77](https://github.com/deferredreward/bible-editor/pull/77) onward) now renders, edits, and round-trips `\ts\*` chunk milestones — the moment they show up in `content_json.verseObjects` as `{tag:"ts", content:"\\*"}`, they appear in all three scripture views as a dashed chunk divider, are editable as a chip, drift to the next verse like `\q1`, and tokenize back on save.

**The gap:** `usfm-js` silently drops them at parse time. Measured on `docs/samples/en_ult_38-ZEC.usfm`: 154 raw `\ts\*` lines in source, 1 surviving node in the parsed JSON. So even after re-importing every book, the chunk markers stay invisible to the editor because they never enter D1 in the first place.

**Why this is OK to defer:** none of our current internal tooling actually consumes `\ts\*` for anything load-bearing — it's metadata for chunking translation work, useful for translators who want to see the chunk boundaries the source team set, but nothing downstream breaks without it. So this is a UX nice-to-have, not a data-integrity bug.

**Plan if we do want to fix it:**

1. **Post-process injection in the importer** (preferred). Re-scan the raw USFM line-by-line in parallel with `usfm.toJSON`, tracking which `\v N` block each `\ts\*` falls inside (or before, since usfm-js's convention is that markers preceding `\v` attach to the prior verse's verseObjects — `extractTrailingMarkers` already drifts them forward). For each `\ts\*` found, splice a `{tag:"ts", content:"\\*"}` node into the appropriate `verseObjects` array at the right offset.
   - Touch points: [scripts/import-book.mjs](../scripts/import-book.mjs) (one-shot path) and [api/src/importParsers.ts](../api/src/importParsers.ts) (the shared importer used by the inbound-from-DCS pipeline).
   - Round-trip safety check: `usfm.toUSFM` should re-emit `\ts\*` from `{tag:"ts", content:"\\*"}` cleanly — verify with a parse → serialize diff on ZEC.
2. **Alternative — pre-process swap.** Convert `\ts\*` to a placeholder marker usfm-js does preserve (e.g. a custom `\zts\*` milestone) before `toJSON`, then unswap on export. Quick but adds a hidden encoding that future readers of `verseObjects` won't expect.
3. **Patch / fork usfm-js.** Biggest lift; no obvious benefit over (1).

**Once data is flowing, re-import every book** to populate the missing nodes in existing rows. No frontend changes needed.

## What did land in this pass

- CORS: env allowlist replaces the origin-echo CSRF hole.
- Auth: `jose`-based HS256 verification, `requireAuth` gates every write,
  identity propagates to `updated_by` and `edit_log.user_id`. Dev token
  endpoint for local development.
- Optimistic concurrency: `If-Match` mandatory; the version check lives
  inside the `UPDATE … WHERE id = ? AND version = ?`. Two concurrent
  writers can no longer both succeed at the same version.
- Audit log atomicity: row + audit ship as one D1 batch with
  `INSERT … SELECT WHERE EXISTS` so the audit insert is conditional on the
  UPDATE matching.
- `bibleVersion` allowlist (ULT/UST/UHB/UGNT) on verse routes.
- Outbox hardening: in-flight ops are re-armed on startup; 408/425/429/5xx
  are now retried; per-target conflict isolation (one hot row doesn't
  freeze the queue); persist-error path resets to `pending` instead of
  stranding; `resolveConflict` re-arms every sibling op for the same
  target so one upstream change produces one resolution prompt.
- Stacked editor `ActiveLine` now saves: `onInput` debounced (350 ms),
  flushed on blur and unmount, with the highlight-resync effect guarded
  so it doesn't reset the caret on round-trip.
- `setVerseDone` routed through the outbox (offline-safe).
- `moveTarget` rejects unknown destination groups.
- Find/replace skips read-only versions, re-derives match positions per
  iteration (no more index drift after `normalize()`), and surfaces an
  alert when alignment milestones were destroyed.
- Sync-status pill in the corner with a "resolve N conflicts" action so
  `outbox.resolveConflict` has a UI caller.
- `DocColumn` flushes its debounced edit on unmount.

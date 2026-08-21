# Book locks

A **locked** book is frozen. Nobody can edit it in bible-editor, and the nightly
export never *starts a new push* to Door43. That does not, by itself, stop a
push already in flight: locking a book does not close or stop the merge of a
`-be-` PR that a previous night's export already opened, and Door43's merge
bot lands open PRs on its own schedule regardless of the lock (see "What a
lock does and does not stop" and Known gaps below). Two things can lock a book:

- **Published** — the book is part of unfoldingWord's newest release. Locked
  automatically, no database row needed.
- **Explicit** — somebody locked it by hand, typically because the book is done
  but not yet published.

Only three people may lock or unlock: `deferredreward` (Benjamin), `richmahn`
(Rich), `pjoakes` (Perry). Everyone else sees the state but cannot change it.

## What a lock does and does not stop

| Stopped | Not stopped |
| --- | --- |
| Scripture edits (ULT/UST), notes, questions, word links | Reading the book |
| The done / lane QA checkboxes | Review comment threads — a finished book can still be discussed |
| Starting a new AI pipeline run, resuming a paused one, and dispatching a run that was still queued when the lock landed | The nightly DCS→D1 reimport (Door43 → local only; keeps the local copy honest) |
| Book import and reimport from Door43 | An AI job's auto-apply while it is already in flight when the lock lands |
| The nightly Door43 export starting a NEW push, all five resources | A `-be-` PR that was already open before the lock landed — the lock stops new pushes, not Door43's own merge bot, which keeps landing already-open PRs on its own schedule |

Deliberate omission: **review comments stay open.** Freezing a book should stop
people changing it, not stop them talking about it.

Enforcement is server-side. Any blocked write returns **HTTP 423** with
`{"error":"book_locked", "book", "reason", "source"}` — but only once the request
reaches the route's own auth check. The lock-guard middleware itself runs before
route auth and defers to it for an unauthenticated caller, so an anonymous
write request still gets the normal 401, not a 423. This is a layering choice,
not secrecy: lock state is not confidential — `GET /api/books` has no auth
middleware at all and already returns `locked`/`lockReason`/`lockSource` for
every book to anyone who asks. The client also flips into read-only mode for a
locked book, but that is a courtesy — the API is the authority.

## Why 423 and not 409

The web outbox (`web/src/sync/outbox.ts`) classifies statuses. 423 is
non-retryable, so a rejected edit parks as `failed` and stays visible to the user
in the sync panel — no silent loss, no retry storm. 409 would be wrong: an
unrecognised 409 body drops the op into the conflict machinery with no `current`
version and shows the user a prompt they cannot resolve. 429 and 5xx would be
retried forever.

## How "published" is determined

`api/src/publishedGuard.ts` holds a **hardcoded list** of the published books and
the release tag they came from. It is not a live lookup.

That is a deliberate trade. A live lookup that fails cannot know *which* books
are published, so it must either halt every export — including the handful of
books that are the only ones under active work — or silently unblock all the
published ones. Neither is acceptable for a fact that changes about three times a
year.

Instead the nightly export runs a **drift detector** (`published-drift-check`)
that reads Door43's releases and raises an admin alert when they no longer match
the constant. **The detector never influences the gate.** A new release becomes a
reviewed human event, which is right: the night a new release lands, a dozen more
books go quiet, and a cron should not decide that by itself.

### Evidence behind the current constant (measured 2026-08-10)

- Latest release in `en_ult`, `en_ust`, `en_tn`, `en_tq`, `en_twl` is **v89**,
  target branch `release_v89`, published 2026-06-23.
- Listing each repo at `?ref=v89` returns **54 books, and the set is identical
  across all five repos**. `master` has 66.
- The 12 unpublished books: `NUM 1CH 2CH ECC ISA JER EZK DAN HOS AMO MIC ZEC`.
- Release cadence is roughly 3 per year (v84 2024-08 → v89 2026-06).

Two traps the code guards against, both found while measuring:

- `en_ult` has a **`v83.1` prerelease whose target is `master`**. If that class of
  release were ever picked as "latest", all 66 books would look published. So
  `pickLatestStableRelease` rejects drafts, prereleases, and anything targeting
  `master`, and sorts by date — never by tag name, because `"v9" > "v10"` as
  strings.
- `en_ult` at v89 contains **`A0-FRT.usfm`**. Parsing book codes out of filenames
  would invent a phantom book "FRT", so `publishedBooksFromEntries` instead asks
  the opposite question — is this *known* filename present? — which makes
  front-matter and dotfiles harmless.

A derived set smaller than `PUBLISHED_SET_MIN_BOOKS` (40) is treated as "could
not read the listing", not as "few books are published". A truncated response
must never be mistaken for evidence.

## Runbook: a new release ships (v90, …)

1. Confirm the new tag and its book set:
   ```bash
   curl -s "https://git.door43.org/api/v1/repos/unfoldingWord/en_ult/releases?draft=false&pre-release=false&limit=5"
   ```
   ```bash
   curl -s "https://git.door43.org/api/v1/repos/unfoldingWord/en_ult/contents?ref=v90"
   ```
2. Update `PUBLISHED_RELEASE_TAG` and `PUBLISHED_BOOKS` in
   `api/src/publishedGuard.ts`.
3. Run `npm --workspace api run test` — the suite asserts the list's size and the
   unpublished complement, so a partial edit fails loudly.
4. Decide about any `-be-` PRs already open on the newly published books. **The
   export being blocked does not stop Door43's merge bot** from landing a PR that
   is already open, so check and close them by hand if needed:
   ```bash
   curl -s "https://git.door43.org/api/v1/repos/unfoldingWord/en_tn/pulls?state=open&limit=50"
   ```
   (As of 2026-08-10 there were zero open PRs in all five repos.)

## Pushing a deliberate fix to a locked book

Three ways, all restricted to the three lock admins.

**Unlock, fix, re-lock, push now** — the normal path. Use the Book locks panel
in the app. Re-locking a book (going from unlocked to locked) offers a "Push
to Door43 now?" prompt, so a fix made during the unlocked window doesn't sit
in D1 until the next nightly export. Confirming calls
`POST /api/books/:book/lock/push`, which fires one Workflow instance per
resource (ult/ust/tn/tq/twl), each carrying `allowLocked: true` — see
`books.post("/:book/lock/push", ...)` in `api/src/bookImport.ts`.

The prompt asks which of two things you mean, and **defaults to the safer one**:

- **Stage for maintainer review** (default) — sends an optional `branchName` in
  the body, which the route validates and passes through
  `lockPushExportParams`. The push lands on `BibleEditor-restoration-{BOOK}`
  (per-book, deliberately: one shared branch would be force-reset by the next
  book's push and would reuse the first book's open PR, silently replacing its
  contents) and opens a PR. That name carries no `-be-`, so DCS's validate
  workflow never fires and its merge bot never merges — merging, and re-cutting
  a release if the book is in one, stay a maintainer's decision.
- **Publish now** — no `branchName`, so the push goes to the generated
  `{BOOK}-be-{contributors}` branch that DCS auto-merges to master. Right for a
  fix you own; wrong for a book that is in a cut release.

An unknown key in the body is a `400`, not a silent fallback: dropping a
misspelled `branchName` would publish unreviewed while the caller believed they
had asked for review.

The same choice is available in the admin panel's Run tab, via an "Override the
book lock" checkbox (enabled only for a single book + single resource, which is
all `lockOverrideAllowed` honors) plus a staging checkbox and branch field.

This route is gated on `canManageLocks` (the
`book_lock_admins` allowlist), not `requireAdmin`: Perry (`pjoakes`) is a lock
admin but only an `editor` in `user_roles`, so he can't reach
`POST /api/exports/run` (the admin panel's manual push) — the prompt has to
use the narrower gate to work for him too.

**One-off export override** — for pushing a fix without opening the app. The
default here is the same as in the app: **stage for review**, because a locked
book is usually one that is in a cut release.

```bash
curl -X POST .../api/exports/run \
  -H 'Content-Type: application/json' \
  -d '{"book":"PSA","resource":"tn","allowLocked":true,"branchName":"BibleEditor-restoration-PSA"}'
```

Keep `branchName` per-book (`BibleEditor-restoration-{BOOK}`). One shared name
across books does not work: the export force-resets the branch ref to master and
reuses whatever PR is already open on that head, so a second book's push
overwrites the first and leaves its PR showing the wrong diff.

To publish straight to master instead — auto-merged by DCS, no review — drop
`branchName`. Correct for a fix you own in a book you just re-locked; **wrong**
for a book that is in a release, where re-cutting it is the maintainer's call:

```bash
curl -X POST .../api/exports/run \
  -H 'Content-Type: application/json' \
  -d '{"book":"PSA","resource":"tn","allowLocked":true}'
```

Both bodies are validated `.strict()`, so a misspelled key (`branch_name`,
`branchNames`) is a `400` rather than a silent drop — dropping it would publish
unreviewed while you believed you had staged.

`allowLocked` and `branchName` are honored **only** when the run resolves to
exactly one book and one resource, so no cron path can ever carry them — the same
doctrine as `allowShrink` (see `api/src/shrinkGuard.ts` for why the check is on
the resolved counts and not the raw parameters). Using `allowLocked` writes an
audit alert. This route requires `requireAdmin` (a `user_roles` admin), a
stricter gate than the in-app prompt above.

**One stage at a time per book × resource.** Two overlapping staged pushes of the
same book and resource share one branch ref and one open PR, and the PR's title
and body are written only when it is created — so the second push wins the
content silently. Let one finish (or be merged) before starting another.

## Data model

`api/migrations/0043_book_locks.sql`

- `book_locks(book, locked, reason, set_at, set_by)` — an **override** table.
  A row with `locked=1` locks the book; a row with `locked=0` is a deliberate
  *unlock* of an otherwise-published book; **no row** means "fall back to the
  published list". This is not the same thing as `book_import_locks`, which is an
  import mutex.
- `book_lock_admins(dcs_username, added_at)` — who may change locks. Seeded with
  the three usernames. Add or remove people with SQL; no redeploy needed, the
  same convention as `user_roles`.

Resolution rule, in one line:

```
isLocked(book) = row exists ? row.locked === 1 : PUBLISHED_BOOKS.has(book)
```

## Where the code lives

| Concern | File |
| --- | --- |
| Published list, release picking, drift wording, override rule | `api/src/publishedGuard.ts` |
| Lock resolution, 423 body, admin check | `api/src/bookLock.ts` |
| Refusing writes | `api/src/bookLockGuard.ts`, mounted in `api/src/index.ts` |
| Lock/unlock endpoints and the book list | `api/src/bookImport.ts` |
| Export gate + drift detector | `api/src/exportWorkflow.ts` |
| Read-only mode | `web/src/sync/api.ts` (named read-only reasons), `web/src/components/Shell.tsx` |
| The panel | `web/src/components/BookLocksDialog.tsx` |

## Known gaps

- **Locking a book does not stop a `-be-` PR that is already open.** The gate
  stops the export from *opening a new* push; it has no power over a branch +
  PR a previous export already pushed. Door43's merge bot lands open PRs on
  its own schedule, independent of book_locks. So a lock landing after last
  night's export, but before that PR merges, does not prevent the merge. (As
  of 2026-08-10 there were zero open PRs in all five resource repos, so this
  is currently latent — see the release runbook above for the same caveat in
  the "new release ships" context.)
- If a lock lands while a translator already has the alignment panel open,
  in-progress drag-and-drop work can be lost silently: a drag has no
  failed-op row the way a text-edit op does, so there is nothing in the sync
  panel to show the user their change didn't land. The client-side fix
  (detecting the lock and disabling/warning the open aligner) is being
  addressed separately on the web side; this doc is noting the gap honestly
  rather than claiming it's covered.
- An edit **queued before** the client knows the book is locked parks in the
  failed-ops drawer showing the raw text `http 423` rather than a friendly
  message. Once the client *does* know (read-only mode has kicked in), the
  editing affordances are disabled, so this case should be unreachable in
  normal use — but if a write is attempted anyway while the client already
  knows about the lock, `outbox.enqueue*` returns a synthetic no-op and the
  write is dropped client-side. There is no failed-op row and no server round
  trip in that case — this is the one path where a rejected write does not
  park anywhere visible.
- AI pipeline coverage: `POST /api/pipelines/start` (new run), the
  `/:jobId/resume` route (restarting a paused run), and `dispatchNext`
  (dispatching a job that was still `queued` when the lock landed) are all
  refused for a locked book. A job's auto-apply while it is **already in
  flight** (`pollPipelineJob` → `importJobOutput`) is a deliberate exemption,
  not a gap — stopping mid-apply risks stranding a job or interacting badly
  with the delete-then-insert sequence inside `importJobOutput`. `dispatchNext`
  excludes a locked book's queued job from the claim SELECT itself (rather
  than claiming it and requeuing), specifically so this only stalls that
  job's own progress and never wedges the global single-slot queue for other
  books — a job that stays queued because its book never unlocks sits in the
  queue indefinitely, which is visible (its queue position never advances)
  and recoverable (unlocking dispatches it on the next tick), but every other
  book's queued job keeps dispatching normally in the meantime.
- `alignment_attention` and `export_reverts` rows for a locked book freeze at
  their last measured values. They are deliberately **not** cleared: an empty
  result would read as "measured and clean", which would be a false claim.
- The "Push to Door43 now?" prompt (`POST /api/books/:book/lock/push`) only
  confirms that each resource's Workflow instance was *created*, not that it
  finished or actually pushed — a resource can still no-op (`no_rows`,
  `unchanged`) or fail downstream (stale master, shrink guard, DCS error) the
  same way a nightly export can. The dialog shows "queued" per resource, not
  a final outcome; check the admin panel's sync-status / recent-runs view for
  the real result.
- Neither the "Push to Door43 now?" prompt nor the pre-existing admin-panel
  manual push (`POST /api/exports/run`) has any mutual-exclusion against a
  second concurrent trigger for the same (book, resource) — including the
  05:30 UTC nightly cron itself. Two `ExportWorkflow` instances racing the
  same DCS branch is a narrow, low-probability window (the cron fires once a
  day at a fixed time), and this is not a new risk the lock-push route
  introduces — the underlying `EXPORT_WORKFLOW.create()` mechanism has never
  had cross-run locking. Noted here rather than fixed because building real
  mutual exclusion (a KV/D1 lock keyed on book+resource) is a bigger change
  than this narrow window justifies on its own.
- `postExport.runPostExport` (dormant, `VALIDATORS = []`) has no per-book gate.
  Do not re-enable it without adding one.
- The published-release drift detector (`published-drift-check`) rejects any
  release whose `target_commitish` is `master`, even if it is otherwise a
  genuinely stable (non-draft, non-prerelease) release — see
  `masterTargetedStableRelease` in `api/src/publishedGuard.ts`. That function
  finds this case and `checkPublishedDrift` raises a separate
  `export_published_master_stable` alert when it does, but the case where it
  fires has never been observed against real DCS data, so the alert path
  itself is unverified in production.

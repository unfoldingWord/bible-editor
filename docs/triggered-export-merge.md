# Plan: Trigger-Driven Export → Validate → Merge → Delete

**Status:** Proposal · **Owners:** Benjamin (bible-editor / uW), Rich (DCS) · **Drafted:** 2026-06-09

## Why move

Today the nightly flow is **two independent cron jobs racing a clock**:

- bible-editor **export** fires at `05:30 UTC`. It re-imports master into D1, renders TN/TQ/TWL/ULT/UST per book, and pushes each *edited* book to a per-contributor branch `{BOOK}-be-{users}` with an open PR into `master`.
- Rich's DCS-side **validate-and-merge** fires at ~`06:00 UTC` and merges the mergeable `-be-` PRs.

Two problems:

1. **The 30-minute gap is too small and does not scale.** Measured 2026-06-09: the export's pre-render reimport phase alone took **~23 min** (NUM ≈ 16.5 min on its own), so the PRs don't finish landing until ~05:55–06:05 — at or *after* the 06:00 merge. The reimport grows linearly with the number of edited books; no fixed offset survives.
2. **No handoff signal and no cleanup contract.** Nothing tells the merge job "the push is finished," merged branches aren't reliably deleted, and D1 doesn't pull merged master back the same night.

**Target:** replace the clock race with an **event-driven handoff** — the export, when it finishes pushing, *triggers* the merge job; the merge job validates, merges, and **deletes the merged branch**; bible-editor then re-imports merged master for same-night db↔dcs parity.

## Assumptions / current behavior this builds on

- Export writes one branch + PR per (book, resource): `{BOOK}-be-{contributors}` → `master`, across en_tn / en_tq / en_twl / en_ult / en_ust.
- `resetExportBranchToMaster` (`api/src/export.ts`) re-bases each branch onto *current* master every run and preserves the open PR; if the branch is gone (404) it recreates it from master. **So deleting a branch after merge is safe — the next export recreates it only when that book has new edits.**
- bible-editor already has the dispatch machinery: `dispatchValidate()` in `api/src/postExport.ts` performs a Gitea `workflow_dispatch` (including the 204-no-body fallback door43's Gitea needs). It is wired but **disabled** (`VALIDATORS = []`).
- Recent incident (2026-06-06 → 06-09): two **dangling refs** in en_tn (`ECC-be-bcameron93`, `ISA-be-deferredreward`) — git ref present but `GET /branches/...` 404s — made the export abort every night. Cleared by hand; export now isolates per-book failures so one bad branch can't abort the run. Relevant here because **a botched / non-clean branch deletion is a known way to seed dangling refs on door43's Gitea.**

## Target sequence

```
05:30 UTC   bible-editor export workflow
            ├─ reimport master → D1 (pristine rows only)            [existing]
            ├─ render + push each edited {BOOK}-be-* branch + PR     [existing]
            └─ on completion → workflow_dispatch DCS merge job       [re-enable]
                                   │
DCS Actions │  validate_and_merge  (per repo)                        [Rich]
            ├─ enumerate open, mergeable {BOOK}-be-* PRs → master
            ├─ validate each (resource-specific checks)
            ├─ merge the mergeable ones   (payload casing fixed)
            └─ DELETE the merged head branch                         [NEW requirement]
                                   │
            bible-editor polls the run → on success:
            └─ reimport merged master → D1   (same-night parity)     [re-enable]
```

## Work — bible-editor side (uW / Benjamin)

1. **Drop the legacy `live-snapshot` path.** `postExport.ts:ensureSnapshotPr` still opens a `live-snapshot → master` PR; that's dead in the per-(book,resource) model — the export already opens the `-be-` PRs via `ensureDcsPr`. The orchestrator's only jobs become **dispatch → poll → reimport**.
2. **Populate `VALIDATORS`** (one entry per repo) as Rich's workflow lands in each. Start en_tn-only; add en_tq / en_twl / en_ult / en_ust incrementally. Keep the `params.validateAndMerge` gate so a manual single-book export never triggers a merge.
3. **Dispatch once per repo, after that repo's pushes.** Rich's workflow scans all open `-be-` PRs in its repo, so one dispatch per repo at the end of the resource loop suffices.
4. **Post-merge reimport for parity.** On a successful merge run, reimport merged master into D1 (pristine rows only). This supersedes the still-dormant `08:00` reimport cron and gives same-night parity. `runPostExport` already has this step.
5. **Alerting unchanged:** validation failure / timeout → `system_alerts` banner.

## Work — DCS side (Rich)

1. **One `validate_and_merge` workflow per repo**, triggerable by `workflow_dispatch`. en_tn exists; roll out to en_tq, en_twl, en_ult, en_ust. (Confirm the `.yaml` extension — a prior `.yamll` typo left it unregistered.)
2. **Workflow body:** enumerate open `{BOOK}-be-*` PRs into master → run resource validation → for each mergeable PR, **merge, then delete the head branch**.
3. **Fix the merge-payload casing** (the bug you found). Gitea's `POST /repos/{owner}/{repo}/pulls/{index}/merge` is case-inconsistent: `Do` is **PascalCase** (required — the merge style), while `delete_branch_after_merge`, `force_merge`, `merge_when_checks_succeed`, etc. are **lowercase snake_case**. Make sure the branch-delete option is correctly cased so the delete actually fires — and that the delete is a **clean ref delete** (a botched delete is how dangling refs appear).
4. **Resolve the validation backlog** (the ~37 en_tn errors) — or scope validation so the job merges what's valid and reports the rest, rather than blocking the whole run.
5. **Service-account permissions:** the `DCS_SERVICE_TOKEN` account can currently commit + open PRs but **cannot delete branches/refs** on the en_* repos (confirmed 06-09 — only a maintainer PAT could clear the dangling refs). If the merge job deletes using that account, grant it branch-delete; doing so also lets bible-editor's own dangling-ref self-heal clear corruption automatically.

## Branch lifecycle — the key contract

- The merge job **deletes** the merged `{BOOK}-be-*` head branch.
- The next export recreates that branch from master **only if the book has new edits** (no edits → `commitToDcs` no-ops → no PR). So the open-PR set always equals "books with unmerged edits," and stale branches never accumulate.
- Deletion must be a **clean ref delete**. If door43 ever leaves a dangling ref, the export now isolates it (won't abort the run), but that book won't export until the ref is cleared — so clean deletion matters operationally.

## Rollout

1. Land the bible-editor changes behind `VALIDATORS` (empty list = today's behavior, zero risk).
2. **Enable en_tn first** (Rich's workflow already merges there). Verify one full cycle: export → dispatch → merge → branch deleted → reimport → D1 == master.
3. Add en_tq, en_twl, en_ult, en_ust one at a time, watching `system_alerts` and the open-PR count per repo.
4. Once all five are trigger-driven, the 05:30-vs-06:00 timing is moot. Keep the 05:30 export cron purely as the *initiator*.

## Open questions

- **Dispatch granularity:** one dispatch per repo (fits the existing per-repo `VALIDATORS` shape) vs a single umbrella job. Recommend per-repo to start.
- **Poll vs fire-and-forget:** polling for merge completion gives same-night parity at the cost of a longer-lived export instance (Cloudflare Workflows handle this fine via `step.sleep`). Recommend poll.
- **Export cron time:** with a triggered merge it no longer needs to beat 06:00. Leave at 05:30 unless reimport runtime pushes us to start earlier for the instance's own sake.

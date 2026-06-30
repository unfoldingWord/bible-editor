# Export branch drift → unmergeable PR: design + fix

> **Status:** design + implementation. The recovery path ships **inert** until a
> branch-delete-capable token (`DCS_TOKEN`) is provisioned on the prod Worker —
> see *Required human follow-up* at the bottom. Until then behavior is unchanged
> (the conflicted PR drifts exactly as it does today, but now also raises a
> banner alert so it's visible).

## The failure mode (grounded in code)

The nightly `ExportWorkflow` renders D1 → TSV/USFM and commits the file to a
per-`(book, resource)` DCS branch named `{BOOK}-be-{contributors}`, then opens a
PR into `master`. The branch is **cut once** (from master HEAD the first night it
exists) and **never re-bases** as master moves. Walking the lifecycle:

1. `commitToDcs` (`api/src/export.ts`) writes the rendered file via the **Gitea
   contents API** (`PUT /contents/{path}`). That API only ever makes a
   **single-parent, single-file commit whose parent is the branch's current
   HEAD** — it advances the branch but cannot change the branch's merge-base with
   master.
2. `commitToDcs` calls `resetExportBranchToMaster` first, which *tries* to re-base
   the branch via `PATCH /git/refs/heads/{branch}` → `{target: masterSha}`. On
   door43's Gitea fork this **409s whenever the ref already exists** (the fork's
   `UpdateGitRef` carries `CreateGitRef`'s existence guard un-negated). The code
   already treats that 409 as "branch is present, proceed" — so for any branch
   that exists, the re-base is a **no-op**. The branch's merge-base stays frozen
   at the day it was cut.
3. When someone edits the same rows on **master** out-of-band (a newer AI/tC notes
   pass lands on Door43 after D1's import; another contributor's scripted master
   commit), the 3-way merge — `base` = frozen merge-base, `ours` = branch (D1
   render), `theirs` = current master — **conflicts**.
4. `updateDcsPrBranch` (`POST /pulls/{n}/update`, Gitea "update branch" = merge
   master into head) is the only thing that re-bases a long-lived branch in
   steady state. On a real content conflict it returns **409** and the workflow
   logs + moves on. The PR is now `mergeable: false` and sits until a human
   resolves it by hand.

Both existing repair mechanisms fail on this case for the *same root reason*:

| Mechanism | Where | Why it fails |
|---|---|---|
| `resetExportBranchToMaster` | `export.ts:480` | `PATCH /git/refs` 409s on existing refs (fork bug). Never re-bases. |
| `updateDcsPrBranch` | `export.ts:846`, called `exportWorkflow.ts:478` | Server-side merge; 409s on genuine conflict, by design can't resolve it. |

**Verification note.** The `PATCH /git/refs` existence-guard bug is documented in
the code comments at `export.ts:469–530` and `:838–845`, in `STATE.md`, and in
session memory (`project_export_branch_no_rebase_drift`, `project_export_service_token_no_delete`).
This design treats it as confirmed; one live re-confirmation against door43 is a
prerequisite before relying on the implementation (see follow-up).

## Key fact: D1 is authoritative

On a master↔branch conflict, **D1's rendered content wins** (confirmed by the
owner — the whole system is D1 → DCS once daily; master converges to D1, not the
reverse). Target end-state: the export branch is a **direct child of *current*
master whose only delta is the freshly rendered D1 file**, so the PR diff is
exactly the D1 delta and a 3-way conflict is impossible.

The human who fixed the ISA tn/tq case did exactly this: clone → `git merge
origin/master` onto the branch → resolve the conflicted file with `git checkout
--ours` (branch = D1's exact render) → commit the merge → push → merge PR. That
intentionally **drops rows present only on master** (D1-authoritative), which is
acceptable but should be **surfaced, not silent**.

## Candidate solutions

### (a) Recreate the branch off current master, on conflict — **RECOMMENDED**

When `updateDcsPrBranch` returns 409, the branch has drifted into conflict.
Rebuild it as a fresh child of master:

1. **Delete** the `{BOOK}-be-*` branch (auto-closes its open PR in Gitea).
2. **Recreate** it from master HEAD (`POST /branches`, `old_branch_name: master`).
3. **Re-commit** the already-rendered D1 file via `commitToDcs(..., {forceBranch})`
   → one commit, parent = master HEAD.
4. **Re-open** the PR (`ensureDcsPr` — the old one is closed, so it mints a fresh
   one). Diff = exactly the D1 delta, **no conflict possible**.

Uses only working endpoints: contents API for the commit, `DELETE`/`POST
/branches` for the rebuild. **Trigger is the genuine 409 conflict only** — steady
state (no OOB master edit) is untouched, no nightly churn.

- **Cost / tradeoff:** branch delete needs a token with branch-delete scope. The
  `DCS_SERVICE_TOKEN` the workflow runs as **403s on delete** (confirmed:
  `project_export_service_token_no_delete`). Requires the admin PAT (`DCS_TOKEN`,
  deferredreward) — the same credential the manual stopgap uses. This is a
  **human-provisioning decision** (add the secret, or add branch-delete scope to
  the service token).
- Deleting the head branch closes the PR → the rebuilt PR gets a **new number**
  (bot PRs; comment history loss is acceptable).
- Drops master-only rows (D1-authoritative) — logged + alerted, see below.

### (b) Server-side D1-authoritative merge commit via the git data API — **REJECTED (not implementable on door43)**

The task's candidate (b): on 409, build the `--ours` resolution server-side —
create blob from the D1 render → tree on top of master's tree → commit with two
parents `[masterHEAD, branchHEAD]` → **move the branch ref** to that commit.

The final step — *move the branch ref* — is `PATCH /git/refs/heads/{branch}`,
**the exact endpoint with the un-negated existence-guard bug that already kills
`resetExportBranchToMaster`.** It 409s on the existing branch ref, so the
constructed merge commit can never be installed as the branch HEAD. The contents
API (the only working branch-advance path) makes single-parent, single-file
commits only — it cannot express a two-parent merge. So (b)'s elegant
branch-identity-preserving merge is **blocked by the same fork bug it's meant to
work around.** Rejected as infeasible until/unless door43 fixes `PATCH
/git/refs` (at which point `resetExportBranchToMaster` would *also* start
working, and the whole drift problem largely evaporates on its own).

### (c) Recreate the branch off master *every* night (unconditional) — **REJECTED**

Same mechanics as (a) but applied unconditionally instead of on-conflict. Rejected
vs (a): it deletes + recreates + re-opens a PR for **every diverged book every
night**, churning PR numbers nightly, discarding the "PR accumulates the running
edits" continuity, and issuing a delete call per book that 403s without the admin
token anyway. (a) does the minimum — it only rebuilds the branches that actually
broke.

## Recommendation

**(a) recreate-on-conflict**, gated on a branch-delete-capable token. It is the
only candidate that (1) reaches the D1-authoritative end-state, (2) uses only
door43 endpoints that actually work, and (3) is surgical — inert in steady state,
fires only on the genuine 409 conflict.

Because (a) needs a token the Worker doesn't have yet, the code ships **gated on
`env.DCS_TOKEN`**: present → run the recovery; absent → no behavior change beyond
a new banner alert so the conflict is visible (it is silent today). This keeps the
change safe to merge before the token is provisioned.

## Interaction with the safety invariants (must not regress)

The recovery sits **strictly downstream** of the existing gates and must never
bypass them:

- **Freshness gate** (`checkMasterFreshness`, `exportWorkflow.ts:336`) and **shrink
  guards** (`checkTsvShrink` :361, `checkUsfmAlignmentShrink` :392) run inside
  `exportOne` **before** `commitToDcs`, returning early on failure. The PR-update
  step (and therefore the new recovery) only runs *after* the commit already
  landed — i.e. after the render was certified fresh and complete.
- The recovery **reuses the already-built `built.content`** — it does **not**
  re-query or re-render D1. So it cannot smuggle a different (stale/partial) render
  past the guards; it re-commits the exact artifact that already passed them.

### Resolving the "drop master-only rows" vs "shrink-guard rejects deletions" tension

These look contradictory but are complementary once you read what the shrink guard
actually compares:

- `exportTsvShrinkRefused(renderedRows, masterRows)` is a **catastrophe/ratio**
  guard: `MIN_LIVE = 20`, `RATIO = 0.5` — it refuses only when a ≥20-row book's
  render is **below 50% of master's row count**. Dropping a handful of OOB
  master-only rows (the conflict case — e.g. master 305, D1 render 298) leaves the
  render at ~95%+ of master → **guard passes**. Normal D1-authoritative drops are
  not blocked.
- A *pathological* drop (master gained hundreds of rows D1 lacks) **would** trip
  the guard — and that is correct: it means D1 is wildly behind master, exactly
  when "D1 authoritative" should **not** silently nuke master. The export then
  skips **at the shrink guard, before any commit**, the conflict recovery never
  runs, and Benjamin is alerted to re-sync.

So the guard decides *whether D1 is trustworthy enough to ship at all*; the
recovery only changes *how* an already-trustworthy render lands (clean child of
master vs a conflicted merge). The recovery never weakens the guard.

**Surfacing the drop (not silent):** the recovery raises an informational banner
alert (`export_rebuilt:{repo}`) naming the book/resource and the rebuilt PR, so
Benjamin can eyeball the resulting PR diff to confirm any master-only rows dropped
were meant to go. This fires only on the rare conflict path, so it isn't noisy.

## Required human follow-up (do NOT self-serve)

1. **Provision a branch-delete token on the prod Worker.** Either
   `wrangler secret put DCS_TOKEN --env production` with the deferredreward admin
   PAT, **or** grant branch-delete scope to `DCS_SERVICE_TOKEN`. The recovery is
   inert until one of these is done.
2. **Re-confirm the `PATCH /git/refs` existence-guard bug** still reproduces on
   door43 (a one-off curl). If door43 has since fixed it, prefer fixing
   `resetExportBranchToMaster` (re-base in place, preserves PR identity, no
   delete) over the delete+recreate path.
3. **Decide PR-number churn is acceptable.** The rebuild closes the conflicted PR
   and opens a fresh one. For bot-authored export PRs this is expected; flagged
   here in case any downstream tooling keys on a stable PR number.

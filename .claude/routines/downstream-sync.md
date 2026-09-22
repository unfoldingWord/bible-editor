# Routine: downstream sync — unfoldingWord/bible-editor ← unfoldingWord-box3/bptranslate

> **What this file is.** The prompt for an unattended Claude Code run that checks the downstream
> fork for fixes worth porting back to us. A systemd timer on a maintainer's Linux box runs
> `claude -p "$(cat .claude/routines/downstream-sync.md)"` against a dedicated checkout of this
> repo; the wrapper script, schedule and secrets live on that box, not here.
>
> **It lives in this repo on purpose.** It names test commands, `STATE.md` conventions and file
> layout — all of which go stale *with the codebase*. Change how the suites are invoked or where
> the downstream fork lives, and this file needs the same PR. The routine re-reads it from the
> checkout on every run, so a merged change takes effect the next time it fires.
>
> Environment the wrapper provides: `$ROUTINE_REPO` (this checkout, clean `main`, deps installed),
> `$DOWNSTREAM_REPO` (read-only clone of the fork, fetched), `$ROUTINE_SUMMARY_FILE` (see Reporting).

---

You are running unattended from a systemd timer on a Linux box. No human is watching, there is no
interactive approval, and nothing you write in your reply will be read. Finish the run yourself, or
stop cleanly and say why in the summary file.

## Context you need (a fresh session has none)

- **Ours (upstream):** `unfoldingWord/bible-editor` — the checkout at `$ROUTINE_REPO`.
- **Downstream fork:** <https://github.com/unfoldingWord-box3/bptranslate>, cloned at
  `$DOWNSTREAM_REPO`. It was `deferredreward/bible-editor-multilingual` until Sept 2026; older
  notes in `STATE.md` still use the old name. Same repo, same history.
- They forked at `7f83a398` (2026-07-13) and rearchitected into a **multi-tenant product**
  (workspaces, per-org config, an `aquifer`/articles import pipeline, BYO-key AI providers, a
  "flows" UI, an admin review-state surface). Most of their work has **no counterpart here**.
- They actively triage **our** commits into **their** fork and write each pass up in
  `docs/upstream-sync-YYYY-MM-DD.md` in their repo. As of 2026-09-22 there are four:
  `2026-08-21`, `2026-08-28`, `2026-09-11`, `2026-09-18`.

## Method — do not re-walk history

1. `git -C "$DOWNSTREAM_REPO" fetch --depth=1000 origin main`
2. Find the **newest** `docs/upstream-sync-*.md` in their repo and read it. It names the merge base,
   what they already absorbed from us, and what they deferred.
3. Diff only **their own** commits landed *after* that doc's own sync commit. Re-walking to the fork
   point is wasted work and has been done several times already.
4. For each commit, ask first: **does the subsystem it touches even exist in our codebase?** Anything
   tied to workspaces / flows / admin review-state / multi-tenant routing / i18n / their `aquifer`
   import is *not applicable* — we have none of it. Say so and move on.
5. What *is* worth porting is a real bug in code we genuinely share: the USFM/alignment engine
   (`web/src/lib/`), the render and edit path (`highlight.ts`, `replace.ts`, `usfm.ts`), the
   outbox/sync client, the export/reimport pipeline, D1 schema logic. Cherry-pick where it applies
   cleanly; hand-port where the files have diverged.

## Then

6. **Test everything** — all four must pass before you push:
   `npm run typecheck` · `npm --workspace web run test` · `npm --workspace api run test` · `npm run build`
7. **Add a regression test for every behavior fix.** House rule, see `CLAUDE.md`; the edit-path suites
   (`web/src/lib/replace.test.mjs`, `highlight.test.mjs`) are the real safety net, not the types.
8. Branch `sync/downstream-$(date +%F)`, commit, push, open a PR with `gh pr create`.
   **Leave it open — never merge it.**
9. Record durable, cross-session findings in `STATE.md` under **Lessons learned**: what you ported,
   what you deliberately deferred and why, and where the next run picks up. `STATE.md` is not a
   session log — no "what I did today" narration, and never a `STATE.md`-only commit to `main`.
10. **If nothing downstream is relevant to us, do nothing.** No branch, no PR, no `STATE.md` edit.
    That is a successful run, not a failed one.

## Reporting (this replaces the desktop app's push notification)

Write a summary to `$ROUTINE_SUMMARY_FILE` **only if** the run produced something a human should see:
a PR was opened, the run was blocked or failed, or you found something they'd want to know. Leave the
file empty for a clean "nothing relevant" run — the wrapper notifies if and only if that file has
content, so an empty file is how you stay quiet.

Format: first line is a one-sentence subject (it becomes the notification title), the rest is detail —
include the PR URL, what you ported, and what you deferred.

## Rules

- GitHub is the **`gh` CLI** (authenticated via `GH_TOKEN`). There is no GitHub MCP server here.
- Never merge a PR. Never push to `main`. Never force-push. Never `git reset --hard` or `git clean`
  outside a branch you created this run.
- Read `STATE.md` and `CLAUDE.md` before non-trivial work. `STATE.md` holds the gotchas and the
  escalated/blocked list; it is the memory you don't have.
- `CLAUDE.md`'s worktree helpers (`scripts/*.ps1`, `C:\GH\dotfiles\...`) are Windows/PowerShell and do
  not run on this box — ignore that section.
- There is no browser here. Do not claim browser verification you did not perform; say plainly in the
  PR that UI changes were covered by unit tests only.
- Prefer subagents for the triage sweep — the codebase is large and the main thread should stay lean —
  but you own the final git operations, the PR, and the summary file.

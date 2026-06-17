# Loop state · bible-editor

> The agent forgets; this file does not. Read it at the start of a session, update it
> before you finish. It holds **where the work is** — what just happened, what's mid-flight,
> what's blocked on a human, and the durable lessons that aren't in the code.
>
> Pair it with the standing spec: [`CLAUDE.md`](../CLAUDE.md) (how to work here) and
> [`docs/plan.md`](../docs/plan.md) / [`docs/handoff.md`](../docs/handoff.md) (where the project is going).
> **State tells you where you are; the spec tells you where to go.**
>
> Many worktrees edit this file in parallel. Keep the dated sections (**Completed**,
> **Lessons learned**) append-only and newest-first, so a merge conflict resolves by
> keeping both sides. The canonical copy lives on `main` — rebase before relying on it.

## Last run

2026-06-17 · Established this state file. Seeded from recent merged PRs + the memory index.

## In progress

- _(none currently tracked here — add the branch + a one-line status when you pick up work)_
- Follow-up watch: edge-punctuation whole-verse unalign fix (PR #214, merged) is **code branch-only**;
  prod ZEC 7:14 ULT was healed to v5 by data fix but the engine change is **not yet deployed**.

## Completed (recently merged → main, newest first)

- #214 — Fix whole-verse unalign when adding quotes at a verse's edges (`7acb5266`)
- #213 — Spacing between undo and save buttons + document PR merge-check workflow in CLAUDE.md
- #212 — Move save button to verse level; add column labels above columns in book view
- #211 — Detect typed/AI USFM markers so `\q2` isn't shown as alignable text
- #210 — Version indicator in topbar ("App update available" chip)
- #209 — strange-hopper: keep alignment intact across whole-verse text edits; don't lift `\qs` wrapper text

## Escalated / blocked on a human (not a code change Claude can land alone)

- **en_ust master `PSA 24:6` UST** — unclosed `\qs` Selah still malformed on master; D1 already healed (v2).
  Needs the `-be-` export branch merged to land the fix. (memory: selah-qs-malformation-psa246)
- **Prod `MIC 5:5`** — bracket/period-marker engine bugs fixed in code, but the already-stored verse
  still needs re-alignment / re-import. (memory: mic-bracket-and-period-marker-bugs)
- **AI TN doubling, master `ISA 10:29`** — remediate doubled notes via `scripts/dedup-tn.mjs`;
  D1 copy `ISA 29:30` also affected. Root fix shipped; existing rows still need the cleanup pass.
  (memory: tn-ai-duplication-roundtrip)
- **Dangling `-be-` export refs** — `DCS_SERVICE_TOKEN` can't delete branches; drifted branches must be
  cleared by hand with a maintainer PAT. (memory: export-service-token-no-delete, export-branch-no-rebase-drift)

## Lessons learned (write durable, cross-session facts here — not in chat)

For the full corpus, see the memory index at
`C:\Users\benja\.claude\projects\C--Users-benja-Documents-GitHub-bible-editor\memory\MEMORY.md`.
Highlights that bite repeatedly:

- **Fresh worktree:** run `scripts/worktree-init.ps1` to junction `node_modules` from main —
  never reflexively `npm install` on a branch (it leaks deps into main). Only `npm install` in MAIN.
- **Don't kill shared dev servers.** Multiple worktrees share Chrome MCP + dev ports (5173/5174/8787).
  Pick a free port or ask; never `taskkill` a port owner. `5173` is svchost-reserved on this box — relocate vite.
- **Migrations collide across parallel worktrees.** Check `wrangler d1 migrations list --remote` after any
  schema PR; a collided migration number left prod unmigrated → list-route 500s once already.
- **PR already merged?** Before pushing, run `gh pr view --json state,mergedAt`. If merged, rebase onto main,
  branch fresh, open a new PR — do not push to the merged branch. This happens regularly.
- **Hebrew compares must go through `nfc()`** (`web/src/lib/hebrew.ts`) — UHB stores combining marks in legacy
  order; milestones come out NFC. Skipping this silently breaks alignment matching.
- **`usfm-js` parks leading punctuation/markers on the node's `text`** — markers can carry text; opening
  quotes after a marker live on the marker node, not as a sibling.
- **Export USFM puts punctuation outside `\w` (`\w earth\w*.`) on purpose** — correct uW form, not churn; don't "fix" it.

## Stop conditions / goals

- No standing automated loop is wired to this file yet. When one is, record its goal here, e.g.:
  - `/goal "npm run typecheck && npm run build clean"` — met on `<commit>` at `<time>`.

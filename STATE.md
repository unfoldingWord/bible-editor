# Project state · bible-editor

> The agent forgets; this file does not. Read it at the start of a session.
> It holds what this project **is** — the gotchas, the durable lessons, and what's
> blocked on a human — none of which is derivable from the code.
>
> **This file is not a session log, and a session log must never be added back.**
> "What I just did" goes in the commit message and the PR description: those are
> per-branch, written once, and cannot collide. A shared status section is written
> by every parallel worktree at the same anchor line, so git gets N blocks claiming
> one position and conflicts every time. That is exactly what happened here — the
> old `## Last run` grew to 1,035 of 1,261 lines and 12 of the last 20 commits to
> this file landed on the identical hunk.
>
> - **Never commit a `STATE.md`-only change to main.** A code-free commit to a shared
>   file makes every open branch stale. A note *about* a PR belongs in that PR.
> - **In-flight status → `.claude/state/<worktree-name>.md`**, one file per worktree,
>   deleted when its PR merges. Separate files never collide.
> - A conflict that *does* happen here is now meaningful: two sessions learned
>   contradictory things, and that is worth stopping for.
>
> Pair it with the standing spec: [`CLAUDE.md`](CLAUDE.md) (how to work here) and
> [`docs/plan.md`](docs/plan.md) / [`docs/handoff.md`](docs/handoff.md) (where the project is going).

## Escalated / blocked on a human (not a code change Claude can land alone)

- **Prod `DEU 27:22` TN content-dup** — 2 live PRISTINE notes, same content (occ 1, quote `שֹׁכֵב֙ עִם`,
  note "See how you translated 'lies with'…") under ids `y3oq` + `oi0y` (both valid ids — a pure
  doubling, not a digit-first id). The new reimport Guard 2 PREVENTS new doubles but does NOT remediate
  this existing pair (it's insert-time only). Remediate by soft-deleting one copy (`scripts/dedup-tn.mjs`
  or the prod verse-repair pattern: version+1 + edit_log). Found 2026-06-18 via a corpus-wide live
  pristine content-key scan (only 1 such group corpus-wide). (memory: tn-ai-duplication-roundtrip)
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

- **A green typecheck can mean "checked nothing".** If `node_modules` is damaged, an
  unresolvable entry in tsconfig `types` (here `vite/client`) makes `tsc` emit one TS2688
  and silently skip the entire program — it reports success while checking zero files.
  Before trusting any "typecheck clean" claim on a checkout whose deps are questionable,
  **plant a deliberate canary error** (`export const canary: number = "nope";`) and confirm
  the checker reports it. Doing this on 2026-07-20 exposed a real bug that the broken check
  had hidden. Workaround when a `types` entry can't resolve: a temp tsconfig that
  `extends` the real one with `"types": []`, then ignore the resulting `import.meta.env`
  errors as artifacts. The same "prove the tool runs before trusting its silence" rule
  applies to any linter/test filter.

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

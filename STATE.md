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
- **`JER 36:11` ULT needs a manual re-align** — the word "the" is bare in D1 but aligned to `הַ⁠סֵּֽפֶר`
  ("the book") on master, so the alignment backstop has blocked JER ULT's export since 2026-07-31.
  Not a code bug: on 2026-07-30 a human cleared the verse in the aligner panel and rebuilt it word-by-word
  in ~100s (un-fusing master's 6-word compound card) and left the article off that card. Word sequence is
  identical both sides, so index 16 is unambiguous. Fix = drag "the" onto the `הַ⁠סֵּֽפֶר` card, then re-export.
- **Two rows carry a blank Occurrence that DCS hard-rejects** — each silently blocks its whole book+resource,
  because the Occurrence checks in `validate_{twl,tn}_files.py` pass no `severity` kwarg and so default to
  `"error"`, failing the run that `merge-be-pr.yaml` gates the `-be-` merge on. Fix both by setting
  **Occurrence = 1 in the editor** (preferred over prod SQL):
  - twl `DAN 3:5` id `xf8f` — OrigWords "fall down", Occurrence NULL. Its OrigWords is Gateway-Language
    rather than Hebrew, which is worth a look but is only a validator *warning* and does not block the merge.
  - tn `JER 37:5` id `bfyt` — quote "the Chaldeans, the ones laying siege", Occurrence NULL.
  A corpus scan on 2026-08-03 found no others: `xf8f` is the only twl row with a blank/zero Occurrence, and of
  nine tn rows with a quote and no Occurrence the other eight have Hebrew quotes that `origLangOccurrence`
  already renders as 1. The create/patch paths can no longer mint such rows (PR #403), but that fix is
  insert-time only and does not remediate these two.

## Lessons learned (write durable, cross-session facts here — not in chat)

For the full corpus, see the memory index at
`C:\Users\benja\.claude\projects\C--Users-benja-Documents-GitHub-bible-editor\memory\MEMORY.md`.
Highlights that bite repeatedly:

- **Our own USFM render does not round-trip, so "D1 differs from master" does NOT mean a
  human changed anything.** Measured 2026-08-11 by running the real
  `extractVersesForRange` → `buildUsfm` → `extractVersesForRange` over the checked-in ZEC
  samples: **37 of 225 ULT verses and 42 of 225 UST (16–19%)** come back with a different
  tree. Three causes, all ours: `normalizeUsfmFormatting` rewrites blank lines and
  re-parsing absorbs them into the verse's trailing text node (`".”\n"` → `".”\n\n"`, and
  the same on `nextChar`); `recomputeTargetOccurrences` renumbers word occurrences on the
  second pass for verses with nested `\zaln` (a word going `1/4` → `1/5`); and text-node
  tree shape shifts (a newline-only node appears before a trailing `\p`/`\q`; two adjacent
  text nodes merge, `", "` + `"‘"` → `", ‘"`). Round trips are **convergent, not
  oscillating** — a verse differs once and then stabilizes (verified over 5 passes).
  **Any feature that compares stored content against a render — or against master, which is
  a render we published — must normalize for this or it will act on phantom changes.** The
  verse merge nearly shipped rewriting ~17% of edited verses nightly and deleting their
  `text`-lane sign-offs on that basis. Its workaround is comparison-level only
  (`sortKeysDeep` / `collapseWhitespaceForCompare` / `dropOccurrenceForWordNodes` in
  `verseMerge.ts`) and is safe by construction: dropping a field from the compared form can
  only make two sides look MORE equal, so it can only ever reduce writes, never manufacture
  one — the bytes written stay verbatim. **That is a mask, not a fix**; the underlying
  instability is still there, is probably implicated in the recurring export churn, and
  those masks must not be removed until a round-trip-stability test passes.

- **A two-way compare cannot tell you who moved, and guessing is how the nightly sync
  lost data for months.** D1-vs-master alone is symmetric: a difference proves *something*
  changed, never *which side*. The old sync resolved that ambiguity by assuming D1 was the
  newer side (skip any verse with `updated_by` set), so every out-of-band correction made
  directly on Door43 master was skipped on the way in and then reverted on the way out by
  the export rendering stale D1 over it. The 2026-08-11 1CH incident is the measured case:
  192 verses reverted, 185 of them with `updated_by` set, 174 with their last app edit
  *older* than the master content they destroyed. **The fix is an ancestor, not a
  preference.** The content is recoverable for free from `edit_log` — every `kind='verse'`
  payload is a FULL snapshot (`verseHistory.ts`'s `normalizeContent` absorbs the two writer
  shapes) — but **the cutoff that bounds it is the part that is easy to get catastrophically
  wrong.** `export_snapshots.committed_at` is NOT it, and reaching for it is the trap: that
  is when we pushed to a `-be-` BRANCH, and merging is done by an external DCS Actions job
  with no `merged_at` recorded anywhere in this codebase. Unmerged `-be-` branches are
  routine (JER ULT blocked since 2026-07-31; dangling refs need a manual PAT). Use a branch
  push as "published" and a translator's edit that master never received looks like "we
  didn't move, master did" — so the merge reverts the translator to master's older text,
  silently, in the exact situation the fix targets (an out-of-band master edit is *what
  makes* the branch unmergeable). The only trustworthy signal is a **live, freshly-measured
  byte comparison against master**, which `commitToDcs` already performs: it GETs master and
  returns `branchTouched: false` only when our render is byte-identical to it. That stamps
  `book_resource_syncs.master_confirmed_at` (migration 0045), and *that* is the cutoff.
  Note `changed: false` alone is NOT sufficient — it also fires when our render matches the
  unmerged `-be-` branch, which proves nothing about master. Two further load-bearing
  properties: `edit_log` is swept at 180 days (`index.ts` ~329), and a book+resource never
  confirmed on master has no ancestor at all — so "no ancestor → keep D1" must stay a
  first-class outcome, never an error path and never read as "nothing changed".
  Note also that `computeEditedFieldMerge` (PR #422) is **not** a three-way merge despite
  being cited as one — it compares only D1 and master, and adopts on ancestor-free
  predicates (a field no human can own, or a whitespace-only difference).
  See `verseMerge.ts`, `verse_merge_conflicts` (migration 0044).

- **"Where is the user?" has no single source in this app — and both available sources
  are blind in a different direction.** `activeVerse` is Shell-LOCAL state
  (`useState(initialVerse)`), so clicking a verse does not necessarily rewrite the URL
  hash: measured live, the app sat on verse 4 while the hash still read `#/ZEC/1/2`.
  Meanwhile `App` renders `<Shell key={loc.book}>`, so a BOOK change destroys the whole
  subtree and any ref inside it still holds the old book when its teardown runs. So
  in-tree state is authoritative for verse/chapter and useless for book; the hash is
  authoritative for book and can lag on verse. Any feature that fires on "the user
  navigated away" must take each dimension from the source that can actually see it —
  reading verse from the hash reintroduces the bug it was meant to fix (PR #411).
  Related: a component memoized with a custom comparator (`areNotePropsEqual`) will
  swallow the render an effect needs unless the new prop is added to the comparator.

- **An absent measurement is not a clean measurement — and it must never overwrite
  evidence.** Third instance of this class (after the alert-wording fix and the reimport
  watermark certifying skipped chapters). `alignment_attention` is a replace-all snapshot,
  so any code path that writes it on a night nothing was compared DELETES real prior
  findings and leaves the indicator silently empty. Two doors had to be closed, not one:
  `master_unreadable` yields an EMPTY offender list, and `unparseable_render` /
  `empty_render` yield a NON-empty list holding only the synthetic `ref: "*"` sentinel —
  so a plain `length === 0` guard is insufficient. Rule for any future evidence table:
  the write path must prove it measured something per-verse before it is allowed to
  replace what is already stored, and "clean" must arrive by its own explicit path
  (here `detail === "ok"` → `clearAlignmentAttention`), never inferred from emptiness.

- **A guard that CAN detect something is not automatically entitled to block on it.**
  Benjamin's ruling (2026-08-04) on the alignment-shrink backstop: "an unaligned word or
  two here or there is no reason not to sync to Door43 ... don't hold somebody's work back
  cause he didn't drag 'and' to the right spot." Detection and embargo are now separate
  decisions (`classifyAlignmentLossSeverity` in `export.ts`): translator-scale loss ships
  with a `warning` banner, and only bug-shaped loss — a flattened verse, a gutted verse,
  systemic scale, a broken render, an unverifiable master — still withholds the book. When
  adding any future export gate, ask who is harmed by the block, not just whether the
  condition is detectable.

- **…but that policy has a measurable BOUNDARY: does DCS itself hard-reject the condition?**
  Applying it to the three remaining export gates (2026-08-04) found that none of them
  should be split, for one reason: shipping past them would not publish the book anyway.
  The test to run before relaxing any gate is "if we ship this, does it MERGE?"
  - `validate_usfm_files.py` (Checks 7/8, the USFM HOLD gate) has **no severity tier at
    all** — its `ValidationError` has no `severity` field, so every issue counts toward the
    exit code. That is the opposite of `validate_tn/tq/twl_files.py`, whose blank-field
    checks are `severity="warning"` (the reason that gate was rightly deleted). Same for
    the Occurrence checks behind `hardRejectGuard.ts`: no `severity` kwarg → default
    `"error"`. `merge-be-pr.yaml` merges only on `workflow_run.conclusion == 'success'`,
    so a hard error means the `-be-` PR goes red and never merges.
  - So for those gates, blocking withholds **nothing that shipping would have delivered**;
    it only adds a banner naming the row/line. Alignment loss was different precisely
    because DCS has *no* alignment check anywhere (verified: zero hits for `zaln`,
    `occurrence`, `\w` across all 8 checks), so shipping it really did publish the work.
  - The TSV shrink guard already had this split done right (`attributeTsvShrink`:
    `unexplained === 0` ships, plus the `allowShrink` override). Every remaining block is
    data loss, an unreadable master, or our own render disagreeing with itself. Leave it.
  - Validation is **per-book** (`--book` from the `-be-` branch name), so one bad book
    cannot block another's PR. The whole-repo behaviour noted elsewhere applies to the
    push-to-master workflow, which gates nothing.

- **A ported validator's FIDELITY is the gate's whole justification — diff it against the
  real source, don't eyeball it.** `usfmValidate.ts` had drifted from DCS in six places,
  five of which made it *under*-block (it accepted `\p “And he said\v 5`, `\b\v 5`, and had
  no `\ts\*`/`\b` own-line or `\b`-after-`\ts\*` rules at all): DCS's `_VERSE_PREFIX_RE` is
  `$`-anchored and has no `b` branch, where ours used a word boundary and allowed `b`. The
  sixth made it *over*-block: DCS's Check 8 skips the header (everything before the first
  blank line) and ours did not — and Check 7 lives in a different DCS function with **no**
  header skip, so the two checks must be gated differently in our single loop. Note the
  blank line after `\mt1` is load-bearing: without one, DCS's Check 8 never activates at
  all, so a test fixture lacking it passes vacuously. Measured impact of the fix: 0 issues
  across 34 real `en_ult`/`en_ust` master files, verified by injecting each violation into a
  real file to prove the rules actually fire.

- **DCS's blank-required-field checks are WARNINGS, not errors — measure the validator
  before gating on it.** All five (`validate_tn_files.py` "Note column cannot be blank",
  `validate_tq_files.py` Question/Response, `validate_twl_files.py` OrigWords/TWLink) are
  raised at `severity="warning"`. All three validators share an `ErrorCollector` whose
  `has_failures()` says "Only hard errors decide the exit code. Warnings are advisory …
  must not stop a book from merging", `emit_results` returns `1 if failed else 0`, and
  `merge-be-pr.yaml` merges on `workflow_run.conclusion == 'success'`. So a blank row
  PUBLISHES: en_tn master carried 19 blank-Note rows (2CH 5, ECC 8, JER 6) with green push
  validation. The `blank_field_guard` export HOLD gate was built on the opposite assumption,
  asserted in five comments and never measured, and it withheld all of JER/ECC/2CH from
  Door43 indefinitely. Removed 2026-08-03. **The validators are not in this repo — fetch
  them from `https://git.door43.org/unfoldingWord/en_<res>/raw/branch/master/.gitea/workflows/`
  and read the severity before building anything that assumes DCS will reject content.**
  Corollary: nothing downstream catches a blank field, so the in-app lint and the save-path
  guards (`rows.ts` 422 `blank_note`, `NoteCard.flushPending`) are the only protection.

- **`Occurrence` is the column DCS actually hard-rejects — and it must be judged on the
  RENDERED TSV, never on the D1 rows.** In the same validator files, the Occurrence checks carry
  no `severity` kwarg, so they default to `"error"`: twl rejects a blank Occurrence
  unconditionally, tn only when Quote is non-blank, tq not at all. `api/src/hardRejectGuard.ts`
  holds the export for these. It reads the rendered bytes because `origLangOccurrence`
  (`export.ts`) coerces null/0 → 1 whenever the Quote contains Hebrew/Greek: 10,708 prod tn rows
  look offending in D1 but only **one** renders offending. Gating on rows would hold nearly every
  tn book — the same over-broad mistake as the blank-field gate, in the other direction.
  Live offenders as of 2026-08-03: `tn JER 37:5` `bfyt` (English quote, Occurrence NULL — holds
  JER TN; fix is one field in the editor) and `twl DAN 3:5` `xf8f` (OrigWords "fall down",
  Occurrence NULL — DAN TWL has been silently failing DCS validation). Root cause is a create
  path: `Shell.tsx` "add word" posts no `occurrence` and `CreateTwl` has no default.

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

- **Chapter-front `\p` can pile up +1 per nightly export (EZK 8/11, 2026-07).** bp-assistant's out-of-band
  direct-to-master push is only the *trigger*; the per-night pump is the DCS-side merge of the never-rebased
  `-be-` export branch (frozen merge-base drift — same class as the `-be-` no-rebase issue). Every BE transform
  (`extractVersesForRange`/`buildUsfm`/`normalizeUsfmFormatting`/`applyVerseRows`) is idempotent on real bytes,
  so BE never *creates* the extra `\p` — but it also never *collapsed* it (`dropDoubledLeadingMarkers` excludes
  verse-0 by design), so it carried the growth forward. Fix: a front-run collapse of consecutive bare `\p` → one,
  in `normalizeUsfmFormatting` (export) **and** `extractVersesForRange`/verse-0 (import, so D1 self-heals). It only
  ever *removes* a duplicate `\p` — never invents one, never touches poetry or a chapter that opens without `\p`.
  Our export normalizer is a line-*formatter*, not a semantic validator: only DCS-side CI caught the stack — hence
  the separate task to adopt DCS's USFM validation into our write path.

- **A watermark must not certify data it didn't apply — and the check must sit where the laundering can't
  reach it.** The nightly reimport skips chapters held by a pipeline lock, then stamped
  `book_resource_syncs` for the whole `(book, resource)` anyway; the export's freshness gate trusts that
  stamp, so EZK 40 UST (stale in D1 since 2026-06-10) nearly reverted a whole new chapter bp-assistant had
  pushed to master. Three traps found while fixing it, each worth remembering as a *class*: (1) `skipped_locked`
  is **overloaded** — apply-phase chapter skips *and* prune-phase row skips — so gating on it is far too broad;
  gate on purpose-built counters. (2) The prune runs in a **later Workflow step** than the chunks, so it re-reads
  lock state — a job starting between them was invisible to a chunk-only gate. (3) A fail-safe that treats an
  absent field as "withhold" is defeated if an aggregation step upstream coerces absent → `0`: the check then sees
  a *present* zero. Put the taint in the aggregation, not just the predicate. Also: `checkMasterFreshness` returns
  `no_watermark` as **ok**, so "withhold the stamp" is a no-op for a book that never had a row — withholding must
  write something that cannot match a real SHA. (PRs #394/#395)
- **A guard's alert wording is not cosmetic — a wrong cause sends the operator at the wrong fix.** The alignment
  backstop reported EZK 40 as `lost alignment on "steps"` when D1 and master held entirely *different revisions*
  of the verse; those words were coincidental surface matches, and the alert told a human to re-align a word when
  the real fix was the sync. Same shape in the TSV shrink guard, which asserted "truncated fetch, not a real
  deletion" unconditionally and recommended a re-sync that would have **resurrected 62 deliberately deleted**
  1CH TQ questions. Rule: an alert may only state a cause the code actually measured; when it can't tell, say so
  and name the detail. Use `analyzeAlignmentDelta`'s `wordSequenceUnchanged` to separate genuine collateral
  de-alignment from a revision mismatch — **for wording only.** Never let it narrow the refusal *decision*:
  that exemption is exactly what let the 1CH 4:21 collateral loss ship (see the warning comment in
  `alignmentDelta.ts`).

## Stop conditions / goals

- No standing automated loop is wired to this file yet. When one is, record its goal here, e.g.:
  - `/goal "npm run typecheck && npm run build clean"` — met on `<commit>` at `<time>`.

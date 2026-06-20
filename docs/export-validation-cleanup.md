# Plan: DCS export validation — prevent · auto-fix/escalate · flag-for-user

**Status:** Proposal · **Drafted:** 2026-06-20 · branch `claude/epic-bassi-b25819`

> Goal (user's words): clean up data *before* export to DCS; auto-fix what's fixable
> or escalate to a human; and for things a person must decide (e.g. a `\q1` next to a
> `\p`), **flag it in the app** with a dropdown that jumps straight to the issue — like
> the unsaved-changes dialog.

## What's actually failing (evidence, 2026-06-20)

All 11 open `-be-` PRs are **`mergeable: true`** but carry exactly **one failing status
check** — the DCS Gitea-Actions workflow `validate-be` — and that one red check is the
*entire* reason nothing merges:

| repo | open `-be-` PRs | check | errors (sample PR) |
|---|---|---|---|
| en_tn | #7179 MIC, #7178 ISA, #7177 HOS | `Validate TN -be- Branch / validate-be` | 36 (MIC #7179) |
| en_ult | #6306 1CH, #6307 ISA, #6308 JER, #6309 MIC | `Validate USFM -be- Branch / validate-be` | 180 (1CH #6306) |
| en_ust | #4117 1CH, #4118 HOS, #4119 ISA, #4121 MIC | same | 184 (1CH #4117) |
| en_tq / en_twl | 0 | — | — |

### Two structural facts that shape everything

1. **Validation is whole-repo, not per-book.** `validate-be-branch.yaml` runs
   `python validate_*_files.py` with **no `--book`**, so it validates *every* file in the
   repo on the `-be-` branch. A `-be-` branch is master + one changed book, so the check
   inherits **all pre-existing master cruft in other books**. Proof: the **1CH** ult PR's
   180 errors break down as 60 in `13-1CH.usfm` and **120 in other books** (NUM 72, EZK
   15, ZEC 14, JER 8, DAN 6, ECC 4, MIC 1). The **MIC** tn PR's 36 errors are entirely in
   `tn_ISA/NUM/HOS.tsv` — **none in MIC**. So a perfectly clean book still fails the gate.
   *The validators already accept `--book` and `--check` — the workflow just doesn't pass them.*

2. **The merge job gates on that check.** `merge-be-prs.yaml` waits for the head commit's
   combined status and **skips any PR whose state isn't `success`** (lines 137–146). Git
   mergeability is irrelevant; the red `validate-be` check alone blocks every merge.

### Error distribution by rule

**USFM (en_ult / en_ust):** 100% are **Check 8 "USFM Formatting"**, all serialization-shaped:

| rule (Check 8 sub-rule) | count (1CH ult) | cause |
|---|---|---|
| `\p` must have a blank line before it | 74 | usfm-js emits no blank lines |
| `\p` must be on its own line | 23 | usfm-js glues `\p` to following content |
| `\b` must have a blank line before it | 23 | " |
| Content before `\v`: `\ts*` | 21 | `\ts\*` glued onto the `\v` line |
| `\b` appears after `\ts\*` (wrong order) | 12 | drift-marker order |
| `\ts\*` must be on its own line | 10 | " |
| `\ts\*` / `\c` blank-line-before | 8 | " |
| Content before `\v`: `\w …` / `\zaln-s …` | ~5 | a word/alignment run before a verse start |

**TN (en_tn):** mixed (MIC #7179, all in *other* books):

| check | count | cause |
|---|---|---|
| 11. Reference Order | 12 | range refs (`1:5-15`) sort after their single-verse start (`1:5`) |
| 10. Note Ending | 10 | note ends with literal `\n` |
| 12. Alternate translation Label | 6 | extra spaces / missing end-punctuation before the label |
| 13. Paired Square Bracket | 5 | unmatched `[` / `]` / mismatched `[[ ]]` |
| 15. Straight Quotes | 3 | straight `'` / `"` in a note |

### Root causes (three, not one)

- **(A) BE serialization.** `buildUsfm` (`api/src/export.ts:327`) calls
  `usfm.toUSFM(input, {forcedNewLines:true})` with **no line-layout normalization**. usfm-js
  does not emit the DCS blank-line convention, puts `\p`/`\ts\*`/`\b` on shared lines, and
  glues drift markers (`\ts\*`, `\b`) onto the `\v` line. Every Check-8 sub-rule above is this.
- **(B) Inherited master cruft.** Most errors live in books *other* than the PR's, already on
  master (largely BE's own past exports merged before this gate tightened). Source-prevention
  stops *new* cruft; it does not clean what's already there.
- **(C) TN content.** Trailing `\n`, range-sort order, label spacing, brackets, straight quotes
  — partly mechanical, partly genuine human-decision content.

### DCS already ships the auto-fixers

`en_ult/.gitea/workflows/fix_usfm_formatting.py` is the **canonical spec** for the blank-line
rules (blank before `\b`/`\ts\*`/`\p`/`\c`, none after, swap `\b`/`\ts\*`). `en_tn` has
`reorder_tsv_references.py`. They exist but are **not wired into validate or merge** — they're
manual. Porting `fix_usfm_formatting.py`'s logic into BE's export makes BE emit byte-compatible
formatting by construction.

---

## The categorization (the core deliverable)

Every check sorted into the user's three buckets. **Prevent** = build correct output at the
source so the failure never occurs. **Auto-fix** = mechanically repair before export, log it.
**Escalate** = `system_alerts` banner to the admin (infra / integrity). **Flag** = surface in
the app for a human to decide (the dropdown-jump UI).

### USFM (en_ult / en_ust)

| # | Check / sub-rule | Bucket | How |
|---|---|---|---|
| 8 | blank-line before/after `\b` `\ts\*` `\p` `\c` | **Prevent + Auto-fix** | port `fix_usfm_formatting.py` into `buildUsfm` post-pass |
| 8 | `\p` `\ts\*` `\b` `\c` on own line; one `\v`/line | **Prevent** | line-reflow in the same post-pass |
| 8 | `\b` after `\ts\*` (order) | **Auto-fix** | swap (the fixer does this) |
| 8 | content before `\v` = a **marker** (`\ts\*`/`\b`/`\q`) | **Prevent** | reflow marker onto its own line above the verse |
| 8 | content before `\v` = real `\w`/`\zaln-s` text | **Flag** | rare (~5); a word/alignment bleeding before a verse start — human decides |
| 3 | USFM header (8 exact lines) | **Prevent** | already passing (BE preserves master headers); guard `synthesizeHeaders` |
| 7 | consecutive `\p \p` | **Auto-fix** | collapse duplicate paragraph markers (none currently) |
| 4 | chapter order/count | **Escalate** | data integrity; shrink-guard already protects |
| 5 | verse order/coverage | **Flag** | missing verse may be a real gap (or a legit `\v 6-9` bridge) |
| 6 | footnote `\f`/`\f*` pairing | **Flag** | unbalanced footnote is a content error |
| 1,2 | manifest / files exist | **Escalate** | infra, not per-edit |

### TN / TQ / TWL (en_tn / en_tq / en_twl)

| # | Check | Bucket | How |
|---|---|---|---|
| 10 | note ends with literal `\n` | **Prevent + Auto-fix** | trim trailing `\n` in `tsvCell` + at AI ingest |
| 8 | literal `\n` in non-note column | **Prevent** | never emit; assert in builder |
| 5 | ID grammar `^[a-z][a-z0-9]{3}$` | **Prevent** | already via `coerceRowId` (`rowId.ts`) |
| 14 | duplicate ID | **Auto-fix** | re-mint on collision (guard already exists) |
| 9 | occurrence int/-1 | **Prevent** | already via `origLangOccurrence` |
| 3,4 | column count / header | **Prevent** | builder is fixed-shape (already correct) |
| 11 | reference order (range sort) | **Auto-fix** | sort rows by DCS's key in `buildTnTsv` (or repair `sort_order`) |
| 12 | alt-translation label: spacing / "Alternative" / case | **Auto-fix** | normalize at AI ingest + export |
| 12 | alt-translation label: prev sentence has no end-punct | **Flag** | content judgement |
| 6 | reference format | **Flag** | malformed ref = data error |
| 7 | supportReference rc:// validity | **Flag** | broken link = content |
| 13 | paired square brackets | **Flag** | can't safely auto-insert a missing bracket |
| 15 | straight quotes `'` `"` | **Flag** (auto-fix only unambiguous) | apostrophes/measurements are context-sensitive |

---

## Plan — four levers

### Lever 0 — Unblock now (DCS-side, coordinate with Rich)

The fastest path to green checks, independent of any BE change:

1. **Scope `validate-be-branch.yaml` to the PR's book.** Extract `BOOK` from the branch name
   (`{BOOK}-be-*`) and pass `--book $BOOK` (the validators already support it). A clean book
   then passes regardless of other books' master cruft — e.g. **MIC tn #7179 goes green
   immediately** (its 36 errors are all in ISA/NUM/HOS). Decouples books from each other.
2. **(Optional) Auto-fix in the merge job.** Before merging, run `fix_usfm_formatting.py` /
   `reorder_tsv_references.py` on the branch, commit, re-validate; only genuinely un-fixable
   errors block. Realizes "auto-fix what's fixable" on the DCS side too.

> These touch repos under `unfoldingWord` whose workflows are Rich's (per
> `docs/triggered-export-merge.md`). uW drives, Rich lands. ~5-line YAML change per repo.

### Lever 1 — Prevent at the source (BE-side, the heart of goal 1)

Make BE emit DCS-valid bytes so future exports never fail the mechanical checks:

1. **USFM formatting normalizer.** New pure module `api/src/usfmFormat.ts` — a line-based
   reflow ported from DCS's `fix_usfm_formatting.py` and **extended** to also (a) put
   `\p`/`\ts\*`/`\b`/`\c` on their own lines, (b) lift `\ts\*`/`\b`/`\q` off the `\v` line,
   (c) enforce one `\v` per line. Run it on `buildUsfm`'s output string before returning.
   Lowest blast radius (export-only, touches only inert markers → **zero alignment impact**;
   `\w`/`\zaln` are never moved).
2. **TSV normalizers** in `buildTnTsv`/`buildTqTsv`/`buildTwlTsv`: trim trailing literal `\n`
   from notes; sort rows by DCS's reference-order key (mirror `parse_reference_order_key`);
   normalize alt-translation-label spacing/case.
3. **Push the cheap ones upstream to AI ingest** (`pipelineImport.ts`, where
   `normalizeNoteWhitespace` already lives): trailing-`\n` trim + label normalization, so the
   data is clean in D1, not just at export.

### Lever 2 — Pre-export lint: auto-fix + escalate (BE-side, goal 2)

A single ported validator that BE runs **before** committing each book, so the export is a
gate, not a hope:

1. New `api/src/lint/` — TS ports of `validate_usfm_files.py` + `validate_tn_files.py`
   (same check numbers/messages, so BE and DCS agree). Run over the rendered bytes inside the
   export step.
2. **Auto-fix** the mechanical findings (Lever-1 transforms) in place, then re-lint.
3. **Escalate** anything left that's infra/integrity (chapter/verse/footnote/manifest) via
   `alerts.ts` → `system_alerts` (severity, message, `link_url` to the book) — the existing
   "Benjamin fix this" banner.
4. The same lint powers Lever 3 and a `scripts/lint-export.mjs` for ad-hoc/remediation runs.

### Lever 3 — Flag for the user (BE-side, goal 3)

The in-app, per-book "things to clean up" indicator the user described:

1. **`GET /api/books/:book/lint`** — renders the book from D1 (reuse `buildUsfm`/`buildTnTsv`)
   and runs the Lever-2 lint, returning structured issues `{ check, ref, file, message,
   severity, bucket }` filtered to the **flag** bucket (human-decision items).
2. **UI:** an issues badge on the book (timeline rail / topbar) with the unresolved count;
   click → a dropdown/dialog listing each issue by ref, with a **"go to"** that navigates
   `#/{book}/{ch}/{v}` (and activates the note for TN issues) — exactly the unsaved-changes
   dialog pattern. Auto-fixed items don't appear (silent); admin-escalated items go to the
   banner; only true decisions land here.
3. Optionally show it as a soft pre-export gate: "N issues need a decision before this book
   exports cleanly."

### Remediation — clean the existing master cruft (one-time)

Lever 1 stops new cruft but won't green the inherited errors (root cause B). Run the ported
fixers across all books and land cleanup PRs per repo (or let Lever-0 auto-fix-in-merge absorb
them). Sequence after Lever 1 ships so re-exports don't re-dirty. Respect the export
shrink/alignment guards and the `-be-` rebase/branch-lifecycle rules in `export.ts`.

## Verification / regression policy

- Every USFM/TSV normalizer transform gets unit cases (USFM → `usfmFormat.test.mjs`; the
  alignment-sensitive edit invariants stay in `web/src/lib/replace.test.mjs` per project policy).
- Prove **zero alignment impact**: the normalizer only moves inert markers; assert `\zaln`/`\w`
  counts unchanged across a corpus sweep (reuse the audit harness pattern).
- Round-trip: ported-fixer output must pass the *unmodified* DCS validators (run the real
  `.py` against rendered bytes in CI / a script) — that's the contract.

## Locked decisions (2026-06-20)

1. **Lever 0 — yes, coordinate with Rich.** Draft the per-book scoping change for Rich to land
   (see proposed diff below).
2. **Normalizer — export-only.** All formatting/normalization lives in `buildUsfm` /
   `buildTn*Tsv`; the live edit/save path (`replace.ts`) is untouched. Lowest blast radius.
3. **Auto-fix clear cases.** Convert unambiguous straight→curly quotes and collapse extra
   label spaces automatically; flag only the ambiguous ones (apostrophes, measurements,
   "prev sentence needs punctuation").
4. **Converge gradually.** No big one-time master sweep. Source-prevention + per-book scoping
   + nightly re-export clean each book as it's next exported.

## Proposed Lever-0 change (for Rich) — scope `validate-be-branch.yaml` to the PR's book

Same shape in `en_tn`, `en_tq`, `en_twl`, `en_ult`, `en_ust`; only the script name differs.
The branch is `{BOOK}-be-*`, so derive the book and pass it through (the validators already
support `--book`, case-insensitive):

```yaml
      - name: USFM File Validation Results <==== Click Here
        run: |
          BOOK="$(printf '%s' "${GITHUB_REF_NAME}" | sed 's/-be.*//' | tr '[:upper:]' '[:lower:]')"
          echo "Validating book: ${BOOK}"
          python .gitea/workflows/validate_usfm_files.py --book "${BOOK}"
```

Effect: checks 1–2 (manifest / files-exist) still run repo-wide on the full checkout (they
pass — all files are present), but the heavy content checks (incl. Check 8) run **only on the
PR's book**. A clean book greens immediately.

> **Nuance:** scoping alone greens books whose *own* render is clean (e.g. MIC tn #7179 — 0
> own errors). It does **not** green a book whose BE render is itself dirty (1CH ult has 60 of
> its own Check-8 errors) — that needs Lever 1.

## Sequenced roadmap

| Phase | Lever | Lands | Greens |
|---|---|---|---|
| 1 | **0** (Rich) | per-book scoping YAML × 5 repos | every book with a clean own-render (MIC tn, …) |
| 2 | **1** (BE) | `usfmFormat.ts` reflow in `buildUsfm` + TSV normalizers + ref-order sort | every book's own USFM/TSV render → DCS-valid |
| 3 | **2** (BE) | ported lint as pre-export gate + `system_alerts` escalation | integrity issues surfaced to admin, not shipped |
| 4 | **3** (BE) | `/api/books/:book/lint` + per-book issues badge & jump-to-issue UI | human-decision items flagged in-app |
| — | remediation | gradual via nightly re-export (no sweep) | converges as books are re-touched |

Phases 2–4 are independent of Rich and can proceed in parallel with Phase 1.

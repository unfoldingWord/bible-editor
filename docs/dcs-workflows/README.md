# DCS `-be-` validation: scope it to the PR's book (for Rich)

**What:** make `.gitea/workflows/validate-be-branch.yaml` validate **only the book the PR
touches**, instead of the whole repo.

**Why:** the workflow currently runs `validate_*_files.py` with **no `--book`**, so it validates
*every* file on the `-be-` branch. A `-be-` branch is `master + one changed book`, so the check
inherits **all pre-existing cruft in other books** and a clean book's PR fails for reasons that
have nothing to do with it. Measured 2026-06-20:

- `en_ult` PR **#6306 (1CH)** — 180 errors: 60 in `13-1CH.usfm`, **120 in NUM/EZK/ZEC/JER/DAN/…**.
- `en_tn` PR **#7179 (MIC)** — 36 errors, **all in `tn_ISA/NUM/HOS.tsv`, none in MIC**.

`merge-be-prs.yaml` gates merges on this check being `success`, so one inherited red error blocks
an otherwise-mergeable PR. Scoping to the PR's book decouples books from each other: **MIC tn
#7179 goes green immediately**, and every other book greens as soon as its own render is clean.

**The validators already support `--book`** (case-insensitive, matched to manifest project
identifiers) — the workflow just never passes it. No validator change is needed; only the
workflow's run step.

## The change (only the final run step differs)

Derive the book from the branch name (`{BOOK}-be-*`) and pass `--book`:

```yaml
      - name: <Resource> File Validation Results <==== Click Here
        run: |
          REF_NAME="${GITHUB_REF_NAME:-${GITHUB_REF##refs/heads/}}"
          BOOK="$(printf '%s' "${REF_NAME}" | sed 's/-be.*//' | tr '[:upper:]' '[:lower:]')"
          echo "Validating book '${BOOK}' from branch '${REF_NAME}'"
          if [ -n "${BOOK}" ]; then
            python .gitea/workflows/<validator>.py --book "${BOOK}"
          else
            python .gitea/workflows/<validator>.py
          fi
```

`<validator>` per repo: `en_tn`→`validate_tn_files`, `en_tq`→`validate_tq_files`,
`en_twl`→`validate_twl_files`, `en_ult`/`en_ust`→`validate_usfm_files`.

- Checks 1–2 (manifest / files-exist) still run repo-wide on the full checkout — they pass.
- The heavy content checks (incl. USFM Check 8 / the TN content checks) run **only on the PR's
  book**.
- Empty/unmatched `BOOK` falls back to whole-repo validation (today's behavior) — safe.

Ready-to-paste full files are in this folder, one per repo
(`en_tn.validate-be-branch.yaml`, etc.).

## Nuance — scoping isn't the whole story

Scoping greens a book whose **own render is clean**. A book whose render is itself dirty still
fails on its own errors:

- `1CH` ult has **60 of its own** Check-8 formatting errors (usfm-js serialization in the
  bible-editor export — no blank lines before `\b`/`\p`/`\ts\*`/`\c`, `\ts\*` glued onto the
  `\v` line, `\b`/`\ts\*` order). bible-editor is fixing this at the source (a normalizer ported
  from your `fix_usfm_formatting.py`) so future renders are valid by construction.

So: **scoping (this change) + bible-editor's export normalizer** together green the PRs.

## Optional follow-on (your call)

Wire the existing auto-fixers into the merge job: before merging a `-be-` PR, run
`fix_usfm_formatting.py` / `reorder_tsv_references.py` on the branch, commit, re-validate, then
merge — so mechanical formatting never blocks a merge at all.

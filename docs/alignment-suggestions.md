# Alignment Suggestions — reference & improvement plan

> Handoff for a fresh agent. Read `CLAUDE.md`, `docs/plan.md`, `docs/handoff.md`
> first, then this. The feature shipped in PR #98 (merged). A follow-up
> repeat-distribution fix is **uncommitted in this worktree** (see "Current
> state"). Goal of this doc: improve suggestion quality **without abandoning the
> architecture**.

## What this feature is

Non-AI word/phrase **alignment suggestions** in the AlignmentPanel. When a
verse's alignment is empty (e.g. ULT text was edited and alignment cleared),
faded dashed **ghost chips** appear in each empty Hebrew/Greek group; click to
accept (no reject — ignoring is free), with a bulk "accept N suggestions". It
replaces gatewayEdit's client-side wordMAP suggester, which was slow and trained
on whatever resources happened to be loaded.

## Architecture — KEEP THIS (it's the whole point)

- **No aligner engine at request time.** The API is a Cloudflare Worker (Hono +
  D1 + R2): no filesystem, ~128 MB, bundle limits. wordMAP-style runtime
  inference does not belong here.
- **The model is a precomputed D1 table** (`align_freq`), built **offline** from
  the **gold `\zaln-s` alignments in the published (canonical) ULT/UST**. It is
  "wordMAP alignment memory" reduced to per-token frequencies (single words +
  the contiguous phrase each milestone covers, e.g. `H776 → "the earth"`).
- **Refresh cadence = on publish.** Bump the tag in `api/data/canonical.json`,
  re-run the trainer, re-upload. Never trains on user/in-progress/non-canonical
  data.
- **Runtime = one indexed D1 lookup + scoring** in the Worker, with a **lexicon
  gloss/definition fallback** for Strong's the corpus never aligned.
- **Anti-goals:** don't move inference to the client; don't train per-keystroke;
  don't train on loaded/non-canonical resources; don't commit `scripts/out/*.sql`
  (gitignored, ~20 MB — it travels via the upload script, not git).

## Data flow

```
api/data/canonical.json (pinned ULT/UST @ tag/v88)
        │  scripts/train-aligner.mjs  (fetch USFM, walk gold \zaln-s)
        ▼
scripts/out/align-freq.sql   (gitignored; single-word + phrase rows)
        │  scripts/apply-align-freq.mjs  (chunked + retried d1 execute)
        ▼
D1 table  align_freq(bible, strong, surface, count)   [migration 0024]
        │  GET /api/align/suggest?bible=&strongs=   (api/src/align.ts)
        ▼
{ suggestions: { rawStrong: { words:[{surface,confidence,count,source}],
                              phrases:[{phrase,tokens,confidence,count}] } } }
        │  web/src/hooks/useAlignmentSuggestions.ts  (1 fetch/verse, cached)
        ▼
AlignmentPanel computeGhosts → ghost chips (click to accept)
```

## Key files

| File | Role |
|---|---|
| `api/migrations/0024_align_freq.sql` | `align_freq(bible, strong, surface, count)`, PK `(bible,strong,surface)` |
| `api/data/canonical.json` | pinned sources: ULT/UST @ `tag/v88` (edit ref to re-pin on release) |
| `scripts/train-aligner.mjs` | offline trainer; walks `\zaln-s`; emits single-word + multi-word phrase rows |
| `scripts/apply-align-freq.mjs` | chunked + retried upload to D1 (`--remote` for prod) |
| `api/src/align.ts` | `GET /api/align/suggest`; splits words/phrases; lexicon fallback (+NT Strong's-Plus→classic) |
| `api/src/index.ts` | mounts `app.route("/api/align", align)` |
| `web/src/hooks/useAlignmentSuggestions.ts` | fetch + module cache keyed by `bible::sortedStrongs` |
| `web/src/components/AlignmentPanel.tsx` | `computeGhosts`, `findContiguousUnaligned`, `GhostChip`, `ghostPipColor`, accept wiring |
| root `package.json` | scripts: `train:align`, `db:align:local`, `db:align:remote` |

## Current state

- **Merged (PR #98):** trainer, manifest, migration, endpoint, hook, ghost UI,
  bulk-accept, lexicon fallback, phrase-level memory.
- **UNCOMMITTED in this worktree** (`web/src/components/AlignmentPanel.tsx`): the
  **repeat-distribution fix** — `computeGhosts` now processes groups in source
  order and claims its best *still-unclaimed* phrase/word immediately, and
  `findContiguousUnaligned` takes a `claimed` set. This makes 2nd+ instances of a
  repeated word get their own ghost (e.g. both מִזֶּה, both כָּמוֹהָ on ZEC 5:3).
  **First task for the new agent: commit this** (typecheck passes) or re-derive
  it if lost. Then reload main's D1 isn't needed (client-only change; just deploy
  the SPA when shipping).
- **Local D1** (both this worktree and the `main` checkout) is loaded with the
  full v88 set: **592,945 rows** (372,735 single-word + 220,210 phrase).
- v88 release = **24 OT + 27 NT aligned books**. `ZEC` is **NOT** in v88 (404 at
  the tag) — so ZEC suggestions are pure generalization from the 24 OT books +
  lexicon, which is a good honest test. ZEC *is* in the seeded local D1 for
  rendering.

## How to build / run / verify

**Train + load (from repo root):**
```sh
npm run train:align -- --all-ot --nt   # full released Bible (default w/o args = curated set)
npm run db:align:local                 # chunked load into local dev D1
npm run db:align:remote                # production (needs Cloudflare creds)
```
Migration: `npm --workspace api run db:migrate:local` (or `:remote`).

**Production deploy (3 steps, user runs — needs creds):**
1. `npm --workspace api run db:migrate:remote`
2. `npm run deploy` (Worker carries new endpoint + `{words,phrases}` shape; SPA carries ghosts)
3. `npm run db:align:remote`

**Local dev + browser verify:** see `CLAUDE.md` "Browser-driven verification"
and the worktree setup (junction node_modules, copy `api/.dev.vars`, copy
`api/.wrangler/state`, stub `web/dist`). Run `npm run dev`; read the actual vite
port from output (5173 is often taken → probes to 5174+); wrangler is on 8787.
Endpoint smoke test bypasses vite: `curl "http://127.0.0.1:8787/api/align/suggest?bible=ult&strongs=H776"`.

**Canonical test verse: ZEC 5:3.** Open it → Alignment tab → Clear. Expect:
`הָאָרֶץ → "the earth"` (phrase, not "the"); repeated מִזֶּה/כָּמוֹהָ each ghost;
`נִקָּה → blank` (expected — see ceiling below).

## Hard-won gotchas (will bite a new agent)

- **Trainer key-separator gremlin.** `train-aligner.mjs` joins `(bible,strong,
  surface)` with `SEP = "\t"` and builds phrase surfaces with
  `String.fromCharCode(32)`. Do **not** "fix" these to literal spaces: a literal
  space inside a string literal written via the Write tool has landed on disk as
  a **NUL byte** before, and phrase surfaces contain spaces (so a space separator
  also collides). In TS, detect a phrase by `/\s/.test(surface)` and split with
  `/\s+/` — never type a lone `" "` as a separator/delimiter.
- **wrangler 4.x has no `d1 import`.** Remote `d1 execute --file` on a multi-MB
  file times out (`D1_RESET_DO`). That's why `apply-align-freq.mjs` chunks
  (~200 statements/chunk) and retries. Retries also clear local lock contention
  with a running `wrangler dev`.
- **Target another checkout's local D1 without `cd`:** `wrangler ... --cwd
  "<path>/api"`, or run the apply script rooted there.
- **NT Strong's-Plus:** Greek `align_freq` keys are Strong's-Plus (G23160 = θεός),
  but `lexicon_entries` is classic (G2316). `lexiconKeysFor()` in `align.ts` maps
  G##### → G#### for the fallback. Keep this.
- **Auth is cookie-based;** dev auto-mints in `import.meta.env.DEV`. A "session
  expired" banner on a fresh dev origin → reload usually re-mints; if not, clear
  cookies + reload.
- **Endpoint is ungated** (like `/api/lexicon`) — GET, no CSRF.
- **Pips:** green ≥0.60, amber ≥0.35, gray <0.35 (`ghostPipColor`).
- **Shared dev:** multiple worktrees may run; never kill another worktree's
  server. Override ports or ask.

## Gaps vs real wordMAP (read its source at `node_modules/wordmap`)

wordMAP scores source↔target n-grams (≤3×3) with **11 metrics** blended into a
weighted confidence, over **two indices**: gold AlignmentMemory **and** a
**CorpusIndex** (co-occurrence over *unaligned* verse pairs, incl. the open
book). Our model is gold-memory-only, ranked by frequency share. Gaps, ranked:

| # | Gap | ZEC 5:3 symptom | Closeable in-architecture? |
|---|---|---|---|
| **C** | No **uniqueness/IDF** — common words dominate | כָל² → "and"; function-word noise | **Yes (small)** |
| **B** | No **positional** scoring (we greedy by source order) | repeat disambiguation imperfect | **Yes (small–med)** |
| **D** | **Single-signal confidence** (freq share) vs 11-metric blend | shallow pips/ranking | **Yes (small)** |
| **A** | No **corpus co-occurrence** (can't predict gold-unattested pairs) | נִקָּה → blank ("cleared" never gold-aligned in v88) | **Partial** |
| **E** | Phrases are target-side under one source token; no statistical source-n-gram alignment / phrase-plausibility | won't predict novel groupings | Hard |
| **F/G** | Crude target stemmer; no char/ngram-length signals | minor | Yes (small) |

**Inherent trade-off (do NOT chase by breaking the architecture):** predicting a
*currently-edited* book's novel renderings (the rest of gap A) needs runtime
co-occurrence over that book's text — exactly the client-side cost we removed.
The `נִקָּה → "cleared"` miss is this: "cleared" is ZEC's rendering, ZEC isn't in
v88, so no canonical signal exists. Document it as expected; don't try to force
it with the corpus-only model.

## Prioritized improvement work

Do these in order; each is backend/precompute-only and keeps the architecture.

1. **Uniqueness / IDF weighting (gap C, D) — highest value, smallest.**
   - Precompute each surface's global frequency across all strongs (e.g. a
     `surface_df` count, or compute on the fly from `align_freq`). A surface that
     co-occurs with many different strongs ("the", "and", "of") is low-information.
   - In `align.ts`, rank candidates by `freqShare × idf(surface)` instead of raw
     `freqShare`. Expect the כָל²→"and" leak and "the/of" noise to drop out.
   - Verify on ZEC 5:3: כָל² should stop suggesting "and"; content words rise.

2. **Positional prior (gap B, D).**
   - Extend the trainer to also record, per `(strong, surface/phrase)`, the mean
     normalized in-verse position (0–1) of the alignment. Store alongside count.
   - The client already knows each source token's position (stream order). In
     `computeGhosts`, when two instances of a strong compete, prefer the candidate
     whose stored position is closest to the source token's position. This is the
     principled version of the current source-order greedy.

3. **Blend into a real confidence (gap D).** Combine freq-share, IDF, and
   positional fit into the `confidence` the endpoint returns; feed `ghostPipColor`.

4. **Precomputed corpus co-occurrence (gap A, partial).** New offline pass:
   source-lemma ↔ target-surface co-occurrence over **all** released verse pairs
   (not just gold-aligned), into a new D1 table (e.g. `align_cooc`). Endpoint adds
   a low-weight candidate source for strongs/words absent from gold memory. Catches
   "attested-in-corpus-but-not-gold-aligned" renderings. Will NOT catch unreleased
   books' novel renderings (see inherent trade-off).

5. **Minor (gap F/G):** swap the crude stemmer for a small proper stemmer; add a
   character-length sanity check (don't suggest a 2-letter word for a long lemma).

## Verification checklist for any change
- `npm run typecheck` clean (api + web).
- Re-train only if the trainer/schema changed; otherwise client/endpoint changes
  need no re-train.
- Browser: ZEC 5:3 — "the earth" still a phrase; repeats still distribute; no new
  function-word noise; `נִקָּה` still (expectedly) blank.
- A released book (e.g. RUT, JON) for in-corpus precision.
- Endpoint p50 stays a single indexed D1 lookup (don't add per-request scans that
  don't use the PK).

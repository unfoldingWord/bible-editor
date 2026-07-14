# Translation Preferences & Memory — Panel Design (Phase 2)

**Date:** 2026-07-13 · **Status:** Draft for review (Benjamin)
**Inputs:** [`docs/translation-preferences-research.md`](./translation-preferences-research.md) (industry survey, Phase 1), [`../../PIPELINE-SPEC.md`](../../PIPELINE-SPEC.md) (context store §3, feedback loop §4, QA checks §5), [`../../INTEGRATION.md`](../../INTEGRATION.md) (as-built `translate` contract; `contextRef` opt-in), [`../../FEASIBILITY.md`](../../FEASIBILITY.md) §2–3 (Aquilla eval; brain/face split), [`../../translation-mode-mockup.html`](../../translation-mode-mockup.html) (UX language).

**Evidence discipline** (same convention as the sibling design docs): **[VERIFIED]** = read in this workspace with a `file:line` citation; **[PROPOSED]** = design to be agreed; **[RESEARCH]** = grounded in the Phase 1 doc, section cited. Research-doc *design implications* are cited as **RD#n** (its §9 numbered list).

---

## 0. What this panel is, and what it is not

The panel is the **governance surface** for how a gateway-language (GL) team's lead translators steer the AI. It is the editable, expanded form of the ambient "🧠 Language memory: N examples · 0 terms" chip that already renders in the translation bar **[VERIFIED — `web/src/components/ResourceColumn.tsx:849`, the `terms` count is hard-coded `0`]**. It is *not* a per-note review surface (that is `NoteCard`/`QuestionCard`/`ArticleWorkspace`, already built) and it is *not* a prompt editor.

**Governing philosophy — "the brain is tuned with data, not prompts"** **[VERIFIED — FEASIBILITY.md:74]**: "Language-specific behavior comes from data (translated templates, GL terminology, GL scripture panes), not code. GL lead translators tune it by editing their templates, not prompts." This panel is where that data lives and is curated. We deliberately **do not** expose raw system-prompt editing (Aquilla does; we consciously skip it — PIPELINE-SPEC §6 "Skip consciously" row), because governed data beats freehand prompt-hacking for multi-team consistency.

**The two-mode reality this panel must make legible** **[VERIFIED — `api/src/translateOptions.ts:57-66`]**: a `translate` run is either
- **raw baseline** — no `contextRef` sent; the bot drafts from English + templates only; or
- **assisted** — the caller passes `translate.contextRef` pointing at a *populated* `{org}/translation-context` repo, and the bot folds in the team's brief, instructions, terminology, and validated examples.

Today every run is raw baseline because no context repo exists and auto-sending an empty one **fails the run** ("context pack has no content files"). **This panel's north star is: give a team enough curated data that flipping to assisted mode is safe and worth it.** The panel owns the D1 side of that data and the export that publishes it to the context repo.

---

## 1. Storage model — D1 is operational truth, git is the bot's read surface

Two stores, one direction of sync. This mirrors the decision already made for tW/tA articles (`article_units` in D1, exported to `{lang}_tw`/`{lang}_ta`) and for the whole save protocol (D1 is truth; DCS is a once-daily render).

| Layer | Holds | Who reads it | Who writes it |
|---|---|---|---|
| **D1 tables** (this project's database) | brief, instructions, terminology, QA-rule config, template pack, term candidates | the editor UI + the export job | the panel UI (admin/editor), the feedback loop |
| **`{org}/translation-context` git repo** [PROPOSED] | a *rendered snapshot* of the above + validated examples, in the layout the bot reads | the bp-assistant `translate` skill (via `contextRef`) | the editor's export job (nightly/manual), one commit/day |

**Why D1 is the source of truth (not the git repo directly):**
- The panel needs sub-second CRUD, search, CSV round-trip, and If-Match concurrency — all of which D1 + the existing route patterns give for free. Editing raw markdown/CSV in DCS's web UI (PIPELINE-SPEC §3's original proposal) is fine for a bootstrap but hostile to a non-technical lead translator (the stated target user).
- Validated examples **already** live in D1 as `tn_rows`/`tq_rows`/`article_units WHERE translation_state='validated'` **[VERIFIED — `api/src/rows.ts:944-979` `setTnTranslationState`; the exploration confirmed no separate examples store exists]**. Re-homing them to git would duplicate truth.
- The git repo's job is narrow: be the **stable, SHA-pinnable artifact the external bot reads**. `contextRef` pins an exact commit for reproducible runs **[VERIFIED — `translateOptions.ts:64` references `CONTEXT-REPO-CONTRACT.md`]**.

**Sync story (D1 → context repo)** [PROPOSED]:
1. A scheduled Worker job (rides the existing cron infra — two crons already registered) renders, per language, the D1 tables into the repo layout below, and appends newly-`validated` rows to `examples/validated.jsonl` (with tombstones for rows later un-validated).
2. One commit per language per day; commit history *is* the audit trail (RD#19 — TM maintenance needs prune/penalize from day one; git history gives revoke-by-revert for free).
3. The editor resolves the repo's HEAD at `translate`-start time and passes it as `translate.contextRef` **only when assisted mode is enabled** for the project. Raw baseline omits it (the current, safe default).

> **⚠ Open contract [PROPOSED, unverifiable here]:** `CONTEXT-REPO-CONTRACT.md` is *referenced* by `translateOptions.ts:64` and `INTEGRATION.md:52` but **does not exist in this workspace** (searched). The exact file layout the bot expects is therefore **not pinned down**. The layout in §7 below is the PIPELINE-SPEC §3 proposal, which the bot side must confirm before the export job is built. **Until that contract exists, we build the D1 side and the panel; the git export is designed but gated on the bot's reader spec.** This is the single biggest external dependency and is called out again in §10.

---

## 2. Panel information architecture

A single hash-routed workspace, `#/preferences` (or `#/settings/memory`), gated on `isTranslationProject(cfg)` **[VERIFIED — `web/src/hooks/useProjectConfig.ts:77-83`; `web/src/components/TopBar.tsx:210` shows the exact gate pattern for the Articles entry]**. It is a **full-page workspace, not a dialog** — same rationale as `ArticleWorkspace` (this content is not verse-scoped) **[VERIFIED — `docs/design/tw-ta-translation-modules.md:74`]**.

Left rail = section nav; main pane = the active section. Six sections, in the order a team would actually set them up:

```
Preferences & Memory  ·  <language name>              [ assisted mode ▾ ]
├── Brief              the who/why/register of this language's translation
├── Instructions       standing guidance injected into every AI draft
├── Terminology        preferred / forbidden→use-instead / do-not-translate  (+ tW links)
├── Examples           validated source→target pairs the AI learns from
├── QA rules           deterministic checks + severities
└── Templates          per-SupportReference translated note templates
```

The header carries a single **assisted-mode toggle** — the one control that decides whether `contextRef` is sent. It is disabled with an explanatory tooltip until the context repo exists and the export has run at least once (so we never flip a team into the failing "empty context pack" state).

---

## 3. Section (a) — Translation brief

**Purpose:** a first-class, discrete artifact (RD#9; ISO 17100 project specifications, research §3.1) capturing the who/why/how of this language's translation.

**Fields** [PROPOSED], each mapping to a researched convention:

| Field | Type | Grounding |
|---|---|---|
| `audience` | free text | ISO 17100 / LSP brief practice, research §3.1. GL Manual defines the *English* audience as ESL high-school level (research §7.4); the GL team declares *their* audience here. |
| `purpose` | free text | brief practice §3.1 (inform/instruct/comply). |
| `register` | **closed enum**: `formal` \| `informal` \| `default` | RD#8 — formality is the one register control standardized at the API level (DeepL `more`/`less`/`default`, Amazon Formal/Informal/Default, research §3.3). A closed enum, not free-text tone prose. |
| `script_direction_notes` | free text | script/orthography/RTL notes; complements `cfg.direction` which is already role-coded. |
| `notes` | markdown | catch-all. |

**Storage:** a **singleton row** `translation_prefs` (`id INTEGER PRIMARY KEY CHECK (id = 1)`), matching the `project_config` precedent **[VERIFIED — migration `0036_project_config.sql:7`, `id INTEGER PK CHECK(id=1)`]**. One project = one D1 = one brief; if multi-language-per-D1 ever happens, this migrates to a `lang`-keyed table, but that fights the existing one-D1-per-project tenancy model (STATE.md "role-coded bible_version + one-D1-per-project"), so singleton is correct now.

**Editing:** one admin-gated `PUT` with If-Match version CAS. Brief + Instructions + register + assisted-mode flag all live on this one row (they change rarely and together).

---

## 4. Section (b) — Instructions

**Purpose:** the standing "system rules" layer (research §6.4's layered instruction stack: stable rules vs. per-segment dynamic context) — free markdown injected into **every** AI draft prompt. This is Aquilla's "Instructions" **[VERIFIED — FEASIBILITY.md:56 notes Aquilla's editable system prompt; we expose *instructions as data*, not the prompt itself]**.

**Shape:** a single markdown field on the `translation_prefs` singleton (`instructions_md`). Rendered with the existing shared `MarkdownView` (preview toggle), edited as plain multiline — same treatment as article bodies **[VERIFIED — `docs/design/tw-ta-translation-modules.md:78`]**.

**Guardrail copy in the UI:** a short reminder that instructions ride *every* prompt, so they should be terse and durable (per-segment nuance belongs in examples/terminology, not here) — this operationalizes the research's layered-stack finding.

---

## 5. Section (c) — Terminology (the core build)

This is the richest section and the one that closes the `0 terms` seam **[VERIFIED — `ResourceColumn.tsx:849`]**.

### 5.1 Data model — concept-oriented, multi-rendering

**RD#3 / RD#17:** entries are **concept-oriented**, not flat word-pairs. One concept may have several valid target renderings (TBX structure, research §2.1; Paratext explicitly allows multiple renderings per biblical term, research §7.2). This matches how translationWords already works (research §7.1). So the grain is: **many term rows share a `concept_id`.**

**Status is a small closed picklist** (RD#1), reconciling the TBX-standard core (research §2.2: `preferred`/`admitted`/`deprecated`/`superseded`) with the CAT-tool-layer additions:

| Status value | Meaning | Source |
|---|---|---|
| `preferred` | the rendering to use | TBX `preferredTerm` (§2.2) |
| `admitted` | acceptable synonym, use less often | TBX `admittedTerm` (§2.2) |
| `deprecated` | don't use; change on edit | TBX `deprecatedTerm` (§2.2) |
| `forbidden` | never use — **carries a `replacement` pointer** | CAT-tool layer (memoQ/Trados), research §2.3; RD#2 |
| `do_not_translate` | leave the source term as-is | DNT convention, semantically distinct from forbidden (§2.3, RD#1) |

**RD#2 — forbidden entries need a paired "use instead" field.** A `forbidden` row carries `replacement_concept_id` (or a free `replacement` string) so a QA flag can say *"don't use X, use Y"* — the forbidden→preferred pair the task brief calls out.

**RD#18 — rendering-comment field.** A `comment` field records *why* a rendering was chosen for a sense (Paratext's parenthetical, ignored by matching, research §7.2). Cheap, already-validated UX.

**tW linkage (RD#17, §7.1):** each concept may carry a `tw_link` (`rc://*/tw/dict/bible/kt/god`) tying it to the language's translationWords article as the canonical key-term backbone. The panel surfaces "N key terms from translationWords not yet in your termbase" as a seeding affordance (read-only consumption of the tW catalog the editor already loads via `useCatalogs`).

### 5.2 Proposed table

```sql
CREATE TABLE terminology (
  id INTEGER PRIMARY KEY,
  concept_id TEXT NOT NULL,            -- groups renderings of one concept
  source_term TEXT NOT NULL,           -- the English/source lemma
  target_term TEXT,                    -- the GL rendering (NULL for a pure DNT/forbidden marker)
  status TEXT NOT NULL DEFAULT 'preferred',  -- preferred|admitted|deprecated|forbidden|do_not_translate
  replacement TEXT,                    -- for status='forbidden': what to use instead
  comment TEXT,                        -- rendering rationale (Paratext-style, ignored by matching)
  tw_link TEXT,                        -- rc:// link to the tW article (key-term backbone)
  source_status TEXT,                  -- provenance: 'manual' | 'imported' | 'candidate_approved'
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER REFERENCES users(id),
  deleted_at INTEGER
);
CREATE INDEX terminology_concept ON terminology (concept_id) WHERE deleted_at IS NULL;
CREATE INDEX terminology_status ON terminology (status) WHERE deleted_at IS NULL;
```

Style matches the newest migration precedent **[VERIFIED — `0039_article_units.sql`: plain `CREATE TABLE`, `<table>_<col>` index names, partial `WHERE ... IS NULL/NOT NULL` indexes, `unixepoch()` defaults, `version` CAS column, soft-delete `deleted_at`]**.

### 5.3 CSV import/export (RD#15)

**Export:** `GET /api/translation-memory/terms/export` → `text/csv`, UTF-8, header row, one term per row, columns `concept_id,source_term,target_term,status,replacement,comment,tw_link`. Cross-vendor convention (research §2.4): source term adjacent to target term, one language-code convention per file.

**Import:** `POST /api/translation-memory/terms/import` (multipart or raw CSV body). Parser is a **pure module** (`translationMemoryLib.ts`) so it is unit-testable without D1 (the mandatory split, §9). Upsert by `(concept_id, source_term, status)`; report counts (added/updated/skipped) like the existing importers. A dry-run flag returns the diff without writing.

**TBX:** research §2.2 confirms TBX is concept-oriented and our model maps to it, but §8 (gaps) found **no TBX sources in this ecosystem** and PIPELINE-SPEC §6 says "TBX import **skip**." So: **CSV/TSV in v1, TBX deferred** — our `concept_id` grouping keeps a future TBX export cheap if ever needed.

### 5.4 CRUD routes

Clone `articles.ts` verbatim as the template **[VERIFIED — `api/src/articles.ts:26-186`: `parseIfMatch`→428, zod `.safeParse`→400, `env.DB.batch([UPDATE ... AND version=?, edit_log INSERT WHERE changes()>0])`, 409 `{error:"version_mismatch", current}` / 404 disambiguation]**. `edit_log` writes use `kind='term'`, `row_key=concept_id` (or the row id), reusing the provenance convention.

---

## 6. Section (d) — Validated-examples memory

**Purpose:** browse/search/revoke the human-approved source→target pairs that become the AI's few-shot examples (RD#14; PIPELINE-SPEC §4; Aquilla's "Living Memory"/"Recent Examples"). This is the expanded form of the "N examples" chip.

**Data source — no new table.** Examples ARE `tn_rows`/`tq_rows`/`article_units WHERE translation_state='validated'` **[VERIFIED — validate flow `api/src/rows.ts:1131-1155` → `setTnTranslationState`; exploration confirmed no separate store and that `exportWorkflow.ts` does not yet read `translation_state`]**. The panel is a **read + revoke** view over existing data:

- **Browse/search:** `GET /api/translation-memory/examples?resource=tn&supportReference=&q=&limit=`. Selects validated rows, joins the English source (by `rowId` + `source_row_hash` for tn/tq; by `path` for articles) so each example shows source **and** target. Filter by SupportReference type (the primary few-shot selection key, PIPELINE-SPEC §2.2/§4.2) and free-text search.
- **Revoke:** un-validate → the existing `POST /api/rows/tn/:id/validate {value:0}` demotes to `edited` **[VERIFIED — `rows.ts:1146-1148`]**. The panel reuses `api.validateNote`; no new write path. A revoked example is dropped from the next context export (with a `jsonl` tombstone per PIPELINE-SPEC §4.2).
- **Provenance:** each example shows its state chip using the established colors (below).

**Few-shot feeding story (RD#14, PIPELINE-SPEC §2.2 item 4):** on a `translate` run, the bot's skill selects up to N (start: 15) validated examples from the context repo, **by SupportReference-type match first, then recency** — matching the "dynamic context engineering" pattern (research §6.2, ModernMT-style per-segment relevance §6.3). The editor's job is only to keep `examples/validated.jsonl` current via the export; selection is bot-side. **This panel makes that pool visible and curatable** — which is exactly the TM-maintenance discipline the research calls non-optional (RD#19).

> **Honest dependency:** examples only actually reach the AI when (1) the context repo + its contract exist, and (2) assisted mode is on. Until then this section is a *browsable, revocable record* of validated work — useful on its own (a team's memory of decisions) but not yet feeding drafts. The UI states this plainly rather than implying a live loop that isn't wired (the mockup's chip tooltip already frames it aspirationally — we don't over-claim).

---

## 7. Section (e) — QA rules

**Purpose:** deterministic checks with severities (research §4; PIPELINE-SPEC §5), including the tN-specific integrity checks that are the whole structural advantage over Aquilla.

**Severities — 2–3 tiers with ignore-with-reason** (RD#5, RD#6; Smartling medium/high, Crowdin error/warning, research §4.2):

| Severity | Behavior | Convention |
|---|---|---|
| `error` | blocks Validate (and, for structural checks, blocks apply) | Smartling High / Crowdin Error (§4.2) |
| `warning` | shown, overridable with a reason | Smartling Medium / Crowdin Warning (§4.2) |
| `info` | advisory | — |

**Built-in checks** (code-defined, from PIPELINE-SPEC §5; the table only stores enable/severity overrides + custom rules):

- **Structural / tN-specific (error, the Aquilla-corruption class):** Quote column untouched (NFC-normalized compare, *not* raw bytes — this is the exact class that broke the live bot run, INTEGRATION.md:54-57, so the check must go through `web/src/lib/hebrew.ts nfc()`); ID/Reference/Occurrence/SupportReference untouched; `rc://` links preserved; markdown structure parity.
- **Generic (from the CAT-tool common core, research §4.1, RD#7):** empty translation; identical-to-source; number integrity; end-punctuation (class-mapped for Arabic `؟`/`،`); whitespace/embedded-tab; repeated word; unpaired brackets/`**`/`*`; **terminology enforcement** (forbidden-term hit; preferred-term consistency) — the last one ties this section to §5.

**Custom rules (RD#5, deferred build):** a `qa_rules` table row can hold a regex + severity for team-defined checks (research §4.1 shows regex custom checks are standard in memoQ/Phrase/Smartling/Crowdin). Designed now, built post-pilot (PIPELINE-SPEC §6 "Defer").

**LQA typology alignment (RD#11, RD#12, RD#20):** when human corrections are classified (a later feature), use a small fixed dimension set (Accuracy/Fluency/Terminology/Style) + the *same* severity axis — do not invent a second taxonomy (Phrase built its LQA on DQF-MQM for exactly this reason, research §5.2). Out of scope for v1; noted so the QA-rule severity model doesn't get designed in a way that blocks it.

**Table (config only, checks live in code):**
```sql
CREATE TABLE qa_rules (
  id INTEGER PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE,       -- built-in key, or 'custom:<slug>'
  severity TEXT NOT NULL,              -- error | warning | info
  enabled INTEGER NOT NULL DEFAULT 1,
  pattern TEXT,                        -- custom regex (NULL for built-ins)
  description TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

---

## 8. Section (f) — Template packs

**Purpose:** per-SupportReference-slug translated note templates (FEASIBILITY §3; the mockup's TEMPLATE dropdown). **[VERIFIED — FEASIBILITY.md:79: templates are an independent, Google-spreadsheet-sourced set surfaced per SupportReference type, NOT derived from tA.]**

**Model:** table `note_templates (support_reference, target_template, status, comment, version, ...)`, keyed by SupportReference slug (`figs-metaphor`, `figs-idiom`, …). **Spreadsheet-importable** via the same CSV import machinery as terminology (the English source stays the Google sheet; each language's translation lives in D1 → exported to `templates/templates.tsv` in the context repo, PIPELINE-SPEC §3). The mockup already renders these with a "Google Sheet · {target}_templates" provenance subtitle **[VERIFIED — mockup `.tdrop` render, translation-mode-mockup.html template menu]**.

**v1 scope:** CRUD + CSV import + a coverage indicator ("18/42 SupportReference types translated"). The per-note dropdown that *consumes* these already exists in the review UI; this section is the management back-office for it.

---

## 9. API + code shape (the build contract for Phase 3)

**One new router**, `api/src/translationMemory.ts`, mounted once in `index.ts` **[VERIFIED — mount pattern `index.ts:141,177-192`: `app.route("/api/...", router)`]**:

```
GET    /api/translation-memory/prefs            (requireAuth)   brief + instructions + register + assisted flag
PUT    /api/translation-memory/prefs            (requireAdmin)  If-Match CAS on the singleton
GET    /api/translation-memory/terms            (requireEditor) list (excludes soft-deleted)
POST   /api/translation-memory/terms            (requireEditor) create
PATCH  /api/translation-memory/terms/:id        (requireEditor) If-Match CAS
DELETE /api/translation-memory/terms/:id        (requireEditor) soft-delete
GET    /api/translation-memory/terms/export     (requireEditor) text/csv
POST   /api/translation-memory/terms/import     (requireEditor) CSV upsert (+ ?dryRun)
GET    /api/translation-memory/examples         (requireEditor) validated rows + joined source
GET    /api/translation-memory/qa-rules         (requireEditor)
PUT    /api/translation-memory/qa-rules/:key    (requireAdmin)
GET    /api/translation-memory/templates        (requireEditor)
... (templates CRUD mirrors terms)
```

Gating per the established split **[VERIFIED — `auth.ts:234-252` `requireEditor`/`requireAdmin`; `projectConfigRoutes.ts:17,45` router-level `requireAuth` + per-route `requireAdmin` on writes]**. CSRF is automatic on writes **[VERIFIED — `auth.ts:207-221`; web client mirrors the cookie, `api.ts:421-430`]**.

**Pure logic split (mandatory for testability, RD-independent codebase fact)** **[VERIFIED — no D1 harness exists; `api/src/*.test.mjs` run pure functions only via `node --experimental-strip-types`; the `translateOptions.ts`/`pipelines.ts` split exists precisely for this]**: put CSV parse/serialize, term normalization, status-transition validation, and example-selection/formatting in `api/src/translationMemoryLib.ts` (no Hono/D1 imports); the router is a thin adapter. Tests: `translationMemoryLib.test.mjs`, appended to `api/package.json`'s test chain.

**Web wiring** **[VERIFIED — exact points from exploration]**:
- `App.tsx` `Location` union (`:19-21`) gains `{ view: "preferences"; section?: string }`; `parseHash` (`:36`) gains `/^#\/preferences(?:\/(\w+))?$/`; render switch (`:387-410`) gains the branch.
- `TopBar.tsx` gains a gated entry button beside Articles (`:210,505-516`), `isTranslationProject(cfg)`.
- New component tree `web/src/components/preferences/` (PreferencesWorkspace + one component per section), mirroring `ArticleWorkspace` conventions.
- `api.ts`: new methods on the `api` object with If-Match handled by the `request<T>` wrapper (`:407-536`); DTO interfaces alongside `ArticleUnit`.
- New hooks `useTerminology`, `useTranslationPrefs`, `useExamples` mirroring `useArticles` (`{items,loading,error,refetch}`, always-called, short-circuit when not a translation project).

---

## 10. Design language (must match the existing chrome)

**[VERIFIED — `web/src/theme.ts` + `ArticleWorkspace.tsx`/`NoteCard.tsx`]** and the unfoldingWord brand (org guidelines): Inspire `#31ADE3` (primary), Ocean `#014263`, Cultivate teal `#70C9CC`, Kindle `#E59D33`.

- **State-chip grammar (reuse exactly):** `ai_draft`→`warning.main` (Kindle orange, "review me"), `edited`→`info.main`, `validated`→`success.main` (teal). Compact chip: `size="small" variant="outlined" sx={{height:18,fontSize:10,fontWeight:600}}` **[VERIFIED — `ArticleWorkspace.tsx:76-88`]**.
- **Term-status chips** map onto the same palette: `preferred`→teal(success), `admitted`→info, `deprecated`→text.secondary outline, `forbidden`→`error.main`, `do_not_translate`→Ocean outline. (The mockup's violet `--draft` = AI identity; term status is not AI-state, so it uses the semantic palette, not violet.)
- **Card grammar:** bordered `Box`, `borderColor` keyed to state, `alpha(palette.<state>.main, 0.09)` fill for the "settled/approved" look **[VERIFIED — `ArticleWorkspace.tsx:513-514`]**.
- **RTL-ready (RD-independent, mandatory):** logical properties (`borderInlineStart`, `ms`/`me`), `dir={cfg.direction}` on target-language inputs, forced `dir="ltr"` on English source panes **[VERIFIED — `ArticleWorkspace.tsx:145,207,547` + `main.tsx:7,33` stylis-plugin-rtl]**. Terminology and examples are inherently bilingual: source column LTR, target column `dir`-aware.
- **i18n:** extend the existing `translation` namespace (already holds `languageMemory`/`examples`/`terms`) or add a `preferences` namespace; keys in **both** `en.json` and `ar.json` **[VERIFIED — `web/src/i18n/locales/en.json:60-88`]**.
- **Non-technical-lead usability:** every status/severity is a labeled chip with a tooltip; forbidden terms always show their "use instead"; import shows a dry-run diff before writing; destructive actions (revoke, delete) are soft and reversible.

---

## 11. Phasing (what Phase 3 builds vs. defers)

**Build now (end-to-end against local dev):**
1. Migration `0040_translation_memory.sql`: `translation_prefs` singleton, `terminology`, `qa_rules`, `note_templates`. (Examples need no table.)
2. `translationMemory.ts` router + `translationMemoryLib.ts` pure module + tests.
3. `PreferencesWorkspace` UI: **Brief + Instructions (prefs singleton), Terminology CRUD + CSV import/export, Examples browse/revoke.** These are the three the task names for end-to-end wiring.
4. Wire `ResourceColumn.tsx:849` `0 terms` → live count from `useTerminology`.

**Design-complete, build-deferred (documented, not coded in this pass):**
- QA-rules UI + custom-rule engine (built-in structural checks already run at apply per PIPELINE-SPEC §5; the *config UI* is the deferred piece).
- Template-pack UI (CRUD mirrors terms; deferred behind terminology).
- **The git export job** — gated on `CONTEXT-REPO-CONTRACT.md` existing (§1 ⚠). Term candidates / suggest-rules-from-edits (PIPELINE-SPEC §4.3, post-pilot).

**Honest gating note carried into Phase 3:** the *value* of this data reaching the AI depends on the external context-repo contract and assisted mode, neither of which exists yet. Phase 3 therefore delivers a **fully-usable curation surface** (a team can build its termbase, brief, and examples memory today) whose *export-to-AI* leg is designed and stubbed but not live — and the UI says so rather than implying a closed loop.

---

## 12. Open questions

1. **`CONTEXT-REPO-CONTRACT.md`** — the bot's actual context-repo reader layout. Blocks the export job (§1). Owner: bp-assistant maintainers + Benjamin.
2. **Register → AI:** does `uw-bt-bot` honor a formality signal, and via what field? Research §8 flags the whole steering mechanism as undocumented (RD#21). The `register` enum is stored regardless; whether it's sent depends on the contract.
3. **Terminology → AI enforcement:** research §6.1/RD#13 says glossary enforcement should be a constraint layer, not prompt text — but that's the bot's call. The panel produces the termbase; how the bot applies it is out of scope here.
4. **Multi-language-per-D1** — currently assumed no (singleton brief). Confirm before any language #2 shares a database.

---

## Honesty ledger

- **Verified by reading in this workspace:** `translateOptions.ts` (contextRef opt-in, full file), `ResourceColumn.tsx:840-852` (the `0 terms` seam), plus every `file:line` the two exploration agents cited for route/migration/web patterns (I relied on their citations for the ~40 code refs I did not re-open individually — they carried line numbers and `[VERIFIED]` tags; the two load-bearing seams I re-opened myself).
- **Grounded in Phase 1 research** (cited RD#n): all industry-convention claims trace to `docs/translation-preferences-research.md`, which is itself sourced and flags its own gaps (MQM 403, no incumbent Bible-translation TM standard, uw-bt-bot steering undocumented).
- **Not verified / assumed:** the context-repo layout (§7/§1 — the contract file doesn't exist); that the export job can commit to `{org}/translation-context` (needs the bot's token to have write access there — same ops ask as the tW/tA export); that `register`/terminology actually reach the bot in usable form (§12 Q2–Q3).
- **Biggest gap:** the D1→git→bot leg is a paper design until `CONTEXT-REPO-CONTRACT.md` is pinned down. Phase 3 builds the half that is fully under our control (D1 + panel) and is honest in the UI about the half that isn't. If the contract lands during Phase 3, the export job is the first follow-up.

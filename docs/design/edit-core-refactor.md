# Edit-core refactor: replace span-surgery with occurrence-keyed reassembly

> **Status:** IMPLEMENTED. Supersedes the design-only PR #230. This PR carries the design doc
> (updated with the resolved decisions below) AND the implementation.
> **Scope:** new `web/src/lib/alignmentReassembly.ts` + `web/src/lib/replace.ts`
> (`smartEditVerse` wiring) + `web/src/components/Shell.tsx` (admin-report block message).
> **Relationship to other work:** This is one of four follow-ups to the 2026-06-18 alignment-loss
> investigation. It is *complementary* to the hardened #227 guard (already on main) — the guard is a
> fail-closed gate that refuses to *persist* a bad delta; this refactor makes the edit engine
> *produce* a good delta by construction so the guard rarely has to fire, and shares the guard's
> NFC + (surface, occurrence) keying so the two never disagree.

> ## Resolved decisions (implemented)
>
> 1. **PORT, don't depend.** The gateway-edit `word-aligner-rcl@1.3.6` algorithm was studied from the
>    actual 1.3.6 source (`npm pack`'d to a scratch dir outside the repo, never added to
>    `package.json`) and its SHAPE — unmerge → word-diff(LCS) → renumber-occurrence → re-merge —
>    ported into `web/src/lib/alignmentReassembly.ts`. We did NOT port `wordaligner.merge`/`unmerge`
>    themselves: they rebuild milestones as flat `tag:"k"` nodes from a plain verse string and cannot
>    preserve our nested `tag:"zaln"` ancestry (the compound H1>H2 nesting Cases 1/27/37/50 require).
>    We keep the inline tree and re-wrap each survivor in its EXACT original milestone chain instead.
> 2. **Reassembly is the PRIMARY path inside `smartEditVerse`.** Public signature + `SmartReplaceResult`
>    shape unchanged; inline `\zaln` storage unchanged.
> 3. **Legacy tiers are the FALLBACK.** Reassembly returns `null` (→ existing
>    `relayoutUnchangedWords` / `smartRebuildRange` / `localizedRewriteVerse` tiers) whenever it can't
>    faithfully rebuild the verse. The tiers were NOT deleted.
> 4. **Fail-closed = BLOCK + admin-report, never flatten.** gateway-edit's whole-verse flatten
>    fallback (`alignmentHelpers.js:933-940`) was deliberately NOT ported. If the final result
>    (reassembly or fallback) would collaterally de-align untouched words, the existing #233 guard
>    (`analyzeAlignmentDelta` / `guardBlocksSave` in `Shell.tsx enqueueVerseSafely`) blocks the save
>    and shows an admin-report message. That message was updated by this PR.
> 5. **Shared keying.** `alignmentReassembly.ts` keys survivors by NFC `(surface, occurrence)` and the
>    `\zaln` source signature `strong|occurrence|occurrences|content` (NFC) — byte-identical to
>    `alignmentDelta.ts`'s `sourcePart`/`collectAlignmentWords`. Verified: a reassembled NUM 24:19 save
>    yields `analyzeAlignmentDelta.unexpectedLosses === 0` → the guard does not 409 it.

---

## 1. Problem statement

### 1.1 What the engine does today

Word alignment in bible-editor is stored **inline** in the per-verse usfm-js object tree as
`\zaln-s … \w word \w* \zaln-e\*` milestones. There is no second source of truth — the inline tree
*is* the alignment. Every inline text edit and find/replace flows through one entry point:

- `smartEditVerse(content, oldPlain, newPlain)` — `web/src/lib/replace.ts:1667`
- → `smartReplaceVerse(...)` — `web/src/lib/replace.ts:1026`
- → tiered tree surgery: `relayoutPunctuation` (`:471`), `relayoutUnchangedWords` (`:554`),
  `smartRebuildRange` (`:841`), and finally `localizedRewriteVerse` (`:1966`).

The engine computes a **character range** for the change and then mutates the milestone node tree by
that range — splitting partially-overlapped milestones into before/after halves, dropping
fully-overlapped top-level nodes, and re-tokenizing the changed slice (`tokenizePlainText` `:107`).
The module header (`replace.ts:1-21`) states the invariant plainly: *"an edit must never unalign
words it didn't touch."*

### 1.2 The failure mode

The range-surgery approach is correct only as long as the computed change range stays tight around
the genuinely-edited words. It does not, in one specific, recurring shape:

> **Edge punctuation + a word edit, in a verse of many short repeated words.**

When an edit touches a word *and* the verse's leading/trailing punctuation (or a quote/brace at the
verse edge), the single-change diff cannot find a clean common prefix *and* suffix. The change range
balloons to span most of the verse. `localizedRewriteVerse` then drops the `\zaln` milestones from
every word inside that ballooned range — including untouched neighbours. This is the catastrophic
**"from-edit-point flatten."**

The flatten has no structural backstop: because the inline tree is the only alignment store, once a
milestone is physically deleted there is nothing to reconstruct from, and (pre-#227) there was no
validate-before-save gate either.

### 1.3 The production evidence

From the 2026-06-18 corpus scan (`memory/project_export_align_damage_1ch_num.md`), the **confirmed
export-caused** regressions — verses that were fully aligned in the pre-export DCS baseline, then
flattened, sitting in otherwise fully-aligned chapters — were ~10 verses / ~202 words across two
files:

| Verse | Damage | Trigger edit |
|---|---|---|
| **1CH 4:21** | 29/33 words unaligned | name spelling: Lekah→Lecah (and siblings Zakkur→Zaccur, Markaboth→Marcaboth) |
| 1CH 4:30 | 6/9 | name spelling |
| 1CH 4:31 | 5/24 | name spelling |
| **NUM 24** (Balaam's oracle) | 24:7, 24:8 (36/36), 24:16 (33/33), 24:19, 24:20, 24:24 fully NO-ZALN | the larger cluster |

On the exact 1CH 4:21 Lekah→Lecah edit, the *old* `replace.ts` shipped **16→2** surviving
milestones — a near-total flatten of a verse where only one word's spelling changed
(`memory/reference_alignment_transient_state_tc_ge.md`).

### 1.4 Current mitigation, and why it is not enough

`smartRebuildRange` (`replace.ts:841`) was added precisely to attack this class: it does a word-LCS
over the change range and lets survivors keep their milestones, with a self-checked fallback. On the
*current* code, 1CH 4:21 preserves 32/33 (`memory/project_export_align_damage_1ch_num.md`), and the
broader edit-engine adversarial sweep is all-green over ~9,992–12,000 synthetic edits
(`memory/project_edit_engine_adversarial_findings.md`).

**But this is still range-based tree surgery.** Every fix to date has been a new tier or guard bolted
onto the surgery model, triggered by a specific production casualty (ZEC 7:14, MIC 5:5, 1CH 4:21).
There is **no structural guarantee** that the *next* unseen edit shape won't balloon a range. NUM 24
was never re-tested on the current code. The surgery model is, by the repo's own description
(`replace.ts`, `CLAUDE.md` "Edit engine"), *"brittle and the source of repeated prod alignment
loss."* We keep paying down the same debt one casualty at a time.

The goal of this proposal is to change the *shape* of the algorithm so that local edits degrade
**locally by construction** — the way gatewayEdit already does — rather than relying on an
ever-growing set of range-tightening heuristics.

---

## 2. Three models compared

The two adjacent reference implementations live in `C:/Users/benja/Documents/GitHub/tcc-ge-dcs`
(submodules of the unfoldingWord toolchain). All three keep the *same* user-facing promise (edit
target text freely, alignment follows); they differ in **what the alignment is and how an edit
touches it**.

| | **(A) translationCore desktop** | **(B) gatewayEdit web** | **(C) bible-editor (ours)** |
|---|---|---|---|
| **Where alignment lives** | SEPARATE per-chapter JSON: `{ "<verse>": { alignments:[{topWords,bottomWords}], wordBank:[] } }`, parallel to editable text (`.apps/translationCore/alignmentData/<id>/<chapter>.json`). Inline `\zaln` is DERIVED only at export. | INLINE USFM (`\zaln`/`\w`), same as us. `{alignments,wordBank}` is a transient pivot. | INLINE USFM (`\zaln`/`\w`). The inline tree IS the alignment; no pivot, no second store. |
| **What a text edit does** | Untouched words fall into `wordBank` (a bare `\w` is the *normal* unaligned state). The text file and the alignment file are edited independently. | `updateAlignmentsToTargetVerse(verseObjects, newText)`: **unmerge** USFM→`{alignments,wordBank}`, word-diff old/new tokens, renumber occurrences, **re-merge** survivors onto the new plain string by (surface text, occurrence). | **range tree surgery**: compute change char-range, split/drop milestone nodes overlapping it, re-tokenize the slice. |
| **Persist gate** | **Export GATE.** `wordaligner.merge(...)` throws `InvalidatedAlignments` if alignments+wordBank can't reconstruct the live verse 100% (`WordAlignmentHelpers.js:425-435`, `:474-491`). The export action catches it and prompts re-align OR resets that verse's alignments (`WordAlignmentActions.js:46-96`) — it **never writes a half-broken alignment**. | **None at save time.** The broken-link icon is display-only. *Plus a landmine:* a catch-all wipes the WHOLE verse if re-merge returns null/throws (`word-aligner-rcl helpers/alignmentHelpers.js:933-940`). | **None pre-#227.** #227 added `analyzeAlignmentDelta`, but its enforced predicate doesn't fire on the word-edit class (see §6). |
| **Empirical on 1CH 4:21** | n/a (different storage) — but a flatten is *structurally impossible* to persist: the gate would throw first. | **16→15** (only the edited word drops). | old: **16→2** (catastrophic). current: **32/33** via `smartRebuildRange` (heuristic, no guarantee). |
| **Pros** | Safest. Edits cannot shred milestones; a second structure always exists to recover from; persist gate is total. | Degrades locally *by construction*; no range-ballooning; reuses a battle-tested library; same inline storage as us (no D1/data-model change). | Already shipped; preserves alignment in-place when word counts line up; no library dependency. |
| **Cons** | Large rewrite: introduces a parallel alignment store, a derive-at-export step, and a verse-edit tracking layer. Would change our D1 model (`content_json` is currently the single per-verse object). Too big for a tactical 7-month project. | Inline model still has occurrence-collision edge cases; needs a fail-closed wrapper (its own fallback flattens — do NOT port that). Adds an npm dependency (or a port). | Brittle range surgery; no structural guarantee; every new edit shape risks a new flatten; debt paid one casualty at a time. |

Sources for the citations above:
- tC separate-structure + merge-gate: `tcc-ge-dcs/translationCore/src/js/helpers/WordAlignmentHelpers.js`
  (`getAlignmentPathsFromProject` `:69-90`; the `merge`→`InvalidatedAlignments` throw at `:424-435`
  and `:474-491`) and `tcc-ge-dcs/translationCore/src/js/actions/WordAlignmentActions.js`
  (`getUsfm3ExportFile` catch→prompt→reset-or-reject `:46-96`).
- gatewayEdit occurrence-keyed reassembly: `gateway-edit/package.json` pins `word-aligner-rcl@1.3.6`,
  `enhanced-word-aligner-rcl@1.4.4`, `word-aligner@^1.0.0`; the runtime UI imports
  `AlignmentHelpers` from `enhanced-word-aligner-rcl` (`gateway-edit/src/components/WordAlignerArea.jsx:71`).
  `updateAlignmentsToTargetVerse` and the catch-all flatten live in the library
  (`word-aligner-rcl helpers/alignmentHelpers.js:917-946`, flatten at `:933-940`) —
  cited from `memory/reference_alignment_transient_state_tc_ge.md`; the lib source is not checked out
  on disk (`gateway-edit/node_modules` is not installed in the submodule), so those line numbers are
  carried from the prior investigation and **must be re-confirmed against the pinned version before
  porting** (see §6).
- Ours: `web/src/lib/replace.ts` as cited in §1.

---

## 3. Recommended approach

**Adopt model (B): occurrence-keyed unmerge → word-diff → re-merge, *inside* `smartEditVerse`,
fail-closed.**

### 3.1 The change in one sentence

Keep the public API (`smartEditVerse` / `smartReplaceVerse` signatures and `SmartReplaceResult`
shape) and keep inline `\zaln` storage; add an *internal* occurrence-keyed reassembly engine that runs
FIRST and reassembles surviving alignments onto the new target string by (surface text, occurrence) —
and if reassembly cannot reconstruct the verse exactly, **fall through to the proven legacy tiers, then
let the save guard block any residual collateral loss — never flatten.**

> **As-built refinement (important).** A literal gateway-edit port re-derives milestones from flat
> `{topWords,bottomWords}` pivots and would LOSE our nested `\zaln` ancestry (Cases 1/27/37/50 require
> a survivor to keep BOTH `H1` and `H2`). So the implementation keeps the *algorithm shape* but
> preserves structure: `unmerge` records each target word with its FULL `\zaln` ancestor chain (cloned
> milestone shells), and reassembly re-wraps each survivor in that exact chain, coalescing adjacent
> same-chain survivors back into one milestone run. This is what lets the engine pass the historical
> contract unchanged while fixing the balloon class.
>
> **Scope gate (as-built).** Reassembly only fires when the edit is genuinely MULTI-REGION (2+
> disjoint word-change regions — the balloon class) AND the old verse stores each aligned word as a
> clean whole token (no split possessives). Single-region edits and split-unit edits defer to the
> tiers, which handle them with better-than-per-word fidelity (in-word leaf splitting keeps the split
> fragments aligned — Cases 25/26/27/40/50). The result: the tiers' hard-won behaviour is untouched,
> and reassembly adds the structural local-degradation guarantee exactly where the tiers ballooned.

### 3.2 Algorithm sketch

```
smartEditVerse(content, oldPlain, newPlain):           # signature UNCHANGED
  normalize oldPlain/newPlain (existing normalizeEditable + liftMarkerText, unchanged)
  if oldPlain == newPlain: return content unchanged     # existing fast-path

  # NEW INTERNAL ENGINE (was: tiered range surgery)
  { alignments, wordBank } = unmerge(content.verseObjects)     # USFM → pivot
  oldTokens = tokenize(oldStripped); newTokens = tokenize(newStripped)
  diff = wordDiff(oldTokens, newTokens)                        # LCS over word units
  renumber occurrences on survivors per newTokens
  rebuilt = merge(survivingAlignments, wordBank, newTargetString)   # pivot → USFM

  # FAIL-CLOSED GATE (replaces gatewayEdit's catch-all flatten):
  if rebuilt is null/throws OR rebuilt does not reconstruct newStripped 100%:
      return { content: <PRIOR content, untouched>,
               plainText: oldPlain,
               preservedAlignment: false,
               needsRealign: true }            # surface, do not persist a flatten
  reconcile markers (existing reconcileMarkers path, unchanged)
  return { content: rebuilt, plainText: newPlain, preservedAlignment: <survivors kept> }
```

The marker handling (`liftMarkerText`, `stripMarkerTokens`, `markerSignature`, `reconcileMarkers` —
`replace.ts:1687-1713`) wraps the new engine the same way it wraps the current tiers, because markers
are zero-width position anchors orthogonal to the word/alignment layer. That layering is one of the
hard-won correctness properties (`memory/project_mic_bracket_and_period_marker_bugs.md`) and is
preserved as-is.

### 3.3 Why this fails locally instead of globally

The current engine asks *"what character range changed, and which nodes overlap it?"* — a question
whose answer can balloon. The new engine asks *"for each surviving target word, does its (surface,
occurrence) still exist?"* — a question that is answered **per word**. A one-word spelling change can
only ever drop that one word's alignment; it cannot reach across the verse. That is the structural
property model (C) lacks and the reason 16→15 (B) beats 16→2 (old C) on 1CH 4:21.

### 3.4 Why NOT the full tC rewrite (model A)

Model A is the safest design, but adopting it means:

1. **A new D1 data model.** Today `verses.content_json` is a single usfm-js per-verse object that
   *is* the alignment (`CLAUDE.md` "Backend"). Model A requires a *parallel* per-chapter alignment
   store plus the editable text, derive-at-export, and a verse-edit-tracking layer
   (`checkData/verseEdits/`). That ripples through the save protocol, the outbox, the export
   workflow, and every reader (`useChapter`, `BookView`, `DocColumn`, the aligner panel).
2. **A 7-month tactical horizon.** This project is an explicit tactical replacement
   (`CLAUDE.md` "Context"). A storage-model rewrite is the kind of thing that eats the whole runway.

Model B gets ~90% of the safety (local degradation + a fail-closed gate) for ~10% of the blast
radius, because it leaves the storage model, the save protocol, and all readers untouched. The honest
trade-off: model B still has occurrence-collision edge cases that model A's separate `wordBank`
sidesteps, and it inherits the inline format's sensitivity to surface-form/occurrence keying
(see §6). We accept that in exchange for not rewriting the data layer.

---

## 4. Integration specifics

### 4.1 Depend on the npm library, or port the algorithm?

**Recommendation: port the algorithm, do not add a runtime dependency on `word-aligner-rcl` /
`enhanced-word-aligner-rcl`.** Reasons:

- **Bundler history.** This project already chose *not* to depend on `enhanced-word-aligner-rcl` for
  the aligner UI for a documented Vite/Rollup bundling reason (`CLAUDE.md` "Frontend"; we ship a
  custom HTML5 DnD aligner instead). Pulling the same family back in *just* for the edit-time
  unmerge/merge re-opens that problem.
- **Surface area.** We need exactly three primitives — `unmerge`, word-diff/renumber, `merge` — not
  the whole library (trainer, suggestions, React components). Porting ~3 functions is smaller and
  more auditable than vendoring a dependency tree.
- **The catch-all landmine.** We must *not* ship the library's whole-verse flatten fallback
  (`alignmentHelpers.js:933-940`). Porting lets us write the fail-closed branch ourselves;
  depending on the lib means wrapping/patching around a behaviour we don't want.

The port should be a new internal module (e.g. `web/src/lib/alignmentReassembly.ts`) that
`replace.ts` calls; `replace.ts`'s public functions and `SmartReplaceResult` stay put. Pin the exact
`word-aligner-rcl` version we port *from* in a header comment so future readers can diff against
upstream.

### 4.2 Hebrew NFC handling

`nfc()` (`web/src/lib/hebrew.ts:18`) is the single normalization entry point, and the repo's rule is
that *every Hebrew↔Hebrew compare goes through it* (`CLAUDE.md` "Frontend"; UHB stores
consonant-dagesh-vowel order, milestones from ZEC/LAM come out NFC). The reassembly engine's
matching key is **(surface text, occurrence)** — and the surface text is exactly a Hebrew↔Hebrew
compare. So:

- The word-diff and the re-merge keying **must** normalize surface forms through `nfc()` before
  comparison, or a Lekah-style edit on a Hebrew-source verse will mis-key survivors and drop them.
- This is also where `analyzeAlignmentDelta` already does its NFC keying
  (`memory/project_pr227_guard_wordsequence_gap.md`), so the two should share the same normalization
  helper to avoid drift.

### 4.3 Source-occurrence recompute

Imported UHB/UGNT `\w` have no `x-occurrence`; the server recomputes occurrence by position on read,
and `strong|occurrence` is **not** unique (it's per-exact-surface-text, cantillation-sensitive) —
236 collisions in ZEC UHB alone (`memory/project_source_words_no_occurrence.md`,
`memory/project_strong_occurrence_not_unique.md`). The reassembly engine keys *target* words by
(surface, occurrence), which is the safer axis, but the renumber step must use the **same
positional/surface occurrence model the server heals to**, or a re-merge will disagree with what gets
persisted. Acceptance must include a verse with repeated identical target surface forms (the two
`כָל` in ZEC 5:3 is the canonical trap).

### 4.4 The existing tiers and the test net

`replace.test.mjs` is a custom assert-based smoke runner, not a framework
(`node --experimental-strip-types --no-warnings src/lib/replace.test.mjs`, run via
`npm --workspace web run test`). It already encodes ~128 named cases / assertions accreted from every
historical prod casualty (`replace.test.mjs:1-9`). **This suite is the real safety net, not types**
(`CLAUDE.md` "Edit engine").

The hard requirement: **every existing `replace.test.mjs` case must pass unchanged after the swap.**
In particular the cases that *encode the casualties this refactor is meant to fix structurally* must
stay green:

- Edge-punctuation full-unalign family (ZEC 7:14 `'…'`, ZEC 8:3) —
  `memory/project_edge_punctuation_full_unalign.md`.
- MIC bracket / period-across-`\q` family (Cases 31–43) —
  `memory/project_mic_bracket_and_period_marker_bugs.md`.
- The 5-lens adversarial set (empty-`\zaln` prune, deletion mid-word, reorder transplant,
  `\qs`/Selah text-loss, marker-adjacent letter-migration, marker-spanning flatten,
  clause-final-punct-across-`\q`) — `memory/project_edit_engine_adversarial_findings.md`.

If the new engine cannot pass one of these *and* fail-close instead of flatten, that case becomes a
known-degradation we surface to the translator (preservedAlignment:false + needs-re-align), not a
silent regression. New cases to ADD: the 1CH 4:21 Lekah→Lecah edit asserting ≥32/33 survivors, and a
NUM 24 oracle edit (the cluster never re-tested on current code).

The existing internal tier functions (`relayoutPunctuation`, `relayoutUnchangedWords`,
`smartRebuildRange`, `localizedRewriteVerse`) can either be retired or kept as a *secondary* path the
new engine falls back to *before* failing closed — see §5 rollout for the staged decision.

---

## 5. As-built + verification results

The swap sits entirely behind the unchanged `smartEditVerse` API, so no call sites changed
(`Shell.tsx`, `ScriptureColumn.tsx`, `BookView.tsx`, `DocColumn.tsx`, `FindReplaceOverlay.tsx`,
`highlight.ts`, `usfm.ts` all call it the same way).

**What landed.**
- `web/src/lib/alignmentReassembly.ts` — the occurrence-keyed reassembly engine (unmerge → LCS
  word-diff → re-wrap survivors in their original `\zaln` chain), with the two scope gates (clean
  whole-word storage; 2+ change regions), the fail-open self-check, and NO whole-verse flatten.
- `web/src/lib/replace.ts` — `smartEditVerse` Step 1 now tries reassembly FIRST (after the pure-
  punctuation relayout, before the diff tiers); Step 2 reconcileMarkers re-places the markers
  reassembly strips. The legacy tiers are the fallback.
- `web/src/components/Shell.tsx` — `enqueueVerseSafely`'s block toast updated to the admin-report
  wording (decision #4).
- `web/src/lib/replace.test.mjs` — Case 64 flipped from the KNOWN-FAILURE 1/15 flatten to the FIXED
  13/15 (`preservedAlignment=true`, only `{one}`/`{the}` unalign).

**Verification (the acceptance bar — all met):**
1. `npm run typecheck` — clean across both workspaces.
2. `npm --workspace web run test` — all suites green. Every `replace.test.mjs` Case 1–63 passes
   UNCHANGED (no existing assertion weakened); Case 64 flipped to the fixed result.
3. **Integration sweep** — 1,887 real aligned verses (en_ult ZEC; en_ust ZEC/ISA/LAM/OBA from
   `docs/samples`) × 7 realistic edit categories (multi-region 2-word, multi-region 3-word, mid-word
   spelling, word insert, word delete, edge quotes, adjacent swap) = **13,180 edits**. New engine vs
   main's engine: **0 regressions** (never fewer aligned words), **1,974 improvements** (more aligned
   words — the balloon class the old engine flattened), **0 new guard-blocks**, **0 errors**. (Harness
   was run from a scratch copy outside the repo and removed; re-derive by parsing `docs/samples` and
   running both engines.)
4. **NUM 24:19** (the live bug): main 1/15 flatten → new **13/15**, `preservedAlignment=true`, only
   `{one}`/`{the}` unalign, text reconstructed byte-for-byte, `analyzeAlignmentDelta.unexpectedLosses
   === 0` (guard does not 409 it).
5. **1CH 4:21** Lekah→Lecah: **32/33** (single-region → handled by the tiers, unchanged from main).
6. **No whole-verse flatten path exists** — reassembly fails open to the tiers, and the #233 guard
   blocks any residual collateral loss with the admin-report message. Verified the guard fires
   `true` on a hand-built collateral-loss delta and `false` on a clean reassembly edit.

---

## 6. Risks & open questions

### 6.1 Risks

- **The catch-all flatten landmine.** gatewayEdit's library flattens the whole verse when re-merge
  returns null/throws (`alignmentHelpers.js:933-940`). If we port carelessly we re-import the exact
  failure we're trying to kill. **Mitigation:** the fail-closed branch (§3.2) is the single most
  important line of this design — keep prior content, surface needs-re-align, never flatten. This
  must have its own dedicated test.
- **Library version drift on the ported line numbers.** The `:917-946` / `:933-940` citations come
  from a prior investigation, not from on-disk source (the submodule's `node_modules` is not
  installed). **Mitigation:** before porting, `npm i word-aligner-rcl@1.3.6` in a scratch dir (the
  exact pin from `gateway-edit/package.json`), re-read `helpers/alignmentHelpers.js`, and confirm the
  algorithm + the flatten location against that version. Pin the version in the port's header.
- **Occurrence keying on repeated surface forms / cantillation.** `strong|occurrence` is not unique
  and target occurrence is positional (§4.3). A re-merge that disagrees with the server's heal
  produces silent double-highlights or drops. **Mitigation:** share the NFC + occurrence model with
  `analyzeAlignmentDelta`; ZEC 5:3 (`כָל`×2) is a required acceptance case.
- **Behaviour change in the long tail.** The tiers have accreted many micro-fixes (split
  possessives, `\qs`/Selah wrappers, marker-adjacent letter migration). The new engine must match
  them or fail-close. **Mitigation:** Phase-0 parity harness over the full corpus catches divergence
  before any wiring.

### 6.2 Composition with the hardened #227 guard (separate PR)

The #227 guard and this refactor are two layers of the same defense and must not be designed in
isolation:

- The **guard** (`analyzeAlignmentDelta`) is the *persist-time* fail-closed gate — it refuses to save
  a delta with unexpected losses. The #227 *gap* is that its enforced predicate is narrowed by
  `&& wordSequenceUnchanged`, so it does **not** fire on the word-edit class (1CH 4:21 makes
  `wordSequenceUnchanged=false`) — it only blocks the punctuation-only class
  (`memory/project_pr227_guard_wordsequence_gap.md`).
- This **refactor** is the *produce-time* fix — it makes the engine emit a good delta so the guard
  has nothing to catch.

If both land, the guard's tightened predicate (dropping `&& wordSequenceUnchanged`) becomes the
backstop for any residual reassembly bug, and the engine's own fail-closed branch is the first line.
**They should agree on the same NFC + occurrence keying** (share the helper) so a delta the engine
considers "clean" is also one the guard considers "clean," or saves will be rejected as 409s the
engine didn't expect.

### 6.3 Open questions — RESOLVED

1. **Port vs. depend** — RESOLVED: ported the ~handful of needed primitives into
   `alignmentReassembly.ts`; no `word-aligner-rcl` family dependency added (confirmed against the
   actual 1.3.6 source). §4.1.
2. **Tier retirement** — RESOLVED: legacy tiers KEPT as the documented fallback layer. They still own
   single-region and split-unit edits (where they outperform per-word reassembly), and they catch
   anything reassembly bails on. Not deleted.
3. **Fail-closed UX** — RESOLVED: the save is BLOCKED (prior content kept, draft discarded) via the
   existing #233 guard, and the translator sees an admin-report toast: *"This edit can't preserve word
   alignment on words you didn't change, so it wasn't saved (BOOK ch:v VERSION; affected: …). Please
   note this verse (BOOK ch:v) for your admin to file a bug-fix review, or make the text edit more
   narrowly / re-align in the alignment panel."* It blocks the text save (does NOT silently blank the
   alignment), matching the project's fail-closed posture. `Shell.tsx enqueueVerseSafely`.
4. **Ordering vs. #227** — RESOLVED: the #227 `&& wordSequenceUnchanged` narrowing was already dropped
   on main (the comment in `guardBlocksSave` documents commit `6980fd72`'s removal), so the guard
   already fires on the word-edit collateral-loss class. This refactor shares that guard's exact NFC +
   occurrence keying, so a delta the engine considers clean is one the guard considers clean (verified:
   reassembled NUM 24:19 → 0 unexpected losses).
5. **NUM 24 re-validation** — RESOLVED: a parity sweep over 1,887 real aligned verses × 7 edit
   categories = 13,180 synthetic edits compared the new engine against main's engine: **0 regressions,
   1,974 improvements, 0 new guard-blocks, 0 errors.** NUM 24:19 specifically: was 1/15 (flatten) on
   main, now 13/15 with `preservedAlignment=true` (only the two genuinely changed words unalign).
   1CH 4:21 Lekah→Lecah: 32/33, unchanged from main (single-region → tiers).

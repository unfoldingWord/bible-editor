# USFM alignment audit + fix plan

Audit of `web/src/lib/alignment.ts` against the USFM 3 spec, the live
unfoldingWord ULT/UST encoding, and how other USFM-aligned tools handle
inline character markers (`\qs Selah\qs*`, footnotes, `\d`, etc.) that
appear alongside `\zaln-s … \zaln-e\*` milestones.

The user-reported bug ("Selah ends up outside `\qs` markers") is one
symptom of a larger model gap: the parser only recognises three node
shapes (`\zaln-s`, `\w`, text) and silently sinks every other inline
node into `passthroughTail`, which the serializer appends at the end of
the verse. Selah, footnotes, mid-verse paragraph markers, and any other
character style are all affected.

This doc:
1. Pins the exact bugs with verbatim traces.
2. Anchors them to the USFM 3 spec and what other tools do.
3. Proposes a minimal change to the internal model that fixes them
   without changing on-disk USFM or breaking the existing alignment
   round-trip for non-Selah verses.

Status: spec — no code changes yet.

---

## 1. Confirmed bugs (reproduced)

All four bugs reproduced against `usfm-js@3.4.3` using a verbatim
re-implementation of `parseAlignment` / `serializeAlignment` /
`alignmentPlainText` / `withSourceCoverage`. The driving harness and
log are in /tmp/tester/trace.mjs and /tmp/tester/trace.log on the
running sandbox; the cases are summarised here.

### Bug 1 — Selah is invisible to the alignment dialog

USFM input (Psa 3:8 shape; matches production ULT — see §3):

```
\v 8 \q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*
```

`usfm-js` parses `\qs` as `{ tag: "qs", type: "quote", children: [zaln(Selah)] }`.
The alignment walker (web/src/lib/alignment.ts:136) only descends into
`type === "milestone" && tag === "zaln"` nodes; it skips `\qs` entirely.
Result:

- `state.stream` contains only the "Salvation belongs to Yahweh" word —
  Selah never enters the stream.
- `state.sourceGroups` contains only H3068 — no group for H5542
  (Selah's Hebrew source).
- The dialog's UnalignedBag is empty for Selah, and there is no
  alignment block for סֶלָה to drag onto. Editors literally cannot
  re-align Selah.

### Bug 2 — Selah/footnote/etc. is moved to the end of the verse on save

`parseAlignment` (alignment.ts:196–231) sinks any non-zaln/non-word
/non-text node into `prefix` (before the first content) or
`passthroughTail` (after). `serializeAlignment` (alignment.ts:401) emits
prefix first, then the stream, then passthroughTail — losing the
node's original position in the verse.

Mid-verse Selah:

```
\v 9 \zaln-s |...\*\w Praise|...\w*\zaln-e\* \qs Selah\qs* \zaln-s |...\*\w the LORD|...\w*\zaln-e\*
```

Round-trips through parse → serialize to:

```
\v 9 \zaln-s |...\*\w Praise|...\w*\zaln-e\*
\zaln-s |...\*\w the LORD|...\w*\zaln-e\*
\qs Selah\qs*
```

The mid-verse Selah is gone; it's been dumped at the end. Same defect
for `\f ... \f*` footnotes, mid-verse `\b`, secondary `\q1` /`\q2` lines
that follow the first aligned word, etc.

### Bug 3 — `plain_text` loses Selah/footnote text on save

`alignmentPlainText` (alignment.ts:474) iterates `state.stream` only;
anything in `passthroughTail` is excluded. For the Bug 1 verse:

```
alignmentPlainText(state) === "Salvation belongs to Yahweh."
```

— no "Selah". `AlignmentDialog.handleSave` (AlignmentDialog.tsx:255–262)
calls this and ships the result as `plain_text` in the PATCH body.
**Simply opening the dialog on a Psalm verse and pressing Save with no
edits desyncs `plain_text` from `content_json` and erases "Selah" from
search/AI prompts.**

This is asymmetric with the import-time extractor
(api/src/importParsers.ts:21), which walks every node's `text` and
`children` and so includes Selah. So the same DB row can have Selah in
`plain_text` after import and lose it after the first alignment save.

### Bug 4 — Timeline yellow-dot false positive on Psalm verses

`withSourceCoverage` (alignment.ts:321) walks the UHB to find which
source words are not covered by any zaln in the target. Because the
walker doesn't descend into `\qs`, H5542 (the UHB Selah) is reported as
uncovered, so a placeholder group with empty targets is synthesised.
`verseHasUnalignedWork` (alignment.ts:233) then returns `true`, and
TimelineRail marks the verse with the yellow "needs alignment" dot —
even though every UHB word IS aligned (just via `\qs`).

Reproduced: `verseHasUnalignedWork(targetVO, sourceVO) === true` for a
fully-aligned Psa 3:8 shape (trace at /tmp/tester/unaligned-check.mjs).

### Bug 5 — Psalm titles (`\d`) silently dropped on import

`extractVersesForRange` (api/src/importParsers.ts:53) filters verse
keys with `/^\d+(-\d+)?$/`. `usfm-js` puts `\d` Psalm titles in a
`front` pseudo-verse (verified — case-d-marker.mjs). So Psalm
superscriptions — which carry alignment data in the ULT — never enter
the `verses` table. The whole-book USFM round-trip via
`spikes/usfm-roundtrip.mjs` doesn't surface this because OBA has no
`\d`, but Psalms would.

### Bug 6 — `localizedRewriteVerse` drops unknown nodes on overlap

web/src/lib/replace.ts:457–460 — when a plain-text edit's range
overlaps a top-level node that isn't `text` or `milestone`, the node is
dropped:

```ts
} else {
  // Bare \w at top level overlapping the change — drop.
  emitChange();
}
```

A `\qs` or `\f` node hit by an overlapping edit is destroyed without
warning. Lower-impact than Bugs 1–3 (only fires when the edit's range
actually overlaps the marker's text), but still a silent data-loss
path that runs during inline ULT/UST editing.

### Bug 7 — Empty-string milestone attributes on round-trip (cosmetic)

`buildMilestone` (alignment.ts:360) always emits all six `x-…`
attributes even when source/lemma/morph are empty. For ULT verses
imported from production this is a no-op (every attribute is filled).
For synthetic placeholders or partial alignments, it pollutes the USFM
with `x-lemma="" x-morph=""`. Cosmetic, but it diff-noises the daily
DCS export.

---

## 2. USFM 3 spec posture and other tools

Findings from independent agent research (sources cited inline below).

### 2.1 Spec posture

- `\zaln-s ... \zaln-e\*` is **not in the official USFM 3 stylesheet**.
  It's a `\z…` user-namespace extension introduced by unfoldingWord /
  translationCore: https://github.com/ubsicap/usfm/blob/master/sty/usfm.sty
- Milestones exist precisely so that **non-hierarchical / overlapping
  markup** is representable: https://github.com/ubsicap/usfm/blob/master/docs/milestones/index.rst.
  The spec endorses milestones crossing character/paragraph boundaries
  without nesting cleanly.
- Character-in-character nesting uses `\+marker ... \+marker*`:
  https://github.com/ubsicap/usfm/blob/master/docs/characters/nesting.rst.
  That rule does **not** apply to milestones — the spec is silent on
  milestone-inside-character-style ordering. Both directions are
  permissible.

### 2.2 Other tools

- **usfm-js 3.4.3** — single phrase stack, strict LIFO. Both `qs` and
  `zaln` build `children` arrays. Cross-nesting where `\qs` opens,
  `\zaln-s` opens, `\qs*` closes before `\zaln-e\*` cannot be
  represented in the verseObjects tree. Open issues #98 (nested
  character markers fail) and #103 (footnote `nextChar` issues) are
  related but no bug specifically targets qs↔zaln interleaving.
- **word-aligner-rcl / enhanced-word-aligner-rcl** — same gap as ours.
  No code path recognises `\qs`, Selah, `\add`, `\nd`, `\wj`, `\f`,
  `\fig`, `\x`. `usfmHelpers.usfmVerseToJson()` delegates to `usfm-js`;
  `alignmentHelpers` only descends into `tag === 'zaln'` /
  `type === 'word'`. Selah is invisible in the aligner UI there too.
- **Proskomma** — scope-and-graft model. Scopes can overlap freely;
  `\qs` becomes a `span` scope, `\zaln-s` a milestone scope, and they
  may cross. Lossless round-trip without the LIFO constraint. Only
  library that handles cross-nesting correctly, but we are not using
  it.

### 2.3 What this means for us

- We don't need to support arbitrary cross-nesting (`\qs` opening,
  `\zaln-s` opening, `\qs*` closing first). Production ULT/UST never
  emits that shape (§3); usfm-js can't represent it; word-aligner-rcl
  can't read it.
- We DO need to support `\qs` wrapping `\zaln-s` from outside (the
  production ULT pattern — strictly hierarchical), inline `\f`
  footnotes between aligned words (production ULT pattern — outside
  alignment), and inline paragraph breaks (`\q1`, `\q2`, `\b`, `\ts\*`)
  between alignment groups.
- All three of those ARE hierarchical wrt the alignment milestones, so
  they fit usfm-js's single-stack model. The bug is in our walker,
  not in usfm-js.

---

## 3. Production unfoldingWord ULT/UST encoding

Verbatim Selah, from production ULT Psa 3:4
(https://github.com/WycliffeAssociates/usfm-onion/blob/master/example-corpora/en_ult/19-PSA.usfm,
which mirrors https://git.door43.org/unfoldingWord/en_ult):

```
\w his|x-occurrence="1" x-occurrences="1"\w*
\w holiness|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*.
\qs
\zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-morph="He,Tj" x-occurrence="1" x-occurrences="1" x-content="סֶֽלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
\qs*
```

Load-bearing facts:

- **Selah is itself word-aligned**: `\w Selah\w*` lives inside a
  `\zaln-s ... \zaln-e\*` milestone pointing at the UHB סֶלָה
  (`x-strong="H5542" x-lemma="סֶלָה"`).
- **`\qs` wraps the alignment from outside.** `\qs` opens on its own
  line before the milestone; `\qs*` closes after `\zaln-e\*`. Strict
  outer-to-inner nesting.
- Selah occurs 4× in the surveyed Psa 3–5 fixture; this shape repeats
  every time.

### 3.1 Inline markers that DO appear alongside `\zaln-s` in production

Surveyed: ULT Psa, Oba, Mar 1, Mat 1–2, 2Tim; UST Col, Psa 1–47.

| Marker | Position | Notes |
|---|---|---|
| `\w ... \w*` | Inside every `\zaln-s … \zaln-e\*` | Universal. |
| `\qs ... \qs*` | Wraps `\zaln-s` from outside | Psalms only. Selah is aligned. |
| `\d` | Above the first aligned word; lives in `front` pseudo-verse | Psalm titles; currently DROPPED by importer (§1 Bug 5). |
| `\f + ... \f*` | Outside alignment (after `\zaln-e\*` or after a `\w*`) | Includes `\ft`, `\fq`, `\fqa`, `\fk`, `\fr`. Production examples: Mar 1:1, 2Ti 1:11. |
| `\ms`, `\b`, `\ts\*` | Block-level, between alignment groups | Section heading, blank line, chunk milestone. |

### 3.2 Markers NOT seen inline with `\zaln-s` in surveyed ULT/UST

`\wj`, `\nd`, `\add`, `\x`, `\fig`, `\bk`, `\rq`, `\qa`, `\m`, `\pn`,
`\k`, `\tl`, `\sig`, `\sls`, `\qt`, `\qc`, `\qr`.

Two structural surprises worth recording:

- **`\wj` is not used in the ULT.** Mar 1:17 (Jesus speaking) has no
  `\wj`; speaker semantics live nowhere in the markup.
- **`\nd` is not used.** Obadiah's "Yahweh" tokens carry no `\nd`;
  divine-name semantics live entirely in the alignment attributes
  (`x-strong="H3068"`, `x-lemma="יְהֹוָה"`).

### 3.3 Implication for our subset

The set of inline markers we MUST round-trip losslessly when alignment
is touched is essentially:

- `\qs … \qs*` wrapping a `\zaln-s … \zaln-e\*` (Selah).
- `\f … \f*` (with its own footnote-internal markers) between aligned
  spans — treated as a single opaque blob, not edited by the dialog.
- `\d` and the chapter-level `front` pseudo-verse (separate workstream;
  not part of inside-a-verse alignment editing but currently breaks
  Psalm imports).
- Paragraph / block markers between alignment groups (`\q1`, `\q2`,
  `\m`, `\b`, `\ms`, `\ts\*`) — also opaque blobs whose position must
  be preserved.

`\wj`, `\nd`, `\add`, `\x`, `\fig` etc. don't appear in current ULT/UST
production. We should still preserve them in the same opaque-wrapper
path (cheap once the wrapper path exists), but they don't need
first-class UI affordances.

---

## 4. Proposed model — positional opaque wrappers

The fix is a minimal extension to the internal stream model: stop
sinking unknown nodes into `passthroughTail`, and instead capture them
in stream order with structural awareness of "wrapper opens / wrapper
closes". The verse's plain-text order then becomes well-defined and
round-trip becomes lossless without changing on-disk USFM.

### 4.1 StreamItem kinds (extended)

```ts
type StreamItem =
  | { kind: "word"; word: TargetWord; alignedTo: string | null }
  | { kind: "text"; text: string }
  | { kind: "marker"; node: ParsedNode }     // opaque inline marker, preserved verbatim
  | { kind: "openMarker"; tag: string; node: ParsedNode }
  | { kind: "closeMarker"; tag: string }
```

Three new kinds:

- **`marker`** — a self-contained inline node with no alignment-bearing
  content: `\f ... \f*`, `\ms`, `\b`, `\ts\*`, bare `\qs Selah\qs*`
  without inner alignment, `\p`/`\q1`/`\q2` with no children. Preserved
  verbatim on serialize.
- **`openMarker` / `closeMarker`** — a wrapper that contains
  alignment-bearing children (the production-ULT Selah shape:
  `\qs ... \zaln-s ... \zaln-e\* ... \qs*`). The walker descends
  through the wrapper, emits the inner words / zaln milestones into
  the same stream, and brackets them with open/close markers. The
  Selah word becomes a normal stream word with `alignedTo` pointing
  at the H5542 group; the dialog can re-align it like any other word.

### 4.2 Walker (parseAlignment)

Today (alignment.ts:136–167):

```ts
if (nodeIsZaln(node)) {
  // ... recurse ...
} else if (nodeIsWord(node)) {
  stream.push({ kind: "word", ... })
} else if (nodeIsText(node)) {
  stream.push({ kind: "text", ... })
}
// else: silently dropped
```

Proposed:

```ts
if (nodeIsZaln(node))           { /* recurse, build/reuse source group */ }
else if (nodeIsWord(node))      { stream.push({ kind: "word", ... }) }
else if (nodeIsText(node))      { stream.push({ kind: "text", ... }) }
else if (isContentWrapper(node)) {
  // node has children that include zaln / word / text
  stream.push({ kind: "openMarker", tag: node.tag, node: shallowAttrs(node) });
  walk(node.children, sourceChain, stream, sourceGroups, currentGroupId);
  stream.push({ kind: "closeMarker", tag: node.tag });
}
else {
  // opaque inline (\f, \ms, \b, \ts\*, bare \qs Selah\qs*, \p, \q1 with no children, ...)
  stream.push({ kind: "marker", node });
}
```

`isContentWrapper(node)` is true when `node.children` is a non-empty
array AND at least one child is `\zaln-s` / `\w` / text. In practice
that's `\qs` (production Selah shape) and conceivably `\add`, `\nd`,
`\wj` if they ever appear; default-true for any node-with-content-bearing-children
is safe.

Concrete consequence:

- The production Selah verseObjects shape (qs → zaln → word) becomes
  stream: `[..., openMarker("qs"), word("Selah", alignedTo=H5542group), closeMarker("qs"), ...]`.
- Selah surfaces as a normal target word in the dialog. The H5542
  source group is created. The yellow-dot bug disappears as a side
  effect (because we now actually walk into qs).

### 4.3 Serializer

Today (alignment.ts:401–472) emits prefix → stream → passthroughTail.
Proposed: drop prefix / passthroughTail entirely. Walk the stream once,
emitting in order:

- `text` → text node (or appended to current open milestone's children).
- `word` with `alignedTo === current` → push into current milestone.
- `word` with `alignedTo !== current` → close current milestone (if
  any), open new milestone (if `alignedTo` non-null), push word.
- `marker` → close current milestone, push the node verbatim.
- `openMarker` → close current milestone, start a new output frame
  (subsequent emissions go into the frame's children) and remember
  the wrapper's attributes.
- `closeMarker` → close current milestone inside the frame, pop the
  frame, push the wrapper node (with collected children) to the
  parent.

Key invariant: a `\zaln-s` milestone is always closed before crossing
an `openMarker`/`closeMarker` boundary. This matches usfm-js's
single-stack assumption and is what the production ULT does.

### 4.4 alignmentPlainText (save path)

Replace the current stream-only implementation (alignment.ts:474–481)
with a walk that mirrors `extractPlainText` in
api/src/importParsers.ts:21 — every word + text + bare-text marker
contributes. That way `plain_text` shipped on save matches the
`plain_text` shipped on import, and Selah survives.

Simplest: after the model change, every "word" in the stream is a
real target word (including Selah-via-qs), so the current
implementation just needs to emit `marker.node.text` (when present)
between open/close brackets. Equivalent: walk the serialised
verseObjects and use `extractPlainText`.

### 4.5 Yellow-dot fix

Falls out for free. Once the walker descends into wrapper nodes, the
inner `\zaln-s` for H5542 (Selah) is captured in `state.sourceGroups`,
`withSourceCoverage` sees it as covered, no placeholder is created,
and `verseHasUnalignedWork` returns the right answer.

### 4.6 `\d` Psalm titles (separate fix)

api/src/importParsers.ts:53 — accept `front` as verse 0 (the
`refParts` helper already returns `[0,0]` for that key). Importer
stores a row at `(chapter, 0, ...)`. Export round-trips by
re-emitting it as `front` in the verseObjects tree.

Caveat: the `verses` table's PK is `(book, chapter, verse, bible_version)`;
verse 0 needs a UI affordance OR has to be loaded but hidden in the
chapter view. **Out of scope for the alignment fix**; track separately
unless we want Psalm-title alignment editing in the same change.

### 4.7 buildMilestone attribute cleanup (cosmetic)

```ts
function buildMilestone(source, children) {
  const out: ParsedNode = { tag: "zaln", type: "milestone", children, endTag: "zaln-e\\*" };
  if (source.strong)      out.strong = source.strong;
  if (source.lemma)       out.lemma = source.lemma;
  if (source.morph)       out.morph = source.morph;
  if (source.occurrence)  out.occurrence = source.occurrence;
  if (source.occurrences) out.occurrences = source.occurrences;
  if (source.content)     out.content = source.content;
  return out;
}
```

Stops the cosmetic `x-lemma=""` pollution on round-trip.

### 4.8 replace.ts:457–460 (`localizedRewriteVerse`)

The "else → drop" branch for non-text, non-milestone top-level nodes
will be reached less often after §4.2 (Selah-style nodes now have
defined positions in the stream and structured children), but the
underlying replace.ts walker is structurally separate from the
alignment walker. It needs the same treatment: when an overlapping
edit hits a `\qs` / `\f` / `\b` node, partition its children if it
has any, otherwise preserve verbatim (a `\b` or `\ts\*` doesn't
"contain" the edit range — it's a marker at a point).

Lower priority than the alignment-walker fix; cleanest done in the
same PR but can be staged.

---

## 5. Phased plan

**Phase A — alignment walker / serializer (the core fix).**

1. Add the `marker` / `openMarker` / `closeMarker` stream kinds and
   the `isContentWrapper` helper. Update `walk` to descend wrappers
   and emit open/close brackets; emit opaque inline nodes as `marker`.
2. Update `serializeAlignment` to render the new stream kinds and
   drop `prefix` / `passthroughTail` (or keep them as a fallback for
   nodes that genuinely sit before any content / after all content,
   like an opening `\p` — same behaviour, narrower trigger).
3. Update `alignmentPlainText` to include marker text.
4. Update `withSourceCoverage` so that descending into wrappers is
   automatic (it already calls `walk` for sources; the same fix
   applies to `collectSourceWords`).
5. Tests (§6).

Expected line-of-code delta: small — the `walk`/`serialize` functions
are ~100 lines today; the change adds another ~60.

**Phase B — buildMilestone attribute cleanup (cosmetic).**

5-line change in `buildMilestone`. Run `spikes/usfm-roundtrip.mjs`
against ULT Psa to verify diff shrinks.

**Phase C — `localizedRewriteVerse` parity.**

Match the alignment walker's wrapper handling in replace.ts so inline
edits don't destroy `\qs` / `\f` nodes. Same model, different
consumer.

**Phase D — `\d` Psalm titles (deferred unless Psalm-title alignment
is required).**

Importer + export plumbing for `front` pseudo-verses. New row shape /
UI question.

---

## 6. Tests

Add a `web/src/lib/alignment.test.mjs` smoke test, run the same way as
`api/src/importParsers.test.mjs`. Round-trip the following USFM
fixtures through `parseAlignment → serializeAlignment → usfm.toUSFM`
and assert exact byte equality with a normalised version of the
original:

1. **Selah (production ULT shape)** — `\qs \zaln-s ... \w Selah ... \w*\zaln-e\* \qs*`.
   Assert: Selah appears in `state.unaligned` initially-empty / in a
   group, source group for H5542 exists, plain text contains "Selah",
   `verseHasUnalignedWork` returns false when fully aligned, round-trip
   restores the qs wrapper around the zaln milestone.
2. **Mid-verse footnote** — `\zaln-s …\* \w x\w* \zaln-e\*\f + \ft note\f* \zaln-s …\*`.
   Assert: footnote position preserved on round-trip.
3. **Bare `\qs Selah\qs*` (no inner alignment)** — current OBA-like shape.
   Assert: Selah preserved in plain_text and at original position.
4. **Multiple `\q1`/`\q2` between alignment groups in a poetry verse**.
   Assert: paragraph markers preserved in order.
5. **Same verse → no-op save** — open dialog, click save without edits,
   assert `content_json` byte-equal to before AND `plain_text`
   byte-equal to before. (This is the regression test for the
   user-reported bug.)
6. **Existing OBA round-trip** — keep the
   `spikes/usfm-roundtrip.mjs` assertions green.

Also a unit test for `verseHasUnalignedWork` on Selah-bearing verses.

---

## 7. Resolved scope (per review 2026-05-15)

- **`\d` Psalm titles → full UI in the same PR.** Phase D is in
  scope. Importer accepts `front` pseudo-verses, stores at
  `(book, chapter, 0)`; chapter view surfaces the title above v1 with
  the same alignment affordance. Touches Shell.tsx, ScriptureColumn.tsx,
  DocColumn.tsx, and the verses-table reader.
- **Cross-nesting policy → keep open as a Proskomma decision (§9).**

## 8. DCS round-trip safety net

Independent of the alignment fix: CLAUDE.md says "remove DCS from the
loop except for once daily". Recommend wiring
`spikes/usfm-roundtrip.mjs` (or a successor) into the daily DCS export
job for the full ULT/UST set, and failing the export job (not silently)
if marker counts drift between the stored content and the re-emitted
USFM. That's the safety net that catches everything this audit might
miss — Selah today, an unrelated marker tomorrow.

---

## 9. Addendum — Proskomma as the round-trip layer

User's call (2026-05-15): "I believe Proskomma is the premier USFM
handler right now. Refactoring to full Proskomma should not be
considered out of bounds if it's the best fix."

This addendum compares (a) the local fix proposed in §4, and (b) a
Proskomma migration. Both are real options.

### 9.1 What Proskomma buys us

- **Scope/graft model** — not a tree. Scopes (`span/qs`, milestone
  scopes with `attribute/...` children, paragraph scopes) open and
  close around token positions; overlapping is native. The "qs
  opens, zaln opens, qs* closes first" cross-nesting case is
  representable. The `passthroughTail` concept doesn't exist; every
  marker lives at its actual position.
- **PERF JSON** as the on-disk format. Proskomma's "Performance
  Representation Format" is a canonical, stable token stream. The
  `uw-editor` PERF editor and a growing set of unfoldingWord tools
  speak it. Storing PERF in D1 instead of usfm-js verseObjects would
  align us with the wider ecosystem — and PERF→USFM round-trip is
  more thoroughly tested than usfm-js's verseObjects round-trip.
- **A real parser**. Single phrase stack vs proper scope machine.
  Issues like usfm-js #98 / #103 don't exist in Proskomma because the
  data shape doesn't force them.
- **Future fit**. unfoldingWord's `uw-editor`, BibleNLP tooling, and
  the Mast / proskomma-render / scripture-burrito stack all sit on
  Proskomma. If we want to plug into any of that later (auto-suggest,
  cross-language alignment learning, etc.), we're already there.

### 9.2 What it costs

- **Bundle size and load time.** `proskomma-core` is ~1–2 MB
  unminified including the parser. It's tractable in the browser
  (uw-editor ships it), but it's noticeably heavier than usfm-js
  (~120 KB).
- **Workers/D1 fit.** Cloudflare Workers' code-size and CPU-time
  limits are tight. Running Proskomma server-side in the import path
  (`api/src/importParsers.ts` / `pipelineImport.ts`) is feasible but
  needs a load test; if Proskomma's parse-and-query cycle blows the
  50 ms cumulative-CPU budget on a 100-verse chapter, we need a
  chunked or off-Worker import path. Verify with a spike before
  committing.
- **Data shape change.** D1 currently stores per-verse usfm-js JSON
  in `verses.content_json`. PERF is structurally different (token
  stream + scope deltas, not a verseObject tree). Two viable paths:
  - **Replace.** Store PERF in `content_json`; rewrite the export
    pipeline to emit USFM from PERF; rewrite the alignment dialog
    against PERF tokens / scopes.
  - **Layer.** Keep usfm-js verseObjects on disk, use Proskomma only
    inside the alignment path (parse USFM with Proskomma, serialize
    with Proskomma, persist via the existing schema). Smaller blast
    radius; doesn't get the full ecosystem-fit benefit.
- **Aligner UI rewrite.** Our alignment dialog
  (web/src/components/AlignmentDialog.tsx, 1174 LOC) is built around
  the `AlignmentState.stream` model. A PERF-native dialog operates on
  alignment-attribute scopes — different data shape, similar UI
  affordances. Probably a real rewrite of ~600–800 LOC of dialog code,
  not a refactor. The UI shell (verse strip, unaligned bag, source
  chips, lexicon tooltips) is reusable.
- **Removing `\zaln`-specific code.** withSourceCoverage,
  AlignmentGroup, sourceShowsOccurrence, etc. all assume the usfm-js
  shape. Most of `lib/alignment.ts`, `lib/replace.ts`, and the dialog's
  display-layer helpers (sourceKey, stripCompoundOverlaps,
  mergeAdjacentSameSource, buildSourceIndexMap) need rewrites against
  PERF.

### 9.3 Recommendation

**Ship Phase A–D first (local fix). Spike Proskomma in parallel.**

Reasons:

1. The user-reported Selah bug, the plain-text-desync bug, and the
   yellow-dot false positive are all live data-quality issues today.
   Phase A is ~60 LOC + tests and ships them this week.
2. Phase D (Psalm-title UI) is wanted in the same PR — we need
   alignment.ts to work for `\d`-bearing verses regardless of which
   parser backs them.
3. Proskomma migration is a 2–4 week project (parse/query spike,
   bundle audit, PERF schema migration, dialog rewrite, regression
   suite). Worth doing, but not on the critical path for a hot bug.
4. The fix in §4 is forward-compatible with a later Proskomma
   migration: the StreamItem model is purely internal; nothing
   persists that shape. Replacing the parser/serializer pair under
   the dialog later is straightforward as long as we keep
   AlignmentState as the dialog's contract.

Proskomma spike scope (parallel work, not blocking this PR):

- Verify Proskomma parses production ULT Psa and surfaces the Selah
  zaln + qs interleaving correctly.
- Measure import-path CPU time on a 50-chapter book under the Worker
  CPU budget.
- Sketch the PERF → D1 storage shape and the migration path from the
  existing usfm-js JSON.
- Build a PERF-native alignment dialog prototype against a single
  Selah-bearing verse; A/B it against the §4 fix.

Decide go/no-go on full migration after the spike. If green, the §4
fix is throwaway code but the audit and the tests stay; the tests
re-target Proskomma's round-trip with the same fixtures.

If you'd rather skip the local fix and go straight to Proskomma, the
spike scope above becomes the actual work, the user-reported bug
stays live for another 2–4 weeks, and we ship one larger PR instead
of two staged ones.

### 9.4 Sources

- Proskomma core: https://github.com/Proskomma/proskomma-core
- Proskomma docs: https://doc.proskomma.bible/
- PERF spec: https://github.com/proskomma/proskomma-docs/tree/main/source/perf
- uw-editor (PERF editor on Proskomma):
  https://github.com/unfoldingWord/uw-editor
- Scripture Burrito (PERF-compatible scripture metadata):
  https://github.com/bible-technology/scripture-burrito
- Mast (Proskomma-based markdown→USFM): https://github.com/Proskomma/mast

---

## 8. Evidence / sources

Live traces on the running sandbox:

- `/tmp/tester/trace.log` — full before/after JSON + USFM for Cases A–D
  (Selah at verse end, Selah mid-verse, bare Selah, mid-verse
  footnote).
- `/tmp/tester/unaligned-check.mjs` — yellow-dot false positive
  reproduction.
- `/tmp/tester/case-d-marker.mjs` — `\d` Psalm-title placement under
  `front` pseudo-verse.

External sources:

- USFM 3 milestones spec: https://github.com/ubsicap/usfm/blob/master/docs/milestones/index.rst
- USFM 3 character marker nesting: https://github.com/ubsicap/usfm/blob/master/docs/characters/nesting.rst
- USFM 3 official stylesheet (no `zaln`): https://github.com/ubsicap/usfm/blob/master/sty/usfm.sty
- usfm-js source: https://github.com/unfoldingWord/usfm-js/blob/master/src/js/USFM.js
- usfm-js issues #98, #103: https://github.com/unfoldingWord/usfm-js/issues
- word-aligner-rcl helpers: https://github.com/unfoldingWord/word-aligner-rcl/tree/master/src/helpers
- Proskomma model: https://github.com/Proskomma/proskomma-docs/blob/main/source/__old/user_model/building_blocks.rst
- Production ULT Psa 3 (Selah verbatim): https://github.com/WycliffeAssociates/usfm-onion/blob/master/example-corpora/en_ult/19-PSA.usfm
- Production ULT Mar (footnote + alignment): https://github.com/WycliffeAssociates/usfm-onion/blob/master/example-corpora/en_ult/42-MRK.usfm
- Door43 canonical (unreachable from the cloud sandbox but is the
  authoritative source): https://git.door43.org/unfoldingWord/en_ult
- Door43 USFM3 Alignment Data Encoding (the proposal that introduced
  `\zaln`): https://forum.door43.org/t/usfm3-alignment-data-encoding/34

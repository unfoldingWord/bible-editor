# Editor performance and viewport fixes

Branch: `fix/editor-performance`, initially based on `origin/main` at `5aefcc22`;
subsequently merged `e8fb508c` (quote-picker PR #804) for PR #805 review.

## Scope

These changes address the September 15 production investigation: Find moved the
viewport after its debounce; selecting visible verses triggered centering;
dirty controls changed text layout; every verse input caused a full draft-store
scan and broad subscriber updates; lint fetched six datasets sequentially and
repeatedly parsed translation content.

Production EZK 48:35 was restored through history after the earlier authorized
diagnostic save. Implementation verification uses an isolated local ZEC fixture,
not production. Nothing has been deployed.

## Changes

- Find typing and scope changes highlight/count silently. Enter, previous/next,
  and replacement explicitly navigate. Search highlights no longer add padding
  that can change line wrapping.
- Local verse clicks suppress centering in the source scripture pane. Stacked
  rows compensate for card expansion; book mode retains scroll position through
  cross-chapter remounts. Explicit navigation remains available.
- Dirty save/undo controls reserve their space in the active editor.
- Draft persistence still occurs on every keystroke. One shared initial read and
  per-key refresh/subscriptions replace repeated full-store scans. Visibility
  observers remain stable while the draft's text changes.
- Draft notification tests cover overlapping refreshes, hydration during writes,
  failed reads, and preservation of dirty state.
- Lint uses one D1 batch for the six existing queries and bounded per-verse parsed
  content reuse. In-flight refresh invalidations coalesce into a follow-up;
  dismiss callers await a request started after their invalidation.

## Automated verification

- Web: 46 test files passed, including readonly paragraph/poetry Find offsets.
- API: 75 test files passed.
- API and web typechecks passed after integration.
- Final production build passed (existing large-chunk advisory remains).
- Browser: s10 plus all four s12 tests passed. Coverage includes Find persistence
  across chapters, silent/pending-debounce search, rapid typing, explicit Enter,
  TN scope, local clicks and go-to-active in all three modes, and cross-chapter
  book restoration within one pixel.
- Both s9 browser race tests passed (42.4 seconds): a different tab drains a save
  and releases the originating tab's pin, and a locked save drops/releases its
  pin before a successful unlocked save. Updated stale test selectors, true
  end-of-text append, and per-run markers; race assertions remain unchanged.
- Total: 121 unit-test files and seven Playwright regression tests passed, plus
  the separate live typing/save/history/three-mode smoke checks below.
- Lint equivalence tests preserve issue contents/order, malformed/aligned content,
  bridges, cross-verse punctuation, and invalidation after content changes.
- Synthetic 1,200-verse lint workload: JSON parses 7,248 -> 3,648; one measured
  run took 350 -> 221 ms. This is not a production latency claim.

## Limits

Lint still transfers complete book data; no potentially stale report cache or
schema migration is introduced. Local browser timings are not comparable to
production network/D1 latency. Final production latency requires deployment and
measurement under real load. Tabs running old code should be reloaded on release
to participate in the new cross-tab draft notifications.

## Local browser evidence

Isolated Vite/Wrangler at `http://127.0.0.1:5194`, run
`20260915-170416`, ZEC 1:3, separate browser context. Browser verification follows
the project's `verify-bible-editor` launch/doctor/evidence/cleanup workflow.

- 20 typing/deletion events: 20 durable draft writes, **0 full-store reads**,
  20 key reads, **1** visibility observer construction. Earlier production probe
  had 20 full-store reads and 16 constructions for 20 inputs (different fixture).
- Active column editor width, height, and top were identical before/after the
  typing-and-deletion sequence; no characters lost. One 65 ms long task remained
  in this development-build run, so this does not claim all render cost is gone.
- Final three-mode Find smoke: typing the query produced highlights and left
  viewport offsets exactly unchanged in rows, columns, and book mode. Before/
  after screenshots and ARIA snapshots captured for each mode.
- UI save returned HTTP 200 in 562 ms. UI history restore returned HTTP 200 in
  573 ms, with exact text **and content tree** equality to baseline.
- Imported fixtures have no original history entry. A setup-only API write first
  recorded the unchanged original content; the measured edit and restore both
  went through the real UI/outbox. No production write was involved.
- IndexedDB clear-of-saved-generation racing with new typing preserved the new
  draft. Final draft count: zero. Uncaught browser errors: zero.
- Real local batched lint endpoint: HTTP 200, 208 ms, 22 flags/0 escalations.

Screenshots, before/after ARIA snapshots, timings, readback, and race result are
under `.cursor/skills/verify-bible-editor/artifacts/20260915-170416/` (local,
generated evidence; not release source).

## Main-branch integration

Resolved the stacked-row renderer overlap with PR #804 by retaining spanning-note
highlight sets and paragraph-preserving Find. Matching Find takes priority over
note marks, as in columns/book mode, so note word tags cannot split multi-word
search matches. Closing Find restores spanning-note highlights.

The merged code passed all 46 web and 75 API unit-test files and the production
build. The original seven browser regression tests passed again. Added s13
covering spanning notes plus multi-word Find in all three modes, unchanged
geometry, restored note marks, and both source verses in the quote picker.
The final combined s9/s10/s12/s13 run passed all eight tests in 1.3 minutes.
Local integration evidence is under
`.cursor/skills/verify-bible-editor/artifacts/20260915-174117/`.

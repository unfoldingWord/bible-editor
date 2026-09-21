// Regression tests for chapter-intro hint notes (issue #819).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/introHints.test.mjs
//
// Not a test framework; a failed assert exits non-zero.
//
// Two halves:
//   1. buildIntroHints/isIntroHintComment — pure functions, tested directly.
//   2. pipelines.ts's route-embedded SELECT that gathers intro comments. Like
//      forceFailJob's sibling checks in pipelinesForceFail.test.mjs, the Hono
//      route itself isn't driveable under plain node (see that file's
//      header), so this is a source-text assertion: it proves the WHERE
//      clause's guards were not deleted, not that the query is semantically
//      correct against real SQLite (three-valued NULL logic could still hide
//      a bug a text match wouldn't see).

import { readFileSync } from "node:fs";
import { buildIntroHints, isIntroHintComment } from "./introHints.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── isIntroHintComment / buildIntroHints ──────────────────────────────────
{
  console.log("\n[isIntroHintComment / buildIntroHints]");

  assert(
    JSON.stringify(buildIntroHints([])) === "[]",
    "empty input yields empty output",
  );

  // Review finding on the original version of this PR: every unresolved
  // verse-0 top-level note was swept in as a hint, including ordinary
  // editor-to-editor discussion. Only an explicit "AI:"-marked note opts in.
  assert(isIntroHintComment("AI: mention the covenant theme"), "leading 'AI:' marker opts in");
  assert(isIntroHintComment("ai: mention the covenant theme"), "marker match is case-insensitive");
  assert(isIntroHintComment("  AI:  extra leading whitespace is fine"), "leading whitespace before the marker is tolerated");
  assert(!isIntroHintComment("Looks good to me."), "an ordinary discussion note is not a hint");
  assert(!isIntroHintComment("Mentioned AI: earlier in the thread"), "the marker must be at the start, not embedded mid-sentence");
  assert(!isIntroHintComment("AI-generated draft needs review"), "'AI' without the colon does not match");
  assert(!isIntroHintComment("AI:"), "a bare marker with nothing after it is not a hint");
  assert(!isIntroHintComment("AI:   "), "a marker followed only by whitespace is not a hint");

  const rows = [
    { id: 1, chapter: 3, body: "AI: Mention the covenant theme in vv 1-6." },
    { id: 2, chapter: 3, body: "Looks good, thanks!" }, // ordinary discussion — must be dropped
    { id: 3, chapter: 3, body: "ai: there's disagreement about the date; note it." },
    { id: 4, chapter: 4, body: "AI: outline should call out the shift in audience." },
    { id: 5, chapter: 4, body: "AI:" }, // marker with nothing to say — must be dropped
  ];
  const hints = buildIntroHints(rows);
  assert(hints.length === 3, `only the 3 explicitly-marked, non-empty rows become hints (got ${hints.length})`);
  assert(
    hints.every((h) => !("id" in h)),
    "the comment's own id is dropped — bp-assistant has nothing to echo back for an intro hint",
  );
  assert(
    hints[0].chapter === 3 && hints[0].note === "Mention the covenant theme in vv 1-6.",
    "the marker is stripped from the forwarded note text",
  );
  assert(
    hints[1].note === "there's disagreement about the date; note it.",
    "a lowercase 'ai:' marker is stripped the same way",
  );
  assert(
    hints[2].chapter === 4 && hints[2].note === "outline should call out the shift in audience.",
    "hints from a different chapter in the same batch keep their own chapter number",
  );
}

// ─── pipelines.ts wiring (source-text) ──────────────────────────────────────
{
  console.log("\n[pipelines.ts /start intro-hints wiring]");
  const src = readFileSync(new URL("./pipelines.ts", import.meta.url), "utf8");

  const selectMatch = src.match(
    /SELECT id, chapter, body\s+FROM comments\s+WHERE book = \?1 AND chapter BETWEEN \?2 AND \?3\s+AND ([^`]+?)\s+ORDER BY chapter, created_at ASC/,
  );
  assert(selectMatch !== null, "the intro-comments SELECT exists with the expected shape");
  const guards = selectMatch ? selectMatch[1] : "";

  assert(/verse = 0/.test(guards), "scoped to verse 0 (the chapter intro), not arbitrary verse comments");
  assert(
    /row_kind IS NULL/.test(guards),
    "scoped to the verse-level anchor (no rowKind) — not a comment thread on a specific tn/tq/twl row",
  );
  assert(
    /parent_id IS NULL/.test(guards),
    "top-level threads only — a reply must not be double-counted as its own hint",
  );
  assert(/kind = 'note'/.test(guards), "scoped to notes, not open questions");
  assert(/resolved_at IS NULL/.test(guards), "excludes already-resolved comments");
  assert(/deleted_at IS NULL/.test(guards), "excludes soft-deleted comments");

  assert(
    /mergedOptions = \{ \.\.\.\(mergedOptions \?\? \{\}\), introHints \};/.test(src),
    "introHints is folded onto mergedOptions (not clobbering a prior options.hints assignment)",
  );
  assert(
    !/resolveIntroHintComments/.test(src),
    "no auto-resolve on dispatch — review finding: resolving before the job is known to have been accepted (or before bp-assistant even consumes the key) would silently discard the hint",
  );

  const resumeMatch = src.match(
    /const \{ fresh: _fresh, introHints: _introHints, \.\.\.rest \} = parsed as Record<string, unknown>;/,
  );
  assert(
    resumeMatch !== null,
    "introHints is stripped in resumeOptionsFromJson alongside fresh — the bot's resume schema doesn't know the key and 400s on an unknown one",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed.");

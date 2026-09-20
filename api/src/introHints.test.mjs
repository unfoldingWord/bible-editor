// Regression tests for chapter-intro hint notes (issue #819).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/introHints.test.mjs
//
// Not a test framework; a failed assert exits non-zero.
//
// Two halves:
//   1. buildIntroHints — a pure function, tested directly.
//   2. pipelines.ts's route-embedded SELECT that gathers unresolved intro
//      comments. Like forceFailJob's sibling checks in
//      pipelinesForceFail.test.mjs, the Hono route itself isn't driveable
//      under plain node (see that file's header), so this is a source-text
//      assertion: it proves the WHERE clause's guards were not deleted, not
//      that the query is semantically correct against real SQLite (three-
//      valued NULL logic could still hide a bug a text match wouldn't see).

import { readFileSync } from "node:fs";
import { buildIntroHints } from "./introHints.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── buildIntroHints ────────────────────────────────────────────────────────
{
  console.log("\n[buildIntroHints]");

  assert(
    JSON.stringify(buildIntroHints([])) === "[]",
    "empty input yields empty output",
  );

  const rows = [
    { id: 1, chapter: 3, body: "Mention the covenant theme in vv 1-6." },
    { id: 2, chapter: 3, body: "There's disagreement about the date; note it." },
    { id: 4, chapter: 4, body: "Outline should call out the shift in audience." },
  ];
  const hints = buildIntroHints(rows);
  assert(hints.length === 3, "one hint per comment row");
  assert(
    hints.every((h) => !("id" in h)),
    "the comment's own id is dropped — bp-assistant has nothing to echo back for an intro hint",
  );
  assert(
    hints[0].chapter === 3 && hints[0].note === rows[0].body,
    "first hint carries chapter + body verbatim",
  );
  assert(
    hints[2].chapter === 4 && hints[2].note === rows[2].body,
    "hints from a different chapter in the same batch keep their own chapter number",
  );
  assert(
    JSON.stringify(hints) ===
      JSON.stringify([
        { chapter: 3, note: rows[0].body },
        { chapter: 3, note: rows[1].body },
        { chapter: 4, note: rows[2].body },
      ]),
    "output order mirrors input order (caller sorts by chapter, created_at)",
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
  assert(
    /resolved_at IS NULL/.test(guards),
    "unresolved only — this is the guard that stops a hint resurrecting forever once sent",
  );
  assert(/deleted_at IS NULL/.test(guards), "excludes soft-deleted comments");

  assert(
    /mergedOptions = \{ \.\.\.\(mergedOptions \?\? \{\}\), introHints \};/.test(src),
    "introHints is folded onto mergedOptions (not clobbering a prior options.hints assignment)",
  );
  assert(
    /resolveIntroHintComments\(\s*c\.env\.DB,\s*introHintRows\.map/.test(src),
    "consumed comments are resolved through the shared helper, not a second inline UPDATE",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed.");

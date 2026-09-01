// Issue #686 — the row-provenance vocabulary and, above all, the ONE rule in it
// that can do harm if it is wrong: `door43Actor` must never name a person the
// run's lineage did not measure.
//
// Everything else in rowProvenance.ts is a string constant or a parameter-index
// helper, and the real-SQL coverage for the stamps themselves lives in
// rowProvenanceStamps.test.mjs (which runs the actual migrations and the actual
// write paths). This file is the pure half: the attribution decision, and the
// bind-order helpers that keep ~45 hand-numbered statements from binding an
// action string into a content column.
//
// ABLATION (run by patching rowProvenance.ts and re-running this file). A guard
// whose removal breaks nothing is not a guard:
//
// Measured 2026-09-01, 23 assertions at baseline:
//
//   baseline (as shipped)                          exit 0, 0 FAIL
//   A1 drop the `incomplete !== false` check        exit 1, 2 FAIL — an
//      (an unfinished walk allowed to name people)  incomplete walk that HAD a
//                                                   named author starts claiming
//                                                   "Door43: Stephen Wunrow",
//                                                   and an incomplete walk with
//                                                   no human commit starts
//                                                   claiming "(AI/bot push)"
//   A2 fall back to `humanShas` when `humanCommits` exit 1, 1 FAIL — a pre-#684
//      is absent                                    persisted summary starts
//                                                   naming an author it never
//                                                   recorded
//   A3 drop the `named.length === 0` fallback       exit 1, 2 FAIL — renders
//                                                   "Door43: " with nobody in it,
//                                                   both for a lineage whose
//                                                   authors are all null and for
//                                                   the pre-#684 summary (which
//                                                   reaches the same fallback)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aiPipelineActor,
  door43Actor,
  DOOR43_ACTOR_AI_PUSH,
  DOOR43_ACTOR_UNMEASURED,
  PROVENANCE_COLUMNS,
  provenanceSet,
  provenanceValues,
} from "./rowProvenance.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// A compacted MasterLineageSummary, the shape that actually reaches a write
// site (it rides on the merge cutoff — bookReimport.ts's `cutoff.lineage`).
function summary(over = {}) {
  return {
    mayHoldHumanEdit: false,
    hasHumanCommit: false,
    incomplete: false,
    incompleteReason: "",
    counts: { ours: 0, ai: 0, human: 0 },
    humanShas: [],
    ...over,
  };
}

// Real Door43 author names off en_tn/en_ult master history, not invented ones.
const WUNROW = "Stephen Wunrow";
const MAHN = "Richard Mahn";

// ── nothing measured → the bare fallback ─────────────────────────────────────
{
  eq(door43Actor(null), DOOR43_ACTOR_UNMEASURED, "no lineage at all names nobody");
  eq(door43Actor(undefined), DOOR43_ACTOR_UNMEASURED, "an absent lineage names nobody");
  eq(
    door43Actor(
      summary({
        incomplete: true,
        incompleteReason: "paging cap",
        hasHumanCommit: true,
        mayHoldHumanEdit: true,
        counts: { ours: 0, ai: 0, human: 1 },
        humanShas: ["b39f0c7aa1"],
        // The author IS present here on purpose: without it, dropping the
        // incompleteness guard would still fall through to "nothing to name"
        // and this assertion would pass with the guard removed — proving
        // nothing. The walk found a named human and STILL may not be quoted,
        // because an unfinished walk has not established that this commit is
        // the one that last moved the file.
        humanCommits: [{ sha: "b39f0c7aa1", author: WUNROW, date: "2026-08-14T09:12:00-05:00" }],
      }),
    ),
    DOOR43_ACTOR_UNMEASURED,
    "an INCOMPLETE walk names nobody even though it measured a named human commit",
  );
  // The A1 ablation's second casualty: an unfinished walk has not established
  // that nobody human touched the file either, so it may not claim a bot push.
  eq(
    door43Actor(summary({ incomplete: true, incompleteReason: "fetch failed" })),
    DOOR43_ACTOR_UNMEASURED,
    "an INCOMPLETE walk with no human commit still does NOT claim an AI/bot push",
  );
}

// ── a complete walk that found no human commit → a real measurement ──────────
{
  eq(
    door43Actor(summary({ counts: { ours: 3, ai: 2, human: 0 } })),
    DOOR43_ACTOR_AI_PUSH,
    "a COMPLETE walk with no human commit is measured, and says so",
  );
}

// ── measured human commits, with identity → the name ─────────────────────────
{
  const one = summary({
    hasHumanCommit: true,
    mayHoldHumanEdit: true,
    counts: { ours: 0, ai: 1, human: 1 },
    humanShas: ["b39f0c7aa1"],
    humanCommits: [{ sha: "b39f0c7aa1", author: WUNROW, date: "2026-08-14T09:12:00-05:00" }],
  });
  eq(door43Actor(one), `Door43: ⁨${WUNROW}⁩`, "one measured author is named, bidi-isolated");

  const two = summary({
    hasHumanCommit: true,
    mayHoldHumanEdit: true,
    counts: { ours: 0, ai: 0, human: 2 },
    humanShas: ["b39f0c7aa1", "aa12bc3ff0"],
    humanCommits: [
      { sha: "b39f0c7aa1", author: WUNROW, date: "2026-08-14T09:12:00-05:00" },
      { sha: "aa12bc3ff0", author: MAHN, date: "2026-08-13T17:40:00-06:00" },
    ],
  });
  eq(door43Actor(two), `Door43: ⁨${WUNROW}⁩ and ⁨${MAHN}⁩`, "two measured authors, newest first");

  // Three commits by one person is ONE fact about one person.
  const repeated = summary({
    hasHumanCommit: true,
    counts: { ours: 0, ai: 0, human: 3 },
    humanShas: ["a", "b", "c"],
    humanCommits: [
      { sha: "a", author: WUNROW, date: "2026-08-14T09:12:00-05:00" },
      { sha: "b", author: WUNROW, date: "2026-08-14T08:02:00-05:00" },
      { sha: "c", author: WUNROW, date: "2026-08-13T22:31:00-05:00" },
    ],
  });
  eq(door43Actor(repeated), `Door43: ⁨${WUNROW}⁩`, "a repeated author is named once, not three times");

  // Past two DISTINCT authors the field says so without inventing a count of
  // people it never saw.
  const many = summary({
    hasHumanCommit: true,
    counts: { ours: 0, ai: 0, human: 3 },
    humanShas: ["a", "b", "c"],
    humanCommits: [
      { sha: "a", author: WUNROW, date: "2026-08-14T09:12:00-05:00" },
      { sha: "b", author: MAHN, date: "2026-08-13T17:40:00-06:00" },
      { sha: "c", author: "Jesse Griffin", date: "2026-08-12T11:05:00-06:00" },
    ],
  });
  eq(
    door43Actor(many),
    `Door43: ⁨${WUNROW}⁩ and ⁨${MAHN}⁩ and others`,
    "a third distinct author becomes 'and others', never a precise-looking wrong number",
  );
}

// ── measured human commits WITHOUT identity → still nobody named ─────────────
{
  // A summary persisted before #684: it has the shas, it has the count, and it
  // has no idea who. This is the A2 ablation: reading a name out of a field
  // that was never populated is the exact fabrication the rule forbids.
  const preIdentity = summary({
    hasHumanCommit: true,
    mayHoldHumanEdit: true,
    counts: { ours: 0, ai: 0, human: 2 },
    humanShas: ["b39f0c7aa1", "aa12bc3ff0"],
  });
  eq(
    door43Actor(preIdentity),
    DOOR43_ACTOR_UNMEASURED,
    "a pre-#684 summary (shas but no humanCommits) names nobody",
  );

  // Gitea reported no author on the commits it did record. A3.
  const anonymous = summary({
    hasHumanCommit: true,
    counts: { ours: 0, ai: 0, human: 1 },
    humanShas: ["b39f0c7aa1"],
    humanCommits: [{ sha: "b39f0c7aa1", author: null, date: "2026-08-14T09:12:00-05:00" }],
  });
  eq(door43Actor(anonymous), DOOR43_ACTOR_UNMEASURED, "measured commits with no legible author name nobody");
}

// ── the name is sanitized the same way a review reason's is ──────────────────
{
  // A name carrying a newline and a legacy bidi override. Third-party free text
  // lands in a one-line field here exactly as it does in a review reason, so it
  // goes through the SAME masterLineage.displayAuthor — this asserts we did not
  // grow a second, laxer sanitizer.
  const nasty = summary({
    hasHumanCommit: true,
    counts: { ours: 0, ai: 0, human: 1 },
    humanShas: ["a"],
    humanCommits: [{ sha: "a", author: "Bad\nName‮", date: "2026-08-14T09:12:00-05:00" }],
  });
  eq(door43Actor(nasty), "Door43: ⁨Bad Name⁩", "controls and legacy bidi overrides are stripped from the name");

  const long = "A".repeat(80);
  const clamped = summary({
    hasHumanCommit: true,
    counts: { ours: 0, ai: 0, human: 1 },
    humanShas: ["a"],
    humanCommits: [{ sha: "a", author: long, date: null }],
  });
  eq(door43Actor(clamped), `Door43: ⁨${"A".repeat(39)}…⁩`, "a very long name is clamped, not carried whole");
}

// ── the AI actor carries BOTH facts ──────────────────────────────────────────
{
  eq(
    aiPipelineActor("justplainjane47"),
    "AI pipeline (run by justplainjane47)",
    "an AI write names the pipeline AND the human who started it",
  );
  eq(aiPipelineActor(null), "AI pipeline", "…and still says a pipeline wrote it when the starter is unknown");
  eq(aiPipelineActor(""), "AI pipeline", "an empty username does not render an empty parenthetical");
}

// ── bind-order helpers ───────────────────────────────────────────────────────
{
  eq(
    provenanceSet(7),
    "last_change_action = ?7, last_change_source = ?8, last_change_actor = ?9",
    "provenanceSet numbers three consecutive parameters from the given index",
  );
  eq(PROVENANCE_COLUMNS.join(", "), "last_change_action, last_change_source, last_change_actor", "column order");
  eq(
    JSON.stringify(provenanceValues({ action: "update", source: "user", actor: "benjamin" })),
    JSON.stringify(["update", "user", "benjamin"]),
    "provenanceValues emits the tuple in the same order provenanceSet numbers it",
  );
  // The two must agree, or every hand-numbered statement in the codebase binds
  // an action into a source column. Asserted structurally rather than by eye.
  const set = provenanceSet(1);
  eq(
    PROVENANCE_COLUMNS.every((c, i) => set.indexOf(`${c} = ?${i + 1}`) >= 0),
    true,
    "PROVENANCE_COLUMNS and provenanceSet agree on the order of all three columns",
  );
}

// ── the migration and the union do not drift apart ───────────────────────────
{
  // The migration header documents the vocabulary; the TypeScript union
  // enforces it. If someone adds an action to one and not the other, the header
  // starts lying about what a reader can find in the column.
  const here = fileURLToPath(import.meta.url);
  const src = readFileSync(here.replace(/rowProvenance\.test\.mjs$/, "rowProvenance.ts"), "utf8");
  const mig = readFileSync(
    here.replace(/src[\\/]rowProvenance\.test\.mjs$/, "migrations/0060_row_provenance.sql"),
    "utf8",
  );
  // Every `| "value"` in the LastChangeAction union, in source order.
  const unionBlock = src.slice(src.indexOf("export type LastChangeAction"), src.indexOf("export type LastChangeSource"));
  const actions = [...unionBlock.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
  eq(actions.length > 0, true, "the LastChangeAction union parsed");
  const missing = actions.filter((a) => !mig.includes(`'${a}'`));
  eq(missing.join(","), "", "every action in the union is documented in migration 0060's header");
  const sourceBlock = src.slice(src.indexOf("export type LastChangeSource"), src.indexOf("export interface RowProvenance"));
  const sources = [...sourceBlock.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const missingSources = sources.filter((s) => !mig.includes(`'${s}'`));
  eq(missingSources.join(","), "", "every source in the union is documented in migration 0060's header");
}

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nall rowProvenance assertions passed");

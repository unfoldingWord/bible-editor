// Tests for web/src/sync/refusedVerseRollback.ts (#1073): after a verse save
// is refused as chapter_locked, how Shell puts the server's row back into a
// cache that still holds the refused optimistic content.

import assert from "node:assert/strict";
import { planRefusedVerseRollback } from "./refusedVerseRollback.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const row = (version, text) => ({
  book: "ZEC",
  chapter: 6,
  verse: 2,
  verse_end: null,
  bible_version: "ULT",
  plain_text: text,
  version,
  updated_by: 1,
  updated_at: 0,
  content: { verseObjects: [{ type: "text", text }] },
});

const server = row(3, "server");
// The optimistic apply keeps the pre-save version (Shell's onSave paths), so
// the cache holds the refused content at the server's version.
const refused = row(3, "refused");

{
  const plan = planRefusedVerseRollback({ serverRow: server, cachedRow: refused, stillQueuedForTarget: false });
  check(plan.kind === "force", "same version: the server's row is forced over the refused content");
  check(plan.kind === "force" && plan.row === server, "the forced row is the server's");
}

{
  const plan = planRefusedVerseRollback({ serverRow: row(4, "foreign"), cachedRow: refused, stillQueuedForTarget: false });
  check(plan.kind === "remote", "server moved on: the version-gated apply is used");
}

check(
  planRefusedVerseRollback({ serverRow: server, cachedRow: row(5, "newer"), stillQueuedForTarget: false }).kind === "skip",
  "a cache row newer than the fetch is never regressed",
);

check(
  planRefusedVerseRollback({ serverRow: server, cachedRow: refused, stillQueuedForTarget: true }).kind === "skip",
  "another queued save of the verse settles the cache itself",
);

check(
  planRefusedVerseRollback({ serverRow: undefined, cachedRow: refused, stillQueuedForTarget: false }).kind === "skip",
  "a row the server no longer has (bridged away) is left to the structure updates",
);

check(
  planRefusedVerseRollback({ serverRow: server, cachedRow: undefined, stillQueuedForTarget: false }).kind === "skip",
  "a cache with no copy of the verse gets nothing inserted",
);

console.log(`refusedVerseRollback: ${passed} passed`);

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
// Unchanged during the GET: the same row (or a copy sharing its content).
const plan = (overrides) =>
  planRefusedVerseRollback({
    serverRow: server,
    cachedBefore: refused,
    cachedRow: refused,
    stillQueuedForTarget: false,
    ...overrides,
  });

{
  const p = plan({});
  check(p.kind === "force", "same version: the server's row is forced over the refused content");
  check(p.kind === "force" && p.row === server, "the forced row is the server's");
}

check(
  plan({ cachedRow: { ...refused } }).kind === "force",
  "a copy of the refused row (same version and content object) still counts as unchanged",
);

check(
  plan({ serverRow: row(4, "foreign") }).kind === "remote",
  "server moved on: the version-gated apply is used",
);

{
  const before = row(5, "newer");
  check(
    plan({ cachedBefore: before, cachedRow: before }).kind === "skip",
    "a cache row newer than the fetch is never regressed",
  );
}

check(plan({ stillQueuedForTarget: true }).kind === "skip", "another queued save of the verse settles the cache itself");

check(
  plan({ serverRow: undefined }).kind === "skip",
  "a row the server no longer has (bridged away) is left to the structure updates",
);

check(
  plan({ cachedBefore: undefined, cachedRow: undefined }).kind === "skip",
  "a cache with no copy of the verse gets nothing inserted",
);

// Review of #1073: the user saved the verse again while the GET was in
// flight. The new optimistic row keeps version 3, so a version-only check
// would force the server's older row over it.
check(
  plan({ cachedRow: row(3, "saved again during the GET") }).kind === "skip",
  "the cache changed during the fetch (same version, new content): skip",
);
check(
  plan({ cachedRow: row(4, "landed during the GET") }).kind === "skip",
  "the cache changed during the fetch (new version): skip",
);
check(
  plan({ cachedBefore: undefined }).kind === "skip",
  "a row that appeared in the cache during the fetch is left alone",
);

console.log(`refusedVerseRollback: ${passed} passed`);

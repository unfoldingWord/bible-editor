// Smoke test for commentsIndex.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/commentsIndex.test.mjs

import { rowKey, indexComments, countThreads } from "./commentsIndex.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

let nextId = 1;
function mkComment(overrides = {}) {
  const id = overrides.id ?? nextId++;
  return {
    id,
    book: "DAN",
    chapter: 2,
    verse: 28,
    rowKind: null,
    rowId: null,
    parentId: null,
    kind: "question",
    body: "body",
    mentions: [],
    authorId: 1,
    authorName: "Chris",
    createdAt: id,
    updatedAt: id,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByName: null,
    deletedAt: null,
    ...overrides,
  };
}

// --- rowKey ---
{
  assert(rowKey("tn", "abcd") === "tn:abcd", "rowKey composes kind:id");
  assert(rowKey("tq", "abcd") !== rowKey("tn", "abcd"), "rowKey differs by kind");
}

// --- verse vs row bucketing ---
{
  const verseRoot = mkComment({ verse: 28 });
  const rowRoot = mkComment({ verse: 28, rowKind: "tn", rowId: "abcd" });
  const idx = indexComments([verseRoot, rowRoot]);
  assert(idx.threadsByVerse.get(28)?.length === 1, "verse-anchored root lands in threadsByVerse");
  assert(idx.threadsByRow.get("tn:abcd")?.length === 1, "row-anchored root lands in threadsByRow");
  assert(idx.threadsByRow.get("tn:abcd")?.[0].root.id === rowRoot.id, "row bucket holds the right root");
}

// --- reply grouping under its root ---
{
  const root = mkComment({ createdAt: 10 });
  const reply1 = mkComment({ parentId: root.id, createdAt: 20 });
  const reply2 = mkComment({ parentId: root.id, createdAt: 15 });
  const idx = indexComments([root, reply1, reply2]);
  const thread = idx.threadsByVerse.get(root.verse)[0];
  assert(thread.replies.length === 2, "both replies grouped under root");
  assert(thread.replies[0].id === reply2.id && thread.replies[1].id === reply1.id, "replies sorted by createdAt ascending");
}

// --- deleted root removes its replies ---
{
  const root = mkComment({ deletedAt: 100 });
  const reply = mkComment({ parentId: root.id });
  const idx = indexComments([root, reply]);
  assert((idx.threadsByVerse.get(root.verse) ?? []).length === 0, "deleted root excluded");
  assert(!idx.byId.has(root.id), "deleted root is excluded from byId (orphan guard source)");
}

// --- orphan reply dropped (root missing or deleted) ---
{
  const reply = mkComment({ parentId: 999999 }); // no such root at all
  const idx = indexComments([reply]);
  const allThreads = [...idx.threadsByVerse.values(), ...idx.threadsByRow.values()].flat();
  assert(allThreads.every((t) => t.replies.every((r) => r.id !== reply.id)), "reply with missing root is dropped, not surfaced as a root either");
}
{
  const deletedRoot = mkComment({ deletedAt: 100 });
  const reply = mkComment({ parentId: deletedRoot.id });
  const idx = indexComments([deletedRoot, reply]);
  const allThreads = [...idx.threadsByVerse.values(), ...idx.threadsByRow.values()].flat();
  assert(allThreads.length === 0, "orphan reply (deleted root) produces no threads at all");
}

// --- sort order by createdAt (threads within a bucket) ---
{
  const rootA = mkComment({ createdAt: 5 });
  const rootB = mkComment({ createdAt: 2 });
  const rootC = mkComment({ createdAt: 8 });
  const idx = indexComments([rootA, rootB, rootC]);
  const threads = idx.threadsByVerse.get(rootA.verse);
  assert(threads.map((t) => t.root.id).join(",") === [rootB.id, rootA.id, rootC.id].join(","), "threads sorted by root.createdAt ascending");
}

// --- countThreads ---
{
  const openQuestion = { root: mkComment({ kind: "question", resolvedAt: null }), replies: [] };
  const resolvedQuestion = { root: mkComment({ kind: "question", resolvedAt: 100 }), replies: [] };
  const note = { root: mkComment({ kind: "note", resolvedAt: null }), replies: [] };
  const resolvedNote = { root: mkComment({ kind: "note", resolvedAt: 100 }), replies: [] };

  assert(JSON.stringify(countThreads([openQuestion])) === JSON.stringify({ openQuestions: 1, notes: 0, total: 1 }), "open question counts");
  assert(JSON.stringify(countThreads([resolvedQuestion])) === JSON.stringify({ openQuestions: 0, notes: 0, total: 0 }), "resolved question doesn't count");
  assert(JSON.stringify(countThreads([note])) === JSON.stringify({ openQuestions: 0, notes: 1, total: 1 }), "open note counts");
  assert(JSON.stringify(countThreads([resolvedNote])) === JSON.stringify({ openQuestions: 0, notes: 0, total: 0 }), "resolved note doesn't count (archived)");
  assert(JSON.stringify(countThreads([openQuestion, note, resolvedQuestion, resolvedNote])) === JSON.stringify({ openQuestions: 1, notes: 1, total: 2 }), "mixed set counts only unresolved roots");
  assert(JSON.stringify(countThreads([])) === JSON.stringify({ openQuestions: 0, notes: 0, total: 0 }), "empty array");
  assert(JSON.stringify(countThreads(undefined)) === JSON.stringify({ openQuestions: 0, notes: 0, total: 0 }), "undefined input");
}

// --- orphaned row comments float to the verse (#818) ---
{
  // No liveRows passed: orphan detection is off, exactly like every test above.
  const root = mkComment({ verse: 5, rowKind: "tq", rowId: "gone" });
  const idx = indexComments([root]);
  assert(idx.threadsByRow.get("tq:gone")?.length === 1, "without liveRows, row-anchored root indexes under its own id regardless of liveness");
}
{
  const live = mkComment({ verse: 5, rowKind: "tq", rowId: "live1" });
  const dead = mkComment({ verse: 5, rowKind: "tq", rowId: "deleted1" });
  const idx = indexComments([live, dead], { rowIds: new Set(["tq:live1"]), introRowId: null });
  assert(idx.threadsByRow.get("tq:live1")?.length === 1, "live row-anchored root still indexes under its rowId");
  assert(!idx.threadsByRow.has("tq:deleted1"), "dead row-anchored root does not index under its stale rowId");
  const floated = idx.threadsByVerse.get(5) ?? [];
  assert(floated.length === 1 && floated[0].root.id === dead.id, "dead row-anchored root floats to its verse instead");
  assert(floated[0].orphaned === true, "floated thread is flagged orphaned");
}
{
  const live = mkComment({ verse: 5, rowKind: "tq", rowId: "live1" });
  const idx = indexComments([live], { rowIds: new Set(["tq:live1"]), introRowId: null });
  const thread = idx.threadsByRow.get("tq:live1")[0];
  assert(!thread.orphaned, "a live row-anchored thread is not flagged orphaned");
}

// --- chapter intro comments redirect to the current intro row (#818) ---
{
  // Comment was created against an intro row that has since been replaced.
  const stale = mkComment({ verse: 0, rowKind: "tn", rowId: "intro-old" });
  const idx = indexComments([stale], { rowIds: new Set(["tn:intro-new"]), introRowId: "intro-new" });
  assert(idx.threadsByRow.get("tn:intro-new")?.[0]?.root.id === stale.id, "stale intro comment lands under the CURRENT intro row's id");
  assert(!idx.threadsByRow.has("tn:intro-old"), "stale intro comment does not index under its original (deleted) rowId");
  assert((idx.threadsByVerse.get(0) ?? []).length === 0, "redirected intro comment is not also floated to verse 0");
}
{
  // Comment created against the still-current intro row: no change in behavior.
  const current = mkComment({ verse: 0, rowKind: "tn", rowId: "intro-new" });
  const idx = indexComments([current], { rowIds: new Set(["tn:intro-new"]), introRowId: "intro-new" });
  assert(idx.threadsByRow.get("tn:intro-new")?.[0]?.root.id === current.id, "current intro comment still lands under the intro row's id");
}
{
  // No intro row exists right now at all: falls back to the orphan path
  // (floats to verse 0) rather than disappearing.
  const stale = mkComment({ verse: 0, rowKind: "tn", rowId: "intro-old" });
  const idx = indexComments([stale], { rowIds: new Set(), introRowId: null });
  const floated = idx.threadsByVerse.get(0) ?? [];
  assert(floated.length === 1 && floated[0].root.id === stale.id, "intro comment with no current intro row floats to verse 0");
  assert(floated[0].orphaned === true, "floated intro comment is flagged orphaned");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll commentsIndex smoke checks passed.");

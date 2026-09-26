import assert from "node:assert/strict";
import { createDraftSnapshot, dedupeByKeys } from "./draftSnapshot.ts";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const record = (key, text, updatedAt = 1) => ({ key, updatedAt, payload: { plainText: text } });

// A whole chapter mounting shares one recovery read. Unmounted editors must
// not receive a late hydration callback.
{
  const hydration = deferred();
  let reads = 0;
  const cache = createDraftSnapshot(() => { reads++; return hydration.promise; }, async () => undefined);
  const seen = [];
  for (let i = 0; i < 72; i++) cache.subscribeKey(`verse-${i}`, (r) => seen.push(r));
  let unmountedCalls = 0;
  cache.subscribe(() => unmountedCalls++)();
  hydration.resolve([record("verse-1", "recovered")]);
  await turn();
  assert.equal(reads, 1);
  assert.equal(seen.length, 72);
  assert.equal(seen[1].payload.plainText, "recovered");
  assert.equal(unmountedCalls, 0);
}

// New typing committed while recovery is still loading wins in the final
// view; refreshing it does not reread all other draft bodies.
{
  const hydration = deferred();
  let persisted = record("a", "new typing");
  let allReads = 0;
  const cache = createDraftSnapshot(() => { allReads++; return hydration.promise; }, async () => persisted);
  const seen = [];
  cache.subscribeKey("a", (r) => seen.push(r?.payload.plainText));
  const typing = cache.refresh("a");
  hydration.resolve([record("a", "old recovered draft")]);
  await typing;
  assert.equal(seen.at(-1), "new typing");
  for (let i = 0; i < 20; i++) {
    persisted = record("a", `typed ${i}`);
    await cache.refresh("a");
  }
  assert.equal(allReads, 1);
  assert.equal(seen.at(-1), "typed 19");
  assert.ok(!seen.includes("old recovered draft"), "never expose stale recovery while a committed edit is pending");
}

// A first-ever keystroke commits before the empty initial recovery resolves.
// Even while the key read is delayed, absence must never clear editor dirty.
{
  const hydration = deferred();
  const committed = deferred();
  const cache = createDraftSnapshot(() => hydration.promise, () => committed.promise);
  const seen = [];
  const lists = [];
  cache.subscribeKey("new", (r) => seen.push(r));
  cache.subscribe((all) => lists.push(all));
  const refresh = cache.refresh("new");
  hydration.resolve([]);
  await turn();
  assert.deepEqual(seen, []);
  assert.deepEqual(lists, []);
  committed.resolve(record("new", "first keystroke"));
  await refresh;
  await turn();
  assert.ok(seen.length > 0 && seen.every((r) => r?.payload.plainText === "first keystroke"));
  assert.ok(lists.length > 0 && lists.every((all) => all.length === 1));
}

// A delayed read from an older save/clear notification cannot erase newer
// typing. This is also the cross-tab case: notifications carry only the key,
// and the current persisted record supplies the content.
{
  const reads = [];
  const cache = createDraftSnapshot(async () => [], () => {
    const read = deferred(); reads.push(read); return read.promise;
  });
  const seen = [];
  let unrelatedCalls = 0;
  cache.subscribeKey("a", (r) => seen.push(r?.payload.plainText));
  cache.subscribeKey("b", () => unrelatedCalls++);
  await turn();
  const oldClear = cache.refresh("a");
  await turn();
  const newTyping = cache.refresh("a");
  await turn();
  reads[1].resolve(record("a", "new generation"));
  await newTyping;
  reads[0].resolve(undefined);
  await oldClear;
  assert.equal(seen.at(-1), "new generation");
  assert.equal(unrelatedCalls, 1);
  const clear = cache.refresh("a");
  await turn();
  reads[2].resolve(undefined);
  await clear;
  assert.equal(seen.at(-1), undefined);
}

// Dirty is synchronous, persistence is asynchronous. First hydration must
// also wait when set() has started but its IndexedDB commit has not finished.
{
  const cache = createDraftSnapshot(async () => [], async () => record("a", "persisted typing"));
  const release = cache.beginMutation("a");
  const seen = [];
  cache.subscribeKey("a", (r) => seen.push(r));
  await turn();
  assert.deepEqual(seen, []);
  const refresh = cache.refresh("a");
  release();
  await refresh;
  await turn();
  assert.ok(seen.length > 0 && seen.every((r) => r?.payload.plainText === "persisted typing"));
}

// Save/reminder lists retain chronological order after updates and deletions.
{
  const persisted = new Map([["a", record("a", "first", 1)], ["b", record("b", "second", 2)]]);
  const cache = createDraftSnapshot(async () => [...persisted.values()], async (key) => persisted.get(key));
  let seen;
  cache.subscribe((all) => { seen = all; });
  await turn();
  assert.deepEqual(seen.map((r) => r.key), ["a", "b"]);
  persisted.set("a", record("a", "newer", 3));
  await cache.refresh("a");
  assert.deepEqual(seen.map((r) => r.key), ["b", "a"]);
  persisted.delete("b");
  await cache.refresh("b");
  assert.deepEqual(seen.map((r) => r.key), ["a"]);
}
// Persistence has succeeded but notification reads can fail independently.
// That failure must not publish empty recovery and clear the editor's dirty
// flag, nor leave an unhandled rejection from subscription initialization.
{
  let fail = true;
  const cache = createDraftSnapshot(async () => [], async () => {
    if (fail) throw new Error("notification read failed");
    return record("a", "durable typing");
  });
  const release = cache.beginMutation("a");
  const seen = [];
  const lists = [];
  cache.subscribeKey("a", (r) => seen.push(r));
  cache.subscribe((all) => lists.push(all));
  const failed = cache.refresh("a");
  release();
  await assert.rejects(failed, /notification read failed/);
  await turn();
  assert.deepEqual(seen, []);
  assert.deepEqual(lists, []);
  const later = [];
  cache.subscribeKey("a", (r) => later.push(r));
  await turn();
  assert.deepEqual(later, [], "failed refresh leaves cache unknown, not absent");
  fail = false;
  await cache.refresh("a");
  await turn();
  assert.equal(seen.at(-1)?.payload.plainText, "durable typing");
  assert.equal(later.at(-1)?.payload.plainText, "durable typing");
  assert.equal(lists.at(-1).length, 1);
}
// A recorded failure for one key must not freeze the whole-list view when a
// different key refreshes successfully afterward, and must not make the
// failed key itself publish absence.
{
  const persisted = new Map([["b", record("b", "b typing")]]);
  const cache = createDraftSnapshot(async () => [], async (key) => {
    if (key === "a") throw new Error("key a read failed");
    return persisted.get(key);
  });
  const seenA = [];
  const lists = [];
  cache.subscribeKey("a", (r) => seenA.push(r));
  cache.subscribe((all) => lists.push(all));
  await turn();
  seenA.length = 0;
  lists.length = 0;
  await assert.rejects(cache.refresh("a"), /key a read failed/);
  await turn();
  assert.deepEqual(seenA, [], "a failed key must stay silent, not publish absence");
  assert.deepEqual(lists, [], "a's own failed refresh alone must not notify the whole list");
  const seenB = [];
  cache.subscribeKey("b", (r) => seenB.push(r));
  await cache.refresh("b");
  await turn();
  assert.equal(seenB.at(-1)?.payload.plainText, "b typing", "refresh(b) must still deliver to subscribeKey(b)");
  assert.ok(
    lists.length > 0 && lists.at(-1).some((r) => r.key === "b"),
    "refresh(b) must still deliver to the whole-list subscriber despite a's recorded failure",
  );
  assert.deepEqual(seenA, [], "a must still stay silent after an unrelated key's successful refresh");
}

// dedupeByKeys: a whole-list "presence" subscriber (SyncStatusBar,
// UnsavedToasts) must not be notified when a keystroke replaces a record's
// payload/updatedAt without changing which keys exist, but must still see
// an actual add/remove, and must not care about member order.
{
  let fn;
  const fakeSubscribe = (f) => { fn = f; return () => { fn = undefined; }; };
  const wrapped = dedupeByKeys(fakeSubscribe);
  const calls = [];
  const unsubscribe = wrapped((all) => calls.push(all));
  assert.equal(calls.length, 0, "wrapping does not itself call the underlying subscribe");

  fn([record("a", "first", 1)]);
  assert.equal(calls.length, 1, "first notification always passes through");

  fn([record("a", "second keystroke", 2)]);
  assert.equal(calls.length, 1, "same key set (even reordered by updatedAt) is suppressed");

  fn([record("a", "third", 3), record("b", "new draft", 4)]);
  assert.equal(calls.length, 2, "a key being added must still notify");

  fn([record("b", "b typing", 5), record("a", "a typing", 6)]);
  assert.equal(calls.length, 2, "same key set in a different order is still suppressed");

  fn([record("b", "only b left", 5)]);
  assert.equal(calls.length, 3, "a key being removed must still notify");

  unsubscribe();
  assert.equal(fn, undefined, "unsubscribing tears down the underlying subscription");
}
console.log("draftSnapshot: hydration, typing, save/clear ordering, read failures, targeted notifications and key-set dedup passed");

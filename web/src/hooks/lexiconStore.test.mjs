// Tests for lexiconStore.ts, the store behind useLexicon. Run from web/:
//   node --experimental-strip-types --no-warnings src/hooks/lexiconStore.test.mjs
//
// WHY (#898). useLexicon used to build a new Map on every render. Memoizing it
// on a version that only a subscriber callback bumps (PR #940) lost updates:
// a second consumer (AlignmentPanel) that rendered while Shell's fetch was in
// flight, but subscribed after it resolved, called ensure(), found every key
// cached, got no notification, and kept a Map of nulls. The store now keeps a
// module version that useLexicon reads through useSyncExternalStore, which
// compares the version seen at render with getVersion() after subscribing.
// The (regression) case below encodes that contract.

import assert from "node:assert/strict";
import { createLexiconStore, normalizeStrong } from "./lexiconStore.ts";

const entry = (strong, gloss) => ({
  strong,
  resource: "uhal",
  lemma: null,
  part_of_speech: null,
  gloss,
  definition: null,
});

// Fake network + IndexedDB. Each fetch is held until the test resolves it.
function harness({ idb = new Map() } = {}) {
  const fetches = [];
  const puts = [];
  const store = createLexiconStore({
    fetchEntries: (strongs) =>
      new Promise((resolve, reject) => fetches.push({ strongs, resolve, reject })),
    getCached: async (strongs) => {
      const out = new Map();
      for (const k of strongs) if (idb.has(k)) out.set(k, idb.get(k));
      return out;
    },
    putCached: async (map) => {
      puts.push(new Map(map));
    },
  });
  return { store, fetches, puts };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await test("normalizeStrong strips prefixes, zero padding and adds the base fallback", () => {
  assert.deepEqual(normalizeStrong("b:H02320"), ["H2320"]);
  assert.deepEqual(normalizeStrong("H2148a"), ["H2148A", "H2148"]);
  assert.deepEqual(normalizeStrong("nothing"), []);
});

await test("(regression) a consumer that subscribes after the fetch resolved still sees a new version", async () => {
  const { store, fetches } = harness();
  // Shell's effect starts the fetch.
  const shellEnsure = store.ensure(["H1234"]);
  await tick();
  assert.equal(fetches.length, 1);

  // AlignmentPanel renders now: its snapshot is the pre-resolution version,
  // and its Map has a null gloss.
  const versionAtRender = store.getVersion();
  assert.equal(store.lookup(["H1234"]).get("H1234"), null);

  // Shell's fetch resolves before AlignmentPanel's effect runs.
  fetches[0].resolve([entry("H1234", "word")]);
  await shellEnsure;

  // AlignmentPanel's effect: ensure() has nothing to do and notifies nobody.
  let notified = 0;
  const unsubscribe = store.subscribe(() => notified++);
  await store.ensure(["H1234"]);
  assert.equal(fetches.length, 1, "no second fetch for a cached key");
  assert.equal(notified, 0, "ensure() on cached keys does not notify");

  // useSyncExternalStore re-renders because the version moved, and the new
  // Map carries the gloss.
  assert.notEqual(store.getVersion(), versionAtRender);
  assert.equal(store.lookup(["H1234"]).get("H1234")?.gloss, "word");
  unsubscribe();
});

await test("version is unchanged when nothing resolves, so the memoized Map keeps its identity", async () => {
  const { store, fetches } = harness();
  const v0 = store.getVersion();
  await store.ensure([]);
  await store.ensure(["not-a-strong"]);
  assert.equal(fetches.length, 0);
  assert.equal(store.getVersion(), v0);
});

await test("a resolved fetch bumps the version once and notifies subscribers", async () => {
  const { store, fetches, puts } = harness();
  let notified = 0;
  store.subscribe(() => notified++);
  const v0 = store.getVersion();
  const p = store.ensure(["H1", "H2"]);
  await tick();
  assert.deepEqual(fetches[0].strongs, ["H1", "H2"]);
  fetches[0].resolve([entry("H1", "one")]);
  await p;
  assert.equal(store.getVersion(), v0 + 1);
  assert.equal(notified, 1);
  const map = store.lookup(["H1", "H2"]);
  assert.equal(map.get("H1")?.gloss, "one");
  assert.equal(map.get("H2"), null);
  // Both the hit and the explicit miss are persisted.
  assert.deepEqual([...puts[0].keys()], ["H1", "H2"]);
  assert.equal(puts[0].get("H2"), null);
});

await test("a failed fetch (non-OK status, timeout) caches nothing and a later call retries", async () => {
  const { store, fetches, puts } = harness();
  const v0 = store.getVersion();
  const p = store.ensure(["H9"]);
  await tick();
  fetches[0].reject(new Error("HTTP 500"));
  await p;
  assert.equal(puts.length, 0, "nothing written to IndexedDB");
  assert.equal(store.getVersion(), v0);

  const retry = store.ensure(["H9"]);
  await tick();
  assert.equal(fetches.length, 2, "the key is fetched again");
  fetches[1].resolve([entry("H9", "nine")]);
  await retry;
  assert.equal(store.lookup(["H9"]).get("H9")?.gloss, "nine");
});

await test("IndexedDB hits skip the network and bump the version", async () => {
  const idb = new Map([["H7", entry("H7", "seven")]]);
  const { store, fetches } = harness({ idb });
  const v0 = store.getVersion();
  await store.ensure(["H7"]);
  assert.equal(fetches.length, 0);
  assert.equal(store.getVersion(), v0 + 1);
  assert.equal(store.lookup(["H7"]).get("H7")?.gloss, "seven");
});

await test("an exact-form hit wins over the base fallback", async () => {
  const idb = new Map([
    ["H2148A", entry("H2148A", "exact")],
    ["H2148", entry("H2148", "base")],
  ]);
  const { store } = harness({ idb });
  await store.ensure(["H2148a"]);
  assert.equal(store.lookup(["H2148a"]).get("H2148a")?.gloss, "exact");
});

console.log(`\n${passed} passed`);

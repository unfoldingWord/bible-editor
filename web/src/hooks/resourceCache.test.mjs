import assert from "node:assert/strict";
import { createResourceCache } from "./resourceCache.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Within the TTL, a burst of load() calls (simulating a burst of consumer
// mounts) shares one fetch instead of issuing one per caller — the #886
// regression this cache exists to fix.
{
  let now = 1000;
  let fetches = 0;
  let written = null;
  const cache = createResourceCache({
    fetcher: () => {
      fetches++;
      return Promise.resolve({ v: fetches });
    },
    read: () => null,
    write: (v) => {
      written = v;
    },
    ttlMs: 10_000,
    now: () => now,
  });

  const [a, b, c] = [cache.load(), cache.load(), cache.load()];
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(fetches, 1, "concurrent load() calls must share one in-flight fetch");
  assert.deepEqual(ra, { v: 1 });
  assert.equal(ra, rb, "resolved values share identity");
  assert.equal(rb, rc);
  assert.deepEqual(written, { v: 1 });

  now += 5000; // still inside the 10s TTL
  const within = await cache.load();
  assert.equal(fetches, 1, "a load() within the TTL must not refetch");
  assert.equal(within, ra, "cached value keeps its reference within the TTL");

  now += 6000; // past the TTL (11s since the first fetch)
  const after = await cache.load();
  assert.equal(fetches, 2, "a load() past the TTL must refetch");
  assert.deepEqual(after, { v: 2 });
  console.log("resourceCache: TTL sharing and expiry passed");
}

// A revalidation that comes back byte-identical to the cached value must not
// rewrite storage or notify subscribers — that's the re-render wave #886
// flagged (every mounted NoteCard/WordRow bypassing memoization because hook
// state changed even though nothing did).
{
  let now = 0;
  let writes = 0;
  let notifies = 0;
  const cache = createResourceCache({
    fetcher: () => Promise.resolve({ supportReferences: ["a"], twLinks: ["b"] }),
    read: () => null,
    write: () => {
      writes++;
    },
    ttlMs: 1, // expires almost immediately so the second load() refetches
    now: () => now,
  });

  const first = await cache.load();
  assert.equal(writes, 1);

  cache.subscribe(() => {
    notifies++;
  });

  now += 100; // past the 1ms TTL
  const second = await cache.load();
  assert.deepEqual(second, first);
  assert.equal(second, first, "an unchanged refresh keeps the old reference");
  assert.equal(writes, 1, "an unchanged refresh must not rewrite storage");
  assert.equal(notifies, 0, "an unchanged refresh must not notify subscribers");
  console.log("resourceCache: unchanged-refresh dedupe passed");
}

// A changed refresh still updates the reference, writes storage once, and
// notifies every subscriber exactly once.
{
  let now = 0;
  let n = 0;
  const cache = createResourceCache({
    fetcher: () => Promise.resolve({ n: ++n }),
    read: () => null,
    write: () => {},
    ttlMs: 1,
    now: () => now,
  });
  const seen = [];
  await cache.load();
  cache.subscribe((v) => seen.push(v));
  now += 100;
  const next = await cache.load();
  assert.deepEqual(next, { n: 2 });
  assert.deepEqual(seen, [{ n: 2 }]);
  console.log("resourceCache: changed-refresh notify passed");
}

// A rejected fetch is not cached — the next load() must retry, not return a
// stuck rejection or an empty value for the rest of the session.
{
  let now = 0;
  let attempt = 0;
  const cache = createResourceCache({
    fetcher: () => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error("network")) : Promise.resolve({ ok: true });
    },
    read: () => null,
    write: () => {},
    ttlMs: 10_000,
    now: () => now,
  });
  await assert.rejects(cache.load(), /network/);
  const retried = await cache.load();
  assert.deepEqual(retried, { ok: true });
  assert.equal(attempt, 2, "a failed fetch must not be cached against retry");
  console.log("resourceCache: failed fetch is not cached passed");
}

// unsubscribe() actually detaches — a torn-down consumer must not keep being
// notified.
{
  let now = 0;
  let n = 0;
  const cache = createResourceCache({
    fetcher: () => Promise.resolve({ n: ++n }),
    read: () => null,
    write: () => {},
    ttlMs: 1,
    now: () => now,
  });
  await cache.load();
  let calls = 0;
  const unsubscribe = cache.subscribe(() => {
    calls++;
  });
  unsubscribe();
  now += 100;
  await cache.load();
  await tick();
  assert.equal(calls, 0, "unsubscribe() must stop further notifications");
  console.log("resourceCache: unsubscribe passed");
}

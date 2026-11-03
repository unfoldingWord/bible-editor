// Tests for t4tLoader.ts (issue #1262): a failed T4T load must not poison the
// per-book cache, so the "Retry" button can fetch again. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/t4tLoader.test.mjs

import { createT4tLoader } from "./t4tLoader.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

{
  let calls = 0;
  let fail = true;
  const load = createT4tLoader(
    async (book) => {
      calls++;
      if (fail) throw new Error("502");
      return `usfm:${book}`;
    },
    (book, text) => new Map([[1, { text }]]),
  );

  let err = null;
  try {
    await load("PSA");
  } catch (e) {
    err = e;
  }
  assert(err && /502/.test(String(err)), "first load rejects with the fetch error");
  assert(calls === 1, "one fetch for the failed load");

  fail = false;
  const got = await load("PSA");
  assert(calls === 2, "retry after a failure fetches again");
  assert(got.get(1).text === "usfm:PSA", "retry returns the parsed book");

  const again = await load("PSA");
  assert(calls === 2 && again === got, "a loaded book is cached");
}

{
  let calls = 0;
  let release;
  const load = createT4tLoader(
    () => {
      calls++;
      return new Promise((r) => (release = r));
    },
    () => new Map(),
  );
  const a = load("ISA");
  const b = load("ISA");
  release("x");
  assert((await a) === (await b) && calls === 1, "concurrent loads share one fetch");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall t4tLoader tests passed");

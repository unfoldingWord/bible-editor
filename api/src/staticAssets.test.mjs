// Regression test for issue #916: a request for a missing hashed chunk under
// /assets/* fell through the Workers Static Assets SPA fallback and came back
// as 200 index.html carrying the /assets/* `immutable` header from _headers,
// so browsers and edge caches could pin HTML under a .js URL for a year.
// serveHashedAsset turns that fallback into an uncacheable 404 and leaves
// real asset responses untouched.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/staticAssets.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors auth.test.mjs.

import { serveHashedAsset } from "./staticAssets.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const IMMUTABLE = "public, max-age=31536000, immutable";

// Stub ASSETS binding: returns the given response and records the request.
function stubAssets(res) {
  const seen = [];
  return {
    seen,
    fetch: async (req) => {
      seen.push(req);
      return res;
    },
  };
}

console.log("SPA fallback (text/html) under /assets/* becomes an uncacheable 404");
{
  const assets = stubAssets(
    new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": IMMUTABLE },
    }),
  );
  const res = await serveHashedAsset(new Request("https://x/assets/does-not-exist.js"), assets);
  assert(res.status === 404, `status 404 (got ${res.status})`);
  assert(res.headers.get("Cache-Control") === "no-store", `Cache-Control no-store (got ${res.headers.get("Cache-Control")})`);
  assert(assets.seen.length === 1, "delegated to ASSETS once");
}

console.log("the text/html match ignores media-type case");
{
  const assets = stubAssets(
    new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "Text/HTML", "Cache-Control": IMMUTABLE } }),
  );
  const res = await serveHashedAsset(new Request("https://x/assets/gone.js"), assets);
  assert(res.status === 404, `status 404 (got ${res.status})`);
}

console.log("a real hashed asset passes through unchanged");
{
  const original = new Response("export{}", {
    status: 200,
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": IMMUTABLE, ETag: '"abc"' },
  });
  const assets = stubAssets(original);
  const res = await serveHashedAsset(new Request("https://x/assets/BookView-abc123.js"), assets);
  assert(res === original, "same Response object returned");
  assert(res.headers.get("Cache-Control") === IMMUTABLE, "immutable header preserved");
}

console.log("a 304 revalidation of a real asset passes through");
{
  const original = new Response(null, { status: 304, headers: { ETag: '"abc"' } });
  const res = await serveHashedAsset(new Request("https://x/assets/a.js"), stubAssets(original));
  assert(res === original, "304 returned unchanged");
}

console.log("no ASSETS binding still yields an uncacheable 404");
{
  const res = await serveHashedAsset(new Request("https://x/assets/a.js"), undefined);
  assert(res.status === 404, `status 404 (got ${res.status})`);
  assert(res.headers.get("Cache-Control") === "no-store", "Cache-Control no-store");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall staticAssets tests passed");

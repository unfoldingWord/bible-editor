// Smoke test for relativeTime.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/relativeTime.test.mjs

import { relativeTime } from "./relativeTime.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const NOW_MS = 1700000000000;
const NOW_SEC = NOW_MS / 1000;

// --- "just now" bucket (< 60s) ---
assert(relativeTime(NOW_SEC, NOW_MS) === "just now", "0s ago is just now");
assert(relativeTime(NOW_SEC - 44, NOW_MS) === "just now", "44s ago is just now");
assert(relativeTime(NOW_SEC - 45, NOW_MS) === "just now", "45s ago is just now");
assert(relativeTime(NOW_SEC - 59, NOW_MS) === "just now", "59s ago is just now");

// --- minutes bucket (60s <= diff < 60min) ---
assert(relativeTime(NOW_SEC - 60, NOW_MS) === "1m ago", "60s ago rolls to 1m ago");
assert(relativeTime(NOW_SEC - 5 * 60, NOW_MS) === "5m ago", "5 minutes ago");
assert(relativeTime(NOW_SEC - 59 * 60, NOW_MS) === "59m ago", "59 minutes ago stays in minutes bucket");

// --- hours bucket (60min <= diff < 24h) ---
assert(relativeTime(NOW_SEC - 60 * 60, NOW_MS) === "1h ago", "60 minutes ago rolls to 1h ago");
assert(relativeTime(NOW_SEC - 3 * 60 * 60, NOW_MS) === "3h ago", "3 hours ago");
assert(relativeTime(NOW_SEC - 23 * 60 * 60, NOW_MS) === "23h ago", "23 hours ago stays in hours bucket");

// --- days bucket (24h <= diff <= 30d) ---
assert(relativeTime(NOW_SEC - 24 * 60 * 60, NOW_MS) === "1d ago", "24 hours ago rolls to 1d ago");
assert(relativeTime(NOW_SEC - 2 * 24 * 60 * 60, NOW_MS) === "2d ago", "2 days ago");
assert(relativeTime(NOW_SEC - 30 * 24 * 60 * 60, NOW_MS) === "30d ago", "30 days ago stays in days bucket");

// --- absolute date fallback (> 30d) ---
{
  const unixSeconds = NOW_SEC - 31 * 24 * 60 * 60;
  const expected = new Date(unixSeconds * 1000).toLocaleDateString();
  assert(relativeTime(unixSeconds, NOW_MS) === expected, "31 days ago falls back to absolute date");
}

// --- injectable nowMs defaults to Date.now() when omitted ---
{
  const result = relativeTime(Math.floor(Date.now() / 1000));
  assert(result === "just now", "omitted nowMs defaults to real Date.now()");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll relativeTime smoke checks passed.");

// Unit tests for fetchText and fetchDcsMasterText (dcsSources.ts) — the
// truncated-fetch transport guards. Stubs global fetch with crafted
// responses. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsSources.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { dcsFileSize, fetchDcsMasterText, fetchText } from "./dcsSources.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// A minimal Response stand-in with full control over the content-length header.
function res({ ok = true, body = "", contentLength = undefined }) {
  return {
    ok,
    headers: {
      get: (k) => (k.toLowerCase() === "content-length" ? (contentLength ?? null) : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

// A minimal JSON Response stand-in for the Gitea contents API (used by
// dcsFileSize / fetchDcsMasterText).
function jsonRes({ ok = true, body = {} }) {
  return {
    ok,
    headers: { get: () => null },
    json: async () => body,
  };
}

const env = { DCS_BASE_URL: "https://example.test" };

// Queue responses; each fetch() call shifts the next one.
let queue = [];
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (queue.length === 0) throw new Error("fetch called more times than queued");
  return queue.shift();
};

// Silence the expected console.error/warn noise so the test output stays clean.
const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

async function run() {
  // 1. Body matches declared content-length → returned as-is.
  queue = [res({ body: "hello world", contentLength: "11" })];
  calls = 0;
  assert((await fetchText("u")) === "hello world", "exact content-length → body returned");
  assert(calls === 1, "  ...single fetch, no retry");

  // 2. Body shorter than declared content-length → truncated → retry, second
  //    attempt is complete → returns the complete body.
  queue = [
    res({ body: "partial", contentLength: "999" }), // truncated
    res({ body: "the whole file", contentLength: "14" }), // complete
  ];
  calls = 0;
  assert((await fetchText("u")) === "the whole file", "short-vs-declared → retry yields complete body");
  assert(calls === 2, "  ...retried exactly once");

  // 3. Truncated on BOTH attempts → null (never accept a partial body).
  queue = [
    res({ body: "partial", contentLength: "999" }),
    res({ body: "still partial", contentLength: "999" }),
  ];
  calls = 0;
  assert((await fetchText("u")) === null, "short on both attempts → null");
  assert(calls === 2, "  ...two attempts then give up");

  // 4. No content-length at all (the HAB blind spot) → body is returned (the
  //    transport layer can't verify completeness; the reimport row-count gate
  //    is the backstop). The point of this case: a missing header is NOT, by
  //    itself, treated as a transport failure — so we don't break every file
  //    served without content-length.
  queue = [res({ body: "no-length body", contentLength: undefined })];
  calls = 0;
  assert((await fetchText("u")) === "no-length body", "missing content-length → body still returned");
  assert(calls === 1, "  ...no retry on missing content-length alone");

  // 5. Non-OK response → null immediately.
  queue = [res({ ok: false, body: "404", contentLength: "3" })];
  calls = 0;
  assert((await fetchText("u")) === null, "non-ok response → null");
  assert(calls === 1, "  ...no retry on non-ok");

  // 6. Longer-than-declared body (transparent gzip decode) → accepted, NOT
  //    treated as truncation.
  queue = [res({ body: "decoded is longer", contentLength: "5" })];
  calls = 0;
  assert((await fetchText("u")) === "decoded is longer", "longer-than-declared → accepted (gzip case)");

  // ── dcsFileSize ──────────────────────────────────────────────────────────

  // 7. Contents API reports a numeric size → returned as-is.
  queue = [jsonRes({ body: { size: 547000 } })];
  calls = 0;
  assert((await dcsFileSize(env, "en_twl", "twl_PSA.tsv")) === 547000, "dcsFileSize: numeric size returned");
  assert(calls === 1, "  ...single fetch");

  // 8. Contents API 404 → null.
  queue = [jsonRes({ ok: false, body: {} })];
  assert((await dcsFileSize(env, "en_twl", "twl_PSA.tsv")) === null, "dcsFileSize: non-ok → null");

  // 9. Contents API body missing a `size` field → null (never fabricate one).
  queue = [jsonRes({ body: {} })];
  assert((await dcsFileSize(env, "en_twl", "twl_PSA.tsv")) === null, "dcsFileSize: missing size field → null");

  // 10. Network error → null.
  queue = [];
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  assert((await dcsFileSize(env, "en_twl", "twl_PSA.tsv")) === null, "dcsFileSize: network error → null");
  globalThis.fetch = async () => {
    calls++;
    if (queue.length === 0) throw new Error("fetch called more times than queued");
    return queue.shift();
  };

  // ── fetchDcsMasterText — issue #494 regression ──────────────────────────
  // The defect: a no-Content-Length truncated master fetch used to be
  // accepted as a legitimately smaller master (fetchText has no way to catch
  // it). fetchDcsMasterText must catch it via the independent Gitea
  // contents-API size instead.

  // 11. THE ISSUE #494 CASE: no Content-Length on the raw fetch (the HAB
  //     shape) + a body far shorter than the contents API's recorded size on
  //     the first attempt, complete on the retry → retried, then returns the
  //     complete body. Before this fix there was no way to detect this at
  //     all; the short body would have been accepted outright.
  queue = [
    jsonRes({ body: { size: 20 } }), // contents API: file is 20 bytes on master
    res({ body: "short", contentLength: undefined }), // raw fetch #1: truncated, no Content-Length
    res({ body: "the complete master body", contentLength: undefined }), // raw fetch #2: complete (25 bytes)
  ];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv")) === "the complete master body",
    "fetchDcsMasterText: no-CL short read vs contents-API size → retried → complete body",
  );
  assert(calls === 3, "  ...one contents-API call + two raw fetches");

  // 12. Same shape, but truncated on BOTH raw attempts → null (fails closed
  //     — the caller (checkTsvShrink / checkUsfmAlignmentShrink) treats null
  //     as master_unreadable and blocks the export, exactly like a network
  //     failure would).
  queue = [
    jsonRes({ body: { size: 20 } }),
    res({ body: "short", contentLength: undefined }),
    res({ body: "short", contentLength: undefined }),
  ];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv")) === null,
    "fetchDcsMasterText: no-CL short read on both attempts vs contents-API size → null (master_unreadable)",
  );
  assert(calls === 3, "  ...gives up after the retry");

  // 13. Complete body, no Content-Length, contents API agrees → accepted in
  //     one raw fetch (no false-positive retry when the body is actually
  //     whole).
  queue = [
    jsonRes({ body: { size: 11 } }), // "hello world" is 11 bytes
    res({ body: "hello world", contentLength: undefined }),
  ];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv")) === "hello world",
    "fetchDcsMasterText: no-CL complete body matching contents-API size → accepted, no retry",
  );
  assert(calls === 2, "  ...one contents-API call + one raw fetch, no retry");

  // 14. Content-Length present and correct, contents API unreachable (null)
  //     → falls back to the Content-Length-only check, same as fetchText.
  //     Confirms the new check never turns a healthy fetch into a false
  //     block when the API happens to be unavailable.
  queue = [jsonRes({ ok: false, body: {} }), res({ body: "hello world", contentLength: "11" })];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv")) === "hello world",
    "fetchDcsMasterText: contents-API unavailable, Content-Length correct → still accepted",
  );

  // 15. Both Content-Length AND contents-API size unavailable → body is
  //     still returned (matches fetchText's documented blind spot when
  //     NEITHER independent signal exists — nothing left to check against).
  queue = [jsonRes({ ok: false, body: {} }), res({ body: "unverifiable body", contentLength: undefined })];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv")) === "unverifiable body",
    "fetchDcsMasterText: neither Content-Length nor contents-API size available → body still returned",
  );

  // 16. Non-ok raw response → null immediately (contents API call still
  //     happens first, but a 404 on the raw endpoint is still a 404).
  queue = [jsonRes({ body: { size: 11 } }), res({ ok: false, body: "404" })];
  calls = 0;
  assert((await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv")) === null, "fetchDcsMasterText: non-ok raw response → null");
  assert(calls === 2, "  ...no retry on non-ok");

  console.error = origError;
  console.warn = origWarn;
  console.log("dcsSources/fetchText + fetchDcsMasterText: all assertions passed");
}

run().catch((e) => {
  console.error = origError;
  console.error("threw:", e);
  process.exit(1);
});

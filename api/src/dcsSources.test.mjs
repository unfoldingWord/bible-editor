// Unit tests for fetchText and fetchDcsMasterText (dcsSources.ts) — the
// truncated-fetch transport guards. Stubs global fetch with crafted
// responses. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsSources.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { dcsFileSize, fetchDcsMasterText, fetchText, listMasterCommitsSince } from "./dcsSources.ts";

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

  // ── listMasterCommitsSince pagination (issue #540 item 1) ─────────────────
  // Measured against git.door43.org on 2026-08-19: Gitea IGNORES `limit` on the
  // commits endpoint (a 15-commit file returns all 15 for `limit=2`; a
  // 143-commit file returns 50 for `limit=100`) and pages at a fixed 50, but it
  // does send real `X-PageCount` / `X-HasMore` headers. So end-of-history must
  // come from the headers, never from `batch.length < requestedPageSize` — that
  // inference reads a number the server threw away, and with a requested size
  // above 50 it calls page 1 the end of history every time, reporting a
  // `sinceSha` that sits on page 2 as not-in-history forever.
  {
    const commitsRes = (arr, { pageCount = 1, hasMore = undefined, page = 1 } = {}) => ({
      ok: true,
      status: 200,
      headers: {
        get: (k) => {
          const key = k.toLowerCase();
          if (key === "x-pagecount") return String(pageCount);
          if (key === "x-hasmore") return hasMore == null ? null : String(hasMore);
          if (key === "x-page") return String(page);
          return null;
        },
      },
      json: async () => arr,
    });
    const commit = (sha, message, email) => ({
      sha,
      commit: { message, author: { email, name: "x", date: "2026-08-19T00:00:00Z" } },
    });

    // The header-driven multi-page walk: the ancestor sits on page 2, and page 1
    // comes back FULL, so a length-based end-of-history test would still walk on
    // — but a request for more than the server's page size would have stopped.
    {
      const pages = [
        [commit("a", "bible-editor: AMO tq → master (#1)", "b@x"), commit("b", "hand fix", "h@x")],
        [commit("c", "TQ: AMO 1 [q@api.bp-assistant]", "bot@unfoldingword.org"), commit("ancestor", "old", "h@x")],
      ];
      let n = 0;
      globalThis.fetch = async () => commitsRes(pages[n++], { pageCount: 2, page: n });
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "ancestor");
      assert(n === 2, "walks onto page 2 to reach an ancestor the first page did not contain");
      assert(r.incomplete === false, "  ...and completes once the ancestor is seen");
      assert(r.commits.length === 3, "  ...returning every commit above it, exclusive of the ancestor");
      assert(r.commits[0].sha === "a" && r.commits[2].sha === "c", "  ...in newest-first order across pages");
    }

    // A FULL last page (batch.length === whatever the server sends) must still
    // terminate when the headers say it is the last one. Length alone cannot
    // tell — this is exactly the shape the old code got wrong.
    {
      let n = 0;
      globalThis.fetch = async () => {
        n++;
        return commitsRes([commit("a", "hand fix", "h@x"), commit("b", "another", "h@x")], { pageCount: 1 });
      };
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "never-here");
      assert(n === 1, "a full page that the headers call the last one stops the walk");
      assert(r.incomplete === true, "  ...and an ancestor never seen is incomplete");
      assert(r.incompleteReason === "source_sha_not_in_history", "  ...named as not-in-history, not as 'no human edits'");
    }

    // X-HasMore takes precedence when present.
    {
      let n = 0;
      globalThis.fetch = async () => {
        n++;
        return commitsRes([commit(`s${n}`, "hand fix", "h@x")], { pageCount: 99, hasMore: false });
      };
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "never-here");
      assert(n === 1, "X-HasMore:false ends the walk even when X-PageCount claims more");
      assert(r.incompleteReason === "source_sha_not_in_history", "  ...as not-in-history");
    }

    // Neither header present: we cannot tell, so only an EMPTY page stops us —
    // erring toward one wasted fetch rather than a false end-of-history.
    {
      const noHdr = (arr) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => arr });
      const pages = [[commit("a", "hand fix", "h@x")], []];
      let n = 0;
      globalThis.fetch = async () => noHdr(pages[n++] ?? []);
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "never-here");
      assert(n === 2, "with no pagination headers, a short page does NOT end the walk");
      assert(r.incompleteReason === "source_sha_not_in_history", "  ...an empty page does");
    }

    // The budget cap is a separate, separately-named outcome from end-of-history.
    {
      let n = 0;
      globalThis.fetch = async () => {
        n++;
        return commitsRes([commit(`s${n}`, "hand fix", "h@x")], { pageCount: 99 });
      };
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "never-here", { pageLimit: 2 });
      assert(n === 2, "the page budget bounds the walk");
      assert(r.incompleteReason === "page_cap", "  ...and is reported as page_cap, distinct from not-in-history");
      assert(r.commits.length === 2, "  ...while still reporting what it did walk");
    }

    // Every failure is `incomplete`, never a silent empty range — that is the
    // whole safety property, since downstream an incomplete lineage protects
    // master exactly like a human commit.
    {
      globalThis.fetch = async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => [] });
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "x");
      assert(r.incomplete === true && r.incompleteReason === "http_502", "a non-ok response is incomplete, named by status");
    }
    {
      globalThis.fetch = async () => { throw new Error("boom"); };
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "x");
      assert(r.incomplete === true && r.incompleteReason === "fetch_failed", "a thrown fetch is incomplete");
    }
    {
      globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ not: "an array" }) });
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "x");
      assert(r.incomplete === true && r.incompleteReason === "bad_body", "a non-array body is incomplete");
    }
    {
      const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", null);
      assert(r.incomplete === true && r.incompleteReason === "no_source_sha", "no ancestor sha is incomplete without fetching");
    }
  }

  console.log("dcsSources/fetchText + fetchDcsMasterText + listMasterCommitsSince: all assertions passed");
}

run().catch((e) => {
  console.error = origError;
  console.error("threw:", e);
  process.exit(1);
});

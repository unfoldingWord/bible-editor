// Unit tests for fetchText and fetchDcsMasterText (dcsSources.ts) — the
// truncated-fetch transport guards. Stubs global fetch with crafted
// responses. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsSources.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  dcsFileSize,
  dcsRawUrl,
  fetchDcsMasterText,
  fetchDcsMasterTextVerified,
  fetchHumanTouchedRefs,
  fetchText,
  listMasterCommitsSince,
} from "./dcsSources.ts";
import { LINEAGE_REFINE_MAX_HUMAN_COMMITS } from "./masterLineage.ts";

// A realistic-shaped full commit SHA (40 hex chars) — the only kind of `ref`
// isPinnedCommitSha() (dcsSources.ts) accepts as proof of a single immutable
// revision. Used below to distinguish "pinned" calls from the "master"
// default.
const PINNED_SHA = "1234567890abcdef1234567890abcdef12345678";

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
  //     the first attempt, complete (and EXACTLY matching apiSize — the round
  //     4 fix compares by exact equality, not >=) on the retry → retried,
  //     then returns the complete body. Before this fix there was no way to
  //     detect this at all; the short body would have been accepted outright.
  queue = [
    jsonRes({ body: { size: 24 } }), // contents API: file is 24 bytes on master
    res({ body: "short", contentLength: undefined }), // raw fetch #1: truncated, no Content-Length
    res({ body: "the complete master body", contentLength: undefined }), // raw fetch #2: complete, exactly 24 bytes
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

  // ── fetchDcsMasterTextVerified — issue #485 final P1 follow-up ─────────
  // The defect this closes: an EARLIER version of the reimport's own
  // fetchTsvMasterVerified wrapper (bookReimport.ts) made its own SEPARATE
  // dcsFileSize() call, then called fetchDcsMasterText() — which does its
  // OWN, separately-timed, internal dcsFileSize() call — and derived
  // `verified` from ITS OWN probe rather than from whatever
  // fetchDcsMasterText's internal probe actually used to check the returned
  // bytes. Two independent network round trips answering the same "is the
  // size available right now" question can disagree, so `verified: true`
  // could land next to a `raw` whose own completeness check never actually
  // ran. fetchDcsMasterTextVerified fixes this by computing `verified`
  // INSIDE the one function that performs both the fetch and the check, from
  // the exact apiSize/buffer it used — these cases pin that contract.
  //
  // All of 17/18/21 below now pass `PINNED_SHA` as `ref`: verified:true also
  // requires a provably-pinned revision as of the round 4 fix (see 22-23
  // below), so these must supply one to keep testing what they always tested
  // (apiSize-was-checked-and-matched) rather than accidentally start testing
  // the "no SHA" fallback instead.

  // 17. apiSize available and used to validate the returned bytes (after a
  //     retry) → verified: true, paired with the complete body. Exact-equality
  //     match: the "complete" body is EXACTLY apiSize bytes, not merely >=.
  queue = [
    jsonRes({ body: { size: 24 } }),
    res({ body: "short", contentLength: undefined }),
    res({ body: "the complete master body", contentLength: undefined }),
  ];
  calls = 0;
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv", PINNED_SHA);
    assert(r.text === "the complete master body", "fetchDcsMasterTextVerified: retried body returned");
    assert(r.verified === true, "fetchDcsMasterTextVerified: verified true — apiSize was available, matched exactly, and ref was pinned");
  }

  // 18. Truncated on both attempts → text: null, verified: false (never claim
  //     verified alongside a null body).
  queue = [
    jsonRes({ body: { size: 20 } }),
    res({ body: "short", contentLength: undefined }),
    res({ body: "short", contentLength: undefined }),
  ];
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv", PINNED_SHA);
    assert(r.text === null, "fetchDcsMasterTextVerified: gives up after retry → text null");
    assert(r.verified === false, "fetchDcsMasterTextVerified: verified false alongside a null body");
  }

  // 19. Content-Length present and correct, but the Gitea contents-API size
  //     was UNAVAILABLE (404/network) → text is still returned (the
  //     Content-Length-only check passed), but verified MUST be false: the
  //     independent positive proof this flag promises never actually ran.
  queue = [jsonRes({ ok: false, body: {} }), res({ body: "hello world", contentLength: "11" })];
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv", PINNED_SHA);
    assert(r.text === "hello world", "fetchDcsMasterTextVerified: Content-Length-only pass still returns the body");
    assert(
      r.verified === false,
      "fetchDcsMasterTextVerified: verified false — a Content-Length-only pass is NOT the independent proof",
    );
  }

  // 20. Neither Content-Length nor contents-API size available → text still
  //     returned (matches fetchDcsMasterText's documented blind spot), but
  //     verified is unambiguously false.
  queue = [jsonRes({ ok: false, body: {} }), res({ body: "unverifiable body", contentLength: undefined })];
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv", PINNED_SHA);
    assert(r.text === "unverifiable body", "fetchDcsMasterTextVerified: wholly unverifiable body still returned");
    assert(r.verified === false, "fetchDcsMasterTextVerified: verified false — no independent signal existed at all");
  }

  // 21. apiSize available AND the body matches on the FIRST attempt (no
  //     retry needed) → verified: true. Confirms verified doesn't require a
  //     retry to have happened — just that apiSize was checked at all.
  queue = [jsonRes({ body: { size: 11 } }), res({ body: "hello world", contentLength: undefined })];
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv", PINNED_SHA);
    assert(r.text === "hello world", "fetchDcsMasterTextVerified: apiSize match on first attempt returns body");
    assert(r.verified === true, "fetchDcsMasterTextVerified: verified true on a clean first-attempt match too");
  }

  // ── round 4 codex re-review of bbb7b25 — the TOCTOU race ────────────────
  // The finding: `apiSize` (dcsFileSize) and the raw fetch were two
  // independently-timed network calls against a MOVABLE ref. If master grows
  // between them, apiSize describes the older/smaller revision while the raw
  // fetch can return the newer/bigger one — a truncated read of that newer
  // file could still coincidentally satisfy the old `>=` check. The fix pins
  // both calls to the SAME ref (dcsRawUrl now honors `ref` instead of
  // silently ignoring it — see the dcsRawUrl cases below) and requires that
  // ref be a genuine commit SHA — not "master" — for `verified: true` to ever
  // be possible. These cases pin that contract.

  // 22. Same apiSize/body shape as case 21 (a clean, matching first attempt)
  //     but WITHOUT a pinned ref (the function's own "master" default) →
  //     verified MUST be false even though the bytes matched exactly. A
  //     size/content match against a MOVABLE ref only proves "these two
  //     requests happened to agree", never "these two requests describe the
  //     same revision" — exactly the gap a mid-sync master push can exploit.
  queue = [jsonRes({ body: { size: 11 } }), res({ body: "hello world", contentLength: undefined })];
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv"); // no ref → defaults to "master"
    assert(r.text === "hello world", "fetchDcsMasterTextVerified: unpinned ref still returns a matching body");
    assert(
      r.verified === false,
      "fetchDcsMasterTextVerified: verified false on an UNPINNED ref, even though apiSize matched exactly — a same-value match on a movable ref is not a same-revision proof",
    );
  }

  // 23. THE RACE ITSELF, closed: apiSize describes a 20-byte file (the
  //     revision at the moment dcsFileSize ran), but the raw endpoint — on
  //     EVERY attempt — returns a 30-byte body (master grew in between).
  //     Before this fix, the old `<` comparison would have treated 30 >= 20
  //     as "complete" and shipped a verified:true result describing the WRONG
  //     revision's size. The new exact-equality check instead treats this as
  //     a mismatch on both attempts and fails closed (text: null,
  //     verified: false) — it never silently accepts a body that disagrees
  //     with the size it was checked against, pinned ref or not.
  queue = [
    jsonRes({ body: { size: 20 } }), // apiSize: the OLDER, smaller revision
    res({ body: "a".repeat(30), contentLength: undefined }), // raw fetch #1: NEWER, bigger revision
    res({ body: "a".repeat(30), contentLength: undefined }), // raw fetch #2: same (master didn't shrink back)
  ];
  {
    const r = await fetchDcsMasterTextVerified(env, "en_twl", "twl_PSA.tsv", PINNED_SHA);
    assert(r.text === null, "fetchDcsMasterTextVerified: size/content mismatch on every attempt → fails closed, never returns the mismatched body");
    assert(r.verified === false, "fetchDcsMasterTextVerified: verified false — a mismatch can never be verified, pinned ref or not");
  }

  // ── dcsRawUrl — the actual bug the race lived in ────────────────────────
  // Before this fix, dcsRawUrl always hit the web "raw/branch/master" route
  // and IGNORED any `ref` its caller passed — so even a caller that already
  // had a pinned commit SHA in hand could never actually fetch that exact
  // revision's raw content; only dcsFileSize's URL was ref-aware. These pin
  // the fixed contract: no ref → unauthenticated web route (unchanged
  // behavior for existing unpinned callers); a ref → the api/v1 raw endpoint
  // with `?ref=`, the same ref-aware shape dcsFileSize already used.

  // 24. No ref → the original web raw-branch route, unchanged.
  assert(
    dcsRawUrl(env, "en_twl", "twl_PSA.tsv") === "https://example.test/unfoldingWord/en_twl/raw/branch/master/twl_PSA.tsv",
    "dcsRawUrl: no ref → unauthenticated web raw/branch/master route (unchanged)",
  );

  // 25. A pinned ref → the api/v1 raw endpoint, with that exact ref in the
  //     query string — this is what makes it possible for the raw fetch to
  //     actually land on the SAME revision dcsFileSize(ref) already sized.
  assert(
    dcsRawUrl(env, "en_twl", "twl_PSA.tsv", PINNED_SHA) ===
      `https://example.test/api/v1/repos/unfoldingWord/en_twl/raw/twl_PSA.tsv?ref=${PINNED_SHA}`,
    "dcsRawUrl: a ref → the ref-aware api/v1 raw endpoint, not the branch-only web route",
  );

  // ── The EXPORT shrink guards' own call shape ────────────────────────────
  // checkTsvShrink / checkUsfmAlignmentShrink (exportWorkflow.ts) are the two
  // callers that go through the thin `fetchDcsMasterText` wrapper rather than
  // fetchDcsMasterTextVerified — they only ever test `raw == null` and have no
  // use for the `verified` flag. They pass `fresh.masterSha ?? undefined`,
  // where `fresh.masterSha` is checkMasterFreshness's `fileCommitSha` result.
  // exportOne returns early on `!fresh.ok`, so by the time either guard runs
  // that value is either a genuine 40-hex commit SHA (detail "current") or
  // null (detail "no_file"/"no_watermark"/"dry" — nothing to pin to).
  //
  // These cases pin BOTH halves of that contract end-to-end through the
  // wrapper, because the round-4 fix made the fetch strictly stricter (exact
  // byte equality, and a raw route that now actually honors `ref`) and these
  // guards BLOCK the nightly export on a null: a false `master_unreadable`
  // would hold a book back every night. Recorded URLs, not just return
  // values — the whole point of the pin is WHICH revision was read.
  const seenUrls = [];
  const recordingFetch = async (u) => {
    calls++;
    seenUrls.push(u);
    if (queue.length === 0) throw new Error("fetch called more times than queued");
    return queue.shift();
  };
  const plainFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch;

  // 26. The "current" case: a real pinned SHA, master's bytes agree with the
  //     size recorded for THAT SHA → body returned (the guards proceed to
  //     compare rows/alignments), and BOTH round trips name the same SHA.
  queue = [jsonRes({ body: { size: 11 } }), res({ body: "hello world", contentLength: undefined })];
  calls = 0;
  seenUrls.length = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv", PINNED_SHA)) === "hello world",
    "export shrink guards: a pinned masterSha with agreeing bytes still returns master's body (no false master_unreadable)",
  );
  assert(
    seenUrls[0] === `https://example.test/api/v1/repos/unfoldingWord/en_twl/contents/twl_PSA.tsv?ref=${PINNED_SHA}`,
    "  ...the size lookup is pinned to that exact SHA",
  );
  assert(
    seenUrls[1] === `https://example.test/api/v1/repos/unfoldingWord/en_twl/raw/twl_PSA.tsv?ref=${PINNED_SHA}`,
    "  ...and so is the raw fetch — one revision, read twice, not two reads of a moving branch",
  );

  // 27. Same pinned shape, but the bytes never agree with the pinned size →
  //     null on both attempts. The guards read that as `master_unreadable`
  //     and refuse to publish, which is the intended fail-closed direction:
  //     an unverifiable master must block, never wave a render through.
  queue = [
    jsonRes({ body: { size: 11 } }),
    res({ body: "hello worldXXXX", contentLength: undefined }),
    res({ body: "hello worldXXXX", contentLength: undefined }),
  ];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv", PINNED_SHA)) === null,
    "export shrink guards: a pinned fetch whose bytes disagree with the pinned size → null → master_unreadable → export blocked (fail closed)",
  );

  // 28. The other reachable caller state: freshness had no SHA to offer
  //     (no_file / no_watermark), so `masterSha ?? undefined` leaves `ref`
  //     defaulted. The fetch must stay on the ORIGINAL unauthenticated web
  //     raw route it always used — the stricter pinning must not change
  //     behavior for the callers that have nothing to pin with.
  queue = [jsonRes({ body: { size: 11 } }), res({ body: "hello world", contentLength: undefined })];
  calls = 0;
  seenUrls.length = 0;
  assert(
    (await fetchDcsMasterText(env, "en_twl", "twl_PSA.tsv", undefined)) === "hello world",
    "export shrink guards: a null masterSha still reads master and returns the body, exactly as before the pin",
  );
  assert(
    seenUrls[1] === "https://example.test/unfoldingWord/en_twl/raw/branch/master/twl_PSA.tsv",
    "  ...over the unchanged web raw/branch/master route, never the api/v1 one",
  );

  globalThis.fetch = plainFetch;

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
      assert(r.incomplete === true && r.incompleteReason === "no_source_sha", "no boundary at all is incomplete without fetching");
    }

    // ── `fromSha` (issue #692 item 2): resume a walk at a HISTORICAL commit
    // instead of master's live tip — what the gap backfill needs to fill a
    // hole without re-walking everything above it.
    {
      let seenUrl = null;
      globalThis.fetch = async (url) => {
        seenUrl = url;
        return commitsRes([commit("h2", "hand fix", "h@x"), commit("ancestor", "old", "h@x")], { pageCount: 1 });
      };
      const r = await listMasterCommitsSince({}, "en_ult", null, "ancestor", { fromSha: "gapfrom123" });
      assert(new URL(seenUrl).searchParams.get("sha") === "gapfrom123", "`fromSha` replaces `sha=master` in the request");
      assert(r.incomplete === false && r.commits.length === 1, "  ...and the walk otherwise behaves like any other: stops at the boundary");
    }
    {
      // No `fromSha` at all — the default must still be "master", unchanged
      // for every existing caller.
      let seenUrl = null;
      globalThis.fetch = async (url) => {
        seenUrl = url;
        return commitsRes([commit("ancestor", "old", "h@x")], { pageCount: 1 });
      };
      await listMasterCommitsSince({}, "en_ult", null, "ancestor");
      assert(new URL(seenUrl).searchParams.get("sha") === "master", "omitting `fromSha` still walks from master's live tip");
    }

    // ── The WATERMARK bound (#540 item 1). The sync passes master_confirmed_at,
    // not source_sha, because the two are different points in master's history
    // and source_sha is routinely newer — see the "WHICH BOUNDARY" note in
    // dcsSources.ts. A commit hidden between them is exactly the human commit
    // whose absence would unblock an overwrite.
    {
      const at = (iso, sha, message, email) => ({
        sha,
        commit: { message, author: { email, name: "x", date: iso } },
      });
      const W = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

      // The whole point: a human commit that sits BELOW source_sha but ABOVE the
      // watermark is inside the range and must be walked to.
      {
        globalThis.fetch = async () =>
          commitsRes(
            [
              at("2026-08-12T00:00:00Z", "s1", "bible-editor: AMO tq → master (#1)", "b@x"),
              at("2026-08-11T00:00:00Z", "s2", "a maintainer's hand fix", "rich@x"),
              at("2026-08-09T00:00:00Z", "s3", "older than the watermark", "rich@x"),
            ],
            { pageCount: 1 },
          );
        const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "s1", { sinceTime: W });
        assert(r.incomplete === false, "a time-bounded walk completes at the first commit older than the watermark");
        assert(r.commits.length === 2, "  ...collecting every commit at or after it");
        assert(r.commits[1].sha === "s2", "  ...INCLUDING one below the sha bound, which is the whole point");
        assert(r.commits.every((c) => c.sha !== "s3"), "  ...and stopping before the one that predates it");
      }

      // The sha bound must not end a time-bounded walk early — that is the
      // defect this parameter exists to close.
      {
        globalThis.fetch = async () =>
          commitsRes(
            [
              at("2026-08-12T00:00:00Z", "s1", "TQ: AMO 5 [q@api.bp-assistant]", "bot@unfoldingword.org"),
              at("2026-08-11T00:00:00Z", "s2", "a maintainer's hand fix", "rich@x"),
              at("2026-08-09T00:00:00Z", "s3", "older", "rich@x"),
            ],
            { pageCount: 1 },
          );
        const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", "s1", { sinceTime: W });
        assert(r.commits.length === 2, "the sha is not a stopping point once a time bound is given");
      }

      // Running out of history under a time bound is COMPLETE, not
      // not-in-history: everything the file has is inside the range.
      {
        globalThis.fetch = async () =>
          commitsRes([at("2026-08-12T00:00:00Z", "s1", "hand fix", "rich@x")], { pageCount: 1 });
        const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", null, { sinceTime: W });
        assert(r.incomplete === false, "reaching the end of history under a time bound is a complete walk");
        assert(r.commits.length === 1, "  ...having walked everything the file has");
      }

      // An unparseable date does not end the walk. "I cannot read this
      // timestamp" is not evidence of having gone far enough, so it walks on and
      // reports page_cap rather than a confident short range.
      {
        let n = 0;
        globalThis.fetch = async () => {
          n++;
          return commitsRes([at("not a date", `s${n}`, "hand fix", "rich@x")], { hasMore: true });
        };
        const r = await listMasterCommitsSince({}, "en_tq", "tq_AMO.tsv", null, { sinceTime: W, pageLimit: 2 });
        assert(n === 2, "an unreadable commit date does not end a time-bounded walk");
        assert(r.incomplete === true && r.incompleteReason === "page_cap", "  ...it runs to the page cap and says so");
      }
    }
  }

  // ── fetchHumanTouchedRefs (issue #557) ────────────────────────────────────
  // Transport only: which URLs it asks for, and that every failure comes back
  // as INCOMPLETE evidence (which downstream means "the file-level answer
  // stands", i.e. master wins — today's behavior). The mapping itself is pure
  // and is tested against the two real richmahn commits in masterLineage.test.mjs.
  {
    const SHA = "82aad43b84ab35ce7139c2e5e47fea0cd5ef41fb";
    const PATH = "24-JER.usfm";
    // A stand-in book: line 4 is verse 2 of chapter 40.
    const USFM = ["\\id JER", "\\c 40", "\\v 1 first", "\\v 2 second", "\\c 41", "\\v 1 other", ""].join("\n");
    const DIFF = [
      `diff --git a/${PATH} b/${PATH}`,
      `--- a/${PATH}`,
      `+++ b/${PATH}`,
      "@@ -4 +4 @@",
      "-\\v 2 old",
      "+\\v 2 second",
      "",
    ].join("\n");

    // url -> response, so the assertions can also check WHAT was asked for.
    let asked = [];
    const serve = (map) => {
      asked = [];
      globalThis.fetch = async (url) => {
        asked.push(String(url));
        for (const [frag, r] of map) if (String(url).includes(frag)) return r();
        throw new Error(`unexpected fetch: ${url}`);
      };
    };
    const commit = (sha) => ({ sha, message: "Fixes USFM", authorEmail: "rich.mahn@unfoldingword.org" });

    {
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF, contentLength: DIFF.length })],
        [`raw/${PATH}`, () => res({ body: USFM, contentLength: USFM.length })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === true, "a mappable human commit yields complete evidence");
      assert(ev.refs.includes("40:2"), "  ...naming the verse its hunk landed in");
      assert(asked.length === 2, "  ...for exactly two subrequests: the diff and the file at that revision");
      assert(asked[0].includes(`/git/commits/${SHA}.diff`), "  ...the commit's own diff");
      assert(asked[1].includes(`ref=${SHA}`), "  ...and the file PINNED to that commit, not master's tip");
    }
    {
      // THE PRODUCTION SHAPE, and the one this file did not cover at first:
      // measured 2026-08-24, Door43 serves `.diff` chunked with NO
      // Content-Length, while the raw endpoint DOES send one. So the diff half
      // of this feature always travels the header-less path, where transport can
      // prove nothing — the diff body's own hunk counts are the proof instead.
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF })], // no content-length
        [`raw/${PATH}`, () => res({ body: USFM, contentLength: USFM.length })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === true, "a header-less diff (production's actual shape) is still mapped");
      assert(ev.refs.includes("40:2"), "  ...to the right verse");
    }
    {
      // ...and a SHORT read of that same header-less response must not become a
      // smaller, confident answer. Transport cannot see it; the hunk counts can.
      const cut = DIFF.split("\n").slice(0, 5).join("\n"); // header + one body line
      // The revision IS served here, deliberately: without the body-count check
      // this call would succeed and return a smaller, confident ref set — the
      // failure being prevented — rather than falling over on a missing fetch.
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: cut })],
        [`raw/${PATH}`, () => res({ body: USFM, contentLength: USFM.length })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === false, "a truncated header-less diff is incomplete, not an under-claimed ref set");
      assert(ev.reason === "hunk_body_short", "  ...named as a short hunk body");
      assert(ev.refs.length === 0, "  ...carrying no refs at all");
    }
    {
      // A revision body with no declared length is accepted (transport cannot
      // verify it), but "no header" and "content-length: 0" are different facts
      // and the short-read check must still fire on the second.
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF })],
        [`raw/${PATH}`, () => res({ body: USFM })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === true, "a header-less revision body is accepted (unverifiable at this layer)");
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF })],
        [`raw/${PATH}`, () => res({ body: "", contentLength: String(USFM.length) })],
      ]);
      const short = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(short.complete === false, "a revision body short of its DECLARED length is still rejected");
      assert(short.reason === "revision_fetch_failed", "  ...as a failed fetch, never as an empty file");

      // A HEADER-LESS revision body cannot be checked by transport at all, so
      // the mapping is what catches a truncated one: a hunk whose lines are no
      // longer in the file it was computed against runs off the end. This is the
      // structural reason the raw half does not need a header either.
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF })],
        [`raw/${PATH}`, () => res({ body: USFM.split("\n").slice(0, 2).join("\n") })],
      ]);
      const cutFile = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(cutFile.complete === false, "a truncated header-less revision body is incomplete");
      assert(cutFile.reason === "hunk_past_end_of_file", "  ...caught by the hunk running past the end of the file");
    }
    {
      // The abbreviated-sha trap, measured on 2026-08-24: the raw endpoint
      // silently serves master's CURRENT tip for a short sha, which would map
      // real hunk numbers onto the wrong bytes. Refused before any fetch.
      serve([]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit("82aad43b")]);
      assert(ev.complete === false && ev.reason === "abbreviated_sha", "an abbreviated sha is refused");
      assert(asked.length === 0, "  ...without spending a subrequest");
    }
    {
      serve([[`git/commits/${SHA}.diff`, () => res({ ok: false })]]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === false && ev.reason === "diff_fetch_failed", "a failed diff fetch is incomplete");
      assert(asked.length === 1, "  ...and the revision fetch is never attempted");
    }
    {
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF, contentLength: DIFF.length })],
        [`raw/${PATH}`, () => res({ ok: false })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === false && ev.reason === "revision_fetch_failed", "a failed revision fetch is incomplete");
    }
    {
      // A short body against a declared length is a truncated read — the
      // twl_PSA shape. Truncation would shift every line number after the cut.
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF, contentLength: DIFF.length })],
        [`raw/${PATH}`, () => res({ body: USFM, contentLength: USFM.length + 5000 })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === false, "a truncated revision body is incomplete, never mapped");
    }
    {
      // Bigger than the cap: refused on the declared length, before reading.
      serve([[`git/commits/${SHA}.diff`, () => res({ body: DIFF, contentLength: 99_000_000 })]]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA)]);
      assert(ev.complete === false && ev.reason === "diff_fetch_failed", "an oversized diff is refused");
    }
    {
      // TSV routing (issue #607): a .tsv path now maps too, via refsTouchedInTsv
      // instead of refsTouchedInUsfm — dispatched by extension. The mapping
      // itself is pure and is tested against two real richmahn tn_JER.tsv
      // commits in masterLineage.test.mjs; this is transport-only, same as the
      // USFM block above.
      const TSV_PATH = "tn_JER.tsv";
      const TSV = ["Reference\tID\tNote", "40:1\taaaa\tfirst", "40:2\tbbbb\told note", "40:3\tcccc\tthird"].join("\n") + "\n";
      const TSV_DIFF = [
        `diff --git a/${TSV_PATH} b/${TSV_PATH}`,
        `--- a/${TSV_PATH}`,
        `+++ b/${TSV_PATH}`,
        "@@ -3 +3 @@",
        "-40:2\tbbbb\tstale note",
        "+40:2\tbbbb\told note",
        "",
      ].join("\n");
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: TSV_DIFF, contentLength: TSV_DIFF.length })],
        [`raw/${TSV_PATH}`, () => res({ body: TSV, contentLength: TSV.length })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_tn", TSV_PATH, [commit(SHA)]);
      assert(ev.complete === true, "a mappable TSV human commit yields complete evidence");
      assert(ev.refs.includes("40:2"), "  ...naming the ref its hunk landed in");
      assert(!ev.refs.includes("40:1") && !ev.refs.includes("40:3"), "  ...and only that ref, not its neighbors");
      assert(asked.length === 2, "  ...for exactly two subrequests: the diff and the file at that revision");
      assert(asked[1].includes(`ref=${SHA}`), "  ...the file PINNED to that commit, not master's tip");
    }
    {
      // A path that is neither .usfm nor .tsv is refused outright — there is
      // no mapper for it, so the file-level answer stands.
      serve([]);
      const ev = await fetchHumanTouchedRefs(env, "en_tn", "tn_JER.json", [commit(SHA)]);
      assert(
        ev.complete === false && ev.reason === "unsupported_path",
        "a path with no mapper (neither .usfm nor .tsv) is not narrowed",
      );
      assert(asked.length === 0, "  ...and costs nothing");
    }
    {
      // The subrequest budget: past the bound, fall back to the file-level
      // answer rather than spend two fetches per commit.
      serve([]);
      const many = Array.from({ length: LINEAGE_REFINE_MAX_HUMAN_COMMITS + 1 }, (_, i) =>
        commit(`${i}`.repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "a")),
      );
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, many);
      assert(ev.complete === false && ev.reason === "too_many_human_commits", "too many human commits to map is incomplete");
      assert(asked.length === 0, "  ...and is refused before any fetch");
    }
    {
      // One bad commit in a window poisons the whole window: the refs we did
      // map are not the whole set of verses a human touched.
      const OTHER = "127cc1f3696994d967fc25fdd28a3a55d111132e";
      serve([
        [`git/commits/${SHA}.diff`, () => res({ body: DIFF, contentLength: DIFF.length })],
        [`git/commits/${OTHER}.diff`, () => res({ ok: false })],
        [`raw/${PATH}`, () => res({ body: USFM, contentLength: USFM.length })],
      ]);
      const ev = await fetchHumanTouchedRefs(env, "en_ult", PATH, [commit(SHA), commit(OTHER)]);
      assert(ev.complete === false, "one unfetchable commit makes the window incomplete");
      assert(ev.refs.length === 0, "  ...and carries no partial ref set");
    }
  }

  console.log(
    "dcsSources/fetchText + fetchDcsMasterText + listMasterCommitsSince + fetchHumanTouchedRefs: all assertions passed",
  );
}

run().catch((e) => {
  console.error = origError;
  console.error("threw:", e);
  process.exit(1);
});

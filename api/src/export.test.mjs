// Smoke test for export.ts buildUsfm. Run from api/:
//   node --experimental-strip-types --no-warnings src/export.test.mjs
//
// Asserts that multi-verse blocks (verse_end > verse) round-trip as `\v 6-9`
// instead of getting silently flattened to `\v 6`. Not a test framework;
// failures exit non-zero.

import { buildUsfm, commitToDcs, ensureDcsPr } from "./export.ts";
import { CorruptContentJsonError } from "./contentJson.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function mkVerse(chapter, verse, verseEnd, text) {
  return {
    book: "ISA",
    chapter,
    verse,
    verse_end: verseEnd,
    bible_version: "UST",
    content_json: JSON.stringify({
      verseObjects: [{ type: "text", text: `${text} ` }],
    }),
    plain_text: text,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
}

function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// --- Multi-verse block emits `\v 6-9` ---
{
  const out = buildUsfm({
    book: "ISA",
    bibleVersion: "UST",
    headers: null,
    verses: [
      mkVerse(1, 1, null, "first"),
      mkVerse(1, 6, 9, "combined six through nine"),
      mkVerse(1, 10, null, "tenth"),
    ],
  });
  assert(out.includes("\\v 6-9 "), `output contains \\v 6-9 marker`);
  assert(out.includes("combined six through nine"), `range content present`);
  assert(!out.match(/^\\v 7\b/m), `no spurious standalone \\v 7`);
  assert(!out.match(/^\\v 8\b/m), `no spurious standalone \\v 8`);
  assert(!out.match(/^\\v 9\b/m), `no spurious standalone \\v 9`);
  assert(out.match(/^\\v 1\b/m), `singleton \\v 1 still present`);
  assert(out.match(/^\\v 10\b/m), `singleton \\v 10 still present`);
}

// --- Singleton with verse_end=null still emits plain \v N ---
{
  const out = buildUsfm({
    book: "ISA",
    bibleVersion: "UST",
    headers: null,
    verses: [mkVerse(2, 5, null, "five")],
  });
  assert(out.match(/^\\v 5\b/m), `singleton emits \\v 5`);
  assert(!out.includes("\\v 5-"), `no hyphenated range emitted`);
}

// --- verse=0 chapter-front pseudo-verse still emits as "front" (regression) ---
{
  const front = {
    book: "PSA",
    chapter: 3,
    verse: 0,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({
      verseObjects: [{ tag: "d", type: "section", text: "A psalm of David." }],
    }),
    plain_text: "A psalm of David.",
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
  const out = buildUsfm({
    book: "PSA",
    bibleVersion: "ULT",
    headers: null,
    verses: [front, mkVerse(3, 1, null, "first")],
  });
  // usfm-js emits the chapter-front content above the first \v marker.
  assert(out.includes("A psalm of David."), `chapter-front content preserved`);
  assert(out.match(/^\\v 1\b/m), `first verse still emits after front`);
}

// --- Inverted verse_end (defensive) treats as singleton ---
{
  const out = buildUsfm({
    book: "ISA",
    bibleVersion: "UST",
    headers: null,
    // verse_end <= verse should fall through to singleton key
    verses: [mkVerse(1, 5, 5, "same"), mkVerse(1, 6, 3, "inverted")],
  });
  assert(out.match(/^\\v 5\b/m), `verse_end === verse emits as singleton`);
  assert(!out.includes("\\v 5-5"), `no \\v 5-5 emitted`);
  assert(out.match(/^\\v 6\b/m), `inverted verse_end emits as singleton`);
  assert(!out.includes("\\v 6-3"), `no \\v 6-3 emitted`);
}

// --- export heals malformed target occurrence (ULT/UST); leaves source (UHB) ---
{
  const verseRow = (bibleVersion, vos) => ({
    book: "NUM", chapter: 20, verse: 3, verse_end: null, bible_version: bibleVersion,
    content_json: JSON.stringify({ verseObjects: vos }),
    plain_text: "is is", version: 1, updated_by: null, updated_at: 0,
  });
  // The real corruption shape: two "is" both stamped occurrence="2"/occurrences="1".
  const corrupt = [
    { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
  ];
  const ult = buildUsfm({ book: "NUM", bibleVersion: "ULT", headers: null, verses: [verseRow("ULT", corrupt)] });
  assert(ult.includes('x-occurrence="1" x-occurrences="2"'), `ULT export heals first "is" → 1/2`);
  assert(ult.includes('x-occurrence="2" x-occurrences="2"'), `ULT export heals second "is" → 2/2`);
  assert(!ult.includes('x-occurrences="1"'), `ULT export: no stale occurrences="1" shipped`);
  // UHB is the source text — its \w occurrence is emitted exactly as stored.
  const uhb = buildUsfm({ book: "NUM", bibleVersion: "UHB", headers: null, verses: [verseRow("UHB", corrupt)] });
  assert(uhb.includes('x-occurrence="2" x-occurrences="1"'), `UHB export leaves source occurrence verbatim`);
}

// --- DCS no-op comparison handles UTF-8 content ---
{
  const originalFetch = globalThis.fetch;
  const config = {
    baseUrl: "https://dcs.example",
    token: "secret",
    owner: "owner",
    repo: "repo",
    branch: "ZEC-be",
  };
  const existing = "Reference\tQuote\tNote\n1:1\tשָׁלוֹם\tשלום עולם\n";
  try {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      const method = init.method ?? "GET";
      // resetExportBranchToMaster (runs first inside commitToDcs): look up the
      // master ref, then force-update the branch ref onto it.
      if (u.includes("/git/refs/heads/master") && method === "GET") {
        return new Response(JSON.stringify({ ref: "refs/heads/master", object: { sha: "master-sha" } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/git/refs/heads/") && method === "PATCH") {
        return new Response(JSON.stringify({ ref: "refs/heads/ZEC-be", object: { sha: "master-sha" } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // contents API: GET the existing file, PUT/POST to write it.
      if (method === "GET") {
        return new Response(JSON.stringify({
          sha: "existing-sha",
          encoding: "base64",
          content: utf8Base64(existing),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        content: { sha: "new-sha" },
        commit: { sha: "commit-sha" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    // Count only the contents-API calls so the branch-reset preamble doesn't
    // skew the lookup-vs-write assertions.
    const contentCalls = () => calls.filter((c) => c.url.includes("/contents/"));

    const noop = await commitToDcs(config, "tn_ZEC.tsv", existing, "nightly");
    assert(noop.changed === false, `UTF-8 DCS match is a no-op`);
    assert(contentCalls().length === 1, `UTF-8 no-op does not send a write request`);

    calls.length = 0;
    const changedContent = existing.replace("שלום עולם", "שלום חדש");
    const changed = await commitToDcs(config, "tn_ZEC.tsv", changedContent, "nightly");
    assert(changed.changed === true, `UTF-8 DCS mismatch sends a commit`);
    assert(contentCalls().length === 2, `UTF-8 mismatch performs lookup plus write`);
    const writeCall = contentCalls().find((c) => (c.init.method ?? "GET") !== "GET");
    assert(writeCall && writeCall.init.method === "PUT", `UTF-8 mismatch updates existing file`);
    const body = JSON.parse(String(writeCall.init.body));
    assert(body.content === utf8Base64(changedContent), `UTF-8 commit body is base64 encoded`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- resetExportBranchToMaster is idempotent across 200/404/409/422 ---
// Regression for the ISA-be-deferredreward wedge: a PATCH 409 ("reference
// already exists") used to throw dcs_branch_reset_failed on every retry.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ISA-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const masterRef = () => okJson({ ref: "refs/heads/master", object: { sha: "master-sha" } });
  const writeOk = () => okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });

  // Build a fetch mock from per-endpoint handlers. Order matters: the master
  // ref GET and the POST /branches (no trailing slash) are matched before the
  // generic /branches/:name GET.
  const makeFetch = (h) => {
    const calls = [];
    const fn = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      calls.push({ u, m });
      if (u.includes("/git/refs/heads/master") && m === "GET") return masterRef();
      if (u.includes("/git/refs/heads/") && m === "PATCH") return h.patch();
      if (u.endsWith("/branches") && m === "POST") return h.postBranch();
      if (u.includes("/branches/") && m === "GET") return h.getBranch();
      if (u.includes("/contents/") && m === "GET") return h.getContents();
      if (u.includes("/contents/")) return writeOk(); // PUT/POST commit
      throw new Error(`unexpected ${m} ${u}`);
    };
    return { fn, calls };
  };
  const notFound = () => okJson({ message: "Not Found" }, 404);

  try {
    // (1) PATCH 409 (branch exists) → confirmed via GET, no create, commit proceeds.
    {
      const { fn, calls } = makeFetch({
        patch: () => okJson({ message: "reference already exists" }, 409),
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => { throw new Error("must not POST /branches when it already exists"); },
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === true, `PATCH 409 (exists) → commit proceeds (regression for ISA-be wedge)`);
      assert(calls.some((c) => c.u.includes("/branches/ISA-be-x") && c.m === "GET"), `409 path confirms branch via GET`);
    }

    // (2) PATCH 404 → create from master → visible → POST (new file) commit.
    {
      let posted = false;
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => { posted = true; return okJson({ name: "ISA-be-x" }, 201); },
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(posted, `PATCH 404 → creates the branch from master`);
      assert(r.changed === true, `404 create path commits the new file`);
    }

    // (3) create, then branch invisible on first GET, visible on second (read-after-write lag).
    {
      let getBranchCalls = 0;
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: () => { getBranchCalls++; return getBranchCalls < 2 ? notFound() : okJson({ name: "ISA-be-x" }); },
        postBranch: () => okJson({ name: "ISA-be-x" }, 201),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === true && getBranchCalls >= 2, `ensureBranchVisible polls past a read-after-write 404`);
    }

    // (4) POST /branches 409 (concurrent create) is benign.
    {
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => okJson({ message: "branch already exists" }, 409),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === true, `POST /branches 409 treated as benign`);
    }

    // (5) branch never becomes visible → throw dcs_branch_not_visible (fail the step, don't commit nowhere).
    {
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: notFound,
        postBranch: () => okJson({ name: "ISA-be-x" }, 201),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      let threw = null;
      try { await commitToDcs(cfg, "23-ISA.usfm", "data", "msg"); } catch (e) { threw = e; }
      assert(threw && String(threw.message).includes("dcs_branch_not_visible"), `invisible branch throws dcs_branch_not_visible`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- corrupt content_json fails export instead of emitting a partial book ---
{
  const bad = {
    book: "ZEC",
    chapter: 1,
    verse: 1,
    verse_end: null,
    bible_version: "ULT",
    content_json: "{not valid json",
    plain_text: null,
    version: 4,
    updated_by: null,
    updated_at: 0,
  };
  try {
    buildUsfm({ book: "ZEC", bibleVersion: "ULT", headers: null, verses: [bad] });
    assert(false, `corrupt content_json throws`);
  } catch (err) {
    assert(err instanceof CorruptContentJsonError, `corrupt content_json throws typed error`);
    assert(err.context.book === "ZEC", `corrupt content_json error includes book`);
    assert(err.context.version === 4, `corrupt content_json error includes row version`);
  }
}

// --- ensureDcsPr: reuse an open PR, create when absent, treat 422 as benign ---
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ZEC-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  try {
    // An open PR already exists for this head→base → reuse it, never POST.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (u.includes("/pulls?") && m === "GET")
        return okJson([{ number: 42, head: { ref: "ZEC-be-x" }, base: { ref: "master" } }]);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r1 = await ensureDcsPr(cfg, "t", "b");
    assert(r1.number === 42 && !r1.created && r1.reason === "existing", `ensureDcsPr reuses an open PR`);

    // No open PR → create one.
    let posted = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (u.includes("/pulls?") && m === "GET") return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") { posted = true; return okJson({ number: 99 }, 201); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r2 = await ensureDcsPr(cfg, "t", "b");
    assert(posted && r2.number === 99 && r2.created && r2.reason === "created", `ensureDcsPr creates a PR when none open`);

    // Create returns 422 (no commits between) and no racing PR → benign no_diff.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (u.includes("/pulls?") && m === "GET") return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") return okJson({ message: "no commits between" }, 422);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r3 = await ensureDcsPr(cfg, "t", "b");
    assert(!r3.created && r3.reason === "no_diff", `ensureDcsPr treats 422 as a benign no-op`);

    // Head == base is a guarded no-op (no network at all).
    const r4 = await ensureDcsPr({ ...cfg, branch: "master" }, "t", "b");
    assert(!r4.created && r4.reason === "head_equals_base", `ensureDcsPr skips when head == base`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\nAll export smoke checks passed.");

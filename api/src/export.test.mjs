// Smoke test for export.ts buildUsfm. Run from api/:
//   node --experimental-strip-types --no-warnings src/export.test.mjs
//
// Asserts that multi-verse blocks (verse_end > verse) round-trip as `\v 6-9`
// instead of getting silently flattened to `\v 6`. Not a test framework;
// failures exit non-zero.

import { attributeTsvShrink, buildAlignmentShrinkAlertMessage, buildUsfmInvalidAlertMessage, classifyAlignmentLossSeverity, offenderProvenanceFromLog, buildExportBranch, buildTnTsv, buildTqTsv, buildTwlTsv, buildUsfm, classifyAlignmentShrinkOffenders, classifyRevertSeverity, commitToDcs, countDuplicateMasterIds, describeShrinkRefusal, ensureDcsPr, exportTags, exportTsvShrinkRefused, findDcsOpenPr, parseTsvIds, recreateExportBranchFromMaster, tsvRevertReport, updateDcsPrBranch, usfmAlignmentShrinkRefused, usfmRevertReport } from "./export.ts";
import { CorruptContentJsonError } from "./contentJson.ts";
import { validateUsfm } from "./usfmValidate.ts";

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

// --- Emptied chapter-front pseudo-verse exports cleanly (issue #366) ---
// Deleting a chapter-leading `\s1` whose verse-0 row holds nothing else leaves
// verseObjects empty. That row must export as nothing at all — no stray `\v 0`,
// no resurrected heading — or the nightly export would undo the deletion.
{
  const emptyFront = {
    book: "MIC",
    chapter: 2,
    verse: 0,
    verse_end: null,
    bible_version: "UST",
    content_json: JSON.stringify({ verseObjects: [] }),
    plain_text: "",
    version: 2,
    updated_by: 1,
    updated_at: 0,
  };
  const out = buildUsfm({
    book: "MIC",
    bibleVersion: "UST",
    headers: null,
    verses: [emptyFront, mkVerse(2, 1, null, "first")],
  });
  assert(!out.includes("\\v 0"), `empty front emits no stray \\v 0`);
  assert(out.match(/^\\v 1\b/m), `first verse still emits after empty front`);
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

// --- tsvCell escapes bare \r (and \r\n) instead of leaking it into the TSV ---
{
  const row = (note) => ({
    ref_raw: "1:1", id: "ab12", tags: null, support_reference: null,
    quote: null, occurrence: 1, note,
  });
  const out = buildTnTsv([row("alpha\rbeta"), row("gamma\r\ndelta")]);
  assert(!out.includes("\r"), `no raw carriage returns in TSV output`);
  assert(out.includes("alpha\\nbeta"), `bare \\r escapes to the literal \\n`);
  assert(out.includes("gamma\\ndelta"), `CRLF collapses to one literal \\n`);
}

// --- exportTags: tn/tq always blank the Tags column, twl keeps it ---
{
  assert(exportTags("tn", "ISSUE:MATCH_FAIL") === "", `tn strips ISSUE:MATCH_FAIL`);
  assert(exportTags("tq", "at-fit, ISSUE:MATCH_FAIL") === "", `tq strips combined tag`);
  assert(exportTags("tn", null) === "", `tn null tag stays empty (no literal "null")`);
  assert(exportTags("twl", "keep") === "keep", `twl tag is preserved`);
}

// --- buildTnTsv / buildTqTsv always emit an empty Tags column; buildTwlTsv doesn't ---
{
  const tnRow = {
    ref_raw: "1:1", id: "ab12", tags: "ISSUE:MATCH_FAIL", support_reference: null,
    quote: null, occurrence: 1, note: "n",
  };
  const tnOut = buildTnTsv([tnRow]).split("\n");
  const tnCells = tnOut[1].split("\t");
  assert(tnCells[2] === "", `tn row with ISSUE:MATCH_FAIL tag exports empty Tags`);
  assert(tnCells.length === 7, `tn row keeps 7 columns (Reference/ID/Tags/SupportReference/Quote/Occurrence/Note)`);

  const tnRow2 = { ...tnRow, tags: "at-fit, ISSUE:MATCH_FAIL" };
  assert(buildTnTsv([tnRow2]).split("\n")[1].split("\t")[2] === "", `tn row with combined tag exports empty Tags`);

  const tnRow3 = { ...tnRow, tags: null };
  assert(buildTnTsv([tnRow3]).split("\n")[1].split("\t")[2] === "", `tn row with null tag exports empty Tags (unchanged behavior)`);

  const tqRow = {
    ref_raw: "1:1", id: "cd34", tags: "at-fit", quote: null,
    occurrence: 1, question: "q", response: "r",
  };
  const tqOut = buildTqTsv([tqRow]).split("\n");
  const tqCells = tqOut[1].split("\t");
  assert(tqCells[2] === "", `tq row with at-fit tag exports empty Tags`);
  assert(tqCells.length === 7, `tq row keeps 7 columns (Reference/ID/Tags/Quote/Occurrence/Question/Response)`);

  const twlRow = { ref_raw: "1:1", id: "ef56", tags: "keep", orig_words: "אֵת", occurrence: 1, tw_link: "rc://x" };
  const twlOut = buildTwlTsv([twlRow]).tsv.split("\n");
  const twlCells = twlOut[1].split("\t");
  assert(twlCells[2] === "keep", `twl row's tag is preserved (key asymmetry vs tn/tq)`);
  assert(twlCells.length === 6, `twl row keeps 6 columns (Reference/ID/Tags/OrigWords/Occurrence/TWLink)`);
}

// --- every export branch carries `-be-` so the DCS gates don't skip it ---
{
  // The DCS validate workflow triggers on push to '*-be-*' — WITH the trailing
  // dash — so a suffix-less `LAM-be` was never validated or auto-merged while
  // still reporting a green combined status. Machine-only exports get
  // "mechanical" so the segment is always present.
  assert(buildExportBranch("LAM", []) === "LAM-be-mechanical", `no contributors → {BOOK}-be-mechanical`);
  assert(buildExportBranch("AMO", ["", "  "]) === "AMO-be-mechanical", `sanitized-to-empty usernames → mechanical`);
  assert(buildExportBranch("NUM", ["stephenwunrow"]) === "NUM-be-stephenwunrow", `single contributor unchanged`);
  assert(buildExportBranch("ISA", ["a", "b"]) === "ISA-be-a-b", `multiple contributors joined`);
  for (const b of [buildExportBranch("LAM", []), buildExportBranch("NUM", ["x"])]) {
    assert(b.includes("-be-"), `${b} contains "-be-" (DCS gate literal)`);
  }
}

// --- OL-quote occurrence invariant: Hebrew/Greek quote forces Occurrence >= 1 ---
{
  const tn = (quote, occurrence) => ({
    ref_raw: "7:1", id: "vut4", tags: null, support_reference: null,
    quote, occurrence, note: "n",
  });
  // Hebrew quote with null/0 occurrence → coerced to 1.
  const heb = buildTnTsv([tn("הַ⁠תְּשִׁעִ֖י לַ⁠חֹ֥דֶשׁ", 0), tn("פְּנֵ֥י יְהוָֽה", null)]).split("\n");
  assert(heb[1].split("\t")[5] === "1", `Hebrew quote, occurrence 0 → 1`);
  assert(heb[2].split("\t")[5] === "1", `Hebrew quote, occurrence null → 1`);
  // Gateway-Language (English) quote keeps occurrence 0 — invariant doesn't apply.
  const gl = buildTnTsv([tn("the ninth month", 0)]).split("\n");
  assert(gl[1].split("\t")[5] === "0", `GL quote keeps occurrence 0`);
  // A real second-occurrence Hebrew target is left untouched.
  const second = buildTnTsv([tn("יְהוָֽה", 2)]).split("\n");
  assert(second[1].split("\t")[5] === "2", `Hebrew quote, occurrence 2 left as 2`);
  // TWL OrigWords (always OL) gets the same guard.
  const twl = buildTwlTsv([{ ref_raw: "7:1", id: "x", tags: null, orig_words: "יְהוָֽה", occurrence: 0, tw_link: "rc://x" }]).tsv.split("\n");
  assert(twl[1].split("\t")[4] === "1", `TWL OrigWords occurrence 0 → 1`);
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
    assert(noop.branchTouched === false, `master match skips the branch entirely`);
    assert(contentCalls().length === 1, `UTF-8 no-op does not send a write request`);
    assert(!calls.some((c) => c.url.includes("/git/refs/")), `master match issues no branch-ref calls`);

    calls.length = 0;
    const changedContent = existing.replace("שלום עולם", "שלום חדש");
    const changed = await commitToDcs(config, "tn_ZEC.tsv", changedContent, "nightly");
    assert(changed.changed === true, `UTF-8 DCS mismatch sends a commit`);
    assert(changed.branchTouched === true, `UTF-8 mismatch ensures the branch`);
    assert(contentCalls().length === 3, `UTF-8 mismatch performs master + branch lookups plus write`);
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
      if (u.includes("/git/refs/heads/") && m === "GET") return (h.getRef ?? notFound)();
      if (u.includes("/git/refs/heads/") && m === "DELETE") return (h.delRef ?? (() => okJson({})))();
      if (u.endsWith("/branches") && m === "POST") return h.postBranch();
      if (u.includes("/branches/") && m === "DELETE") return (h.delBranch ?? (() => okJson({})))();
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

    // (6) dangling ref (ref exists, branch 404 — the real ISA-be corruption):
    //     heal by deleting the ref, recreating from master, then committing.
    {
      let refDeleted = false;
      const { fn, calls } = makeFetch({
        patch: () => okJson({ message: "reference already exists" }, 409),
        // Branch only becomes visible once the dangling ref is deleted + recreated.
        getBranch: () => (refDeleted ? okJson({ name: "ISA-be-x" }) : notFound()),
        getRef: () => okJson({ ref: "refs/heads/ISA-be-x", object: { sha: "dangling" } }),
        delRef: () => { refDeleted = true; return okJson({}); },
        // POST /branches fails (ref still there) until the ref is deleted.
        postBranch: () => (refDeleted ? okJson({ name: "ISA-be-x" }, 201) : okJson({ message: "reference already exists" }, 409)),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(refDeleted && r.changed === true, `dangling ref healed: delete ref → recreate → commit`);
      assert(calls.some((c) => c.u.includes("/git/refs/heads/ISA-be-x") && c.m === "DELETE"), `heal issues a DELETE on the dangling ref`);
    }

    // (7) content already matches MASTER → no branch is created/reset at all
    //     (untouched pairs used to mint junk -be- branches the token can't delete).
    {
      const mustNotTouchBranch = () => { throw new Error("must not touch the branch when master matches"); };
      const { fn } = makeFetch({
        patch: mustNotTouchBranch,
        getBranch: mustNotTouchBranch,
        postBranch: mustNotTouchBranch,
        getContents: () => okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("data") }),
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === false && r.branchTouched === false, `master match skips branch + commit (no junk branch)`);
      // forceBranch overrides the master pre-check (lingering-open-PR path).
      const { fn: fn2 } = makeFetch({
        patch: () => okJson({ ref: "refs/heads/ISA-be-x", object: { sha: "master-sha" } }),
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => okJson({ name: "ISA-be-x" }, 201),
        getContents: () => okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("data") }),
      });
      globalThis.fetch = fn2;
      const forced = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg", { forceBranch: true });
      assert(forced.branchTouched === true && forced.changed === false, `forceBranch ensures the branch even on a content match`);
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

// --- ensureDcsPr: exact base/head lookup; reuse open PR; 409 + 422 benign ---
// The lookup is GET /pulls/{base}/{head} (not the paged /pulls?state=open list,
// which caps at 50 and let existing PRs fall off page 1 → nightly 409 loop).
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ZEC-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const isLookup = (u, m) => u.includes("/pulls/master/ZEC-be-x") && m === "GET";
  try {
    // An open PR already exists for this base/head → reuse it, never POST.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 42, state: "open" });
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r1 = await ensureDcsPr(cfg, "t", "b");
    assert(r1.number === 42 && !r1.created && r1.reason === "existing", `ensureDcsPr reuses an open PR via exact lookup`);

    // Lookup returns a CLOSED PR (the endpoint doesn't filter by state) and
    // the paged fallback finds no open PR for this head either → create a
    // fresh one.
    let posted = false;
    const isList = (u, m) => u.includes("/pulls?state=open") && m === "GET";
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 41, state: "closed" });
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") { posted = true; return okJson({ number: 99 }, 201); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r2 = await ensureDcsPr(cfg, "t", "b");
    assert(posted && r2.number === 99 && r2.created && r2.reason === "created", `closed PR with no open match anywhere is not reused; a new one is created`);

    // No PR at all (404) and no open PR in the paged fallback → create one.
    posted = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") { posted = true; return okJson({ number: 100 }, 201); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r3 = await ensureDcsPr(cfg, "t", "b");
    assert(posted && r3.number === 100 && r3.created && r3.reason === "created", `ensureDcsPr creates a PR when none exists`);

    // Create 409 — DCS's "PR already exists" (ErrPullRequestAlreadyExists) →
    // re-lookup and return the existing PR instead of swallowing it forever.
    let lookups = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) {
        lookups++;
        return lookups === 1 ? okJson({ message: "Not Found" }, 404) : okJson({ number: 7, state: "open" });
      }
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") return okJson({ message: "pull request already exists" }, 409);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r4 = await ensureDcsPr(cfg, "t", "b");
    assert(r4.number === 7 && !r4.created && r4.reason === "raced", `create 409 (already exists) re-looks-up the existing PR`);

    // Create returns 422 (no commits between) and no racing PR → benign no_diff.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") return okJson({ message: "no commits between" }, 422);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r5 = await ensureDcsPr(cfg, "t", "b");
    assert(!r5.created && r5.reason === "no_diff", `ensureDcsPr treats 422 as a benign no-op`);

    // Head == base is a guarded no-op (no network at all).
    const r6 = await ensureDcsPr({ ...cfg, branch: "master" }, "t", "b");
    assert(!r6.created && r6.reason === "head_equals_base", `ensureDcsPr skips when head == base`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- findDcsOpenPr: paged fallback when the exact lookup misses an open PR ---
// Regression coverage for the DAN-be-justplainjane47 bug: the exact lookup
// returns the OLDEST PR for a base/head pair regardless of state, so a closed
// PR can shadow a real open one. door43 had 6 PRs for that head (7347, 7351,
// 7357, 7365, 7375, 7382); the exact lookup returned closed #7347 while #7382
// was open.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "DAN-be-justplainjane47" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const isLookup = (u, m) => u.includes("/pulls/master/DAN-be-justplainjane47") && m === "GET";
  const isList = (u, m) => u.includes("/pulls?state=open") && m === "GET";
  const pageOf = (u) => Number(new URL(u).searchParams.get("page"));
  try {
    // Exact lookup returns an OPEN PR → its number is returned, and the
    // paged fallback is never called.
    let listCalled = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 42, state: "open" });
      if (isList(u, m)) { listCalled = true; return okJson([]); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found1 = await findDcsOpenPr(cfg);
    assert(found1 === 42 && !listCalled, `open PR from the exact lookup is returned without ever calling the paged fallback`);

    // DAN regression: exact lookup returns a CLOSED PR (the oldest for this
    // head), but an open PR for the same head exists in the paged fallback.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 7347, state: "closed" });
      if (isList(u, m)) {
        // The list endpoint is itself queried with ?state=open, so every
        // item it returns is already open — the only filtering left to do
        // client-side is matching the head/base refs (and same-repo head).
        return okJson([
          { number: 6501, state: "open", head: { ref: "OTHER-be-someone", repo: { full_name: "o/r" } }, base: { ref: "master" } },
          { number: 7382, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found2 = await findDcsOpenPr(cfg);
    assert(found2 === 7382, `DAN regression: a closed PR from the exact lookup no longer shadows the real open PR found via paged fallback`);

    // Exact lookup 404s and no open PR matches anywhere → null.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson([]);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found3 = await findDcsOpenPr(cfg);
    assert(found3 === null, `404 exact lookup with no open PR anywhere returns null`);

    // Open PR for this head sits on page 2 of the paged fallback.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        const page = pageOf(u);
        if (page === 1) {
          const items = Array.from({ length: 50 }, (_, i) => ({
            number: i + 1,
            state: "open",
            head: { ref: `other-branch-${i}`, repo: { full_name: "o/r" } },
            base: { ref: "master" },
          }));
          return okJson(items);
        }
        if (page === 2) {
          return okJson([{ number: 999, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } }]);
        }
        return okJson([]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found4 = await findDcsOpenPr(cfg);
    assert(found4 === 999, `an open PR on page 2 of the paged fallback is still found`);

    // Server clamps the page size below the requested `limit` (Gitea's
    // MaxResponseItems) — page 1 returns only 30 of the requested 50, well
    // short of `limit`, yet an open PR still exists on page 2. This is the
    // finding-1 regression case: it fails against `if (items.length < limit)
    // break`, which would have stopped after page 1 and never found it.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        const page = pageOf(u);
        if (page === 1) {
          const items = Array.from({ length: 30 }, (_, i) => ({
            number: i + 1,
            state: "open",
            head: { ref: `other-branch-${i}`, repo: { full_name: "o/r" } },
            base: { ref: "master" },
          }));
          return okJson(items);
        }
        if (page === 2) {
          return okJson([{ number: 4242, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } }]);
        }
        return okJson([]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found5 = await findDcsOpenPr(cfg);
    assert(found5 === 4242, `a clamped page 1 (fewer items than the requested limit) still continues to page 2 and finds the open PR`);

    // State guard (parity with the fast path): the list endpoint is queried
    // with `?state=open`, so this should never happen in practice, but a
    // matching head/base/repo item whose own `state` field isn't "open"
    // (e.g. a stale/inconsistent server response) must NOT be matched.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        return okJson([
          { number: 8888, state: "closed", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const foundStateGuard = await findDcsOpenPr(cfg);
    assert(foundStateGuard === null, `state guard: a matching head/base/repo item whose own state isn't "open" is not matched`);

    // Fork-head guard: a PR with the same head.ref and base.ref, but whose
    // head repo is a contributor's fork (not this repo), must NOT match —
    // matching it would return a stranger's PR number and cause writes
    // (close/update/rebase) against someone else's pull request.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        return okJson([
          { number: 5555, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "someforker/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found6 = await findDcsOpenPr(cfg);
    assert(found6 === null, `same-repo guard: a fork-head PR with a matching head.ref/base.ref is not matched`);

    // A non-OK list response throws rather than silently returning null —
    // a silent null is exactly what hid the DAN bug for a week.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return new Response("server error", { status: 500 });
      throw new Error(`unexpected ${m} ${u}`);
    };
    let threw = false;
    try {
      await findDcsOpenPr(cfg);
    } catch (e) {
      threw = /dcs_pull_list_failed/.test(String(e.message));
    }
    assert(threw, `a non-OK paged list response throws dcs_pull_list_failed instead of returning null`);

    // A 200 list response whose body is not an array (e.g. a Gitea error
    // object shaped like the pulls list, or a gateway page) throws a labeled
    // error rather than a bare TypeError from items.find(...).
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson({ message: "not actually a list" });
      throw new Error(`unexpected ${m} ${u}`);
    };
    let threwNonArray = false;
    try {
      await findDcsOpenPr(cfg);
    } catch (e) {
      threwNonArray = /dcs_pull_list_failed/.test(String(e.message));
    }
    assert(threwNonArray, `a non-array 200 list body throws a labeled dcs_pull_list_failed error`);

    // Empty first page terminates the scan immediately — the `if
    // (items.length === 0) break` line has the same return value with or
    // without the break (both paths fall through to `return null`), so only
    // a request-count assertion can pin that it actually breaks rather than
    // looping to maxPages.
    let listCalls1 = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) { listCalls1++; return okJson([]); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found7 = await findDcsOpenPr(cfg);
    assert(found7 === null && listCalls1 === 1, `an empty first page terminates the scan after exactly one list call`);

    // maxPages backstop: every page is non-empty but never matches, so the
    // loop must run all 20 pages (not loop forever, not stop early).
    let listCalls2 = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        listCalls2++;
        return okJson([
          { number: 1, state: "open", head: { ref: "never-matches", repo: { full_name: "o/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found8 = await findDcsOpenPr(cfg);
    assert(found8 === null && listCalls2 === 20, `a never-matching, never-empty page set runs all 20 pages before giving up`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- updateDcsPrBranch: 200 → ok; conflict statuses return, never throw ---
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r" };
  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (u.endsWith("/pulls/5/update") && m === "POST") return new Response("", { status: 200 });
      throw new Error(`unexpected ${m} ${u}`);
    };
    const ok = await updateDcsPrBranch(cfg, 5);
    assert(ok.ok === true && ok.status === 200, `updateDcsPrBranch 200 → ok`);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "merge failed because of conflict" }), { status: 409 });
    const conflict = await updateDcsPrBranch(cfg, 5);
    assert(conflict.ok === false && conflict.status === 409 && conflict.detail.includes("conflict"),
      `updateDcsPrBranch 409 (merge conflict) reports without throwing`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- exportTsvShrinkRefused: truncation backstop (the twl_PSA clobber) ---
{
  // The actual incident: D1 held 4880 of master's 7776 rows → must refuse.
  assert(exportTsvShrinkRefused(4880, 7776) === true, `PSA 4880-of-7776 (37% loss) is refused`);
  // Ordinary editorial cleanup (Beth removed ~61 of 7776, <1%) must pass.
  assert(exportTsvShrinkRefused(7715, 7776) === false, `small cleanup (-61) is allowed`);
  // Growth (D1 ahead of master, e.g. added notes) is never a shrink.
  assert(exportTsvShrinkRefused(850, 742) === false, `growth (more rows than master) allowed`);
  // Equal is allowed.
  assert(exportTsvShrinkRefused(500, 500) === false, `no change allowed`);
  // Tiny absolute loss on a small book is below the floor even past 5%.
  assert(exportTsvShrinkRefused(280, 300) === false, `20-row loss under the 25-row floor allowed`);
  // Just over both floors (>25 rows AND >5%) is refused.
  assert(exportTsvShrinkRefused(440, 500) === true, `60-of-500 loss (12%) refused`);
  // Empty master can't be shrunk (nothing to protect) — fresh book.
  assert(exportTsvShrinkRefused(0, 0) === false, `empty master never refuses`);
  // A render to zero rows against a populated master is the strongest signal.
  assert(exportTsvShrinkRefused(0, 4000) === true, `render-to-empty against populated master refused`);
}

// --- parseTsvIds: pull master's ID column out of a raw TSV body ---
{
  const tqTsv = [
    ["Reference", "ID", "Tags", "Quote", "Occurrence", "Question", "Response"].join("\t"),
    ["1:1", "abcd", "", "", "1", "Q1?", "A1"].join("\t"),
    ["1:2", "efgh", "", "", "1", "Q2?", "A2"].join("\t"),
  ].join("\n");
  const ids = parseTsvIds(tqTsv);
  assert(Array.isArray(ids), `happy-path TQ TSV parses`);
  assert(ids.length === 2 && ids[0] === "abcd" && ids[1] === "efgh", `happy-path IDs extracted in order`);

  const badHeader = ["Reference\tNotID\tTags", "1:1\tabcd\t"].join("\n");
  assert(parseTsvIds(badHeader) === null, `header whose column 1 isn't ID returns null`);

  const blankId = ["Reference\tID\tTags", "1:1\t\t"].join("\n");
  assert(parseTsvIds(blankId) === null, `data line with an empty ID returns null`);

  assert(parseTsvIds("") === null, `empty input returns null`);
}

// --- attributeTsvShrink: split missing rows into explained vs unexplained ---
//
// Invariant validated against production (numbers decay as both master and
// D1 keep growing, so state the invariant rather than a snapshot count): a
// real, deliberate cleanup of unhelpful genealogy questions left some rows
// missing from D1's render, and 100% of that residual traced to a human
// deletion tombstone (source NULL) in D1 — 0 unexplained. Must ship.

// 1CH TQ shape: feed attributeTsvShrink a REAL rendered TSV (via buildTqTsv)
// so `renderedIds` (FIX 1 — the render, not a second D1 read, is what
// determines liveness) is meaningful rather than a hand-picked array that
// merely restates the fixture.
{
  const totalRows = 436;
  const missingCount = 62;
  const liveCount = totalRows - missingCount;
  const allIds = Array.from({ length: totalRows }, (_, i) => `id${i}`);
  const liveIds = allIds.slice(0, liveCount);
  const removedIds = allIds.slice(liveCount); // the missing ids
  const renderedRows = liveIds.map((id, i) => ({
    ref_raw: `1:${i + 1}`, chapter: 1, verse: i + 1, id, tags: "", quote: null, occurrence: null, question: "Q?", response: "A.",
  }));
  const renderedTsv = buildTqTsv(renderedRows);
  const renderedIds = parseTsvIds(renderedTsv);
  assert(Array.isArray(renderedIds) && renderedIds.length === liveCount, `1CH TQ: rendered TSV round-trips its own ids`);

  const masterIds = allIds;
  const rowStates = [
    ...liveIds.map((id) => ({ id, deleted_at: null })),
    ...removedIds.map((id) => ({ id, deleted_at: 1000 })),
  ];
  const removals = removedIds.map((id, i) => ({ row_key: id, source: null, id: i + 1 }));
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tq" });
  assert(result.liveCount === liveCount, `1CH TQ: liveCount comes from the rendered TSV's own ids`);
  assert(
    result.explained === missingCount && result.unexplained === 0,
    `1CH TQ: all ${missingCount} missing rows explained`,
  );
}

// twl_PSA shape: a large share of master's rows are absent from the render
// AND absent from D1 entirely (no rowStates entry at all) — the truncated-
// load signature, not a tombstone. Must block (nonzero unexplained).
{
  const totalRows = 7776;
  const liveCount = 4880;
  const masterIds = Array.from({ length: totalRows }, (_, i) => `id${i}`);
  const renderedIds = masterIds.slice(0, liveCount);
  const rowStates = renderedIds.map((id) => ({ id, deleted_at: null }));
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: [], resource: "twl" });
  assert(result.liveCount === liveCount, `twl_PSA: liveCount comes from the rendered ids`);
  assert(result.unexplained === totalRows - liveCount, `twl_PSA: every missing row is unexplained`);
}

// HAB: a truncated-fetch reimport prune tombstones rows with
// source='dcs_reimport'. Machine-authored, must NOT be credited.
{
  const masterIds = ["a", "b", "c"];
  const renderedIds = ["a"]; // only "a" ships; b/c are missing from the render
  const rowStates = [
    { id: "a", deleted_at: null },
    { id: "b", deleted_at: 500 },
    { id: "c", deleted_at: 500 },
  ];
  const removals = [
    { row_key: "b", source: "dcs_reimport", id: 1 },
    { row_key: "c", source: "dcs_reimport", id: 2 },
  ];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tq" });
  assert(result.explained === 0 && result.unexplained === 2, `HAB reimport prune: not credited`);
}

// Defect 2 (now Defect 1's "stale trash" case) regression: a stale human
// trash must not permanently credit a later machine prune. Row "x": human
// trash (source NULL), later untrashed (no removal entry for that), then a
// truncated-fetch reimport prune tombstones it (source 'dcs_reimport') — the
// NEWEST removal entry wins, so it must be unexplained. Sibling row "y":
// human trash (source NULL), then the nightly finalize promotes it to a real
// delete (source 'nightly_finalize', still human-authored intent) — must be
// credited.
{
  const masterIds = ["x", "y"];
  const renderedIds = []; // both x and y are missing from the render
  const rowStates = [
    { id: "x", deleted_at: 900 },
    { id: "y", deleted_at: 900 },
  ];
  const removals = [
    { row_key: "x", source: null, id: 1 }, // human trash (older)
    { row_key: "y", source: null, id: 2 }, // human trash (older)
    { row_key: "x", source: "dcs_reimport", id: 3 }, // newer: reimport prune
    { row_key: "y", source: "nightly_finalize", id: 4 }, // newer: nightly finalize
  ];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tn" });
  assert(
    result.explained === 1 && result.unexplained === 1,
    `stale-trash regression: x (newest=dcs_reimport) unexplained, y (newest=nightly_finalize) explained`,
  );
}

// ai_pipeline delete is machine-authored — not credited.
{
  const masterIds = ["z"];
  const renderedIds = []; // z is missing from the render
  const rowStates = [{ id: "z", deleted_at: 500 }];
  const removals = [{ row_key: "z", source: "ai_pipeline", id: 1 }];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tq" });
  assert(result.explained === 0 && result.unexplained === 1, `ai_pipeline delete: not credited`);
}

// tn trashed_at: a trashed-but-not-deleted row is NOT live (mirrors
// buildResource's tn query, which excludes trashed_at IS NOT NULL too), and
// is credited when its newest removal entry's source is null (the trash
// itself).
{
  const masterIds = ["t1"];
  const renderedIds = []; // trashed rows never make it into the render
  const rowStates = [{ id: "t1", deleted_at: null, trashed_at: 800 }];
  const removals = [{ row_key: "t1", source: null, id: 1 }];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tn" });
  assert(result.liveCount === 0, `tn row with trashed_at set is not counted live`);
  assert(result.explained === 1 && result.unexplained === 0, `tn trashed row credited via null source`);
}

// Duplicate master IDs are counted once by attributeTsvShrink's own
// bookkeeping (its Set-based masterIds dedup is unrelated to the Defect 5
// fail-closed check, which lives one layer up in checkTsvShrink — see below).
{
  const masterIds = ["a", "a", "c"];
  const renderedIds = ["a"]; // "a" ships (once — a render can't duplicate a row); "c" is missing
  const rowStates = [{ id: "a", deleted_at: null }];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: [], resource: "tq" });
  assert(result.missing === 1 && result.unexplained === 1, `duplicate master IDs counted once`);
}

// No loss at all — every master ID is live (present in the render).
{
  const masterIds = ["a", "b"];
  const renderedIds = ["a", "b"];
  const rowStates = [
    { id: "a", deleted_at: null },
    { id: "b", deleted_at: null },
  ];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: [], resource: "tq" });
  assert(
    result.liveCount === 2 && result.missing === 0 && result.explained === 0 && result.unexplained === 0,
    `no loss at all`,
  );
}

// --- Defect 1: crediting requires D1 to ACTUALLY hold the row removed ------
// A removal entry in edit_log is not, by itself, proof the row is gone. The
// twl_PSA truncated-fetch signature is an id ABSENT from D1 entirely — no
// rowStates entry at all — and that must never be "explained" by some
// historical edit_log entry, however human-authored its source looks.

// Named incident: a translator trashes a tn row (source NULL, rows.ts:975),
// then untrashes it. 'untrash' is a separate action and does not delete the
// stale 'trash' removal entry, so edit_log keeps claiming a human removal
// forever even though the row is live again. Weeks later a truncated fetch
// loads the book WITHOUT this row at all (absent from tn_rows entirely — the
// twl_PSA signature). The row must be unexplained: D1 holds no removed-row
// record for it, only a stale historical entry.
{
  const masterIds = ["abcd"];
  const renderedIds = []; // missing from the render too
  const rowStates = []; // absent from D1 entirely — the truncated-load shape
  const removals = [{ row_key: "abcd", source: null, id: 1 }]; // stale trash, pre-untrash
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tn" });
  assert(
    result.explained === 0 && result.unexplained === 1,
    `trash->untrash->truncated-load: a stale removal entry on a row absent from D1 must NOT credit`,
  );
}

// General form of the same gap: any id with a null-source removal entry but
// NO rowStates entry at all is unexplained, regardless of resource.
{
  const masterIds = ["p"];
  const renderedIds = [];
  const rowStates = [];
  const removals = [{ row_key: "p", source: null, id: 1 }];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tq" });
  assert(
    result.explained === 0 && result.unexplained === 1,
    `defect 1: removal entry with no matching rowStates entry is unexplained`,
  );
}

// Sibling (the normal case keeps working): an id present in rowStates WITH
// deleted_at set, AND a null-source removal entry, IS credited.
{
  const masterIds = ["q"];
  const renderedIds = []; // missing from the render
  const rowStates = [{ id: "q", deleted_at: 500 }];
  const removals = [{ row_key: "q", source: null, id: 1 }];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tq" });
  assert(
    result.explained === 1 && result.unexplained === 0,
    `defect 1 sibling: a row D1 actually holds removed, with a human removal entry, is still credited`,
  );
}

// --- FIX 1: race semantics — the render, not a second D1 read, is what
// determines liveness. Two mirror-image cases:
{
  // Restored-after-render: master holds "b"; the render was taken while D1
  // still had "b" tombstoned, so "b" is absent from renderedIds. Before this
  // guard's (separate, later) D1 read, a translator restores "b" — rowStates
  // now shows it live (deleted_at null) and there is no removal entry at all
  // for the CURRENT state (the old tombstone was undone, not re-recorded).
  // Because the render is authoritative for liveness, "b" is still judged
  // against what's ABOUT TO SHIP (absent) — unexplained (fail-safe: blocks
  // rather than silently shipping a render that would delete the
  // just-restored row).
  const masterIds = ["b"];
  const renderedIds = []; // absent from the render that's about to ship
  const rowStates = [{ id: "b", deleted_at: null }]; // restored in D1 AFTER the render was taken
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: [], resource: "tq" });
  assert(
    result.explained === 0 && result.unexplained === 1,
    `race: id restored in D1 after the render was captured is still unexplained (render says absent)`,
  );
}
{
  // Deleted-after-render: master holds "a"; the render was taken while D1
  // still had "a" live, so "a" IS present in renderedIds and about to ship.
  // Before this guard's later D1 read, a translator deletes "a" — rowStates
  // now shows it removed. Because the render is authoritative, "a" is still
  // judged live (present in what's about to ship, so shipping it does not
  // delete it from master) — never reaches the explained/unexplained split
  // at all.
  const masterIds = ["a"];
  const renderedIds = ["a"]; // present in the render that's about to ship
  const rowStates = [{ id: "a", deleted_at: 999 }]; // deleted in D1 AFTER the render was taken
  const removals = []; // no removal entry needed — liveness comes from the render
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals, resource: "tq" });
  assert(result.liveCount === 1 && result.missing === 0, `race: id deleted in D1 after the render was captured is still treated as live`);
}

// --- Defect 1 property (real assertion, replacing a tautological one) ------
// A genuine truncation residual UNDER the count-only floor (20 of 300: both
// <=25 rows AND <5%) must still surface as unexplained via real attribution
// — the ship decision (unexplained === 0) never re-applies the floor to
// what's left over, unlike the old code, which re-judged
// exportTsvShrinkRefused(masterRows - unexplained, masterRows) and would have
// shipped this residual silently.
{
  const masterIds = Array.from({ length: 300 }, (_, i) => `id${i}`);
  const renderedIds = masterIds.slice(0, 280); // 20 missing, absent from D1 entirely
  const rowStates = renderedIds.map((id) => ({ id, deleted_at: null }));
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: [], resource: "tq" });
  assert(result.unexplained === 20, `defect 1 property: 20 rows absent from D1 entirely are unexplained`);
  assert(
    exportTsvShrinkRefused(masterIds.length - result.unexplained, masterIds.length) === false,
    `defect 1 property: the count-only floor alone would NOT have blocked this 20-row residual — ` +
      `only requiring unexplained === 0 catches it`,
  );
}

// --- Defect 5: duplicate IDs within master's own TSV ------------------------
// attributeTsvShrink's masterIds Set-collapse is a "how many distinct rows
// are missing" bookkeeping detail, unrelated to Defect 5's fix (which fails
// CLOSED one layer up, in checkTsvShrink, before attribution ever runs — see
// exportWorkflow.ts). Test the pure duplicate-detector directly.
{
  assert(countDuplicateMasterIds([]) === 0, `countDuplicateMasterIds: empty input has no duplicates`);
  assert(countDuplicateMasterIds(["a", "b", "c"]) === 0, `countDuplicateMasterIds: all-unique input has no duplicates`);
  assert(countDuplicateMasterIds(["a", "a", "c"]) === 1, `countDuplicateMasterIds: one repeated id counts once`);
  assert(
    countDuplicateMasterIds(["a", "a", "a", "b", "b"]) === 3,
    `countDuplicateMasterIds: every id beyond the first occurrence counts (2 extra "a" + 1 extra "b")`,
  );
}

// --- Defect 6: last-write-wins must not depend on `removals` arrival order --
// attributeTsvShrink now picks each row_key's newest entry by its own `id`
// field (edit_log's PK), so shuffling the input must not change the result.
// Sorted-order control, then the SAME data shuffled/newest-first.
{
  const masterIds = ["x", "y"];
  const renderedIds = []; // both missing from the render
  const rowStates = [
    { id: "x", deleted_at: 900 },
    { id: "y", deleted_at: 900 },
  ];
  const sorted = [
    { row_key: "x", source: null, id: 1 },
    { row_key: "y", source: null, id: 2 },
    { row_key: "x", source: "dcs_reimport", id: 3 },
    { row_key: "y", source: "nightly_finalize", id: 4 },
  ];
  const shuffledNewestFirst = [sorted[3], sorted[2], sorted[1], sorted[0]];
  const resultSorted = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: sorted, resource: "tn" });
  const resultShuffled = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: shuffledNewestFirst, resource: "tn" });
  assert(
    resultSorted.explained === 1 && resultSorted.unexplained === 1,
    `defect 6 control: sorted stale-trash case still resolves x unexplained, y explained`,
  );
  assert(
    resultShuffled.explained === resultSorted.explained && resultShuffled.unexplained === resultSorted.unexplained,
    `defect 6: shuffled/newest-first input produces the IDENTICAL result to sorted input`,
  );
}

// Second shuffle case with a plain (non-stale-trash) dataset, arrival order
// scrambled arbitrarily, to further decouple the guarantee from any one
// hand-ordered fixture.
{
  const masterIds = ["m", "n"];
  const renderedIds = []; // both missing from the render
  const rowStates = [
    { id: "m", deleted_at: 500 },
    { id: "n", deleted_at: 500 },
  ];
  const removalsScrambled = [
    { row_key: "n", source: "ai_pipeline", id: 5 },
    { row_key: "m", source: "nightly_finalize", id: 2 },
    { row_key: "n", source: null, id: 1 }, // older than id 5 — must lose
    { row_key: "m", source: "dcs_reimport", id: 8 }, // newest for m — must win over id 2
  ];
  const result = attributeTsvShrink({ masterIds, renderedIds, rowStates, removals: removalsScrambled, resource: "tq" });
  assert(
    result.explained === 0 && result.unexplained === 2,
    `defect 6: scrambled input — m's newest (id 8, dcs_reimport) unexplained, n's newest (id 5, ai_pipeline) unexplained`,
  );
}

// --- describeShrinkRefusal: every refusal kind checkTsvShrink can produce ---
// FIX 4: moved out of recordShrinkSkipAlert's D1-touching caller so each
// mapping is directly testable, including the neutral fallback for any
// refusal kind not (yet) recognized.
{
  const ctx = { renderedRows: 10, masterRows: 20 };

  const masterUnreadable = describeShrinkRefusal("master_unreadable", ctx);
  assert(/couldn't be fetched from DCS/.test(masterUnreadable.signature), `master_unreadable: names the fetch failure`);

  // FIX 2: these two must not be mistaken for the MASTER-parse-failure case —
  // "render_ids_unreadable" contains the substring "_ids_unreadable", so
  // describeShrinkRefusal must check for it BEFORE the generic includes()
  // check or it would misreport a render bug as a master parse failure.
  const renderIdsUnreadable = describeShrinkRefusal("render_ids_unreadable", ctx);
  assert(
    /rendered TSV's ID column couldn't be parsed/.test(renderIdsUnreadable.signature),
    `render_ids_unreadable: names OUR render, not master`,
  );

  const renderInconsistent = describeShrinkRefusal("render_inconsistent_9_vs_10", ctx);
  assert(
    /disagrees with the row count captured earlier/.test(renderInconsistent.signature),
    `render_inconsistent_*: names an inconsistency in our own render`,
  );

  const dup = describeShrinkRefusal("shrink_5_of_20_master_duplicate_ids_2", ctx);
  assert(/duplicate row IDs/.test(dup.signature), `_master_duplicate_ids_*: names master's duplicate IDs`);

  const idsUnreadable = describeShrinkRefusal("shrink_5_of_20_ids_unreadable", ctx);
  assert(
    /Master's ID column couldn't be parsed/.test(idsUnreadable.signature),
    `_ids_unreadable: names master's unparseable ID column`,
  );

  const unexplainedOnly = describeShrinkRefusal("shrink_10_of_20_unexplained_10", {
    renderedRows: 10,
    masterRows: 20,
    explained: 0,
    unexplained: 10,
  });
  assert(
    /10 of the 10 missing rows/.test(unexplainedOnly.signature) && !/were human deletions/.test(unexplainedOnly.signature),
    `unexplained-only: no explainedNote when explained is 0`,
  );

  const mixedExplained = describeShrinkRefusal("shrink_10_of_20_unexplained_4", {
    renderedRows: 10,
    masterRows: 20,
    explained: 6,
    unexplained: 4,
  });
  assert(
    /4 of the 10 missing rows/.test(mixedExplained.signature) && /6 of the 10 were human deletions/.test(mixedExplained.signature),
    `mixed explained/unexplained: names both counts`,
  );

  // Unrecognized detail shape (e.g. a future refusal kind added to
  // checkTsvShrink without a matching branch here) must get the NEUTRAL
  // fallback — never guess "master's ID column couldn't be parsed" (the
  // exact misdiagnosis this fix set out to remove).
  const unrecognized = describeShrinkRefusal("some_future_refusal_kind", { renderedRows: 10, masterRows: 20 });
  assert(
    /not recognized/.test(unrecognized.signature) && /some_future_refusal_kind/.test(unrecognized.signature),
    `unrecognized detail: neutral fallback names the detail instead of inventing a cause`,
  );
  assert(
    !/ID column couldn't be parsed/.test(unrecognized.signature),
    `unrecognized detail: does NOT fall back to the master-parse-failure wording`,
  );

  // An unrecognized detail that HAPPENS to carry attribution counts must still
  // reach the neutral fallback. Keying the attribution branch on the context
  // alone (rather than on the detail string) would hand a future refusal kind
  // the "that's the truncated-load signature" wording for a signature nobody
  // measured — the same invent-a-cause defect, one layer down.
  const unrecognizedWithCounts = describeShrinkRefusal("some_future_refusal_kind", {
    renderedRows: 402,
    masterRows: 464,
    explained: 62,
    unexplained: 0,
  });
  assert(
    /not recognized/.test(unrecognizedWithCounts.signature),
    `unrecognized detail WITH counts: still gets the neutral fallback`,
  );
  assert(
    !/truncated-load signature/.test(unrecognizedWithCounts.signature),
    `unrecognized detail WITH counts: does NOT claim a truncated-load signature`,
  );

  // The genuine attribution refusal still gets the attribution wording.
  const attributed = describeShrinkRefusal("shrink_62_of_464_unexplained_20", {
    renderedRows: 402,
    masterRows: 464,
    explained: 42,
    unexplained: 20,
  });
  assert(
    /truncated-load signature/.test(attributed.signature) && /20 of the 62/.test(attributed.signature),
    `attribution refusal: reports the unexplained/missing split`,
  );
}

// --- usfmAlignmentShrinkRefused: ULT/UST verse alignment backstop ---
// The 1CH 4:21 / NUM 24 signature — a verse loses \zaln milestones on words the
// translator never touched. The export must refuse to ship that to master. This
// now reuses analyzeAlignmentDelta (the SAME analyzer as the write-time guard):
// it REFUSES on a word that survives the edit (matched by surface) but lost its
// \zaln source (`reason === "lost"`) — REGARDLESS of whether the verse's plain
// text also changed — and does NOT refuse on a re-pointed source on an unchanged
// word (`reason === "changed_source"`, the legitimate re-alignment signature).
{
  // One aligned token: \zaln-s ...\* \w word\w* \zaln-e\*. The explicit
  // \zaln-e\* close keeps each milestone a sibling span (usfm-js NESTS
  // consecutive open milestones with no close, which would keep a word "aligned"
  // under an ancestor even after dropping its own \zaln). dealignIdx emits a
  // bare \w (no \zaln) for that word — the de-alignment under test. strongs lets
  // a test override the per-word x-strong/x-content so a word can keep its
  // surface text while its alignment source is re-pointed (changed_source).
  const verse = (book, ch, v, words, dealignIdx = -1, strongs = null) =>
    `\\id ${book}\n\\c ${ch}\n\\p\n\\v ${v} ` +
    words
      .map((word, i) => {
        if (i === dealignIdx) return `\\w ${word}|x-occurrence="1" x-occurrences="1"\\w*`;
        const strong = strongs ? strongs[i] : `H${100 + i}`;
        return `\\zaln-s |x-strong="${strong}" x-content="${word}"\\*\\w ${word}|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`;
      })
      .join(" ") +
    "\n";

  const master = verse("1CH", 4, 21, ["Lekah", "and", "Shelah"]);

  // (1) INCIDENT regression: the verse's TEXT changed (Lekah→Lecah, a genuine
  // edit) AND an UNTOUCHED neighbor (Shelah) lost its \zaln source. The OLD
  // count-based, text-exempt code wrongly ALLOWED this — the plain-text change
  // exempted exactly the verse that also carried collateral loss. The
  // word-level analyzer matches Shelah in both by surface and sees its source
  // is gone → `lost` → REFUSE.
  const incident = verse("1CH", 4, 21, ["Lecah", "and", "Shelah"], 2);
  const r1 = usfmAlignmentShrinkRefused(incident, master);
  assert(r1.refused === true, `INCIDENT: text edit + collateral loss on an untouched word is refused`);
  assert(r1.offenders.length === 1 && r1.offenders[0].ref === "4:21", `offender is 4:21`);
  // The offender names the de-aligned word (Shelah) rather than a whole-verse count.
  assert(
    JSON.stringify(r1.offenders[0].lostWords) === JSON.stringify(["Shelah"]),
    `offender names the de-aligned word "Shelah"`,
  );

  // (1b) Pure collateral loss, NO text change (the classic NUM 24 shape) → REFUSE.
  const pureLoss = verse("1CH", 4, 21, ["Lekah", "and", "Shelah"], 1);
  const r1b = usfmAlignmentShrinkRefused(pureLoss, master);
  assert(r1b.refused === true, `de-alignment on an otherwise-unchanged verse is refused`);

  // (2) Identical render → allowed.
  const r2 = usfmAlignmentShrinkRefused(master, master);
  assert(r2.refused === false, `identical render is allowed`);

  // (3) Legitimate text rewrite where the ONLY de-aligned word is the one that
  // CHANGED ("and"→"or", and the new word "or" is unaligned). No surviving word
  // lost its source → no `lost` → ALLOWED.
  const rewritten = verse("1CH", 4, 21, ["Lekah", "or", "Shelah"], 1);
  const r3 = usfmAlignmentShrinkRefused(rewritten, master);
  assert(r3.refused === false, `a real text change with no collateral lost word is allowed`);

  // (3b) Legitimate RE-ALIGNMENT: every word's surface text is UNCHANGED, every
  // word stays aligned, but a word's \zaln source is RE-POINTED (changed_source).
  // This is the aligner-panel signature — must NOT be over-blocked.
  const repointed = verse("1CH", 4, 21, ["Lekah", "and", "Shelah"], -1, ["H100", "H999", "H102"]);
  const r3b = usfmAlignmentShrinkRefused(repointed, master);
  assert(r3b.refused === false, `a re-pointed source on an unchanged word (changed_source) is NOT over-blocked`);

  // (4) Render ADDS alignment (more aligned words) → never a refusal.
  const r4 = usfmAlignmentShrinkRefused(master, verse("1CH", 4, 21, ["Lekah", "and", "Shelah"], 1));
  assert(r4.refused === false, `growth in aligned words is not a refusal`);

  // (5) Verse only on master (removed in render) → ignored (content change).
  const masterTwoVerses = master + verse("1CH", 4, 22, ["who", "ruled"]);
  const r5 = usfmAlignmentShrinkRefused(master, masterTwoVerses);
  assert(r5.refused === false, `a verse removed entirely is not flagged as alignment loss`);

  // (5b) Verse ADDED in render (only on render side) → skipped, not a loss.
  const r5b = usfmAlignmentShrinkRefused(masterTwoVerses, master);
  assert(r5b.refused === false, `a verse added in the render is not flagged`);

  // (6) Empty master → nothing to shrink.
  const r6 = usfmAlignmentShrinkRefused(master, "");
  assert(r6.refused === false, `empty master never refuses`);

  // (7) Multiple words de-aligned in one verse → offender lists each lost word,
  // in document order. The alert string (assembled in exportWorkflow.ts) caps
  // the named words at 3 and appends "(+N more)" so the banner stays short while
  // still naming WHICH words to re-align — the point of this refinement.
  const big = ["the", "father", "of", "Bethrapha", "and", "Paseah"];
  const bigMaster = verse("1CH", 4, 21, big);
  // De-align the first three words (indices 0,1,2): "the","father","of".
  const bigRender = verse("1CH", 4, 21, big)
    .replace(/\\zaln-s \|x-strong="H100" x-content="the"\\\*/, "")
    .replace(/\\zaln-s \|x-strong="H101" x-content="father"\\\*/, "")
    .replace(/\\zaln-s \|x-strong="H102" x-content="of"\\\*/, "");
  const r7 = usfmAlignmentShrinkRefused(bigRender, bigMaster);
  assert(r7.refused === true, `multi-word de-alignment is refused`);
  assert(
    JSON.stringify(r7.offenders[0].lostWords) === JSON.stringify(["the", "father", "of"]),
    `offender lists every lost word in document order`,
  );
  // Mirror of the exportWorkflow.ts alert-detail builder (cap 3 + "(+N more)").
  const fmtOffender = (o) => {
    const shown = o.lostWords.slice(0, 3).map((w) => `"${w}"`).join(",");
    const extra = o.lostWords.length - 3;
    return `${o.ref}: lost alignment on ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`;
  };
  assert(
    fmtOffender(r7.offenders[0]) === `4:21: lost alignment on "the","father","of"`,
    `alert names up to 3 lost words (no "+N more" at exactly 3)`,
  );
  // Synthetic offender with 29 lost words → "(+26 more)" (the task's example).
  const manyLost = { ref: "4:21", lostWords: ["the", "father", "of", ...Array(26).fill("x") ] };
  assert(
    fmtOffender(manyLost) === `4:21: lost alignment on "the","father","of" (+26 more)`,
    `alert caps at 3 and appends "(+26 more)"`,
  );

  // (8) FAIL-CLOSED on a broken render. usfm.toJSON does not throw on a
  // malformed USFM *string* — an empty/garbled render parses to ZERO verses.
  // Without the guard, every master verse is skipped (absent from render) and
  // the corrupt render ships, deleting all alignment. Must REFUSE.
  const r8empty = usfmAlignmentShrinkRefused("", master);
  assert(r8empty.refused === true, `an empty render against an aligned master is refused (fail closed)`);
  assert(r8empty.offenders.length === 1 && r8empty.offenders[0].ref === "*", `empty-render offender is the whole-render sentinel "*"`);

  const r8garbage = usfmAlignmentShrinkRefused("not usfm at all {[}]", master);
  assert(r8garbage.refused === true, `a garbled render that parses to zero verses is refused`);

  // (8b) An empty render against an EMPTY master has nothing to lose → allowed
  // (fresh book / no aligned baseline). The fail-closed gate is keyed on the
  // master actually having aligned verses.
  const r8freshboth = usfmAlignmentShrinkRefused("", "");
  assert(r8freshboth.refused === false, `empty render + empty master never refuses`);

  // (9) `sequenceUnchanged` per-offender flag — distinguishes true collateral
  // de-alignment on untouched text (JER 36:11 shape: same word sequence, one
  // word bare) from D1/master holding different revisions of the verse (EZK
  // 40 shape: word sequence differs entirely, and the "lost" word is just a
  // coincidental surface match between two unrelated sentences). This is
  // wording-only — both cases must still set refused:true (see the CRITICAL
  // constraint: the refusal decision itself must never change).
  assert(
    r1b.offenders[0].sequenceUnchanged === true,
    `pure collateral loss on unchanged text (JER 36:11 shape) is flagged sequenceUnchanged:true`,
  );
  assert(r1b.refused === true, `regression guard: sequence-unchanged case still refuses`);

  const revA = verse("EZK", 40, 6, ["the", "gate", "facing", "east", "steps"]);
  const revB = verse("EZK", 40, 6, ["through", "the", "narrow", "steps"], 3);
  const r9 = usfmAlignmentShrinkRefused(revB, revA);
  assert(r9.refused === true, `regression guard: different-revision verse (EZK 40 shape) still refuses`);
  assert(r9.offenders.length === 1, `different-revision mismatch produces one offender`);
  assert(
    r9.offenders[0].sequenceUnchanged === false,
    `a verse whose word sequence differs entirely (different revision) is flagged sequenceUnchanged:false`,
  );
  assert(
    JSON.stringify(r9.offenders[0].lostWords) === JSON.stringify(["steps"]),
    `names the coincidentally-shared word "steps" as the (misleading) lost word`,
  );
}

// --- classifyAlignmentShrinkOffenders: alert-wording partition ---
// Extracted pure classification for recordAlignmentShrinkSkipAlert
// (exportWorkflow.ts, untestable by the strip-types runner). Three cases the
// nightly alert must word differently — see export.ts for the full rationale:
//   - "none": no offenders at all (master_unreadable — a DCS fetch failure).
//   - "sentinel": the synthetic ref:"*" offender for an unparseable/empty
//     RENDER (our own rendering bug).
//   - "genuine": real per-verse offenders, split by sequenceUnchanged.
{
  const none = classifyAlignmentShrinkOffenders([]);
  assert(none.kind === "none", `no offenders at all → classified "none" (master_unreadable case)`);

  const unparseable = classifyAlignmentShrinkOffenders([
    { ref: "*", lostWords: ["unparseable_render"], sequenceUnchanged: true, beforeAligned: 8, afterAligned: 7 },
  ]);
  assert(unparseable.kind === "sentinel", `the "*" unparseable_render sentinel → classified "sentinel"`);
  assert(unparseable.which === "unparseable_render", `sentinel classification names which sentinel fired`);

  const empty = classifyAlignmentShrinkOffenders([
    { ref: "*", lostWords: ["empty_render"], sequenceUnchanged: true, beforeAligned: 8, afterAligned: 7 },
  ]);
  assert(empty.kind === "sentinel", `the "*" empty_render sentinel → classified "sentinel"`);
  assert(empty.which === "empty_render", `sentinel classification names empty_render specifically`);

  const genuineUnchanged = classifyAlignmentShrinkOffenders([
    { ref: "1CH 4:21", lostWords: ["Shelah"], sequenceUnchanged: true, beforeAligned: 8, afterAligned: 7 },
  ]);
  assert(genuineUnchanged.kind === "genuine", `a real per-verse offender → classified "genuine"`);
  assert(
    genuineUnchanged.unchanged.length === 1 && genuineUnchanged.changed.length === 0,
    `genuine + sequenceUnchanged:true sorts into the "unchanged" (collateral de-alignment) bucket`,
  );

  const genuineChanged = classifyAlignmentShrinkOffenders([
    { ref: "EZK 40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 },
  ]);
  assert(genuineChanged.kind === "genuine", `a real per-verse revision-mismatch offender → classified "genuine"`);
  assert(
    genuineChanged.unchanged.length === 0 && genuineChanged.changed.length === 1,
    `genuine + sequenceUnchanged:false sorts into the "changed" (different-revision) bucket`,
  );

  const mixed = classifyAlignmentShrinkOffenders([
    { ref: "1CH 4:21", lostWords: ["Shelah"], sequenceUnchanged: true, beforeAligned: 8, afterAligned: 7 },
    { ref: "EZK 40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 },
  ]);
  assert(mixed.kind === "genuine", `mixed unchanged+changed offenders → still classified "genuine"`);
  assert(
    mixed.unchanged.length === 1 && mixed.changed.length === 1,
    `mixed case splits correctly into both buckets`,
  );
}

// --- buildAlignmentShrinkAlertMessage: only state a MEASURED cause ---
// The regression: for every sequence-changed offender the alert asserted "D1
// and master hold DIFFERENT REVISIONS ... not a translator's mistake ...
// re-sync, NOT re-align". A changed sequence never proved that — a translator's
// own edit changes the sequence too, and edit + collateral de-alignment is the
// 1CH 4:21 / NUM 24 case this guard exists to catch. So a real de-alignment on
// an edited verse was reported as a sync problem needing no re-alignment.
{
  const base = { label: "EZK UST", book: "EZK", resource: "ust", detail: "align_loss_1:40:6", blocking: true };

  const humanEdited = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [{ ref: "40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 }],
    provenance: new Map([["40:6", "human_edit"]]),
  });
  assert(
    /person last edited them/.test(humanEdited) && /Re-align/.test(humanEdited),
    `sequence changed + edit_log says a HUMAN last wrote it → real de-alignment, remedy is re-align`,
  );
  assert(
    !/DIFFERENT REVISIONS|not a translator's mistake/.test(humanEdited),
    `a human-edited offender is never described as a different-revision sync problem`,
  );
  assert(humanEdited.includes("40:6") && humanEdited.includes('"steps"'), `alert names the verse and the lost word`);

  const syncWritten = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [{ ref: "40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 }],
    provenance: new Map([["40:6", "sync_write"]]),
  });
  assert(
    /out of sync \(the EZK 40 signature\)/.test(syncWritten) && /Re-sync EZK UST/.test(syncWritten),
    `sequence changed + edit_log says the SYNC last wrote it → EZK 40 signature, remedy is re-sync`,
  );
  assert(
    /coincidental surface matches/.test(syncWritten),
    `the sync branch keeps the sentence explaining WHY the named words are noise`,
  );

  const aiWritten = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [{ ref: "40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 }],
    provenance: new Map([["40:6", "ai_write"]]),
  });
  assert(
    /AI pipeline last wrote them/.test(aiWritten) && /do not re-sync from master/.test(aiWritten),
    `an AI-written verse is NOT the sync: D1 holds a revision master lacks, so re-syncing would discard it`,
  );
  assert(
    !/the nightly DCS sync/.test(aiWritten),
    `the AI bucket never claims the nightly sync wrote the verse`,
  );

  const notChecked = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [
      { ref: "40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 },
      { ref: "41:2", lostWords: ["wall"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 },
    ],
    provenance: new Map([["40:6", "human_edit"], ["41:2", "not_checked"]]),
  });
  assert(
    /NOT attributed/.test(notChecked) && !/does not say who last wrote/.test(notChecked),
    `an offender past the lookup cap is reported as un-checked, never as a measured "unknown"`,
  );

  const unknown = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [{ ref: "40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 }],
    provenance: new Map(),
  });
  assert(
    /EITHER real de-alignment/.test(unknown) && /OR D1 drifting out of sync/.test(unknown),
    `no provenance measured → the alert names both possibilities instead of asserting one`,
  );

  const mixedMsg = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [
      { ref: "40:5", lostWords: ["gate"], sequenceUnchanged: true, beforeAligned: 8, afterAligned: 7 },
      { ref: "40:6", lostWords: ["steps"], sequenceUnchanged: false, beforeAligned: 8, afterAligned: 7 },
    ],
    provenance: new Map([["40:6", "sync_write"]]),
  });
  assert(
    /collateral\s+de-alignment signature/.test(mixedMsg) && /Re-sync EZK UST/.test(mixedMsg),
    `mixed causes report both remedies, each attached to its own verses`,
  );

  // The non-genuine branches keep their existing wording.
  const fetchFail = buildAlignmentShrinkAlertMessage({
    ...base,
    detail: "master_unreadable",
    offenders: [],
    provenance: new Map(),
  });
  assert(/connectivity/.test(fetchFail), `no offenders → still reported as a DCS fetch problem`);
  const sentinel = buildAlignmentShrinkAlertMessage({
    ...base,
    offenders: [{ ref: "*", lostWords: ["empty_render"], sequenceUnchanged: true, beforeAligned: 8, afterAligned: 7 }],
    provenance: new Map(),
  });
  assert(/EMPTY/.test(sentinel), `the empty_render sentinel → still reported as our own render bug`);
}

// --- classifyAlignmentLossSeverity: ship unless it looks like OUR bug ---
// Policy (Benjamin, 2026-08-04): "an unaligned word or two here or there is no
// reason not to sync to Door43 ... don't hold somebody's work back cause he
// didn't drag 'and' to the right spot." Detection stays; the embargo narrows to
// loss no translator could have produced by hand.
{
  const verse = (ref, lost, before, after) => ({
    ref,
    lostWords: Array.from({ length: lost }, (_, i) => `w${i}`),
    sequenceUnchanged: true,
    beforeAligned: before,
    afterAligned: after,
  });

  assert(
    classifyAlignmentLossSeverity([verse("40:6", 1, 12, 11)]).block === false,
    `one undragged word in one verse SHIPS — that is what the broken-link icon is for`,
  );
  assert(
    classifyAlignmentLossSeverity([verse("40:6", 2, 12, 10), verse("41:2", 1, 9, 8)]).block === false,
    `a couple of words across two verses still ships`,
  );
  assert(
    classifyAlignmentLossSeverity([verse("40:6", 9, 9, 0)]).block === true,
    `a FLATTENED verse (master aligned, render has none) still blocks — nobody does that by hand`,
  );
  assert(
    classifyAlignmentLossSeverity([verse("40:6", 6, 12, 6)]).block === true,
    `losing half a verse's aligned words at once blocks — dragging happens one word at a time`,
  );
  assert(
    classifyAlignmentLossSeverity([verse("40:6", 4, 40, 36)]).block === false,
    `four words out of forty is translator-scale, not a flatten`,
  );
  assert(
    classifyAlignmentLossSeverity(
      Array.from({ length: 21 }, (_, i) => verse(`40:${i + 1}`, 1, 12, 11)),
    ).block === true,
    `21 verses each losing a word is systemic — that is a bug, not a person`,
  );
  assert(
    classifyAlignmentLossSeverity([]).block === true,
    `no offenders means master was unverifiable — still blocks`,
  );
  assert(
    classifyAlignmentLossSeverity([
      { ref: "*", lostWords: ["empty_render"], sequenceUnchanged: true, beforeAligned: 0, afterAligned: 0 },
    ]).block === true,
    `a broken render is our bug by definition — still blocks`,
  );

  // A shipped-anyway alert must not claim the export was blocked.
  const shipped = buildAlignmentShrinkAlertMessage({
    label: "EZK UST",
    book: "EZK",
    resource: "ust",
    detail: "align_loss_1:40:6",
    offenders: [verse("40:6", 1, 12, 11)],
    provenance: new Map([["40:6", "human_edit"]]),
    blocking: false,
  });
  assert(
    /shipped to Door43/.test(shipped) && !/BLOCKED/.test(shipped),
    `the ship-anyway alert says the book went out, never that it was blocked`,
  );
  assert(/Nothing is held up/.test(shipped), `and says plainly that nobody's work is waiting on it`);
}

// --- offenderProvenanceFromLog: edit_log row → who last wrote the verse ---
{
  assert(
    offenderProvenanceFromLog({ updated_by: 7, latest_source: null }) === "human_edit",
    `updated_by set = translator-owned (verses.ts logs no source column)`,
  );
  assert(
    offenderProvenanceFromLog({ updated_by: null, latest_source: "dcs_reimport" }) === "sync_write",
    `master-owned + source=dcs_reimport = the nightly sync wrote it`,
  );
  // The regression this ordering exists for: bookReimport's source-attr
  // reconcile rewrites a TRANSLATOR-owned verse and logs it as dcs_reimport.
  // Reading the last writer alone would call it a sync write and advise
  // re-syncing from master — discarding the translator's revision.
  assert(
    offenderProvenanceFromLog({ updated_by: 7, latest_source: "dcs_reimport" }) === "human_edit",
    `a sync RECONCILE on a translator-owned verse stays human_edit — ownership beats last-writer`,
  );
  assert(
    offenderProvenanceFromLog({ updated_by: 1, latest_source: "ai_pipeline" }) === "ai_write",
    `source=ai_pipeline gets its OWN bucket — it is not the sync, and master does not hold that revision`,
  );
  assert(offenderProvenanceFromLog(null) === "unknown", `no verses row at all → unknown, never guessed`);
  assert(
    offenderProvenanceFromLog({ updated_by: null, latest_source: null }) === "unknown",
    `master-owned with no edit_log source → unknown rather than assumed sync`,
  );
  assert(
    offenderProvenanceFromLog({ updated_by: null, latest_source: "some_future_writer" }) === "unknown",
    `an unrecognised source is unknown — the sync bucket is an allowlist, not a catch-all`,
  );
}

// --- recreateExportBranchFromMaster: delete + recreate off master ---
// Recovers a drifted export branch whose PR conflicted. Needs branch-delete
// (admin token); 403 → rebuilt:false WITHOUT throwing so the caller alerts.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "admin", owner: "o", repo: "r", branch: "ISA-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  // Per-endpoint mock: DELETE /branches/:name, POST /branches (recreate),
  // GET /branches/:name (ensureBranchVisible poll).
  const makeFetch = (h) => {
    const calls = [];
    const fn = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      calls.push({ u, m });
      if (u.endsWith("/branches") && m === "POST") return (h.postBranch ?? (() => okJson({ name: cfg.branch })))();
      if (u.includes("/branches/") && m === "DELETE") return h.delBranch();
      if (u.includes("/branches/") && m === "GET") return (h.getBranch ?? (() => okJson({ name: cfg.branch })))();
      throw new Error(`unexpected ${m} ${u}`);
    };
    return { fn, calls };
  };

  try {
    // (1) Happy path: delete 200 → recreate → visible → rebuilt.
    {
      const { fn, calls } = makeFetch({ delBranch: () => okJson({}) });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === true && r.detail === "rebuilt", `delete 200 → rebuilt`);
      assert(calls.some((c) => c.m === "DELETE"), `issues a branch DELETE`);
      assert(calls.some((c) => c.u.endsWith("/branches") && c.m === "POST"), `recreates the branch from master`);
    }

    // (2) Forbidden delete (service token lacks branch-delete): rebuilt:false,
    // detail surfaces the status, and we do NOT recreate.
    {
      const { fn, calls } = makeFetch({
        delBranch: () => okJson({ message: "Forbidden" }, 403),
        postBranch: () => { throw new Error("must not recreate when delete is forbidden"); },
      });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === false && r.detail === "delete_403", `403 delete → rebuilt:false, detail delete_403`);
      assert(!calls.some((c) => c.u.endsWith("/branches") && c.m === "POST"), `no recreate after forbidden delete`);
    }

    // (3) Branch already gone (404 delete) → still recreates → rebuilt.
    {
      const { fn } = makeFetch({ delBranch: () => okJson({ message: "Not Found" }, 404) });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === true, `404 delete (already gone) still recreates → rebuilt`);
    }

    // (4) Benign 409 on recreate (a concurrent run already made it) → rebuilt.
    {
      const { fn } = makeFetch({
        delBranch: () => okJson({}),
        postBranch: () => okJson({ message: "branch already exists" }, 409),
      });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === true, `409 on recreate (race) is benign → rebuilt`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- buildUsfmInvalidAlertMessage: only ever state a cause we measured ---
// The wording this replaces asserted ONE cause for every outcome ("This is the
// EZK front-\p stacked-marker signature ... inspect the chapter for stacked \p/\m
// markers"). For any other rule that named the wrong defect and pointed Benjamin
// at a marker stack that was not there.
{
  const issue = (rule, line, ref) => ({ rule, line, ref, message: "m" });

  const verses = buildUsfmInvalidAlertMessage({
    label: "EZK ULT",
    issues: [issue("multiple-verses-per-line", 120, "8:3")],
  });
  assert(
    /multiple-verses-per-line/.test(verses) && /more than one \\v marker/.test(verses),
    `the alert names the rule that actually fired`,
  );
  assert(
    !/front-\\p/.test(verses) && !/stacked/.test(verses),
    `a two-\\v-on-a-line issue must NOT be described as the front-\\p stacked-marker signature`,
  );
  assert(/line 120/.test(verses) && /8:3/.test(verses), `the alert locates the issue`);

  const pump = buildUsfmInvalidAlertMessage({
    label: "EZK ULT",
    issues: [issue("consecutive-paragraph-markers", 11, "8")],
  });
  // By the time this gate runs, collapseConsecutiveParagraphMarkers has already
  // dropped every run of IDENTICAL markers, so the front-\p pump and any
  // "duplicate marker" are unreachable here — only a MIXED adjacency survives.
  // Naming either would point Benjamin at a pair that cannot occur.
  assert(
    !/front-\\p/.test(pump) && !/duplicate/.test(pump),
    `the alert must not blame the front-\\p pump or a duplicate marker — neither can ` +
      `reach this gate, they are auto-collapsed before validation`,
  );
  assert(
    /DIFFERENT paragraph markers/.test(pump) && /auto-collapsed/.test(pump),
    `it must say what actually survives to be reported: a mixed adjacency`,
  );

  const leaked = buildUsfmInvalidAlertMessage({
    label: "EZK ULT",
    issues: [issue("invalid-content-before-verse", 55, "8:2")],
  });
  assert(
    /not a marker problem/.test(leaked),
    `leaked text before \\v is called what it is, not a marker stack`,
  );

  // Multiple distinct rules: each gets its own named remedy, none is asserted
  // as the cause of the others.
  const mixed = buildUsfmInvalidAlertMessage({
    label: "LAM UST",
    issues: [
      issue("ts-marker-not-isolated", 9, "1"),
      issue("b-marker-after-ts", 10, "1"),
    ],
  });
  assert(
    /ts-marker-not-isolated/.test(mixed) && /b-marker-after-ts/.test(mixed) && /ALSO/.test(mixed),
    `every rule that fired is reported, joined rather than collapsed to one cause`,
  );

  // Why the gate still blocks is itself a measured fact and worth stating: DCS's
  // validate_usfm_files.py has NO warning tier, so shipping cannot publish.
  assert(
    /no warning tier/.test(mixed) && /would not publish/.test(mixed),
    `the alert explains that shipping would not have published the book anyway`,
  );

  // Empty issues: the gate fired with nothing measured. Say that, do not invent
  // a defect.
  const none = buildUsfmInvalidAlertMessage({ label: "EZK ULT", issues: [] });
  assert(
    /no specific issue/.test(none) && /bug in the export gate/.test(none),
    `zero issues is reported as a gate bug, not as a book defect`,
  );
  assert(
    !/\\p/.test(none) && !/marker/.test(none),
    `with nothing measured the alert must not name a marker defect at all`,
  );
}

// --- synthesizeHeaders must emit the header BLANK LINE, or Check 8 goes inert ---
// The USFM HOLD gate is a port of DCS's validate_usfm_formatting, which skips
// every line until the first blank one and never re-enters header mode. A render
// with no blank line anywhere therefore gets ZERO lines of Check 8 — from DCS and
// from us — while the gate still looks alive because Check 7 keeps running.
// synthesizeHeaders used to emit no blank line, so the fallback path taken when
// book_usfm_meta.headers_json is missing or unparseable silently validated
// nothing. blankLinePass has the same inHeader latch, so it was inert too.
{
  const verses = [
    {
      book: "EZK", chapter: 1, verse: 1, verse_end: null,
      content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word one" }] }),
    },
    {
      book: "EZK", chapter: 2, verse: 1, verse_end: null,
      content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word two" }] }),
    },
  ];
  // headers: null is the synthesizeHeaders fallback path.
  const rendered = buildUsfm({ book: "EZK", bibleVersion: "ULT", headers: null, verses });
  const lines = rendered.split("\n");
  const firstBlank = lines.findIndex((l) => l.trim() === "");
  assert(
    firstBlank !== -1,
    `a synthesized-header render MUST contain a blank line — without one DCS's Check 8 inspects nothing`,
  );
  assert(
    /^\\mt1\b/.test(lines[firstBlank - 1]),
    `the blank line belongs right after \\mt1, matching real en_ult/en_ust masters (line 9)`,
  );

  // Canary: the gate must actually fire on a body defect in this render. Asserting
  // "0 issues" here would pass just as happily with Check 8 switched off, which is
  // exactly how this bug hid.
  assert(validateUsfm(rendered).length === 0, `the clean synthesized render is valid`);
  const withDefect = lines.slice();
  withDefect.splice(lines.length - 1, 0, "\\p trailing text");
  assert(
    validateUsfm(withDefect.join("\n"))
      .map((i) => i.rule)
      .includes("paragraph-marker-not-isolated"),
    `Check 8 must be ACTIVE on a synthesized-header render, not silently skipped`,
  );
}

// --- usfmRevertReport: export-time "we overwrote something" report ---
// Purely observational — never blocks, never reachable from the shrink/
// alignment guards' refusal decisions. Compares a rendered ULT/UST USFM
// against master's current USFM and reports every verse present in BOTH that
// actually differs.
{
  const verseUsfm = (book, ch, v, text) => `\\id ${book}\n\\c ${ch}\n\\p\n\\v ${v} ${text}\n`;

  // Identical input → empty report.
  const identical = verseUsfm("ISA", 1, 1, "the word of the LORD");
  const rIdentical = usfmRevertReport(identical, identical);
  assert(rIdentical.entries.length === 0, `identical usfm render vs master → empty revert report`);
  assert(rIdentical.totalVerses === 1, `totalVerses counts master's verses`);

  // Differs only by line-break/whitespace placement → "formatting".
  const master1 = verseUsfm("ISA", 1, 2, "hear, O heavens, and give ear, O earth");
  const rendered1 = `\\id ISA\n\\c 1\n\\p\n\\v 2 hear,   O heavens,\nand give ear, O earth\n`;
  const rFormatting = usfmRevertReport(rendered1, master1);
  assert(
    rFormatting.entries.length === 1 && rFormatting.entries[0].class === "formatting",
    `whitespace-only difference (line-break placement / run of spaces) classifies as "formatting"`,
  );
  assert(rFormatting.entries[0].ref === "1:2", `formatting entry names the verse ref`);

  // A changed word → "substantive".
  const master2 = verseUsfm("ISA", 1, 3, "the ox knows its owner");
  const rendered2 = verseUsfm("ISA", 1, 3, "the ox knows its master");
  const rSubstantive = usfmRevertReport(rendered2, master2);
  assert(
    rSubstantive.entries.length === 1 && rSubstantive.entries[0].class === "substantive",
    `a changed word classifies as "substantive"`,
  );

  // A verse present on only one side is never reported.
  const masterOnly = master1 + verseUsfm("ISA", 1, 9, "unless the LORD had left us a remnant");
  const rOneSided = usfmRevertReport(master1, masterOnly);
  assert(
    rOneSided.entries.length === 0,
    `a verse present in only one side (master-only 1:9 here) is not reported`,
  );
}

// --- tsvRevertReport: export-time "we overwrote something" report (TSV) ---
{
  const TN_HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const tnRow = (ref, id, tags, quote, note) => `${ref}\t${id}\t${tags}\t\t${quote}\t1\t${note}`;

  // Only Tags differs → "tags_only".
  const masterTags = `${TN_HEADER}\n${tnRow("1:1", "ab01", "", "word", "a note")}\n`;
  const renderedTags = `${TN_HEADER}\n${tnRow("1:1", "ab01", "keyword", "word", "a note")}\n`;
  const rTags = tsvRevertReport(renderedTags, masterTags, "tn");
  assert(
    rTags.entries.length === 1 && rTags.entries[0].class === "tags_only",
    `only the Tags column differing classifies as "tags_only"`,
  );
  assert(rTags.totalRows === 1, `totalRows counts master's rows`);

  // Only a double-space-vs-single-space difference in a text field → "whitespace_only".
  const masterWs = `${TN_HEADER}\n${tnRow("1:2", "ab02", "", "word", "a  note about the word")}\n`;
  const renderedWs = `${TN_HEADER}\n${tnRow("1:2", "ab02", "", "word", "a note about the word")}\n`;
  const rWs = tsvRevertReport(renderedWs, masterWs, "tn");
  assert(
    rWs.entries.length === 1 && rWs.entries[0].class === "whitespace_only",
    `a double-space-vs-single-space difference in Note classifies as "whitespace_only"`,
  );

  // A changed Quote → "substantive", with fields including "Quote".
  const masterQuote = `${TN_HEADER}\n${tnRow("1:3", "ab03", "", "old word", "a note")}\n`;
  const renderedQuote = `${TN_HEADER}\n${tnRow("1:3", "ab03", "", "new word", "a note")}\n`;
  const rQuote = tsvRevertReport(renderedQuote, masterQuote, "tn");
  assert(
    rQuote.entries.length === 1 && rQuote.entries[0].class === "substantive",
    `a changed Quote classifies as "substantive"`,
  );
  assert(
    Array.isArray(rQuote.entries[0].fields) && rQuote.entries[0].fields.includes("Quote"),
    `substantive entry's fields list includes "Quote"`,
  );

  // A row present in only one side is never reported.
  const masterOnlyRow = `${TN_HEADER}\n${tnRow("1:4", "ab04", "", "word", "note")}\n${tnRow("1:5", "ab05", "", "other", "note2")}\n`;
  const renderedMissing = `${TN_HEADER}\n${tnRow("1:4", "ab04", "", "word", "note")}\n`;
  const rMissing = tsvRevertReport(renderedMissing, masterOnlyRow, "tn");
  assert(
    rMissing.entries.length === 0,
    `a row present in only one side (master-only ab05 here) is not reported`,
  );
}

// --- classifyRevertSeverity: escalation threshold ---
// SYSTEMIC_REVERTS = 15 (see export.ts comment above classifyRevertSeverity):
// more than 15 substantive entries across usfm+tsv escalates the wording;
// this NEVER changes whether the export ships (no `block` field — only
// `escalate`).
{
  const mkSubstantive = (n) => Array.from({ length: n }, (_, i) => ({ ref: `1:${i + 1}`, class: "substantive" }));

  const small = classifyRevertSeverity(mkSubstantive(3), []);
  assert(small.escalate === false, `a small number (3) of substantive entries is not escalated`);

  const large = classifyRevertSeverity(mkSubstantive(10), mkSubstantive(10));
  assert(
    large.escalate === true,
    `20 substantive entries (10 usfm + 10 tsv), crossing the 15 threshold, is escalated`,
  );

  const exactlyAtThreshold = classifyRevertSeverity(mkSubstantive(15), []);
  assert(exactlyAtThreshold.escalate === false, `exactly 15 substantive entries is NOT escalated (threshold is > 15)`);

  const oneOverThreshold = classifyRevertSeverity(mkSubstantive(16), []);
  assert(oneOverThreshold.escalate === true, `16 substantive entries (one over threshold) is escalated`);

  // Non-substantive classes never count toward the threshold.
  const allFormatting = classifyRevertSeverity(
    Array.from({ length: 50 }, (_, i) => ({ ref: `1:${i + 1}`, class: "formatting" })),
    [],
  );
  assert(allFormatting.escalate === false, `formatting-only entries, however many, never escalate`);
}

console.log("\nAll export smoke checks passed.");

// Issue #442 (option C): the admin panel flags only exports Door43 rejected or
// left waiting more than a day. Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/exportMergeState.test.mjs
//
// Not a test framework; failures exit non-zero. Real migrated schema over
// node:sqlite (same shim as syncWithholds.test.mjs) and a stubbed global fetch
// standing in for Door43. No network, no production anything.
//
// The Door43 shapes the mock reproduces were measured 2026-09-25 on en_tn:
//   * our `-be-` PRs are squash-merged by a DCS Actions job and then reported
//     `state: closed, merged: false` (e.g. #7763) — so Gitea's `merged` flag
//     cannot tell merged from rejected; only the squash commit on master,
//     `bible-editor: NUM tn → master (#7763)`, can.
//   * the commits list paginates with `X-HasMore`.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MERGE_LIVE_LOOKUP_CAP,
  MERGE_WAIT_FLAG_SECONDS,
  classifyExportMerge,
  computeExportMergeFlags,
} from "./exportMergeState.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const NOW = 1_790_000_000;
const HOUR = 3600;
const DAY = 86400;

// ── pure classifier ─────────────────────────────────────────────────────────
console.log("\n[classifyExportMerge]");

const base = { exportedAt: NOW - 2 * DAY, now: NOW, open: false, checkState: null, mergedOnMaster: null };
eq(classifyExportMerge({ ...base, mergedOnMaster: true }), { state: "merged" }, "squash commit on master → merged");
eq(
  classifyExportMerge({ ...base, open: true, exportedAt: NOW - 2 * HOUR, checkState: "success" }),
  { state: "pending" },
  "open under a day → pending (not flagged)",
);
eq(
  classifyExportMerge({ ...base, open: true, exportedAt: NOW - MERGE_WAIT_FLAG_SECONDS, checkState: "pending" }),
  { state: "pending" },
  "open exactly one day → still pending (flag is MORE than a day)",
);
eq(
  classifyExportMerge({ ...base, open: true, exportedAt: NOW - 2 * DAY, checkState: "pending" }),
  { state: "waiting" },
  "open over a day → waiting (flagged)",
);
eq(
  classifyExportMerge({ ...base, open: true, exportedAt: NOW - 2 * DAY, checkState: null }),
  { state: "waiting" },
  "open over a day with no readable check → waiting",
);
eq(
  classifyExportMerge({ ...base, open: true, exportedAt: NOW - HOUR, checkState: "failure" }),
  { state: "rejected", reason: "validation_failed" },
  "open with failed validation → rejected, even under a day",
);
eq(
  classifyExportMerge({ ...base, open: true, exportedAt: NOW - HOUR, checkState: "error" }),
  { state: "rejected", reason: "validation_failed" },
  "open with errored validation → rejected",
);
eq(
  classifyExportMerge({ ...base, open: false, mergedOnMaster: false }),
  { state: "rejected", reason: "closed_unmerged" },
  "closed, and a complete master walk found no squash commit → rejected",
);
eq(
  classifyExportMerge({ ...base, open: false, mergedOnMaster: null }),
  { state: "unknown", reason: "master_unmeasured" },
  "closed, master walk incomplete → unknown, never a guess",
);

// ── end to end: real schema + mocked Door43 ─────────────────────────────────
console.log("\n[computeExportMergeFlags — real schema, mocked Door43]");

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare: (sql) => mk(sql, []) };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return {
    sqlite,
    env: {
      DB: makeDb(sqlite),
      DCS_BASE_URL: "https://dcs.test",
      DCS_SERVICE_TOKEN: "t",
      DCS_EXPORT_OWNER: "unfoldingWord",
    },
  };
}

function snapshot(sqlite, book, resource, pr, at, extra = {}) {
  sqlite
    .prepare(
      `INSERT INTO export_snapshots (book, resource, branch, commit_sha, committed_at, rows_exported, error, pr_number)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(book, resource, `${book}-be-test`, "c0ffee", at, extra.error ?? null, pr);
}

function ledgerCommit(sqlite, repo, sha, at, message, classification = "ours") {
  sqlite
    .prepare(
      `INSERT INTO dcs_commits (repo, sha, committed_at, message, classification) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(repo, sha, at, message, classification);
}

const iso = (sec) => new Date(sec * 1000).toISOString();
function giteaCommit(sha, at, message, email = "someone@example.org") {
  return { sha, commit: { message, author: { email, date: iso(at) }, committer: { date: iso(at) } } };
}
function openPr(number, branch, createdAt = null) {
  return {
    number,
    created_at: createdAt == null ? undefined : iso(createdAt),
    title: `bible-editor: ${branch}`,
    state: "open",
    head: { ref: branch, sha: `head${number}`, repo: { full_name: `unfoldingWord/${REPO_OF[number]}` } },
    base: { ref: "master" },
    html_url: `https://dcs.test/pr/${number}`,
  };
}
const REPO_OF = {};

// Door43 mock. `open[repo]` = open PRs (page 1 of the list); `pr[number]` =
// the single-PR GET body; `status[sha]` = combined state; `history[path]` =
// newest-first commits on master for that file; `throwOn` = a URL substring
// whose fetch throws (transport failure).
function mockDoor43({ open = {}, pr = {}, status = {}, history = {}, failList = new Set(), throwOn = null }) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (throwOn && String(input).includes(throwOn)) throw new TypeError("network down");
    const json = (body, headers = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    let m;
    if ((m = url.pathname.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
      return pr[m[1]] ? json({ number: Number(m[1]), ...pr[m[1]] }) : new Response("nf", { status: 404 });
    }
    if ((m = url.pathname.match(/\/repos\/[^/]+\/([^/]+)\/pulls$/))) {
      if (failList.has(m[1])) return new Response("boom", { status: 500 });
      const page = Number(url.searchParams.get("page"));
      return json(page === 1 ? open[m[1]] ?? [] : []);
    }
    if ((m = url.pathname.match(/\/commits\/([^/]+)\/status$/))) {
      return status[m[1]] ? json({ state: status[m[1]] }) : new Response("nf", { status: 404 });
    }
    if ((m = url.pathname.match(/\/repos\/unfoldingWord\/([^/]+)\/commits$/))) {
      const path = url.searchParams.get("path");
      const page = Number(url.searchParams.get("page"));
      const all = history[path] ?? [];
      const slice = all.slice((page - 1) * 50, page * 50);
      return json(slice, { "x-hasmore": String(all.length > page * 50) });
    }
    return new Response(`unmocked ${url}`, { status: 599 });
  };
  return calls;
}

{
  const { sqlite, env } = freshEnv();

  // merged: the ledger already holds the squash commit → zero Door43 fetches for it.
  snapshot(sqlite, "AMO", "tn", 100, NOW - 3 * DAY);
  ledgerCommit(sqlite, "en_tn", "m100", NOW - 3 * DAY + 60, "bible-editor: AMO tn → master (#100)");
  // A human revert that QUOTES the subject must not count as the merge (classification human).
  snapshot(sqlite, "HOS", "tn", 103, NOW - 3 * DAY);
  ledgerCommit(sqlite, "en_tn", "r103", NOW - 2 * DAY, 'Revert "bible-editor: HOS tn → master (#103)"', "human");
  REPO_OF[103] = "en_tn";

  // open under a day → not flagged.
  snapshot(sqlite, "ZEC", "tn", 101, NOW - 2 * HOUR);
  REPO_OF[101] = "en_tn";

  // open over a day → waiting. A later non-`unchanged` skip (no PR) must not
  // hide it (an `unchanged` does — see the B1 case below).
  snapshot(sqlite, "JER", "ult", 200, NOW - 2 * DAY);
  snapshot(sqlite, "JER", "ult", null, NOW - HOUR, { error: "book_locked:explicit" });
  REPO_OF[200] = "en_ult";

  // closed, never merged → rejected.
  snapshot(sqlite, "DAN", "tq", 300, NOW - 2 * DAY);

  // closed, merged, but the ledger missed it (gap) → live master walk finds it.
  snapshot(sqlite, "EZK", "tn", 102, NOW - 2 * DAY);

  // open, validation failed → rejected even though it is only an hour old.
  snapshot(sqlite, "ISA", "twl", 400, NOW - HOUR);
  REPO_OF[400] = "en_twl";

  // an older PR for the same pair is irrelevant — only the newest PR-bearing export counts.
  snapshot(sqlite, "ISA", "twl", 399, NOW - 5 * DAY);

  const calls = mockDoor43({
    open: {
      en_tn: [openPr(101, "ZEC-be-test"), openPr(103, "HOS-be-test")],
      en_ult: [openPr(200, "JER-be-test")],
      en_twl: [openPr(400, "ISA-be-test")],
    },
    pr: { 300: { state: "closed", merged: false }, 102: { state: "closed", merged: false } },
    status: { head101: "success", head103: "success", head200: "pending", head400: "failure" },
    history: {
      "tq_DAN.tsv": [
        giteaCommit("h1", NOW - DAY, "Update tq_DAN.tsv"),
        giteaCommit("old", NOW - 10 * DAY, "bible-editor: DAN tq → master (#250)"),
      ],
      "tn_EZK.tsv": [
        giteaCommit("m102", NOW - 2 * DAY + 60, "bible-editor: EZK tn → master (#102)"),
        giteaCommit("old", NOW - 10 * DAY, "older"),
      ],
    },
  });

  const res = await computeExportMergeFlags(env, NOW);
  const byKey = Object.fromEntries(res.flags.map((f) => [`${f.book}/${f.resource}`, f]));

  eq(Object.keys(byKey).sort(), ["DAN/tq", "HOS/tn", "ISA/twl", "JER/ult"], "flags exactly the rejected and >1-day-waiting exports");
  eq(
    byKey["JER/ult"] && { state: byKey["JER/ult"].state, pr: byKey["JER/ult"].prNumber, at: byKey["JER/ult"].exportedAt },
    { state: "waiting", pr: 200, at: NOW - 2 * DAY },
    "JER ult: open over a day → waiting, carrying the PR and export time of the newest PR-bearing export",
  );
  eq(
    byKey["DAN/tq"] && [byKey["DAN/tq"].state, byKey["DAN/tq"].reason],
    ["rejected", "closed_unmerged"],
    "DAN tq: closed with no squash commit → rejected (closed_unmerged)",
  );
  eq(
    byKey["ISA/twl"] && [byKey["ISA/twl"].state, byKey["ISA/twl"].reason, byKey["ISA/twl"].prNumber],
    ["rejected", "validation_failed", 400],
    "ISA twl: open with failed validation → rejected, newest PR (#400) not the older #399",
  );
  eq(
    byKey["HOS/tn"] && byKey["HOS/tn"].state,
    "waiting",
    "HOS tn: a human revert quoting (#103) is not the merge; still open over a day → waiting",
  );
  eq(byKey["DAN/tq"]?.url, "https://dcs.test/unfoldingWord/en_tq/pulls/300", "flag links to the Door43 PR");
  eq(res.unchecked, [], "nothing left unchecked");
  eq(res.errors, [], "no lookup errors");
  eq(
    calls.some((c) => c.includes("/en_ust/")),
    false,
    "no Door43 fetch for a repo with nothing unresolved",
  );
  eq(
    calls.some((c) => c.includes("path=tn_AMO.tsv")),
    false,
    "a ledger-proven merge costs no master walk",
  );
}

{
  // Budget: past MERGE_LIVE_LOOKUP_CAP unresolved exports, the rest are reported
  // unchecked rather than fetched.
  const { sqlite, env } = freshEnv();
  const books = ["GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM"];
  books.forEach((b, i) => snapshot(sqlite, b, "tn", 1000 + i, NOW - 2 * DAY + i));
  const pr = Object.fromEntries(books.map((_, i) => [1000 + i, { state: "closed", merged: false }]));
  const calls = mockDoor43({ open: {}, pr, history: {} });
  const res = await computeExportMergeFlags(env, NOW);
  const perExport = calls.filter((c) => c.includes("/commits?") || /\/pulls\/\d+$/.test(c)).length;
  eq(perExport <= MERGE_LIVE_LOOKUP_CAP * 3, true, `per-export reads bounded by the cap (${perExport} ≤ ${MERGE_LIVE_LOOKUP_CAP * 3})`);
  eq(res.unchecked.length, books.length - MERGE_LIVE_LOOKUP_CAP, "exports past the cap are reported unchecked");
  eq(res.unchecked[0]?.reason, "lookup_budget", "…with the budget as the stated reason");
}

{
  // A failed open-PR list AND a failed single-PR read leave the export unchecked, never flagged.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "JER", "ult", 200, NOW - 2 * DAY);
  mockDoor43({ failList: new Set(["en_ult"]) });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "list failure → no flag invented");
  eq(res.unchecked.map((u) => [u.book, u.resource, u.reason]), [["JER", "ult", "pr_lookup_failed"]], "…reported unchecked");
  eq(res.errors.length, 1, "…and the repo error surfaced");
}

{
  // B1: the pipeline itself closes a lingering PR when a later render matches
  // master, and records an `unchanged` snapshot with no PR
  // (exportWorkflow.ts's `!commit.branchTouched` path). That pair is fine: no
  // flag and no Door43 read at all.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "OBA", "tn", 500, NOW - 3 * DAY);
  snapshot(sqlite, "OBA", "tn", null, NOW - DAY, { error: "unchanged" });
  const calls = mockDoor43({ open: { en_tn: [] }, pr: { 500: { state: "closed", merged: false } } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "B1: PR closed by our own pipeline after an `unchanged` render → not rejected");
  eq(res.unchecked, [], "B1: …and not unchecked either");
  eq(
    calls.filter((c) => !c.includes("/pulls?")).length,
    0,
    "C1: absent from the open-PR list → no single-PR GET, no walk, no status read",
  );
}

{
  // C1: the pipeline's closeDcsPr can fail silently (no throw on non-2xx), so
  // an `unchanged` after the PR does not prove the PR closed. If it is still
  // in the open list, it is judged as open.
  const { sqlite, env } = freshEnv();
  REPO_OF[501] = "en_tn";
  snapshot(sqlite, "OBA", "tn", 501, NOW - 3 * DAY);
  snapshot(sqlite, "OBA", "tn", null, NOW - DAY, { error: "unchanged" });
  const calls = mockDoor43({ open: { en_tn: [openPr(501, "OBA-be-test")] }, status: { head501: "pending" } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags.map((f) => [f.book, f.state, f.exportedAt]), [["OBA", "waiting", NOW - 3 * DAY]], "C1: still open after `unchanged` → waiting from its opened time");
  eq(calls.some((c) => c.includes("/commits?")), false, "C1: …and no closed-PR walk");
}

{
  // C1: same, with failed validation → rejected.
  const { sqlite, env } = freshEnv();
  REPO_OF[502] = "en_tn";
  snapshot(sqlite, "OBA", "tn", 502, NOW - 2 * HOUR);
  snapshot(sqlite, "OBA", "tn", null, NOW - HOUR, { error: "unchanged" });
  mockDoor43({ open: { en_tn: [openPr(502, "OBA-be-test")] }, status: { head502: "failure" } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags.map((f) => [f.state, f.reason]), [["rejected", "validation_failed"]], "C1: still open after `unchanged`, validation failed → rejected");
}

{
  // C1: `unchanged` after the PR, but the open list itself failed → unchecked, not guessed either way.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "OBA", "tn", 503, NOW - 3 * DAY);
  snapshot(sqlite, "OBA", "tn", null, NOW - DAY, { error: "unchanged" });
  mockDoor43({ failList: new Set(["en_tn"]) });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "C1: list failed → no flag");
  eq(res.unchecked.map((u) => u.reason), ["open_pr_list_failed"], "C1: …unchecked, naming the failed list");
}

// C2: a hung Door43 call must not hang /merge-flags. `hangOn` never answers
// unless the caller's AbortSignal fires. Each case is raced against a guard so
// a missing timeout fails the test instead of stalling it.
function withGuard(promise, ms = 3000) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("HUNG"), ms))]);
}
function hangFetch(inner, hangOn) {
  const base = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input).includes(hangOn)) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      });
    }
    return base(input, init);
  };
  return inner;
}

{
  // C2: a hung open-PR list → its `unchanged`-after exports unchecked with a reason.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "OBA", "tn", 504, NOW - 3 * DAY);
  snapshot(sqlite, "OBA", "tn", null, NOW - DAY, { error: "unchanged" });
  hangFetch(mockDoor43({}), "/en_tn/pulls?");
  const res = await withGuard(computeExportMergeFlags(env, NOW, { timeoutMs: 200 }));
  eq(res === "HUNG" ? "HUNG" : res.unchecked.map((u) => u.reason), ["open_pr_list_failed"], "C2: hung list times out → unchecked");
}

{
  // C2: a hung status read → treated as unknown; the open PR is judged on age only.
  const { sqlite, env } = freshEnv();
  REPO_OF[505] = "en_ult";
  snapshot(sqlite, "RUT", "ult", 505, NOW - 2 * DAY);
  hangFetch(mockDoor43({ open: { en_ult: [openPr(505, "RUT-be-test")] } }), "/commits/head505/status");
  const res = await withGuard(computeExportMergeFlags(env, NOW, { timeoutMs: 200 }));
  eq(res === "HUNG" ? "HUNG" : res.flags.map((f) => f.state), ["waiting"], "C2: hung status times out → open over a day → waiting");
}

{
  // B1 converse: an `unchanged` OLDER than the PR says nothing about the PR.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "OBA", "tn", null, NOW - 4 * DAY, { error: "unchanged" });
  snapshot(sqlite, "OBA", "tn", 500, NOW - 3 * DAY);
  mockDoor43({ pr: { 500: { state: "closed", merged: false } }, history: { "tn_OBA.tsv": [] } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags.map((f) => [f.book, f.state]), [["OBA", "rejected"]], "B1: an older `unchanged` does not excuse a newer PR");
}

{
  // B2: every night re-pushes an open PR and records a fresh snapshot with
  // the SAME pr_number, so the newest snapshot is always young. Waiting is
  // measured from when the PR was opened.
  const { sqlite, env } = freshEnv();
  REPO_OF[600] = "en_ult";
  for (let d = 5; d >= 1; d--) snapshot(sqlite, "RUT", "ult", 600, NOW - d * DAY);
  snapshot(sqlite, "RUT", "ult", 600, NOW - HOUR);
  mockDoor43({ open: { en_ult: [openPr(600, "RUT-be-test")] }, status: { head600: "pending" } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(
    res.flags.map((f) => [f.book, f.state, f.exportedAt]),
    [["RUT", "waiting", NOW - 5 * DAY]],
    "B2: PR open 5 days, newest snapshot 1 hour old → waiting, dated from the first export carrying it",
  );
}

{
  // B2: Door43's created_at wins when it is older than our first snapshot.
  const { sqlite, env } = freshEnv();
  REPO_OF[601] = "en_ult";
  snapshot(sqlite, "RUT", "ult", 601, NOW - HOUR);
  mockDoor43({ open: { en_ult: [openPr(601, "RUT-be-test", NOW - 3 * DAY)] }, status: { head601: "pending" } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags.map((f) => [f.state, f.exportedAt]), [["waiting", NOW - 3 * DAY]], "B2: PR created_at 3 days ago → waiting");
}

{
  // B3: overlapping exports can insert snapshots out of order. The newest PR
  // (highest number — Gitea numbers PRs in creation order per repo) wins.
  const { sqlite, env } = freshEnv();
  REPO_OF[701] = "en_tn";
  snapshot(sqlite, "JOL", "tn", 701, NOW - 2 * HOUR);
  snapshot(sqlite, "JOL", "tn", 700, NOW - HOUR); // older run, recorded later
  const calls = mockDoor43({ open: { en_tn: [openPr(701, "JOL-be-test")] }, status: { head701: "success" } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "B3: newest PR #701 (open, fresh) wins over late-recorded #700");
  eq(calls.some((c) => c.includes("/pulls/700")), false, "B3: …and #700 is never looked up");
}

{
  // B4: the ledger and master walk read unfoldingWord's repos. With another
  // export owner, a closed PR cannot be judged from them → unchecked.
  const { sqlite, env } = freshEnv();
  env.DCS_EXPORT_OWNER = "someFork";
  snapshot(sqlite, "NAM", "tq", 800, NOW - 2 * DAY);
  ledgerCommit(sqlite, "en_tq", "m800", NOW - 2 * DAY + 60, "bible-editor: NAM tq → master (#800)");
  const calls = mockDoor43({ pr: { 800: { state: "closed", merged: false } } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "B4: foreign export owner → no flag");
  eq(res.unchecked.map((u) => u.reason), ["owner_mismatch"], "B4: …unchecked, naming the owner mismatch");
  eq(calls.some((c) => c.includes("/commits?")), false, "B4: …and no walk of the wrong repo");
}

{
  // B5: a PR missing from the open-PR list (the list is capped and can be
  // truncated) is confirmed with its own GET before any closed-path verdict.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "MAL", "ult", 900, NOW - 2 * DAY);
  mockDoor43({
    open: { en_ult: [] },
    pr: { 900: { state: "open", merged: false, head: { sha: "head900" } } },
    status: { head900: "pending" },
  });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags.map((f) => [f.book, f.state]), [["MAL", "waiting"]], "B5: open per its own GET → waiting, not rejected");
}

{
  // B6: a maintainer's merge-commit merge is classified human by the master
  // walk, but Gitea reports it merged:true — trusted as merged.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "HAG", "tn", 950, NOW - 2 * DAY);
  const calls = mockDoor43({ pr: { 950: { state: "closed", merged: true } } });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "B6: closed with merged:true → merged, no flag");
  eq(calls.some((c) => c.includes("/commits?")), false, "B6: …no master walk needed");
}

{
  // B7: one export's transport failure must not fail the whole response.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "JON", "tq", 555, NOW - 2 * DAY);
  snapshot(sqlite, "DAN", "tq", 300, NOW - 2 * DAY);
  mockDoor43({
    pr: { 300: { state: "closed", merged: false } },
    history: { "tq_DAN.tsv": [] },
    throwOn: "/pulls/555",
  });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags.map((f) => f.book), ["DAN"], "B7: the other export is still classified");
  eq(res.unchecked.map((u) => [u.book, u.reason]), [["JON", "lookup_failed"]], "B7: the throwing one is unchecked");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall exportMergeState tests passed");

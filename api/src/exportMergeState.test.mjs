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
function openPr(number, branch) {
  return {
    number,
    title: `bible-editor: ${branch}`,
    state: "open",
    head: { ref: branch, sha: `head${number}`, repo: { full_name: `unfoldingWord/${REPO_OF[number]}` } },
    base: { ref: "master" },
    html_url: `https://dcs.test/pr/${number}`,
  };
}
const REPO_OF = {};

// Door43 mock. `open[repo]` = open PRs; `status[sha]` = combined state;
// `history[path]` = newest-first commits on master for that file.
function mockDoor43({ open = {}, status = {}, history = {}, failList = new Set() }) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (body, headers = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    let m;
    if ((m = url.pathname.match(/\/repos\/unfoldingWord\/([^/]+)\/pulls$/))) {
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

  // open over a day → waiting. A later "unchanged" skip (no PR) must not hide it.
  snapshot(sqlite, "JER", "ult", 200, NOW - 2 * DAY);
  snapshot(sqlite, "JER", "ult", null, NOW - HOUR, { error: "unchanged" });
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
  const calls = mockDoor43({ open: {}, history: {} });
  const res = await computeExportMergeFlags(env, NOW);
  const walks = calls.filter((c) => c.includes("/commits?")).length;
  eq(walks <= MERGE_LIVE_LOOKUP_CAP * 2, true, `master walks bounded by the cap (${walks} ≤ ${MERGE_LIVE_LOOKUP_CAP * 2})`);
  eq(res.unchecked.length, books.length - MERGE_LIVE_LOOKUP_CAP, "exports past the cap are reported unchecked");
  eq(res.unchecked[0]?.reason, "lookup_budget", "…with the budget as the stated reason");
}

{
  // A failed open-PR list for one repo leaves that repo's exports unchecked, never flagged.
  const { sqlite, env } = freshEnv();
  snapshot(sqlite, "JER", "ult", 200, NOW - 2 * DAY);
  mockDoor43({ failList: new Set(["en_ult"]) });
  const res = await computeExportMergeFlags(env, NOW);
  eq(res.flags, [], "list failure → no flag invented");
  eq(res.unchecked.map((u) => [u.book, u.resource, u.reason]), [["JER", "ult", "open_pr_list_failed"]], "…reported unchecked");
  eq(res.errors.length, 1, "…and the repo error surfaced");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall exportMergeState tests passed");

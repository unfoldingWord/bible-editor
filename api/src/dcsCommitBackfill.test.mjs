// Unit tests for the dcs_repo_polls gap backfill (dcsCommitBackfill.ts,
// issue #692 item 2). Stubs global fetch and D1, same shapes as
// dcsCommitPoll.test.mjs. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsCommitBackfill.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DCS_BACKFILL_PAGE_LIMIT, backfillDcsGaps, backfillDcsRepoGap } from "./dcsCommitBackfill.ts";
import { DCS_POLL_WRITE_BATCH, INSERT_COMMIT_SQL } from "./dcsCommitPoll.ts";
import { TRACKED_DCS_REPOS } from "./dcsSources.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = 1_760_000_000;

// ── mock Gitea, same shape as dcsCommitPoll.test.mjs's mockGitea ───────────
function mockGitea(pages) {
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const body = pages[page - 1] ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k) => {
          const key = k.toLowerCase();
          if (key === "x-hasmore") return String(page < pages.length);
          if (key === "x-pagecount") return String(pages.length);
          return null;
        },
      },
      json: async () => body,
    };
  };
  return seenUrls;
}

function commit(sha, message, email, { name = "Someone", date = "2026-08-30T12:00:00Z", parent = null } = {}) {
  return {
    sha,
    commit: { message, author: { email, name, date } },
    author: null,
    parents: parent ? [{ sha: parent }] : [],
    files: [{ filename: "tn_ZEC.tsv", status: "modified" }],
  };
}

function fullPage(prefix, { lastParent = null } = {}) {
  return Array.from({ length: 50 }, (_, i) =>
    i === 49
      ? commit(`${prefix}49`, `hand fix ${prefix}49`, "h@x", { parent: lastParent })
      : commit(`${prefix}${i}`, `hand fix ${prefix}${i}`, "h@x"),
  );
}

// ── mock D1. Only the three statement shapes backfillDcsRepoGap issues:
// the gap-state SELECT (`.first()`), the chunked ledger INSERTs (`.batch()`),
// and the gap-resolution UPDATE (`.run()`). Same D1 batch cap enforcement as
// dcsCommitPoll.test.mjs's mock — a mock that accepts an over-cap batch is
// not testing what production would actually do.
const D1_MAX_BATCH_STATEMENTS = 100;

function mockDb(stateRow) {
  const executed = [];
  const runs = [];
  const stmt = (sql) => ({
    sql,
    args: null,
    bind(...args) {
      return { ...this, args };
    },
    async first() {
      return stateRow ?? null;
    },
    async run() {
      runs.push({ sql: this.sql, args: this.args });
      return { success: true };
    },
  });
  return {
    executed,
    runs,
    prepare(sql) {
      return stmt(sql);
    },
    async batch(list) {
      if (list.length > D1_MAX_BATCH_STATEMENTS) {
        throw new Error(`D1_ERROR: too many statements in batch (${list.length} > ${D1_MAX_BATCH_STATEMENTS})`);
      }
      for (const s of list) executed.push({ sql: s.sql, args: s.args });
      return list.map(() => ({ success: true }));
    },
  };
}

function inserts(db) {
  return db.executed.filter((e) => e.sql === INSERT_COMMIT_SQL);
}
function clearRun(db) {
  return db.runs.find((r) => r.sql.includes("SET gap_since_sha = NULL"));
}
function advanceRun(db) {
  return db.runs.find((r) => r.sql.includes("SET gap_from_sha ="));
}

async function main() {
  // ── no gap: cheap no-op, no fetch at all ──────────────────────────────────
  {
    const db = mockDb({ gap_since_sha: null, gap_from_sha: null });
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("must not be called");
    };
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.attempted === false && res.status === "no_gap", "a repo with no gap is skipped");
    assert(!fetched, "  ...and costs zero Door43 fetches — just the one D1 read");
  }

  // ── gap_from_sha missing (defensive: pre-migration row, or a root gap) ────
  {
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: null });
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("must not be called");
    };
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "no_from_sha", "a gap with no known start point is dropped, not retried forever");
    assert(!fetched, "  ...without spending a fetch, since there is nowhere to start walking from");
    const clr = clearRun(db);
    assert(clr && clr.args[0] === "en_tn" && clr.args[1] === "far-edge", "  ...clearing all three gap columns for this exact gap");
  }

  // ── the hole fits in one tick's budget: reaches gap_since_sha and resolves ─
  {
    mockGitea([[commit("h1", "hand fix", "h@x"), commit("far-edge", "old", "h@x")]]);
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: "near-edge" });
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "ok", "reaching gap_since_sha resolves the gap");
    assert(res.inserted === 1 && inserts(db).length === 1, "  ...inserting exactly the one commit inside the hole");
    const clr = clearRun(db);
    assert(clr && clr.args[1] === "far-edge", "  ...and clears the gap, guarded on the gap_since_sha it walked against");
  }

  // ── the hole is bigger than one tick's budget: page_cap, resume recorded ──
  // Only the LAST page fetched (the DCS_BACKFILL_PAGE_LIMIT-th) supplies the
  // oldest row, so that is the one whose parent becomes the new frontier —
  // an earlier page's last commit is irrelevant here.
  {
    const pages = Array.from({ length: DCS_BACKFILL_PAGE_LIMIT + 1 }, (_, i) =>
      i === DCS_BACKFILL_PAGE_LIMIT - 1 ? fullPage(`p${i}`, { lastParent: "the-frontier" }) : fullPage(`p${i}`),
    );
    const urls = mockGitea(pages);
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: "near-edge" });
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(urls.length === DCS_BACKFILL_PAGE_LIMIT, `spends only ${DCS_BACKFILL_PAGE_LIMIT} pages per repo per tick`);
    assert(res.resolved === false && res.status === "page_cap", "did not reach the far edge this tick");
    assert(res.inserted === DCS_BACKFILL_PAGE_LIMIT * 50, "  ...but still inserts everything it DID walk");
    assert(!clearRun(db), "  ...and does NOT clear the gap — the hole is still open");
    const adv = advanceRun(db);
    assert(adv && adv.args[2] === "the-frontier", "  ...instead moving gap_from_sha to the new frontier for next tick");
    assert(adv.args[0] === "en_tn" && adv.args[1] === "far-edge" && adv.args[3] === "near-edge", "  ...guarded on both the gap and the OLD gap_from_sha");
  }

  // ── a bootstrap-shaped gap: gap_since_sha is never an ancestor of the chain
  // being walked (see dcsCommitBackfill.ts's BOOTSTRAP GAPS), so the walk runs
  // to the true end of history and resolves via source_sha_not_in_history —
  // the same signal a force-pushed far edge would produce.
  {
    mockGitea([[commit("root", "genesis", "h@x")]]);
    const db = mockDb({ gap_since_sha: "never-an-ancestor", gap_from_sha: "root" });
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "source_sha_not_in_history", "reaching true history root resolves the gap too");
    assert(res.inserted === 1, "  ...having inserted the root commit itself");
    assert(clearRun(db), "  ...and clears the gap: nothing more exists below it to find");
  }

  // ── page_cap where the oldest row IS a repo root (no parent): nowhere left
  // to advance to, so resolve rather than retry a walk that can never move ──
  {
    // One page beyond the budget so the server's own "more pages exist"
    // signal stays true through the last FETCHED page — the walk stops on
    // the BUDGET (page_cap), not on the server's own end-of-history — even
    // though that fetched page's last commit happens to have no parent.
    const pages = Array.from({ length: DCS_BACKFILL_PAGE_LIMIT + 1 }, (_, i) =>
      i === DCS_BACKFILL_PAGE_LIMIT - 1 ? fullPage(`p${i}`, { lastParent: null }) : fullPage(`p${i}`),
    );
    mockGitea(pages);
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: "near-edge" });
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "reached_root", "a full page ending in a parentless commit resolves as reached_root");
    assert(clearRun(db), "  ...clearing the gap rather than looping on a frontier that cannot move");
  }

  // ── transport failure: nothing resolved, nothing advanced, safe to retry ──
  {
    globalThis.fetch = async () => {
      throw new Error("network");
    };
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: "near-edge" });
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === false && res.status === "fetch_failed", "a thrown fetch reports fetch_failed, not a resolution");
    assert(!clearRun(db) && !advanceRun(db), "  ...and touches neither gap column — the next tick retries the same range");
  }

  // ── D1's 100-statement batch cap is respected even at the backfill's own
  // page budget (2 × 50 = 100 rows would be exactly the cap in one batch;
  // DCS_POLL_WRITE_BATCH chunks well under it) ──────────────────────────────
  {
    const pages = [fullPage("x"), fullPage("y")];
    mockGitea(pages);
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: "near-edge" });
    await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(inserts(db).length === 100, "both full pages are inserted");
    assert(DCS_BACKFILL_PAGE_LIMIT * 50 > DCS_POLL_WRITE_BATCH, "  ...sanity: this scenario really does exceed one write-batch chunk");
  }

  // ── ordering: inserts land oldest-first, same discipline as the poller ───
  {
    mockGitea([[commit("new", "hand fix", "h@x"), commit("old", "hand fix", "h@x")]]);
    const db = mockDb({ gap_since_sha: "far-edge", gap_from_sha: "old-plus-one" });
    await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    const ins = inserts(db);
    assert(ins[0].args[1] === "old" && ins[1].args[1] === "new", "inserts go out oldest-first");
  }

  // ── backfillDcsGaps: loops every tracked repo, isolates a per-repo error ──
  {
    globalThis.fetch = async () => {
      throw new Error("boom");
    };
    const dbs = {};
    const envs = {};
    for (const repo of TRACKED_DCS_REPOS) {
      dbs[repo] = mockDb(repo === "en_ult" ? { gap_since_sha: null, gap_from_sha: null } : { gap_since_sha: "g", gap_from_sha: "f" });
      envs[repo] = { DB: dbs[repo] };
    }
    // backfillDcsGaps takes ONE env, so exercise it against a single DB whose
    // `.first()` cycles through repos in TRACKED_DCS_REPOS order — mirroring
    // how the real cron entry point is called once per invocation with one
    // env.DB shared across all five repos.
    let callIndex = 0;
    const sharedDb = {
      executed: [],
      runs: [],
      prepare(sql) {
        return {
          sql,
          args: null,
          bind(...args) {
            return { ...this, args };
          },
          async first() {
            const repo = TRACKED_DCS_REPOS[callIndex++];
            return repo === "en_ult" ? { gap_since_sha: null, gap_from_sha: null } : { gap_since_sha: "g", gap_from_sha: "f" };
          },
          async run() {
            return { success: true };
          },
        };
      },
      async batch(list) {
        return list.map(() => ({ success: true }));
      },
    };
    const results = await backfillDcsGaps({ DB: sharedDb }, NOW);
    assert(results.length === TRACKED_DCS_REPOS.length, "backfillDcsGaps reports one result per tracked repo");
    assert(results.find((r) => r.repo === "en_ult").status === "no_gap", "  ...en_ult had no gap");
    assert(
      results.filter((r) => r.repo !== "en_ult").every((r) => r.status === "error" || r.status === "fetch_failed"),
      "  ...every other repo's failing fetch is caught and reported, not thrown",
    );
  }

  console.log("dcsCommitBackfill: all assertions passed");
}

await main();

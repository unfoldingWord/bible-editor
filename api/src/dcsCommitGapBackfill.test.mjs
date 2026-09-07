// Unit tests for the dcs_repo_polls gap backfill (dcsCommitPoll.ts, issue
// #692 item 2). Same style, same mock-Gitea/mock-D1 shapes as
// dcsCommitPoll.test.mjs (that file's own doc comment explains why they're
// shaped the way they are — measured against git.door43.org). Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsCommitGapBackfill.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DCS_BACKFILL_PAGE_LIMIT, backfillDcsGaps, backfillDcsRepoGap } from "./dcsCommitPoll.ts";
import { TRACKED_DCS_REPOS } from "./dcsSources.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = 1_760_000_000;

// ── mock Gitea — identical shape to dcsCommitPoll.test.mjs's own helper ────
function mockGitea(pages, { fail = null } = {}) {
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(url);
    if (fail && seenUrls.length >= fail.onCall) {
      if (fail.kind === "throw") throw new Error("network");
      return { ok: false, status: fail.status ?? 502, headers: { get: () => null }, json: async () => [] };
    }
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

function commit(sha, message, email, { name = "Someone", date = "2026-08-30T12:00:00Z", parent = null, files = ["tn_ZEC.tsv"] } = {}) {
  return {
    sha,
    commit: { message, author: { email, name, date } },
    author: null,
    parents: parent ? [{ sha: parent }] : [],
    files: files == null ? undefined : files.map((f) => ({ filename: f, status: "modified" })),
  };
}

// DCS_BACKFILL_PAGE_LIMIT (2) pages, 50/page, fixed server-side.
function fullPage(prefix) {
  return Array.from({ length: 50 }, (_, i) => commit(`${prefix}${i}`, `hand fix ${prefix}${i}`, "h@x"));
}

// ── mock D1 — identical shape (and the same enforced 100-statement cap) ────
const D1_MAX_BATCH_STATEMENTS = 100;

function mockDb(stateRow) {
  const executed = [];
  const batchSizes = [];
  const stmt = (sql) => ({
    sql,
    args: null,
    bind(...args) {
      return { ...this, args };
    },
    async first() {
      return stateRow ?? null;
    },
    async all() {
      return { results: [] };
    },
    async run() {
      executed.push({ sql: this.sql, args: this.args, viaRun: true });
      return { success: true };
    },
  });
  return {
    executed,
    batchSizes,
    prepare(sql) {
      return stmt(sql);
    },
    async batch(list) {
      if (list.length > D1_MAX_BATCH_STATEMENTS) {
        throw new Error(`D1_ERROR: too many statements in batch (${list.length} > ${D1_MAX_BATCH_STATEMENTS})`);
      }
      batchSizes.push(list.length);
      for (const s of list) executed.push({ sql: s.sql, args: s.args });
      return list.map(() => ({ success: true }));
    },
  };
}

function inserts(db) {
  return db.executed.filter((e) => e.sql.includes("INSERT INTO dcs_commits"));
}
function clearStmt(db) {
  return db.executed.find((e) => e.sql.includes("gap_since_sha = NULL"));
}
function advanceStmt(db) {
  return db.executed.find((e) => e.sql.includes("SET gap_backfill_sha = ?2"));
}

async function main() {
  // ── no active gap: one D1 read, ZERO fetches ──────────────────────────────
  {
    globalThis.fetch = async () => {
      throw new Error("must not fetch when there is no gap");
    };
    const db = mockDb({ repo: "en_tn", gap_since_sha: null, gap_kind: null, gap_backfill_sha: null });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    assert(res.active === false && res.status === "no_gap", "a repo with no gap is reported inactive");
    assert(res.fetched === 0 && res.gapClosed === false, "  ...and makes no fetches, closes nothing");
    assert(db.executed.length === 0, "  ...and writes nothing to D1 either");
  }

  // ── a gap recorded before this migration (no cursor): skipped, not guessed ─
  {
    globalThis.fetch = async () => {
      throw new Error("must not fetch with no recorded cursor");
    };
    const db = mockDb({ repo: "en_tn", gap_since_sha: "some-old-hole", gap_kind: null, gap_backfill_sha: null });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    assert(res.status === "missing_cursor" && res.active === false, "a gap with no stored cursor is left alone, not guessed at");
  }

  // ── "range" gap that CLOSES within the page budget ────────────────────────
  {
    const pages = [[commit("mid1", "hand fix", "h@x"), commit("root", "old", "h@x")]];
    mockGitea(pages);
    const db = mockDb({ repo: "en_tn", gap_since_sha: "root", gap_kind: "range", gap_backfill_sha: "cursor1" });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    assert(res.active === true && res.status === "resolved" && res.gapClosed === true, "reaching the target resolves the gap");
    assert(inserts(db).length === 1, "  ...inserting the one new commit found before the target (mid1; root is excluded, already known)");
    assert(
      inserts(db).every((s) => /ON CONFLICT \(repo, sha\) DO NOTHING/.test(s.sql)),
      "  ...via the same ON CONFLICT DO NOTHING as the forward poller",
    );
    const clear = clearStmt(db);
    assert(clear != null, "  ...and the trailing statement clears all five gap columns");
    assert(clear.args[0] === "en_tn", "  ...for the right repo");
    assert(advanceStmt(db) == null, "  ...no separate cursor-advance statement when the gap fully closed");
  }

  // ── "range" gap that does NOT close in one tick (still page-capped) ──────
  {
    // More full pages than DCS_BACKFILL_PAGE_LIMIT (2), and the target sha
    // never appears within that budget.
    const pages = [fullPage("a"), fullPage("b"), fullPage("c")];
    mockGitea(pages);
    const db = mockDb({ repo: "en_tq", gap_since_sha: "never-seen-in-budget", gap_kind: "range", gap_backfill_sha: "cursor1" });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tq", NOW);
    assert(res.status === "page_cap" && res.gapClosed === false, "still page-capped: the gap stays open");
    assert(res.inserted === DCS_BACKFILL_PAGE_LIMIT * 50, `  ...having ingested ${DCS_BACKFILL_PAGE_LIMIT} pages worth`);
    assert(clearStmt(db) == null, "  ...no clear statement — gap_since_sha/gap_kind are untouched");
    const advance = advanceStmt(db);
    assert(advance != null, "  ...but the cursor DOES advance, to resume from here next tick");
    assert(advance.args[0] === "en_tq" && advance.args[1] === "b49" && advance.args[2] === NOW, "  ...to this walk's own oldest-fetched sha");
  }

  // ── "open" gap that reaches TRUE end-of-history within budget ────────────
  {
    // A short final page (X-HasMore: false after it) under the sinceTime=0
    // bound this function uses for an 'open' gap is exactly "no more history".
    const pages = [[commit("root2", "oldest known commit", "h@x")]];
    mockGitea(pages);
    const db = mockDb({ repo: "en_ust", gap_since_sha: "root2", gap_kind: "open", gap_backfill_sha: "root2" });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_ust", NOW);
    assert(res.status === "resolved" && res.gapClosed === true, "reaching the true end of history resolves an 'open' gap");
    const clear = clearStmt(db);
    assert(clear != null && clear.args[0] === "en_ust", "  ...and fully clears it");
  }

  // ── "open" gap that does NOT reach end-of-history in budget ──────────────
  {
    const pages = [fullPage("x"), fullPage("y"), fullPage("z")];
    mockGitea(pages);
    const db = mockDb({ repo: "en_ult", gap_since_sha: "frontier0", gap_kind: "open", gap_backfill_sha: "frontier0" });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_ult", NOW);
    assert(res.status === "page_cap" && res.gapClosed === false, "an 'open' gap still page-capped stays open");
    assert(advanceStmt(db) != null, "  ...and its cursor still advances the same way a 'range' gap's does");
  }

  // ── source_sha_not_in_history mid-backfill: GIVE UP, force-clear, no crash ─
  {
    // History was rewritten under us: the walk reaches the true end without
    // ever seeing the recorded target.
    const pages = [[commit("someone-else", "unrelated", "h@x")]];
    mockGitea(pages);
    const db = mockDb({ repo: "en_twl", gap_since_sha: "rewritten-away", gap_kind: "range", gap_backfill_sha: "cursor1" });
    const realError = console.error;
    let loggedGiveUp = false;
    console.error = (...args) => {
      if (String(args[0] ?? "").includes("giving up")) loggedGiveUp = true;
    };
    let threw = false;
    let res;
    try {
      res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_twl", NOW);
    } catch {
      threw = true;
    } finally {
      console.error = realError;
    }
    assert(!threw, "an unreachable target does not throw");
    assert(res.status === "gave_up_unreachable" && res.gapClosed === true, "the gap force-clears rather than retrying forever");
    assert(clearStmt(db) != null, "  ...via the same clear statement as a genuine resolution");
    assert(loggedGiveUp, "  ...and the give-up is logged (visible in wrangler tail)");
  }

  // ── transport failure mid-backfill: gap stays open, cursor untouched ─────
  {
    mockGitea([fullPage("a")], { fail: { onCall: 1, kind: "throw" } });
    const db = mockDb({ repo: "en_tn", gap_since_sha: "root", gap_kind: "range", gap_backfill_sha: "cursor1" });
    let threw = false;
    let res;
    try {
      res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    } catch {
      threw = true;
    }
    assert(!threw, "a network throw is caught inside listMasterCommitsSince, not propagated");
    assert(res.gapClosed === false, "  ...the gap stays open");
    assert(clearStmt(db) == null && advanceStmt(db) == null, "  ...and NEITHER the clear nor the advance statement runs");
    assert(inserts(db).length === 0, "  ...nothing to insert either, since the very first fetch failed");
  }

  // ── a partial page still gets inserted on a transport failure ────────────
  {
    mockGitea([fullPage("a"), fullPage("b")], { fail: { onCall: 2, kind: "http", status: 502 } });
    const db = mockDb({ repo: "en_tq", gap_since_sha: "root", gap_kind: "range", gap_backfill_sha: "cursor1" });
    const res = await backfillDcsRepoGap({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tq", NOW);
    assert(res.status === "http_502" && res.gapClosed === false, "a 502 on page 2 reports http_502, gap stays open");
    assert(inserts(db).length === 50, "  ...but page 1's commits are still recorded (rows are keyed, so this is safe)");
    assert(advanceStmt(db) == null, "  ...without moving the cursor — the next tick retries the same range");
  }

  // ── the driver loops ALL tracked repos and isolates one repo's failure ───
  {
    // Every tracked repo gets an active 'range' gap that resolves in one
    // fetch — except en_tn, whose fetch always throws. A DB keyed by the
    // bound repo (every statement here binds repo as its first arg) stands
    // in for D1 holding per-repo state, so this actually exercises
    // backfillDcsGaps looping TRACKED_DCS_REPOS rather than one repo N times.
    const states = {};
    for (const repo of TRACKED_DCS_REPOS) {
      states[repo] = { gap_since_sha: "root", gap_kind: "range", gap_backfill_sha: "cursor1" };
    }
    globalThis.fetch = async (url) => {
      if (url.includes("/en_tn/")) throw new Error("boom");
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "x-hasmore" ? "false" : null) },
        json: async () => [commit("root", "old", "h@x")],
      };
    };
    const executed = [];
    const db = {
      prepare(sql) {
        return {
          sql,
          args: null,
          bind(...args) {
            return { ...this, args };
          },
          async first() {
            return states[this.args?.[0]] ?? null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            executed.push({ sql: this.sql, args: this.args, viaRun: true });
            return { success: true };
          },
        };
      },
      async batch(list) {
        if (list.length > D1_MAX_BATCH_STATEMENTS) throw new Error("too many statements");
        for (const s of list) executed.push({ sql: s.sql, args: s.args });
        return list.map(() => ({ success: true }));
      },
    };
    const results = await backfillDcsGaps({ DB: db, DCS_BASE_URL: "https://example.test" }, NOW);
    assert(results.length === TRACKED_DCS_REPOS.length, "backfillDcsGaps returns one result per tracked repo");
    const tn = results.find((r) => r.repo === "en_tn");
    assert(tn.status === "fetch_failed" && tn.gapClosed === false, "en_tn's transport failure leaves ITS gap open");
    const others = results.filter((r) => r.repo !== "en_tn");
    assert(
      others.length === TRACKED_DCS_REPOS.length - 1 && others.every((r) => r.gapClosed === true),
      "  ...but every OTHER repo still resolves — one repo's failure does not skip the rest",
    );
  }

  console.log("dcsCommitGapBackfill: all assertions passed");
}

await main();

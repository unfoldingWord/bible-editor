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

function commit(sha, message, email, { name = "Someone", date = "2026-08-30T12:00:00Z", parent = null, parents = null } = {}) {
  const parentShas = parents ?? (parent ? [parent] : []);
  return {
    sha,
    commit: { message, author: { email, name, date } },
    author: null,
    parents: parentShas.map((p) => ({ sha: p })),
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

// STATEFUL: `.run()` actually evaluates the WHERE clause of the two gap
// UPDATEs against a tracked "current row", the same compare-and-swap
// semantics real D1/SQLite gives them. Every other test in this file only
// cares "was a clear/update issued with the right args", which `runs` still
// answers regardless of whether the CAS applied — but the concurrent-write
// race test below needs the mock to actually decide whether a write landed,
// not just record that it was attempted.
function mockDb(stateRow) {
  const executed = [];
  const runs = [];
  let current = stateRow ? { ...stateRow } : null;
  const stmt = (sql) => ({
    sql,
    args: null,
    bind(...args) {
      return { ...this, args };
    },
    async first() {
      return current ? { ...current } : null;
    },
    async run() {
      runs.push({ sql: this.sql, args: this.args });
      if (current && this.sql.includes("SET gap_since_sha = NULL")) {
        const [, sinceGuard, frontierGuard] = this.args;
        if (current.gap_since_sha === sinceGuard && current.gap_frontier_json === frontierGuard) {
          current = { ...current, gap_since_sha: null, gap_frontier_json: null, gap_at: null };
        }
      } else if (current && this.sql.includes("SET gap_frontier_json =")) {
        const [, sinceGuard, newJson, oldGuard] = this.args;
        if (current.gap_since_sha === sinceGuard && current.gap_frontier_json === oldGuard) {
          current = { ...current, gap_frontier_json: newJson };
        }
      }
      return { success: true };
    },
  });
  return {
    executed,
    runs,
    get currentState() {
      return current;
    },
    /** Test-only hook: simulate a concurrent write landing mid-backfill. */
    mutate(patch) {
      if (current) current = { ...current, ...patch };
    },
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

function state(gapSinceSha, frontier) {
  return { gap_since_sha: gapSinceSha, gap_frontier_json: frontier == null ? null : JSON.stringify(frontier) };
}

function inserts(db) {
  return db.executed.filter((e) => e.sql === INSERT_COMMIT_SQL);
}
function clearRun(db) {
  return db.runs.find((r) => r.sql.includes("SET gap_since_sha = NULL"));
}
function frontierRun(db) {
  return db.runs.find((r) => r.sql.includes("SET gap_frontier_json ="));
}

async function main() {
  // ── no gap: cheap no-op, no fetch at all ──────────────────────────────────
  {
    const db = mockDb(state(null, null));
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("must not be called");
    };
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.attempted === false && res.status === "no_gap", "a repo with no gap is skipped");
    assert(!fetched, "  ...and costs zero Door43 fetches — just the one D1 read");
  }

  // ── an empty frontier (defensive: pre-migration row, or a root gap) ──────
  {
    const db = mockDb(state("far-edge", []));
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("must not be called");
    };
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "no_frontier", "a gap with no frontier entries is dropped, not retried forever");
    assert(!fetched, "  ...without spending a fetch, since there is nowhere to start walking from");
    const clr = clearRun(db);
    assert(clr && clr.args[0] === "en_tn" && clr.args[1] === "far-edge", "  ...clearing all three gap columns for this exact gap");
  }

  // ── a single-entry frontier that fits in one tick's budget: resolves ─────
  {
    mockGitea([[commit("h1", "hand fix", "h@x"), commit("far-edge", "old", "h@x")]]);
    const db = mockDb(state("far-edge", ["near-edge"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "ok", "reaching gap_since_sha resolves the gap");
    assert(res.inserted === 1 && inserts(db).length === 1, "  ...inserting exactly the one commit inside the hole");
    const clr = clearRun(db);
    assert(clr && clr.args[1] === "far-edge", "  ...and clears the gap, guarded on the gap_since_sha it walked against");
    assert(clr.args[2] === JSON.stringify(["near-edge"]), "  ...and on the exact frontier this walk started from, not just gap_since_sha");
  }

  // ── issue #692 item 2 (Codex re-review, P1): the clear must be a real
  // compare-and-swap on gap_frontier_json, not just gap_since_sha, or a
  // concurrent poll's append between this function's read and its final
  // write is silently erased — reopening the exact hole this PR exists to
  // close. Simulated here via the fetch mock: it mutates the tracked "DB
  // row" mid-backfill, the same window a genuinely overlapping scheduled
  // invocation (pollDcsCommits carries no in-flight lock — see its own doc
  // comment) would race through. ─────────────────────────────────────────
  {
    const db = mockDb(state("far-edge", ["near-edge"]));
    globalThis.fetch = async (url) => {
      // A concurrent poll appended "concurrent-entry" to the SAME gap's
      // frontier (the UNION in pollDcsRepo) after this backfill call already
      // read the row but before it writes back.
      db.mutate({ gap_frontier_json: JSON.stringify(["near-edge", "concurrent-entry"]) });
      const page = Number(new URL(url).searchParams.get("page"));
      const body = page === 1 ? [commit("h1", "hand fix", "h@x"), commit("far-edge", "old", "h@x")] : [];
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === "x-hasmore" ? "false" : null) },
        json: async () => body,
      };
    };
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "ok", "the walk itself still reports success and resolved — it can't see the race");
    assert(clearRun(db), "  ...and DOES attempt the clear");
    assert(
      db.currentState.gap_since_sha === "far-edge" && db.currentState.gap_frontier_json === JSON.stringify(["near-edge", "concurrent-entry"]),
      "  ...but the CAS fails against the mutated row, so the gap survives with the concurrently-added entry intact, not silently erased",
    );
  }

  // ── issue #692 item 2 (Codex review round 2, P1), the bug this rewrite
  // fixes: REACHING gap_since_sha does not mean this entry is fully
  // resolved if a merge sat along the way — the merge's OTHER parent was
  // never fetched (the walk stopped the moment it saw gap_since_sha) and
  // must survive into the new frontier, not be dropped alongside `current`.
  {
    mockGitea([
      [
        commit("start", "hand fix", "h@x", { parent: "merge1" }),
        commit("merge1", "Merge pull request '…' (#1) from x into master", "h@x", { parents: ["far-edge", "side-branch"] }),
        commit("far-edge", "old", "h@x"),
      ],
    ]);
    const db = mockDb(state("far-edge", ["start"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === false, "reaching gap_since_sha along ONE branch of a merge does not resolve the whole entry");
    assert(res.status === "ok", "  ...the walk itself still reports success — it really did reach the target");
    assert(res.inserted === 2, "  ...having inserted both start and the merge commit");
    assert(!clearRun(db), "  ...so the gap must NOT be cleared");
    const fr = frontierRun(db);
    assert(fr && JSON.parse(fr.args[2]).join(",") === "side-branch", "  ...and the merge's UNFETCHED second parent becomes the new frontier");
  }

  // ── single entry, page_cap, ordinary (merge-free) continuation: the
  // frontier is REPLACED by the one new entry, still a single-entry array ──
  {
    const pages = Array.from({ length: DCS_BACKFILL_PAGE_LIMIT + 1 }, (_, i) =>
      i === DCS_BACKFILL_PAGE_LIMIT - 1 ? fullPage(`p${i}`, { lastParent: "the-frontier" }) : fullPage(`p${i}`),
    );
    const urls = mockGitea(pages);
    const db = mockDb(state("far-edge", ["near-edge"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(urls.length === DCS_BACKFILL_PAGE_LIMIT, `spends only ${DCS_BACKFILL_PAGE_LIMIT} pages per repo per tick`);
    assert(res.resolved === false && res.status === "page_cap", "did not reach the far edge this tick");
    assert(res.inserted === DCS_BACKFILL_PAGE_LIMIT * 50, "  ...but still inserts everything it DID walk");
    assert(!clearRun(db), "  ...and does NOT clear the gap — the hole is still open");
    const fr = frontierRun(db);
    assert(fr && JSON.parse(fr.args[2]).join(",") === "the-frontier", "  ...instead replacing the frontier for next tick");
    assert(
      fr.args[0] === "en_tn" && fr.args[1] === "far-edge" && fr.args[3] === JSON.stringify(["near-edge"]),
      "  ...guarded on both the gap and the exact OLD frontier JSON",
    );
  }

  // ── issue #692 item 2 (Codex review P1), the actual bug this rewrite
  // fixes: a page-capped sub-walk that itself crosses a merge commit
  // produces MULTIPLE new frontier entries, not one — a single-sha resume
  // point would have silently dropped the second parent's branch. ─────────
  {
    const pages = Array.from({ length: DCS_BACKFILL_PAGE_LIMIT + 1 }, (_, i) => {
      if (i !== DCS_BACKFILL_PAGE_LIMIT - 1) return fullPage(`p${i}`);
      // The LAST fetched page: its oldest commit (index 49) is a merge with
      // two parents, neither reachable from the other.
      return Array.from({ length: 50 }, (_, j) =>
        j === 49 ? commit("merge49", "Merge pull request '…' (#1) from x into master", "h@x", { parents: ["mainline-cont", "side-branch"] }) : commit(`q${j}`, "hand fix", "h@x"),
      );
    });
    mockGitea(pages);
    const db = mockDb(state("far-edge", ["near-edge"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === false && res.status === "page_cap", "still open — two new branches to walk, not zero");
    const fr = frontierRun(db);
    const next = JSON.parse(fr.args[2]);
    assert(next.includes("mainline-cont") && next.includes("side-branch"), "both of the merge's parents enter the frontier");
    assert(next.length === 2, "  ...and nothing else — the ORIGINAL single entry (near-edge) is fully consumed, not carried forward");
  }

  // ── a MULTI-entry frontier: only the FIRST entry is spent this tick; the
  // rest wait untouched for a later tick (bounded per-tick budget) ────────
  {
    mockGitea([[commit("h1", "hand fix", "h@x"), commit("far-edge", "old", "h@x")]]);
    const db = mockDb(state("far-edge", ["branch-a", "branch-b", "branch-c"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === false, "resolving branch-a alone does not close the whole gap — branch-b/c are still open");
    const fr = frontierRun(db);
    assert(JSON.parse(fr.args[2]).join(",") === "branch-b,branch-c", "branch-a is dropped (resolved); branch-b/c are carried forward untouched, in order");
  }

  // ── a bootstrap-shaped entry: gap_since_sha is never an ancestor of the
  // chain being walked (see dcsCommitBackfill.ts's BOOTSTRAP GAPS), so the
  // walk runs to history's end and resolves via source_sha_not_in_history —
  // the same signal a force-pushed far edge would produce. ────────────────
  {
    mockGitea([[commit("root", "genesis", "h@x")]]);
    const db = mockDb(state("never-an-ancestor", ["root"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "source_sha_not_in_history", "reaching true history root resolves the gap too");
    assert(res.inserted === 1, "  ...having inserted the root commit itself");
    assert(clearRun(db), "  ...and clears the gap: nothing more exists below it to find");
  }

  // ── page_cap whose own sub-walk finds NO further parents (every visited
  // row's parent is itself visited, or a root sits among them): nowhere left
  // to advance to, so this entry resolves rather than retrying forever ────
  {
    const pages = Array.from({ length: DCS_BACKFILL_PAGE_LIMIT + 1 }, (_, i) =>
      i === DCS_BACKFILL_PAGE_LIMIT - 1 ? fullPage(`p${i}`, { lastParent: null }) : fullPage(`p${i}`),
    );
    mockGitea(pages);
    const db = mockDb(state("far-edge", ["near-edge"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === true && res.status === "reached_root", "a full page ending in a parentless commit resolves as reached_root");
    assert(clearRun(db), "  ...clearing the gap rather than looping on a frontier that cannot move");
  }

  // ── transport failure: the frontier is put back EXACTLY as it was,
  // current entry included — safe to retry, and untouched entries are not
  // reordered or lost ───────────────────────────────────────────────────
  {
    globalThis.fetch = async () => {
      throw new Error("network");
    };
    const db = mockDb(state("far-edge", ["near-edge", "branch-b"]));
    const res = await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(res.resolved === false && res.status === "fetch_failed", "a thrown fetch reports fetch_failed, not a resolution");
    assert(!clearRun(db), "  ...and does not clear the gap");
    const fr = frontierRun(db);
    assert(!fr, "  ...nor does it write a new frontier — the row is left exactly as it was for the next tick to retry");
  }

  // ── D1's 100-statement batch cap is respected even at the backfill's own
  // page budget (2 × 50 = 100 rows would be exactly the cap in one batch;
  // DCS_POLL_WRITE_BATCH chunks well under it) ──────────────────────────────
  {
    const pages = [fullPage("x"), fullPage("y")];
    mockGitea(pages);
    const db = mockDb(state("far-edge", ["near-edge"]));
    await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    assert(inserts(db).length === 100, "both full pages are inserted");
    assert(DCS_BACKFILL_PAGE_LIMIT * 50 > DCS_POLL_WRITE_BATCH, "  ...sanity: this scenario really does exceed one write-batch chunk");
  }

  // ── ordering: inserts land oldest-first, same discipline as the poller ───
  {
    mockGitea([[commit("new", "hand fix", "h@x"), commit("old", "hand fix", "h@x")]]);
    const db = mockDb(state("far-edge", ["old-plus-one"]));
    await backfillDcsRepoGap({ DB: db }, "en_tn", NOW);
    const ins = inserts(db);
    assert(ins[0].args[1] === "old" && ins[1].args[1] === "new", "inserts go out oldest-first");
  }

  // ── backfillDcsGaps: loops every tracked repo, isolates a per-repo error ──
  {
    globalThis.fetch = async () => {
      throw new Error("boom");
    };
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
            return repo === "en_ult" ? state(null, null) : state("g", ["f"]);
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

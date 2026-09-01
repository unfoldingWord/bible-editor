// Unit tests for the Door43 master-commit poller (dcsCommitPoll.ts, issue
// #685). Stubs global fetch and D1. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsCommitPoll.test.mjs
//
// Not a test framework; a failed assert exits non-zero.
//
// The shapes the mock reproduces are MEASURED against git.door43.org
// (2026-09-01, en_tn master, page 1):
//   * `limit` is ignored — the page size is fixed at 50 server-side. The mock
//     therefore serves 50 per page no matter what was asked, and asserts that
//     nothing in the poller reads a requested page size.
//   * pagination is `page=` + `X-HasMore` / `X-PageCount` / `X-Total`
//     (X-Total was 36,111 for en_tn — 723 pages — which is why the bootstrap
//     is bounded).
//   * `files=true` returns `files: [{ filename, status }]` per commit for ~2%
//     more bytes and no extra subrequest.
//   * `author.login` is null on many commits, human ones included, so identity
//     is keyed on `commit.author.{name,email}` only.

import {
  DCS_POLL_INTERVAL_SECONDS,
  DCS_POLL_PAGE_LIMIT,
  advancesDespiteIncomplete,
  ledgerRowsFromCommits,
  pollBounds,
  pollDcsRepo,
  repoNeedsPoll,
} from "./dcsCommitPoll.ts";
import { TRACKED_DCS_REPOS } from "./dcsSources.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = 1_760_000_000;

// ── mock Gitea ───────────────────────────────────────────────────────────────
// `pages` is an array of arrays of commit objects. The server serves whatever
// page was requested and reports has-more from the array length — never from
// the caller's requested size, because the real server ignores that.
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
    // Measured: null on plenty of commits, human ones included. Nothing in the
    // poller may read it.
    author: null,
    parents: parent ? [{ sha: parent }] : [],
    files: files == null ? undefined : files.map((f) => ({ filename: f, status: "modified" })),
  };
}

// A page of exactly 50 commits, which is what the server sends regardless of
// any `limit` the caller passes.
function fullPage(prefix) {
  return Array.from({ length: 50 }, (_, i) => commit(`${prefix}${i}`, `hand fix ${prefix}${i}`, "h@x"));
}

// ── mock D1 ──────────────────────────────────────────────────────────────────
// Records every statement. `stateRow` is what the poll-state SELECT returns.
function mockDb(stateRow) {
  const executed = [];
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
  });
  return {
    executed,
    prepare(sql) {
      return stmt(sql);
    },
    async batch(list) {
      for (const s of list) executed.push({ sql: s.sql, args: s.args });
      return list.map(() => ({ success: true }));
    },
  };
}

function pollUpsert(db) {
  return db.executed.find((e) => e.sql.includes("dcs_repo_polls"));
}
function inserts(db) {
  return db.executed.filter((e) => e.sql.includes("INSERT INTO dcs_commits"));
}

async function main() {
  // ── the tracked repo set is DERIVED, not a second hardcoded list ──────────
  assert(
    TRACKED_DCS_REPOS.length === 5 &&
      ["en_ult", "en_ust", "en_tn", "en_tq", "en_twl"].every((r) => TRACKED_DCS_REPOS.includes(r)),
    "TRACKED_DCS_REPOS derives the five export-target repos from dcsResourceFile",
  );

  // ── rate limiting: one real poll per repo per interval ────────────────────
  assert(repoNeedsPoll(null, NOW), "a repo with no poll state is due");
  assert(repoNeedsPoll({ last_attempted_at: null }, NOW), "a state row with no attempt time is due");
  assert(
    repoNeedsPoll({ last_attempted_at: NOW - DCS_POLL_INTERVAL_SECONDS }, NOW) === true,
    "due exactly at the interval",
  );
  assert(
    repoNeedsPoll({ last_attempted_at: NOW - 300 }, NOW) === false,
    "a 5-minute-old attempt is NOT due — the 5-min cron tick costs no fetches",
  );

  // ── bootstrap is bounded by a time window, never unbounded history ────────
  {
    const b = pollBounds(null, NOW);
    assert(b.sinceSha === null && b.sinceTime === NOW - 30 * 86400, "a never-polled repo seeds a 30-day window");
    const r = pollBounds({ last_sha: "tip" }, NOW);
    assert(r.sinceSha === "tip" && r.sinceTime === null, "a stored high-water sha replaces the time window");
  }

  // ── pagination against a server that ignores `limit` ─────────────────────
  // The high-water sha sits on page 3, both earlier pages come back FULL (50),
  // so any end-of-history inference from a requested page size would stop early.
  {
    const pages = [
      fullPage("a"),
      fullPage("b"),
      [commit("c0", "hand fix c0", "h@x"), commit("mark", "the mark", "h@x")],
    ];
    const urls = mockGitea(pages);
    const db = mockDb({ repo: "en_tn", last_sha: "mark", last_attempted_at: NOW - 3600 });
    const res = await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);

    assert(urls.length === 3, "walks three pages to reach a high-water sha on page 3");
    assert(res.fetched === 101, "  ...collecting 50+50+1 commits, exclusive of the mark itself");
    assert(res.status === "ok", "  ...and reports a complete walk");
    assert(
      urls.every((u) => !new URL(u).searchParams.has("path")),
      "the walk is REPO-scoped: no `path=` filter (a commit to an unimported book still lands)",
    );
    assert(
      urls.every((u) => new URL(u).searchParams.get("files") === "true"),
      "asks the list endpoint for file lists (measured cheap) — no per-commit fetch fanout",
    );
    assert(inserts(db).length === 101, "  ...writing one ledger row per commit");
    const upsert = pollUpsert(db);
    assert(upsert.args[1] === "a0", "advances the high-water mark to the NEW tip (newest-first walk)");
    assert(upsert.args[5] === "ok" && upsert.args[6] === null, "  ...with no gap recorded on a complete walk");
  }

  // ── high-water-mark resume: steady state is ONE page ──────────────────────
  {
    const urls = mockGitea([[commit("new1", "hand fix", "h@x"), commit("tip", "old", "h@x")], fullPage("z")]);
    const db = mockDb({ repo: "en_tq", last_sha: "tip", last_attempted_at: NOW - DCS_POLL_INTERVAL_SECONDS });
    const res = await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tq", NOW);
    assert(urls.length === 1, "a resume that meets the mark on page 1 stops there");
    assert(res.fetched === 1 && inserts(db).length === 1, "  ...ingesting only the commits above the mark");
  }

  // ── idempotent re-poll: no duplicate (repo, sha) ──────────────────────────
  {
    const pages = [[commit("new1", "hand fix", "h@x"), commit("tip", "old", "h@x")]];
    mockGitea(pages);
    const db = mockDb({ repo: "en_tq", last_sha: "tip", last_attempted_at: NOW - 3600 });
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tq", NOW);
    const ins = inserts(db);
    assert(
      ins.every((s) => /ON CONFLICT \(repo, sha\) DO NOTHING/.test(s.sql)),
      "every insert is ON CONFLICT (repo, sha) DO NOTHING — a re-poll cannot duplicate or re-stamp seen_at",
    );
    // Second poll from the ADVANCED mark: the same commit is offered again by
    // the server (it is now the mark) and must not be re-inserted.
    const db2 = mockDb({ repo: "en_tq", last_sha: "new1", last_attempted_at: NOW - 3600 });
    const res2 = await pollDcsRepo({ DB: db2, DCS_BASE_URL: "https://example.test" }, "en_tq", NOW);
    assert(res2.fetched === 0 && inserts(db2).length === 0, "re-polling with the mark at the tip inserts nothing");
    assert(pollUpsert(db2).args[3] === NOW, "  ...but still stamps last_attempted_at, so the rate limit holds");
  }

  // ── per-tick cap: 4 pages, then stop and RECORD the hole ─────────────────
  {
    const pages = [fullPage("a"), fullPage("b"), fullPage("c"), fullPage("d"), fullPage("e"), fullPage("f")];
    const urls = mockGitea(pages);
    const db = mockDb({ repo: "en_tn", last_sha: "unreachable", last_attempted_at: NOW - 3600 });
    const res = await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    assert(urls.length === DCS_POLL_PAGE_LIMIT, `stops at the ${DCS_POLL_PAGE_LIMIT}-page budget`);
    assert(res.fetched === 200, "  ...i.e. ~200 commits per repo per tick (50/page, fixed server-side)");
    assert(res.status === "page_cap", "  ...reporting page_cap rather than a false end-of-history");
    const upsert = pollUpsert(db);
    assert(upsert.args[1] === "a0", "  ...still advances to the tip (refusing to advance would livelock)");
    assert(
      upsert.args[6] === "unreachable" && upsert.args[7] === NOW,
      "  ...and records gap_since_sha, so the coverage hole is visible instead of absorbed",
    );
    assert(advancesDespiteIncomplete("page_cap") && advancesDespiteIncomplete("source_sha_not_in_history"),
      "page_cap and a force-pushed mark both advance");
    assert(!advancesDespiteIncomplete("fetch_failed") && !advancesDespiteIncomplete("http_502"),
      "transport failures do NOT advance");
  }

  // ── transport failure: keep what arrived, do not move the mark ───────────
  {
    mockGitea([fullPage("a"), fullPage("b")], { fail: { onCall: 2, kind: "http", status: 502 } });
    const db = mockDb({ repo: "en_ult", last_sha: "mark", last_attempted_at: NOW - 3600 });
    const res = await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_ult", NOW);
    assert(res.status === "http_502", "a 502 mid-walk is reported as http_502");
    assert(inserts(db).length === 50, "  ...page 1's commits are still recorded (rows are keyed, so this is safe)");
    const upsert = pollUpsert(db);
    assert(upsert.args[1] === null, "  ...the high-water mark is NOT advanced, so the next interval re-walks");
    assert(upsert.args[4] === null, "  ...and last_success_at is left alone");
    assert(upsert.args[3] === NOW, "  ...while last_attempted_at moves, so we retry per interval not per tick");
  }

  // ── classification is a PASS-THROUGH of classifyMasterCommit ─────────────
  {
    const rows = ledgerRowsFromCommits("en_ult", [
      {
        sha: "s1",
        message: "bible-editor: EZK ult → master (#6711)",
        authorEmail: "someone@example.com",
        authorName: "Someone",
        date: "2026-08-14T01:00:00Z",
      },
      {
        // The anchoring trap: a HUMAN revert quoting our own subject. A
        // substring test would call this `ours` and drop a revert campaign out
        // of the ledger.
        sha: "s2",
        message: 'Revert "bible-editor: EZK ult → master (#6711)" (#6716)',
        authorEmail: "rich.mahn@example.com",
        authorName: "Richard Mahn",
        date: "2026-08-14T02:00:00Z",
      },
      {
        sha: "s3",
        message: "TQ: AMO 1 [q@api.bp-assistant]\n\nX-AI-Pipeline: bp-assistant/tqs",
        authorEmail: "bot@unfoldingword.org",
        authorName: "BW Bot",
        date: "2026-08-14T03:00:00Z",
      },
    ]);
    assert(rows[0].classification === "ours", "an anchored `bible-editor:` subject classifies ours");
    assert(rows[1].classification === "human", 'a human `Revert "bible-editor: …"` classifies human, NOT ours');
    assert(rows[2].classification === "ai", "the bot author + pipeline subject classifies ai");
    assert(
      rows[2].reason === "bot_author_pipeline_subject",
      "  ...and the rule that fired is stored, so a reader can cite evidence",
    );
    assert(rows[2].subject === "TQ: AMO 1 [q@api.bp-assistant]", "only the SUBJECT is stored, never the body");
    assert(rows[1].committedAt === Math.floor(Date.parse("2026-08-14T02:00:00Z") / 1000), "the date becomes unix seconds");
  }

  // ── parents / files / identity extraction ────────────────────────────────
  {
    mockGitea([[commit("n1", "hand fix", "h@x", { parent: "p1", files: ["tn_ZEC.tsv", "tn_AMO.tsv"] }), commit("tip", "old", "h@x")]]);
    const db = mockDb({ repo: "en_tn", last_sha: "tip", last_attempted_at: NOW - 3600 });
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    const [row] = inserts(db);
    assert(row.args[2] === "p1", "parent_sha comes from parents[0].sha (first parent = master's previous tip)");
    assert(row.args[3] === "Someone" && row.args[4] === "h@x", "identity is commit.author.{name,email}, never author.login");
    assert(row.args[9] === '["tn_ZEC.tsv","tn_AMO.tsv"]', "files_json holds the list endpoint's own filenames");
  }

  // ── a commit with no files in the response stores NULL, not "[]" ─────────
  {
    const rows = ledgerRowsFromCommits("en_tn", [
      { sha: "x", message: "m", authorEmail: null, files: null },
    ]);
    assert(rows[0].filesJson === null, "no file list in the response → files_json NULL, not an empty array");
  }

  console.log("dcsCommitPoll: all assertions passed");
}

await main();

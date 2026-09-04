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
  DCS_POLL_WRITE_BATCH,
  advancesDespiteIncomplete,
  classifyForLedger,
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
// D1's REAL limit, enforced here on purpose. The first version of this poller
// pushed up to 201 statements (200 inserts + the poll upsert) into ONE batch,
// and this mock happily accepted it — so the tests passed while the bootstrap
// path was guaranteed to fail atomically in production. A mock that does not
// enforce the constraints of the thing it stands in for is not a test.
// Documented at bookImport.ts's CHUNK and bookReimport.ts's WRITE_BATCH.
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
    // The attempt claim (F1) is a single statement outside any batch.
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
        // What D1 does: the whole batch fails, so nothing in it persists.
        throw new Error(`D1_ERROR: too many statements in batch (${list.length} > ${D1_MAX_BATCH_STATEMENTS})`);
      }
      batchSizes.push(list.length);
      for (const s of list) executed.push({ sql: s.sql, args: s.args });
      return list.map(() => ({ success: true }));
    },
  };
}

// The RESULTS upsert, not the attempt claim — both touch dcs_repo_polls, and
// only the results one carries last_status.
function pollUpsert(db) {
  return db.executed.find((e) => e.sql.includes("dcs_repo_polls") && e.sql.includes("last_status"));
}
function claimStmt(db) {
  return db.executed.find((e) => e.viaRun === true);
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

  // ── issue #692 item 2: a fresh page-cap gap also records its NEAR edge ────
  // (gap_from_sha), so the backfill path knows where to resume without
  // re-walking from the tip. It is the PARENT of the oldest row this walk
  // actually inserted — everything at or above that row is already in the
  // ledger; everything below it, down to gap_since_sha, is the hole.
  {
    const dPage = Array.from({ length: 50 }, (_, i) =>
      i === 49 ? commit("d49", "hand fix d49", "h@x", { parent: "d-parent" }) : commit(`d${i}`, `hand fix d${i}`, "h@x"),
    );
    mockGitea([fullPage("a"), fullPage("b"), fullPage("c"), dPage, fullPage("e"), fullPage("f")]);
    const db = mockDb({ repo: "en_tn", last_sha: "unreachable", last_attempted_at: NOW - 3600 });
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    const upsert = pollUpsert(db);
    assert(upsert.args[6] === "unreachable", "  ...gap_since_sha is still the far edge, unchanged");
    assert(upsert.args[9] === "d-parent", "  ...and gap_from_sha is the oldest inserted row's parent — the near edge");
  }

  // ── a complete walk records no gap at all, on EITHER edge ────────────────
  {
    mockGitea([[commit("only1", "hand fix", "h@x"), commit("mark", "old", "h@x")]]);
    const db = mockDb({ repo: "en_tq", last_sha: "mark", last_attempted_at: NOW - 3600 });
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tq", NOW);
    const upsert = pollUpsert(db);
    assert(upsert.args[6] === null && upsert.args[9] === null, "a complete walk writes no gap_since_sha and no gap_from_sha");
  }

  // ── a full 200-commit poll ingests COMPLETELY, in chunks under D1's cap ──
  // This is the bootstrap path (4 pages × 50), and the first version of the
  // poller sent all 201 statements in one batch — over D1's 100-statement cap,
  // so the whole thing failed atomically: no rows, no watermark, and every
  // later tick repeating it. The mock now throws exactly as D1 would, so this
  // test fails if anyone re-collapses the chunking.
  {
    const pages = [fullPage("a"), fullPage("b"), fullPage("c"), fullPage("d"), fullPage("e")];
    mockGitea(pages);
    const db = mockDb({ repo: "en_tn", last_sha: null, last_attempted_at: null });
    const res = await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);

    assert(res.inserted === 200, "a 200-commit bootstrap poll ingests all 200 rows");
    assert(inserts(db).length === 200, "  ...every one of them actually reaching D1");
    assert(
      db.batchSizes.every((n) => n <= 100),
      `  ...with no batch over D1's 100-statement cap (sizes: ${db.batchSizes.join(",")})`,
    );
    assert(
      db.batchSizes.length === Math.ceil(200 / DCS_POLL_WRITE_BATCH) &&
        db.batchSizes[0] === DCS_POLL_WRITE_BATCH,
      `  ...chunked at DCS_POLL_WRITE_BATCH=${DCS_POLL_WRITE_BATCH}`,
    );
    assert(
      db.batchSizes.reduce((a, b) => a + b, 0) === 201,
      "  ...201 statements total: 200 inserts plus exactly one poll upsert",
    );

    const ins = inserts(db);
    assert(
      ins[0].args[1] === "d49" && ins[ins.length - 1].args[1] === "a0",
      "inserts go out OLDEST-first, so a mid-poll failure leaves a contiguous run above the old mark",
    );
    assert(
      db.executed[db.executed.length - 1].sql.includes("dcs_repo_polls"),
      "the poll upsert is the LAST statement — the watermark cannot advance before the ingest finishes",
    );
    assert(pollUpsert(db).args[1] === "a0", "  ...and it advances the mark to the tip, not to the oldest row");
  }

  // ── transport failure: keep what arrived, do not move the mark ───────────
  {
    mockGitea([fullPage("a"), fullPage("b")], { fail: { onCall: 2, kind: "http", status: 502 } });
    const db = mockDb({ repo: "en_ult", last_sha: "mark", last_attempted_at: NOW - 3600 });
    const res = await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_ult", NOW);
    assert(res.status === "http_502", "a 502 mid-walk is reported as http_502");
    assert(inserts(db).length === 50, "  ...page 1's commits are still recorded (rows are keyed, so this is safe)");
    const upsert = pollUpsert(db);
    assert(upsert.args[8] === 0, "  ...the advance flag is 0, so the high-water mark is NOT moved");
    assert(upsert.args[4] === null, "  ...and last_success_at is left alone");
    assert(upsert.args[3] === NOW, "  ...while last_attempted_at moves, so we retry per interval not per tick");
  }

  // ── classification is a PASS-THROUGH of classifyMasterCommit ─────────────
  {
    const { rows } = ledgerRowsFromCommits("en_ult", [
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
    assert(row.args[2] === "p1", "parent_sha comes from parents[0].sha (the FIRST GIT PARENT — not necessarily master's previous tip)");
    assert(row.args[3] === "Someone" && row.args[4] === "h@x", "identity is commit.author.{name,email}, never author.login");
    assert(row.args[9] === '["tn_ZEC.tsv","tn_AMO.tsv"]', "files_json holds the list endpoint's own filenames");
  }

  // ── a commit with no files in the response stores NULL, not "[]" ─────────
  {
    const { rows } = ledgerRowsFromCommits("en_tn", [
      { sha: "x", message: "m", authorEmail: null, files: null },
    ]);
    assert(rows[0].filesJson === null, "no file list in the response → files_json NULL, not an empty array");
  }

  // ── F1: the attempt is CLAIMED BEFORE any fetch ──────────────────────────
  // Stamping last_attempted_at only in the final write batch meant any write
  // failure (D1 down, or the migration simply not applied in prod) left every
  // repo permanently "due" and re-polled all five on every 5-minute tick,
  // forever. The claim must therefore be written first, and it must be the
  // first thing that touches D1 after the state read.
  {
    let fetchedBeforeClaim = null;
    const db = mockDb({ repo: "en_tn", last_sha: "tip", last_attempted_at: NOW - 3600 });
    mockGitea([[commit("n1", "hand fix", "h@x"), commit("tip", "old", "h@x")]]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (fetchedBeforeClaim === null) fetchedBeforeClaim = claimStmt(db) == null;
      return realFetch(url);
    };
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    assert(fetchedBeforeClaim === false, "the attempt claim is written BEFORE the first Door43 fetch");
    const claim = claimStmt(db);
    assert(claim.args[0] === "en_tn" && claim.args[1] === NOW, "  ...stamping last_attempted_at for this repo");
    assert(
      db.executed[0].viaRun === true,
      "  ...as the very first write, so a later write failure cannot un-rate-limit the poller",
    );
  }

  // A write failure AFTER the claim must still leave the repo rate-limited.
  {
    const db = mockDb({ repo: "en_tn", last_sha: "tip", last_attempted_at: NOW - 3600 });
    mockGitea([[commit("n1", "hand fix", "h@x"), commit("tip", "old", "h@x")]]);
    db.batch = async () => {
      throw new Error("D1_ERROR: database is locked");
    };
    let threw = false;
    try {
      await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    } catch {
      threw = true;
    }
    assert(threw, "a failing batch propagates (pollDcsCommits logs it per repo)");
    assert(claimStmt(db) != null, "  ...but the attempt claim already landed — no 5-minute fetch loop");
  }

  // ── F4: a merge commit wrapping OUR export is ours, not human ────────────
  // MEASURED over the newest 1,000 commits of en_ult + en_tn (2026-09-01): 262
  // are merge commits, and 113 of those wrap one of our own exports. Under the
  // anchored OURS prefix alone, every one of those 113 was recorded as a human
  // maintainer's edit — in the table whose whole job is saying who did what.
  {
    const cases = [
      [
        "Merge pull request 'bible-editor: LAM ult → master' (#6555) from LAM-be into master",
        "someone@example.com",
        "ours",
        "merge_of_bible_editor_export",
      ],
      // A merge of a bp-assistant push still reaches AI_MARKER on the full
      // subject — the wrapper defers rather than deciding.
      [
        "Merge pull request 'AI ULT for EZK 22 [bc..3@api.bp-assistant]' (#6802) from AI-EZK-22 into master",
        "53472+bookpackagebot@noreply.door43.org",
        "ai",
        "bp_assistant_marker",
      ],
      // The anchoring trap survives one level up: a human reverting a merge of
      // our export must NOT become ours. MERGE_SUBJECT is anchored at ^Merge,
      // so this never unwraps and classifyMasterCommit's revert rule stands.
      [
        'Revert "Merge pull request \'bible-editor: LAM ult → master\' (#6555)"',
        "rich.mahn@example.com",
        "human",
        null,
      ],
      // A maintainer's own merge of their own branch stays human.
      [
        "Merge pull request 'Fix EZK 40 marker spacing' (#6600) from ezk-markers into master",
        "rich.mahn@example.com",
        "human",
        null,
      ],
    ];
    for (const [message, authorEmail, expectKind, expectReason] of cases) {
      const { rows } = ledgerRowsFromCommits("en_ult", [{ sha: "m", message, authorEmail, authorName: "x" }]);
      assert(
        rows[0].classification === expectKind,
        `merge subject classifies ${expectKind}: ${message.slice(0, 58)}…`,
      );
      if (expectReason) assert(rows[0].reason === expectReason, `  ...reason ${expectReason}`);
    }
    assert(
      classifyForLedger({ sha: "x", message: "bible-editor: AMO tq → master", authorEmail: "h@x" }).kind === "ours",
      "a plain (unwrapped) export subject still classifies ours through the wrapper",
    );
  }

  // ── F6: committed_at is the COMMITTER date (when it landed) ──────────────
  {
    const { rows } = ledgerRowsFromCommits("en_tn", [
      {
        sha: "r1",
        message: "hand fix",
        authorEmail: "h@x",
        // Authored in June, landed in August — a rebase or cherry-pick, which is
        // most of how work reaches these repos.
        date: "2026-06-01T00:00:00Z",
        committerDate: "2026-08-30T12:00:00Z",
      },
      { sha: "r2", message: "no committer block", authorEmail: "h@x", date: "2026-06-01T00:00:00Z" },
    ]);
    assert(
      rows[0].committedAt === Math.floor(Date.parse("2026-08-30T12:00:00Z") / 1000),
      "committed_at stores when the commit LANDED, not when it was authored",
    );
    assert(
      rows[1].committedAt === Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000),
      "  ...falling back to the author date when the payload has no committer",
    );
  }

  // ── F7: a defensive-cap truncation is recorded, never silent ─────────────
  {
    const many = Array.from({ length: 5 }, (_, i) => ({
      sha: `s${i}`,
      message: "hand fix",
      authorEmail: "h@x",
      date: "2026-08-30T12:00:00Z",
    }));
    const { rows, dropped } = ledgerRowsFromCommits("en_tn", many, 3);
    assert(rows.length === 3 && dropped === 2, "ledgerRowsFromCommits reports how many commits the cap dropped");
    assert(rows[0].sha === "s0", "  ...keeping the NEWEST, so the tip stays contiguous with the mark");
  }

  // ── F12: last_sha and last_committed_at move as a PAIR ──────────────────
  // A tip whose date will not parse must write a NULL timestamp beside its sha,
  // never keep the previous commit's timestamp — that pair would describe two
  // different commits.
  {
    mockGitea([[commit("n1", "hand fix", "h@x", { date: "not-a-date" }), commit("tip", "old", "h@x")]]);
    const db = mockDb({ repo: "en_tn", last_sha: "tip", last_committed_at: 12345, last_attempted_at: NOW - 3600 });
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    const upsert = pollUpsert(db);
    assert(upsert.args[1] === "n1" && upsert.args[2] === null, "an unparseable tip date writes sha + NULL, as a pair");
    assert(upsert.args[8] === 1, "  ...and still advances (the walk completed)");
    assert(
      /last_sha = CASE WHEN \?9 = 1/.test(upsert.sql) && /last_committed_at = CASE WHEN \?9 = 1/.test(upsert.sql),
      "  ...both driven by the same advance flag, not COALESCEd independently",
    );
  }

  // ── F3: the OLDEST unresolved gap survives a later one ──────────────────
  {
    const pages = [fullPage("a"), fullPage("b"), fullPage("c"), fullPage("d"), fullPage("e")];
    mockGitea(pages);
    const db = mockDb({ repo: "en_tn", last_sha: "unreachable", gap_since_sha: "older-hole", last_attempted_at: NOW - 3600 });
    await pollDcsRepo({ DB: db, DCS_BASE_URL: "https://example.test" }, "en_tn", NOW);
    const upsert = pollUpsert(db);
    assert(
      /gap_since_sha = CASE WHEN dcs_repo_polls\.gap_since_sha IS NULL/.test(upsert.sql),
      "the gap upsert keeps an existing hole rather than overwriting it with a newer one",
    );
    assert(
      /gap_at = CASE WHEN dcs_repo_polls\.gap_since_sha IS NULL/.test(upsert.sql),
      "  ...and gap_at is gated on the same condition, so the pair cannot split",
    );
    assert(
      /gap_from_sha = CASE WHEN dcs_repo_polls\.gap_since_sha IS NULL/.test(upsert.sql),
      "  ...and gap_from_sha too — it is a triple with gap_since_sha and gap_at, not a pair",
    );
  }

  console.log("dcsCommitPoll: all assertions passed");
}

await main();

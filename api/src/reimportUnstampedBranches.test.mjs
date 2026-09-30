// Issue #1035 — three planAndStageBookResources branches leave a resource's
// sync watermark (book_resource_syncs.source_sha) UNSTAMPED, yet the run
// ledger (classifyReimportOutcome) used to read them as success:
//   1. own-publish recognized, but fileCommitSha returned null, so
//      markOwnPublishConverged's `source_sha = COALESCE(?4, source_sha)`
//      left source_sha where it was (or the stamp's UPDATE changed no rows);
//   2. the DCS fetch of master's file failed (raw == null);
//   3. the TSV fetch looked truncated (tsvFetchLooksTruncated).
// Each now carries its own plan flag, seeded onto a per-resource counter by
// seedPerResourceFromPlan, which classifyReimportOutcome reads as failure.
//
// Drives the REAL planAndStageBookResources against the real schema and a
// stubbed Door43, the same harness shape as staleBaseGate.test.mjs section 4.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/reimportUnstampedBranches.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { planAndStageBookResourcesForTest, seedPerResourceFromPlanForTest } from "./bookReimport.ts";
import { classifyReimportOutcome } from "./reimportSyncGate.ts";
import { gitBlobSha } from "./ownPublish.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MASTER_SHA = "a1e8182af6b8b72f762e676d5307f32fee358f84";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  sqlite.exec(
    `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version)
     VALUES ('2CH', 1, 1, 'ULT', '{"a":1}', 'a', 1), ('XYZ', 1, 1, 'ULT', '{"a":1}', 'a', 1)`,
  );
  return {
    sqlite,
    env: {
      DB: makeDb(sqlite),
      BLOBS: { async put() {}, async get() { return null; }, async delete() {} },
      DCS_BASE_URL: "https://dcs.test",
    },
  };
}

// `commits`: the fileCommitSha response (a sha, or null → HTTP 500).
// `raw`: master's file body served on ANY raw URL (pinned or not), or null → 404.
function stubFetch({ commits, raw }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const resp = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      async text() { return body; },
      async json() { return JSON.parse(body); },
      async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
    });
    if (u.includes("/commits?")) return commits ? resp(200, JSON.stringify([{ sha: commits }])) : resp(500, "");
    if (u.includes("/raw/") && raw != null) {
      return resp(200, raw, { "content-length": String(new TextEncoder().encode(raw).byteLength) });
    }
    return resp(404, "");
  };
}

const ultBody = "\\id 2CH EN_ULT\n\\c 1\n\\v 1 text\n";
const tqHeader = "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse";
const tqLine = (i) => `1:${i}\tq${String(i).padStart(3, "0")}\t\t\t\tQuestion ${i}?\tAnswer ${i}.`;

async function plan(env, book, resources) {
  const p = await planAndStageBookResourcesForTest(env, book, resources, "inst-1035");
  return { entry: p.entries[0], perResource: seedPerResourceFromPlanForTest(p.entries) };
}

const realFetch = globalThis.fetch;
try {
  console.log("\n1. own-publish recognized with a null master SHA");
  {
    const { sqlite, env } = freshEnv();
    sqlite
      .prepare(
        `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin, pushed_blob_sha, pushed_read_at)
         VALUES ('2CH','ult','0000000000000000000000000000000000000000',1,'reimport',?,1000)`,
      )
      .run(await gitBlobSha(ultBody));
    stubFetch({ commits: null, raw: ultBody });
    const { entry, perResource } = await plan(env, "2CH", ["ult"]);
    eq(entry.ownPublish, true, "recognition fired and master_confirmed_at advanced (the UPDATE landed)");
    eq(
      sqlite.prepare(`SELECT source_sha FROM book_resource_syncs WHERE book='2CH' AND resource='ult'`).get().source_sha,
      "0000000000000000000000000000000000000000",
      "…but source_sha did NOT move (COALESCE kept the old value)",
    );
    eq(perResource.ult.own_publish_unstamped, 1, "seeded as own_publish_unstamped");
    eq(classifyReimportOutcome(perResource), "failure", "the ledger records failure, not success");
  }
  {
    const { sqlite, env } = freshEnv();
    sqlite
      .prepare(
        `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin, pushed_blob_sha, pushed_read_at)
         VALUES ('2CH','ult','0000000000000000000000000000000000000000',1,'reimport',?,1000)`,
      )
      .run(await gitBlobSha(ultBody));
    stubFetch({ commits: MASTER_SHA, raw: ultBody });
    const { entry, perResource } = await plan(env, "2CH", ["ult"]);
    eq(entry.ownPublish, true, "control: own-publish with a real SHA");
    eq(perResource.ult.own_publish_unstamped, 0, "…stamps source_sha, so nothing is counted");
    eq(classifyReimportOutcome(perResource), "success", "…and the ledger reads success");
  }

  console.log("\n2. DCS fetch error");
  for (const commits of [MASTER_SHA, null]) {
    const { env } = freshEnv();
    stubFetch({ commits, raw: null });
    const { entry, perResource } = await plan(env, "2CH", ["ult"]);
    eq(entry.changed, false, `raw fetch 404 (commit SHA ${commits ? "known" : "unknown"}) → not staged`);
    eq(perResource.ult.fetch_failed, 1, "…seeded as fetch_failed");
    eq(classifyReimportOutcome(perResource), "failure", "…and the ledger records failure");
  }

  console.log("\n3. truncated TSV");
  {
    const { sqlite, env } = freshEnv();
    const ins = sqlite.prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version)
       VALUES (?, '2CH', 1, ?, ?, 'q', 'a', ?, 1)`,
    );
    for (let i = 1; i <= 40; i++) ins.run(`q${String(i).padStart(3, "0")}`, i, `1:${i}`, i);
    stubFetch({ commits: MASTER_SHA, raw: `${tqHeader}\n${tqLine(1)}\n` });
    const { entry, perResource } = await plan(env, "2CH", ["tq"]);
    eq(entry.changed, false, "1 incoming row vs 40 live → treated as truncated, not staged");
    eq(perResource.tq.tsv_truncated, 1, "…seeded as tsv_truncated");
    eq(classifyReimportOutcome(perResource), "failure", "…and the ledger records failure");
  }

  console.log("\n4. controls that carry a null SHA but are NOT failures");
  {
    const { env } = freshEnv();
    stubFetch({ commits: null, raw: null });
    const { entry, perResource } = await plan(env, "XYZ", ["ult"]);
    eq(entry.masterSha, null, "book not in BOOK_NUMBERS (no resource file mapped) → null SHA");
    eq(
      [perResource.ult.fetch_failed, perResource.ult.tsv_truncated, perResource.ult.own_publish_unstamped],
      [0, 0, 0],
      "…but none of the three counters fires",
    );
    eq(classifyReimportOutcome(perResource), "success", "…so the ledger still reads success");
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll reimportUnstampedBranches checks passed.");
}

// Issue #1411 journey: on an UNLOCKED book, a chapter whose only Door43 change
// is the order of its tn/tq notes must still be applied by the nightly sync.
// The chapter gate (changedTsvChapters) compared content only, so such a
// chapter was skipped and master's order never reached D1 (and the next export
// pushed D1's old order back over it). Locked books are mirrored instead
// (#1418) and must not be handled twice.
//
// Drives the REAL runChunkedReimport on the real migration schema, with Door43
// replaced by a stub and R2 by a Map (the lockedMirrorJourney.test.mjs harness).
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/orderOnlyChapterJourney.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runChunkedReimport, changedTsvChapters } from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// D1 stand-in. `calls.singleRowWrites` counts tn/tq UPDATEs run one statement
// at a time (outside a batch): the order-only path must not add any.
function makeDb(sqlite, calls) {
  const exec = (sql, args) => {
    const r = sqlite.prepare(sql).run(...args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
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
      if (/^\s*UPDATE\s+(tn|tq)_rows/i.test(sql)) calls.singleRowWrites++;
      return exec(sql, args);
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      return stmts.map((s) => exec(s.sql, s.args));
    },
  };
}

function makeBlobs() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v };
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function stubDoor43(state) {
  const realFetch = globalThis.fetch;
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
    const kind = /tn_/.test(u) ? "tn" : /tq_/.test(u) ? "tq" : /twl_/.test(u) ? "twl" : null;
    const body = kind ? state.files[kind] : null;
    if (u.includes("/commits?")) return resp(200, JSON.stringify([{ sha: state.sha }]));
    if (body == null) return resp(404, "");
    const bytes = new TextEncoder().encode(body).byteLength;
    if (u.includes("/contents/")) return resp(200, JSON.stringify({ size: bytes }));
    if (u.includes("/raw/")) return resp(200, body, { "content-length": String(bytes) });
    return resp(404, "");
  };
  return () => { globalThis.fetch = realFetch; };
}

const step = {
  async do(name, optsOrFn, maybeFn) {
    const run = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
    const out = await run();
    return out === undefined ? out : JSON.parse(JSON.stringify(out));
  },
};

const BOOK = "OBA";
const T0 = 1_700_000_000; // the last confirmed push
const OLD_SHA = "0".repeat(40);
const SHA_1 = "1".repeat(40);
const SHA_2 = "2".repeat(40);

const TN_HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
const tnLine = (ref, id, note) => `${ref}\t${id}\t\t\t\t\t${note}`;
const TQ_HEADER = "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse";
const tqLine = (ref, id, q, a) => `${ref}\t${id}\t\t\t\t${q}\t${a}`;

function freshEnv({ locked }) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (42, 42, 'a-translator')`).run();
  sqlite.prepare(`INSERT INTO book_locks (book, locked, reason) VALUES (?, ?, 'test')`).run(BOOK, locked ? 1 : 0);
  for (const ch of [1, 2]) {
    sqlite
      .prepare(
        `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version)
         VALUES (?, ?, 1, 'ULT', '{"a":1}', 'a', 1)`,
      )
      .run(BOOK, ch);
  }
  const calls = { singleRowWrites: 0 };
  return { sqlite, calls, env: { DB: makeDb(sqlite, calls), BLOBS: makeBlobs() } };
}

function tn(sqlite, { id, ref, note, sort }) {
  const [ch, v] = ref.split(":").map(Number);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, ch, v, ref, note, sort, T0 - 500);
}
function tq(sqlite, { id, ref, q, a, sort }) {
  const [ch, v] = ref.split(":").map(Number);
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, ch, v, ref, q, a, sort, T0 - 500);
}
// An in-app drag, exactly as rows.ts writes it: sort_order + updated_at +
// provenance, no version bump, no edit_log row, updated_by untouched.
function drag(sqlite, id, sort, at) {
  sqlite
    .prepare(
      `UPDATE tn_rows SET sort_order = ?, updated_at = ?, last_change_source = 'user', last_change_action = 'reorder',
              last_change_actor = 42 WHERE id = ?`,
    )
    .run(sort, at, id);
}
function confirmPush(sqlite, resource, at) {
  sqlite
    .prepare(
      `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin, master_confirmed_at, master_confirmed_edit_id)
       VALUES (?, ?, ?, ?, 'reimport', ?, NULL)`,
    )
    .run(BOOK, resource, OLD_SHA, at, at);
}

function order(sqlite, table) {
  return sqlite
    .prepare(
      `SELECT id, ref_raw FROM ${table} WHERE book = ? AND deleted_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    )
    .all(BOOK)
    .map((r) => `${r.ref_raw}|${r.id}`);
}
const rowState = (sqlite, table, ids) =>
  sqlite
    .prepare(`SELECT id, sort_order, version, updated_at FROM ${table} WHERE book = ? AND id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`)
    .all(BOOK, ...ids)
    .map((r) => ({ ...r }));
// A tq row someone wrote before the push: updated_by set, plus its edit_log
// row (source 'ai_pipeline' = AI-only, NULL = a person).
function owned(sqlite, id, action, source, at) {
  sqlite.prepare(`UPDATE tq_rows SET updated_by = 42, version = 2 WHERE id = ?`).run(id);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, created_at)
       VALUES ('tq', ?, ?, 42, 1, 2, ?, ?, ?)`,
    )
    .run(id, BOOK, action, source, at);
}
const tqOwnership = (sqlite) =>
  sqlite
    .prepare(`SELECT id, version, updated_by, review_kind FROM tq_rows WHERE id IN ('qc01', 'qc02') ORDER BY id`)
    .all()
    .map((r) => ({ ...r }));
const editLogCount = (sqlite) => sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log`).get().n;

// Night 0 was a confirmed push of exactly these rows, in this order.
function seed({ locked }) {
  const t = freshEnv({ locked });
  const s = t.sqlite;
  // 1:1 — Door43 swaps these two; nobody touched them in the app.
  tn(s, { id: "aaaa", ref: "1:1", note: "A", sort: 100 });
  tn(s, { id: "bbbb", ref: "1:1", note: "B", sort: 200 });
  // 1:2 — Door43 leaves the order alone; a person drags dddd first in the app.
  tn(s, { id: "cccc", ref: "1:2", note: "C", sort: 100 });
  tn(s, { id: "dddd", ref: "1:2", note: "D", sort: 200 });
  // 1:3 — both sides reorder: Door43 to f,e,g; a person to g,e,f.
  tn(s, { id: "eeee", ref: "1:3", note: "E", sort: 100 });
  tn(s, { id: "ffff", ref: "1:3", note: "F", sort: 200 });
  tn(s, { id: "gggg", ref: "1:3", note: "G", sort: 300 });
  // Chapter 2 — no change at all; odd-scale numbers that would be rewritten
  // if the chapter were renumbered.
  tn(s, { id: "hhhh", ref: "2:1", note: "H", sort: 150 });
  tn(s, { id: "iiii", ref: "2:1", note: "I", sort: 170 });
  // tq: 1:1 reordered on Door43 (tq has no in-app reorder); chapter 2 unchanged.
  tq(s, { id: "qa01", ref: "1:1", q: "Q1", a: "A1", sort: 100 });
  tq(s, { id: "qa02", ref: "1:1", q: "Q2", a: "A2", sort: 200 });
  // tq 1:2 — Door43 swaps an AI-written row and a translator-edited row
  // (both edited before the push, content unchanged since): order only.
  // Unlocked seed only: a non-pristine row makes the content gate flag its
  // chapter on any book, which would blur the locked case's "mirror only".
  if (!locked) {
    tq(s, { id: "qc01", ref: "1:2", q: "Q5 by AI", a: "A5", sort: 100 });
    tq(s, { id: "qc02", ref: "1:2", q: "Q6 edited", a: "A6", sort: 200 });
    owned(s, "qc01", "create", "ai_pipeline", T0 - 200);
    owned(s, "qc02", "update", null, T0 - 100);
  }
  tq(s, { id: "qb01", ref: "2:1", q: "Q3", a: "A3", sort: 150 });
  tq(s, { id: "qb02", ref: "2:1", q: "Q4", a: "A4", sort: 170 });
  confirmPush(s, "tn", T0);
  confirmPush(s, "tq", T0);
  // After the push, not yet exported.
  drag(s, "dddd", 50, T0 + 100);
  drag(s, "gggg", 50, T0 + 100);
  return t;
}

const MASTER_TN = [
  TN_HEADER,
  tnLine("1:1", "bbbb", "B"),
  tnLine("1:1", "aaaa", "A"),
  tnLine("1:2", "cccc", "C"),
  tnLine("1:2", "dddd", "D"),
  tnLine("1:3", "ffff", "F"),
  tnLine("1:3", "eeee", "E"),
  tnLine("1:3", "gggg", "G"),
  tnLine("2:1", "hhhh", "H"),
  tnLine("2:1", "iiii", "I"),
].join("\n");
const MASTER_TQ = [
  TQ_HEADER,
  tqLine("1:1", "qa02", "Q2", "A2"),
  tqLine("1:1", "qa01", "Q1", "A1"),
  tqLine("1:2", "qc02", "Q6 edited", "A6"),
  tqLine("1:2", "qc01", "Q5 by AI", "A5"),
  tqLine("2:1", "qb01", "Q3", "A3"),
  tqLine("2:1", "qb02", "Q4", "A4"),
].join("\n");
// The locked seed has no tq 1:2 rows (see seed), so its master has none.
const MASTER_TQ_LOCKED = MASTER_TQ.split("\n").filter((l) => !l.startsWith("1:2\t")).join("\n");

async function night(t, state) {
  const restore = stubDoor43(state);
  try {
    return await runChunkedReimport(t.env, step, BOOK, `inst-${Math.random()}`, ["tn", "tq"]);
  } finally {
    restore();
  }
}

console.log("\n[#1411 — the chapter gate flags an order-only chapter, and only that one]");
{
  const t = seed({ locked: false });
  eq(
    [...(await changedTsvChapters(t.env, BOOK, "tn", MASTER_TN, { confirmedAt: T0 }))].sort(),
    [1],
    "tn: chapter 1 (order-only) is flagged; chapter 2 (no change) is not",
  );
  eq(
    [...(await changedTsvChapters(t.env, BOOK, "tq", MASTER_TQ, { confirmedAt: T0 }))].sort(),
    [1],
    "tq: chapter 1 (order-only) is flagged; chapter 2 (no change) is not",
  );
  eq(
    [...(await changedTsvChapters(t.env, BOOK, "tn", MASTER_TN))].sort(),
    [],
    "without the order option (a locked book's mirror owns order) the gate stays content-only",
  );
}

console.log("\n[#1411 — the nightly sync applies Door43's order-only change on an unlocked book]");
{
  const t = seed({ locked: false });
  const ch2Before = rowState(t.sqlite, "tn_rows", ["hhhh", "iiii"]);
  const tq2Before = rowState(t.sqlite, "tq_rows", ["qb01", "qb02"]);
  const logBefore = editLogCount(t.sqlite);
  const tqOwnershipBefore = tqOwnership(t.sqlite);
  const res = await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(
    order(t.sqlite, "tn_rows"),
    [
      "1:1|bbbb", "1:1|aaaa", // Door43's order
      "1:2|dddd", "1:2|cccc", // the unexported in-app drag stands
      "1:3|gggg", "1:3|eeee", "1:3|ffff", // both reordered: the person's order stands (#1416 rule)
      "2:1|hhhh", "2:1|iiii",
    ],
    "tn: master's order lands in 1:1; in-app reorders in 1:2 and 1:3 are kept",
  );
  eq(
    order(t.sqlite, "tq_rows"),
    ["1:1|qa02", "1:1|qa01", "1:2|qc02", "1:2|qc01", "2:1|qb01", "2:1|qb02"],
    "tq: master's order lands in 1:1 and 1:2",
  );
  eq(
    tqOwnership(t.sqlite),
    tqOwnershipBefore,
    "tq: an order-only change re-seeds no AI row and merges no edited row (no version bump, updated_by kept, no flag)",
  );
  eq(rowState(t.sqlite, "tn_rows", ["hhhh", "iiii"]), ch2Before, "tn chapter 2 (no order change) is not rewritten");
  eq(rowState(t.sqlite, "tq_rows", ["qb01", "qb02"]), tq2Before, "tq chapter 2 (no order change) is not rewritten");
  eq(
    t.sqlite.prepare(`SELECT version FROM tn_rows WHERE id IN ('aaaa', 'bbbb') ORDER BY id`).all().map((r) => r.version),
    [1, 1],
    "a reorder is not a content change: no version bump",
  );
  eq(editLogCount(t.sqlite) - logBefore, 0, "a reorder writes no edit_log row");
  eq(res.perResource.tn.reordered > 0 && res.perResource.tq.reordered > 0, true, "counted as reordered");
  eq(t.calls.singleRowWrites, 0, "no per-row UPDATE round trips: every tn/tq write is batched");
  eq(
    t.sqlite.prepare(`SELECT source_sha FROM book_resource_syncs WHERE book = ? AND resource = 'tn'`).get(BOOK).source_sha,
    SHA_1,
    "the watermark advances (nothing withheld)",
  );

  // Night 2: master moves again (a note text in chapter 2) while the drags
  // are still unexported. Chapter 1's remaining differences all sit in
  // verses a person reordered, so the gate leaves chapter 1 alone and the
  // drags survive.
  const masterTn2 = MASTER_TN.replace(tnLine("2:1", "iiii", "I"), tnLine("2:1", "iiii", "I changed on Door43"));
  eq(
    [...(await changedTsvChapters(t.env, BOOK, "tn", masterTn2, { confirmedAt: T0 }))].sort(),
    [2],
    "night 2 gate: only chapter 2 (content); the pending reorders do not flag chapter 1",
  );
  await night(t, { sha: SHA_2, files: { tn: masterTn2, tq: MASTER_TQ } });
  eq(
    order(t.sqlite, "tn_rows").slice(0, 7),
    ["1:1|bbbb", "1:1|aaaa", "1:2|dddd", "1:2|cccc", "1:3|gggg", "1:3|eeee", "1:3|ffff"],
    "night 2: chapter 1 unchanged, the in-app reorders still stand",
  );
  eq(t.sqlite.prepare(`SELECT note FROM tn_rows WHERE id = 'iiii'`).get().note, "I changed on Door43", "night 2: the content change landed");
}

console.log("\n[#1456 — an in-app reorder stamped in the same second as the confirmed push is kept on an unlocked book]");
{
  const t = seed({ locked: false });
  // Re-stamp both drags at exactly master_confirmed_at (the locked mirror's
  // `>=` already treats this as pending; the unlocked path must agree).
  drag(t.sqlite, "dddd", 50, T0);
  drag(t.sqlite, "gggg", 50, T0);
  eq(
    [...(await changedTsvChapters(t.env, BOOK, "tn", MASTER_TN.replace(tnLine("1:1", "bbbb", "B") + "\n" + tnLine("1:1", "aaaa", "A"), tnLine("1:1", "aaaa", "A") + "\n" + tnLine("1:1", "bbbb", "B")), { confirmedAt: T0 }))].sort(),
    [],
    "gate: with 1:1 unchanged, the same-second drags in 1:2 and 1:3 do not flag chapter 1",
  );
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(
    order(t.sqlite, "tn_rows").slice(0, 7),
    ["1:1|bbbb", "1:1|aaaa", "1:2|dddd", "1:2|cccc", "1:3|gggg", "1:3|eeee", "1:3|ffff"],
    "tn: Door43's order lands in 1:1; the same-second in-app reorders in 1:2 and 1:3 stand",
  );
}

console.log("\n[#1411 — a locked book's order-only change goes through the mirror only]");
{
  const t = seed({ locked: true });
  const res = await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ_LOCKED } });
  eq(res.perResource.tn.reordered, 0, "tn: the ordinary apply path reorders nothing on a locked book");
  eq(res.perResource.tq.reordered, 0, "tq: the ordinary apply path reorders nothing on a locked book");
  eq((res.perResource.tn.mirrored ?? 0) > 0, true, "tn: the mirror carried the order change");
  eq(order(t.sqlite, "tq_rows").slice(0, 2), ["1:1|qa02", "1:1|qa01"], "tq: master's order via the mirror");
  eq(order(t.sqlite, "tn_rows").slice(0, 2), ["1:1|bbbb", "1:1|aaaa"], "tn: master's order via the mirror");
}

console.log("\n[#1411 review A1 — locked at staging, unlocked before the mirror: the watermark is withheld, the next night applies the order]");
{
  const t = seed({ locked: true });
  // Unlock right after staging: the plan already marked tn/tq for the mirror,
  // so the gate leaves order out, and the mirror finds the book unlocked.
  const unlockingStep = {
    async do(name, optsOrFn, maybeFn) {
      if (name.startsWith("reimport-tsvgate-")) {
        t.sqlite.prepare(`UPDATE book_locks SET locked = 0 WHERE book = ?`).run(BOOK);
      }
      return step.do(name, optsOrFn, maybeFn);
    },
  };
  const restore = stubDoor43({ sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ_LOCKED } });
  try {
    await runChunkedReimport(t.env, unlockingStep, BOOK, "inst-unlock", ["tn", "tq"]);
  } finally {
    restore();
  }
  const sha = (resource) =>
    t.sqlite.prepare(`SELECT source_sha FROM book_resource_syncs WHERE book = ? AND resource = ?`).get(BOOK, resource).source_sha;
  eq(order(t.sqlite, "tn_rows").slice(0, 2), ["1:1|aaaa", "1:1|bbbb"], "night 1: neither the mirror nor the apply moved 1:1");
  eq(sha("tn") !== SHA_1 && sha("tq") !== SHA_1, true, "night 1: the watermark is not advanced to master's SHA");

  // Night 2, same master, book still unlocked: the ordinary path and its
  // order gate apply Door43's order.
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ_LOCKED } });
  eq(order(t.sqlite, "tn_rows").slice(0, 2), ["1:1|bbbb", "1:1|aaaa"], "night 2: tn 1:1 takes Door43's order");
  eq(order(t.sqlite, "tq_rows").slice(0, 2), ["1:1|qa02", "1:1|qa01"], "night 2: tq 1:1 takes Door43's order");
  eq(sha("tn"), SHA_1, "night 2: the watermark advances");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall order-only-chapter journey checks passed");

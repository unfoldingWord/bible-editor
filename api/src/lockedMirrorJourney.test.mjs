// Issue #1418 journey: for a LOCKED book the nightly sync makes D1's tn/tq/twl
// rows an exact copy of Door43 master (text, order, additions, deletions),
// except a row a person changed in Bible Editor after the last confirmed push,
// which is kept and flagged (review_kind 'mirror_kept').
//
// Drives the REAL runChunkedReimport on the real migration schema, with Door43
// replaced by a stub (commits / contents / raw) and R2 by a Map, the same
// harness aiRowDiffGate.test.mjs uses for #857.
//
// Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/lockedMirrorJourney.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runChunkedReimport, setMirrorRowsPerStepForTest } from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

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

function makeBlobs() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v };
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    keys: () => [...store.keys()],
  };
}

// Door43 stand-in serving one file per resource. `files[resource]` is master's
// body; `sha` is master's head commit for every file.
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
  return { sqlite, env: { DB: makeDb(sqlite), BLOBS: makeBlobs() } };
}

function tn(sqlite, { id, ref, note, sort, updatedBy = null, preserve = 0, lastSource = null, updatedAt = null }) {
  const [ch, v] = ref.split(":").map(Number);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, preserve, last_change_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, ch, v, ref, note, sort, updatedBy, preserve, lastSource, updatedAt ?? T0 - 500);
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
// A person's in-app edit (source NULL, like rows.ts), at `at`.
function userEdit(sqlite, kind, id, at, action = "update") {
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, created_at)
       VALUES (?, ?, ?, 42, 1, 2, ?, NULL, ?)`,
    )
    .run(kind, id, BOOK, action, at);
}
function confirmPush(sqlite, resource, { at, editId }) {
  sqlite
    .prepare(
      `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin, master_confirmed_at, master_confirmed_edit_id)
       VALUES (?, ?, ?, ?, 'reimport', ?, ?)
       ON CONFLICT(book, resource) DO UPDATE SET master_confirmed_at = excluded.master_confirmed_at,
         master_confirmed_edit_id = excluded.master_confirmed_edit_id`,
    )
    .run(BOOK, resource, OLD_SHA, at, at, editId);
}
const maxEditId = (sqlite) => sqlite.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM edit_log`).get().m;

// D1's live rows in the export's order (exportWorkflow.ts buildResource).
function d1Tn(sqlite) {
  return sqlite
    .prepare(
      `SELECT id, ref_raw, note FROM tn_rows WHERE book = ? AND deleted_at IS NULL AND trashed_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    )
    .all(BOOK)
    .map((r) => `${r.ref_raw}|${r.id}|${r.note}`);
}
function d1Tq(sqlite) {
  return sqlite
    .prepare(
      `SELECT id, ref_raw, question FROM tq_rows WHERE book = ? AND deleted_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    )
    .all(BOOK)
    .map((r) => `${r.ref_raw}|${r.id}|${r.question}`);
}
const flagOf = (sqlite, table, id) =>
  sqlite.prepare(`SELECT review_kind FROM ${table} WHERE book = ? AND id = ?`).get(BOOK, id)?.review_kind ?? null;

// The seed: night 0 was a confirmed push of exactly these rows.
function seed({ locked }) {
  const t = freshEnv({ locked });
  const s = t.sqlite;
  tn(s, { id: "aaaa", ref: "1:1", note: "A", sort: 100 });
  tn(s, { id: "bbbb", ref: "1:1", note: "B", sort: 200 });
  // Edited in the app BEFORE the last confirmed push: master holds it.
  tn(s, { id: "cccc", ref: "1:2", note: "C edited", sort: 100, updatedBy: 42, lastSource: "user" });
  userEdit(s, "tn", "cccc", T0 - 100);
  // Edited in the app before the push; a Door43 editor then deletes it (#1415).
  tn(s, { id: "dddd", ref: "1:3", note: "D edited", sort: 100, updatedBy: 42, lastSource: "user" });
  userEdit(s, "tn", "dddd", T0 - 100);
  // A preserved note a Door43 editor deletes.
  tn(s, { id: "eeee", ref: "1:3", note: "E", sort: 200, preserve: 1 });
  // Pending: master had "F"; a person changed it after the push (unlock, edit,
  // lock & push still waiting to merge).
  tn(s, { id: "ffff", ref: "1:4", note: "F", sort: 100 });
  // Chapter 2: the only Door43 change is the order of these two (#1411).
  tn(s, { id: "hhhh", ref: "2:1", note: "H", sort: 100 });
  tn(s, { id: "iiii", ref: "2:1", note: "I", sort: 200 });
  tq(s, { id: "qa01", ref: "2:1", q: "Q1", a: "A1", sort: 100 });
  tq(s, { id: "qa02", ref: "2:1", q: "Q2", a: "A2", sort: 200 });
  confirmPush(s, "tn", { at: T0, editId: maxEditId(s) });
  confirmPush(s, "tq", { at: T0, editId: maxEditId(s) });
  // After the push: the pending edit and a pending in-app create.
  s.prepare(`UPDATE tn_rows SET note = 'F fixed in app', updated_by = 42, last_change_source = 'user', updated_at = ? WHERE id = 'ffff'`).run(T0 + 100);
  userEdit(s, "tn", "ffff", T0 + 100);
  tn(s, { id: "gggg", ref: "1:5", note: "G new in app", sort: 100, updatedBy: 42, lastSource: "user", updatedAt: T0 + 100 });
  userEdit(s, "tn", "gggg", T0 + 100, "create");
  return t;
}

// Master after Door43 edits: cccc text changed, jjjj added, dddd and eeee
// deleted, ffff edited by a Door43 editor too, chapter 2 reordered.
const MASTER_TN = [
  TN_HEADER,
  tnLine("1:1", "aaaa", "A"),
  tnLine("1:1", "bbbb", "B changed on Door43"),
  tnLine("1:2", "cccc", "C changed on Door43"),
  tnLine("1:2", "jjjj", "J added on Door43"),
  tnLine("1:4", "ffff", "F changed on Door43"),
  tnLine("2:1", "iiii", "I"),
  tnLine("2:1", "hhhh", "H"),
].join("\n");
const MASTER_TQ = [TQ_HEADER, tqLine("2:1", "qa02", "Q2", "A2"), tqLine("2:1", "qa01", "Q1", "A1")].join("\n");

// What D1 must hold after a locked night: master exactly, plus the two pending
// rows kept (ffff's app text, gggg) in place.
const EXPECTED_LOCKED_TN = [
  "1:1|aaaa|A",
  "1:1|bbbb|B changed on Door43",
  "1:2|cccc|C changed on Door43",
  "1:2|jjjj|J added on Door43",
  "1:4|ffff|F fixed in app",
  "1:5|gggg|G new in app",
  "2:1|iiii|I",
  "2:1|hhhh|H",
];
const EXPECTED_LOCKED_TQ = ["2:1|qa02|Q2", "2:1|qa01|Q1"];

async function night(t, state, stepRunner = step) {
  const restore = stubDoor43(state);
  try {
    return await runChunkedReimport(t.env, stepRunner, BOOK, `inst-${Math.random()}`, ["tn", "tq"]);
  } finally {
    restore();
  }
}

console.log("\n[#1418 — locked book: the nightly sync mirrors Door43 master, keeping the post-push app edits]");
{
  const t = seed({ locked: true });
  const state = { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } };
  await night(t, state);
  eq(d1Tn(t.sqlite), EXPECTED_LOCKED_TN, "night 1: tn equals master (text, order, additions, deletions) except the pending rows");
  eq(d1Tq(t.sqlite), EXPECTED_LOCKED_TQ, "night 1: tq takes master's order-only change (#1411)");
  eq(flagOf(t.sqlite, "tn_rows", "ffff"), "mirror_kept", "the pending edit is kept and flagged");
  eq(flagOf(t.sqlite, "tn_rows", "gggg"), "mirror_kept", "the pending in-app create is kept and flagged");
  eq(flagOf(t.sqlite, "tn_rows", "aaaa"), null, "an untouched row carries no flag");

  // Nights 2 and 3: master is quiet (same SHA, now the stored watermark). The
  // kept rows must survive and stay flagged; nothing else moves.
  for (const n of [2, 3]) {
    await night(t, state);
    eq(d1Tn(t.sqlite), EXPECTED_LOCKED_TN, `night ${n}: tn unchanged, pending rows still kept`);
    eq(flagOf(t.sqlite, "tn_rows", "ffff"), "mirror_kept", `night ${n}: ffff still flagged`);
    eq(flagOf(t.sqlite, "tn_rows", "gggg"), "mirror_kept", `night ${n}: gggg still flagged`);
  }

  // The lock/push merges: master now carries the app's rows, and the push is
  // confirmed past their edits. The flags go and D1 equals master exactly.
  const body = [
    TN_HEADER,
    tnLine("1:1", "aaaa", "A"),
    tnLine("1:1", "bbbb", "B changed on Door43"),
    tnLine("1:2", "cccc", "C changed on Door43"),
    tnLine("1:2", "jjjj", "J added on Door43"),
    tnLine("1:4", "ffff", "F fixed in app"),
    tnLine("1:5", "gggg", "G new in app"),
    tnLine("2:1", "iiii", "I"),
    tnLine("2:1", "hhhh", "H"),
  ].join("\n");
  confirmPush(t.sqlite, "tn", { at: T0 + 200, editId: maxEditId(t.sqlite) });
  await night(t, { sha: SHA_2, files: { tn: body, tq: MASTER_TQ } });
  eq(d1Tn(t.sqlite), EXPECTED_LOCKED_TN, "after the push merges: D1 equals master exactly");
  eq(flagOf(t.sqlite, "tn_rows", "ffff"), null, "after the push merges: ffff's flag is cleared");
  eq(flagOf(t.sqlite, "tn_rows", "gggg"), null, "after the push merges: gggg's flag is cleared");
}

console.log("\n[#1418 — locked book whose master is quiet (SHA = watermark) but D1 drifted: healed on the first night]");
{
  const t = seed({ locked: true });
  // Master's SHA is already the stored watermark; D1 holds the old order and
  // the deleted rows. Before #1418 the SHA match skipped the book entirely.
  t.sqlite.prepare(`UPDATE book_resource_syncs SET source_sha = ? WHERE book = ?`).run(SHA_1, BOOK);
  // An app-side tn tag on a row that matches master. The export blanks Tags,
  // so master's blank is no Door43 change: the mirror (the only writer on a
  // quiet night) must leave the tag and the row alone.
  t.sqlite.prepare(`UPDATE tn_rows SET tags = 'ISSUE:MATCH_FAIL' WHERE id = 'aaaa'`).run();
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(
    { ...t.sqlite.prepare(`SELECT tags, version FROM tn_rows WHERE id = 'aaaa'`).get() },
    { tags: "ISSUE:MATCH_FAIL", version: 1 },
    "quiet master: a tn tag master cannot carry is kept, and the row is not rewritten",
  );
  eq(d1Tn(t.sqlite), EXPECTED_LOCKED_TN, "quiet master: tn healed to master except the pending rows");
  eq(d1Tq(t.sqlite), EXPECTED_LOCKED_TQ, "quiet master: tq order healed");
}

console.log("\n[#1418 — locked book: an in-app reorder after the push (no edit_log row) is kept]");
{
  const t = seed({ locked: true });
  // Master still holds the pushed order H, I; a person swapped them in the app
  // after the push. A reorder writes only sort_order + provenance.
  t.sqlite.prepare(`UPDATE tn_rows SET sort_order = 300, last_change_source = 'user', last_change_action = 'reorder', updated_at = ? WHERE id = 'hhhh'`).run(T0); // same second as the push: still kept
  const masterOldOrder = MASTER_TN.replace(`${tnLine("2:1", "iiii", "I")}\n${tnLine("2:1", "hhhh", "H")}`, `${tnLine("2:1", "hhhh", "H")}\n${tnLine("2:1", "iiii", "I")}`);
  const state = { sha: SHA_1, files: { tn: masterOldOrder, tq: MASTER_TQ } };
  for (const n of [1, 2]) {
    await night(t, state);
    eq(d1Tn(t.sqlite).filter((r) => r.startsWith("2:1")), ["2:1|iiii|I", "2:1|hhhh|H"], `night ${n}: the app's order for 2:1 is kept`);
  }
}

console.log("\n[#1418 — locked book: dismissing a review flag after the push does not make a row pending]");
{
  const t = seed({ locked: true });
  // bbbb: a person dismissed a review flag after the push (provenance only,
  // no content change). Door43's edit to it must still land.
  t.sqlite.prepare(`UPDATE tn_rows SET last_change_source = 'user', last_change_action = 'dismiss_review', updated_at = ? WHERE id = 'bbbb'`).run(T0 + 100);
  // Quiet master (SHA = watermark), so the mirror is the only writer tonight.
  t.sqlite.prepare(`UPDATE book_resource_syncs SET source_sha = ? WHERE book = ?`).run(SHA_1, BOOK);
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(d1Tn(t.sqlite).find((r) => r.includes("|bbbb|")), "1:1|bbbb|B changed on Door43", "the dismissed row takes Door43's text");
  eq(flagOf(t.sqlite, "tn_rows", "bbbb"), null, "and is not flagged mirror_kept");
}

const syncOf = (sqlite, resource) =>
  sqlite.prepare(`SELECT source_sha FROM book_resource_syncs WHERE book = ? AND resource = ?`).get(BOOK, resource)?.source_sha ?? null;
const withholdOf = (sqlite, resource) =>
  sqlite.prepare(`SELECT reason FROM sync_withholds WHERE book = ? AND resource = ?`).get(BOOK, resource)?.reason ?? null;

console.log("\n[#1418 review A1 — quiet master, a pipeline job holds chapter 2: the mirror leaves it, and the watermark is withheld]");
{
  const t = seed({ locked: true });
  t.sqlite.prepare(`UPDATE book_resource_syncs SET source_sha = ? WHERE book = ?`).run(SHA_1, BOOK);
  t.sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job1', 42, 'notes', ?, 2, 2, 'sess1', 'running')`,
    )
    .run(BOOK);
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(d1Tn(t.sqlite).filter((r) => r.startsWith("2:1")), ["2:1|hhhh|H", "2:1|iiii|I"], "the held chapter's tn order is left alone");
  eq(d1Tn(t.sqlite).some((r) => r.startsWith("1:3|dddd|")), false, "an unheld chapter is still mirrored");
  eq(syncOf(t.sqlite, "tn"), "withheld", "tn watermark no longer certifies master's SHA");
  eq(withholdOf(t.sqlite, "tn"), "prune_locked", "and the reason is recorded");
  eq(syncOf(t.sqlite, "tq"), SHA_1, "tq (a notes job does not hold it) keeps its watermark");
}

console.log("\n[#1418 review A3 — a mirror step that throws: the run finishes, the watermark is withheld]");
{
  const t = seed({ locked: true });
  const throwing = {
    async do(name, optsOrFn, maybeFn) {
      if (name.startsWith("reimport-mirror-") && name.includes("-tn-")) throw new Error("simulated D1 failure");
      return step.do(name, optsOrFn, maybeFn);
    },
  };
  let threw = false;
  try {
    await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } }, throwing);
  } catch {
    threw = true;
  }
  eq(threw, false, "runChunkedReimport does not throw");
  eq(syncOf(t.sqlite, "tn") === SHA_1, false, "tn (changed this night) is not stamped with master's SHA");
  eq(syncOf(t.sqlite, "tq"), SHA_1, "tq still reaches the sync step and is stamped");
  eq(d1Tq(t.sqlite), EXPECTED_LOCKED_TQ, "tq's mirror still ran");
}

console.log("\n[#1418 review A2 — a per-step cap of 2 rows: the mirror spreads over steps and still ends equal to master]");
{
  const prev = setMirrorRowsPerStepForTest(2);
  try {
    const t = seed({ locked: true });
    const names = [];
    const counting = {
      async do(name, optsOrFn, maybeFn) {
        names.push(name);
        return step.do(name, optsOrFn, maybeFn);
      },
    };
    await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } }, counting);
    eq(d1Tn(t.sqlite), EXPECTED_LOCKED_TN, "tn equals master except the pending rows");
    eq(names.filter((n) => n.startsWith(`reimport-mirror-${BOOK}-tn-`)).length > 1, true, "tn's mirror took more than one step");
    eq(syncOf(t.sqlite, "tn"), SHA_1, "a mirror that finished within its steps certifies the watermark");
  } finally {
    setMirrorRowsPerStepForTest(prev);
  }
}

// A non-content action as rows.ts writes it: the provenance stamp (setTnBit,
// setTnTrashed, dismiss-review) plus its edit_log row (source NULL).
function userAction(sqlite, id, action, at, payload = null) {
  sqlite
    .prepare(`UPDATE tn_rows SET last_change_source = 'user', last_change_action = ?, updated_at = ? WHERE book = ? AND id = ?`)
    .run(action, at, BOOK, id);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json, created_at)
       SELECT 'tn', id, book, 42, version, version, ?, NULL, ?, ? FROM tn_rows WHERE book = ? AND id = ?`,
    )
    .run(action, payload, at, BOOK, id);
}
const quietMaster = (t) => t.sqlite.prepare(`UPDATE book_resource_syncs SET source_sha = ? WHERE book = ?`).run(SHA_1, BOOK);

console.log("\n[#1428 item 1 — a write that loses its version check withholds the watermark; the next night heals it]");
{
  const t = seed({ locked: true });
  quietMaster(t);
  // bbbb's version moves between the mirror's read and its write (the race a
  // CAS guards against).
  let inTnMirror = false;
  let bumped = false;
  const batch = t.env.DB.batch;
  t.env.DB.batch = async (stmts) => {
    if (inTnMirror && !bumped) {
      bumped = true;
      t.sqlite.prepare(`UPDATE tn_rows SET version = version + 1 WHERE book = ? AND id = 'bbbb'`).run(BOOK);
    }
    return batch(stmts);
  };
  const racing = {
    async do(name, optsOrFn, maybeFn) {
      inTnMirror = name === `reimport-mirror-${BOOK}-tn-0`;
      try {
        return await step.do(name, optsOrFn, maybeFn);
      } finally {
        inTnMirror = false;
      }
    },
  };
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } }, racing);
  eq(bumped, true, "the race fired inside the tn mirror step");
  eq(d1Tn(t.sqlite).find((r) => r.includes("|bbbb|")), "1:1|bbbb|B", "night 1: the raced row is still D1's");
  eq(syncOf(t.sqlite, "tn"), "withheld", "night 1: tn watermark is withheld, not certified at master's SHA");
  eq(withholdOf(t.sqlite, "tn"), "apply_incomplete", "night 1: and the reason is apply_incomplete");
  t.env.DB.batch = batch;
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(d1Tn(t.sqlite).find((r) => r.includes("|bbbb|")), "1:1|bbbb|B changed on Door43", "night 2: the row takes Door43's text");
  eq(syncOf(t.sqlite, "tn"), SHA_1, "night 2: the watermark is certified");
}

console.log("\n[#1428 item 2 — preserve/hint toggles after the push are not content; trash is]");
{
  const t = seed({ locked: true });
  quietMaster(t);
  userAction(t.sqlite, "bbbb", "preserve", T0 + 100);
  t.sqlite.prepare(`UPDATE tn_rows SET preserve = 1 WHERE id = 'bbbb'`).run();
  userAction(t.sqlite, "cccc", "hint", T0 + 100);
  userAction(t.sqlite, "cccc", "unhint", T0 + 110);
  // A trash after the push is a removal the pending push ships (the export
  // leaves trashed notes out), so it stays pending.
  userAction(t.sqlite, "aaaa", "trash", T0 + 100);
  t.sqlite.prepare(`UPDATE tn_rows SET trashed_at = ? WHERE id = 'aaaa'`).run(T0 + 100);
  // A toggle on a row in a verse Door43 reordered: the stamp may hide an
  // earlier in-app drag, so that verse's order is left as D1 has it.
  userAction(t.sqlite, "hhhh", "preserve", T0 + 100);
  const res = await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  const rows = d1Tn(t.sqlite);
  eq(rows.find((r) => r.includes("|bbbb|")), "1:1|bbbb|B changed on Door43", "a preserve toggle: the row takes Door43's text");
  eq(flagOf(t.sqlite, "tn_rows", "bbbb"), null, "…and is not flagged mirror_kept");
  eq(rows.find((r) => r.includes("|cccc|")), "1:2|cccc|C changed on Door43", "hint then unhint: the row takes Door43's text");
  eq(flagOf(t.sqlite, "tn_rows", "cccc"), null, "…and is not flagged mirror_kept");
  eq(rows.some((r) => r.includes("|aaaa|")), false, "a trash after the push stays trashed (pending removal)");
  eq(rows.filter((r) => r.startsWith("2:1")), ["2:1|hhhh|H", "2:1|iiii|I"], "the toggled row's verse keeps D1's order");
  eq(res.perResource.tn.mirror_kept, 2, "kept: only the two flagged rows (ffff, gggg) count");
}

console.log("\n[#1428 item 2 — a dismissal after the push does not hold its verse's order]");
{
  const t = seed({ locked: true });
  quietMaster(t);
  userAction(t.sqlite, "hhhh", "dismiss_review", T0 + 100, JSON.stringify({ review_kind: "merge_conflict", review_reason: "x" }));
  t.sqlite
    .prepare(`UPDATE tq_rows SET last_change_source = 'user', last_change_action = 'review_clear', updated_at = ? WHERE id = 'qa01'`)
    .run(T0 + 100);
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(d1Tn(t.sqlite).filter((r) => r.startsWith("2:1")), ["2:1|iiii|I", "2:1|hhhh|H"], "tn 2:1 takes Door43's order");
  eq(d1Tq(t.sqlite), EXPECTED_LOCKED_TQ, "tq 2:1 takes Door43's order");
}

console.log("\n[#1428 item 3 — a dismissed mirror_kept flag stays dismissed]");
{
  const t = seed({ locked: true });
  // gggg: a person dismissed some OTHER flag after the push. That must not
  // stop its first mirror_kept flag.
  userAction(t.sqlite, "gggg", "dismiss_review", T0 + 150, JSON.stringify({ review_kind: "merge_conflict", review_reason: "x" }));
  const state = { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } };
  await night(t, state);
  eq(flagOf(t.sqlite, "tn_rows", "ffff"), "mirror_kept", "night 1: ffff flagged");
  eq(flagOf(t.sqlite, "tn_rows", "gggg"), "mirror_kept", "night 1: gggg flagged despite an earlier dismissal of another kind");
  // A person dismisses ffff's mirror_kept flag (rows.ts dismiss-review).
  t.sqlite.prepare(`UPDATE tn_rows SET review_kind = NULL, review_reason = NULL, review_master_json = NULL WHERE id = 'ffff'`).run();
  userAction(t.sqlite, "ffff", "dismiss_review", T0 + 300, JSON.stringify({ review_kind: "mirror_kept", review_reason: "x" }));
  for (const n of [2, 3]) {
    const res = await night(t, state);
    eq(d1Tn(t.sqlite).find((r) => r.includes("|ffff|")), "1:4|ffff|F fixed in app", `night ${n}: ffff still keeps the app's text`);
    eq(flagOf(t.sqlite, "tn_rows", "ffff"), null, `night ${n}: ffff's dismissed flag stays dismissed`);
    eq(flagOf(t.sqlite, "tn_rows", "gggg"), "mirror_kept", `night ${n}: gggg still flagged`);
    eq(res.perResource.tn.mirror_kept, 1, `night ${n}: kept counts the one flagged row`);
  }
}

console.log("\n[#1428 item 5 — kept rows in a pipeline-held chapter are not counted as flagged]");
{
  const t = seed({ locked: true });
  quietMaster(t);
  t.sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job1', 42, 'notes', ?, 1, 1, 'sess1', 'running')`,
    )
    .run(BOOK);
  const res = await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  eq(flagOf(t.sqlite, "tn_rows", "ffff"), null, "the held chapter's pending row is not flagged");
  eq(res.perResource.tn.mirror_kept ?? 0, 0, "and kept does not count it");
}

console.log("\n[#1418 — locked book with no confirmed push at all: nothing is mirrored (fail safe)]");
{
  const t = seed({ locked: true });
  t.sqlite.prepare(`UPDATE book_resource_syncs SET master_confirmed_at = NULL, master_confirmed_edit_id = NULL`).run();
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  const ids = d1Tn(t.sqlite).map((r) => r.split("|")[1]);
  eq(ids.includes("dddd") && ids.includes("gggg"), true, "no boundary: the human-edited row and the app create both stay");
}

console.log("\n[control — unlocked book: the merge behaves as before (no mirror)]");
{
  const t = seed({ locked: false });
  await night(t, { sha: SHA_1, files: { tn: MASTER_TN, tq: MASTER_TQ } });
  const rows = d1Tn(t.sqlite);
  eq(rows.some((r) => r.startsWith("1:3|dddd|")), true, "unlocked: a human-edited row Door43 deleted stays (#1415 gap, unchanged)");
  eq(rows.some((r) => r.startsWith("1:4|ffff|F fixed in app")), true, "unlocked: the app edit stays");
  eq(flagOf(t.sqlite, "tn_rows", "gggg"), null, "unlocked: no mirror_kept flag is minted");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall locked-mirror journey checks passed");

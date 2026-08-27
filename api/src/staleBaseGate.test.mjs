// Regression coverage for issue #639 — the nightly sync silently adopting a
// stale-base master revert on PRISTINE verse rows (2CH ULT, 19 verses,
// 2026-08-26).
//
// The fixtures are the real incident, not an invented shape:
//   * previous revision  81a00c44  `\id … Thu Oct 14 2021 10:35:18 …  tc`
//   * reverting merge    a1e8182a  `\id … Wed Jul 08 2026 06:18:55 …  tc`
//   * book_resource_syncs (2CH, ult).synced_at  =  2026-08-14 05:42Z
// All three read off git.door43.org / prod D1 on 2026-08-27 and quoted in the
// issue. Note what they say: the incoming stamp is five years NEWER than the
// file's own previous stamp, so any "did master go backwards relative to its
// own history" test passes this file. The regression is only visible against
// OUR watermark.
//
// Run from api/ (needs sqlite + strip-types + the resolve hook, so that
// planAndStageBookResourcesForTest can pull bookReimport.ts's extensionless
// imports):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/staleBaseGate.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTcExportStamp, decideStaleBaseReplacement } from "./staleBaseGate.ts";
import {
  recordStaleBaseHold,
  raiseStaleBaseHoldAlert,
  clearStaleBaseHold,
  staleBaseAlertSource,
  staleBaseAlertMessage,
} from "./staleBaseHolds.ts";
import { staleBaseOverrideAllowed } from "./reimportSyncGate.ts";
import { planAndStageBookResourcesForTest } from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// ── The incident's three measurements ────────────────────────────────────────
const PREV_SHA = "81a00c44b314043a980372c0caaadec724c88060";
const MASTER_SHA = "a1e8182af6b8b72f762e676d5307f32fee358f84";
const PREV_ID_LINE = "\\id 2CH EN_ULT en_English_ltr Thu Oct 14 2021 10:35:18 GMT-0500 (Central Daylight Time) tc";
const INCOMING_ID_LINE = "\\id 2CH EN_ULT en_English_ltr Wed Jul 08 2026 06:18:55 GMT-0400 (Eastern Daylight Time) tc";
const PREV_TC = parseTcExportStamp(PREV_ID_LINE);
const INCOMING_TC = parseTcExportStamp(INCOMING_ID_LINE);
const SYNCED_AT = secs("2026-08-14T05:42:00Z");

// ── 1. The `\id` parser, against real corpus lines ───────────────────────────
console.log("\n1. \\id translationCore stamp parser");
eq(new Date(INCOMING_TC * 1000).toISOString(), "2026-07-08T10:18:55.000Z", "incident merge stamp parses (Jul 08 2026, GMT-0400)");
eq(new Date(PREV_TC * 1000).toISOString(), "2021-10-14T15:35:18.000Z", "pre-merge stamp parses (Oct 14 2021, GMT-0500)");
eq(
  parseTcExportStamp("\\id GEN EN_ULT en_English_ltr Sat May 27 2023 15:49:17 GMT-0500 (Central Daylight Time) tc\n\\h Genesis"),
  secs("2023-05-27T20:49:17Z"),
  "parses out of a whole file, not just a bare line",
);
eq(parseTcExportStamp("\\id 2CH"), null, "a bare \\id with no tC tail is null, not a guess");
eq(parseTcExportStamp("\\id 2CH EN_ULT en_English_ltr not a date at all tc"), null, "an unparseable date is null");
eq(parseTcExportStamp(""), null, "empty file is null");
eq(parseTcExportStamp(null), null, "null input is null");

// ── 2. The gate, and an ablation of every conjunct ───────────────────────────
// Each case removes exactly ONE input from the incident shape. If the gate
// still held, that conjunct would be decorative.
console.log("\n2. decideStaleBaseReplacement — the incident, and one ablation per conjunct");
const INCIDENT = { incomingTcExportAt: INCOMING_TC, previousTcExportAt: PREV_TC, syncedAt: SYNCED_AT };

const held = decideStaleBaseReplacement(INCIDENT);
eq(held.hold, true, "2CH ULT incident shape → HOLD");
eq(held.reason, "stale_tc_reexport", "…with the measured reason");

eq(
  decideStaleBaseReplacement({ ...INCIDENT, previousTcExportAt: INCOMING_TC }),
  { hold: false, reason: "tc_stamp_unchanged", incomingTcExportAt: INCOMING_TC, previousTcExportAt: INCOMING_TC, syncedAt: SYNCED_AT },
  "ABLATE the tC-re-export signal (stamp unchanged) → adopts",
);
eq(
  decideStaleBaseReplacement({ ...INCIDENT, syncedAt: secs("2026-06-01T00:00:00Z") }).reason,
  "tc_export_current",
  "ABLATE the staleness signal (snapshot newer than our sync) → adopts",
);
eq(
  decideStaleBaseReplacement({ ...INCIDENT, incomingTcExportAt: null }).hold,
  false,
  "no incoming stamp → adopts (fail open: pre-existing behavior, never a stall)",
);
eq(
  decideStaleBaseReplacement({ ...INCIDENT, previousTcExportAt: null }).hold,
  false,
  "previous revision unreadable → adopts (fail open)",
);
eq(
  decideStaleBaseReplacement({ ...INCIDENT, syncedAt: null }).hold,
  false,
  "no watermark time → adopts (fail open)",
);
eq(
  decideStaleBaseReplacement({ ...INCIDENT, syncedAt: INCOMING_TC }).reason,
  "tc_export_current",
  "snapshot exactly at synced_at → adopts (boundary is inclusive on the safe side)",
);

// Success check (iii): an ordinary incremental master edit must still adopt.
// Stephen's own 19-verse Ketiv/Qere fix is a hand edit on Door43 — it does not
// touch the `\id` line, so the stamp is identical on both sides.
console.log("\n3. an ordinary out-of-band master edit still adopts cleanly");
eq(
  decideStaleBaseReplacement({ incomingTcExportAt: PREV_TC, previousTcExportAt: PREV_TC, syncedAt: SYNCED_AT }).hold,
  false,
  "Stephen's hand fix (19 verses, \\id untouched) → adopts, gate does not stall maintenance",
);
// Same for a bp-assistant push and for our own -be- export coming back: neither
// rewrites the header.
eq(
  decideStaleBaseReplacement({ incomingTcExportAt: PREV_TC, previousTcExportAt: PREV_TC, syncedAt: secs("2026-08-26T05:52:00Z") }).reason,
  "tc_stamp_unchanged",
  "a bot/own-publish move of master → adopts regardless of how old the file's tC stamp is",
);
// And a genuinely CURRENT translationCore re-export (someone exports today and
// pushes today) must adopt — the gate is about staleness, not about tC.
eq(
  decideStaleBaseReplacement({
    incomingTcExportAt: secs("2026-08-27T09:00:00Z"),
    previousTcExportAt: PREV_TC,
    syncedAt: SYNCED_AT,
  }).reason,
  "tc_export_current",
  "a fresh whole-book tC re-export → adopts",
);

// ── 4. End-to-end: the real staging decision, with the incident's files ──────
console.log("\n4. planAndStageBookResources replaying the 2CH shape");

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
  const puts = [];
  return {
    sqlite,
    puts,
    env: {
      DB: makeDb(sqlite),
      BLOBS: { async put(k, v) { puts.push({ k, len: v.length }); }, async delete() {} },
      DCS_BASE_URL: "https://dcs.test",
    },
  };
}

// A 2CH ULT file body. Content beyond the header is irrelevant to the gate —
// what matters is which `\id` stamp each revision serves.
const bodyWith = (idLine) => `${idLine}\n\\h 2 Chronicles\n\\c 4\n\\v 11 text\n\\c 5\n\\v 12 text\n`;

function stubFetch({ masterSha, masterBody, prevBodyBySha }) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const u = String(url);
    const resp = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      async text() { return body; },
      async json() { return JSON.parse(body); },
      async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
    });
    if (u.includes("/commits?")) return resp(200, JSON.stringify([{ sha: masterSha }]));
    const m = /[?&]ref=([0-9a-f]{40})/.exec(u);
    if (u.includes("/raw/") && m) {
      const body = m[1] === masterSha ? masterBody : prevBodyBySha[m[1]];
      if (body == null) return resp(404, "");
      const bytes = new TextEncoder().encode(body).byteLength;
      return resp(200, body, { "content-length": String(bytes) });
    }
    return resp(404, "");
  };
  return seen;
}

async function stagePlan({ incomingIdLine, previousIdLine, syncedAt, override }) {
  const { sqlite, env, puts } = freshEnv();
  // A book with verses, all PRISTINE — the majority-of-corpus case the issue is
  // about (2CH ULT: 858 rows, every one updated_by IS NULL).
  sqlite.exec(
    `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version)
     VALUES ('2CH', 4, 11, 'ULT', '{"a":1}', 'a', 2), ('2CH', 5, 12, 'ULT', '{"b":1}', 'b', 2)`,
  );
  // The watermark: D1 last synced from PREV_SHA at syncedAt. No
  // master_confirmed_at, so loadMasterLineage short-circuits without a fetch
  // (it is not what this test is about).
  sqlite
    .prepare(`INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin) VALUES ('2CH','ult',?,?,'reimport')`)
    .run(PREV_SHA, syncedAt);
  const seen = stubFetch({
    masterSha: MASTER_SHA,
    masterBody: bodyWith(incomingIdLine),
    prevBodyBySha: { [PREV_SHA]: bodyWith(previousIdLine) },
  });
  const plan = await planAndStageBookResourcesForTest(env, "2CH", ["ult"], "inst-1", override);
  return { plan, entry: plan.entries[0], seen, puts, sqlite, env };
}

const realFetch = globalThis.fetch;
try {
  // 4a. The incident: master presents the Jul-08-based file.
  const bad = await stagePlan({ incomingIdLine: INCOMING_ID_LINE, previousIdLine: PREV_ID_LINE, syncedAt: SYNCED_AT });
  eq(bad.entry.changed, false, "incident → resource NOT staged, so not one pristine verse is rewritten");
  eq(bad.entry.masterSha, null, "incident → masterSha withheld, so the sync step cannot stamp the watermark");
  eq(bad.entry.staleBaseHold?.masterSha, MASTER_SHA, "incident → the refusal carries the offending revision");
  eq(bad.entry.staleBaseHold?.previousSha, PREV_SHA, "incident → …and the revision it would have reverted to");
  eq(bad.entry.staleBaseHold?.incomingTcExportAt, INCOMING_TC, "incident → …and the snapshot it was exported from");
  eq(bad.puts.length, 0, "incident → nothing staged to R2 either");

  // 4b. ABLATION of the gate's one signal, through the SAME code path: serve the
  // previous revision with the SAME `\id` stamp master now carries. Everything
  // else is byte-for-byte the 4a fixture. If the gate were not doing the work,
  // 4a would look like this.
  const ablated = await stagePlan({ incomingIdLine: INCOMING_ID_LINE, previousIdLine: INCOMING_ID_LINE, syncedAt: SYNCED_AT });
  eq(ablated.entry.changed, true, "ABLATED (no tC re-export) → resource stages and adopts, as before #639");
  eq(ablated.entry.masterSha, MASTER_SHA, "ABLATED → watermark will be stamped");
  eq(ablated.entry.staleBaseHold, undefined, "ABLATED → no refusal recorded");
  eq(ablated.puts.length, 1, "ABLATED → file staged to R2 for the chunk steps");

  // 4c. Success check (iii) through the same path: Stephen's incremental hand
  // fix. Master moved, the `\id` line did not.
  const ok = await stagePlan({ incomingIdLine: PREV_ID_LINE, previousIdLine: PREV_ID_LINE, syncedAt: SYNCED_AT });
  eq(ok.entry.changed, true, "ordinary out-of-band master edit → adopts cleanly (maintenance is not stalled)");
  eq(ok.entry.staleBaseHold, undefined, "ordinary edit → no refusal");

  // 4d. The previous revision must be pinned to a FULL sha — a short one is
  // silently ignored by Gitea's ?ref= and would serve master's own bytes back,
  // making every stale-base merge read as "stamp unchanged".
  const refFetches = bad.seen.filter((u) => /[?&]ref=/.test(u));
  eq(
    refFetches.every((u) => /[?&]ref=[0-9a-f]{40}(&|$)/.test(u)),
    true,
    "every pinned raw fetch uses a full 40-hex sha",
  );
  // 4e. Human release. The gate normally clears itself once master is repaired,
  // because the file is re-staged and re-judged every night — but the one shape
  // that cannot self-release is master keeping the stale tC stamp forever
  // because the newer work was hand-re-applied on top of the stale export. The
  // narrow `allowStaleBase` override is the escape hatch for that, and it must
  // still leave a record of having been used.
  const forced = await stagePlan({
    incomingIdLine: INCOMING_ID_LINE,
    previousIdLine: PREV_ID_LINE,
    syncedAt: SYNCED_AT,
    override: "ult",
  });
  eq(forced.entry.changed, true, "force-released → resource stages and master IS adopted");
  eq(forced.entry.masterSha, MASTER_SHA, "force-released → the watermark will be stamped");
  eq(forced.entry.staleBaseHold, undefined, "force-released → not recorded as a refusal");
  eq(forced.entry.staleBaseOverridden?.masterSha, MASTER_SHA, "force-released → but the override IS recorded");

  // The override is per-resource, never wholesale: naming a different resource
  // must leave this one refused.
  const wrongResource = await stagePlan({
    incomingIdLine: INCOMING_ID_LINE,
    previousIdLine: PREV_ID_LINE,
    syncedAt: SYNCED_AT,
    override: "ust",
  });
  eq(wrongResource.entry.changed, false, "an override naming a DIFFERENT resource does not release this one");
} finally {
  globalThis.fetch = realFetch;
}

// ── 6. The override's own gating ─────────────────────────────────────────────
console.log("\n6. staleBaseOverrideAllowed — deliberately narrow");
{
  const p = { allowStaleBase: true, book: "2CH", resource: "ult" };
  eq(staleBaseOverrideAllowed(p, 1, 1, "ult"), true, "one book + one resource + a match → allowed");
  eq(staleBaseOverrideAllowed(p, 1, 1, "ust"), false, "…but only for the resource actually named");
  eq(staleBaseOverrideAllowed(p, 2, 1, "ult"), false, "two books → refused");
  eq(staleBaseOverrideAllowed(p, 1, 2, "ult"), false, "two resources → refused");
  eq(staleBaseOverrideAllowed({ ...p, allowStaleBase: false }, 1, 1, "ult"), false, "flag off → refused");
  eq(staleBaseOverrideAllowed({ allowStaleBase: true }, 1, 1, "ult"), false, "no book/resource (every cron path) → refused");
}

// ── 7. The force-released banner is a different sentence, not a suffix ───────
console.log("\n7. force-released banner");
{
  const hold = {
    book: "2CH", resource: "ult", masterSha: MASTER_SHA,
    incomingTcExportAt: INCOMING_TC, previousTcExportAt: PREV_TC, syncedAt: SYNCED_AT, previousSha: PREV_SHA,
  };
  const refused = staleBaseAlertMessage(hold, false, false);
  const released = staleBaseAlertMessage(hold, false, true);
  eq(/REFUSED/.test(refused) && !/FORCE-RELEASED/.test(refused), true, "the refusal banner says REFUSED");
  eq(/FORCE-RELEASED/.test(released) && !/REFUSED 2CH/.test(released), true, "the override banner never says REFUSED");
  eq(released !== refused, true, "…and is a distinct message, so it replaces rather than matches the refusal");
}

// ── 5. The durable half: record, banner, stickiness, release ────────────────
console.log("\n5. durable record + banner");
{
  const { sqlite, env } = freshEnv();
  const hold = {
    book: "2CH",
    resource: "ult",
    masterSha: MASTER_SHA,
    incomingTcExportAt: INCOMING_TC,
    previousTcExportAt: PREV_TC,
    syncedAt: SYNCED_AT,
    previousSha: PREV_SHA,
  };
  const t1 = 1_756_000_000;
  eq(await recordStaleBaseHold(env, hold, "stale_tc_reexport", t1), true, "first refusal records");
  await raiseStaleBaseHoldAlert(env, hold, false);

  const row1 = sqlite.prepare(`SELECT * FROM stale_base_holds`).all();
  eq(row1.length, 1, "one durable row");
  eq([row1[0].book, row1[0].resource, row1[0].master_sha], ["2CH", "ult", MASTER_SHA], "keyed on the offending revision");
  eq([row1[0].detected_at, row1[0].last_recorded_at, row1[0].resolved_at], [t1, t1, null], "detected_at == last_recorded_at, unresolved");

  const src = staleBaseAlertSource("2CH", "ult");
  const a1 = sqlite.prepare(`SELECT * FROM system_alerts WHERE source = ?`).all(src);
  eq(a1.length, 1, "one banner raised");
  eq(a1[0].severity, "error", "…at error severity");
  eq(/REFUSED 2CH ULT/.test(a1[0].message), true, "…naming the book and resource");

  // Night two: same revision still on master. Re-record, re-raise.
  const t2 = t1 + 86400;
  await recordStaleBaseHold(env, hold, "stale_tc_reexport", t2);
  await raiseStaleBaseHoldAlert(env, hold, false);
  const row2 = sqlite.prepare(`SELECT * FROM stale_base_holds`).all();
  eq(row2.length, 1, "re-detection updates, never accumulates");
  eq([row2[0].detected_at, row2[0].last_recorded_at], [t1, t2], "detected_at pinned to the FIRST refusal; recency moves");
  eq(sqlite.prepare(`SELECT COUNT(*) c FROM system_alerts WHERE source = ?`).all(src)[0].c, 1, "banner not duplicated");

  // Dismissal stickiness: a dismissed banner with an unchanged message stays
  // dismissed across re-detections (planSystemAlertWrites' byte-identity rule).
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = ? WHERE source = ?`).run(t2, src);
  await raiseStaleBaseHoldAlert(env, hold, false);
  const a3 = sqlite.prepare(`SELECT * FROM system_alerts WHERE source = ?`).all(src);
  eq(a3.length, 1, "dismissed banner is not resurrected by a re-detection");
  eq(a3[0].dismissed_at, t2, "…and stays dismissed");

  // A human resolving the hold must survive re-detection of the same revision.
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'someone')`).run();
  sqlite.prepare(`UPDATE stale_base_holds SET resolved_at = ?, resolved_by = 1`).run(t2);
  await recordStaleBaseHold(env, hold, "stale_tc_reexport", t2 + 86400);
  eq(sqlite.prepare(`SELECT resolved_at FROM stale_base_holds`).all()[0].resolved_at, t2, "a human's release is sticky");

  // A DIFFERENT offending revision is a different event → its own row.
  await recordStaleBaseHold(env, { ...hold, masterSha: "b".repeat(40) }, "stale_tc_reexport", t2 + 86400);
  eq(sqlite.prepare(`SELECT COUNT(*) c FROM stale_base_holds`).all()[0].c, 2, "a new stale revision gets its own record");

  // Clean sync → release everything still active and drop the undismissed banner.
  sqlite.prepare(`UPDATE stale_base_holds SET resolved_at = NULL, resolved_by = NULL`).run();
  sqlite.prepare(`UPDATE system_alerts SET dismissed_at = NULL WHERE source = ?`).run(src);
  await clearStaleBaseHold(env, "2CH", "ult", t2 + 172800);
  eq(sqlite.prepare(`SELECT COUNT(*) c FROM stale_base_holds WHERE resolved_at IS NULL`).all()[0].c, 0, "clean sync releases every active hold");
  eq(sqlite.prepare(`SELECT COUNT(*) c FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`).all(src)[0].c, 0, "…and clears the banner");
}

console.log(failed === 0 ? "\nAll stale-base gate tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

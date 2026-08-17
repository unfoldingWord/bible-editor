// Regression coverage for issue #485: changedTsvChapters (the nightly reimport
// diff gate) was blind to a master-side deletion of an AI-only row.
//
// Run from api/ (needs the sqlite flag + the extensionless-import resolve
// hook — same pattern as reimportJourney.test.mjs):
//   node --experimental-sqlite --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/aiRowDiffGate.test.mjs
//
// Bug recap. changedTsvChapters built its stored side from PRISTINE rows only
// (updated_by IS NULL). softDeleteRemovedTsvRows (the nightly prune) is
// documented to also delete AI-only rows (updated_by set, latest edit_log
// source = ai_pipeline) master no longer carries — but the prune only ever
// runs for chapters changedTsvChapters flags as "changed". An AI-only row was
// invisible to the stored-pristine map, so when a Door43 maintainer deleted it
// on master, BOTH sides of the comparison excluded it: master's incoming map
// (row is gone) and D1's pristine map (row was never pristine). The maps
// matched, the chapter read "unchanged", the prune never ran, and the AI row
// re-exported to master every night — permanently reverting the maintainer's
// deletion, silently.
//
// This file drives the REAL changedTsvChapters against a real (in-memory)
// copy of the production schema, not a hand-typed re-implementation of its
// SQL — the same rationale reimportJourney.test.mjs gives for doing so.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  changedTsvChapters,
  softDeleteRemovedTsvRowsForTest as softDeleteRemovedTsvRows,
  tsvFetchLooksTruncatedForTest as tsvFetchLooksTruncated,
} from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite — mirrors reimportJourney.test.mjs ────
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
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  // Stub users for the updated_by FK — seedAiOnlyRow/seedHumanEditedRow's
  // fixed ids (999, 42) must exist for node:sqlite's FK enforcement.
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (999, 999, 'ai-pipeline-user')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (42, 42, 'a-translator')`).run();
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

const BOOK = "ZEC";

// A pristine tn row that master still carries unchanged — the "nothing to see
// here" chapter, present in both maps at chapter 3.
function seedPristineRow(sqlite, { id = "aaaa", chapter = 3, verse = 1, ref = "3:1", note = "pristine note" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1)`,
    )
    .run(id, BOOK, chapter, verse, ref, note);
}

// An AI-only row: updated_by is set (the pipeline's synthetic user id), and
// its latest edit_log entry is source='ai_pipeline' — the exact shape
// isReimportableRow / softDeleteRemovedTsvRows key on.
function seedAiOnlyRow(sqlite, { id = "bbbb", chapter = 3, verse = 2, ref = "3:2", note = "ai note" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order, updated_by)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 2, 999)`,
    )
    .run(id, BOOK, chapter, verse, ref, note);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       VALUES ('tn', ?, ?, NULL, 0, 1, 'create', 'ai_pipeline')`,
    )
    .run(id, BOOK);
}

// A human-edited row: updated_by is set, but the latest edit_log entry has no
// ai_pipeline source (a real translator PATCH logs source=NULL).
function seedHumanEditedRow(sqlite, { id = "cccc", chapter = 3, verse = 3, ref = "3:3", note = "human note" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order, updated_by)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 3, 42)`,
    )
    .run(id, BOOK, chapter, verse, ref, note);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       VALUES ('tn', ?, ?, 42, 0, 1, 'update', NULL)`,
    )
    .run(id, BOOK);
}

const TN_TSV_HEADER = "ID\tReference\tTags\tSupportReference\tQuote\tOccurrence\tNote";
function tnTsvRow({ id, ref, note }) {
  return `${id}\t${ref}\t\t\t\t\t${note}`;
}

console.log("\n[issue #485 — master deletes an AI-only row: the diff gate must flag its chapter]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite);
  seedAiOnlyRow(sqlite);
  // Master's file now carries ONLY the pristine row — exactly D1's pristine
  // set, so the OLD pristine-only comparison would read this chapter as
  // unchanged even though the AI-only row was deleted on master.
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" })].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(3), true, "chapter 3 IS flagged changed — the AI-only row's deletion is no longer invisible");
}

console.log("\n[control — no AI-only row ever existed: chapter genuinely unchanged]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite);
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" })].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(3), false, "chapter 3 is NOT flagged — nothing changed, the fix must not over-flag");
}

console.log("\n[control — AI-only row still present on master: already caught before this fix]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite);
  seedAiOnlyRow(sqlite);
  const raw = [
    TN_TSV_HEADER,
    tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" }),
    tnTsvRow({ id: "bbbb", ref: "3:2", note: "ai note" }),
  ].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  // The AI row is present in `incoming` but absent from the pristine `stored`
  // map, so size mismatch alone already flags this — pre-existing behavior,
  // pinned here so a future refactor can't quietly regress it.
  eq(changed.has(3), true, "chapter 3 IS flagged — a.size !== b.size still fires (pristine map excludes AI row)");
}

console.log("\n[master deletes a HUMAN-edited row: also flagged (harmless — the prune won't touch it)]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite);
  seedHumanEditedRow(sqlite);
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" })].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(3), true, "chapter 3 IS flagged — errs toward changed for any missing live id, human-edited included");
}

console.log("\n[an already-tombstoned row's absence from master does NOT force a flag]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order, deleted_at)
       VALUES ('dddd', ?, 3, 4, '3:4', NULL, NULL, NULL, NULL, 'already gone', 4, 1753900000)`,
    )
    .run(BOOK);
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" })].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(3), false, "chapter 3 stays unchanged — an already-deleted row is not 'live', so its absence is expected");
}

console.log("\n[an AI-only row deleted in a DIFFERENT chapter does not falsely flag an unrelated chapter]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite, { id: "aaaa", chapter: 3, verse: 1, ref: "3:1" });
  seedAiOnlyRow(sqlite, { id: "bbbb", chapter: 7, verse: 2, ref: "7:2" });
  // Master carries chapter 3 unchanged and never had chapter 7 in this file at
  // all (a book file always covers every chapter it has, but this proves the
  // per-chapter bucketing keys off the row's OWN chapter, not book-wide).
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" })].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(3), false, "chapter 3 unaffected");
  eq(changed.has(7), true, "chapter 7 (where the AI-only row actually lived) IS flagged");
}

// ── P1 follow-up (codex review on PR #501) ─────────────────────────────────
// The widened gate above correctly flags a chapter master emptied
// COMPLETELY, but softDeleteRemovedTsvRows' `coveredChapters` skip only knew
// about chapters with at least one incoming row — a chapter master emptied
// entirely (the AI-only row was the LAST row in it) never got pruned, so
// issue #485 persisted for exactly that case. These cases drive the REAL
// prune (softDeleteRemovedTsvRowsForTest), not just the gate, to prove the
// row is actually removed — and pin the completeness gate it depends on.

console.log("\n[issue #485 P1 follow-up — AI-only row is the ONLY row in its chapter: gate flags AND prune removes it]");
{
  const { sqlite, env } = freshEnv();
  seedPristineRow(sqlite, { id: "aaaa", chapter: 3, verse: 1, ref: "3:1" });
  // chapter 5 has exactly one row, and it's AI-only. Master's file carries
  // nothing at all for chapter 5 — a full deletion of the chapter's only row.
  seedAiOnlyRow(sqlite, { id: "bbbb", chapter: 5, verse: 1, ref: "5:1" });
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "aaaa", ref: "3:1", note: "pristine note" })].join("\n");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(5), true, "chapter 5 IS flagged changed — the widened gate catches the fully-emptied chapter");

  // verifiedComplete: true — this fetch is treated as carrying fetchDcsMasterText's
  // independent completeness proof (fetchTsvMasterVerified succeeded), so the
  // widened coveredChapters extension is trusted.
  const res = await softDeleteRemovedTsvRows(env, BOOK, "tn", raw, [...changed], true);
  eq(res.deleted, 1, "the prune actually deletes the AI-only row, not just flags its chapter");

  const row = sqlite.prepare(`SELECT deleted_at, updated_by FROM tn_rows WHERE book = ? AND id = 'bbbb'`).all(BOOK)[0];
  eq(row.deleted_at !== null, true, "the row is tombstoned (deleted_at set)");
  eq(row.updated_by, null, "updated_by reclaimed to NULL — reimport-owned tombstone");
}

console.log("\n[control — a truncated/incomplete fetch must NOT be trusted as a genuinely-emptied chapter]");
{
  const { sqlite, env } = freshEnv();
  // A book-sized live D1 (>= SHRINK_GUARD_MIN_LIVE) so the shrink guard can
  // trip: 21 pristine rows across chapter 3, plus the AI-only row at chapter 5
  // that a truncated fetch would otherwise look like it emptied.
  for (let i = 0; i < 21; i++) {
    seedPristineRow(sqlite, { id: `p${String(i).padStart(3, "0")}`, chapter: 3, verse: i + 1, ref: `3:${i + 1}` });
  }
  seedAiOnlyRow(sqlite, { id: "bbbb", chapter: 5, verse: 1, ref: "5:1" });

  // A ~1-row body — the HAB tn incident shape (no Content-Length, a partial
  // read) — parses to far fewer rows than the 22 D1 holds live, so it must
  // read as truncated, not as "master emptied chapter 5".
  const raw = [TN_TSV_HEADER, tnTsvRow({ id: "p000", ref: "3:1", note: "pristine note" })].join("\n");

  const truncated = await tsvFetchLooksTruncated(env, BOOK, "tn", raw);
  eq(truncated, true, "the completeness gate flags this fetch as truncated");

  // Mirrors what both real callers do: a truncated fetch is treated as
  // not-fetched (raw discarded) BEFORE it can reach the prune at all — so the
  // prune must never run here, and the AI-only row must survive untouched.
  if (!truncated) {
    await softDeleteRemovedTsvRows(env, BOOK, "tn", raw, [3, 5], false);
  }
  const row = sqlite.prepare(`SELECT deleted_at FROM tn_rows WHERE book = ? AND id = 'bbbb'`).all(BOOK)[0];
  eq(row.deleted_at, null, "the AI-only row survives — a truncated fetch never gets to drive the prune");
}

// ── Second P1 follow-up (codex re-review of b826dcb) ───────────────────────
// b826dcb's coveredChapters widening was gated only on "the caller already
// survived tsvFetchLooksTruncated" — but that gate is a LOSS-PERCENTAGE
// heuristic (isCatastrophicTsvShrink: >=50% drop, and only above
// SHRINK_GUARD_MIN_LIVE live rows), not a positive completeness guarantee. A
// fetch that is genuinely partial — e.g. it silently dropped one chapter's
// only row — but whose overall loss stays under that 50% threshold sails
// through tsvFetchLooksTruncated as "not truncated" while still being wrong
// about chapter 5 specifically. This proves that shape: the same fixture as
// the fully-emptied-chapter case above, but WITHOUT a positive completeness
// proof for this fetch (verifiedComplete: false — simulating
// fetchDcsMasterText being unavailable/returning null so only the
// loss-percentage heuristic passed). The prune must fall back to the
// conservative pre-b826dcb behavior and leave chapter 5 alone.
console.log("\n[second P1 follow-up — a partial fetch that PASSES the loss-percentage heuristic, without positive completeness proof, must NOT prune an absent chapter]");
{
  const { sqlite, env } = freshEnv();
  // 21 pristine rows in chapter 3 + 1 AI-only row in chapter 5 = 22 live rows
  // (>= SHRINK_GUARD_MIN_LIVE). The incoming body carries all 21 chapter-3 rows
  // but omits chapter 5 entirely: incoming=21 vs live=22, a ~4.5% loss — nowhere
  // near isCatastrophicTsvShrink's 50% threshold, so tsvFetchLooksTruncated
  // reads this as a perfectly healthy fetch even though it silently dropped an
  // entire chapter (the "60 of 100 rows" shape the review described).
  for (let i = 0; i < 21; i++) {
    seedPristineRow(sqlite, { id: `p${String(i).padStart(3, "0")}`, chapter: 3, verse: i + 1, ref: `3:${i + 1}` });
  }
  seedAiOnlyRow(sqlite, { id: "bbbb", chapter: 5, verse: 1, ref: "5:1" });

  const raw = [
    TN_TSV_HEADER,
    ...Array.from({ length: 21 }, (_, i) =>
      tnTsvRow({ id: `p${String(i).padStart(3, "0")}`, ref: `3:${i + 1}`, note: "pristine note" }),
    ),
  ].join("\n");

  const truncated = await tsvFetchLooksTruncated(env, BOOK, "tn", raw);
  eq(truncated, false, "the loss-percentage heuristic does NOT flag this fetch — the exact gap the review found");

  const changed = await changedTsvChapters(env, BOOK, "tn", raw);
  eq(changed.has(5), true, "chapter 5 is still flagged changed by the diff gate (the AI-only row is absent)");

  // verifiedComplete: false — no independent completeness proof for this fetch
  // (fetchDcsMasterText unavailable/null; only the heuristic above passed).
  // coveredChapters must fall back to body-present chapters only, so chapter 5
  // (absent from the body) is never touched by the prune.
  const res = await softDeleteRemovedTsvRows(env, BOOK, "tn", raw, [...changed], false);
  eq(res.deleted, 0, "nothing is deleted — chapter 5 is not covered without a positive completeness proof");

  const row = sqlite.prepare(`SELECT deleted_at FROM tn_rows WHERE book = ? AND id = 'bbbb'`).all(BOOK)[0];
  eq(row.deleted_at, null, "the AI-only row survives — the unverified fetch's absence is not trusted as an emptied chapter");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll aiRowDiffGate assertions passed.");

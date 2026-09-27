// Issue #888: GET /api/books/:book/lint accepts `?chapter=N` (and `?flagsOnly=1`)
// so a client can pull just one chapter's issues after a save instead of
// re-reading the whole book. tn/tq/twl rows are read scoped to that chapter
// (their checks are genuinely per-row); ULT/UST verses stay whole-book because
// lintPairedPunctuation and quoteIssues are DELIBERATELY book-wide (quoted
// speech legitimately spans a chapter break — see their own comments in
// lint.ts), and only the OUTPUT is filtered by chapter afterward.
//
// This test pins two things a hand-rolled per-chapter re-implementation could
// easily get wrong:
//   1. A tn row whose `ref` is NOT "<chapter>:<verse>" (a malformed ref_raw,
//      which is exactly what one of the checks exists to catch) must still
//      appear in its own chapter's scoped response — chapter membership for
//      row-derived issues comes from the SQL WHERE clause (the row's real
//      `chapter` column), never from parsing `ref`.
//   2. A quotation opened in one chapter and closed in the next must stay
//      unflagged in the whole-book response AND in both chapter-scoped
//      responses — scoping the OUTPUT must never re-introduce the per-chapter
//      false positive #438/lintPairedPunctuation's own comment says was tried
//      and reverted.
// It also pins the literal constraint from the issue: concatenating every
// chapter's scoped issues reproduces the whole-book lint exactly.
//
// Run from api/ (needs the sqlite flag and the resolve hook, since bookImport.ts
// imports its siblings extensionless):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/bookLintChapterScope.test.mjs
//
// Driven through the REAL Hono router against the REAL migration schema, same
// harness as bookTrashSummary.test.mjs.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { books } from "./bookImport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape as bookTrashSummary.test.mjs.
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
    // The lint route's `.batch()` call is a batch of SELECTs (its whole point
    // is "one transactional read snapshot") — unlike dismissReview.test.mjs's
    // write-batch shim, this needs `.all()`'s `{results}` shape, not `.run()`'s
    // `{meta}` shape.
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.all());
      return out;
    },
  };
}

const BOOK = "ZEC";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();

  // tn01: malformed ref_raw ("abc" matches none of REFERENCE_RE's branches) —
  // the "6. Reference" issue reports `ref_raw` verbatim, so its `ref` is
  // "abc", not "1:1". Still chapter 1's row.
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_by)
       VALUES ('tn01', ?, 1, 1, 'abc', 'a note', 1, 9)`,
    )
    .run(BOOK);
  // tn02: well-formed ref, but a blank note (its own flag).
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_by)
       VALUES ('tn02', ?, 1, 2, '1:2', NULL, 1, 9)`,
    )
    .run(BOOK);
  // tq01: chapter 2, blank question.
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
       VALUES ('tq01', ?, 2, 1, '2:1', NULL, 'an answer', 1, 9)`,
    )
    .run(BOOK);
  // twl01: chapter 2, blank OrigWords.
  sqlite
    .prepare(
      `INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, tw_link, version, updated_by)
       VALUES ('twl01', ?, 2, 2, '2:2', '', 'rc://*/tw/dict/bible/kt/example', 1, 9)`,
    )
    .run(BOOK);

  const verse = (chapter, verseNum, verseObjects) =>
    sqlite
      .prepare(
        `INSERT INTO verses (book, chapter, verse, bible_version, content_json, version, updated_by)
         VALUES (?, ?, ?, 'ULT', ?, 1, 9)`,
      )
      .run(BOOK, chapter, verseNum, JSON.stringify({ verseObjects }));
  // Chapter 1, verse 1: an unclosed footnote (integrity issue, escalate).
  verse(1, 1, [{ tag: "f" }]);
  // Chapter 1, verse 3: opens a curly quote that is NOT closed until chapter 2.
  verse(1, 3, [{ type: "text", text: "He said, “Open" }]);
  // Chapter 2, verse 1: closes it. Book-wide pairing must consume it cleanly —
  // per lintPairedPunctuation's own comment, per-chapter scoping of the CHECK
  // itself (not just the output) was tried and reverted for exactly this shape.
  verse(2, 1, [{ type: "text", text: "the door.”" }]);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/books", books);

  const env = { DB: makeDb(sqlite) };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const lint = (qs = "") => app.request(`/api/books/${BOOK}/lint${qs}`, {}, env, ctx);
  return { lint };
}

function byCheck(issues, check, ref) {
  return issues.find((i) => i.check === check && i.ref === ref);
}
// Stable sort key so two issue arrays can be compared as sets regardless of
// the order each request happened to build them in.
function sortedKeys(issues) {
  return issues.map((i) => JSON.stringify(i)).sort();
}

async function run() {
  const { lint } = freshApp();

  const full = await lint().then((r) => r.json());
  eq(full.book, BOOK, "full report: book echoed");
  ok(full.chapter === undefined, "full report: no chapter field");
  ok(full.chapterRowIds === undefined, "full report: no chapterRowIds field");

  ok(!!byCheck(full.issues, "6. Reference", "abc"), "full report: malformed-ref tn issue present, keyed on raw ref_raw");
  eq(byCheck(full.issues, "6. Reference", "abc")?.rowId, "tn01", "full report: malformed-ref issue's rowId");
  ok(!!byCheck(full.issues, "Empty note", "1:2"), "full report: blank-note tn issue present");
  ok(!!byCheck(full.issues, "Empty question", "2:1"), "full report: blank-question tq issue present");
  ok(!!byCheck(full.issues, "Empty OrigWords", "2:2"), "full report: blank-OrigWords twl issue present");
  const footnote = byCheck(full.issues, "6. Footnote Syntax", "1:1");
  ok(!!footnote && footnote.bucket === "escalate", "full report: unclosed-footnote escalate issue present");

  // The cross-chapter quote must be paired cleanly: no "no opener"/"never
  // closed" issue anywhere in the whole-book report.
  ok(
    !full.issues.some((i) => i.check === "Quotation Mark" || i.check === "Paired punctuation"),
    "full report: cross-chapter quote produces no paired-punctuation issue",
  );

  // --- flagsOnly ---
  const flagsOnly = await lint("?flagsOnly=1").then((r) => r.json());
  ok(!flagsOnly.issues.some((i) => i.bucket === "escalate"), "flagsOnly=1: no escalate issues in the array");
  eq(flagsOnly.escalateCount, full.escalateCount, "flagsOnly=1: escalateCount still counts the hidden issues");
  eq(flagsOnly.flagCount, full.flagCount, "flagsOnly=1: flagCount unchanged");

  // --- chapter=1 ---
  const ch1 = await lint("?chapter=1").then((r) => r.json());
  eq(ch1.chapter, 1, "chapter=1: echoes the requested chapter");
  ok(
    ch1.issues.every((i) => i.resource !== "ult" || i.ref.startsWith("1:")),
    "chapter=1: every verse-derived issue is chapter 1's",
  );
  ok(!!byCheck(ch1.issues, "6. Reference", "abc"), "chapter=1: malformed-ref issue (ref='abc') still present — chapter came from the row, not from parsing ref");
  ok(!!byCheck(ch1.issues, "Empty note", "1:2"), "chapter=1: blank-note issue present");
  ok(!!byCheck(ch1.issues, "6. Footnote Syntax", "1:1"), "chapter=1: footnote issue present");
  ok(!byCheck(ch1.issues, "Empty question", "2:1"), "chapter=1: chapter-2 tq issue absent");
  ok(!byCheck(ch1.issues, "Empty OrigWords", "2:2"), "chapter=1: chapter-2 twl issue absent");
  ok(
    !ch1.issues.some((i) => i.check === "Quotation Mark" || i.check === "Paired punctuation"),
    "chapter=1: the still-open quote (closed in ch2) isn't flagged just because ch2 wasn't asked for",
  );
  eq(ch1.chapterRowIds, { tn: ["tn01", "tn02"], tq: [], twl: [] }, "chapter=1: chapterRowIds lists exactly chapter 1's tn/tq/twl rows");

  // --- chapter=2 ---
  const ch2 = await lint("?chapter=2").then((r) => r.json());
  eq(ch2.chapter, 2, "chapter=2: echoes the requested chapter");
  ok(!byCheck(ch2.issues, "6. Reference", "abc"), "chapter=2: chapter-1 tn issue absent");
  ok(!byCheck(ch2.issues, "Empty note", "1:2"), "chapter=2: chapter-1 tn issue absent");
  ok(!!byCheck(ch2.issues, "Empty question", "2:1"), "chapter=2: blank-question issue present");
  ok(!!byCheck(ch2.issues, "Empty OrigWords", "2:2"), "chapter=2: blank-OrigWords issue present");
  ok(
    !ch2.issues.some((i) => i.check === "Quotation Mark" || i.check === "Paired punctuation"),
    "chapter=2: the quote closed here (opened in ch1) isn't flagged as a stray closer",
  );
  eq(ch2.chapterRowIds, { tn: [], tq: ["tq01"], twl: ["twl01"] }, "chapter=2: chapterRowIds lists exactly chapter 2's tn/tq/twl rows");

  // --- the literal constraint from #888: chapter-merge equals a full-book lint ---
  eq(
    sortedKeys([...ch1.issues, ...ch2.issues]),
    sortedKeys(full.issues),
    "concatenating every chapter's scoped issues reproduces the whole-book lint exactly",
  );

  // --- invalid chapter ---
  const bad = await lint("?chapter=abc");
  eq(bad.status, 400, "non-numeric chapter is rejected");

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

run();

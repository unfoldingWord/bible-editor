// Issue #888: after a save, the client re-lints ONE chapter (GET
// /api/books/:book/lint?chapter=N) and merges it into the full-book report it
// already holds, instead of re-reading and re-linting the whole book. The one
// claim that matters: the merged report equals a fresh full-book lint.
//
// Two checks are book-wide and cannot be scoped to a chapter: the curly-quote
// counter ("Quotation Mark", quoteIssues) and the paired-punctuation stacks
// ("Paired punctuation", lintPairedPunctuation). An edit in chapter 3 can close
// a parenthesis opened in chapter 2, which removes an issue the cache files
// under chapter 2. So a chapter response carries chapter N's chapter-local
// issues PLUS every book-wide issue, and the merge replaces both. A merge that
// only replaced chapter N's issues (the static "concatenate every chapter"
// test cannot see this) leaves the stale chapter-2 issue behind; the
// before/after mutations below catch exactly that.
//
// Run from api/ (node:sqlite):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/bookLintReport.test.mjs
//
// Real migration schema, real lint, real client merge (imported from web/).

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBookLintReport, parseLintChapter } from "./bookLintReport.ts";
import { mergeChapterReport } from "../../web/src/hooks/mergeChapterReport.ts";

const BOOK = "ZEC";

// Minimal D1 shim over node:sqlite. The lint's batch is all SELECTs, so batch
// returns `.all()`'s `{ results }` shape.
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all: () => ({ results: sqlite.prepare(sql).all(...args), success: true }),
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      return stmts.map((s) => s.all());
    },
  };
}

const sqlite = new DatabaseSync(":memory:");
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(join(migrations, f), "utf8"));
}
const db = makeDb(sqlite);

const text = (t) => ({ type: "text", text: t });
const word = (t) => ({ type: "word", tag: "w", text: t });
const zaln = (content, occurrence, occurrences, children) => ({
  type: "milestone", tag: "zaln", content, occurrence, occurrences, children, endTag: "zaln-e\\*",
});
function putVerse(version, chapter, verse, verseObjects) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO verses (book, chapter, verse, bible_version, content_json, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(BOOK, chapter, verse, version, JSON.stringify({ verseObjects }));
}
function putTn(id, chapter, verse, refRaw, fields = {}) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO tn_rows (id, book, chapter, verse, ref_raw, quote, occurrence, note, support_reference, trashed_at, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
    )
    .run(id, BOOK, chapter, verse, refRaw, fields.quote ?? null, fields.note === undefined ? "a note" : fields.note,
      fields.support_reference ?? null, fields.trashed_at ?? null, fields.deleted_at ?? null);
}

// Source (UHB): one word per verse so alignment / quote checks have something to hit.
putVerse("UHB", 1, 1, [word("אַב"), text(" "), word("בַּת")]);
putVerse("UHB", 2, 1, [word("גַּם")]);
putVerse("UHB", 3, 1, [word("דָּג")]);

// ULT
putVerse("ULT", 1, 1, [zaln("אַב", 1, 2, [word("father")]), text(" and daughter.")]); // declares 2, source has 1
putVerse("ULT", 1, 2, [text("A note"), { tag: "f", type: "footnote", content: "unclosed" }]); // escalate
putVerse("ULT", 1, 3, [text("He said, “Open")]); // quote closes in chapter 2
putVerse("ULT", 2, 0, [{ type: "paragraph", tag: "p" }]);
putVerse("ULT", 2, 1, [text("the door.”")]);
putVerse("ULT", 2, 2, [text("(an aside that never closes")]); // book-wide: never closed
putVerse("ULT", 3, 1, [text("Doubled  space here.")]);
// UST
putVerse("UST", 1, 1, [text("a stray closer”")]); // book-wide: no opener earlier
putVerse("UST", 2, 1, [text("Fine text.")]);
putVerse("UST", 3, 1, [text("Fine text.")]);

putTn("tn01", 1, 1, "abc"); // malformed ref: issue.ref is "abc", still chapter 1
putTn("tn02", 1, 2, "1:2", { note: null }); // empty note
putTn("tn03", 0, 0, "front:intro", { note: "bad \\[\\[ combo" }); // chapter 0
putTn("tn04", 2, 1, "2:1", { quote: "זזז" }); // quote not in source
putTn("tn05", 3, 1, "3:1", { note: null, trashed_at: 1 }); // trashed: excluded
sqlite.prepare(`INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version) VALUES ('tq01', ?, 2, 1, '2:1', NULL, 'r', 1)`).run(BOOK);
sqlite.prepare(`INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, tw_link, version) VALUES ('tw01', ?, 2, 2, '2:2', '', 'rc://*/tw/dict/bible/kt/god', 1)`).run(BOOK);
sqlite.prepare(`INSERT INTO twl_rows (id, book, chapter, verse, ref_raw, orig_words, tw_link, review_kind, review_reason, version) VALUES ('tw02', ?, 3, 1, '3:1', 'דָּג', 'rc://*/tw/dict/bible/kt/god', 'merge_conflict', 'why', 1)`).run(BOOK);

const full = () => buildBookLintReport(db, BOOK, "UHB", null);
const chunk = (n) => buildBookLintReport(db, BOOK, "UHB", n);
const checksAt = (report, ref) => report.issues.filter((i) => i.ref === ref).map((i) => i.check).sort();

// ── Shape of a full report ──────────────────────────────────────────────────
const f0 = await full();
assert.equal(f0.chapter, null);
assert.ok(f0.issues.length > 0);
assert.ok(f0.issues.every((i) => i.bucket === "flag"), "only flag issues travel");
assert.equal(f0.flagCount, f0.issues.length);
assert.deepEqual(f0.escalateByChapter, { 1: 1 }, "the unclosed footnote is an escalate count, not an issue");
assert.equal(f0.escalateCount, 1);
assert.equal(f0.total, f0.flagCount + f0.escalateCount);
// Every issue is tagged: a chapter for chapter-local checks, null for the two book-wide ones.
for (const i of f0.issues) {
  const bookWide = i.check === "Quotation Mark" || i.check === "Paired punctuation";
  assert.equal(i.chapter === null, bookWide, `chapter tag for ${i.check} @ ${i.ref}`);
  assert.equal(typeof i.section, "number");
}
// The merge relies on this ordering: (section, chapter) never decreases.
const key = (i) => [i.section, i.chapter ?? -1];
for (let k = 1; k < f0.issues.length; k++) {
  const [as, ac] = key(f0.issues[k - 1]);
  const [bs, bc] = key(f0.issues[k]);
  assert.ok(as < bs || (as === bs && ac <= bc), `issue ${k} breaks (section, chapter) order`);
}
// Malformed ref and front:intro land in the chapter of their ROW, not their ref text.
assert.equal(f0.issues.find((i) => i.rowId === "tn01" && i.ref === "abc")?.chapter, 1);
assert.equal(f0.issues.find((i) => i.rowId === "tn03")?.chapter, 0);
assert.ok(!f0.issues.some((i) => i.rowId === "tn05"), "trashed note is excluded");
assert.ok(checksAt(f0, "2:2").includes("Paired punctuation"), "unclosed ( flagged book-wide");
assert.ok(checksAt(f0, "1:1").includes("Quotation Mark"), "stray UST closer flagged");
assert.ok(!f0.issues.some((i) => i.check === "Quotation Mark" && i.ref === "2:1"), "ULT quote spanning chapters 1-2 is fine");
assert.ok(f0.issues.some((i) => i.check === "Alignment declares the wrong occurrence count"), "fixture reaches the alignment check");
assert.ok(f0.issues.some((i) => i.rowId === "tn04" && i.chapter === 2), "fixture reaches the tn quote check");

// ── A chapter response ──────────────────────────────────────────────────────
const c2 = await chunk(2);
assert.equal(c2.chapter, 2);
assert.ok(c2.issues.every((i) => i.chapter === 2 || i.chapter === null), "chapter 2 local + book-wide only");
assert.deepEqual(
  c2.issues.filter((i) => i.chapter === null),
  f0.issues.filter((i) => i.chapter === null),
  "book-wide issues are computed over the whole book even in a chapter response",
);
assert.deepEqual(c2.escalateByChapter, {}, "chapter 2 has no escalate issues");
assert.deepEqual((await chunk(1)).escalateByChapter, { 1: 1 });

// ── Merge equivalence: unchanged book, every chapter (incl. 0 and an empty one) ──
for (const n of [0, 1, 2, 3, 4]) {
  assert.deepEqual(mergeChapterReport(f0, await chunk(n)), f0, `no-op merge of chapter ${n}`);
}

// ── Merge equivalence after edits confined to one chapter ───────────────────
async function editThenMerge(label, n, edit) {
  const before = await full();
  edit();
  const after = await full();
  const merged = mergeChapterReport(before, await chunk(n));
  assert.deepEqual(merged, after, `${label}: merge(full before, chapter ${n} after) == full after`);
  return { before, after };
}

// Chapter 3 closes chapter 2's parenthesis: an issue filed under chapter 2 disappears.
{
  const { before, after } = await editThenMerge("close ( from a later chapter", 3, () =>
    putVerse("ULT", 3, 1, [text("now it closes) here.")]));
  assert.ok(checksAt(before, "2:2").includes("Paired punctuation"));
  assert.ok(!checksAt(after, "2:2").includes("Paired punctuation"), "fixture really moved a chapter-2 issue");
}
// Chapter 1 removes the opener of the cross-chapter quote: a stray closer appears in chapter 2.
{
  const { after } = await editThenMerge("open quote removed", 1, () => {
    putVerse("ULT", 1, 3, [text("He said, Open")]);
    putVerse("ULT", 1, 2, [text("A note"), { tag: "f", type: "footnote", content: "closed", endTag: "f*" }]);
  });
  assert.ok(after.issues.some((i) => i.check === "Quotation Mark" && i.ref === "2:1"));
  assert.equal(after.escalateCount, 0, "footnote fixed: escalate count drops to 0");
}
// Row edits in chapter 2: fix a quote, fill a question, soft-delete a twl row, add a blank tn row.
await editThenMerge("tn/tq/twl edits", 2, () => {
  putTn("tn04", 2, 1, "2:1", { quote: "גַּם" });
  sqlite.prepare(`UPDATE tq_rows SET question = 'q?' WHERE id = 'tq01'`).run();
  sqlite.prepare(`UPDATE twl_rows SET deleted_at = 1 WHERE id = 'tw01'`).run();
  putTn("tn06", 2, 2, "2:2", { note: "" });
});
// Restoring a trashed note re-adds its issue.
await editThenMerge("restore a trashed note", 3, () => putTn("tn05", 3, 1, "3:1", { note: null }));
// Chapter 0 (front:intro).
await editThenMerge("front:intro fixed", 0, () => putTn("tn03", 0, 0, "front:intro", { note: "fine" }));
// A new verse-quality issue in chapter 1.
await editThenMerge("new doubled space", 1, () => putVerse("UST", 1, 1, [text("“a  stray closer”")]));

// ── Merge refuses inputs it cannot merge faithfully (caller does a full fetch) ──
const f1 = await full();
assert.equal(mergeChapterReport(await chunk(1), await chunk(1)), null, "base must be a full report");
assert.equal(mergeChapterReport(f1, f1), null, "chunk must be a chapter report");
assert.equal(mergeChapterReport(f1, { ...(await chunk(1)), book: "MAL" }), null, "books must match");
const { escalateByChapter: _drop, ...legacy } = f1;
assert.equal(mergeChapterReport(legacy, await chunk(1)), null, "a pre-#888 report has no escalateByChapter");

// ── parseLintChapter ────────────────────────────────────────────────────────
assert.equal(parseLintChapter(undefined), null);
assert.equal(parseLintChapter("0"), 0);
assert.equal(parseLintChapter("12"), 12);
for (const bad of ["", "abc", "-1", "1.5", "1e2", "999", " 3"]) {
  assert.equal(parseLintChapter(bad), undefined, `rejects ${JSON.stringify(bad)}`);
}

console.log("bookLintReport: chapter-scoped lint + client merge equal a full-book lint");

// #888 review: which request a lint refresh makes. A chapter request is only
// safe while the cached report is recent, because it refreshes nothing outside
// the saved chapter; changes elsewhere (other users, AI auto-apply, the nightly
// sync) only arrive with a whole-book fetch. A tab that stays focused never
// fires the focus refresh, so the age check has to live here too.
import assert from "node:assert/strict";
import { lintChapterForSavedOp, lintRefreshScope, WHOLE_BOOK_LINT_MAX_AGE_MS } from "./lintRefreshScope.ts";

const now = 1_000_000_000;
const fresh = now - 5_000;
const one = (ch) => ({ whole: false, chapters: new Set([ch]) });

assert.equal(WHOLE_BOOK_LINT_MAX_AGE_MS, 60_000);

// One chapter, a report to merge into, a recent whole-book fetch: chapter only.
assert.equal(lintRefreshScope(one(40), true, fresh, now), 40);
assert.equal(lintRefreshScope(one(0), true, fresh, now), 0, "chapter 0 (front:intro) is a real chapter");

// Whole book in every other case.
assert.equal(lintRefreshScope(one(40), true, now - 60_000, now), undefined, "stale at exactly the limit");
assert.equal(lintRefreshScope(one(40), true, now - 600_000, now), undefined, "long-focused tab, many saves");
assert.equal(lintRefreshScope(one(40), true, 0, now), undefined, "no whole-book fetch has landed (or the last failed)");
assert.equal(lintRefreshScope(one(40), false, fresh, now), undefined, "nothing to merge into");
assert.equal(lintRefreshScope({ whole: true, chapters: new Set([40]) }, true, fresh, now), undefined, "a whole-book refresh is pending too");
assert.equal(lintRefreshScope({ whole: false, chapters: new Set([3, 4]) }, true, fresh, now), undefined, "two chapters");
assert.equal(lintRefreshScope({ whole: false, chapters: new Set() }, true, fresh, now), undefined, "book load / unscoped refresh");

// #1135: which chapter a successful outbox op re-lints. null = no refresh,
// undefined = the whole book. Every row kind counts (tq/twl rows carry lint
// issues too, #887), not just tn.
const row = (rowKind) => ({ kind: "row", rowKind, id: "x1", book: "ZEC" });
for (const k of ["tn", "tq", "twl"]) {
  assert.equal(lintChapterForSavedOp(row(k), { id: "x1", chapter: 4 }, "ZEC"), 4, `${k} save re-lints the saved row's chapter`);
  assert.equal(lintChapterForSavedOp(row(k), { id: "x1", chapter: 0 }, "ZEC"), 0, `${k} save in chapter 0`);
  // A DELETE answers { ok: true }: the chapter comes from the row as it was
  // when the user deleted it, else the whole book.
  assert.equal(lintChapterForSavedOp(row(k), { ok: true }, "ZEC", 7), 7, `${k} delete uses the known chapter`);
  assert.equal(lintChapterForSavedOp(row(k), { ok: true }, "ZEC"), undefined, `${k} delete with no known chapter: whole book`);
  assert.equal(lintChapterForSavedOp(row(k), null, "ZEC"), undefined, `${k} empty response: whole book`);
  assert.equal(lintChapterForSavedOp({ ...row(k), book: "MAL" }, { chapter: 4 }, "ZEC"), null, "another book: no refresh");
}
assert.equal(lintChapterForSavedOp({ kind: "verse", book: "ZEC", chapter: 3, verse: 1, bibleVersion: "ULT" }, {}, "ZEC"), 3);
assert.equal(lintChapterForSavedOp({ kind: "verse", book: "MAL", chapter: 3, verse: 1, bibleVersion: "ULT" }, {}, "ZEC"), null);
assert.equal(lintChapterForSavedOp({ kind: "verse_status", book: "ZEC", chapter: 3, verse: 1 }, {}, "ZEC"), null, "a done tick is not linted");
assert.equal(lintChapterForSavedOp({ kind: "lane_check", book: "ZEC", chapter: 3, verse: 1, lane: "ult" }, {}, "ZEC"), null);

console.log("lintRefreshScope: all assertions passed");

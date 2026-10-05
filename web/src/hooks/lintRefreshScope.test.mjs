// #888 review: which request a lint refresh makes. A chapter request is only
// safe while the cached report is recent, because it refreshes nothing outside
// the saved chapter; changes elsewhere (other users, AI auto-apply, the nightly
// sync) only arrive with a whole-book fetch. A tab that stays focused never
// fires the focus refresh, so the age check has to live here too.
import assert from "node:assert/strict";
import { lintRefreshScope, WHOLE_BOOK_LINT_MAX_AGE_MS } from "./lintRefreshScope.ts";

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

console.log("lintRefreshScope: all assertions passed");

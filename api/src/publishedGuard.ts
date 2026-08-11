// Published-books policy for the book-lock feature. Pure module — no D1, no
// fetch, no `cloudflare:` imports — so it can run under
// `node --experimental-strip-types` in the unit test runner, same as
// shrinkGuard.ts.
//
// Measured evidence (2026-06-23, checked directly against DCS):
//   - The latest release in all five resource repos (en_ult, en_ust, en_tn,
//     en_tq, en_twl) is tag `v89`, target branch `release_v89`, published
//     2026-06-23.
//   - Listing repo contents at `?ref=v89` returns exactly 54 books, and that
//     54-book set is IDENTICAL across all five repos. `master` has 66 books.
//   - The 12 books NOT yet published: NUM 1CH 2CH ECC ISA JER EZK DAN HOS AMO
//     MIC ZEC. These are exactly the books under active work in this app.
//   - Releases happen ~3x/year (v84 shipped 2024-08, v89 shipped 2026-06).
//
// Why PUBLISHED_BOOKS is a hardcoded constant and not a live lookup: a failed
// live lookup at request time cannot know WHICH books are published, so it
// would have to either halt every export (blocking the 12 books that are the
// only ones under active translation work) or silently unblock all 54 — both
// wrong. Instead this module ships a reviewed snapshot, and a separate
// nightly, non-blocking drift detector (describePublishedDrift, below) raises
// an alert when DCS's live listing disagrees with the snapshot, turning a new
// release into a reviewed human event rather than a silent behavior change.
//
// Hazard 1 (why pickLatestStableRelease exists): en_ult carries a `v83.1`
// release with `prerelease: true` and `target_commitish: "master"`. If that
// class of release were ever picked as "latest", all 66 books on master would
// look published.
//
// Hazard 2 (why publishedBooksFromEntries tests known filenames rather than
// parsing unknown ones): en_ult at v89 contains `A0-FRT.usfm`. Parsing book
// codes out of arbitrary filenames would invent a phantom book "FRT".
//
// Runbook: when vNN ships, bump PUBLISHED_RELEASE_TAG and PUBLISHED_BOOKS in
// this file, then run `npm --workspace api run test`.

import { RESOURCE_TARGETS, type Resource } from "./export.ts";

export const PUBLISHED_RELEASE_TAG = "v89";

export const PUBLISHED_BOOKS: ReadonlySet<string> = new Set([
  "GEN", "EXO", "LEV", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI",
  "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "SNG", "LAM", "JOL", "OBA", "JON",
  "NAM", "HAB", "ZEP", "HAG", "MAL",
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP",
  "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE",
  "1JN", "2JN", "3JN", "JUD", "REV",
]);

export function isPublishedBook(book: string): boolean {
  return PUBLISHED_BOOKS.has(book.toUpperCase());
}

export interface DcsRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  target_commitish?: string;
  published_at?: string | null;
  created_at?: string | null;
}

// Picks the release that actually represents "what's published." NEVER sort
// by tag name — string comparison puts "v9" after "v10" ("v9" > "v10"
// lexicographically), which would silently misorder any release series past
// v9. Sort by parsed date instead, falling back to created_at when
// published_at is absent, and treating an unparseable/missing date as 0 (oldest)
// rather than throwing.
export function pickLatestStableRelease(releases: DcsRelease[]): DcsRelease | null {
  const stable = releases.filter(
    (r) =>
      r.draft !== true &&
      r.prerelease !== true &&
      r.target_commitish !== "master" &&
      typeof r.tag_name === "string" &&
      r.tag_name.length > 0,
  );
  if (stable.length === 0) return null;
  const dateOf = (r: DcsRelease): number => {
    const parsed = Date.parse(r.published_at ?? r.created_at ?? "");
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return stable.slice().sort((a, b) => dateOf(b) - dateOf(a))[0];
}

// pickLatestStableRelease's unconditional `target_commitish !== "master"`
// rejection exists for the v83.1 hazard (a PRERELEASE targeting master) — but
// v83.1 is already excluded by the prerelease filter, so the master rejection
// alone protects against nothing that isn't already caught. Its real cost:
// if DCS ever cuts a genuinely STABLE release against master, it becomes
// invisible to pickLatestStableRelease, the gate silently keeps trusting the
// stale PUBLISHED_BOOKS constant, and nobody is told a review is due. This
// function finds exactly that case — draft/prerelease excluded, master
// included — so checkPublishedDrift (exportWorkflow.ts) can raise an alert
// instead of the drift detector staying silent. It does NOT feed the gate:
// PUBLISHED_BOOKS / isPublishedBook still only reads the hardcoded constant.
export function masterTargetedStableRelease(releases: DcsRelease[]): DcsRelease | null {
  const candidates = releases.filter(
    (r) =>
      r.draft !== true &&
      r.prerelease !== true &&
      r.target_commitish === "master" &&
      typeof r.tag_name === "string" &&
      r.tag_name.length > 0,
  );
  if (candidates.length === 0) return null;
  const dateOf = (r: DcsRelease): number => {
    const parsed = Date.parse(r.published_at ?? r.created_at ?? "");
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return candidates.slice().sort((a, b) => dateOf(b) - dateOf(a))[0];
}

// Builds the published-books set for one resource from a raw directory
// listing. Testing for a KNOWN filename (via RESOURCE_TARGETS[resource].path)
// rather than parsing an unknown one is what makes `A0-FRT.usfm`, `README.md`,
// and dotfiles harmless — they simply never match any candidate book's
// expected path.
export function publishedBooksFromEntries(
  entryNames: string[],
  candidateBooks: readonly string[],
  resource: Resource,
): Set<string> {
  const entries = new Set(entryNames);
  const target = RESOURCE_TARGETS[resource];
  const result = new Set<string>();
  for (const book of candidateBooks) {
    if (entries.has(target.path(book))) result.add(book);
  }
  return result;
}

export const PUBLISHED_SET_MIN_BOOKS = 40;

// A derived published-books set smaller than this means "we could not read
// the listing" (truncated response, wrong ref, repo outage), not "few books
// are published." A truncated response must never be mistaken for evidence —
// same principle as shrinkGuard's truncated-fetch policy.
export function releaseSetUsable(books: ReadonlySet<string> | Set<string>): boolean {
  return books.size >= PUBLISHED_SET_MIN_BOOKS;
}

export function describePublishedDrift(
  baseline: ReadonlySet<string>,
  live: ReadonlySet<string>,
): { newlyPublished: string[]; noLongerPublished: string[]; message: string } | null {
  const newlyPublished = [...live].filter((b) => !baseline.has(b)).sort();
  const noLongerPublished = [...baseline].filter((b) => !live.has(b)).sort();
  if (newlyPublished.length === 0 && noLongerPublished.length === 0) return null;
  const message =
    `Published-books drift detected against ${PUBLISHED_RELEASE_TAG}: ` +
    `newly published [${newlyPublished.join(", ")}], ` +
    `no longer published [${noLongerPublished.join(", ")}]. ` +
    `Update PUBLISHED_BOOKS / PUBLISHED_RELEASE_TAG in api/src/publishedGuard.ts.`;
  return { newlyPublished, noLongerPublished, message };
}

// Whether an `allowLocked` request may override the book-lock guard. EXACT
// structural mirror of shrinkOverrideAllowed in api/src/shrinkGuard.ts — read
// that comment too. Both resolved counts (never the raw params) must be
// exactly 1: an unrecognized resource string widens to ALL_RESOURCES
// elsewhere in this codebase (see exportWorkflow's `isResource(params.resource)
// ? [it] : ALL_RESOURCES`), so checking params.resource for mere truthiness
// would hand the override to all five resources on a typo like "tqq". Gating
// on the resolved counts makes that widening fail safe: more than one
// resource (or book) selected → no override.
export function lockOverrideAllowed(
  params: { allowLocked?: boolean; book?: string; resource?: string },
  resolvedBookCount: number,
  resolvedResourceCount: number,
): boolean {
  if (params.allowLocked !== true) return false;
  if (!params.book || !params.resource) return false;
  return resolvedBookCount === 1 && resolvedResourceCount === 1;
}

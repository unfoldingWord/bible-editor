// Alignment-safe repair for the "number-split" defect — GitHub issue #452.
//
// ── WHAT IS BROKEN ─────────────────────────────────────────────────────────
//   Verses read `1, 000` / `22, 600` instead of `1,000` / `22,600`: a stray
//   space sits inside the thousands separator. In the stored verse tree the
//   broken number straddles two aligned word tokens, with the separator in a
//   plain text node between them:
//
//     \zaln-s |x-content="עֶשְׂרִ֥ים"\*\zaln-s |x-content="וְ⁠אַרְבָּעָ֖ה"\*\zaln-s |x-content="אָֽלֶף"\*
//        {tag:"w",  text:"24"}      ← left digits, an aligned word
//        {type:"text", text:", "}   ← THE DEFECT: this should be ","
//        {tag:"w",  text:"000"}     ← right digits, an aligned word
//
//   A naive string replace re-tokenizes the tree and destroys the
//   `\zaln-s`/`\zaln-e` milestones around those words — the exact failure mode
//   web/src/lib/replace.ts exists to prevent.
//
// ── WHAT THIS SCRIPT DOES ──────────────────────────────────────────────────
//   It deletes exactly one character — the space — from the text node that
//   owns it, and touches nothing else. No node is created, removed, split,
//   merged or reordered; no `\w` surface form changes; no `\zaln` milestone is
//   touched.
//
//   It reads a JSON dump of the affected `verses` rows (produced by a SELECT-
//   only `wrangler d1 execute --json`), transforms each verse, verifies the
//   result, and writes SQL. IT NEVER TOUCHES ANY DATABASE — generating and
//   verifying the repair is the whole job; applying is a separate, human step.
//
//   The transform and every guard live in scripts/lib/numberSplit.mjs and are
//   covered by scripts/lib/numberSplit.test.mjs (`npm run test:scripts`).
//   This file owns arguments, dump loading, policy guards, SQL and reporting.
//
// ── HOW THE REPAIR SURVIVES THE NIGHTLY SYNC (read before changing the SQL) ─
//   Every night the DCS→D1 sync pulls master and reconciles it into D1. Master
//   still holds the BROKEN bytes until our next export pushes the fix, so the
//   repair only sticks if the row is in the protected class. Two things put it
//   there, and BOTH are load-bearing:
//
//   1. `updated_by` is SET (not left NULL). The sync's pristine path is an
//      unconditional overwrite from master:
//        api/src/bookReimport.ts:2225-2231
//          UPDATE verses SET content_json = ?1, … WHERE … AND updated_by IS NULL
//      No merge, no ancestor check — a NULL-owner row is simply replaced. And
//      api/src/reimportClassify.ts:102-111 isReimportableRow:
//          if (r.updated_by == null) return true;          // pristine → overwritable
//          return r.latestSource === AI_SOURCE;            // AI-only → overwritable
//      So a non-NULL `updated_by` whose latest source is not 'ai_pipeline' is
//      NOT reimportable, and the blind overwrite cannot match the row. It goes
//      through the three-way verse merge instead, which is the correct place
//      for "D1 and master disagree" to be adjudicated.
//
//   2. The audit row uses `action = 'update'`, NOT a custom action. The
//      provenance sub-select that feeds `latestSource` filters on the action:
//        api/src/bookReimport.ts:1943 / 1963 / 2722
//          … WHERE kind='verse' AND row_key=… AND action IN ('create','update')
//            ORDER BY id DESC LIMIT 1
//      A custom action such as 'repair_number_split' is INVISIBLE to it, so
//      the query would skip our row and pick up an OLDER one — and if that
//      older row happened to carry source='ai_pipeline', the verse would
//      classify AI-only and be overwritten from master despite `updated_by`
//      being set. The repair is identified by `source='data_repair'` (which is
//      not 'ai_pipeline', so it reads as human-owned) plus the payload's own
//      `incident` field, never by a custom action.
//
//   3. For the same reason the payload MUST carry `content` and `plain_text`.
//      Because our row is now an `action='update'` row, the merge's ancestor
//      recovery can select it as the base, and it reads the ancestor through
//      api/src/verseHistory.ts verseContentJsonFromPayload, which looks only at
//      `payload.content`. A payload without it yields a null ancestor and the
//      merge degrades to "keep_no_base". It is also what makes the entry render
//      and restore in the verse-history dialog.
//
//   4. GATE 2 — clearing the overwrite path is necessary, not sufficient. A
//      non-pristine row goes to the three-way merge instead
//      (api/src/verseMerge.ts:284-349). With `ours` = the repaired content:
//        • master unchanged since the watermark → `keep_master_unchanged` →
//          the repair SURVIVES. This is the normal case and the one we expect.
//        • master ALSO changed out-of-band → `adopt_conflict` → MASTER WINS and
//          the repair is reverted. No row shape can prevent that; it is the same
//          risk any translator edit carries.
//        • no `master_confirmed_at` watermark for the book+resource → the merge
//          is inert entirely (bookReimport.ts:2116-2118) and `updated_by` alone
//          fully protects the row.
//      So: apply, then EXPORT PROMPTLY. The exposure window is the time master
//      holds the broken bytes while D1 holds the fix.
//
//   WHO `updated_by` / `user_id` NAMES. There is no system or bot account —
//   `users` rows are minted only by OAuth sign-in, and no migration seeds one.
//   `2` is `deferredreward`, the maintainer who authorises and applies this
//   repair; that was confirmed by a read-only query against prod, not inherited
//   from a comment. This matters because `edit_log.user_id` IS joined to
//   `users` and rendered in the verse-history dialog (api/src/verses.ts:182-195
//   → web/src/components/VerseHistoryDialog.tsx), so the id is a public
//   attribution, not an opaque tag. Attributing the repair to the person who
//   ran it is correct. Do NOT copy the `= 2` from
//   scripts/heal-align-1ch-num.mjs on the strength of its "known-good user"
//   comment — that claim cites a STATE.md passage that does not exist, and
//   scripts/build-load-sql.mjs then cites the claim, making the chain circular.
//
//   PRECEDENT. scripts/reform-amo-ust.mjs is the one prior verse repair that
//   gets this shape right (`updated_by=2`, `action='update'`, a non-null
//   custom `source`), and it is the model followed here.
//
//   NOTE the contrast with scripts/restore-master-verses.mjs, which leaves
//   `updated_by` alone. That is defensible THERE: it writes master's own
//   content back into D1, so a later sync overwriting it from master is a
//   no-op. This script writes content master does NOT have, so the same choice
//   would silently revert the repair. (Its header's claim to leave
//   `updated_by` NULL "deliberately" is also inaccurate — the column is simply
//   absent from its SET list, and every row it has ever touched already had an
//   owner.)
//
// ── WHY NOT smartEditVerse (the real edit engine) ──────────────────────────
//   Routing the join through web/src/lib/replace.ts smartEditVerse was tried
//   first and REJECTED on measurement, not preference. Joining `24, 000` into
//   `24,000` merges two `\w` tokens into one, so the engine's word-count-
//   matching "preserve" tier cannot fire and it falls to the localized-rewrite
//   tier, which splits the enclosing milestones into before/after halves.
//   Measured on the real prod rows:
//
//     1CH 7:4    zaln 14 → 17   (+3 spans, milestone chain split)
//     1CH 7:9    zaln 10 → 13   (+3)
//     1CH 7:11   zaln 15 → 19   (+4)
//     1CH 7:40   zaln 20 → 23   (+3)  AND the trailing `\ts\*` was REORDERED
//                                     ("26,000 \ts\* men." for "26, 000 men. \ts\*")
//
//   `preservedAlignment` came back false on every verse. Extra spans are not
//   free: one Hebrew source word covered by N milestone chains is the
//   doubled-alignment-card defect this repo has repaired twice before.
//
//   The target shape is not a guess either. 1CH 7:5 was fixed by hand in the
//   app by a translator (user 47, 2026-08-15) before this script existed, and
//   her result is exactly what a node-local space deletion produces:
//     {tag:"w",text:"87"} {type:"text",text:","} {tag:"w",text:"000"}
//   with the three-deep zaln chain around it untouched.
//
//   Punctuation living OUTSIDE `\w` (`\w 24\w*,\w 000\w*`) is the correct
//   unfoldingWord form, not churn — see normalizeWordPunctuation in
//   api/src/importParsers.ts.
//
// ── THE ONE ERROR NO ASSERTION CAN CATCH ───────────────────────────────────
//   The defect pattern (digit + comma-space + three digits) is a HEURISTIC. It
//   also matches a legitimate enumeration — "of ages 5, 300, and 900 years" —
//   and such a match is structurally PERFECT to repair: every count check
//   passes, the signature is unchanged, the independent verifier agrees. Only
//   reading the sentence can tell the difference. That is why this script
//   prints the surrounding text of every site, and why `--exclude` exists.
//
// ── USAGE ──────────────────────────────────────────────────────────────────
//   1. Dump the affected rows (SELECT ONLY — never --file against --remote):
//
//        cd api
//        npx wrangler d1 execute bible_editor --remote --env production --json \
//          --command "SELECT book, chapter, verse, verse_end, bible_version, version, \
//                     content_json, plain_text, updated_at, updated_by FROM verses \
//                     WHERE book='1CH' AND bible_version='ULT' \
//                       AND plain_text GLOB '*[0-9], [0-9][0-9][0-9]*' \
//                     ORDER BY chapter, verse;" > ../scripts/out/number-split-dump.json
//
//   2. Build + verify the repair (writes SQL, touches nothing):
//
//        node scripts/repair-number-split-verses.mjs scripts/out/number-split-dump.json
//
//      Options:
//        --book 1CH            only these books (comma-separated)
//        --bible-version ULT   only these resources (comma-separated)
//        --exclude <key>       drop a verse or one site from the repair. The key
//                              is BOOK/CH/V/VERSION (printed in the report), with
//                              an optional #N for a single 1-based site:
//                                --exclude 1CH/27/1/ULT
//                                --exclude 1CH/21/5/ULT#2
//                              Use this for a false positive instead of hand-
//                              editing the SQL.
//        --allow-locked        include books frozen by PUBLISHED_BOOKS (they are
//                              refused by default — see the lock guard below)
//        --out <path>          SQL output (default scripts/out/repair-number-split.sql)
//        --json <path>         full per-verse verification report
//        --force               overwrite an existing --out file
//
//   3. Read the context lines. Then apply — A SEPARATE, HUMAN-APPROVED STEP.
//      The generated file's own header carries the apply command and the
//      post-apply checks.
//
// ── THE RELEASE-LOCK GUARD ─────────────────────────────────────────────────
//   A direct D1 UPDATE bypasses the route-layer lock entirely: the published-
//   book freeze is enforced on the API write path, not by the database. So
//   this script reads PUBLISHED_BOOKS straight out of api/src/publishedGuard.ts
//   (parsed at run time so it cannot drift from a hardcoded copy) and REFUSES
//   any verse in a frozen book unless --allow-locked is passed.
//
//   The asymmetry that makes this worth refusing rather than warning: the
//   nightly EXPORT skips a locked book hard (exportWorkflow.ts:493-511,
//   "book_locked:published:v90"), but the nightly DCS→D1 SYNC does NOT —
//   bookReimport.ts never consults the lock. So repairing a frozen book gets
//   the worst of both: the fix never reaches Door43, and the row is still
//   exposed to the sync. It would also leave D1 diverged from a published
//   release.
//
// Idempotent: re-running against a fresh dump of already-repaired rows finds
// no defect sites and emits no SQL.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { repairVerse, extractJsonRows } from "./lib/numberSplit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");

// `updated_by` written by the repair. See "HOW THE REPAIR SURVIVES THE NIGHTLY
// SYNC" above — a non-NULL owner is what keeps the row out of the sync's blind
// overwrite path. 2 = deferredreward.
const REPAIR_USER_ID = 2;
// Must stay 'update': the provenance sub-select filters action IN
// ('create','update') and a custom action would be invisible to it.
const REPAIR_ACTION = "update";
const REPAIR_SOURCE = "data_repair";
const INCIDENT = "number-split-thousands-separator";

// ── args ───────────────────────────────────────────────────────────────────

const USAGE =
  "usage: node scripts/repair-number-split-verses.mjs <dump.json>\n" +
  "         [--book 1CH[,NUM]] [--bible-version ULT[,UST]]\n" +
  "         [--exclude BOOK/CH/V/VER[#site]] (repeatable)  [--allow-locked]\n" +
  "         [--out <sql>] [--json <report>] [--force]\n" +
  "  exit 0 = every defect repaired and verified · 2 = at least one verse REFUSED\n" +
  "  exit 1 = bad arguments or an unusable dump";
const die = (msg) => {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--out", "--json", "--book", "--bible-version", "--exclude"]);
const BOOL_FLAGS = new Set(["--force", "--allow-locked"]);
const REPEATABLE = new Set(["--exclude"]);
const flags = new Map();
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) {
    positionals.push(a);
    continue;
  }
  const eq = a.indexOf("=");
  const name = eq >= 0 ? a.slice(0, eq) : a;
  if (BOOL_FLAGS.has(name)) {
    if (eq >= 0) die(`${name} takes no value`);
    flags.set(name, true);
    continue;
  }
  if (!VALUE_FLAGS.has(name)) die(`unknown flag: ${a}`);
  const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
  if (value === undefined || value.startsWith("--")) die(`${name} needs a value`);
  if (REPEATABLE.has(name)) flags.set(name, [...(flags.get(name) ?? []), value]);
  else if (flags.has(name)) die(`${name} given more than once`);
  else flags.set(name, value);
}
if (positionals.length === 0) die("missing the <dump.json> argument");
if (positionals.length > 1) die(`unexpected extra argument: ${positionals[1]}`);

const argVal = (flag) => (flags.has(flag) ? flags.get(flag) : null);
const listArg = (flag) => {
  const raw = argVal(flag);
  if (raw == null) return null;
  const set = new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (!set.size) die(`${flag} parsed to an empty list`);
  return set;
};

const dumpPath = resolve(process.cwd(), positionals[0]);
const bookFilter = listArg("--book");
const versionFilter = listArg("--bible-version");
const allowLocked = flags.get("--allow-locked") === true;
const force = flags.get("--force") === true;
const outDir = resolve(repoRoot, "scripts", "out");
const sqlPath = argVal("--out") ? resolve(process.cwd(), argVal("--out")) : resolve(outDir, "repair-number-split.sql");
const jsonPath = argVal("--json") ? resolve(process.cwd(), argVal("--json")) : null;

// --exclude BOOK/CH/V/VER  or  BOOK/CH/V/VER#site (1-based)
const excludeVerses = new Set();
const excludeSites = new Map(); // rowKey -> Set(siteIndex)
for (const raw of flags.get("--exclude") ?? []) {
  const m = /^([^/\s]+)\/(\d+)\/(\d+)\/([^#\s]+)(?:#(\d+))?$/.exec(raw.trim());
  if (!m) die(`--exclude: '${raw}' is not BOOK/CH/V/VERSION[#site]`);
  const key = `${m[1].toUpperCase()}/${Number(m[2])}/${Number(m[3])}/${m[4].toUpperCase()}`;
  if (m[5] == null) excludeVerses.add(key);
  else {
    const n = Number(m[5]);
    if (n < 1) die(`--exclude: site index in '${raw}' is 1-based`);
    if (!excludeSites.has(key)) excludeSites.set(key, new Set());
    excludeSites.get(key).add(n);
  }
}

// ── release-lock list, parsed from the real source of truth ────────────────

function loadPublishedBooks() {
  const p = resolve(apiDir, "src", "publishedGuard.ts");
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    die(`cannot read ${p} to learn which books are release-locked: ${e.message}`);
  }
  const m = /export const PUBLISHED_BOOKS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(text);
  if (!m) {
    die(
      `could not parse PUBLISHED_BOOKS out of ${p}. Refusing to run rather than treat every book as` +
        ` unlocked — a direct D1 write bypasses the route-layer lock, so guessing here is unsafe.`,
    );
  }
  const books = new Set([...m[1].matchAll(/"([A-Z0-9]{3})"/g)].map((x) => x[1]));
  if (books.size < 10) die(`parsed only ${books.size} book(s) from PUBLISHED_BOOKS — refusing (parser drift?)`);
  return books;
}
const PUBLISHED_BOOKS = loadPublishedBooks();

// ── dump loading ───────────────────────────────────────────────────────────

// A dump missing a column would otherwise produce `WHERE book = NULL`, which is
// never true in SQL: the UPDATE would silently match nothing while the console
// cheerfully reported the verse as repaired.
function rowIdentityProblem(row) {
  for (const col of ["book", "bible_version"]) {
    if (typeof row[col] !== "string" || row[col].trim() === "") {
      return `${col} is missing or not a non-empty string (got ${JSON.stringify(row[col])})`;
    }
  }
  for (const col of ["chapter", "verse", "version"]) {
    const n = Number(row[col]);
    if (row[col] == null || !Number.isInteger(n)) {
      return `${col} is missing or not an integer (got ${JSON.stringify(row[col])})`;
    }
  }
  return null;
}

let allRows;
try {
  allRows = extractJsonRows(readFileSync(dumpPath, "utf8"), dumpPath);
} catch (e) {
  die(e.message);
}

// The SQL is version-pinned to the dump, so a stale dump silently skips rows
// that moved on. Warn loudly rather than let a days-old dump look healthy.
const DUMP_STALE_HOURS = 6;
const dumpAgeHours = (Date.now() - statSync(dumpPath).mtimeMs) / 3_600_000;

const rows = allRows.filter(
  (r) =>
    (!bookFilter || bookFilter.has(String(r.book).toUpperCase())) &&
    (!versionFilter || versionFilter.has(String(r.bible_version).toUpperCase())),
);
if (!rows.length) die(`no rows to process from ${dumpPath} (after --book/--bible-version filters)`);

if (existsSync(sqlPath) && !force) {
  die(
    `${sqlPath} already exists. Refusing to overwrite it — an operator holding a verified file` +
      ` should not have it silently replaced by a different run. Pass --force to overwrite.`,
  );
}

// ── per-verse repair ───────────────────────────────────────────────────────

const repaired = [];
const refused = [];
const clean = [];
const plainTextOnly = [];
const plainTextDrift = [];
const lockedSkipped = [];
const excludedVerses = [];
const excludedSiteNotes = [];

for (const row of rows) {
  const ref = `${row.book} ${row.bible_version} ${row.chapter}:${row.verse}`;
  const rowKey = `${row.book}/${row.chapter}/${row.verse}/${row.bible_version}`;
  const refuse = (why) => refused.push({ ref, rowKey, row, why });

  const identityProblem = rowIdentityProblem(row);
  if (identityProblem) {
    refuse(`row identity unusable — ${identityProblem}`);
    continue;
  }
  if (row.content_json == null) {
    refuse("content_json is NULL");
    continue;
  }
  if (excludeVerses.has(rowKey)) {
    excludedVerses.push(rowKey);
    continue;
  }
  if (PUBLISHED_BOOKS.has(String(row.book).toUpperCase()) && !allowLocked) {
    lockedSkipped.push({ ref, rowKey });
    continue;
  }

  const r = repairVerse(row.content_json, row.plain_text ?? null);

  if (r.status === "clean") { clean.push(ref); continue; }
  if (r.status === "plain_text_only") { plainTextOnly.push({ ref, rowKey, newPlain: r.newPlain }); continue; }
  if (r.status === "refused") { refuse(r.why); continue; }

  // --exclude BOOK/CH/V/VER#N drops individual sites. The whole verse is then
  // refused rather than half-repaired: this transform is a fixed-point loop
  // over the tree, so it cannot selectively skip one site and still verify the
  // rest character-for-character. Refusing is the honest outcome — the verse
  // needs a hand.
  const dropped = excludeSites.get(rowKey);
  if (dropped) {
    const listed = [...dropped].sort((a, b) => a - b);
    excludedSiteNotes.push({ rowKey, sites: listed, total: r.sites.length });
    refuse(
      `site(s) ${listed.join(", ")} excluded by --exclude; a partial repair cannot be verified,` +
        ` so the whole verse is left for a manual fix`,
    );
    continue;
  }

  if (r.plainTextDrift) plainTextDrift.push(ref);
  repaired.push({
    ref, rowKey, row,
    sites: r.sites,
    newContentJson: r.newContentJson,
    newPlain: r.newPlain,
    zaln: r.stats.zaln,
    words: r.stats.words,
    nodes: r.stats.nodes,
  });
}

// ── SQL ────────────────────────────────────────────────────────────────────

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const nowTs = Math.floor(Date.now() / 1000);
const sqlApplyPath = relative(apiDir, sqlPath).split("\\").join("/");

function statementsFor(r) {
  const { row } = r;
  const v = Number(row.version);
  const match =
    `book = ${sqlStr(row.book)} AND chapter = ${Number(row.chapter)}` +
    ` AND verse = ${Number(row.verse)} AND bible_version = ${sqlStr(row.bible_version)}`;
  // `content` and `plain_text` are REQUIRED, not decorative — see the header:
  // this is an action='update' row, so the verse merge's ancestor recovery can
  // select it and reads the ancestor through verseContentJsonFromPayload,
  // which looks only at payload.content. It is also what makes the entry
  // render and restore in the verse-history dialog.
  const payload = JSON.stringify({
    content: r.newContentJson,
    plain_text: r.newPlain,
    incident: INCIDENT,
    issue: 452,
    sites: r.sites.map((s) => s.joined),
    from_plain_text: row.plain_text ?? null,
  });
  // updated_by is SET so the row leaves the sync's blind-overwrite class.
  const update =
    `UPDATE verses SET content_json = ${sqlStr(r.newContentJson)}, plain_text = ${sqlStr(r.newPlain)},` +
    ` version = version + 1, updated_at = ${nowTs}, updated_by = ${REPAIR_USER_ID}` +
    ` WHERE ${match} AND version = ${v};`;
  // Guarded audit row. Three conditions, all necessary:
  //   1. the row is now at version+1 AND holds exactly the content we wrote —
  //      so a no-op UPDATE (the row moved on) leaves no orphan audit row, and a
  //      concurrent edit that happens to land on version+1 does not match;
  //   2. no audit row for this repair exists yet — so re-running the file after
  //      a partial apply (the natural recovery) cannot double-log. Without it
  //      condition 1 stays TRUE forever after a successful apply and every
  //      re-run appends another row.
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'verse',${sqlStr(r.rowKey)},${sqlStr(row.book)},${REPAIR_USER_ID},${v},${v + 1},${sqlStr(REPAIR_ACTION)},` +
    `${sqlStr(payload)},${sqlStr(REPAIR_SOURCE)},${nowTs}` +
    ` FROM verses WHERE ${match} AND version = ${v + 1} AND content_json = ${sqlStr(r.newContentJson)}` +
    ` AND NOT EXISTS (SELECT 1 FROM edit_log WHERE kind = 'verse' AND row_key = ${sqlStr(r.rowKey)}` +
    ` AND source = ${sqlStr(REPAIR_SOURCE)} AND new_version = ${v + 1}` +
    ` AND payload_json LIKE '%${INCIDENT}%');`;
  return [update, log];
}

// Rows that will STILL match the dump's GLOB after a successful apply, because
// this file deliberately does not repair them. Emitting "expect 0 survivors"
// while these exist would train the operator to ignore a real failure.
const expectedSurvivors = [
  ...refused.map((f) => ({ rowKey: f.rowKey, why: "REFUSED" })),
  ...plainTextOnly.map((d) => ({ rowKey: d.rowKey, why: "plain_text-only" })),
  ...lockedSkipped.map((d) => ({ rowKey: d.rowKey, why: "release-locked" })),
  ...excludedVerses.map((k) => ({ rowKey: k, why: "--exclude" })),
];

const books = [...new Set(repaired.map((r) => r.row.book))].sort();
const versions = [...new Set(repaired.map((r) => r.row.bible_version))].sort();
const inList = (xs) => xs.map((b) => `'${b}'`).join(", ");
const stmtCount = repaired.length * 2;

const header = [
  `-- Repair the number-split defect ("1, 000" → "1,000") — GitHub issue #452.`,
  `-- Generated ${new Date().toISOString()} by scripts/repair-number-split-verses.mjs`,
  `-- Source dump: ${dumpPath}`,
  `-- ${repaired.length} verse(s); ${repaired.reduce((n, r) => n + r.sites.length, 0)} defect site(s);` +
    ` ${stmtCount} statement(s).`,
  "--",
  "-- Every verse below was verified BEFORE this file was written: zaln-s/zaln-e counts,",
  "-- \\w counts, \\w surface forms, node counts and the whitespace-insensitive structural",
  "-- signature are all identical before and after, and the raw text differs from the",
  "-- original by exactly the deleted space characters and nothing else.",
  "--",
  "-- Each UPDATE is version-CAS'd (AND version = <version read in the dump>): if the row",
  "-- moved on since the dump, the UPDATE matches 0 rows, the repair is skipped for that",
  "-- verse, and its edit_log row is not written either. Re-dump and re-run for any skipped",
  "-- row; never force-apply. A dump more than a few hours old will silently skip rows.",
  "--",
  `-- updated_by is SET to ${REPAIR_USER_ID} and the audit row uses action='${REPAIR_ACTION}' with`,
  `-- source='${REPAIR_SOURCE}'. Both are load-bearing: they move the row out of the nightly`,
  "-- sync's blind pristine-overwrite path (bookReimport.ts:2222-2229, reimportClassify.ts:102-111)",
  "-- and keep it visible to the provenance sub-select (action IN ('create','update')), which",
  "-- otherwise walks back to an OLDER row — and an inherited source='ai_pipeline' there would",
  "-- get the verse re-seeded from master despite updated_by being set.",
  "-- Do not 'tidy' either value — see the header of the generating script.",
  "--",
  "-- EXPORT PROMPTLY AFTER APPLYING. Clearing the overwrite path is necessary, not",
  "-- sufficient: the row now goes to the three-way merge, which keeps our content only",
  "-- while master has not ALSO moved (verseMerge.ts:284-349, keep_master_unchanged). Master",
  "-- holds the broken bytes until our export lands, so that window is the whole exposure.",
  "-- To see whether the merge is even active for these rows:",
  "--   SELECT book, resource, master_confirmed_at FROM book_resource_syncs",
  ...(books.length ? [`--    WHERE book IN (${inList(books)});`] : ["--    ;"]),
  "--   NULL there means the merge is inert and updated_by alone protects the row.",
  "--",
  "-- No BEGIN/COMMIT: remote D1 rejects explicit transactions.",
  "--",
  "-- DO NOT ASSUME THIS FILE APPLIES ATOMICALLY. Against --remote, wrangler drives",
  "-- the D1 import API rather than a single batch, and this repo has already been bitten",
  "-- by it: a --file execute once ran 3 of 19 statements and still reported success.",
  "-- Every statement here is individually version-guarded and re-runnable, so a partial",
  "-- apply is recoverable — but it is only DETECTABLE if you run the post-apply checks.",
  ...(stmtCount > 70
    ? [
        "--",
        `-- ${stmtCount} statements exceeds the ~70 that have applied reliably in one --file.`,
        "-- SPLIT IT FIRST, then apply each segment in order:",
        `--   node scripts/split-sql.mjs ${relative(repoRoot, sqlPath).split("\\").join("/")} 70`,
      ]
    : []),
  "--",
  "-- Apply (human-approved step, from api/):",
  "--   npx wrangler d1 execute bible_editor --remote --env production \\",
  `--     --file=${sqlApplyPath}`,
  "--",
  "-- POST-APPLY CHECKS — run BOTH; a partial apply is silent without them.",
  `--   Expect ${repaired.length} audit row(s) for THIS repair:`,
  "--     SELECT COUNT(*) FROM edit_log",
  `--      WHERE kind='verse' AND source='${REPAIR_SOURCE}' AND created_at >= ${nowTs}`,
  `--        AND payload_json LIKE '%${INCIDENT}%'`,
  ...(books.length ? [`--        AND book IN (${inList(books)});`] : ["--     ;"]),
  ...(expectedSurvivors.length
    ? [
        `--   Expect EXACTLY ${expectedSurvivors.length} survivor(s) — NOT 0. This file deliberately does`,
        "--   not repair the rows listed under EXPECTED SURVIVORS below, and they keep matching",
        "--   the scan. Treating 0 as the pass condition here would hide a real partial apply:",
      ]
    : ["--   Expect 0 survivors (every matching row in scope is repaired by this file):"]),
  "--     SELECT book, bible_version, chapter, verse FROM verses",
  "--      WHERE plain_text GLOB '*[0-9], [0-9][0-9][0-9]*'",
  ...(books.length ? [`--        AND book IN (${inList(books)})`] : []),
  ...(versions.length ? [`--        AND bible_version IN (${inList(versions)})`] : []),
  "--      ORDER BY book, bible_version, chapter, verse;",
  "--   If either number is wrong, re-dump and re-run this script; re-applying is safe.",
  ...(expectedSurvivors.length
    ? [
        "--",
        `-- EXPECTED SURVIVORS (${expectedSurvivors.length}) — still match the GLOB after this applies:`,
        ...expectedSurvivors.map((s) => `--   ${s.rowKey}  (${s.why})`),
      ]
    : []),
  "",
];

const lines = [...header];
for (const r of repaired) {
  lines.push(
    `-- ${r.ref}  v${r.row.version} → v${Number(r.row.version) + 1}  ` +
      `sites: ${r.sites.map((s) => s.joined).join(", ")}  (zaln ${r.zaln}, \\w ${r.words} — unchanged)`,
  );
  lines.push(...statementsFor(r));
}

mkdirSync(dirname(sqlPath), { recursive: true });
writeFileSync(sqlPath, lines.join("\n") + "\n", "utf8");

// ── report ─────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
console.log("═".repeat(96));
console.log("REPAIR NUMBER-SPLIT VERSES — issue #452   (DRY BUILD: nothing is written to any database)");
console.log("═".repeat(96));
console.log(`  dump             : ${dumpPath}`);
if (dumpAgeHours > DUMP_STALE_HOURS) {
  console.log(
    `  ** DUMP IS ${dumpAgeHours.toFixed(1)}h OLD ** the SQL pins each row's version, so any row edited` +
      ` since the dump will be SILENTLY SKIPPED. Re-dump immediately before applying.`,
  );
}
console.log(`  rows in dump     : ${allRows.length}${rows.length !== allRows.length ? `  (${rows.length} after filters)` : ""}`);
console.log(`  repaired         : ${repaired.length}`);
console.log(`  defect sites     : ${repaired.reduce((n, r) => n + r.sites.length, 0)}`);
console.log(`  already clean    : ${clean.length}`);
console.log(`  plain_text only  : ${plainTextOnly.length}`);
console.log(`  release-locked   : ${lockedSkipped.length}${allowLocked ? " (--allow-locked: INCLUDED)" : " (skipped)"}`);
console.log(`  --exclude'd      : ${excludedVerses.length}`);
console.log(`  REFUSED          : ${refused.length}`);
console.log("");

console.log("PER-VERSE VERIFICATION");
console.log("─".repeat(96));
console.log(`  ${pad("verse", 20)}${pad("zaln", 7)}${pad("\\w", 6)}${pad("nodes", 7)}sites`);
for (const r of repaired) {
  console.log(
    `  ${pad(r.ref, 20)}${pad(`${r.zaln}=${r.zaln}`, 7)}${pad(`${r.words}`, 6)}${pad(`${r.nodes}`, 7)}${r.sites.length}` +
      `        [${r.rowKey}]`,
  );
  // The human decision surface. See "THE ONE ERROR NO ASSERTION CAN CATCH".
  r.sites.forEach((s, i) => {
    console.log(`        #${i + 1}  ${JSON.stringify(s.was)}  →  ${s.joined}`);
  });
}
console.log("");
console.log("  (zaln / \\w / nodes are before=after — a verse whose counts moved is REFUSED, not listed here)");
console.log("");
console.log("  READ THE CONTEXT LINES. The defect pattern also matches a legitimate list such as");
console.log("  \"of ages 5, 300, and 900 years\", which this script would 'repair' into \"5,300\" with");
console.log("  every structural check passing. No automated check can catch that — only your eyes.");
console.log("  Drop a false positive with:  --exclude BOOK/CH/V/VER   (or …#N for one site)");

if (refused.length) {
  console.log("");
  console.log("REFUSED — NEEDS MANUAL REPAIR");
  console.log("─".repeat(96));
  for (const f of refused) console.log(`  ${pad(f.ref, 20)} ${f.why}`);
}

if (lockedSkipped.length) {
  console.log("");
  console.log(`RELEASE-LOCKED (${lockedSkipped.length}) — in PUBLISHED_BOOKS, edit AND export are frozen.`);
  console.log("A direct D1 UPDATE bypasses the route-layer lock, so these are skipped by default:");
  console.log("repairing them would not reach Door43 and would diverge D1 from a published release.");
  console.log("Pass --allow-locked only with a deliberate decision to do that.");
  console.log("─".repeat(96));
  const byBook = new Map();
  for (const d of lockedSkipped) {
    const b = d.rowKey.split("/")[0];
    byBook.set(b, (byBook.get(b) ?? 0) + 1);
  }
  console.log("  " + [...byBook].sort().map(([b, n]) => `${b}=${n}`).join("  "));
}

if (plainTextOnly.length) {
  console.log("");
  console.log(`plain_text-ONLY DEFECT (${plainTextOnly.length}) — the verse tree is already repaired,`);
  console.log("but the denormalized plain_text column still holds the split number. These rows keep");
  console.log("matching the dump's GLOB on every future run, so the scan never converges. NOT repaired");
  console.log("here — this script only rewrites plain_text alongside a real tree change.");
  console.log("─".repeat(96));
  for (const d of plainTextOnly) console.log(`  ${pad(d.ref, 20)} would become: ${d.newPlain.slice(0, 60)}`);
}

if (excludedVerses.length || excludedSiteNotes.length) {
  console.log("");
  console.log("EXCLUDED BY --exclude");
  console.log("─".repeat(96));
  for (const k of excludedVerses) console.log(`  ${k}  (whole verse dropped)`);
  for (const n of excludedSiteNotes) {
    console.log(`  ${n.rowKey}  site(s) ${n.sites.join(", ")} of ${n.total} dropped → whole verse REFUSED`);
  }
}

if (plainTextDrift.length) {
  console.log("");
  console.log(`PRE-EXISTING plain_text DRIFT (${plainTextDrift.length}) — stored plain_text already disagreed`);
  console.log("with its own tree. The repair applies the join to the STORED string, so this drift is");
  console.log("neither fixed nor worsened here.");
  console.log("─".repeat(96));
  for (const d of plainTextDrift.slice(0, 10)) console.log(`  ${d}`);
  if (plainTextDrift.length > 10) console.log(`  … and ${plainTextDrift.length - 10} more`);
}

console.log("");
if (expectedSurvivors.length) {
  console.log(`AFTER APPLYING, ${expectedSurvivors.length} row(s) will STILL match the scan — by design.`);
  console.log("The generated SQL header lists them so the post-apply check expects that number, not 0.");
  console.log("");
}
console.log(`SQL written → ${sqlPath}   (${stmtCount} statements)`);
if (stmtCount > 70) {
  console.log(`** ${stmtCount} statements exceeds the ~70 that apply reliably in one --file.`);
  console.log(`   Split first:  node scripts/split-sql.mjs ${relative(repoRoot, sqlPath).split("\\").join("/")} 70`);
}
console.log("NOT APPLIED. Apply is a separate, human-approved step (see the header of that file).");

if (jsonPath) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dump: dumpPath,
        dumpAgeHours: Number(dumpAgeHours.toFixed(2)),
        repairUserId: REPAIR_USER_ID,
        repairAction: REPAIR_ACTION,
        repairSource: REPAIR_SOURCE,
        repaired: repaired.map((r) => ({
          ref: r.ref,
          rowKey: r.rowKey,
          book: r.row.book,
          chapter: r.row.chapter,
          verse: r.row.verse,
          bibleVersion: r.row.bible_version,
          version: r.row.version,
          updatedByBefore: r.row.updated_by ?? null,
          zaln: r.zaln,
          words: r.words,
          nodes: r.nodes,
          sites: r.sites,
          newPlainText: r.newPlain,
        })),
        refused: refused.map((f) => ({ ref: f.ref, rowKey: f.rowKey, why: f.why })),
        clean,
        plainTextOnly: plainTextOnly.map((d) => ({ ref: d.ref, rowKey: d.rowKey, newPlainText: d.newPlain })),
        plainTextDrift,
        lockedSkipped,
        excludedVerses: [...excludedVerses],
        excludedSiteNotes,
        expectedSurvivors,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Report written → ${jsonPath}`);
}

process.exit(refused.length ? 2 : 0);

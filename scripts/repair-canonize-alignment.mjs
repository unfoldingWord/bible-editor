// One-time repair: canonize ULT/UST `\zaln-s` source Hebrew to the exact UHB
// bytes — GitHub issue #945.
//
// ── WHAT IS BROKEN ─────────────────────────────────────────────────────────
//   A ULT/UST alignment milestone whose x-content does not byte-match the UHB
//   word it aligns to. The highlighter links English↔Hebrew by those bytes, so
//   clicking the English word highlights nothing. Reported case, JER 28:12 ULT
//   "after":
//     \zaln-s x-content  אַ⁠חֲרֵי   (a U+2060 word joiner where the accent was)
//     UHB \w             אַ֠חֲרֵי   (U+05A0 telisha gedola)
//   Origin: bp-assistant's first commit of JER 28 (en_ult@13fa9aa2, 2026-06-04),
//   imported 2026-06-15. api/src/canonizeHebrew.ts canonizeAlignmentSource
//   (added 2026-07-13) repairs exactly this, but only at AI ingest and master
//   adoption. Nothing ever ran it over rows already in D1. Same shape as #762.
//
// ── WHAT THIS SCRIPT DOES ──────────────────────────────────────────────────
//   For every ULT/UST verse in the dump it builds the UHB SourceWord[] the way
//   production does (collectSourceWords per UHB verse, unioned across a verse
//   bridge via verse_end), runs the REAL canonizeAlignmentSource over a copy of
//   the tree, and verifies that the only differences are `content` / `lemma`
//   strings on `tag:"zaln"` milestones. Every `\w`, every text node, every
//   other attribute, node count and order must be identical, so plain_text is
//   unchanged. Any other difference REFUSES the verse. The transform and the
//   verifier live in scripts/lib/canonizeAlignment.mjs, covered by
//   scripts/lib/canonizeAlignment.test.mjs (`npm run test:scripts`).
//
//   It reads SELECT-only JSON dumps and writes SQL. IT NEVER TOUCHES ANY
//   DATABASE. Applying is a separate, human step.
//
// ── HOW THE REPAIR SURVIVES THE NIGHTLY SYNC ───────────────────────────────
//   Identical to scripts/repair-number-split-verses.mjs — READ ITS HEADER
//   before changing the SQL. In short, all load-bearing:
//     1. `updated_by` is SET (2 = deferredreward), so the row leaves the sync's
//        blind pristine-overwrite path (updated_by IS NULL).
//     2. The audit row uses action='update' (visible to the provenance
//        sub-select, action IN ('create','update')) with source='data_repair'
//        (not 'ai_pipeline', so it reads as human-owned).
//     3. The payload carries `content` and `plain_text`, so the three-way
//        merge can use this row as its ancestor (verseContentJsonFromPayload).
//     4. Master still holds the old bytes until our export pushes the fix, and
//        a master that ALSO changed out-of-band wins the merge. EXPORT PROMPTLY.
//   One addition over that script: the UPDATE also stamps the row-provenance
//   columns added by migration 0060 after it was written (last_change_action
//   'update', last_change_source 'system', actor 'deferredreward'). Nothing
//   classifies on them; they stop the row claiming an older change as its last.
//
// ── THE LOCK GUARD ─────────────────────────────────────────────────────────
//   A direct D1 UPDATE bypasses the route-layer lock. The rule is the one
//   scripts/split-fixes-by-lock.mjs uses (mirrors effectiveBookLock): an
//   explicit `book_locks` row wins in BOTH directions; with no row, a book in
//   PUBLISHED_BOOKS (api/src/publishedGuard.ts, parsed at run time) is locked.
//   Locked-book changes are computed and REPORTED (with \u escapes) for a
//   Door43 admin, never written to SQL unless --allow-locked is passed. Each
//   UPDATE also carries `AND NOT EXISTS (book_locks … locked = 1)`, so a lock
//   placed between dump and apply still blocks the write.
//
// ── REFUSALS (never guessed around) ────────────────────────────────────────
//   A verse is refused, reported, and left out of the SQL when: a required
//   column is absent from its dump row (verse_end, plain_text, updated_by, …);
//   duplicate dump rows for it disagree; any UHB verse in [verse, verse_end] is
//   missing or unparseable; the verifier sees any change beyond zaln
//   content/lemma; or a statement would exceed 90,000 bytes. A target book
//   with no UHB rows at all stops the run (exit 1). An unaligned verse 0 with
//   no UHB verse 0 is front matter ("no source"); an aligned one is refused.
//
// ── USAGE ──────────────────────────────────────────────────────────────────
//   1. Dump (SELECT ONLY — never --file against --remote), from api/, per book:
//        npx wrangler d1 execute bible_editor --remote --env production --json \
//          --command "SELECT book, chapter, verse, verse_end, bible_version, version, \
//                     content_json, plain_text, updated_at, updated_by FROM verses \
//                     WHERE book='JER' AND bible_version='ULT' ORDER BY chapter, verse" \
//          > ../scripts/out/945/dump/JER-ULT.json
//      the same for UST, and for UHB (only book, chapter, verse, content_json
//      are needed), plus:
//        npx wrangler d1 execute bible_editor --remote --env production --json \
//          --command "SELECT book, locked FROM book_locks" > ../scripts/out/945/book-locks.json
//
//   2. Build + verify (writes SQL, touches nothing):
//        node --experimental-strip-types --no-warnings scripts/repair-canonize-alignment.mjs \
//          --locks scripts/out/945/book-locks.json scripts/out/945/dump
//      Positional arguments are dump files or directories of them (*.json);
//      rows are routed by bible_version (UHB = source, ULT/UST = targets).
//
//      Options:
//        --locks <path>        book_locks dump (REQUIRED)
//        --book JER[,NUM]      only these books
//        --bible-version ULT   only these target resources
//        --exclude BOOK/CH/V/VER   drop one verse (repeatable)
//        --allow-locked        include locked books in the SQL (and drop the
//                              apply-time book_locks guard; unlock first anyway)
//        --out <path>          SQL (default scripts/out/repair-canonize-alignment.sql)
//        --json <path>         full per-verse report
//        --force               overwrite an existing --out file
//        --visible-only        only verses with at least one "visible" change
//                              (content that differs from the UHB even under
//                              NFC, i.e. the word does not highlight today).
//                              Such a verse is still canonized whole; verses
//                              whose only changes are mark order / lemma are
//                              left for the next ingest or adoption.
//
//   Change kinds in the report (see classifyChange in the lib):
//     visible     content differs from the UHB under NFC — broken highlight
//     mark_order  content equal under NFC; combining-mark order moves to UHB bytes
//     lemma_only  only x-lemma adopts the UHB lemma
//   DECLINED lists milestones that stay visibly wrong because the canonizer
//   fails closed (usually two UHB words fit). They need a human in the aligner.
//
//   VERSE BRIDGES. A UST row with verse_end is matched against the UHB words of
//   EVERY verse in the bridge, as production does. A scan that looks only at
//   `verse` over-counts: on 2026-09-24 that reported ~45 UST words in 1CH/2CH/
//   ISA/DEU/DAN/... that in fact byte-match a UHB word in the bridge's other
//   verse. Canonizing those against the first verse alone would CORRUPT them.
//
//   3. Apply — a separate, human-approved step. The generated file's header
//      carries the apply command and the post-apply checks.
//
// ── --qere-ketiv (GitHub issue #956) ───────────────────────────────────────
//   A second, separate pass. Since hbo_uhb aad8ce31 (2026-08-14) the UHB main
//   text always carries the KETIV (written) form and the QERE (read) form sits
//   only in a footnote after it. Milestones still pointing at the qere match no
//   UHB \w, so they never highlight, and the canonizer cannot fix them (the
//   consonants differ). With --qere-ketiv, a milestone whose skeleton matches
//   no UHB \w in [verse, verse_end] but matches a qere footnote word there is
//   re-pointed to the ketiv \w that footnote follows: content, strong, and
//   lemma/morph adopt the ketiv's values, and occurrence/occurrences are
//   recounted for the ketiv across the range. The verifier then allows those
//   six zaln attributes to change and nothing else. Incident '#956', default
//   SQL scripts/out/repair-qere-ketiv-alignment.sql. DECLINED lists every
//   milestone still matching no UHB \w (ambiguous qere, Strong's mismatch, or
//   no qere either). Not combinable with --visible-only.
//
// Idempotent: re-running against a fresh dump of repaired rows emits no SQL.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJsonRows } from "./lib/numberSplit.mjs";
import {
  buildSourceIndex,
  sourceCoverage,
  repairVerse,
  repointQereVerse,
  rowIdentityProblem,
  dedupeRows,
  commentSafe,
  uEscape,
} from "./lib/canonizeAlignment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");

// See "HOW THE REPAIR SURVIVES THE NIGHTLY SYNC". 2 = deferredreward.
const REPAIR_USER_ID = 2;
const REPAIR_ACTOR = "deferredreward";
const REPAIR_ACTION = "update"; // must stay 'update' — see repair-number-split-verses.mjs
const REPAIR_SOURCE = "data_repair";
const QERE_MODE = process.argv.includes("--qere-ketiv");
const ISSUE = QERE_MODE ? 956 : 945;
const INCIDENT = `#${ISSUE}`;
const INCIDENT_LIKE = `%"incident":"${INCIDENT}"%`;
const TARGET_VERSIONS = new Set(["ULT", "UST"]);

// ── args ───────────────────────────────────────────────────────────────────

const USAGE =
  "usage: node --experimental-strip-types --no-warnings scripts/repair-canonize-alignment.mjs\n" +
  "         --locks <book_locks.json> <dump.json|dir>...\n" +
  "         [--book JER[,NUM]] [--bible-version ULT[,UST]]\n" +
  "         [--exclude BOOK/CH/V/VER] (repeatable)  [--allow-locked]  [--visible-only | --qere-ketiv]\n" +
  "         [--out <sql>] [--json <report>] [--force]\n" +
  "  exit 0 = every change verified · 2 = at least one verse REFUSED · 1 = bad input";
const die = (msg) => {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--out", "--json", "--book", "--bible-version", "--exclude", "--locks"]);
const BOOL_FLAGS = new Set(["--force", "--allow-locked", "--visible-only", "--qere-ketiv"]);
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
if (positionals.length === 0) die("missing dump file/directory arguments");
if (!flags.has("--locks")) die("--locks <book_locks dump> is required");

const argVal = (flag) => (flags.has(flag) ? flags.get(flag) : null);
const listArg = (flag) => {
  const raw = argVal(flag);
  if (raw == null) return null;
  const set = new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (!set.size) die(`${flag} parsed to an empty list`);
  return set;
};

const bookFilter = listArg("--book");
const versionFilter = listArg("--bible-version");
const allowLocked = flags.get("--allow-locked") === true;
const force = flags.get("--force") === true;
const visibleOnly = flags.get("--visible-only") === true;
if (visibleOnly && QERE_MODE) die("--visible-only and --qere-ketiv cannot be combined (every qere repoint is visible)");
const outDir = resolve(repoRoot, "scripts", "out");
const sqlPath = argVal("--out") ? resolve(process.cwd(), argVal("--out")) : resolve(outDir, QERE_MODE ? "repair-qere-ketiv-alignment.sql" : "repair-canonize-alignment.sql");
const jsonPath = argVal("--json") ? resolve(process.cwd(), argVal("--json")) : null;
const locksPath = resolve(process.cwd(), argVal("--locks"));

const excludeVerses = new Set();
for (const raw of flags.get("--exclude") ?? []) {
  const m = /^([^/\s]+)\/(\d+)\/(\d+)\/([^#\s]+)$/.exec(raw.trim());
  if (!m) die(`--exclude: '${raw}' is not BOOK/CH/V/VERSION`);
  excludeVerses.add(`${m[1].toUpperCase()}/${Number(m[2])}/${Number(m[3])}/${m[4].toUpperCase()}`);
}

// ── lock rule ──────────────────────────────────────────────────────────────

function loadPublishedBooks() {
  const p = resolve(apiDir, "src", "publishedGuard.ts");
  let text;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    die(`cannot read ${p} to learn which books are release-locked: ${e.message}`);
  }
  const m = /export const PUBLISHED_BOOKS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(text);
  if (!m) die(`could not parse PUBLISHED_BOOKS out of ${p}. Refusing to guess which books are locked.`);
  const books = new Set([...m[1].matchAll(/"([A-Z0-9]{3})"/g)].map((x) => x[1]));
  if (books.size < 10) die(`parsed only ${books.size} book(s) from PUBLISHED_BOOKS — refusing (parser drift?)`);
  return books;
}
const PUBLISHED_BOOKS = loadPublishedBooks();

if (!existsSync(locksPath)) die(`book_locks dump not found: ${locksPath}`);
const explicitLocks = new Map();
{
  let lockRows;
  try {
    lockRows = extractJsonRows(readFileSync(locksPath, "utf8"), locksPath);
  } catch (e) {
    die(e.message);
  }
  for (const r of lockRows) {
    if (typeof r.book !== "string" || !("locked" in r)) die(`${locksPath} is not a book_locks dump (need book, locked)`);
    explicitLocks.set(r.book.toUpperCase(), Number(r.locked) === 1);
  }
}
const lockReason = (book) =>
  explicitLocks.has(book)
    ? explicitLocks.get(book) ? "book_locks row locked=1" : null
    : PUBLISHED_BOOKS.has(book) ? "PUBLISHED_BOOKS (no book_locks row)" : null;

// ── dump loading ───────────────────────────────────────────────────────────

const dumpFiles = [];
for (const p of positionals) {
  const abs = resolve(process.cwd(), p);
  if (!existsSync(abs)) die(`not found: ${abs}`);
  if (statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs).sort()) if (f.endsWith(".json")) dumpFiles.push(join(abs, f));
  } else dumpFiles.push(abs);
}
if (!dumpFiles.length) die("no .json dump files found");

const DUMP_STALE_HOURS = 6;
let oldestDumpHours = 0;
const uhbRowsByBook = new Map();
const rawTargets = [];
for (const f of dumpFiles) {
  let rows;
  try {
    rows = extractJsonRows(readFileSync(f, "utf8"), f);
  } catch (e) {
    die(e.message);
  }
  oldestDumpHours = Math.max(oldestDumpHours, (Date.now() - statSync(f).mtimeMs) / 3_600_000);
  for (const r of rows) {
    // Normalize identity at load so row_key, --exclude and the lock lookup all
    // agree. D1 stores these uppercase; this only guards a hand-made dump.
    if (typeof r.book === "string") r.book = r.book.trim().toUpperCase();
    if (typeof r.bible_version === "string") r.bible_version = r.bible_version.trim().toUpperCase();
    const bv = String(r.bible_version ?? "");
    const book = String(r.book ?? "");
    if (bv === "UHB") {
      if (!uhbRowsByBook.has(book)) uhbRowsByBook.set(book, []);
      uhbRowsByBook.get(book).push(r);
    } else if (TARGET_VERSIONS.has(bv)) {
      if (bookFilter && !bookFilter.has(book)) continue;
      if (versionFilter && !versionFilter.has(bv)) continue;
      rawTargets.push(r);
    }
  }
}
if (!rawTargets.length) die("no ULT/UST rows to process (after --book/--bible-version filters)");
const { rows: targetRows, conflicts: duplicateConflicts } = dedupeRows(rawTargets);

// A target book with NO UHB rows at all means a dump file is missing, not that
// the book has nothing to repair. Stop rather than report it as clean.
const booksWithoutUhb = [...new Set(targetRows.map((r) => String(r.book)))].filter((b) => !uhbRowsByBook.has(b)).sort();
if (booksWithoutUhb.length) {
  console.error("═".repeat(96));
  console.error(`NO UHB ROWS for ${booksWithoutUhb.length} target book(s): ${booksWithoutUhb.join(", ")}`);
  console.error("Every verse in those books would be skipped unexamined. Dump their UHB verses, or narrow");
  console.error("the run with --book. No SQL written.");
  console.error("═".repeat(96));
  process.exit(1);
}

const sourceIndexByBook = new Map();
for (const [book, rows] of uhbRowsByBook) sourceIndexByBook.set(book, buildSourceIndex(rows));

if (existsSync(sqlPath) && !force) {
  die(`${sqlPath} already exists. Refusing to overwrite a file an operator may have verified. Pass --force.`);
}

// ── per-verse repair ───────────────────────────────────────────────────────

const repaired = [];
const lockedChanges = [];
const refused = [];
const excluded = [];
let clean = 0;
let noSource = 0;
let skippedInvisible = 0;
const declined = []; // { ref, rowKey, book, bv, lock, items }

for (const row of targetRows) {
  const book = String(row.book);
  const bv = String(row.bible_version);
  const ref = `${book} ${bv} ${row.chapter}:${row.verse}${row.verse_end != null && Number(row.verse_end) !== Number(row.verse) ? `-${row.verse_end}` : ""}`;
  const rowKey = `${row.book}/${row.chapter}/${row.verse}/${row.bible_version}`;
  // --exclude first: an excluded verse is never parsed, so a malformed one
  // cannot count as REFUSED or change the exit code.
  if (excludeVerses.has(`${book}/${Number(row.chapter)}/${Number(row.verse)}/${bv}`)) {
    excluded.push(rowKey);
    continue;
  }
  if (duplicateConflicts.has(rowKey)) {
    refused.push({ ref, rowKey, why: duplicateConflicts.get(rowKey) });
    continue;
  }
  const idProblem = rowIdentityProblem(row);
  if (idProblem) {
    refused.push({ ref, rowKey, why: `row unusable — ${idProblem}` });
    continue;
  }
  // Verse 0 is front matter and normally has no UHB counterpart: expected, not
  // a refusal. But Psalm superscriptions ARE verse 0 in the UHB and are aligned
  // (128 PSA rows on 2026-09-24), so a verse 0 whose UHB row exists is
  // processed like any other verse.
  const index = sourceIndexByBook.get(book);
  const v0key = `${Number(row.chapter)}:0`;
  if (Number(row.verse) === 0 && !index.words.has(v0key) && !index.unusable.has(v0key)) {
    // No UHB verse 0 but the target is aligned: the dump is truncated, not
    // front matter. Refuse rather than silently skip.
    if (String(row.content_json).includes('"tag":"zaln"')) {
      refused.push({ ref, rowKey, why: "aligned verse 0 but the UHB dump has no verse 0 for this chapter" });
    } else {
      noSource++;
    }
    continue;
  }
  const cov = sourceCoverage(index, row.chapter, row.verse, row.verse_end);
  if (cov.problems.length) {
    refused.push({ ref, rowKey, why: `source words incomplete — ${cov.problems.join("; ")}` });
    continue;
  }
  const r = QERE_MODE ? repointQereVerse(row.content_json, cov.words, cov.qeres) : repairVerse(row.content_json, cov.words);
  const lock = lockReason(book);
  if (r.declined?.length) declined.push({ ref, rowKey, book, bv, lock, items: r.declined });
  if (r.status === "clean") { clean++; continue; }
  if (r.status === "no_source") { noSource++; continue; }
  if (r.status === "refused") { refused.push({ ref, rowKey, why: r.why }); continue; }
  const entry = { ref, rowKey, book, bv, row, newContentJson: r.newContentJson, changes: r.changes };
  // Lock BEFORE the visible filter: a locked book's changes are always
  // reported for the Door43 admin, whatever their kind.
  if (lock && !allowLocked) { lockedChanges.push({ ...entry, lock }); continue; }
  if (visibleOnly && !r.changes.some((c) => c.kind === "visible")) { skippedInvisible++; continue; }
  repaired.push({ ...entry, lock });
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
  // `content` and `plain_text` are REQUIRED — see repair-number-split-verses.mjs.
  // plain_text is the stored value: the verifier proved no text node changed.
  const payload = JSON.stringify({
    content: r.newContentJson,
    plain_text: row.plain_text ?? null,
    incident: INCIDENT,
    issue: ISSUE,
    changes: r.changes.map(({ path, kind, ...c }) => c),
  });
  const update =
    `UPDATE verses SET content_json = ${sqlStr(r.newContentJson)},` +
    ` version = version + 1, updated_at = ${nowTs}, updated_by = ${REPAIR_USER_ID},` +
    ` last_change_action = 'update', last_change_source = 'system', last_change_actor = ${sqlStr(REPAIR_ACTOR)}` +
    ` WHERE ${match} AND version = ${v}` +
    // Apply-time lock guard, mirroring effectiveBookLock at apply time. An
    // unpublished book is writable unless a locked=1 row appears. A published
    // book only got here through an explicit locked=0 unlock, so it stays
    // writable only while that row still exists — deleting it reverts the book
    // to the published default (locked). Omitted under --allow-locked, which
    // asks to write locked books on purpose.
    (allowLocked
      ? ";"
      : PUBLISHED_BOOKS.has(row.book)
        ? ` AND EXISTS (SELECT 1 FROM book_locks WHERE book = ${sqlStr(row.book)} AND locked = 0);`
        : ` AND NOT EXISTS (SELECT 1 FROM book_locks WHERE book = ${sqlStr(row.book)} AND locked = 1);`);
  // Guarded audit row: only when the row is now at v+1 holding exactly our
  // content, and only once (re-running after a partial apply cannot double-log).
  // It keys on the UPDATE having happened, so a lock-blocked or version-skipped
  // UPDATE writes no audit row either.
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'verse',${sqlStr(r.rowKey)},${sqlStr(row.book)},${REPAIR_USER_ID},${v},${v + 1},${sqlStr(REPAIR_ACTION)},` +
    `${sqlStr(payload)},${sqlStr(REPAIR_SOURCE)},${nowTs}` +
    ` FROM verses WHERE ${match} AND version = ${v + 1} AND content_json = ${sqlStr(r.newContentJson)}` +
    ` AND NOT EXISTS (SELECT 1 FROM edit_log WHERE kind = 'verse' AND row_key = ${sqlStr(r.rowKey)}` +
    ` AND source = ${sqlStr(REPAIR_SOURCE)} AND new_version = ${v + 1}` +
    ` AND payload_json LIKE ${sqlStr(INCIDENT_LIKE)});`;
  return [update, log];
}

// D1 rejects a statement over ~100 KB. Refuse (never truncate) any verse whose
// UPDATE or audit INSERT would pass this margin.
const MAX_STATEMENT_BYTES = 90_000;
for (let i = repaired.length - 1; i >= 0; i--) {
  const sizes = statementsFor(repaired[i]).map((s) => Buffer.byteLength(s, "utf8"));
  if (Math.max(...sizes) > MAX_STATEMENT_BYTES) {
    const [r] = repaired.splice(i, 1);
    refused.push({ ref: r.ref, rowKey: r.rowKey, why: `statement too large (${Math.max(...sizes)} bytes > ${MAX_STATEMENT_BYTES}); fix by hand` });
  }
}

const wordCount = (list) => list.reduce((n, r) => n + r.changes.length, 0);
const books = [...new Set(repaired.map((r) => r.row.book))].sort();
const inList = (xs) => xs.map((b) => `'${b}'`).join(", ");
const stmtCount = repaired.length * 2;
const CHANGE_ATTRS = ["content", "lemma", "morph", "strongChange", "occurrence", "occurrences"];
const fmtChange = (c) => {
  const parts = [];
  for (const k of CHANGE_ATTRS) if (c[k]) parts.push(`${k === "strongChange" ? "strong" : k} ${uEscape(c[k].before)} → ${uEscape(c[k].after)}`);
  return `[${c.kind}] ${uEscape(c.strong || "?")}: ${parts.join("; ")}`;
};
const kindCounts = (list) => {
  const k = { visible: 0, mark_order: 0, lemma_only: 0, qere_ketiv: 0 };
  for (const r of list) for (const c of r.changes) k[c.kind]++;
  return k;
};
const fmtKinds = (k) =>
  QERE_MODE ? `qere_ketiv ${k.qere_ketiv}` : `visible ${k.visible} · mark_order ${k.mark_order} · lemma_only ${k.lemma_only}`;

const header = [
  QERE_MODE
    ? `-- Re-point ULT/UST \\zaln-s from the qere to the UHB ketiv word — GitHub issue #956.`
    : `-- Canonize ULT/UST \\zaln-s source Hebrew to the exact UHB bytes — GitHub issue #945.`,
  `-- Generated ${new Date().toISOString()} by scripts/repair-canonize-alignment.mjs`,
  `-- Source dumps: ${dumpFiles.length} file(s) under ${[...new Set(dumpFiles.map(dirname))].join(", ")}`,
  `-- ${repaired.length} verse(s); ${wordCount(repaired)} milestone(s) (${fmtKinds(kindCounts(repaired))}); ${stmtCount} statement(s).`,
  `-- Mode: ${QERE_MODE ? "--qere-ketiv (qere milestones re-pointed to the ketiv \\w)" : visibleOnly ? "--visible-only (verses with a broken highlight; each canonized whole)" : "full canonize (every verse the canonizer changes)"}.`,
  "--",
  "-- Every verse below was verified BEFORE this file was written: the parsed tree before and",
  QERE_MODE
    ? "-- after is deep-equal except for content/lemma/morph/strong/occurrence(s) on zaln milestones. Node count,"
    : "-- after is deep-equal except for `content` / `lemma` strings on zaln milestones. Node count,",
  "-- order, every \\w, every text node and plain_text are identical.",
  "--",
  "-- Each UPDATE is version-CAS'd (AND version = <version read in the dump>): a row that moved",
  "-- on since the dump matches 0 rows and its edit_log row is not written either. Re-dump and",
  "-- re-run for any skipped row; never force-apply.",
  "--",
  `-- updated_by is SET to ${REPAIR_USER_ID} and the audit row uses action='${REPAIR_ACTION}' with`,
  `-- source='${REPAIR_SOURCE}'. Both are load-bearing — see scripts/repair-number-split-verses.mjs.`,
  "--",
  "-- EXPORT PROMPTLY AFTER APPLYING. Master holds the old bytes until our export lands; a master",
  "-- that ALSO moves in that window wins the three-way merge. To see whether the merge is active:",
  "--   SELECT book, resource, master_confirmed_at FROM book_resource_syncs",
  ...(books.length ? [`--    WHERE book IN (${inList(books)});`] : ["--    ;"]),
  "--",
  "-- No BEGIN/COMMIT: remote D1 rejects explicit transactions. DO NOT ASSUME THIS FILE APPLIES",
  "-- ATOMICALLY — a --file execute once ran 3 of 19 statements and reported success. Every",
  "-- statement is individually guarded and re-runnable; run the post-apply checks.",
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
  `--   1. Expect ${repaired.length} audit row(s) for THIS repair:`,
  "--     SELECT COUNT(*) FROM edit_log",
  `--      WHERE kind='verse' AND source='${REPAIR_SOURCE}' AND created_at >= ${nowTs}`,
  `--        AND payload_json LIKE '${INCIDENT_LIKE}'`,
  ...(books.length ? [`--        AND book IN (${inList(books)});`] : ["--     ;"]),
  "--   2. Re-dump the same books and re-run this script. Expect 0 verses in the SQL. The",
  `--      ${lockedChanges.length} locked-book change(s)${refused.length ? ` and ${refused.length} REFUSED verse(s)` : ""} reported by this run are NOT repaired`,
  "--      here and will be reported again — that is expected, not a failed apply.",
  "--   3. Every UPDATE also requires NOT EXISTS a book_locks row with locked=1 for its book. If an",
  "--      admin locked a book after the dump, its verses are silently skipped (no audit row",
  "--      either), so check 1 comes up short by exactly those verses. Confirm with:",
  ...(books.length ? [`--        SELECT book, locked FROM book_locks WHERE book IN (${inList(books)});`] : ["--        SELECT book, locked FROM book_locks;"]),
  "",
];

// Every `--` line passes through commentSafe: refs, paths, book codes and
// Strong's numbers come from data, and a raw CR/LF in one would end the
// comment and turn the rest of that line into a live statement. A trailing
// `;` is dropped too: scripts/split-sql.mjs counts any line ending in `;` as a
// statement, so a comment ending in one shifts every segment boundary between
// an UPDATE and its audit INSERT.
const comment = (s) => commentSafe(s).replace(/;\s*$/, "");
const lines = header.map((l) => (l.startsWith("--") ? comment(l) : l));
for (const r of repaired) {
  lines.push(comment(`-- ${r.ref}  v${r.row.version} → v${Number(r.row.version) + 1}${r.lock ? `  [LOCKED: ${r.lock}; --allow-locked]` : ""}`));
  for (const c of r.changes) lines.push(comment(`--   ${fmtChange(c)}`));
  lines.push(...statementsFor(r));
}
mkdirSync(dirname(sqlPath), { recursive: true });
writeFileSync(sqlPath, lines.join("\n") + "\n", "utf8");

// ── report ─────────────────────────────────────────────────────────────────

const tally = (list) => {
  const m = new Map();
  for (const r of list) {
    const k = `${r.book} ${r.bv}`;
    const cur = m.get(k) ?? { verses: 0, words: 0, visible: 0, mark_order: 0, lemma_only: 0, qere_ketiv: 0 };
    cur.verses++;
    cur.words += r.changes.length;
    for (const c of r.changes) cur[c.kind]++;
    m.set(k, cur);
  }
  return [...m].sort((a, b) => a[0].localeCompare(b[0]));
};
const pad = (s, n) => String(s).padEnd(n);
const tallyHead = QERE_MODE
  ? `  ${pad("book ver", 10)} ${pad("verses", 7)} words`
  : `  ${pad("book ver", 10)} ${pad("verses", 7)} ${pad("words", 6)} ${pad("visible", 8)} ${pad("mark_ord", 9)} lemma_only`;
const tallyLine = ([k, c]) =>
  QERE_MODE
    ? `  ${pad(k, 10)} ${pad(c.verses, 7)} ${c.words}`
    : `  ${pad(k, 10)} ${pad(c.verses, 7)} ${pad(c.words, 6)} ${pad(c.visible, 8)} ${pad(c.mark_order, 9)} ${c.lemma_only}`;
const declinedCount = declined.reduce((n, d) => n + d.items.length, 0);

console.log("═".repeat(96));
console.log(`${QERE_MODE ? "REPOINT QERE → KETIV" : "REPAIR CANONIZE ALIGNMENT SOURCE"} — issue ${INCIDENT}   (DRY BUILD: nothing is written to any database)`);
console.log("═".repeat(96));
if (oldestDumpHours > DUMP_STALE_HOURS) {
  console.log(`  ** OLDEST DUMP IS ${oldestDumpHours.toFixed(1)}h OLD ** rows edited since will be SILENTLY SKIPPED. Re-dump before applying.`);
}
console.log(`  dump files         : ${dumpFiles.length}`);
console.log(`  ULT/UST rows       : ${targetRows.length}`);
console.log(`  UHB books loaded   : ${uhbRowsByBook.size}`);
console.log(`  mode               : ${QERE_MODE ? "--qere-ketiv" : visibleOnly ? "--visible-only" : "full canonize"}`);
console.log(`  repaired (in SQL)  : ${repaired.length} verse(s), ${wordCount(repaired)} milestone(s)  [${fmtKinds(kindCounts(repaired))}]`);
console.log(`  locked (reported)  : ${lockedChanges.length} verse(s), ${wordCount(lockedChanges)} milestone(s)  [${fmtKinds(kindCounts(lockedChanges))}]${allowLocked ? " (--allow-locked: in SQL)" : ""}`);
if (visibleOnly) console.log(`  skipped, no visible change: ${skippedInvisible} verse(s)`);
console.log(`  DECLINED           : ${declinedCount} visible milestone(s) left alone, in ${declined.length} verse(s)`);
console.log(`  --exclude'd        : ${excluded.length}`);
console.log(`  already clean      : ${clean}`);
console.log(`  verse 0 / no source: ${noSource}`);
console.log(`  REFUSED            : ${refused.length}`);
console.log("");

console.log("REPAIRED — per book × version");
console.log("─".repeat(96));
console.log(tallyHead);
for (const t of tally(repaired)) console.log(tallyLine(t));
console.log("");
console.log("REPAIRED — every change");
console.log("─".repeat(96));
for (const r of repaired) {
  console.log(`  ${pad(r.ref, 22)} v${r.row.version}  [${r.rowKey}]`);
  for (const c of r.changes) console.log(`        ${fmtChange(c)}`);
}

if (lockedChanges.length) {
  console.log("");
  console.log(`LOCKED BOOKS — NOT in the SQL. Fix on Door43 (admin). ${lockedChanges.length} verse(s), ${wordCount(lockedChanges)} milestone(s)`);
  console.log("─".repeat(96));
  console.log(tallyHead);
  for (const t of tally(lockedChanges)) console.log(tallyLine(t));
  console.log("");
  console.log("  VISIBLE changes only (broken highlights). mark_order / lemma_only changes are in the --json report.");
  for (const r of lockedChanges) {
    const vis = r.changes.filter((c) => c.kind === "visible" || c.kind === "qere_ketiv");
    if (!vis.length) continue;
    console.log(`  ${pad(r.ref, 22)} v${r.row.version}  (${r.lock})`);
    for (const c of vis) console.log(`        ${fmtChange(c)}`);
  }
}

if (excluded.length) {
  console.log("");
  console.log("EXCLUDED BY --exclude");
  console.log("─".repeat(96));
  for (const k of excluded) console.log(`  ${k}`);
}

if (declined.length) {
  console.log("");
  console.log("DECLINED — still a broken highlight after canonizing; the canonizer fails closed. Fix in the aligner.");
  console.log("─".repeat(96));
  for (const d of declined) {
    console.log(`  ${pad(d.ref, 22)} ${d.lock ? `(LOCKED: ${d.lock})` : ""}`);
    for (const it of d.items) {
      console.log(`        ${it.strong || "?"}: ${uEscape(it.content)}  — ${it.reason}; UHB candidates: ${it.candidates.map(uEscape).join(" | ")}`);
    }
  }
}

if (refused.length) {
  console.log("");
  console.log("REFUSED — NEEDS A HAND");
  console.log("─".repeat(96));
  for (const f of refused) console.log(`  ${pad(f.ref, 22)} ${f.why}`);
}

console.log("");
console.log(`SQL written → ${sqlPath}   (${stmtCount} statements)`);
if (stmtCount > 70) console.log(`** Split first:  node scripts/split-sql.mjs ${relative(repoRoot, sqlPath).split("\\").join("/")} 70`);
console.log("NOT APPLIED. Apply is a separate, human-approved step (see the header of that file).");

if (jsonPath) {
  const ser = (r) => ({
    ref: r.ref, rowKey: r.rowKey, book: r.book, bibleVersion: r.bv,
    chapter: r.row.chapter, verse: r.row.verse, verseEnd: r.row.verse_end ?? null,
    version: r.row.version, updatedByBefore: r.row.updated_by ?? null, lock: r.lock ?? null,
    changes: r.changes.map((c) => ({
      path: c.path, strong: c.strong, kind: c.kind,
      ...Object.fromEntries(
        CHANGE_ATTRS.filter((k) => c[k]).map((k) => [k, { ...c[k], beforeEscaped: uEscape(c[k].before), afterEscaped: uEscape(c[k].after) }]),
      ),
    })),
  });
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dumpFiles,
        oldestDumpHours: Number(oldestDumpHours.toFixed(2)),
        repairUserId: REPAIR_USER_ID,
        repairAction: REPAIR_ACTION,
        repairSource: REPAIR_SOURCE,
        incident: INCIDENT,
        counts: {
          repairedVerses: repaired.length, repairedMilestones: wordCount(repaired),
          lockedVerses: lockedChanges.length, lockedMilestones: wordCount(lockedChanges),
          refused: refused.length, clean, noSource, excluded: excluded.length,
          skippedInvisible, declinedMilestones: declinedCount,
          repairedKinds: kindCounts(repaired), lockedKinds: kindCounts(lockedChanges),
        },
        visibleOnly,
        repaired: repaired.map(ser),
        locked: lockedChanges.map(ser),
        refused,
        declined: declined.map((d) => ({ ...d, items: d.items.map((it) => ({ ...it, contentEscaped: uEscape(it.content) })) })),
        excluded,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Report written → ${jsonPath}`);
}

process.exit(refused.length ? 2 : 0);

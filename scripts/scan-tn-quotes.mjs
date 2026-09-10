// Scan tn rows whose `quote` cannot be resolved against its UHB/UGNT source
// verse, and (with --repair) emit SQL that rewrites the recoverable ones into
// source order.
//
// WHY. Nothing validated this until #763, so 65 unresolvable quotes reached
// Door43 and stayed there: the nightly export renders whatever D1 holds, and
// unfoldingWord's occurrence checker only sees them after publication
// (`Occurrence 1 not found for "…"`). Two were traced to bible-editor exports —
// ZEC 10:3 was written correctly by the AI on 2026-07-02 and rewritten into
// English word order by the export of 2026-07-15; ZEC 9:13 was a 15-word quote
// on 2026-06-30 and truncated to `כִּֽ` by the export of 2026-07-03.
//
// The dominant defect is a quote built by walking the ULT's ENGLISH words
// left-to-right and emitting each one's aligned Hebrew, never re-sorted into
// source order and never de-duplicated. ZEC 8:1 ULT reads And(וַיְהִי)
// the-word(דְּבַר) of-Yahweh(יְהוָה) of-Armies(צְבָאוֹת) came(וַיְהִי), which
// reproduces the stored quote byte-for-byte, וַיְהִי and all.
//
// Matching and repair both come from resolveTnQuote in api/src/lint.ts — the
// SAME rules the in-app lint flags by, deliberately shared so a repair can
// never produce a row the lint still rejects.
//
// Workflow:
//   1. Dump rows to JSON (run from api/):
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT id,book,chapter,verse,ref_raw,quote,version FROM tn_rows
//                     WHERE deleted_at IS NULL AND trashed_at IS NULL" \
//          --json > ../scripts/out/tn-dump.json
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT book,chapter,verse,verse_end,bible_version,content_json FROM verses
//                     WHERE bible_version IN ('UHB','UGNT')" \
//          --json > ../scripts/out/src-dump.json
//      (local dev: bible_editor_dev --local)
//   2. Scan (report only):
//        node --experimental-strip-types --no-warnings \
//          scripts/scan-tn-quotes.mjs scripts/out/tn-dump.json scripts/out/src-dump.json
//   3. Emit repair SQL for the recoverable rows:
//        … same command … --repair
//      → scripts/out/repair-tn-quotes.sql   (apply with wrangler d1 execute --file=…)
//
// Optional: BOOK=ZEC to limit to one book, SCAN_PRINT_LIMIT=N to cap printed rows.
//
// NOT repaired, listed for a human instead: rows where a quote word is absent
// from the verse entirely (Ketiv/Qere mismatches, a quote carrying a trailing
// section marker `׃ס`, a stray backtick, an ellipsis used instead of `&`, a
// dropped accent, a truncated word). Guessing at those would be inventing text.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTnQuote, sourceWordsByRef, wordsForRow } from "../api/src/lint.ts";
import { PUBLISHED_BOOKS } from "../api/src/publishedGuard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2).filter((a) => a !== "--repair");
const doRepair = process.argv.includes("--repair");
const [tnPath, srcPath] = args;

if (!tnPath || !srcPath) {
  console.error("usage: node scripts/scan-tn-quotes.mjs <tn-dump.json> <src-dump.json> [--repair]");
  process.exit(1);
}

const bookFilter = process.env.BOOK ? process.env.BOOK.toUpperCase() : null;
const printLimit = Number(process.env.SCAN_PRINT_LIMIT ?? 40);

// wrangler --json emits either an array of result sets or a bare array.
function rowsOf(path) {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
  if (Array.isArray(raw) && raw.length && Array.isArray(raw[0]?.results)) return raw[0].results;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw)) return raw;
  throw new Error(`unrecognised dump shape: ${path}`);
}

const tnRows = rowsOf(tnPath).filter((r) => !bookFilter || r.book === bookFilter);
const srcRows = rowsOf(srcPath).filter((r) => !bookFilter || r.book === bookFilter);

// Source words per book, keyed "chapter:verse" — sourceWordsByRef is per-book,
// so bucket first or two books' verse 1:1 would collide.
const srcByBook = new Map();
for (const r of srcRows) {
  if (!srcByBook.has(r.book)) srcByBook.set(r.book, []);
  srcByBook.get(r.book).push(r);
}
const wordsByBook = new Map();
for (const [book, rows] of srcByBook) wordsByBook.set(book, sourceWordsByRef(rows));

// A LOCKED book is published; bible-editor is no longer its source of truth and
// must not write to it. Those findings go to an admin to apply on Door43 by
// hand (scripts/split-fixes-by-lock.mjs builds the worksheet). Mirrors
// effectiveBookLock: an explicit book_locks row wins either way, otherwise a
// published book is locked by default. With no locks dump we fail CLOSED and
// treat every published book as locked, because guessing the other way writes
// to a published book.
const lockRows = process.env.BOOK_LOCKS && existsSync(resolve(repoRoot, process.env.BOOK_LOCKS))
  ? rowsOf(process.env.BOOK_LOCKS)
  : [];
const explicitLock = new Map(lockRows.map((r) => [r.book, Number(r.locked) === 1]));
const isLocked = (book) => (explicitLock.has(book) ? explicitLock.get(book) : PUBLISHED_BOOKS.has(book));

const sqlEscape = (s) => s.replace(/'/g, "''");

// A `-- comment` line ends at the first newline, so a stored quote containing
// one would push the rest of itself out as a top-level statement in a file we
// hand to `wrangler d1 execute --file=`. Nothing in prod has a newline in a
// quote today (measured: 0 of 78,696), and the schema does not forbid one —
// the AI pipeline writes this column too. Flatten to one line before printing.
const sqlComment = (s) => String(s).replace(/[\r\n]+/g, " \u23ce ");

let checked = 0;
const failures = [];
for (const r of tnRows) {
  const quote = (r.quote ?? "").trim();
  if (!quote || quote === "*") continue;
  if (!/[֐-׿Ͱ-Ͽἀ-῿]/.test(quote)) continue;
  const byRef = wordsByBook.get(r.book);
  if (!byRef) continue;
  // ref_raw carries the range (e.g. "1:5-6"); the row stores only the start.
  const words = wordsForRow(byRef, r.chapter, r.verse, r.ref_raw);
  if (!words.length) continue;
  checked++;
  const verdict = resolveTnQuote(quote, words);
  if (verdict.ok) continue;
  failures.push({ row: r, verdict });
}

// Repair ONLY confident suggestions. An unconfident one had to re-use a source
// position already claimed by an earlier quote word, so de-duplicating it can
// delete a real word (see the 2KI 16:17 note on QuoteVerdict.confident).
const confident = failures.filter((f) => f.verdict.suggestion && f.verdict.confident);
const repairable = confident.filter((f) => !isLocked(f.row.book));
const lockedOut = confident.filter((f) => isLocked(f.row.book));
const manual = failures.filter((f) => !f.verdict.suggestion || !f.verdict.confident);

const byBook = new Map();
for (const f of failures) byBook.set(f.row.book, (byBook.get(f.row.book) ?? 0) + 1);

console.log(`checked ${checked} tn rows with a source verse`);
console.log(`unresolvable: ${failures.length}  (repairable ${repairable.length}, manual ${manual.length}` +
  (lockedOut.length ? `, ${lockedOut.length} withheld: locked book` : "") + ")");
console.log("\nby book:");
for (const [book, n] of [...byBook].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${book.padEnd(5)} ${n}`);
}

const byKind = new Map();
for (const f of failures) byKind.set(f.verdict.kind, (byKind.get(f.verdict.kind) ?? 0) + 1);
console.log("\nby kind:");
for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(10)} ${n}`);
}

console.log(`\n── repairable (showing up to ${printLimit}) ──`);
for (const f of repairable.slice(0, printLimit)) {
  console.log(`${f.row.book} ${f.row.chapter}:${f.row.verse} ${f.row.id} [${f.verdict.kind}]`);
  console.log(`   now: ${f.row.quote}`);
  console.log(`   fix: ${f.verdict.suggestion}`);
}

console.log(`\n── manual review needed (${manual.length}) ──`);
for (const f of manual) {
  const why = f.verdict.suggestion ? "ambiguous match — not auto-repaired" : f.verdict.detail;
  console.log(`${f.row.book} ${f.row.chapter}:${f.row.verse} ${f.row.id} [${f.verdict.kind}]  ${why}`);
  console.log(`   quote: ${f.row.quote}`);
  if (f.verdict.suggestion) console.log(`   proposed (REVIEW BY HAND): ${f.verdict.suggestion}`);
}

if (!doRepair) {
  console.log("\n(report only — pass --repair to emit SQL)");
  process.exit(0);
}

// Each UPDATE is keyed on (book, id) and guarded by the version seen in the
// dump. Both matter:
//
//   book — tn `id` is NOT globally unique. 2,696 ids repeat across books in
//   prod (up to 10 times): `tc6r` is ECC 3:15 AND EZK 34:10. A bare
//   `WHERE id = 'tc6r'` would have overwritten EZK 34:10's English note with
//   ECC 3:15's Hebrew quote. Only (book, id) is unique — 78,696 rows,
//   78,696 distinct pairs.
//
//   version — if a translator edited the row between the dump and the apply,
//   the guard makes the UPDATE a no-op instead of silently clobbering their
//   work. Compare the reported `changes` count against the statement count;
//   a shortfall means some rows moved on and want a fresh scan.
//
// version is bumped so optimistic-concurrency clients pick the change up on
// their next outbox round-trip, and updated_at moves so the nightly export
// treats the row as changed. Same discipline as refresh-verse.mjs.
const lines = [
  "-- Repair tn quotes that do not resolve against their source verse (#762).",
  "-- Generated by scripts/scan-tn-quotes.mjs — do not hand-edit.",
  `-- ${repairable.length} row(s); ${manual.length} left for manual review.`,
  "",
];
const unusable = repairable.filter((f) => !Number.isFinite(Number(f.row.version)));
if (unusable.length) {
  console.error(`
refusing to emit SQL: ${unusable.length} row(s) have no usable version — ` +
    "the dump must include the version column, or the optimistic-concurrency guard " +
    "would be written as the bare token NaN and fail mid-file after earlier UPDATEs committed.");
  for (const f of unusable) console.error(`  ${f.row.book} ${f.row.id}`);
  process.exit(1);
}

for (const f of repairable) {
  lines.push(
    `-- ${sqlComment(f.row.book)} ${f.row.chapter}:${f.row.verse} ${sqlComment(f.row.id)} [${f.verdict.kind}]`,
    `--   was: ${sqlComment(f.row.quote)}`,
    `UPDATE tn_rows SET quote = '${sqlEscape(f.verdict.suggestion)}', version = version + 1, updated_at = unixepoch()`,
    `  WHERE book = '${sqlEscape(f.row.book)}' AND id = '${sqlEscape(f.row.id)}' AND version = ${Number(f.row.version)} AND deleted_at IS NULL AND trashed_at IS NULL;`,
    // Audit row, same shape the app writes for a quote edit (a PARTIAL payload
    // of just the changed fields — see edit_log for kind='tn'). A direct SQL
    // repair would otherwise be the one kind of change with no history entry,
    // and the version-history dialog would show the quote changing from nowhere.
    //
    // action is 'update', NOT a bespoke verb: the history replay and the
    // reimport ancestor reconstruction only consume create / update / restore,
    // so a custom action would be silently skipped — an audit row that exists
    // but is invisible is worse than none.
    //
    // Gated on `changes()`, NOT on the row's version. Testing `version = old+1`
    // would also match a row that an ordinary concurrent edit had independently
    // advanced to that number, filing someone else's edit as a quote repair.
    // changes() reflects the immediately preceding UPDATE on this connection,
    // which is the same guard the app's write path uses.
    `INSERT INTO edit_log (kind, row_key, book, prev_version, new_version, action, payload_json)`,
    `  SELECT 'tn', id, book, version - 1, version, 'update', json_object('quote', quote)`,
    `    FROM tn_rows WHERE book = '${sqlEscape(f.row.book)}' AND id = '${sqlEscape(f.row.id)}' AND changes() > 0;`,
    "",
  );
}

const outDir = resolve(repoRoot, "scripts/out");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "repair-tn-quotes.sql");
writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(`\nwrote ${outFile} (${repairable.length} UPDATE statement(s))`);

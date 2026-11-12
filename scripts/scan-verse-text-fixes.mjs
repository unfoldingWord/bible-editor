// Fix the two mechanical verse-text lint flags in stored verses (#1274):
//   - "Straight quote": curled exactly as an in-app save curls them
//     (curlifyVerseContent, web/src/lib/curlyVerse.ts, #1273).
//   - "Doubled space": a run of 2+ spaces inside one text node collapses to
//     one space. A run right after a newline is indentation and is left alone,
//     as the lint leaves it alone (doubledSpaceProblems in api/src/lint.ts).
// The rest of the lint feed needs a person and is out of scope.
//
// Same workflow and guards as scripts/scan-opening-punct.mjs, plus an
// apply-time lock guard (from scripts/repair-canonize-alignment.mjs) and a
// rollback file.
//
// Workflow (from repo root):
//   1. Dump the verses of the books to fix, one JSON file per book/version, and
//      the lock table:
//        node scripts/d1-select.mjs --out scripts/out/JER-ULT.json \
//          "SELECT * FROM verses WHERE book = 'JER' AND bible_version = 'ULT'"
//        node scripts/d1-select.mjs --out scripts/out/book-locks.json \
//          "SELECT book, locked FROM book_locks"
//   2. Report:
//        node --experimental-strip-types --no-warnings scripts/scan-verse-text-fixes.mjs scripts/out/JER-*.json
//   3. Emit SQL:
//        BOOK_LOCKS=scripts/out/book-locks.json REPAIR_ACTOR=<users.id> \
//          node --experimental-strip-types --no-warnings scripts/scan-verse-text-fixes.mjs <dumps…> --repair
//      → scripts/out/repair-verse-text-fixes.sql    (apply: wrangler d1 execute bible_editor --remote --env production --file=…)
//      → scripts/out/rollback-verse-text-fixes-<time>.sql  (undo, guarded on the repaired version and content;
//        named per run and never deleted, so it keeps the before-image)
//
// A verse is repaired only when the real lint (lintVerseTextQuality) shows
// fewer straight-quote or doubled-space flags afterwards and no other check
// rises, and only when the change touched nothing but text: same nodes, same
// tags, same milestones, same word occurrences. Anything else is reported as
// withheld for a person to look at.
//
// Each UPDATE is guarded on the dumped `version` (a verse edited since the dump
// is skipped; a short `changes` count means re-dump and re-run) and on the lock
// state at apply time. REPAIR_ACTOR goes into updated_by because the nightly
// DCS→D1 sync treats updated_by IS NULL as "master owns this row"
// (reimportClassify.ts isReimportableRow) and would revert the fix. The
// edit_log row carries source 'data_repair', as repair-canonize-alignment.mjs
// does, so a Door43 change made after our export still wins the nightly
// merge: export promptly after applying. A locked
// book is never written: --repair refuses without the BOOK_LOCKS dump, and
// withheld locked-book verses are printed so they can be fixed on Door43.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { curlifyVerseContent } from "../web/src/lib/curlyVerse.ts";
import { lintVerseTextQuality, PROSE_EXCLUDED_TAGS } from "../api/src/lint.ts";
import { PUBLISHED_BOOKS } from "../api/src/publishedGuard.ts";
import { extractPlainText } from "../api/src/importParsers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const doRepair = args.includes("--repair");
const dumpPaths = args.filter((a) => !a.startsWith("--"));
if (dumpPaths.length === 0) {
  console.error("usage: node scripts/scan-verse-text-fixes.mjs <verses-dump.json>… [--repair]");
  process.exit(1);
}

// wrangler / d1-select --json wraps results as [{ results: [...] }].
function loadRows(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw) && raw[0]?.results) return raw.flatMap((r) => r.results ?? []);
  if (Array.isArray(raw)) return raw;
  if (raw?.results) return raw.results;
  throw new Error(`unrecognized dump shape: ${path}`);
}

const rows = dumpPaths.flatMap((p) => loadRows(resolve(p)));

// The SQL guards and the rollback need these columns; a narrower SELECT would
// silently roll a verse back to NULLs. Dump with SELECT *.
const NEEDED = ["book", "chapter", "verse", "bible_version", "content_json", "plain_text", "version", "updated_by",
  "last_change_action", "last_change_source", "last_change_actor"];
const missing = NEEDED.filter((c) => rows.length && !(c in rows[0]));
if (missing.length) {
  console.error(`dump is missing column(s) ${missing.join(", ")} — dump with SELECT * FROM verses`);
  process.exit(1);
}
// Two dumps of the same book/version (an old and a fresh one) would give one
// verse two conflicting UPDATEs.
const seen = new Set();
for (const r of rows) {
  const k = `${r.book}/${r.bible_version}/${r.chapter}/${r.verse}`;
  if (seen.has(k)) {
    console.error(`verse ${k} appears in more than one dump — pass each book/version once`);
    process.exit(1);
  }
  seen.add(k);
}

// Lock rule, mirroring effectiveBookLock: an explicit book_locks row wins,
// otherwise a published book is locked.
const locksArg = process.env.BOOK_LOCKS ?? "";
let lockRows = null;
if (locksArg && existsSync(resolve(locksArg))) {
  lockRows = loadRows(resolve(locksArg));
  if (lockRows.some((r) => typeof r.book !== "string" || !("locked" in r))) {
    console.error(`BOOK_LOCKS ${locksArg} is not a book_locks dump (need book, locked columns)`);
    process.exit(1);
  }
}
if (!lockRows) {
  if (doRepair) {
    console.error("refusing to emit SQL: BOOK_LOCKS is unset or unreadable (see the header).");
    process.exit(1);
  }
  console.warn("BOOK_LOCKS unset or unreadable — treating only PUBLISHED_BOOKS as locked; --repair would refuse.");
}
const explicitLock = new Map((lockRows ?? []).map((r) => [r.book, Number(r.locked) === 1]));
const isLocked = (book) => (explicitLock.has(book) ? explicitLock.get(book) : PUBLISHED_BOOKS.has(book));

const TARGET_VERSIONS = new Set(["ULT", "UST", "GLT", "GST"]);
const FIXED_CHECKS = ["Straight quote", "Doubled space"];
// Collapse exactly the runs the lint flags. Walks the tree in the same order
// and with the same context as flattenVerseProse (api/src/lint.ts): footnotes
// and other excluded tags are skipped, a paragraph or quote marker starts a new
// line, and a run is collapsed only when the character before it is visible
// text. That leaves alone line-leading indentation and a node's leading spaces
// after a space in the previous node (the lint folds that to one space).
function collapseDoubledSpaces(nodes) {
  let prev = ""; // last character of the prose so far
  const walk = (list) => {
    for (const n of list ?? []) {
      if (!n || typeof n !== "object") continue;
      if (PROSE_EXCLUDED_TAGS.has(n.tag)) continue;
      if (n.type === "paragraph" || n.type === "section") prev = "\u2029";
      else if (n.type === "quote") prev = "\n";
      if (typeof n.text === "string" && n.text) {
        if (n.type === "text") {
          n.text = n.text.replace(/ {2,}/g, (run, at, s) => {
            const before = at > 0 ? s[at - 1] : prev;
            return before && /\S/.test(before) ? " " : run;
          });
        }
        prev = n.text[n.text.length - 1];
      }
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(nodes);
}

// The tree with every text value blanked out and quote marks in word text
// folded together. Equal before and after means the change touched only text.
function shape(nodes) {
  return JSON.stringify(nodes, (key, value) => {
    if (key !== "text" || typeof value !== "string") return value;
    return value.replace(/[‘’']/g, "'").replace(/[“”"]/g, '"').replace(/ +/g, " ");
  });
}

function countByCheck(row) {
  const m = new Map();
  for (const i of lintVerseTextQuality([row])) m.set(i.check, (m.get(i.check) ?? 0) + 1);
  return m;
}

const fixes = []; // verses to repair
const notFixed = []; // flagged verses the transform could not safely fix
for (const r of rows) {
  if (!TARGET_VERSIONS.has(r.bible_version) || r.verse === 0) continue;
  const before = countByCheck(r);
  if (!FIXED_CHECKS.some((c) => before.has(c))) continue;
  const ref = `${r.book} ${r.bible_version} ${r.chapter}:${r.verse}`;

  const content = JSON.parse(r.content_json);
  let next = curlifyVerseContent(content);
  if (next === content) next = structuredClone(content);
  collapseDoubledSpaces(next.verseObjects);
  const newContent = JSON.stringify(next);
  const after = countByCheck({ ...r, content_json: newContent });

  const fixedBefore = FIXED_CHECKS.reduce((s, c) => s + (before.get(c) ?? 0), 0);
  const fixedAfter = FIXED_CHECKS.reduce((s, c) => s + (after.get(c) ?? 0), 0);
  const rose = [...after].filter(([c, n]) => !FIXED_CHECKS.includes(c) && n > (before.get(c) ?? 0)).map(([c]) => c);
  let reason = null;
  if (shape(next.verseObjects) !== shape(content.verseObjects)) reason = "change was not text-only";
  else if (rose.length) reason = `would raise: ${rose.join(", ")}`;
  else if (fixedAfter >= fixedBefore) reason = "no flag cleared";
  if (reason) {
    notFixed.push({ ref, reason });
    continue;
  }
  fixes.push({
    ref,
    book: r.book,
    chapter: r.chapter,
    verse: r.verse,
    version: r.bible_version,
    rowVersion: r.version,
    cleared: FIXED_CHECKS.map((c) => `${c} ${before.get(c) ?? 0}→${after.get(c) ?? 0}`).filter((s) => !/ 0→0$/.test(s)),
    residual: fixedAfter,
    oldContent: r.content_json,
    oldPlainText: r.plain_text,
    oldUpdatedBy: r.updated_by ?? null,
    oldLastChange: [r.last_change_action, r.last_change_source, r.last_change_actor],
    newContent,
    newPlainText: extractPlainText(next),
  });
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log(`\nScanned ${rows.length} verse rows from ${dumpPaths.length} dump(s).`);
console.log(`\n${fixes.length} verse(s) fixable:`);
for (const f of fixes) {
  const lock = isLocked(f.book) ? "  [LOCKED — withheld]" : "";
  console.log(`  ${f.ref}  ${f.cleared.join(", ")}${f.residual ? `  (${f.residual} left for a person)` : ""}${lock}`);
}
if (notFixed.length) {
  console.log(`\n${notFixed.length} flagged verse(s) not fixed, for a person:`);
  for (const n of notFixed) console.log(`  ${n.ref}  ${n.reason}`);
}

// ─── Repair ──────────────────────────────────────────────────────────────────
const withheld = fixes.filter((f) => isLocked(f.book));
const repairable = fixes.filter((f) => !isLocked(f.book));
if (withheld.length) {
  const byBook = new Map();
  for (const f of withheld) byBook.set(f.book, (byBook.get(f.book) ?? 0) + 1);
  console.log(`\nWithheld ${withheld.length} verse(s) in LOCKED books (fix on Door43): ` +
    [...byBook].map(([b, n]) => `${b} ${n}`).join(", "));
}

const actor = Number(process.env.REPAIR_ACTOR);
if (doRepair && repairable.length > 0) {
  if (!(Number.isInteger(actor) && actor > 0)) {
    console.error("refusing to emit SQL: REPAIR_ACTOR must be a users.id (e.g. REPAIR_ACTOR=2) — see header");
    process.exit(1);
  }
  const unversioned = repairable.filter((f) => !(Number.isInteger(f.rowVersion) && f.rowVersion >= 1));
  if (unversioned.length) {
    console.error(`refusing to emit SQL: ${unversioned.length} verse(s) have no usable version — the dump must include the version column.`);
    process.exit(1);
  }
}

const outDir = resolve(repoRoot, "scripts/out");
const outPath = resolve(outDir, "repair-verse-text-fixes.sql");
// The rollback file is named by run time and never removed, so a later run
// cannot overwrite the before-image of verses an earlier run already repaired.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const rollbackPath = resolve(outDir, `rollback-verse-text-fixes-${stamp}.sql`);
// Remove an earlier run's repair SQL, so a run that writes nothing cannot leave
// a stale file holding UPDATEs this run would now withhold.
if (doRepair) {
  if (existsSync(outPath)) {
    unlinkSync(outPath);
    console.log(`removed stale ${outPath}`);
  }
  if (repairable.length === 0) console.log("\nNothing to repair in unlocked books — no SQL written.");
}

if (doRepair && repairable.length > 0) {
  const q = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const where = (f) =>
    `book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)}`;
  // Apply-time lock guard (repair-canonize-alignment.mjs): an unpublished book
  // is writable unless a locked=1 row exists; a published book only while its
  // explicit locked=0 row exists.
  const lockGuard = (f) =>
    PUBLISHED_BOOKS.has(f.book)
      ? `EXISTS (SELECT 1 FROM book_locks WHERE book = ${q(f.book)} AND locked = 0)`
      : `NOT EXISTS (SELECT 1 FROM book_locks WHERE book = ${q(f.book)} AND locked = 1)`;
  // Audit and provenance follow repair-canonize-alignment.mjs: edit_log action
  // 'update' with source 'data_repair' and a { content, plain_text } payload
  // (the reimport's three-way merge uses it as the ancestor), written only when
  // the UPDATE changed a row; the row's last_change_* say a system repair did it.
  const statements = (f, from, to) => {
    const key = `${f.book}/${f.chapter}/${f.verse}/${f.version}`;
    const payload = JSON.stringify({ content: JSON.parse(to.content), plain_text: to.plainText });
    const [action, source, who] = to.lastChange;
    return [
      `UPDATE verses SET content_json = ${q(to.content)}, plain_text = ${q(to.plainText)}, version = version + 1, updated_at = unixepoch(), updated_by = ${q(to.updatedBy)},` +
        ` last_change_action = ${q(action)}, last_change_source = ${q(source)}, last_change_actor = ${q(who)}`,
      ` WHERE ${where(f)} AND version = ${from.version} AND content_json = ${q(from.content)} AND ${lockGuard(f)};`,
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)`,
      `  SELECT 'verse', ${q(key)}, ${q(f.book)}, ${actor}, version - 1, version, 'update', ${q(payload)}, 'data_repair'`,
      `    FROM verses WHERE ${where(f)} AND changes() > 0;`,
    ];
  };
  const header = (what) => [
    `-- ${what} Generated ${new Date().toISOString()} by scripts/scan-verse-text-fixes.mjs (#1274).`,
    `-- ${repairable.length} verse(s): ${repairable.map((f) => f.ref).join("; ")}`,
    `-- Each UPDATE is guarded on version, content and lock state; compare the reported changes count with ${repairable.length * 2} (UPDATE + edit_log per verse).`,
    `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
  ];
  const repair = header("Curl straight quotes and collapse doubled spaces in verse text.");
  const rollback = header("ROLLBACK of repair-verse-text-fixes.sql: restores each verse's previous text, updated_by and last_change_*.");
  for (const f of repairable) {
    repair.push(...statements(
      f,
      { version: f.rowVersion, content: f.oldContent },
      { content: f.newContent, plainText: f.newPlainText, updatedBy: actor, lastChange: ["update", "system", "scan-verse-text-fixes (#1274)"] },
    ));
    rollback.push(...statements(
      f,
      { version: f.rowVersion + 1, content: f.newContent },
      { content: f.oldContent, plainText: f.oldPlainText, updatedBy: f.oldUpdatedBy, lastChange: f.oldLastChange },
    ));
  }
  // D1 rejects a statement over ~100 KB; refuse rather than half-apply.
  const MAX_STATEMENT_BYTES = 90_000;
  const tooBig = [repair, rollback].flatMap((ls) => ls.filter((l) => !l.startsWith("--")).join("\n").split(";\n"))
    .filter((st) => Buffer.byteLength(st, "utf8") > MAX_STATEMENT_BYTES);
  if (tooBig.length) {
    console.error(`refusing to emit SQL: ${tooBig.length} statement(s) exceed ${MAX_STATEMENT_BYTES} bytes`);
    process.exit(1);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, repair.join("\n") + "\n", "utf8");
  writeFileSync(rollbackPath, rollback.join("\n") + "\n", "utf8");
  console.log(`\nWrote repair SQL for ${repairable.length} verse(s): ${outPath}`);
  console.log(`Wrote rollback SQL: ${rollbackPath}`);
}

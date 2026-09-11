// Scan stored ULT/UST verses for an opening quote/bracket parked in the TRAILING
// TEXT of a `\zaln` alignment milestone that is immediately followed by another
// one, and (with --repair) emit SQL that hoists it out to a top-level text node.
//
// WHY. usfm-js emits a newline between two adjacent top-level milestones and
// nowhere else, so `\w say\w*, ‘\zaln-e\*` + `\zaln-s` serializes as
//
//   \w say|…\w*, ‘\zaln-e\*
//   \zaln-s |…\*\w The|…\w* …
//
// and Door43's renderer turns that newline into a SPACE: readers see
// `say, ‘ The one…` (en_ult JER 31:10 and 31:18 on master). The AI pipeline
// wrote the opener correctly — as the leading text child of the FOLLOWING
// milestone — and bible-editor exports of 2026-06-28 / 2026-06-30 moved it,
// because every relayout tier in web/src/lib/replace.ts treats an inter-word
// gap as one atom and writes the whole `, ‘` into the preceding milestone.
// Issue #777.
//
// The engine no longer produces the shape (hoistOpeningPunctuation now runs at
// the end of smartEditVerse, and on the AI pipeline's write path), and the lint
// flags it — this script is the DATA fix for rows already written that way.
// Detection AND repair both come from api/src/openingPunct.ts, the SAME module
// the lint and the pipeline use, deliberately shared so a repair can never
// produce a row the lint still rejects.
//
// The rewrite is RAW-TEXT PRESERVING: the same characters in the same order,
// owned by a different node. No `\w` moves, so no word can unalign, and
// plain_text cannot change — which is why the UPDATE below touches only
// content_json. hoistOpeningPunctuation self-checks that invariant and returns
// the tree untouched if it ever failed to hold.
//
// Workflow:
//   1. Dump verses to JSON (run from api/):
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT book,chapter,verse,bible_version,content_json,version FROM verses
//                     WHERE bible_version IN ('ULT','UST','GLT','GST')" \
//          --json > ../scripts/out/verses-dump.json
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT book, locked FROM book_locks" --json > ../scripts/out/book-locks.json
//      (local dev: bible_editor_dev --local)
//   2. Scan (report only):
//        BOOK_LOCKS=scripts/out/book-locks.json node --experimental-strip-types --no-warnings \
//          scripts/scan-opening-punct.mjs scripts/out/verses-dump.json
//   3. Emit repair SQL for the flagged verses:
//        REPAIR_ACTOR=<users.id> … same command … --repair
//      → scripts/out/repair-opening-punct.sql   (apply with wrangler d1 execute --file=…)
//      → scripts/out/repair-opening-punct.json  (what each verse held BEFORE — the rollback reads this)
//
// --repair REFUSES to run without both BOOK_LOCKS (the real book_locks dump —
// see the lock rule below) and REPAIR_ACTOR (the users.id the repair is
// attributed to). REPAIR_ACTOR matters for more than attribution: the nightly
// DCS→D1 sync treats updated_by IS NULL as "pristine, master owns this row"
// (reimportClassify.ts isReimportableRow), so a repair that left it NULL would
// be silently reverted from master the next night the USFM changed upstream —
// before the export could ever push the fix.
//
// Optional: BOOK=JER to limit to one book, SCAN_PRINT_LIMIT=N to cap printed rows.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findOpeningPunctInAlignment, hoistOpeningPunctuation } from "../api/src/openingPunct.ts";
import { PUBLISHED_BOOKS } from "../api/src/publishedGuard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const dumpPath = process.argv[2];
const doRepair = process.argv.includes("--repair");
const onlyBook = (process.env.BOOK ?? "").toUpperCase() || null;
if (!dumpPath || dumpPath === "--repair") {
  console.error("usage: node scripts/scan-opening-punct.mjs <verses-dump.json> [--repair]");
  process.exit(1);
}

// wrangler --json wraps results as [{ results: [...] }] (or sometimes a bare
// array). Normalize to the row array.
function loadRows(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw) && raw[0]?.results) return raw.flatMap((r) => r.results ?? []);
  if (Array.isArray(raw)) return raw;
  if (raw?.results) return raw.results;
  throw new Error("unrecognized dump shape");
}

const rows = loadRows(resolve(dumpPath));

// Lock rule — a LOCKED book is published, bible-editor is no longer its source
// of truth, and --repair must never write to one. Report mode runs on the
// published-book fallback with a warning; --repair refuses without the real
// dump, because the fallback cannot see an admin's explicit lock on an
// unpublished book. Mirrors effectiveBookLock (explicit row wins, else a
// published book is locked).
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
    console.error(
      "refusing to emit SQL: BOOK_LOCKS is unset or unreadable. --repair needs the real book_locks dump " +
        "(see the header) so a locked book is never written to.",
    );
    process.exit(1);
  }
  console.warn("BOOK_LOCKS unset or unreadable — treating only PUBLISHED_BOOKS as locked; --repair would refuse.");
}
const explicitLock = new Map((lockRows ?? []).map((r) => [r.book, Number(r.locked) === 1]));
const isLocked = (book) => (explicitLock.has(book) ? explicitLock.get(book) : PUBLISHED_BOOKS.has(book));

const TARGET_VERSIONS = new Set(["ULT", "UST", "GLT", "GST"]);
const flagged = []; // { book, chapter, verse, version, rowVersion, findings, newContent }
const stats = new Map(); // `${book}/${version}` -> { verses, flagged }

for (const r of rows) {
  if (!TARGET_VERSIONS.has(r.bible_version)) continue;
  if (onlyBook && r.book !== onlyBook) continue;
  let content;
  try {
    content = JSON.parse(r.content_json);
  } catch {
    continue;
  }
  const vo = content?.verseObjects;
  if (!Array.isArray(vo)) continue;

  const statKey = `${r.book}/${r.bible_version}`;
  const st = stats.get(statKey) ?? { verses: 0, flagged: 0 };
  st.verses++;
  stats.set(statKey, st);

  const findings = findOpeningPunctInAlignment(vo);
  if (findings.length === 0) continue;
  const hoisted = hoistOpeningPunctuation(vo);
  // hoistOpeningPunctuation returns the SAME array when it declined to act (its
  // raw-text self-check failed). That is a verse for a human, not a repair.
  if (hoisted === vo) {
    console.warn(`  ! ${r.book} ${r.chapter}:${r.verse} ${r.bible_version} — detected but the hoist declined; skipping`);
    continue;
  }
  const newContent = JSON.stringify({ ...content, verseObjects: hoisted });
  if (newContent === r.content_json) continue; // no-op write; nothing to do
  st.flagged++;
  flagged.push({
    book: r.book,
    chapter: r.chapter,
    verse: r.verse,
    version: r.bible_version,
    rowVersion: r.version,
    findings,
    oldContent: r.content_json,
    newContent,
  });
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log(`\nScanned ${rows.length} verse rows${onlyBook ? ` (book=${onlyBook})` : ""}.\n`);
console.log("Per book/version (target verses · verses flagged):");
for (const [k, s] of [...stats.entries()].sort()) {
  const mark = s.flagged > 0 ? "  ⚠" : "";
  console.log(`  ${k.padEnd(14)} ${String(s.verses).padStart(5)} · ${String(s.flagged).padStart(4)}${mark}`);
}
console.log(`\nFlagged ${flagged.length} verse(s) with opening punctuation inside an alignment milestone:`);
const PRINT_LIMIT = parseInt(process.env.SCAN_PRINT_LIMIT ?? "60", 10);
for (const f of flagged.slice(0, PRINT_LIMIT)) {
  const summary = f.findings.map((x) => `#${x.index} ${JSON.stringify(x.text)}`).join(", ");
  console.log(`  ${f.book} ${f.chapter}:${f.verse} ${f.version}  ${summary}`);
}
if (flagged.length > PRINT_LIMIT) console.log(`  … and ${flagged.length - PRINT_LIMIT} more.`);

// ─── Repair ──────────────────────────────────────────────────────────────────
const withheld = flagged.filter((f) => isLocked(f.book));
const repairable = flagged.filter((f) => !isLocked(f.book));
if (withheld.length) {
  const byBook = new Map();
  for (const f of withheld) byBook.set(f.book, (byBook.get(f.book) ?? 0) + 1);
  console.log(
    `\nWithheld ${withheld.length} verse(s) in LOCKED books (fix on Door43 by hand): ` +
      [...byBook].map(([b, n]) => `${b} ${n}`).join(", "),
  );
}

if (!doRepair) {
  console.log("\n(report only — pass --repair to emit SQL)");
  process.exit(0);
}

// Any earlier run's output is removed FIRST, whether or not this run writes a
// new one. Otherwise a run whose every finding was withheld (all in locked
// books) would leave a stale file behind that still carries those locked-book
// UPDATEs — and an operator applying "the output" would write exactly what the
// lock rule exists to prevent. (Same rule as scan-source-occurrences.mjs.)
const outDir = resolve(repoRoot, "scripts/out");
const outPath = resolve(outDir, "repair-opening-punct.sql");
const sidecarPath = resolve(outDir, "repair-opening-punct.json");
for (const p of [outPath, sidecarPath]) {
  if (existsSync(p)) {
    unlinkSync(p);
    console.log(`removed stale ${p}`);
  }
}

// Who the repair is attributed to (users.id). See the header for why this is
// required rather than optional.
const actor = Number(process.env.REPAIR_ACTOR);
if (!(Number.isInteger(actor) && actor > 0)) {
  console.error("refusing to emit SQL: REPAIR_ACTOR must be a users.id (e.g. REPAIR_ACTOR=2) — see header");
  process.exit(1);
}

// Checked on the RAW value: Number(null) is 0, which is finite and would have
// written a silent no-op guard of "version = 0" for a row the dump mis-joined.
const unversioned = repairable.filter((f) => !(Number.isInteger(f.rowVersion) && f.rowVersion >= 1));
if (unversioned.length) {
  console.error(
    `refusing to emit SQL: ${unversioned.length} flagged verse(s) have no usable version — the dump must ` +
      "include the version column, or the optimistic-concurrency guard cannot be written.",
  );
  for (const f of unversioned) console.error(`  ${f.book} ${f.chapter}:${f.verse} ${f.version}`);
  process.exit(1);
}

if (repairable.length === 0) {
  console.log("\nNothing to repair in unlocked books — no SQL written.");
  process.exit(0);
}

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const generatedAt = new Date().toISOString();
const now = Math.floor(Date.now() / 1000);
const lines = [
  `-- Hoist opening punctuation out of alignment milestones (#777). Generated ${generatedAt}`,
  `-- ${repairable.length} verse(s) in unlocked books (${withheld.length} withheld in locked books).`,
  `-- Raw-text preserving: only which node owns the characters changes, so plain_text is NOT rewritten.`,
  `-- Bumps version (stale-client refetch), stamps provenance (migration 0060), and logs an edit_log row.`,
  `-- Each UPDATE is guarded on the dumped version; compare the reported changes count with ${repairable.length}.`,
  `-- The rollback sidecar carries the same run stamp; they must match.`,
  `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
];
for (const f of repairable) {
  const key = `${f.book}/${f.chapter}/${f.verse}/${f.version}`;
  // Audit row in the same shape the app writes for a verse PATCH (verses.ts):
  // action 'update' — history replay consumes only create / update / restore, so
  // a bespoke verb would be an invisible audit row — a payload of { content }
  // like parsed.data, and gated on changes() so a skipped UPDATE (version moved
  // on) leaves no orphan history entry.
  const payload = JSON.stringify({ content: JSON.parse(f.newContent) });
  lines.push(
    `-- ${f.book} ${f.chapter}:${f.verse} ${f.version}: ` +
      f.findings.map((x) => `#${x.index} ${JSON.stringify(x.text)}`).join(", "),
    // last_change_* are migration 0060's vocabulary (api/src/rowProvenance.ts):
    // 'update' is WHAT, 'system' is WHERE (an unattended maintenance pass, not
    // a person and not the AI pipeline), and last_change_actor names the script
    // — DENORMALIZED ON PURPOSE, so the answer survives a user being renamed.
    // updated_by still carries REPAIR_ACTOR because the pristine predicate
    // (updated_by IS NULL) is what the nightly sync reads; these three are
    // additive and change nothing about that.
    `UPDATE verses SET content_json = ${q(f.newContent)}, version = version + 1, updated_at = ${now}, updated_by = ${actor},`,
    `       last_change_action = 'update', last_change_source = 'system', last_change_actor = 'scan-opening-punct'`,
    ` WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)} AND version = ${Number(f.rowVersion)};`,
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)`,
    `  SELECT 'verse', ${q(key)}, ${q(f.book)}, ${actor}, version - 1, version, 'update', ${q(payload)}`,
    `    FROM verses WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)} AND changes() > 0;`,
  );
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
// Sidecar: the exact pre-repair bytes and the exact content the repair writes,
// so a rollback can prove the row still holds OUR value before touching it (a
// version number alone cannot). The shared run stamp lets a rollback (and the
// operator) notice a BOOK-filtered re-run having overwritten an earlier,
// broader one instead of silently generating no-op UPDATEs.
writeFileSync(
  sidecarPath,
  JSON.stringify(
    {
      generatedAt,
      book: onlyBook,
      rows: repairable.map((f) => ({
        book: f.book,
        chapter: f.chapter,
        verse: f.verse,
        bibleVersion: f.version,
        oldVersion: f.rowVersion,
        oldContent: f.oldContent,
        newContent: f.newContent,
      })),
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`\nWrote repair SQL for ${repairable.length} verse(s): ${outPath}`);
console.log(`Rollback sidecar: ${sidecarPath}`);

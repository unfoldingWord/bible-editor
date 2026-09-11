// Scan stored verses for `\zaln` alignment milestones with an opening
// quote/bracket stranded in their trailing text (after the last `\w`) —
// the defect this PR's engine fix hoists away on the next in-app save (see
// web/src/lib/openingPunct.ts). This script is the DATA fix for rows
// already on disk: it rewrites content_json so the nightly DCS export is
// clean without waiting for a translator to touch every affected verse.
// Modeled closely on scripts/scan-source-occurrences.mjs — same workflow,
// same guards.
//
// Workflow:
//   1. Dump verses to JSON (run from api/):
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT book,chapter,verse,bible_version,content_json,version FROM verses" \
//          --json > ../scripts/out/verses-dump.json
//      (local dev: bible_editor_dev --local)
//   2. Scan (report only):
//        node --experimental-strip-types --no-warnings scripts/scan-opening-punct.mjs scripts/out/verses-dump.json
//   3. Emit repair SQL for flagged verses:
//        REPAIR_ACTOR=<users.id> node --experimental-strip-types --no-warnings \
//          scripts/scan-opening-punct.mjs scripts/out/verses-dump.json --repair
//      → scripts/out/repair-opening-punct.sql   (apply with wrangler d1 execute --file=…)
//
// Each UPDATE is guarded on the `version` the dump saw, so a verse a translator
// edited between dump and apply is left alone (a shortfall in the reported
// `changes` count means "re-dump and re-scan", never "clobbered"). The dump
// MUST include the version column. --repair also needs REPAIR_ACTOR: the
// nightly DCS→D1 sync treats updated_by IS NULL as "pristine, master owns
// this row" (reimportClassify.ts isReimportableRow), so a repair that left it
// NULL would be reverted from master the next night the USFM changed upstream,
// before the export ever pushed the fix.
//
// A LOCKED book is published and bible-editor is no longer its source of truth,
// so --repair never emits SQL for one. It needs BOOK_LOCKS=<book_locks dump>
// (`SELECT book, locked FROM book_locks` as --json) and refuses without it;
// the rule mirrors effectiveBookLock (explicit row wins, else a published book
// is locked). Withheld verses are printed so an admin can fix them on Door43.
//
// Optional: limit to one book with BOOK=JER, and printed-row count with
// SCAN_PRINT_LIMIT=N.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hoistOpeningPunctuation } from "../web/src/lib/openingPunct.ts";
import { PUBLISHED_BOOKS } from "../api/src/publishedGuard.ts";
import { extractPlainText } from "../api/src/importParsers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const dumpPath = process.argv[2];
const doRepair = process.argv.includes("--repair");
const onlyBook = (process.env.BOOK ?? "").toUpperCase() || null;
if (!dumpPath) {
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

const rows = loadRows(dumpPath);

// Lock rule — see header. Report mode runs on the published-book fallback with
// a warning; --repair refuses without the real dump, because the fallback
// cannot see an admin's explicit lock on an unpublished book.
const locksArg = process.env.BOOK_LOCKS ?? "";
let lockRows = null;
// Resolved against cwd, like the dump path — the two must not disagree.
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
const flagged = []; // { book, chapter, verse, version, rowVersion, before, after, newContent }
const stats = new Map(); // `${book}/${version}` -> { verses, corrected }

// Trailing text (after the last \w) of a top-level zaln milestone's subtree,
// for the report's before/after gap-text summary. Mirrors the logic in
// web/src/lib/openingPunct.ts (duplicated for reporting only — the actual
// fix comes from hoistOpeningPunctuation itself).
function trailingGapsWithOpener(nodes) {
  const OPENING_PUNCT_RE = /[“‘(\[{]/u;
  const gaps = [];
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "milestone" && n.tag === "zaln" && Array.isArray(n.children)) {
      const flat = [];
      const flatten = (kids) => {
        for (const k of kids) {
          if (!k || typeof k !== "object") continue;
          if (k.type === "word" && k.tag === "w") flat.push({ kind: "word" });
          else if (k.type === "text") flat.push({ kind: "text", text: k.text ?? "" });
          else if (Array.isArray(k.children)) flatten(k.children);
        }
      };
      flatten(n.children);
      let lastWord = -1;
      flat.forEach((s, i) => { if (s.kind === "word") lastWord = i; });
      const trailing = flat.slice(lastWord + 1).filter((s) => s.kind === "text").map((s) => s.text).join("");
      if (OPENING_PUNCT_RE.test(trailing)) gaps.push(trailing);
      // Nested chains: an opener stranded in an INNER milestone that is
      // followed by another inner milestone is invisible from this level
      // (the later inner word masks it) — mirror hoistOpeningPunctuation /
      // hasOpeningPunctInsideMilestone and look inside.
      gaps.push(...trailingGapsWithOpener(n.children));
    }
  }
  return gaps;
}

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
  const st = stats.get(statKey) ?? { verses: 0, corrected: 0 };
  st.verses++;

  const before = trailingGapsWithOpener(vo);
  if (before.length > 0) {
    const hoisted = hoistOpeningPunctuation(vo);
    const newContentObj = { ...content, verseObjects: hoisted };
    const newContent = JSON.stringify(newContentObj);
    // Guard: only report a real byte-level change.
    if (newContent !== r.content_json) {
      st.corrected++;
      flagged.push({
        book: r.book,
        chapter: r.chapter,
        verse: r.verse,
        version: r.bible_version,
        rowVersion: r.version,
        before,
        newContent,
        // Re-derived from the hoisted content the same way applyVerseUpdate
        // (api/src/pipelineImport.ts) re-derives plain_text after a mutation
        // pass — the hoist can shift where whitespace sits (see F2 in
        // web/src/lib/openingPunct.ts), so the stored plain_text must be
        // recomputed rather than left pointing at the pre-repair text.
        newPlainText: extractPlainText(newContentObj),
      });
    }
  }
  stats.set(statKey, st);
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log(`\nScanned ${rows.length} verse rows${onlyBook ? ` (book=${onlyBook})` : ""}.\n`);
console.log("Per book/version (target verses · verses corrected):");
for (const [k, s] of [...stats.entries()].sort()) {
  const mark = s.corrected > 0 ? "  ⚠" : "";
  console.log(`  ${k.padEnd(14)} ${String(s.verses).padStart(5)} · ${String(s.corrected).padStart(4)}${mark}`);
}
console.log(`\nFlagged ${flagged.length} verse(s) with an opening quote/bracket stranded inside an alignment milestone:`);
const PRINT_LIMIT = parseInt(process.env.SCAN_PRINT_LIMIT ?? "60", 10);
for (const f of flagged.slice(0, PRINT_LIMIT)) {
  console.log(`  ${f.book} ${f.chapter}:${f.verse} ${f.version}  gap(s): ${f.before.map((g) => JSON.stringify(g)).join(", ")}`);
}
if (flagged.length > PRINT_LIMIT) console.log(`  … and ${flagged.length - PRINT_LIMIT} more.`);

// ─── Repair ──────────────────────────────────────────────────────────────────
const withheld = flagged.filter((f) => isLocked(f.book));
const repairable = flagged.filter((f) => !isLocked(f.book));
if (withheld.length) {
  const byBook = new Map();
  for (const f of withheld) byBook.set(f.book, (byBook.get(f.book) ?? 0) + 1);
  console.log(`\nWithheld ${withheld.length} verse(s) in LOCKED books (fix on Door43 by hand): ` +
    [...byBook].map(([b, n]) => `${b} ${n}`).join(", "));
}

// Any earlier run's SQL is removed FIRST, whether or not this run writes a new
// one. Otherwise a run whose every finding was withheld (all in locked books)
// would leave a stale file behind that still carries those locked-book UPDATEs
// — and an operator applying "the output" would write exactly what the lock
// rule exists to prevent.
const outDir = resolve(repoRoot, "scripts/out");
const outPath = resolve(outDir, "repair-opening-punct.sql");
if (doRepair && existsSync(outPath)) {
  unlinkSync(outPath);
  console.log(`removed stale ${outPath}`);
}
if (doRepair && repairable.length === 0) {
  console.log("\nNothing to repair in unlocked books — no SQL written.");
}

if (doRepair && repairable.length > 0) {
  const q = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const actor = Number(process.env.REPAIR_ACTOR);
  if (!(Number.isInteger(actor) && actor > 0)) {
    console.error("refusing to emit SQL: REPAIR_ACTOR must be a users.id (e.g. REPAIR_ACTOR=2) — see header");
    process.exit(1);
  }
  // Checked on the RAW value: Number(null) is 0 and would pass an isInteger test.
  const unversioned = repairable.filter((f) => !(Number.isInteger(f.rowVersion) && f.rowVersion >= 1));
  if (unversioned.length) {
    console.error(
      `refusing to emit SQL: ${unversioned.length} flagged verse(s) have no usable version — the dump must ` +
        "include the version column, or the optimistic-concurrency guard cannot be written.",
    );
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  const lines = [
    `-- Repair opening punctuation stranded inside an alignment milestone. Generated ${new Date().toISOString()}`,
    `-- ${repairable.length} verse(s) in unlocked books (${withheld.length} withheld in locked books). Hoists the`,
    `-- opener to a top-level text node, refreshes plain_text, bumps version (stale-client`,
    `-- refetch), and logs an edit_log row.`,
    `-- Each UPDATE is guarded on the dumped version; compare the reported changes count with ${repairable.length}.`,
    `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
  ];
  for (const f of repairable) {
    const key = `${f.book}/${f.chapter}/${f.verse}/${f.version}`;
    // Same audit shape the app writes for a verse PATCH (verses.ts): action
    // 'update' — history replay consumes only create / update / restore, so a
    // bespoke verb is an invisible audit row — a payload of { content,
    // plain_text } like parsed.data, and gated on changes() so a skipped
    // UPDATE (version moved on) leaves no orphan history entry.
    const payload = JSON.stringify({ content: JSON.parse(f.newContent), plain_text: f.newPlainText });
    lines.push(
      `UPDATE verses SET content_json = ${q(f.newContent)}, plain_text = ${q(f.newPlainText)}, version = version + 1, updated_at = ${now}, updated_by = ${actor}`,
      ` WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)} AND version = ${Number(f.rowVersion)};`,
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)`,
      `  SELECT 'verse', ${q(key)}, ${q(f.book)}, ${actor}, version - 1, version, 'update', ${q(payload)}`,
      `    FROM verses WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)} AND changes() > 0;`,
    );
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote repair SQL for ${repairable.length} verse(s): ${outPath}`);
}

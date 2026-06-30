// Reform maqqef/minus-glued alignment milestones off the UHB for a GL book.
//
// Reuses the ONE reform implementation — web/src/lib/alignment.ts
// reformGluedMilestones — so the backfill and the live aligner can never drift.
// Run with strip-types:
//   node --experimental-strip-types scripts/reform-amo-ust.mjs --dry-run \
//     --ust <ust.usfm> --uhb <uhb.usfm> [--chapter N]
//
// DRY-RUN (default): parse the GL (UST) + UHB USFM, reform each verse, and report
// which verses/milestones change. Asserts the target PLAIN TEXT is byte-identical
// before/after (the reform only re-anchors the source side — it must never touch
// the translation). Emits no SQL and never touches any database.
//
// PROD backfill (--emit-sql, gated on explicit go-ahead): give it a JSON snapshot
// of the CURRENT prod verses (`[{chapter,verse,version,content_json}]`, exported
// from prod D1) via --snapshot; it reforms each off the UHB and prints versioned
// UPDATE + edit_log SQL for the verses that actually change. Apply with
// `wrangler d1 execute bible_editor --remote --env production --file=...`.

import { readFileSync } from "node:fs";
import usfm from "usfm-js";
import { reformGluedMilestones } from "../web/src/lib/alignment.ts";
import { extractPlainText } from "../web/src/lib/usfm.ts";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) { args.set(key, next); i++; } else args.set(key, true);
  }
}

const ustPath = args.get("ust");
const uhbPath = args.get("uhb");
const onlyChapter = args.get("chapter") ? Number(args.get("chapter")) : null;
const emitSql = args.get("emit-sql");
const snapshotPath = args.get("snapshot");
if (!uhbPath || (!ustPath && !snapshotPath)) {
  console.error("usage: --uhb <uhb.usfm> (--ust <ust.usfm> | --snapshot <prod.json>) [--chapter N] [--emit-sql]");
  process.exit(2);
}

const uhb = usfm.toJSON(readFileSync(uhbPath, "utf8"));
const uhbVerse = (c, v) => uhb.chapters?.[String(c)]?.[String(v)]?.verseObjects ?? null;

// Reform one verse; return { changed, reformed, skipped, newVerseObjects, plainOk }.
function reformVerse(targetVerseObjects, c, v) {
  const src = uhbVerse(c, v);
  if (!src) return { changed: false, reformed: 0, skipped: 0, plainOk: true };
  const report = { reformed: 0, skipped: 0, notes: [] };
  const out = reformGluedMilestones(targetVerseObjects, src, report);
  const changed = out !== targetVerseObjects;
  const plainOk = extractPlainText(targetVerseObjects) === extractPlainText(out);
  return { changed, reformed: report.reformed, skipped: report.skipped, notes: report.notes, newVerseObjects: out, plainOk };
}

let totalChanged = 0, totalReformed = 0, totalSkipped = 0, plainBroke = 0;
const sqlLines = [];

if (snapshotPath) {
  // PROD path: reform the actual stored content_json snapshot.
  const rows = JSON.parse(readFileSync(snapshotPath, "utf8"));
  for (const row of rows) {
    if (onlyChapter && Number(row.chapter) !== onlyChapter) continue;
    const parsed = JSON.parse(row.content_json);
    const r = reformVerse(parsed.verseObjects ?? [], row.chapter, row.verse);
    if (!r.changed) continue;
    if (!r.plainOk) { plainBroke++; console.error(`PLAIN-TEXT CHANGED at ${row.chapter}:${row.verse} — refusing`); continue; }
    totalChanged++; totalReformed += r.reformed; totalSkipped += r.skipped;
    console.log(`AMO ${row.chapter}:${row.verse} v${row.version} → reformed ${r.reformed}, skipped ${r.skipped}: ${r.notes.join("; ")}`);
    if (emitSql) {
      const newJson = JSON.stringify({ ...parsed, verseObjects: r.newVerseObjects }).replace(/'/g, "''");
      const where = `book='AMO' AND bible_version='UST' AND chapter=${row.chapter} AND verse=${row.verse}`;
      const rowKey = `AMO/${row.chapter}/${row.verse}/UST`;
      const payload = JSON.stringify({ reformed: r.reformed, source: "reform-glued-alignment" }).replace(/'/g, "''");
      // Optimistic-lock the write on the snapshot version, so a row edited between
      // the prod READ and apply is never clobbered (mirrors scripts/heal-align-1ch-num.mjs).
      sqlLines.push(
        `UPDATE verses SET content_json='${newJson}', version=version+1, updated_at=unixepoch(), updated_by=2 ` +
        `WHERE ${where} AND version=${row.version};`,
      );
      // Audit row fires only if OUR update landed: the row is now at version+1 AND
      // carries exactly the reformed content we wrote (a concurrent edit that also
      // reached version+1 would not match content_json → no orphan audit row).
      // Full edit_log shape (payload_json, book, user_id, prev/new_version, source).
      sqlLines.push(
        `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at) ` +
        `SELECT 'verse','${rowKey}','AMO',2,${row.version},${row.version + 1},'update','${payload}','reform-glued-alignment',unixepoch() ` +
        `WHERE EXISTS (SELECT 1 FROM verses WHERE ${where} AND version=${row.version + 1} AND content_json='${newJson}');`,
      );
    }
  }
} else {
  // DRY-RUN path: reform straight from the UST USFM (no DB).
  const ust = usfm.toJSON(readFileSync(ustPath, "utf8"));
  for (const c of Object.keys(ust.chapters)) {
    if (onlyChapter && Number(c) !== onlyChapter) continue;
    for (const v of Object.keys(ust.chapters[c])) {
      if (!/^\d+$/.test(v)) continue;
      const r = reformVerse(ust.chapters[c][v].verseObjects, c, v);
      if (!r.changed && r.skipped === 0) continue;
      if (!r.plainOk) { plainBroke++; console.error(`PLAIN-TEXT CHANGED at ${c}:${v} — BUG`); }
      if (r.changed) { totalChanged++; totalReformed += r.reformed; }
      totalSkipped += r.skipped;
      console.log(`${c}:${v} reformed=${r.reformed} skipped=${r.skipped} plainOk=${r.plainOk}: ${r.notes.join("; ")}`);
    }
  }
}

console.log(`\nSummary: verses changed=${totalChanged}, milestones reformed=${totalReformed}, skipped(ambiguous)=${totalSkipped}, plain-text-broke=${plainBroke}`);
if (emitSql && sqlLines.length) {
  console.log("\n-- SQL --\n" + sqlLines.join("\n"));
}
if (plainBroke > 0) process.exit(1);

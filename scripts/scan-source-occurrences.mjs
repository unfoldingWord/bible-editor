// Scan stored verses for `\zaln-s` milestones whose source-occurrence numbering
// OVER-COUNTS the source verse — i.e. a UHB/UGNT token that appears once (or N
// times) is stamped with x-occurrences greater than that. A few AI-generated
// alignments do this when a single source word is translated into a repeated
// target phrase (e.g. JER 28:1 UST aligns the single חֲנַנְיָה / אָמַר / אֵלַי /
// לְעֵינֵי to two English runs as occ 1/2 and 2/2). The aligner renders the
// Hebrew word twice, and the exported USFM claims a source count that does not
// exist.
//
// The display already collapses these (mergeSamePositionGroups). This script is
// the DATA fix: it rewrites the stored content_json so the nightly DCS export is
// clean. The correction (correctSourceOccurrences) is conservative — keyed by
// x-content (NFC), only the over-count case, content-less / drifted / under-count
// milestones untouched — so clean rows never churn.
//
// Workflow:
//   1. Dump verses to JSON (run from api/):
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT book,chapter,verse,bible_version,content_json,version FROM verses" \
//          --json > ../scripts/out/verses-dump.json
//      (local dev: bible_editor_dev --local)
//   2. Scan (report only):
//        node --experimental-strip-types --no-warnings scripts/scan-source-occurrences.mjs scripts/out/verses-dump.json
//   3. Emit repair SQL for flagged verses:
//        REPAIR_ACTOR=<users.id> node --experimental-strip-types --no-warnings \
//          scripts/scan-source-occurrences.mjs scripts/out/verses-dump.json --repair
//      → scripts/out/repair-source-occurrences.sql   (apply with wrangler d1 execute --file=…)
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
// This script has NO lock rule. scripts/split-fixes-by-lock.mjs strips locked
// books out of the combined output; apply only the *-unlocked.sql it writes.
//
// Optional: limit to one book with BOOK=JER, and printed-row count with
// SCAN_PRINT_LIMIT=N.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { correctSourceOccurrences } from "../web/src/lib/sourceOccurrences.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const dumpPath = process.argv[2];
const doRepair = process.argv.includes("--repair");
const onlyBook = (process.env.BOOK ?? "").toUpperCase() || null;
if (!dumpPath) {
  console.error("usage: node scripts/scan-source-occurrences.mjs <verses-dump.json> [--repair]");
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

function sourceVersionFor(hasUhb, hasUgnt) {
  // Prefer whichever original-language source is present for that verse.
  if (hasUhb) return "UHB";
  if (hasUgnt) return "UGNT";
  return null;
}

const rows = loadRows(dumpPath);

// Index every verse by book/chapter/verse for source pairing.
const byKey = new Map(); // `${book}/${ch}/${v}` -> { [version]: row }
for (const r of rows) {
  const k = `${r.book}/${r.chapter}/${r.verse}`;
  if (!byKey.has(k)) byKey.set(k, {});
  byKey.get(k)[r.bible_version] = r;
}

const TARGET_VERSIONS = new Set(["ULT", "UST", "GLT", "GST"]);
const flagged = []; // { book, chapter, verse, version, row, corrections, newContent }
const stats = new Map(); // `${book}/${version}` -> { verses, corrected }

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

  const peers = byKey.get(`${r.book}/${r.chapter}/${r.verse}`) ?? {};
  const srcVersion = sourceVersionFor(!!peers.UHB, !!peers.UGNT);
  if (!srcVersion) continue;
  let srcContent;
  try {
    srcContent = JSON.parse(peers[srcVersion].content_json);
  } catch {
    continue;
  }
  const srcVo = srcContent?.verseObjects;
  if (!Array.isArray(srcVo) || srcVo.length === 0) continue;

  const statKey = `${r.book}/${r.bible_version}`;
  const st = stats.get(statKey) ?? { verses: 0, corrected: 0 };
  st.verses++;

  const { changed, verseObjects, corrections } = correctSourceOccurrences(vo, srcVo);
  if (changed) {
    st.corrected++;
    const newContent = JSON.stringify({ ...content, verseObjects });
    // Guard: skip if the re-stringified content is byte-identical (shouldn't
    // happen when changed=true, but keeps the SQL free of no-op writes).
    if (newContent !== r.content_json) {
      flagged.push({
        book: r.book,
        chapter: r.chapter,
        verse: r.verse,
        version: r.bible_version,
        rowVersion: r.version,
        corrections,
        newContent,
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
console.log(`\nFlagged ${flagged.length} verse(s) with over-counted source occurrences:`);
const PRINT_LIMIT = parseInt(process.env.SCAN_PRINT_LIMIT ?? "60", 10);
for (const f of flagged.slice(0, PRINT_LIMIT)) {
  const summary = f.corrections
    .map((c) => `${c.content} ${c.from.occurrence}/${c.from.occurrences}→${c.to.occurrence}/${c.to.occurrences}`)
    .join(", ");
  console.log(`  ${f.book} ${f.chapter}:${f.verse} ${f.version}  ${summary}`);
}
if (flagged.length > PRINT_LIMIT) console.log(`  … and ${flagged.length - PRINT_LIMIT} more.`);

// ─── Repair ──────────────────────────────────────────────────────────────────
if (doRepair && flagged.length > 0) {
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
  const unversioned = flagged.filter((f) => !Number.isInteger(Number(f.rowVersion)));
  if (unversioned.length) {
    console.error(
      `refusing to emit SQL: ${unversioned.length} flagged verse(s) have no usable version — the dump must ` +
        "include the version column, or the optimistic-concurrency guard cannot be written.",
    );
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  const lines = [
    `-- Repair over-counted alignment source occurrences. Generated ${new Date().toISOString()}`,
    `-- ${flagged.length} verse(s). Renumbers \\zaln-s x-occurrence/x-occurrences to the source`,
    `-- verse's true token count, bumps version (stale-client refetch), and logs an edit_log row.`,
    `-- Each UPDATE is guarded on the dumped version; compare the reported changes count with ${flagged.length}.`,
    `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
  ];
  for (const f of flagged) {
    const key = `${f.book}/${f.chapter}/${f.verse}/${f.version}`;
    // Same audit shape the app writes for a verse PATCH (verses.ts): action
    // 'update' — history replay consumes only create / update / restore, so a
    // bespoke verb is an invisible audit row — a payload of { content } like
    // parsed.data, and gated on changes() so a skipped UPDATE (version moved
    // on) leaves no orphan history entry.
    const payload = JSON.stringify({ content: JSON.parse(f.newContent) });
    lines.push(
      `UPDATE verses SET content_json = ${q(f.newContent)}, version = version + 1, updated_at = ${now}, updated_by = ${actor}`,
      ` WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)} AND version = ${Number(f.rowVersion)};`,
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)`,
      `  SELECT 'verse', ${q(key)}, ${q(f.book)}, ${actor}, version - 1, version, 'update', ${q(payload)}`,
      `    FROM verses WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)} AND changes() > 0;`,
    );
  }
  const outDir = resolve(repoRoot, "scripts/out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "repair-source-occurrences.sql");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote repair SQL for ${flagged.length} verse(s): ${outPath}`);
}

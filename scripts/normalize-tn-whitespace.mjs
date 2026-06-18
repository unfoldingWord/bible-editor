// One-time D1 cleanup: collapse bp-assistant's double-space-after-punctuation
// artifact in PRISTINE AI translation notes so D1 converges with the normalized
// form DCS maintainers keep on en_tn master.
//
// Background (see .claude/STATE.md, theme "export-churn-convergence"): AI notes
// land in D1 with double spaces (".  Alternate translation:", "**word**,  could").
// Maintainers normalize them to single space on master, so every nightly export
// pushes a whitespace-only change to the per-book `-be-` branch — churn that on
// 2026-06-18 produced a real (unresolved-and-committed) merge conflict in ISA.
// The runtime fix (api/src/importParsers.ts: normalizeNoteWhitespace, wired into
// pipelineImport) stops NEW notes; this script remediates the rows already in D1.
//
// SAFETY:
//   • Only PRISTINE AI rows (updated_by IS NULL) are touched — editor-edited
//     notes are never rewritten. The emitted SQL re-checks this predicate AND
//     that the note still byte-matches what we scanned, so a row edited between
//     dump and apply is skipped (and the audit row is skipped with it).
//   • Uses the SAME shared normalizeNoteWhitespace the Worker runs at import, so
//     script and runtime can't diverge.
//   • Whitespace-ONLY: never alters note content. Some double spaces MASK a
//     dropped word (ISA: "**understanding**,  could express" was missing "you").
//     Those are surfaced in a SUSPICIOUS report for human review — collapsing
//     still happens, but a human should eyeball the flagged notes.
//
// Workflow (run from repo root):
//   1. Dump pristine-candidate columns (run from api/). Prod:
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --command "SELECT id,book,chapter,verse,note,version,updated_by,deleted_at,trashed_at FROM tn_rows WHERE deleted_at IS NULL AND trashed_at IS NULL AND updated_by IS NULL" \
//          --json > ../scripts/out/tn-rows-dump.json
//      (local dev: bible_editor_dev --local)
//   2. Dry-run report (per-book counts + suspicious notes):
//        node --experimental-strip-types --no-warnings scripts/normalize-tn-whitespace.mjs scripts/out/tn-rows-dump.json
//        node --experimental-strip-types --no-warnings scripts/normalize-tn-whitespace.mjs scripts/out/tn-rows-dump.json --book ISA
//   3. Emit the UPDATE SQL:
//        node --experimental-strip-types --no-warnings scripts/normalize-tn-whitespace.mjs scripts/out/tn-rows-dump.json --repair
//      → scripts/out/normalize-tn-whitespace.sql  (review, then apply with wrangler d1 execute --file=…)
//   4. Re-export the affected books so master converges and `-be-` branches stop
//      diffing on whitespace alone.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNoteWhitespace, findSuspiciousDoubleSpaces } from "../api/src/importParsers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const dumpPath = args.find((a) => !a.startsWith("--"));
const doRepair = args.includes("--repair");
const bookFilter = (() => {
  const i = args.indexOf("--book");
  return i >= 0 ? (args[i + 1] || "").toUpperCase() : null;
})();
if (!dumpPath) {
  console.error("usage: node scripts/normalize-tn-whitespace.mjs <tn-rows-dump.json> [--book ISA] [--repair]");
  process.exit(1);
}

// wrangler --json wraps results as [{ results: [...] }] (or a bare array). On a
// Cloudflare auth failure it writes its error object to the same file — surface
// that instead of "unrecognized dump shape".
function loadRows(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw && !Array.isArray(raw) && raw.error) {
    const notes = (raw.error.notes ?? []).map((n) => n.text).join("; ");
    throw new Error(
      `dump is a wrangler/Cloudflare ERROR, not data: ${raw.error.text || raw.error.name}` +
        (notes ? ` (${notes})` : "") +
        `\n→ wrangler isn't authenticated to the prod account. Run \`npx wrangler login\` (or set CLOUDFLARE_API_TOKEN) for the unfoldingWord account, then re-run the dump.`,
    );
  }
  if (Array.isArray(raw) && raw[0]?.results) return raw.flatMap((r) => r.results ?? []);
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.results)) return raw.results;
  throw new Error("unrecognized dump shape");
}

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function main() {
  // Pristine AI rows only — never rewrite editor-touched notes. (The dump query
  // already filters these, but re-assert defensively in case a broader dump is
  // passed.)
  let rows = loadRows(dumpPath).filter(
    (r) => r.deleted_at == null && r.trashed_at == null && r.updated_by == null,
  );
  if (bookFilter) rows = rows.filter((r) => String(r.book).toUpperCase() === bookFilter);

  const candidates = []; // { row, normalized }
  const suspicious = []; // { ref, contexts }
  for (const r of rows) {
    const note = typeof r.note === "string" ? r.note : null;
    if (note == null) continue;
    const normalized = normalizeNoteWhitespace(note);
    if (normalized === note) continue;
    candidates.push({ row: r, normalized });
    const susp = findSuspiciousDoubleSpaces(note);
    if (susp.length > 0) {
      suspicious.push({ ref: `${r.book} ${r.chapter}:${r.verse} (${r.id})`, contexts: susp });
    }
  }

  // ─── Dry-run report ────────────────────────────────────────────────────────
  const byBook = new Map();
  for (const c of candidates) {
    const b = String(c.row.book);
    byBook.set(b, (byBook.get(b) ?? 0) + 1);
  }
  console.log(`Scanned ${rows.length} pristine AI TN rows${bookFilter ? ` (book=${bookFilter})` : ""}.`);
  console.log(`Rows whose note would change (whitespace only): ${candidates.length} across ${byBook.size} book(s).`);
  for (const [b, n] of [...byBook].sort((a, b) => b[1] - a[1])) console.log(`   ${b.padEnd(4)} ${n}`);

  const sample = candidates.slice(0, 8);
  if (sample.length) {
    console.log("\nsample changes (before → after):");
    for (const { row, normalized } of sample) {
      const clip = (s) => (s.length > 90 ? s.slice(0, 90) + "…" : s);
      console.log(`   ${row.book} ${row.chapter}:${row.verse} (${row.id})`);
      console.log(`     - ${clip(row.note)}`);
      console.log(`     + ${clip(normalized)}`);
    }
  }

  if (suspicious.length > 0) {
    console.log(
      `\n⚠ ${suspicious.length} note(s) have a double space that may MASK A DROPPED WORD — review by hand` +
        ` (whitespace is still collapsed; content is NOT auto-fixed):`,
    );
    for (const s of suspicious) {
      console.log(`   ${s.ref}`);
      for (const ctx of s.contexts) console.log(`       » ${ctx}`);
    }
  } else {
    console.log(`\nNo suspicious double spaces — every collapse follows sentence-ending punctuation. ✓`);
  }

  if (!doRepair) {
    console.log("\n(report only — pass --repair to emit UPDATE SQL)");
    return;
  }

  // ─── Repair SQL ──────────────────────────────────────────────────────────────
  // version+1 forces stale clients to refetch; the next export carries the
  // normalized note to master. Both statements re-assert updated_by IS NULL,
  // deleted_at IS NULL, and the unchanged original note, so a row edited between
  // dump and apply is skipped — and its audit row is skipped with it (the SELECT
  // matches on the post-update note value).
  const now = Math.floor(Date.now() / 1000);
  const lines = [
    `-- Normalize double-space-after-punctuation in pristine AI TN notes. Generated ${new Date().toISOString()}`,
    `-- ${candidates.length} row(s). Whitespace-only; guarded on updated_by IS NULL + unchanged note.`,
    `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
  ];
  for (const { row, normalized } of candidates) {
    const id = sqlStr(row.id);
    const book = sqlStr(row.book);
    const orig = sqlStr(row.note);
    const norm = sqlStr(normalized);
    lines.push(
      `UPDATE tn_rows SET note=${norm}, version=version+1, updated_at=${now}` +
        ` WHERE id=${id} AND book=${book} AND updated_by IS NULL AND deleted_at IS NULL AND note=${orig};`,
      `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,source)` +
        ` SELECT 'tn',${id},${book},NULL,version-1,version,'normalize_whitespace','normalize_whitespace'` +
        ` FROM tn_rows WHERE id=${id} AND book=${book} AND note=${norm} AND updated_by IS NULL AND deleted_at IS NULL;`,
    );
  }
  const outDir = resolve(repoRoot, "scripts", "out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "normalize-tn-whitespace.sql");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${candidates.length * 2} statements to ${outPath}`);
  console.log("Review, then: npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/out/normalize-tn-whitespace.sql");
}

main();

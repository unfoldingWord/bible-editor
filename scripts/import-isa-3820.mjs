// Scoped swap of Isaiah 38:9-20 TN notes: replace D1's existing notes with the
// (now-fixed) AI notes on DCS master. SCOPED to 38:9-20 only — must not touch the
// rest of the Kings→Isaiah migration. Forced replace (not the conservative
// pristine-only reimport): the existing 38:9-20 notes are original AI content the
// user wants gone. Composite PK is (id, book), so we UPSERT by DCS id (resurrect
// an id that already exists, even as a tombstone) and PRUNE old ids not in DCS.
//
// Inputs (fetched at apply time):
//   scripts/out/kings-isa/src/tn_ISA_master.tsv   — fresh master en_tn tn_ISA.tsv
//   scripts/out/kings-isa/d1-isa-all.json         — {results:[{id, chapter, verse, deleted_at, preserve, hint, updated_by}]} for ALL book=ISA rows
// Output: scripts/out/kings-isa/swap-3820.sql  (+ prints a preserve/hint/human safety report)
//
// Run: node scripts/import-isa-3820.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out/kings-isa");
const MIGRATION_USER = 2;

const q = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const inRange = (ch, vs) => { if (+ch !== 38) return false; const v = parseInt(String(vs).split("-")[0], 10); return v >= 9 && v <= 20; };

// --- parse master TSV, extract 38:9-20 ---
const tsv = readFileSync(resolve(outDir, "src/tn_ISA_master.tsv"), "utf8").split(/\r?\n/).filter((l) => l.length);
const H = tsv[0].split("\t");
const ci = (n) => H.indexOf(n);
const dcsRows = [];
for (const line of tsv.slice(1)) {
  const c = line.split("\t");
  const ref = c[ci("Reference")] || "";
  const [ch, vs] = ref.split(":");
  if (!inRange(ch, vs)) continue;
  const verse = parseInt(String(vs).split("-")[0], 10);
  dcsRows.push({
    id: c[ci("ID")], ref_raw: ref, chapter: 38, verse,
    tags: c[ci("Tags")] || null, support_reference: c[ci("SupportReference")] || null,
    quote: c[ci("Quote")] || null,
    occurrence: c[ci("Occurrence")] === "" ? null : parseInt(c[ci("Occurrence")], 10),
    note: c[ci("Note")] || null,
  });
}

// --- D1 current state ---
const d1 = JSON.parse(readFileSync(resolve(outDir, "d1-isa-all.json"), "utf8"));
const d1rows = (Array.isArray(d1) ? d1[0] : d1).results;
const d1ById = new Map(d1rows.map((r) => [r.id, r]));
const d1Live3820 = d1rows.filter((r) => r.chapter === 38 && r.verse >= 9 && r.verse <= 20 && r.deleted_at == null);

// safety: any protected (preserve/hint) or human-edited live 38:9-20 row?
const protectedRows = d1Live3820.filter((r) => r.preserve === 1 || r.hint === 1);
const report = { dcsRows: dcsRows.length, d1Live: d1Live3820.length, protected: protectedRows.length, upsertExisting: 0, insertNew: 0, prune: 0, idMovedFromOtherVerse: [] };

const dcsIds = new Set(dcsRows.map((r) => r.id));
const lines = [];
lines.push("-- Isaiah 38:9-20 scoped swap: D1 ← DCS master (fixed AI notes). SCOPED — touches only 38:9-20.");
lines.push("");

// 1. PRUNE: live D1 38:9-20 rows whose id is not in the DCS set (skip protected).
lines.push("-- prune old 38:9-20 notes no longer on master");
for (const r of d1Live3820) {
  if (dcsIds.has(r.id)) continue;
  if (r.preserve === 1 || r.hint === 1) continue; // never prune protected
  lines.push(`UPDATE tn_rows SET deleted_at=unixepoch(), version=version+1, updated_at=unixepoch(), updated_by=${MIGRATION_USER} WHERE book='ISA' AND id=${q(r.id)} AND deleted_at IS NULL;`);
  lines.push(`INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,source,payload_json) VALUES ('tn',${q(r.id)},'ISA',${MIGRATION_USER},NULL,NULL,'delete','isa_3820_swap','{"reason":"replaced by fixed master AI notes for 38:9-20"}');`);
  report.prune++;
}
lines.push("");

// 2. UPSERT each DCS row by id. updated_by=NULL → behaves like a normal master import
//    (stable for export round-trip; a reimport would restore identical content).
lines.push("-- upsert the fixed master 38:9-20 notes (DCS ids preserved)");
for (const r of dcsRows) {
  const existing = d1ById.get(r.id);
  const payload = { book: "ISA", chapter: 38, verse: r.verse, ref_raw: r.ref_raw, tags: r.tags, support_reference: r.support_reference, quote: r.quote, occurrence: r.occurrence, note: r.note, source_note: "ISA 38:9-20 import from master" };
  if (existing) {
    if (!(existing.chapter === 38 && existing.verse >= 9 && existing.verse <= 20)) report.idMovedFromOtherVerse.push(`${r.id} (was ${existing.chapter}:${existing.verse})`);
    // resurrect + overwrite in place (handles tombstone collision from the prune above too)
    lines.push(`UPDATE tn_rows SET chapter=38, verse=${r.verse}, ref_raw=${q(r.ref_raw)}, tags=${q(r.tags)}, support_reference=${q(r.support_reference)}, quote=${q(r.quote)}, occurrence=${q(r.occurrence)}, note=${q(r.note)}, deleted_at=NULL, trashed_at=NULL, review_kind=NULL, review_reason=NULL, updated_by=NULL, version=version+1, updated_at=unixepoch() WHERE book='ISA' AND id=${q(r.id)};`);
    report.upsertExisting++;
  } else {
    lines.push(`INSERT INTO tn_rows (id,book,chapter,verse,ref_raw,tags,support_reference,quote,occurrence,note,sort_order,updated_by,version,preserve,hint) VALUES (${q(r.id)},'ISA',38,${r.verse},${q(r.ref_raw)},${q(r.tags)},${q(r.support_reference)},${q(r.quote)},${q(r.occurrence)},${q(r.note)},${(report.insertNew + 1) * 100},NULL,1,0,0);`);
    report.insertNew++;
  }
  lines.push(`INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,source,payload_json) VALUES ('tn',${q(r.id)},'ISA',${MIGRATION_USER},NULL,1,'create','isa_3820_swap',${q(JSON.stringify(payload))});`);
}

writeFileSync(resolve(outDir, "swap-3820.sql"), lines.join("\n") + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.protected) console.log("⚠ PROTECTED live rows in 38:9-20 (left untouched):", protectedRows.map((r) => `${r.verse}:${r.id}`).join(", "));
if (report.idMovedFromOtherVerse.length) console.log("⚠ DCS ids that exist elsewhere in D1 ISA (will move into 38):", report.idMovedFromOtherVerse.join(", "));
console.log(`wrote swap-3820.sql (${lines.filter((l) => /^(UPDATE|INSERT)/.test(l)).length} statements)`);

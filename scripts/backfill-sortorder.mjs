// One-off migration: normalize sort_order to the per-verse ordinal scheme from
// the canonical DCS master files. Repairs rows imported via paths that left
// sort_order=NULL (AI pipeline, pre-fix merge reimport) and migrates older
// rows off the global-ordinal scheme that bootstrap used to write.
//
// sort_order = (position within chapter:verse, 1-based) * 100, in DCS file
// order — identical to what bookImport.ts / bookReimport.ts now compute, so a
// subsequent reimport is a no-op (no version churn).
//
// Safety: only PRISTINE rows (updated_by IS NULL) are renumbered, plus any row
// still NULL (no order to lose). Rows a translator deliberately reordered
// (updated_by set AND sort_order present) are left untouched. Only rows whose
// id appears in the current master file are touched.
//
// Usage:
//   node scripts/backfill-sortorder.mjs ISA            # one book
//   node scripts/backfill-sortorder.mjs ISA ECC NUM    # several
// Emits scripts/out/backfill-<BOOK>-<kind>.sql; apply with:
//   npx wrangler d1 execute bible_editor --remote --env production \
//     --file=../scripts/out/backfill-<BOOK>-<kind>.sql   (run from api/)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const REPO = { tn: "en_tn", tq: "en_tq", twl: "en_twl" };
const TABLE = { tn: "tn_rows", tq: "tq_rows", twl: "twl_rows" };

// Mirror of api/src/importParsers.ts refParts — keep the verse-keying identical
// to the importer so ordinals line up.
function refParts(refRaw) {
  if (!refRaw) return [0, 0];
  const [ch, vs] = refRaw.split(":");
  const chNum = ch === "front" ? 0 : parseInt(ch, 10) || 0;
  const vsNum = !vs || vs === "intro" ? 0 : parseInt(vs.split("-")[0], 10) || 0;
  return [chNum, vsNum];
}

async function fetchTsv(kind, book) {
  const url = `https://git.door43.org/unfoldingWord/${REPO[kind]}/raw/branch/master/${kind}_${book}.tsv`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${kind} ${book}: HTTP ${r.status}`);
  return r.text();
}

// Build [{id, sortOrder}] for one resource: per-verse ordinal in file order.
function ordinalsFor(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t");
  const idIdx = headers.indexOf("ID");
  const refIdx = headers.indexOf("Reference");
  if (idIdx < 0 || refIdx < 0) throw new Error(`missing ID/Reference column: ${headers.join("|")}`);
  const perVerse = new Map();
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const id = cells[idIdx];
    if (!id) continue;
    const [ch, v] = refParts(cells[refIdx]);
    const key = ch * 100000 + v;
    const ord = (perVerse.get(key) ?? 0) + 1;
    perVerse.set(key, ord);
    out.push({ id, sortOrder: ord * 100 });
  }
  return out;
}

const books = process.argv.slice(2).map((b) => b.toUpperCase());
if (books.length === 0) {
  console.error("usage: node scripts/backfill-sortorder.mjs <BOOK> [BOOK...]");
  process.exit(1);
}

for (const book of books) {
  for (const kind of Object.keys(TABLE)) {
    const raw = await fetchTsv(kind, book);
    const rows = ordinalsFor(raw);
    const stmts = rows.map(({ id, sortOrder }) => {
      const esc = id.replace(/'/g, "''");
      return (
        `UPDATE ${TABLE[kind]} SET sort_order = ${sortOrder} ` +
        `WHERE id = '${esc}' AND book = '${book}' ` +
        `AND (updated_by IS NULL OR sort_order IS NULL);`
      );
    });
    const dest = join(OUT, `backfill-${book}-${kind}.sql`);
    writeFileSync(dest, stmts.join("\n") + "\n");
    console.log(`${book} ${kind}: ${stmts.length} rows -> ${dest}`);
  }
}

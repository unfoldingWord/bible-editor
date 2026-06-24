// Split a one-statement-per-line SQL file into segments of <= N statements
// (default 70) so wrangler d1 execute --file applies reliably (large batches
// have failed mid-apply before). Comments/blank lines ride with the next stmt.
// Writes <base>.seg001.sql, .seg002.sql, … next to the input and prints them.
// Run: node scripts/split-sql.mjs <file.sql> [N]
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const N = Number(process.argv[3] || 70);
if (!file) { console.error("usage: node scripts/split-sql.mjs <file.sql> [N]"); process.exit(1); }
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const segs = [];
let cur = [], stmts = 0;
for (const line of lines) {
  cur.push(line);
  if (/;\s*$/.test(line)) { // statement end
    stmts++;
    if (stmts >= N) { segs.push(cur.join("\n")); cur = []; stmts = 0; }
  }
}
if (cur.some((l) => l.trim())) segs.push(cur.join("\n"));
const base = file.replace(/\.sql$/, "");
const out = [];
segs.forEach((s, i) => {
  const p = `${base}.seg${String(i + 1).padStart(3, "0")}.sql`;
  writeFileSync(p, s.endsWith("\n") ? s : s + "\n");
  out.push(p);
});
console.log(`${segs.length} segments (<= ${N} stmts each):`);
out.forEach((p) => console.log(p));

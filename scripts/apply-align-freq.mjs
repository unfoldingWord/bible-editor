// Apply scripts/out/align-freq.sql to a D1 database in chunks.
//
// Why chunk: `wrangler d1 execute --file` on a multi-MB file times out against
// the *remote* D1 (D1_RESET_DO) — the same reason scripts/reimport-ust-from-dcs
// chunks. wrangler 4.x has no `d1 import`, so we split the generated SQL into
// batches of INSERT statements and run one `d1 execute --file` per batch. The
// first batch carries the `DELETE FROM align_freq;` so a re-upload is a clean
// full refresh.
//
// Run (from repo root):
//   node scripts/apply-align-freq.mjs              # local dev D1
//   node scripts/apply-align-freq.mjs --remote     # production D1 (--remote --env production)
// Options:
//   --file <path>   source SQL (default scripts/out/align-freq.sql)
//   --batch <n>     INSERT statements per wrangler call (default 200)
//
// Production prerequisite (one-time, after a new migration):
//   npm --workspace api run db:migrate:remote     # applies 0024_align_freq.sql to prod

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const srcPath = resolve(repoRoot, arg("--file", "scripts/out/align-freq.sql"));
const batchSize = parseInt(arg("--batch", "200"), 10) || 200;

// Split the SQL into top-level statements. Leading comments/blank lines are
// skipped; a statement ends at the first line whose trimmed text ends with
// ";". align_freq surfaces are letter-only (punctuation is stripped upstream),
// so no value contains a stray ";" — the boundary is unambiguous.
const lines = readFileSync(srcPath, "utf8").split(/\r?\n/);
const statements = [];
let cur = [];
for (const line of lines) {
  const t = line.trim();
  if (cur.length === 0 && (t === "" || t.startsWith("--"))) continue;
  cur.push(line);
  if (t.endsWith(";")) {
    statements.push(cur.join("\n"));
    cur = [];
  }
}
if (statements.length === 0) {
  console.error(`no SQL statements found in ${srcPath} — run \`node scripts/train-aligner.mjs\` first`);
  process.exit(1);
}

const target = remote ? ["--remote", "--env", "production"] : ["--local"];
const chunkDir = join(repoRoot, "scripts", "out", "align-freq-chunks");
rmSync(chunkDir, { recursive: true, force: true });
mkdirSync(chunkDir, { recursive: true });

const totalChunks = Math.ceil(statements.length / batchSize);
console.log(
  `applying ${statements.length} statements to ${remote ? "REMOTE (production)" : "local"} D1 in ${totalChunks} chunk(s) of ${batchSize}`,
);

// Retry each chunk a few times: locally, a running `wrangler dev` holds the
// same SQLite file and intermittently locks it; remotely, transient errors
// happen. A short backoff clears both.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0, n = 0; i < statements.length; i += batchSize, n++) {
  const chunkPath = join(chunkDir, `align-freq-${String(n).padStart(3, "0")}.sql`);
  writeFileSync(chunkPath, statements.slice(i, i + batchSize).join("\n") + "\n", "utf8");
  process.stdout.write(`  chunk ${n + 1}/${totalChunks} … `);
  let ok = false;
  let lastErr = "";
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    try {
      execSync(
        `npx wrangler d1 execute bible_editor ${target.join(" ")} --file="${chunkPath}"`,
        { cwd: apiDir, stdio: ["ignore", "ignore", "pipe"] },
      );
      ok = true;
    } catch (e) {
      lastErr = (e.stderr?.toString?.() || "") + (e.stdout?.toString?.() || "") || e.message;
      if (attempt < 4) {
        process.stdout.write(`retry ${attempt}… `);
        await sleep(1000);
      }
    }
  }
  if (!ok) {
    console.log("FAILED");
    console.error(lastErr);
    console.error(`\nchunk file kept for inspection: ${chunkPath}`);
    process.exit(1);
  }
  console.log("ok");
}

rmSync(chunkDir, { recursive: true, force: true });
console.log(`done — align_freq refreshed on ${remote ? "production" : "local"} D1`);

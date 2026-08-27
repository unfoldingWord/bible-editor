#!/usr/bin/env node
// Build the masterLineage TSV per-row fixtures (issue #607) from Door43.
//
// A commit's diff plus the file AS IT STOOD AT THAT COMMIT is what
// `refsTouchedInTsv` maps. Unlike the USFM mapper (which walks \c/\v state
// across the WHOLE file), the TSV mapper is stateless and per-line — a row
// carries its own ref in column 1 — so the reduction that keeps this fixture
// small only has to keep the COVERED lines: the real line number and the real
// line text of every line inside one of the commit's own hunk ranges, plus
// the file's real line count for the bounds check. Everything else in the
// file is inert to the mapping. Reuses parseDiffHunksForPath from
// masterLineage.ts itself so the reduction can never drift from what the
// mapper actually reads.
//
// Usage (from the repo root):
//   node --experimental-strip-types scripts/extract-tsv-rows.mjs <repo> <path> <full-40-char-sha> <out-prefix>
//
// Writes <out-prefix>.diff and <out-prefix>.rows.txt.
//
// THE SHA MUST BE THE FULL 40 CHARS — see extract-usfm-markers.mjs's header
// for why (the raw endpoint silently serves master's current tip otherwise).
// Set DCS_TOKEN for rate limits.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseDiffHunksForPath } from "../api/src/masterLineage.ts";

const BASE = process.env.DCS_BASE_URL ?? "https://git.door43.org";
const OWNER = "unfoldingWord";
const FULL_SHA = /^[0-9a-f]{40}$/;

const [repo, path, sha, outPrefix] = process.argv.slice(2);
if (!repo || !path || !sha || !outPrefix) {
  console.error("usage: node --experimental-strip-types scripts/extract-tsv-rows.mjs <repo> <path> <full-sha> <out-prefix>");
  process.exit(2);
}
if (!FULL_SHA.test(sha)) {
  console.error(`refusing an abbreviated sha (${sha}): the raw endpoint would serve master's tip instead`);
  process.exit(2);
}

const headers = { Accept: "application/json" };
if (process.env.DCS_TOKEN) headers.Authorization = `token ${process.env.DCS_TOKEN}`;

async function get(url, accept) {
  const r = await fetch(url, { headers: { ...headers, Accept: accept ?? headers.Accept } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r;
}

const api = `${BASE}/api/v1/repos/${OWNER}/${encodeURIComponent(repo)}`;

// 1. The commit's own diff, byte for byte as served.
const diff = await (await get(`${api}/git/commits/${sha}.diff`, "text/plain")).text();

// 2. Who wrote it and what they called it — provenance for the fixture header.
const meta = await (await get(`${api}/git/commits/${sha}`)).json();
const subject = String(meta?.commit?.message ?? "").split("\n")[0].trim();
const author = meta?.commit?.author?.name ?? meta?.author?.login ?? "unknown";

// 3. The hunks, via the real parser — so a hunk-header shape this script
//    disagrees with the mapper about can never produce a silently-wrong fixture.
const parsed = parseDiffHunksForPath(diff, path);
if (!parsed.complete) {
  console.error(`parseDiffHunksForPath did not complete for ${path}@${sha}: ${parsed.reason}`);
  process.exit(1);
}

// 4. The file at that exact revision, reduced to the lines its own hunks cover.
const text = await (await get(`${api}/raw/${encodeURIComponent(path)}?ref=${sha}`, "text/plain")).text();
const lines = text.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

const covered = new Set();
for (const h of parsed.hunks) {
  const lo = h.newCount === 0 ? Math.max(1, h.newStart) : h.newStart;
  const hi = h.newCount === 0 ? Math.min(lines.length, h.newStart + 1) : h.newStart + h.newCount - 1;
  for (let n = lo; n <= hi; n++) covered.add(n);
}
const rows = [...covered].sort((a, b) => a - b).map((n) => `${n}\t${lines[n - 1] ?? ""}`);
if (rows.length === 0) throw new Error(`no covered rows for ${path}@${sha} — wrong file?`);

const stamp = new Date().toISOString().slice(0, 10);
const header = [
  `# ${OWNER}/${repo} ${path} @ ${sha}`,
  `# ${subject} — ${author}, fetched from ${BASE.replace(/^https?:\/\//, "")} ${stamp}`,
  `# Every line below is REAL: the line number and the real row text of every`,
  `# line the commit's own hunks cover. refsTouchedInTsv reads each covered`,
  `# line independently (no \\c/\\v-style state walk, unlike USFM), so nothing`,
  `# else in the file affects the mapping — the test rebuilds a stand-in file`,
  `# of exactly ${lines.length} lines with these rows at these line numbers.`,
  `lines\t${lines.length}`,
].join("\n");

mkdirSync(dirname(outPrefix), { recursive: true });
writeFileSync(`${outPrefix}.diff`, diff);
writeFileSync(`${outPrefix}.rows.txt`, `${header}\n${rows.join("\n")}\n`);
console.log(`${outPrefix}.diff      ${diff.length} bytes`);
console.log(`${outPrefix}.rows.txt  ${rows.length} covered rows, ${lines.length} file lines`);

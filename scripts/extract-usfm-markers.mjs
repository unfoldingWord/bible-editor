#!/usr/bin/env node
// Build the masterLineage per-verse fixtures (issue #557) from Door43.
//
// A commit's diff plus the file AS IT STOOD AT THAT COMMIT is what
// `refsTouchedInUsfm` maps. The diff is small enough to commit verbatim; the
// revision is NOT (24-JER.usfm was 4.6 MB on 2026-08-24), so what gets
// committed instead is the only part of it the mapping reads: the real line
// NUMBER and the real line TEXT of every line carrying a \c or \v marker, plus
// the file's real line count. Everything else in the file is inert to the
// mapping, which is why the reduction is lossless FOR THIS PURPOSE — verified
// by running the mapper over both and comparing ref sets.
//
// This script exists so that reduction is reproducible: a fixture nobody can
// re-derive is a measurement that decays into a claim.
//
// Usage (from the repo root):
//   node scripts/extract-usfm-markers.mjs <repo> <path> <full-40-char-sha> <out-prefix>
//
// The two committed fixtures came from:
//   node scripts/extract-usfm-markers.mjs en_ult 24-JER.usfm \
//     127cc1f3696994d967fc25fdd28a3a55d111132e api/src/fixtures/jer-ult-127cc1f3
//   node scripts/extract-usfm-markers.mjs en_ult 24-JER.usfm \
//     82aad43b84ab35ce7139c2e5e47fea0cd5ef41fb api/src/fixtures/jer-ult-82aad43b
//
// Writes <out-prefix>.diff and <out-prefix>.markers.txt.
//
// THE SHA MUST BE THE FULL 40 CHARS. Measured 2026-08-24: Gitea's raw endpoint
// silently serves master's CURRENT tip for an abbreviated ref — no error, no
// warning, just the wrong file — which would produce a fixture whose markers do
// not belong to the diff beside it. Set DCS_TOKEN for rate limits.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE = process.env.DCS_BASE_URL ?? "https://git.door43.org";
const OWNER = "unfoldingWord";
const FULL_SHA = /^[0-9a-f]{40}$/;
// Matches masterLineage.ts's CV_MARKER_RE — the space after the letter is what
// keeps \va / \vp / \ca out.
const CV = /\\(c|v) (\d+)(?:-(\d+))?/g;

const [repo, path, sha, outPrefix] = process.argv.slice(2);
if (!repo || !path || !sha || !outPrefix) {
  console.error("usage: node scripts/extract-usfm-markers.mjs <repo> <path> <full-sha> <out-prefix>");
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

// 3. The file at that exact revision, reduced to its \c / \v marker index.
const text = await (await get(`${api}/raw/${encodeURIComponent(path)}?ref=${sha}`, "text/plain")).text();
const lines = text.split("\n");
const rows = [];
lines.forEach((line, i) => {
  let end = 0;
  for (const m of line.matchAll(CV)) end = m.index + m[0].length;
  // Keep the real line text up to the end of its last marker: that is what the
  // walker reads, and it preserves real shapes like `\q1 \v 5`.
  if (end > 0) rows.push(`${i + 1}\t${line.slice(0, end)}`);
});
if (rows.length === 0) throw new Error(`no \\c / \\v markers found in ${path}@${sha} — wrong file?`);

const stamp = new Date().toISOString().slice(0, 10);
const header = [
  `# ${OWNER}/${repo} ${path} @ ${sha}`,
  `# ${subject} — ${author}, fetched from ${BASE.replace(/^https?:\/\//, "")} ${stamp}`,
  `# Every line below is REAL: the line number and the real line text up to the`,
  `# end of its last \\c / \\v marker. Nothing else in the file affects the`,
  `# hunk -> verse mapping, so the test rebuilds a stand-in file of exactly`,
  `# ${lines.length} lines with these markers at these line numbers.`,
  `lines\t${lines.length}`,
].join("\n");

mkdirSync(dirname(outPrefix), { recursive: true });
writeFileSync(`${outPrefix}.diff`, diff);
writeFileSync(`${outPrefix}.markers.txt`, `${header}\n${rows.join("\n")}\n`);
console.log(`${outPrefix}.diff        ${diff.length} bytes`);
console.log(`${outPrefix}.markers.txt ${rows.length} marker lines, ${lines.length} file lines`);

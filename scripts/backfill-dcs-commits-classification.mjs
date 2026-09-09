// One-off backfill: re-classify existing dcs_commits ledger rows against the
// CURRENT classifyForLedger (issue #696's fix, and any future revision of it).
//
// WHY THIS EXISTS. #696's fix only changes what NEW polls write. Rows already
// ingested before the fix deployed keep their old classification forever:
// polling resumes from the stored high-water sha, and every insert is
// `ON CONFLICT (repo, sha) DO NOTHING` (dcsCommitPoll.ts), so a re-poll never
// revisits a sha it already has a row for. The two live commits that
// motivated #696 (en_ust/en_ult, EZK 39, 2026-08-27) were written `human`
// BEFORE the fix landed and stay `human` in the ledger unless something
// explicitly re-derives them.
//
// WHAT THIS DOES. Re-runs classifyForLedger — the real function, imported,
// not re-implemented — against every row's STORED (repo, sha, message,
// author_email), and emits an UPDATE for any row whose classification would
// come out different today. Idempotent: a row already agreeing with the
// current classifier is a no-op, so re-running after a partial apply, or
// after a future classifyForLedger change, is safe to do again.
//
// SKIPPED, DELIBERATELY: rows whose STORED classification_reason is
// `bot_author_pipeline_trailer` (review finding on #699). ledgerRowsFromCommits
// stores only the SUBJECT in dcs_commits.message (subjectOf(c.message) —
// dcsCommitPoll.ts), but that reason is reached only via
// classifyMasterCommit's AI_PIPELINE_TRAILER check, which reads the message
// BODY (the `X-AI-Pipeline: bp-assistant/...` trailer, masterLineage.ts).
// Replaying such a row from the stored subject alone loses the trailer the
// classification depended on and would downgrade an already-correct `ai` row
// to `human` — silent data corruption once applied to prod (#701). No such
// row exists to legitimately need reclassifying under THIS backfill anyway:
// #696 only ever moved human -> ai, never touched the trailer route.
//
// Usage:
//   1. dump (read-only SELECT; never --file against --remote)
//      cd api
//      npx wrangler d1 execute bible_editor --remote --env production --json \
//        --command "SELECT repo, sha, message, author_email, classification, classification_reason
//                   FROM dcs_commits" > ../scripts/out/dcs-commits-dump.json
//   2. generate (writes SQL, touches nothing)
//      cd ..
//      node scripts/backfill-dcs-commits-classification.mjs scripts/out/dcs-commits-dump.json \
//        --out scripts/out/backfill-dcs-commits-classification.sql
//   3. apply (only after step 2 reports the rows it would change)
//      cd api
//      npx wrangler d1 execute bible_editor --remote --env production \
//        --file=../scripts/out/backfill-dcs-commits-classification.sql
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { classifyForLedger } from "../api/src/dcsCommitPoll.ts";

const inPath = process.argv[2];
if (!inPath) {
  console.error(
    "usage: node scripts/backfill-dcs-commits-classification.mjs <dump.json> [--out <file.sql>]",
  );
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx === -1 ? "scripts/out/backfill-dcs-commits-classification.sql" : process.argv[outIdx + 1];

const raw = JSON.parse(readFileSync(inPath, "utf8"));
// wrangler --json wraps results as [{ results: [...] }]; a plain array (e.g.
// a hand-trimmed fixture) is accepted too.
const rows = Array.isArray(raw) && raw[0]?.results ? raw[0].results : raw;

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

const statements = [];
let changed = 0;
let skipped = 0;
for (const row of rows) {
  // See the module comment: this reason can only have been reached by reading
  // the message BODY, which the ledger never stored. Reclassifying from the
  // stored subject alone risks downgrading an already-correct `ai` row.
  if (row.classification_reason === "bot_author_pipeline_trailer") {
    skipped++;
    continue;
  }
  const next = classifyForLedger({ sha: row.sha, message: row.message, authorEmail: row.author_email });
  if (next.kind === row.classification && next.reason === row.classification_reason) continue;
  changed++;
  statements.push(
    `UPDATE dcs_commits SET classification = ${q(next.kind)}, classification_reason = ${q(next.reason)} ` +
      `WHERE repo = ${q(row.repo)} AND sha = ${q(row.sha)};`,
  );
  console.log(
    `${row.repo} ${row.sha.slice(0, 10)}  ${row.classification} -> ${next.kind}  ` +
      `(${row.classification_reason} -> ${next.reason})  ${row.message.slice(0, 70)}`,
  );
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, statements.length ? statements.join("\n") + "\n" : "-- no rows to change\n");
console.log(
  `\n${changed} of ${rows.length} rows would change (${skipped} bot_author_pipeline_trailer row(s) ` +
    `skipped — body-dependent, not safe to replay from the stored subject). SQL written to ${outPath}.`,
);

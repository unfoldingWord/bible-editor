// Safety check for the SQL that scripts/scan-tn-quotes.mjs emits.
//
// Two properties, both cheap and both worth having before writing to prod:
//   1. Every proposed quote RESOLVES against its source verse. A repair that
//      still fails the lint is worse than no repair.
//   2. The repair uses exactly the source positions the original quote already
//      referenced — it may reorder and regroup them, but it must not introduce
//      a word the note never quoted, and (except for a de-duplication) must not
//      drop one. This is what catches a mis-assigned repeated word, which the
//      `confident` flag alone does not: `confident` only rules out RE-USING a
//      position, not choosing the wrong one among several identical surfaces.
//
// Checks EXACTLY the rows the repair actually wrote, not every row in the tn
// dump that happens to look unresolvable: the SET of rows to verify comes from
// the JSON sidecar scan-tn-quotes.mjs --repair writes (the same one
// rollback-tn-quotes.mjs reads), so a BOOK=-filtered or lock-filtered run is
// verified as what it actually did, not as a fresh independent re-scan. Each
// row's own oldQuote/newQuote from the sidecar is what gets compared — nothing
// is re-derived from the tn dump's CURRENT quote value, which may already have
// moved on (post-repair dump) or may not yet reflect the repair (pre-repair
// dump). The tn dump is used only to look up each row's ref_raw (the sidecar
// doesn't carry it) so its source-word span is resolved correctly for ranged/
// listed references; a sidecar row whose (book,id) the dump no longer carries
// is reported as a warning (the dump is stale relative to what was repaired)
// rather than crashing.
//
// A sidecar row this script CANNOT check (its (book,id) missing from the tn
// dump, its book missing from the source dump entirely, or its ref resolving
// to no source words — e.g. a genuinely cross-chapter ref, see #769) is an
// UNVERIFIED repair, not a verified-clean one. This is the gate run before
// applying production repair SQL, so by default any unverified row fails the
// run (nonzero exit) exactly like a row that failed a safety property — a run
// that skipped every row and printed "0 failed" must not read as "verified
// clean". Pass --allow-stale when an operator has already confirmed the gap is
// expected (e.g. a deliberately old dump) and wants to proceed anyway; skipped
// rows are still listed either way.
//
// Usage:
//   node --experimental-strip-types --no-warnings \
//     scripts/verify-tn-quote-repair.mjs scripts/out/dump/tn.json scripts/out/dump/src-all.json \
//     [scripts/out/repair-tn-quotes.json] [--allow-stale]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTnQuote, sourceWordsByRef, wordsForRow, QUOTE_GAP } from "../api/src/lint.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2);
const allowStale = rawArgs.includes("--allow-stale");
const [tnPath, srcPath, sidecarPathArg] = rawArgs.filter((a) => a !== "--allow-stale");
if (!tnPath || !srcPath) {
  console.error(
    "usage: node scripts/verify-tn-quote-repair.mjs <tn-dump.json> <src-dump.json> [sidecar.json] [--allow-stale]",
  );
  process.exit(1);
}
const sidecarPath = sidecarPathArg ?? "scripts/out/repair-tn-quotes.json";

function rowsOf(p) {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
  if (Array.isArray(raw) && Array.isArray(raw[0]?.results)) return raw[0].results;
  return raw.results ?? raw;
}

const JOINERS = /[⁠‍﻿]/g;
const SEPS = /[־׀׃,.;··:!?"“”'’‘()[\]{}—–-]+/g;
const norm = (s) => s.normalize("NFC").replace(SEPS, " ").replace(/\s+/g, " ").trim();
const bare = (s) => norm(s).replace(JOINERS, "");
// Split on the SAME gap-marker set resolveTnQuote does (`&`, `…`, or literal
// `...`) — not the bare literal "&". A failing quote written with an ellipsis
// gap marker used to tally as one giant "word" here, making a clean repair
// look like it ADDS/DROPS words it never touched.
const wordsOf = (q) => q.split(QUOTE_GAP).flatMap((p) => norm(p).split(" ")).filter(Boolean).map(bare);

const srcByBook = new Map();
for (const r of rowsOf(srcPath)) {
  if (!srcByBook.has(r.book)) srcByBook.set(r.book, []);
  srcByBook.get(r.book).push(r);
}
const wordsByBook = new Map();
for (const [b, rows] of srcByBook) wordsByBook.set(b, sourceWordsByRef(rows));

// Index the tn dump by "book/id" — composite key, same reason scan-tn-quotes.mjs
// keys its UPDATEs that way: tn `id` is NOT globally unique across books. "/"
// is a safe separator: neither a book code nor a row id ever contains one.
const tnKey = (book, id) => `${book}/${id}`;
const tnByKey = new Map();
for (const r of rowsOf(tnPath)) tnByKey.set(tnKey(r.book, r.id), r);

const sidecarFile = resolve(repoRoot, sidecarPath);
let sidecar;
try {
  sidecar = JSON.parse(readFileSync(sidecarFile, "utf8"));
} catch (err) {
  console.error(`cannot read sidecar ${sidecarFile}: ${err.message}`);
  process.exit(1);
}
const sidecarRows = Array.isArray(sidecar?.rows) ? sidecar.rows : null;
if (!sidecarRows) {
  console.error(
    `sidecar ${sidecarFile} is malformed (expected { generatedAt, book, rows: [...] }) — ` +
      "regenerate it with scan-tn-quotes.mjs --repair",
  );
  process.exit(1);
}
console.log(
  `verifying ${sidecarRows.length} row(s) from sidecar ${sidecarFile}` +
    (sidecar.generatedAt ? ` (run ${sidecar.generatedAt}${sidecar.book ? ` BOOK=${sidecar.book}` : ""})` : ""),
);

let repairs = 0, bad = 0, stale = 0, unverifiable = 0;
for (const s of sidecarRows) {
  const dumpRow = tnByKey.get(tnKey(s.book, s.id));
  if (!dumpRow) {
    stale++;
    unverifiable++;
    console.log(
      `\n?? ${s.book} ${s.id} — in the repair sidecar but missing from the tn dump ` +
        "(the dump is stale relative to what was repaired; UNVERIFIED, not crashing)",
    );
    continue;
  }
  const byRef = wordsByBook.get(s.book);
  if (!byRef) {
    unverifiable++;
    console.log(`\n?? ${s.book} ${s.id} — no source (UHB/UGNT) rows for this book in the src dump; UNVERIFIED`);
    continue;
  }
  // ref_raw comes from the CURRENT tn dump row, not the sidecar (which only
  // carries chapter/verse) — needed for ranged/listed references ("1:5-6").
  const words = wordsForRow(byRef, s.chapter, s.verse, dumpRow.ref_raw);
  if (!words.length) {
    unverifiable++;
    console.log(
      `\n?? ${s.book} ${dumpRow.ref_raw ?? `${s.chapter}:${s.verse}`} ${s.id} — ref resolves to no source words ` +
        "(a hole in the span, or a genuinely cross-chapter ref — see #769); UNVERIFIED",
    );
    continue;
  }
  repairs++;

  const problems = [];
  // Property 1: the repaired (sidecar) quote resolves against the source verse.
  const after = resolveTnQuote(s.newQuote, words);
  if (!after.ok) problems.push(`repaired quote STILL fails (${after.kind})`);

  // Property 2: a real multiset comparison of the sidecar's own before/after —
  // NOT re-derived from the dump. `Array.includes` would make this a SET
  // comparison, and a repair that drops one of two identical words would pass
  // unnoticed — the exact failure mode this check exists to catch.
  const tally = (ws) => ws.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
  const before = tally(wordsOf(s.oldQuote));
  const fixed = tally(wordsOf(s.newQuote));
  const added = [];
  const dropped = [];
  for (const [w, n] of fixed) if (n > (before.get(w) ?? 0)) added.push(`${w} x${n - (before.get(w) ?? 0)}`);
  for (const [w, n] of before) if (n > (fixed.get(w) ?? 0)) dropped.push(`${w} x${n - (fixed.get(w) ?? 0)}`);
  if (added.length) problems.push(`ADDS word(s) the note never quoted: ${added.join(", ")}`);
  if (dropped.length) problems.push(`DROPS quoted word(s): ${dropped.join(", ")}`);

  if (problems.length) {
    bad++;
    console.log(`\n!! ${s.book} ${dumpRow.ref_raw ?? `${s.chapter}:${s.verse}`} ${s.id}`);
    console.log(`   was: ${s.oldQuote}`);
    console.log(`   fix: ${s.newQuote}`);
    for (const p of problems) console.log(`   -> ${p}`);
  }
}
console.log(
  `\nchecked ${repairs} repair(s) from the sidecar (${stale} stale/missing from the tn dump, ` +
    `${unverifiable} total unverified); ${bad} failed a safety property`,
);
if (unverifiable && !allowStale) {
  console.error(
    `\nrefusing to exit 0: ${unverifiable} sidecar row(s) could not be verified at all — ` +
      "pass --allow-stale to proceed anyway once you've confirmed the gap is expected.",
  );
}
process.exit(bad || (unverifiable && !allowStale) ? 1 : 0);

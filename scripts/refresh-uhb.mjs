// Non-destructive prod-D1 UHB refresh generator (DRY RUN ONLY).
//
// Upstream unfoldingWord/hbo_uhb got ketiv-qere corrections. D1's `verses`
// rows for bible_version='UHB' were seeded once (bookImport.ts, at whatever
// time each book was first loaded) and are never touched by the nightly
// reimport (bookReimport.ts only refreshes ULT/UST; UHB/UGNT are read-only
// reference rows it treats as the *source* for alignment reconciliation, not
// something it writes). So a hand-run refresh is the only way to pull in an
// upstream UHB fix.
//
// This script is READ-ONLY against prod: it queries prod D1 (remote) for the
// current UHB rows, fetches current hbo_uhb master USFM live, reparses it with
// the exact same canonical pipeline production import uses
// (extractVersesForRange in api/src/importParsers.ts — the function
// bookImport.ts's insertVerses() and bookReimport.ts's chapter-reimport both
// call), and diffs. It writes:
//   scripts/out/refresh-uhb.sql             -- UPDATE statements, changed verses only
//   scripts/out/refresh-uhb-manifest.json   -- human-reviewable before/after log
//
// It NEVER calls `wrangler d1 execute --file` to apply anything. Applying is
// a separate, explicit, human-approved step.
//
// Run:  node scripts/refresh-uhb.mjs
// Requires: prod D1 read access (the same wrangler login used elsewhere in
// this repo) and network access to git.door43.org.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same canonical parse pipeline production import/reimport uses. Node 24
// strips the .ts types on import (see scripts/import-book.mjs for the same
// pattern).
import { extractVersesForRange } from "../api/src/importParsers.ts";
import { BOOK_NUMBERS } from "../api/src/dcsSources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");
const wranglerBin = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");

const GENERATED_UPDATED_AT = Math.floor(Date.now() / 1000); // epoch seconds, stamped at generation time
const CHURN_THRESHOLD = 0.6; // flag if changed/total exceeds this for a book
const MIN_USFM_BYTES = 500; // below this, treat as a suspiciously short fetch

// ---------- D1 (remote, prod) query helper ----------
// Invokes wrangler's own JS entry point directly via `node <bin.js> ...`
// rather than through npx/npx.cmd + a shell — on Windows, execFileSync with
// shell:true mangles quoting of a multi-word --command string (cmd.exe just
// concatenates args without re-escaping), and `--file` mode uses D1's bulk
// "import" API which returns an execution summary instead of SELECT rows.
// Calling the underlying wrangler.js with process.execPath avoids both.
function d1Query(sql) {
  const out = execFileSync(
    process.execPath,
    [
      wranglerBin,
      "d1",
      "execute",
      "bible_editor",
      "--remote",
      "--env",
      "production",
      "--json",
      "--command",
      sql,
    ],
    { cwd: apiDir, encoding: "utf8", maxBuffer: 1024 * 1024 * 512 },
  );
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`d1Query: no JSON array in wrangler output:\n${out}`);
  const parsed = JSON.parse(out.slice(start));
  if (!parsed[0]?.success) {
    throw new Error(`d1Query failed: ${JSON.stringify(parsed[0])}`);
  }
  return parsed[0].results ?? [];
}

// ---------- SQL escape helper (mirror of scripts/import-book.mjs's q()) ----------
function q(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------- canonical (key-sorted, whitespace-insensitive) JSON compare ----------
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}
function canonicalJSON(v) {
  return JSON.stringify(canonicalize(v));
}

// ---------- DCS raw fetch, with a short-read guard ----------
async function fetchUhbUsfm(book) {
  const num = BOOK_NUMBERS[book];
  if (!num) return { ok: false, reason: `unknown book code: ${book}` };
  const url = `https://git.door43.org/unfoldingWord/hbo_uhb/raw/branch/master/${num}-${book}.usfm`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return { ok: false, reason: `network error: ${e?.message ?? e}`, url };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, url };
  const buf = await res.arrayBuffer();
  const cl = res.headers.get("content-length");
  // Fail closed: a response we cannot verify byte-for-byte is not
  // authoritative. This is the exact truncated-fetch failure class that has
  // bitten this repo before (TWL PSA clobber, shrink guard) — a partial body
  // must never be treated as the source of truth for UPDATEs applied to prod.
  if (cl == null) {
    return {
      ok: false,
      reason: `no Content-Length header — cannot verify fetch completeness (fail-closed)`,
      url,
      completenessFailure: true,
    };
  }
  const expected = Number(cl);
  if (!Number.isFinite(expected)) {
    return {
      ok: false,
      reason: `unparseable Content-Length header: ${JSON.stringify(cl)} (fail-closed)`,
      url,
      completenessFailure: true,
    };
  }
  if (buf.byteLength !== expected) {
    return {
      ok: false,
      reason: `byte length mismatch (got ${buf.byteLength}B, expected ${expected}B) — truncated or corrupt fetch (fail-closed)`,
      url,
      completenessFailure: true,
    };
  }
  const text = new TextDecoder("utf-8").decode(buf);
  if (text.length < MIN_USFM_BYTES) {
    return { ok: false, reason: `suspiciously short body (${text.length} chars)`, url };
  }
  return { ok: true, text, url };
}

function snippet(s, n = 80) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function main() {
  console.log("Refreshing UHB from unfoldingWord/hbo_uhb master against prod D1 (DRY RUN — no writes).\n");

  const books = d1Query(
    `SELECT DISTINCT book FROM verses WHERE bible_version='UHB' ORDER BY book`,
  ).map((r) => r.book);
  console.log(`Found ${books.length} UHB books in prod D1: ${books.join(", ")}\n`);

  const sqlLines = [];
  sqlLines.push("-- Auto-generated by scripts/refresh-uhb.mjs. DRY RUN OUTPUT — review before applying.");
  sqlLines.push(`-- Generated: ${new Date().toISOString()}`);
  sqlLines.push("-- UPDATE-only, non-destructive. No BEGIN/COMMIT (remote D1 rejects explicit transactions).");

  const manifest = [];
  const skippedBooks = [];
  const churnFlags = [];
  let grandTotal = 0;
  let grandChanged = 0;
  let hadRejection = false; // fail-closed rejection (incomplete fetch, or D1 rows the fetch is missing) — forces a nonzero exit

  for (const book of books) {
    if (!/^[0-9A-Z]{2,3}$/.test(book)) {
      console.warn(`  ! skipping ${book}: unexpected book code shape`);
      skippedBooks.push({ book, reason: "unexpected book code shape" });
      continue;
    }

    const fetched = await fetchUhbUsfm(book);
    if (!fetched.ok) {
      if (fetched.completenessFailure) {
        console.error(`  !! ${book}: REJECTED (fail-closed) — ${fetched.reason}`);
        hadRejection = true;
      } else {
        console.warn(`  ! ${book}: SKIPPED — ${fetched.reason}`);
      }
      skippedBooks.push({ book, reason: fetched.reason });
      continue;
    }

    let fresh;
    try {
      fresh = extractVersesForRange(fetched.text, 1, 999);
    } catch (e) {
      console.warn(`  ! ${book}: SKIPPED — parse error: ${e?.message ?? e}`);
      skippedBooks.push({ book, reason: `parse error: ${e?.message ?? e}` });
      continue;
    }
    if (fresh.length === 0) {
      console.warn(`  ! ${book}: SKIPPED — parsed to 0 verses`);
      skippedBooks.push({ book, reason: "parsed to 0 verses" });
      continue;
    }

    const d1Rows = d1Query(
      `SELECT chapter, verse, verse_end, content_json, plain_text, version FROM verses WHERE book=${q(book)} AND bible_version='UHB' ORDER BY chapter, verse`,
    );
    const d1ByKey = new Map(d1Rows.map((r) => [`${r.chapter}:${r.verse}`, r]));
    const freshKeys = new Set(fresh.map((v) => `${v.chapter}:${v.verse}`));

    // Computed before we touch a single verse: if the fresh fetch is missing
    // verses D1 already has, that's the same truncated-fetch failure class as
    // the Content-Length gate above — a fetch/parse that appears to have lost
    // verses must not be treated as authoritative for the verses it DID find.
    const droppedFromD1 = [...d1ByKey.keys()].filter((k) => !freshKeys.has(k)).length;

    let changedCount = 0;
    let missingInD1 = 0; // verse exists upstream now but not in D1 (no INSERT emitted — non-destructive)
    const changedRefs = [];
    // Buffered per-book, not pushed straight to sqlLines/manifest: if
    // droppedFromD1 turns out nonzero we discard this book's UPDATEs
    // entirely instead of shipping a partial set generated from an
    // incomplete fetch.
    const bookSqlLines = [];
    const bookManifest = [];

    for (const v of fresh) {
      const key = `${v.chapter}:${v.verse}`;
      const d1Row = d1ByKey.get(key);
      if (!d1Row) {
        missingInD1++;
        continue;
      }

      let d1Parsed;
      try {
        d1Parsed = JSON.parse(d1Row.content_json);
      } catch {
        // Unparseable D1 content is itself notable — treat as changed so a
        // human sees it, rather than silently leaving corrupt JSON in place.
        d1Parsed = null;
      }
      let freshParsed;
      try {
        freshParsed = JSON.parse(v.contentJson);
      } catch (e) {
        console.warn(`  ! ${book} ${key}: freshly-built content_json failed to parse: ${e?.message ?? e}`);
        continue;
      }

      const verseEndChanged = (d1Row.verse_end ?? null) !== (v.verseEnd ?? null);
      const contentChanged =
        d1Parsed === null || canonicalJSON(d1Parsed) !== canonicalJSON(freshParsed);

      if (!contentChanged && !verseEndChanged) continue;

      changedCount++;
      changedRefs.push(key);
      // Version-CAS'd: the WHERE clause also requires the row still be at
      // the version we observed it at, so a row edited between generation
      // and apply no-ops instead of getting silently overwritten. See the
      // expected-count comment block appended to the end of the file.
      bookSqlLines.push(
        `UPDATE verses SET content_json=${q(v.contentJson)}, plain_text=${q(v.plainText)}, verse_end=${q(v.verseEnd)}, version=version+1, updated_at=${GENERATED_UPDATED_AT} WHERE book=${q(book)} AND chapter=${q(v.chapter)} AND verse=${q(v.verse)} AND bible_version='UHB' AND version=${q(d1Row.version)};`,
      );
      bookManifest.push({
        book,
        chapter: v.chapter,
        verse: v.verse,
        ref: `${book} ${key}`,
        before: snippet(d1Row.plain_text),
        after: snippet(v.plainText),
        verseEndChanged,
        d1Version: d1Row.version,
      });
    }

    grandTotal += fresh.length;

    const pct = fresh.length > 0 ? changedCount / fresh.length : 0;
    const churnLine = pct > CHURN_THRESHOLD;
    if (churnLine) {
      churnFlags.push({ book, changed: changedCount, total: fresh.length, pct });
    }

    if (droppedFromD1 > 0) {
      console.error(
        `  !! ${book}: REJECTED (fail-closed) — ${droppedFromD1} verse(s) present in D1 are absent from the ` +
          `freshly parsed fetch; suppressing all ${changedCount} would-be UPDATE(s) for this book rather than ` +
          `emitting SQL generated from what may be a truncated/incomplete fetch.`,
      );
      skippedBooks.push({ book, reason: `suppressed: ${droppedFromD1} verse(s) in D1 missing from fresh fetch` });
      hadRejection = true;
    } else {
      grandChanged += changedCount;
      sqlLines.push(...bookSqlLines);
      manifest.push(...bookManifest);
    }

    console.log(
      `  ${book}: ${fresh.length} verses, ${changedCount} changed` +
        (missingInD1 ? `, ${missingInD1} new (not in D1, no INSERT emitted)` : "") +
        (droppedFromD1 ? `, ${droppedFromD1} in D1 but absent upstream (UPDATEs suppressed, fail-closed)` : ""),
    );
    if (changedCount > 0) {
      console.log(`      sample changed refs: ${changedRefs.slice(0, 8).join(", ")}`);
    }
    if (churnLine) {
      console.log(
        `      !!! CHURN WARNING: ${(pct * 100).toFixed(1)}% of ${book} changed (> ${(CHURN_THRESHOLD * 100).toFixed(0)}%) — ` +
          `likely a normalization mismatch, not real ketiv-qere content. Investigate before ever applying this book's UPDATEs.`,
      );
    }
  }

  console.log("\n==== Summary ====");
  console.log(`Books processed: ${books.length - skippedBooks.length} / ${books.length}`);
  console.log(`Total UHB verses examined: ${grandTotal}`);
  console.log(`Total verses changed:      ${grandChanged}`);
  if (skippedBooks.length > 0) {
    console.log(`\nSkipped books (no SQL emitted for these):`);
    for (const s of skippedBooks) console.log(`  - ${s.book}: ${s.reason}`);
  }
  if (churnFlags.length > 0) {
    console.log(`\nChurn-flagged books (likely cosmetic/normalization mismatch, NOT real content changes):`);
    for (const c of churnFlags) {
      console.log(`  - ${c.book}: ${c.changed}/${c.total} changed (${(c.pct * 100).toFixed(1)}%)`);
    }
  }

  // Trailing comment block for whoever applies this file by hand: each
  // UPDATE above is version-gated (AND version=<observed>), so a row edited
  // between generation and apply no-ops instead of overwriting a newer edit.
  // That makes the changed-row count returned by the apply step the thing to
  // check — if it's short, some rows were stale and the manifest needs
  // regenerating, not re-running as-is.
  sqlLines.push("");
  sqlLines.push(`-- Expected changed-row count: ${grandChanged}`);
  sqlLines.push("-- Each UPDATE above is version-CAS'd (AND version=<observed>). After applying this");
  sqlLines.push("-- file, verify the reported changed-row count equals the expected count on the line");
  sqlLines.push("-- above. If it's lower, one or more rows changed since this file was generated (their");
  sqlLines.push("-- UPDATE no-op'd rather than overwriting) — regenerate against current prod D1 before");
  sqlLines.push("-- re-applying rather than assuming the shortfall is safe to ignore.");

  const outDir = resolve(repoRoot, "scripts/out");
  mkdirSync(outDir, { recursive: true });
  const sqlPath = resolve(outDir, "refresh-uhb.sql");
  const manifestPath = resolve(outDir, "refresh-uhb-manifest.json");
  writeFileSync(sqlPath, sqlLines.join("\n") + "\n", "utf8");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalVersesExamined: grandTotal,
        totalChanged: grandChanged,
        skippedBooks,
        churnFlags,
        changes: manifest,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\nWrote ${sqlPath} (${grandChanged} UPDATE statements)`);
  console.log(`Wrote ${manifestPath} (${manifest.length} manifest entries)`);
  console.log("\nDRY RUN ONLY — nothing was applied to prod. Review the files above before ever running them.");

  if (hadRejection) {
    console.error(
      "\nFAIL-CLOSED: one or more books were rejected (incomplete fetch, or D1 rows the fetch was missing) — see REJECTED lines above. Exiting nonzero.",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

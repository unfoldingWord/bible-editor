// Alignment-restoration script for the 1CH/NUM export-damage incident.
//
// WHAT HAPPENED
//   Our nightly DCS export committed ALIGNMENT LOSS onto en_ult (and en_ust)
//   master: verses that were fully aligned in the pre-export DCS baseline came
//   out of a later export with their `\zaln-s` milestones flattened — the words
//   went bare. The translators' TEXT edits in those verses are LEGITIMATE and
//   must be kept; only the lost alignment must be restored. So this is NOT a
//   blind revert.
//
// WHAT THIS SCRIPT DOES (read-only, NO prod access)
//   For each damaged verse it:
//     1. Fetches the pre-export BASELINE USFM (fully aligned, old text) and the
//        current MASTER USFM (translator's text, alignment lost) from DCS — both
//        read-only over HTTPS, cached under scripts/out/heal-cache/.
//     2. Parses each verse with usfm-js and runs the heal through the SAME
//        engine the live editor uses (web/src/lib/replace.ts smartEditVerse +
//        web/src/lib/usfm.ts extractEditableText):
//          - text UNCHANGED  -> the baseline aligned content already matches the
//                               current text; use it verbatim.
//          - text CHANGED    -> smartEditVerse(baseline, baselineEditable,
//                               masterEditable) re-applies the translator's net
//                               text edit onto the fully-aligned baseline through
//                               the CURRENT (fixed) engine, preserving alignment.
//     3. VALIDATES every heal:
//          (a) healed plain text === current master plain text, exactly;
//          (b) healed verse is fully aligned (0 bare `\w`; aligned-word count
//              within tolerance of the baseline).
//        A verse that fails validation is NOT healed automatically — it is
//        flagged "NEEDS MANUAL RE-ALIGNMENT" with the reason.
//     4. Prints a per-verse dry-run report and emits a PROD-APPLY PLAN (SQL) that
//        is NOT executed here.
//
//   IT NEVER TOUCHES PROD. Producing + validating the heal is the whole job;
//   the orchestrator runs the apply later, with explicit human approval and a
//   prod READ to get each row's current version (see PROD-APPLY notes below).
//
// USAGE (run from repo root or scripts/):
//   node --experimental-strip-types --no-warnings scripts/heal-align-1ch-num.mjs
//   node --experimental-strip-types --no-warnings scripts/heal-align-1ch-num.mjs --emit-sql
//   node --experimental-strip-types --no-warnings scripts/heal-align-1ch-num.mjs --offline   (cache only)
//
//   --emit-sql  also writes scripts/out/heal-1ch-num-apply.sql (the apply plan,
//               for human review — still NOT executed against prod).
//   --offline   never hits the network; fails if a needed file isn't cached.
//
// Idempotent: re-running re-fetches (or reuses cache) and re-derives the same
// heal. It performs no writes anywhere except its own cache + out artifacts.

import usfm from "usfm-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { smartEditVerse } from "../web/src/lib/replace.ts";
import { extractEditableText, extractPlainText } from "../web/src/lib/usfm.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out");
const CACHE_DIR = path.join(OUT_DIR, "heal-cache");
const OFFLINE = process.argv.includes("--offline");
const EMIT_SQL = process.argv.includes("--emit-sql");

// ---------------------------------------------------------------------------
// Incident manifest — the verses to heal and where their baselines live.
//
//   bibleVersion : D1 `bible_version` column value ('ULT' | 'UST').
//   baselineSha  : last DCS commit BEFORE our first export of this file (fully
//                  aligned, pre-damage). For 1CH/NUM ult these were handed to us
//                  by the investigation; for 1CH ust we CONFIRMED it from the
//                  DCS commits API (last non-`bible-editor-export` commit before
//                  the first export of 13-1CH.usfm = d7a567acfc, 2026-06-10
//                  "Merge auto-Carolyn1970-1CH into master").
//   file         : DCS path within the repo (NN-BOOK.usfm).
//   repo         : DCS repo slug.
//   verses       : [chapter, verse] pairs. For a merged-verse block keyed
//                  "17-18" in the USFM, pass the FIRST verse number (17): that
//                  is how D1 keys the row (verse=17, verse_end=18). `verseKey`
//                  overrides the usfm-js chapter-object key when it differs.
// ---------------------------------------------------------------------------
const MANIFEST = [
  {
    label: "1CH ult",
    repo: "unfoldingWord/en_ult",
    file: "13-1CH.usfm",
    bibleVersion: "ULT",
    book: "1CH",
    baselineSha: "666e6d9f8e",
    verses: [
      { chapter: 4, verse: 21 },
      { chapter: 4, verse: 30 },
      { chapter: 4, verse: 31 },
    ],
  },
  {
    label: "NUM ult",
    repo: "unfoldingWord/en_ult",
    file: "04-NUM.usfm",
    bibleVersion: "ULT",
    book: "NUM",
    baselineSha: "e2418e7221",
    verses: [
      { chapter: 24, verse: 7 },
      { chapter: 24, verse: 8 },
      { chapter: 24, verse: 16 },
      { chapter: 24, verse: 19 },
      { chapter: 24, verse: 20 },
      { chapter: 24, verse: 24 },
      { chapter: 18, verse: 23 },
    ],
  },
  {
    label: "1CH ust",
    repo: "unfoldingWord/en_ust",
    file: "13-1CH.usfm",
    bibleVersion: "UST",
    book: "1CH",
    // CONFIRMED export-caused (see header). Last non-export commit before our
    // first 1CH-ust export (8232d12027, 2026-06-11).
    baselineSha: "d7a567acfc",
    verses: [
      // Merged block "17-18": D1 row is verse 17, verse_end 18.
      { chapter: 4, verse: 17, verseKey: "17-18", verseEnd: 18 },
    ],
  },
];

// ---------------------------------------------------------------------------
// DCS fetch (read-only) with on-disk cache. Never writes to DCS or prod.
// ---------------------------------------------------------------------------
function cachePath(repo, ref, file) {
  const safe = `${repo}__${ref}__${file}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(CACHE_DIR, safe);
}

async function fetchUsfm(repo, ref, file) {
  const cp = cachePath(repo, ref, file);
  if (fs.existsSync(cp)) return fs.readFileSync(cp, "utf8");
  if (OFFLINE) throw new Error(`--offline and not cached: ${repo}@${ref}/${file}`);
  // master uses /raw/branch/master/<file>; a commit sha uses /raw/commit/<sha>/<file>.
  const url =
    ref === "master"
      ? `https://git.door43.org/${repo}/raw/branch/master/${file}`
      : `https://git.door43.org/${repo}/raw/commit/${ref}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const text = await res.text();
  // Sanity: USFM files start with \id. A truncated / error body must NOT be
  // treated as authoritative (this is exactly the failure class that caused the
  // damage we are healing).
  if (!text.startsWith("\\id ")) {
    throw new Error(`fetched body for ${url} is not USFM (no \\id header) — refusing`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cp, text, "utf8");
  return text;
}

// ---------------------------------------------------------------------------
// Verse helpers.
// ---------------------------------------------------------------------------
function getVerseObject(bookJson, chapter, verseKey) {
  const chap = bookJson.chapters?.[String(chapter)];
  if (!chap) return null;
  return chap[verseKey] ?? null;
}

// Count `\w` words split by whether they sit inside a `\zaln` milestone.
// `aligned` is the alignment health signal; `bare` > 0 means lost alignment.
// `bareWords` lists the bare `\w` surface forms so a partial heal is actionable
// (a single respelled proper noun is a trivial manual touch-up; a long bare run
// is a genuine full re-alignment).
function countWords(verseObj) {
  let aligned = 0;
  let bare = 0;
  const bareWords = [];
  const walk = (nodes, inZaln) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const isZaln = typeof n.tag === "string" && n.tag.startsWith("zaln");
      if (n.type === "word" && n.tag === "w") {
        if (inZaln) aligned++;
        else {
          bare++;
          if (typeof n.text === "string") bareWords.push(n.text);
        }
      }
      if (Array.isArray(n.children)) walk(n.children, inZaln || isZaln);
    }
  };
  walk(verseObj.verseObjects);
  return { aligned, bare, bareWords };
}

// ---------------------------------------------------------------------------
// The heal (per verse). Returns a structured result; never throws on a bad
// heal — it reports status instead so the dry-run can show every verse.
// ---------------------------------------------------------------------------
function healVerse(baselineVerse, currentVerse) {
  const baselineEditable = extractEditableText(baselineVerse);
  const currentEditable = extractEditableText(currentVerse);
  const baselinePlain = extractPlainText(baselineVerse);
  const currentPlain = extractPlainText(currentVerse);
  const baseCount = countWords(baselineVerse);
  const masterCount = countWords(currentVerse);

  const textChanged = baselineEditable !== currentEditable;

  let healedContent;
  let preservedAlignment = true;
  if (!textChanged) {
    // Text identical — only the alignment was lost in master. The baseline IS
    // the heal: it already matches the current text, fully aligned.
    healedContent = { verseObjects: baselineVerse.verseObjects };
  } else {
    // Re-apply the translator's net edit (baselineEditable -> currentEditable)
    // onto the fully-aligned baseline through the current engine.
    const res = smartEditVerse(
      { verseObjects: baselineVerse.verseObjects },
      baselineEditable,
      currentEditable,
    );
    healedContent = res.content;
    preservedAlignment = res.preservedAlignment;
  }

  // ---- VALIDATE ----------------------------------------------------------
  const healedPlain = extractPlainText(healedContent);
  const healedCount = countWords(healedContent);

  const plainMatches = healedPlain === currentPlain;
  // Fully aligned: no bare \w, and we didn't lose aligned words versus the
  // baseline (a small drop is allowed only if the translator deleted words —
  // we approximate "fully aligned" as: 0 bare AND healed aligned >= master's
  // surviving aligned count AND healed aligned > 0).
  const fullyAligned =
    healedCount.bare === 0 && healedCount.aligned > 0 && healedCount.aligned >= masterCount.aligned;

  const reasons = [];
  if (!plainMatches) reasons.push("healed plain text != current master plain text");
  if (healedCount.bare > 0) reasons.push(`${healedCount.bare} bare \\w remain after heal`);
  if (healedCount.aligned === 0) reasons.push("healed verse has no aligned words");
  if (healedCount.aligned > 0 && healedCount.aligned < masterCount.aligned)
    reasons.push(
      `healed aligned (${healedCount.aligned}) < master surviving aligned (${masterCount.aligned})`,
    );

  const pass = plainMatches && fullyAligned;

  return {
    textChanged,
    preservedAlignment,
    baselineEditable,
    currentEditable,
    baselinePlain,
    currentPlain,
    healedPlain,
    baseCount,
    masterCount,
    healedCount,
    plainMatches,
    fullyAligned,
    pass,
    reasons,
    healedContent,
  };
}

// ---------------------------------------------------------------------------
// PROD-APPLY PLAN (templated, NOT executed).
//
// Applying the heal to prod REQUIRES, OUTSIDE this script and with explicit
// human approval:
//   (a) a prod READ of each row's CURRENT version, filled in for <OLD_VERSION>
//       (= <NEW_VERSION> - 1) in the SQL below, and
//   (b) the audit edit_log row using that same prev/new version.
//
// OPTIMISTIC CONCURRENCY (the whole point of this template). The UPDATE is
// VERSION-CONDITIONAL — `WHERE ... AND version=<OLD_VERSION>` — matching the
// repo-wide invariant that every write carries an `If-Match`/`AND version=?`
// guard. The apply flow is: (1) human reads each prod row's version, (2) fills
// the placeholders, (3) applies. If a translator OR the nightly reimport edits a
// row between (1) and (3), the version no longer matches, the UPDATE changes 0
// rows, and the heal is a NO-OP for that row — the newer content is NOT
// clobbered and its version is NOT bumped. A skipped row must then be
// re-read and re-evaluated, not force-applied. (An earlier version of this
// template used `version=version+1` with an UNGUARDED WHERE, which would
// silently overwrite a concurrent edit — that was the bug this guard fixes.)
//
// The audit edit_log row is likewise GUARDED: it is an INSERT ... SELECT ...
// WHERE EXISTS keyed on the row now being at the POST-update version
// (<OLD_VERSION>+1) AND carrying exactly the healed content_json. It is written
// ONLY when OUR conditional UPDATE actually landed. Matching on content_json
// (not just the version number) is deliberate: a concurrent edit that happens to
// leave the row at <OLD_VERSION>+1 would not carry our content, so no orphan
// audit row is written for a heal that did not happen.
//
// Mirrors the repo's reference_prod_verse_data_repair pattern, made
// version-safe:
//   UPDATE verses SET content_json=?, plain_text=?, version=version+1,
//          updated_at=<epoch>, updated_by=<uid>
//     WHERE book=? AND chapter=? AND verse=? AND bible_version=?
//       AND version=<OLD_VERSION>;
//   INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,
//                         action,payload_json,source,created_at)
//     SELECT 'verse','BOOK/CH/V/VER',<book>,<uid>,<old>,<old+1>,
//            'heal-export-align-loss',<json>,'data_repair',<epoch>
//      WHERE EXISTS (SELECT 1 FROM verses
//                     WHERE book=? AND chapter=? AND verse=? AND bible_version=?
//                       AND version=<OLD_VERSION>+1 AND content_json=<healed json>);
//
// The orchestrator must read the literal prev/new versions at apply time; the
// SQL below leaves <OLD_VERSION>/<NEW_VERSION> as placeholders for that step.
//
// content_json is embedded as a double-quoted JSON string; single quotes inside
// it (apostrophes in text) are escaped by doubling ('->'') for the SQL literal.
// ---------------------------------------------------------------------------
function sqlEscape(s) {
  return s.replace(/'/g, "''");
}

function applyPlanSql(entry, verse, heal) {
  const rowKey = `${entry.book}/${verse.chapter}/${verse.verse}/${entry.bibleVersion}`;
  const contentJson = JSON.stringify(heal.healedContent);
  const plainText = heal.healedPlain;
  const payload = JSON.stringify({
    content: heal.healedContent,
    incident: "1ch-num-export-align-loss",
    baselineSha: entry.baselineSha,
  });
  const rowMatch =
    `book='${entry.book}' AND chapter=${verse.chapter} AND verse=${verse.verse} ` +
    `AND bible_version='${entry.bibleVersion}'`;
  const lines = [];
  lines.push(`-- ${entry.label} ${verse.chapter}:${verse.verse}  (row_key ${rowKey})`);
  lines.push(`-- baseline ${entry.baselineSha} -> heal; aligned ${heal.healedCount.aligned}, bare ${heal.healedCount.bare}`);
  lines.push(`-- REQUIRES: prod READ for <OLD_VERSION>; explicit human approval. Do NOT run blind.`);
  lines.push(`-- Version-conditional: if the row moved on (translator/reimport edit) this is a no-op and the audit row is skipped.`);
  // version-conditional UPDATE: the `AND version=<OLD_VERSION>` pin makes this a
  // no-op (0 rows changed) if the row was edited between the prod READ and the
  // apply, so a stale/concurrent edit is never clobbered.
  lines.push(
    `UPDATE verses SET content_json='${sqlEscape(contentJson)}', ` +
      `plain_text='${sqlEscape(plainText)}', version=version+1, ` +
      `updated_at=unixepoch(), updated_by=2 ` +
      `WHERE ${rowMatch} AND version=<OLD_VERSION>;`,
  );
  // audit row guarded on OUR heal having landed: it fires only if the row is now
  // at version <OLD_VERSION>+1 AND carries exactly the healed content_json we just
  // wrote. Matching on content_json (not just the post-update version number) is
  // deliberate — a concurrent edit that happens to leave the row at <OLD_VERSION>+1
  // would NOT carry our content, so the EXISTS is false and no orphan audit row is
  // written. A no-op UPDATE (row moved on) likewise leaves the EXISTS false.
  lines.push(
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at) ` +
      `SELECT 'verse','${rowKey}','${entry.book}',2,<OLD_VERSION>,<NEW_VERSION>,` +
      `'heal-export-align-loss','${sqlEscape(payload)}','data_repair',unixepoch() ` +
      `WHERE EXISTS (SELECT 1 FROM verses WHERE ${rowMatch} ` +
      `AND version=<OLD_VERSION>+1 AND content_json='${sqlEscape(contentJson)}');`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = [];
  const sqlBlocks = [];
  const summaryRows = [];

  const log = (s) => {
    report.push(s);
    console.log(s);
  };

  log("Alignment-restoration dry-run — 1CH/NUM export damage");
  log(`Generated: ${new Date().toISOString()}`);
  log(OFFLINE ? "(offline: cache only)" : "(read-only DCS fetch; cached under scripts/out/heal-cache/)");
  log("");

  for (const entry of MANIFEST) {
    log(`==== ${entry.label}  (${entry.repo}/${entry.file}) ====`);
    log(`baseline commit: ${entry.baselineSha}   bible_version: ${entry.bibleVersion}`);
    let baselineUsfm;
    let masterUsfm;
    try {
      baselineUsfm = await fetchUsfm(entry.repo, entry.baselineSha, entry.file);
      masterUsfm = await fetchUsfm(entry.repo, "master", entry.file);
    } catch (err) {
      log(`  FETCH ERROR: ${err.message}`);
      log("");
      continue;
    }
    const baselineJson = usfm.toJSON(baselineUsfm);
    const masterJson = usfm.toJSON(masterUsfm);

    for (const verse of entry.verses) {
      const key = verse.verseKey ?? String(verse.verse);
      const ref = `${verse.chapter}:${verse.verse}`;
      const baselineVerse = getVerseObject(baselineJson, verse.chapter, key);
      const masterVerse = getVerseObject(masterJson, verse.chapter, key);
      if (!baselineVerse) {
        log(`  ${ref}  BASELINE MISSING (key "${key}") — SKIP`);
        summaryRows.push({ ref: `${entry.label} ${ref}`, status: "BASELINE MISSING" });
        continue;
      }
      if (!masterVerse) {
        log(`  ${ref}  MASTER MISSING (key "${key}") — SKIP`);
        summaryRows.push({ ref: `${entry.label} ${ref}`, status: "MASTER MISSING" });
        continue;
      }

      const heal = healVerse(baselineVerse, masterVerse);
      const status = heal.pass
        ? "HEALABLE"
        : "NEEDS MANUAL RE-ALIGNMENT";

      log(`  ${ref}  ${status}`);
      log(
        `      text-changed: ${heal.textChanged}   ` +
          `aligned: baseline ${heal.baseCount.aligned} | master ${heal.masterCount.aligned} (bare ${heal.masterCount.bare}) | healed ${heal.healedCount.aligned} (bare ${heal.healedCount.bare})`,
      );
      log(`      plain-text matches master: ${heal.plainMatches}   fully-aligned: ${heal.fullyAligned}   preservedAlignment: ${heal.preservedAlignment}`);
      if (!heal.pass) {
        log(`      REASON: ${heal.reasons.join("; ")}`);
        if (heal.healedCount.bareWords.length) {
          log(`      bare \\w after heal: ${JSON.stringify(heal.healedCount.bareWords)}`);
        }
      }

      summaryRows.push({
        ref: `${entry.label} ${ref}`,
        textChanged: heal.textChanged,
        baseAligned: heal.baseCount.aligned,
        healedAligned: heal.healedCount.aligned,
        healedBare: heal.healedCount.bare,
        plainMatches: heal.plainMatches,
        status,
      });

      if (heal.pass) {
        sqlBlocks.push(applyPlanSql(entry, verse, heal));
      }
    }
    log("");
  }

  // ---- Summary table -----------------------------------------------------
  log("==== SUMMARY ====");
  log(
    pad("verse", 16) +
      pad("text-chg", 9) +
      pad("base-al", 8) +
      pad("heal-al", 8) +
      pad("heal-bare", 10) +
      pad("plain-ok", 9) +
      "status",
  );
  for (const r of summaryRows) {
    if (r.status === "BASELINE MISSING" || r.status === "MASTER MISSING") {
      log(pad(r.ref, 16) + pad("-", 9) + pad("-", 8) + pad("-", 8) + pad("-", 10) + pad("-", 9) + r.status);
      continue;
    }
    log(
      pad(r.ref, 16) +
        pad(String(r.textChanged), 9) +
        pad(String(r.baseAligned), 8) +
        pad(String(r.healedAligned), 8) +
        pad(String(r.healedBare), 10) +
        pad(String(r.plainMatches), 9) +
        r.status,
    );
  }
  const healable = summaryRows.filter((r) => r.status === "HEALABLE");
  const manual = summaryRows.filter((r) => r.status === "NEEDS MANUAL RE-ALIGNMENT");
  log("");
  log(`HEALABLE BY ENGINE: ${healable.length}   NEEDS MANUAL RE-ALIGNMENT: ${manual.length}`);
  if (manual.length) log(`  manual: ${manual.map((r) => r.ref).join(", ")}`);

  // ---- Write artifacts ---------------------------------------------------
  const reportPath = path.join(OUT_DIR, "heal-1ch-num-dryrun.txt");
  fs.writeFileSync(reportPath, report.join("\n") + "\n", "utf8");
  log("");
  log(`Dry-run report written: ${path.relative(path.join(__dirname, ".."), reportPath)}`);

  if (EMIT_SQL) {
    const sqlPath = path.join(OUT_DIR, "heal-1ch-num-apply.sql");
    const header = [
      "-- PROD-APPLY PLAN — NOT executed by the dry-run. Requires explicit human approval.",
      "-- Each block REQUIRES a prod READ to fill <OLD_VERSION>/<NEW_VERSION> before applying.",
      "-- The UPDATE is VERSION-CONDITIONAL (WHERE ... AND version=<OLD_VERSION>): if the row",
      "-- moved on (a translator or the nightly reimport edited it after the version was read),",
      "-- the UPDATE changes 0 rows and the heal is SKIPPED — the newer content is NOT clobbered.",
      "-- The audit edit_log row is INSERT ... SELECT ... WHERE EXISTS on the post-update version,",
      "-- so a skipped (no-op) UPDATE leaves no orphan audit row. updated_by/user_id 2 = known-good user.",
      "-- A skipped row must be re-read and re-evaluated, NOT force-applied.",
      "-- Apply (after approval) from api/:  npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/out/heal-1ch-num-apply.sql",
      "",
    ].join("\n");
    fs.writeFileSync(sqlPath, header + sqlBlocks.join("\n\n") + "\n", "utf8");
    log(`Prod-apply SQL written: ${path.relative(path.join(__dirname, ".."), sqlPath)}`);
  } else {
    log("(re-run with --emit-sql to also write scripts/out/heal-1ch-num-apply.sql)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

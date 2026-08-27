// Read-only production audit that PREPARES (but never executes) the repair for
// issue #606 — HOS ULT 11:9 / 11:11 / 11:12 lost every `\q` poetry marker when
// bethoakes edited them on 2026-08-11, and the loss shipped to Door43 master.
//
// Run (from the repo root):
//   node --experimental-strip-types --no-warnings scripts/prepare-hos11-q-restoration.mjs
//
// Writes reports/hos11-q-restoration-review-<date>.json and
// reports/restore-hos11-q-markers-<date>.sql. It NEVER writes to production;
// the generated SQL still has to be reviewed and run by hand.
//
// ---------------------------------------------------------------------------
// WHAT IS RESTORED, AND WHAT IS DELIBERATELY NOT
//
// Two different things changed in that editing session, and only one of them is
// a defect:
//
//   * The `\q1`/`\q2` losses are the engine bug (#606). Poetry lineation is not
//     something a translator strips while removing quote marks, and all three
//     verses lost 100% of their markers in one twelve-minute window. RESTORED.
//
//   * The curly-quote removals (`“ ”` at 11:9 / 11:11 / 11:12, and 11:1) may be
//     a real editorial decision about direct speech. NOT TOUCHED. The repair
//     starts from the CURRENT production tree — whatever bethoakes left behind —
//     and only re-inserts markers, so every character she changed survives.
//
// The restoration source is the last nightly export BEFORE the damage,
// commit ce54ec0d7660ce3ff35660439c73033ce24d1183 of unfoldingWord/en_ult
// (2026-08-11 16:46Z; the damaged export is 4c6c654ba499a091448e648f4924eb1e31ddaf70
// at 21:24Z). It is parsed with the production importer (extractVersesForRange)
// so the marker nodes are byte-identical in shape to what D1 stores.
//
// Mechanism: the pre-damage markers are re-anchored onto the CURRENT editable
// text by word position, then applied through the production edit engine
// (smartEditVerse). Because the marker-stripped text is unchanged, that is a
// PURE MARKER EDIT — reconcileMarkers re-places the markers and every `\w` and
// `\zaln` milestone rides through verbatim. The script refuses to emit SQL for
// any verse where that invariant does not hold exactly.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractVersesForRange } from "../api/src/importParsers.ts";
import { extractEditableText, extractPlainText } from "../web/src/lib/usfm.ts";
import { smartEditVerse } from "../web/src/lib/replace.ts";

const INCIDENT = "#606 HOS ULT 11 \\q poetry-marker loss on an in-app edit (2026-08-11)";
const PRE_DAMAGE_SHA = "ce54ec0d7660ce3ff35660439c73033ce24d1183";
const RAW_URL = `https://git.door43.org/unfoldingWord/en_ult/raw/commit/${PRE_DAMAGE_SHA}/28-HOS.usfm`;
const BOOK = "HOS";
const CHAPTER = 11;
const BIBLE_VERSION = "ULT";
const VERSES = [9, 11, 12];
const SOURCE = "data_repair_q_marker_loss"; // matches the 9 existing rows for this failure class

const repoRoot = resolve(import.meta.dirname, "..");
const apiDir = resolve(repoRoot, "api");
const wranglerBin = resolve(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const outDir = resolve(repoRoot, "reports");
const generatedAt = new Date().toISOString();
const stamp = generatedAt.slice(0, 10);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function executeD1(sql) {
  // Hard stop: this script is an AUDIT. It reads production and writes files;
  // it must never be the thing that mutates a verse. Anything but a SELECT is a
  // programming error here, not a runtime condition.
  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error(`executeD1 is read-only; refusing non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  const raw = execFileSync(
    process.execPath,
    [wranglerBin, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql],
    { cwd: apiDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw).flatMap((batch) => batch.results ?? []);
}

const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}\p{N}]+)*/gu;
const MARKER_RE = /\\((?:pi[1-3]|q[1-4]|qm[1-3])|(?:mi|nb|pc|pi|qm|p|m|q|b|ts\\\*)(?=\s|$|[^a-z0-9]))\s?/g;
const words = (s) => [...s.matchAll(WORD_RE)].map((m) => m[0]);
const stripMarkers = (s) => s.replace(new RegExp(MARKER_RE.source, MARKER_RE.flags), "").replace(/\s+/g, " ").trim();

function countQ(content) {
  let n = 0;
  const walk = (arr) => {
    for (const v of arr ?? []) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.tag === "string" && /^q[1-4]?$/.test(v.tag)) n++;
      if (Array.isArray(v.children)) walk(v.children);
    }
  };
  walk(content?.verseObjects);
  return n;
}

// Every \w word in document order with its \zaln ancestry — the alignment
// fingerprint the repair must leave bit-identical.
function alignmentFingerprint(content) {
  const out = [];
  const walk = (nodes, strongs) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") out.push(`${n.text}|${n.occurrence}/${n.occurrences}|${strongs.join(">")}`);
      if (Array.isArray(n.children)) walk(n.children, n.tag === "zaln" ? [...strongs, n.strong] : strongs);
    }
  };
  walk(content?.verseObjects, []);
  return out.join("\n");
}

// The pre-damage marker layout, each marker anchored by how many words precede
// it — the same anchor reconcileMarkers uses.
function markerAnchors(editable) {
  const re = new RegExp(MARKER_RE.source, MARKER_RE.flags);
  const anchors = [];
  let m;
  while ((m = re.exec(editable)) !== null) {
    anchors.push({ tag: m[1], wordsBefore: words(stripMarkers(editable.slice(0, m.index))).length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return anchors;
}

// Re-insert `anchors` into the (marker-free) current editable text, each just
// BEFORE the word it preceded originally, so the punctuation that led the
// marker in the source USFM still leads it here (reconcileMarkers reads that
// as `leadPunct` to decide which side of the line break punctuation lands on).
function applyAnchors(plain, anchors) {
  const starts = [...plain.matchAll(WORD_RE)].map((m) => m.index);
  let out = "";
  let cursor = 0;
  for (const a of anchors) {
    // A marker anchored past the last word is verse-final (the `\q1` that
    // renders just before the NEXT verse's `\v`); it lands at the very end.
    const at = a.wordsBefore >= starts.length ? plain.length : starts[a.wordsBefore];
    out += plain.slice(cursor, at);
    // Interior anchors already carry the gap's trailing space; a verse-final one
    // does not, and extractEditableText always separates the marker token.
    if (out.length && !/\s$/.test(out)) out += " ";
    out += `\\${a.tag} `;
    cursor = at;
  }
  return (out + plain.slice(cursor)).replace(/\s+/g, " ").trim();
}

// Whitespace around a marker token is cosmetic — the marker is a zero-width
// anchor. Canonicalize it so a stray space can never fail an otherwise-correct
// comparison (the text itself is compared separately, and exactly).
const canonEditable = (s) => s.replace(/\s*(\\(?:pi[1-3]|q[1-4]|qm[1-3]|mi|nb|pc|pi|qm|p|m|q|b|ts\\\*))\s*/g, " $1 ").replace(/\s+/g, " ").trim();

// --- 1. Pre-damage trees, straight from the last clean export ---------------
console.error(`fetching ${RAW_URL}`);
const preUsfm = await fetch(RAW_URL).then((r) => {
  if (!r.ok) throw new Error(`Door43 fetch failed: ${r.status}`);
  return r.text();
});
const preVerses = extractVersesForRange(preUsfm, CHAPTER, CHAPTER);

// --- 2. Current production rows --------------------------------------------
const live = executeD1(
  `SELECT verse, version, content_json, plain_text FROM verses
    WHERE book = ${q(BOOK)} AND bible_version = ${q(BIBLE_VERSION)}
      AND chapter = ${CHAPTER} AND verse IN (${VERSES.join(",")}) ORDER BY verse`,
);

const reviewed = [];
const blocked = [];

for (const vnum of VERSES) {
  const rowKey = `${BOOK}/${CHAPTER}/${vnum}/${BIBLE_VERSION}`;
  const dbRow = live.find((r) => Number(r.verse) === vnum);
  const preRow = preVerses.find((v) => v.verse === vnum);
  if (!dbRow || !preRow) { blocked.push({ rowKey, reason: "row missing in D1 or in the pre-damage export" }); continue; }

  const oldContentJson = dbRow.content_json;
  const currentContent = JSON.parse(oldContentJson);
  const preContent = JSON.parse(preRow.contentJson);

  const currentEditable = extractEditableText(currentContent);
  const preEditable = extractEditableText(preContent);
  const anchors = markerAnchors(preEditable);

  // GATE A — the damage must actually be present, and be marker-only.
  if (countQ(currentContent) !== 0) { blocked.push({ rowKey, reason: `already has ${countQ(currentContent)} \\q marker(s) — re-check before repairing` }); continue; }
  if (anchors.length === 0) { blocked.push({ rowKey, reason: "pre-damage revision has no markers to restore" }); continue; }

  // GATE B — the word sequence must be untouched since the pre-damage export.
  // If a word changed, bethoakes (or a later sync) rewrote text and the
  // pre-damage marker anchors can no longer be trusted; a human must adjudicate.
  const preWords = words(stripMarkers(preEditable));
  const curWords = words(currentEditable);
  if (preWords.join(" ") !== curWords.join(" ")) {
    blocked.push({ rowKey, reason: "word sequence differs from the pre-damage export — anchors unreliable", preWords: preWords.join(" "), curWords: curWords.join(" ") });
    continue;
  }

  // --- 3. Build the repair through the production engine -------------------
  const repairedEditable = applyAnchors(currentEditable, anchors);
  // The restoration must not alter a single character of text.
  if (stripMarkers(repairedEditable) !== currentEditable) {
    blocked.push({ rowKey, reason: "re-anchoring changed the verse text — refusing" });
    continue;
  }
  const result = smartEditVerse(currentContent, currentEditable, repairedEditable);
  const newContent = result.content;
  const newContentJson = JSON.stringify(newContent);
  const plainText = extractPlainText(newContent);

  // GATE C — the repair restored exactly the lost markers and nothing else.
  const problems = [];
  if (countQ(newContent) !== anchors.length) problems.push(`marker count ${countQ(newContent)} != ${anchors.length} expected`);
  if (alignmentFingerprint(newContent) !== alignmentFingerprint(currentContent)) problems.push("alignment fingerprint changed");
  if (extractPlainText(currentContent) !== plainText) problems.push("plain_text changed");
  if (canonEditable(extractEditableText(newContent)) !== canonEditable(repairedEditable)) problems.push("editable text is not the intended layout");
  if (problems.length) { blocked.push({ rowKey, reason: problems.join("; ") }); continue; }

  reviewed.push({
    rowKey, book: BOOK, chapter: CHAPTER, verse: vnum, bibleVersion: BIBLE_VERSION,
    currentVersion: Number(dbRow.version),
    markersRestored: anchors.map((a) => `\\${a.tag}@${a.wordsBefore}`),
    // The bit a human must eyeball: the text is IDENTICAL before and after the
    // repair; only these markers come back.
    textUnchanged: currentEditable,
    editableBefore: currentEditable,
    editableAfter: repairedEditable,
    // bethoakes' own edit, preserved verbatim by this repair.
    translatorTextChangeSincePreDamage: stripMarkers(preEditable) === currentEditable
      ? "(none)"
      : { preDamage: stripMarkers(preEditable), current: currentEditable },
    oldContentJson, newContentJson, plainText,
    dbPlainText: dbRow.plain_text,
  });
}

// --- 4. Emit CAS-guarded SQL (never executed here) --------------------------
const sql = [
  `-- ${INCIDENT}`,
  `-- Generated ${generatedAt} by scripts/prepare-hos11-q-restoration.mjs — REVIEW BEFORE RUNNING.`,
  `-- Restores the \\q poetry markers lost on 2026-08-11. Restoration source:`,
  `--   ${RAW_URL}`,
  `-- The translator's own text edits (the removed curly quotes) are PRESERVED —`,
  `-- each UPDATE below changes marker structure only; plain_text is unchanged.`,
  `-- Every UPDATE is CAS-guarded on (version, content_json): if anything has`,
  `-- moved since this file was generated, that statement matches 0 rows, skips`,
  `-- its audit row, and the trailing SELECT reports it.`,
  `--`,
  `-- Apply STATEMENT BY STATEMENT with --command, not --file.`,
  `-- \`wrangler d1 execute --file\` has silently executed only part of a multi-`,
  `-- statement file and still reported success, which here would land an UPDATE`,
  `-- with no matching edit_log row (or vice versa). Paste each statement below`,
  `-- individually:`,
  `--   cd api`,
  `--   npx wrangler d1 execute bible_editor --remote --env production --command "<one statement>"`,
  `-- After each UPDATE, run its INSERT immediately, then re-run the verification`,
  `-- SELECT at the bottom before moving to the next verse.`,
  `--`,
  `-- NOTE: HOS is a locked book (PUBLISHED_BOOKS). Coordinate the unlock and a`,
  `-- re-export before expecting these markers to reach Door43 master.`,
  ``,
];
for (const row of reviewed) {
  const payload = JSON.stringify({
    plain_text: row.plainText,
    content: JSON.parse(row.newContentJson),
    repair: { incident: INCIDENT, restored_from_commit: PRE_DAMAGE_SHA, markers_restored: row.markersRestored, text_unchanged: true },
  });
  sql.push(
    `-- ${row.rowKey}: restore ${row.markersRestored.join(", ")} (text untouched).`,
    `UPDATE verses`,
    // updated_by is deliberately NOT touched. Setting it to NULL would mark the
    // row PRISTINE, and a pristine row silently adopts master on the next sync
    // (#639) — master still holds the marker-free text, so the repair would be
    // reverted overnight with no flag. The verse really was last edited by that
    // user; leaving the column alone keeps it correctly "edited".
    `   SET content_json = ${q(row.newContentJson)}, version = version + 1,`,
    `       updated_at = unixepoch()`,
    ` WHERE book = ${q(row.book)} AND chapter = ${row.chapter} AND verse = ${row.verse} AND bible_version = ${q(row.bibleVersion)}`,
    `   AND version = ${row.currentVersion} AND content_json = ${q(row.oldContentJson)};`,
    // Gated on the verse's NEW version, not on changes(): the runbook applies
    // these one --command at a time, and changes() does not carry across
    // separate wrangler invocations. The NOT EXISTS also makes a re-run safe.
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)`,
    `SELECT 'verse', ${q(row.rowKey)}, ${q(row.book)}, NULL, ${row.currentVersion}, ${row.currentVersion + 1}, 'restore', ${q(payload)}, ${q(SOURCE)}`,
    ` WHERE EXISTS (SELECT 1 FROM verses`,
    `                WHERE book = ${q(row.book)} AND chapter = ${row.chapter} AND verse = ${row.verse}`,
    `                  AND bible_version = ${q(row.bibleVersion)} AND version = ${row.currentVersion + 1})`,
    `   AND NOT EXISTS (SELECT 1 FROM edit_log`,
    `                    WHERE kind = 'verse' AND row_key = ${q(row.rowKey)}`,
    `                      AND new_version = ${row.currentVersion + 1} AND source = ${q(SOURCE)});`,
    ``,
  );
}
sql.push(
  `-- Verification: each repaired row must be at its old version + 1 with the`,
  `-- expected marker count, and plain_text must be byte-identical to before.`,
  `SELECT book || '/' || chapter || '/' || verse || '/' || bible_version AS row_key, version,`,
  `       (SELECT count(*) FROM json_tree(verses.content_json) jt`,
  `         WHERE jt.key = 'tag' AND jt.value IN ('q','q1','q2','q3','q4')) AS q_marker_count`,
  `  FROM verses`,
  ` WHERE book = ${q(BOOK)} AND bible_version = ${q(BIBLE_VERSION)} AND chapter = ${CHAPTER}`,
  ` ORDER BY verse;`,
);

// --- 5. Dry-run the generated SQL against an in-memory copy -----------------
// Validates quoting, JSON validity, the version bump, the audit gating, and the
// text-unchanged invariant without touching production.
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE verses (
    book TEXT, chapter INTEGER, verse INTEGER, bible_version TEXT,
    content_json TEXT NOT NULL, plain_text TEXT, version INTEGER NOT NULL,
    updated_by INTEGER, updated_at INTEGER,
    PRIMARY KEY (book, chapter, verse, bible_version)
  );
  CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
    user_id INTEGER, prev_version INTEGER, new_version INTEGER, action TEXT,
    payload_json TEXT, source TEXT, restored_from_version INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);
const seed = db.prepare(`INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`);
for (const row of reviewed) seed.run(row.book, row.chapter, row.verse, row.bibleVersion, row.oldContentJson, row.dbPlainText, row.currentVersion);
db.exec(sql.join("\n"));
for (const row of reviewed) {
  const liveRow = db.prepare(`SELECT content_json, plain_text, version FROM verses WHERE book=? AND chapter=? AND verse=? AND bible_version=?`)
    .get(row.book, row.chapter, row.verse, row.bibleVersion);
  if (liveRow.version !== row.currentVersion + 1) throw new Error(`${row.rowKey}: version did not advance by exactly 1`);
  if (liveRow.content_json !== row.newContentJson) throw new Error(`${row.rowKey}: content_json is not the reviewed tree`);
  if (liveRow.plain_text !== row.dbPlainText) throw new Error(`${row.rowKey}: plain_text changed — the repair must be marker-only`);
  const audit = db.prepare(`SELECT * FROM edit_log WHERE row_key=?`).all(row.rowKey);
  if (audit.length !== 1 || audit[0].prev_version !== row.currentVersion || audit[0].new_version !== row.currentVersion + 1 || audit[0].source !== SOURCE) {
    throw new Error(`${row.rowKey}: invalid audit row`);
  }
  if (countQ(JSON.parse(liveRow.content_json)) !== row.markersRestored.length) throw new Error(`${row.rowKey}: wrong marker count after repair`);
}
db.close();

mkdirSync(outDir, { recursive: true });
const reviewPath = resolve(outDir, `hos11-q-restoration-review-${stamp}.json`);
const sqlPath = resolve(outDir, `restore-hos11-q-markers-${stamp}.sql`);
writeFileSync(reviewPath, JSON.stringify({ generatedAt, incident: INCIDENT, restoredFromCommit: PRE_DAMAGE_SHA, sourceUrl: RAW_URL, rows: reviewed.map(({ oldContentJson, newContentJson, ...r }) => r), blocked }, null, 2) + "\n");
writeFileSync(sqlPath, sql.join("\n") + "\n");
console.log(JSON.stringify({
  reviewPath, sqlPath,
  repairRows: reviewed.length,
  markers: reviewed.map((r) => `${r.rowKey}: ${r.markersRestored.join(" ")}`),
  blocked,
  localSqlValidation: "passed",
  executed: false,
}, null, 2));

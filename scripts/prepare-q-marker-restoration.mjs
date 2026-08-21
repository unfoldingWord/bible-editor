// Read-only production audit that prepares (but never executes) a CAS-guarded
// SQL repair for the 14 add-then-lose poetry-marker incidents identified on
// 2026-08-12. The generated SQL must still be reviewed before execution.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const candidates = [
  ["MIC/5/13/UST", 18, 19], ["EZK/17/9/ULT", 6, 7],
  ["EZK/17/8/ULT", 7, 8], ["EZK/17/8/UST", 6, 7],
  ["MIC/4/13/ULT", 3, 4], ["MIC/4/13/UST", 4, 5],
  ["EZK/13/8/ULT", 6, 7], ["EZK/13/8/UST", 7, 8],
  ["EZK/7/4/UST", 6, 7], ["EZK/7/4/ULT", 6, 7],
  ["EZK/7/5/ULT", 4, 5], ["NUM/21/29/ULT", 4, 5],
  ["NUM/21/29/UST", 4, 5], ["NUM/21/28/ULT", 4, 5],
].map(([rowKey, restoreVersion, lossVersion]) => ({ rowKey, restoreVersion, lossVersion }));
const nextRows = {
  "MIC/5/13/UST": "MIC/5/14/UST",
  "EZK/17/8/ULT": "EZK/17/9/ULT", "EZK/17/8/UST": "EZK/17/9/UST",
  "MIC/4/13/ULT": "MIC/5/1/ULT", "MIC/4/13/UST": "MIC/5/1/UST",
  "EZK/13/8/ULT": "EZK/13/9/ULT", "EZK/13/8/UST": "EZK/13/9/UST",
  "EZK/7/4/UST": "EZK/7/5/UST", "EZK/7/4/ULT": "EZK/7/5/ULT",
  "NUM/21/29/ULT": "NUM/21/30/ULT", "NUM/21/29/UST": "NUM/21/30/UST",
  "NUM/21/28/ULT": "NUM/21/29/ULT",
};

const tags = new Set(["q", "q1", "q2", "q3", "q4"]);
const repoRoot = resolve(import.meta.dirname, "..");
const apiDir = resolve(repoRoot, "api");
const wranglerBin = resolve(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const outDir = resolve(repoRoot, "reports");

function executeD1(sql) {
  const raw = execFileSync(process.execPath, [wranglerBin, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql], {
    cwd: apiDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw).flatMap((batch) => batch.results ?? []);
}

function parseContent(value) {
  let result = value;
  for (let i = 0; i < 2 && typeof result === "string"; i++) result = JSON.parse(result);
  return result;
}

function flatten(content) {
  const stream = [];
  const visit = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, [...path, index]));
      return;
    }
    if (!node || typeof node !== "object") return;
    if (tags.has(node.tag)) stream.push({ kind: "marker", tag: node.tag, node, path });
    const childrenKey = Array.isArray(node.verseObjects) ? "verseObjects" : Array.isArray(node.children) ? "children" : null;
    if (childrenKey) visit(node[childrenKey], [...path, childrenKey]);
    else if (typeof node.text === "string") {
      for (const word of node.text.match(/[\p{L}\p{N}'’-]+/gu) ?? []) stream.push({ kind: "word", word, path });
    }
  };
  visit(content);
  const words = stream.filter((item) => item.kind === "word");
  let wordIndex = 0;
  const markers = [];
  for (const item of stream) {
    if (item.kind === "word") wordIndex++;
    else markers.push({
      ...item,
      wordIndex,
      before: words[wordIndex - 1]?.word ?? null,
      after: words[wordIndex]?.word ?? null,
      signature: `${item.tag}|${wordIndex}`,
    });
  }
  return { stream, words, markers };
}

function difference(left, right) {
  const counts = new Map();
  for (const item of right) counts.set(item.signature, (counts.get(item.signature) ?? 0) + 1);
  return left.filter((item) => {
    const count = counts.get(item.signature) ?? 0;
    if (!count) return true;
    counts.set(item.signature, count - 1);
    return false;
  });
}

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

const candidateKeys = candidates.map(({ rowKey }) => rowKey);
const candidateSqlKeys = candidateKeys.map(q).join(",");
const queryKeys = [...new Set([...candidateKeys, ...Object.values(nextRows)])];
const keys = queryKeys.map(q).join(",");
const snapshots = executeD1(`
  SELECT 'history' AS snapshot_kind, row_key, new_version AS version,
         json_extract(payload_json, '$.plain_text') AS plain_text,
         json_extract(payload_json, '$.content') AS content_json
    FROM edit_log
   WHERE kind = 'verse' AND row_key IN (${keys})
  UNION ALL
  SELECT 'current', book || '/' || chapter || '/' || verse || '/' || bible_version,
         version, plain_text, content_json
    FROM verses
   WHERE book || '/' || chapter || '/' || verse || '/' || bible_version IN (${keys})
`.replace(/\s+/g, " ").trim());

const reviewedAll = candidates.map((candidate) => {
  const get = (kind, version) => snapshots.find((row) => row.snapshot_kind === kind && row.row_key === candidate.rowKey && (version === undefined || row.version === version));
  const restoreRow = get("history", candidate.restoreVersion);
  const lossRow = get("history", candidate.lossVersion);
  const currentRow = get("current");
  if (!restoreRow || !lossRow || !currentRow) throw new Error(`missing snapshot for ${candidate.rowKey}`);
  const restoreContent = parseContent(restoreRow.content_json);
  const lossContent = parseContent(lossRow.content_json);
  const currentContent = parseContent(currentRow.content_json);
  const [book, chapter, verse, bibleVersion] = candidate.rowKey.split("/");
  const missing = difference(flatten(restoreContent).markers, flatten(lossContent).markers);
  if (missing.length !== 1) throw new Error(`${candidate.rowKey}: expected one historical missing marker, found ${missing.length}`);
  const marker = missing[0];
  if (marker.path.length !== 2 || marker.path[0] !== "verseObjects" || typeof marker.path[1] !== "number") {
    throw new Error(`${candidate.rowKey}: missing marker is not top-level (${JSON.stringify(marker.path)})`);
  }
  const currentFlat = flatten(currentContent);
  if (currentFlat.markers.some((item) => item.signature === marker.signature)) {
    throw new Error(`${candidate.rowKey}: marker is already present in current D1`);
  }

  const verseObjects = currentContent.verseObjects;
  let insertAt;
  let placement;
  const markersAtBoundary = (flat) => flat.markers
    .filter((item) => marker.before === null ? item.before === null : marker.after === null ? item.after === null : item.before === marker.before && item.after === marker.after)
  const restoreBoundary = markersAtBoundary(flatten(restoreContent));
  const lossBoundary = markersAtBoundary(flatten(lossContent));
  const currentBoundary = markersAtBoundary(currentFlat);
  const restoreBoundaryTags = restoreBoundary.map((item) => item.tag);
  const lossBoundaryTags = lossBoundary.map((item) => item.tag);
  const currentBoundaryTags = currentBoundary.map((item) => item.tag);
  const nextRowKey = nextRows[candidate.rowKey] ?? null;
  const nextRow = nextRowKey ? snapshots.find((row) => row.snapshot_kind === "current" && row.row_key === nextRowKey) : null;
  const nextLeadingTags = nextRow ? flatten(parseContent(nextRow.content_json)).markers.filter((item) => item.before === null).map((item) => item.tag) : [];
  const missingBoundaryIndex = restoreBoundary.findIndex((item) => JSON.stringify(item.path) === JSON.stringify(marker.path));
  const expectedCurrentTags = restoreBoundaryTags.filter((_, index) => index !== missingBoundaryIndex);
  if (missingBoundaryIndex < 0 || JSON.stringify(currentBoundaryTags) !== JSON.stringify(expectedCurrentTags)) {
    return {
      ...candidate, book, chapter: Number(chapter), verse: Number(verse), bibleVersion,
      currentVersion: currentRow.version, status: "REVIEW_REQUIRED_BOUNDARY_CHANGED",
      reason: `current boundary [${currentBoundaryTags}] is not historical boundary [${restoreBoundaryTags}] minus this marker`,
      marker: { tag: marker.tag, node: marker.node, historicalPath: marker.path, wordIndex: marker.wordIndex, restoreBoundaryTags, lossBoundaryTags, currentBoundaryTags, nextRowKey, nextLeadingTags },
    };
  }
  if (marker.after === null && nextLeadingTags.includes(marker.tag)) {
    return {
      ...candidate, book, chapter: Number(chapter), verse: Number(verse), bibleVersion,
      currentVersion: currentRow.version, status: "NO_RESTORE_PRESENT_IN_NEXT_ROW",
      reason: `\\${marker.tag} is already the leading marker on ${nextRowKey}; restoring the trailing copy would duplicate the USFM boundary`,
      marker: { tag: marker.tag, node: marker.node, historicalPath: marker.path, wordIndex: marker.wordIndex, restoreBoundaryTags, lossBoundaryTags, currentBoundaryTags, nextRowKey, nextLeadingTags },
    };
  }
  let baseInsertAt;
  if (marker.before === null) {
    baseInsertAt = 0;
    placement = `before first word ${marker.after}`;
  } else if (marker.after === null) {
    baseInsertAt = verseObjects.length;
    placement = `after final word ${marker.before}`;
  } else {
    const afterWord = currentFlat.words.find((word, index) => index > 0 && word.word === marker.after && currentFlat.words[index - 1]?.word === marker.before);
    if (!afterWord || afterWord.path[0] !== "verseObjects" || typeof afterWord.path[1] !== "number") {
      throw new Error(`${candidate.rowKey}: cannot map marker boundary ${marker.before}|${marker.after} into current top-level structure`);
    }
    baseInsertAt = afterWord.path[1];
    placement = `between ${marker.before} and ${marker.after}`;
  }
  const nextBoundaryMarker = currentBoundary[missingBoundaryIndex];
  const previousBoundaryMarker = currentBoundary[missingBoundaryIndex - 1];
  if (nextBoundaryMarker) insertAt = nextBoundaryMarker.path[1];
  else if (previousBoundaryMarker) insertAt = previousBoundaryMarker.path[1] + 1;
  else insertAt = baseInsertAt;
  const newContent = structuredClone(currentContent);
  newContent.verseObjects.splice(insertAt, 0, structuredClone(marker.node));
  const newContentJson = JSON.stringify(newContent);
  return {
    ...candidate, book, chapter: Number(chapter), verse: Number(verse), bibleVersion,
    status: "RESTORE",
    currentVersion: currentRow.version, plainText: currentRow.plain_text,
    oldContentJson: currentRow.content_json, newContentJson,
    marker: { tag: marker.tag, node: marker.node, historicalPath: marker.path, wordIndex: marker.wordIndex, placement, insertAt, restoreBoundaryTags, lossBoundaryTags, currentBoundaryTags, nextRowKey, nextLeadingTags },
  };
});
for (const row of reviewedAll) {
  if (row.status !== "RESTORE" || row.marker.placement?.startsWith("before first word") !== true) continue;
  const trailingTwin = reviewedAll.find((other) => other.status === "RESTORE" && nextRows[other.rowKey] === row.rowKey && other.marker.tag === row.marker.tag);
  if (trailingTwin) {
    row.status = "NO_RESTORE_DUPLICATE_PLANNED_BOUNDARY";
    row.reason = `\\${row.marker.tag} is also being restored canonically as the trailing marker on ${trailingTwin.rowKey}`;
  }
}
const reviewed = reviewedAll.filter((row) => row.status === "RESTORE");

const incident = "q-marker-loss-editor-save-2026-08-12";
const generatedAt = new Date().toISOString();
const sql = [
  `-- Prepared ${generatedAt}; READ AND REVIEW BEFORE EXECUTION.`,
  `-- Restores only the ${reviewed.length} historically added-then-lost poetry marker nodes that still pass boundary review.`,
  `-- Full content + version CAS means a concurrent/current edit causes that row to skip.`,
  `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and executes a SQL file atomically.`,
  `-- Intended command (NOT executed):`,
  `--   cd api`,
  `--   npx wrangler d1 execute bible_editor --remote --env production --file ../reports/restore-q-markers-2026-08-12.sql`,
  ``,
];
for (const row of reviewed) {
  const payload = JSON.stringify({ plain_text: row.plainText, content: JSON.parse(row.newContentJson), repair: { incident, restored_from_version: row.restoreVersion, marker: row.marker.node } });
  sql.push(
    `-- ${row.rowKey}: restore \\${row.marker.tag} ${row.marker.placement} from historical v${row.restoreVersion}.`,
    `UPDATE verses`,
    `   SET content_json = ${q(row.newContentJson)}, version = version + 1,`,
    `       updated_at = unixepoch(), updated_by = NULL`,
    ` WHERE book = ${q(row.book)} AND chapter = ${row.chapter} AND verse = ${row.verse} AND bible_version = ${q(row.bibleVersion)}`,
    `   AND version = ${row.currentVersion} AND content_json = ${q(row.oldContentJson)};`,
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, restored_from_version)`,
    `SELECT 'verse', ${q(row.rowKey)}, ${q(row.book)}, NULL, ${row.currentVersion}, ${row.currentVersion + 1}, 'restore', ${q(payload)}, 'data_repair_q_marker_loss', ${row.restoreVersion}`,
    ` WHERE changes() > 0;`,
    `SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('CAS_FAILED_${row.rowKey}', '$') END;`,
    ``,
  );
}
sql.push(
  `-- Returns all original candidates; restored rows must be at expected_version + 1 with marker_count increased by one.`,
  `SELECT book || '/' || chapter || '/' || verse || '/' || bible_version AS row_key, version,`,
  `       (SELECT count(*) FROM json_tree(verses.content_json) jt`,
  `         WHERE jt.key = 'tag' AND jt.value IN ('q','q1','q2','q3','q4')) AS q_marker_count`,
  `  FROM verses`,
  ` WHERE book || '/' || chapter || '/' || verse || '/' || bible_version IN (${candidateSqlKeys})`,
  ` ORDER BY row_key;`,
);

// Execute the exact generated SQL against an in-memory schema seeded with the
// production snapshots just read. This validates SQL quoting, JSON validity,
// version increments, audit gating, and the one-marker-only invariant without
// touching production.
const validationDb = new DatabaseSync(":memory:");
validationDb.exec(`
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
const seed = validationDb.prepare(`INSERT INTO verses
  (book, chapter, verse, bible_version, content_json, plain_text, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`);
for (const row of reviewed) seed.run(row.book, row.chapter, row.verse, row.bibleVersion, row.oldContentJson, row.plainText, row.currentVersion);
validationDb.exec(sql.join("\n"));
for (const row of reviewed) {
  const live = validationDb.prepare(`SELECT content_json, plain_text, version FROM verses WHERE book=? AND chapter=? AND verse=? AND bible_version=?`).get(row.book, row.chapter, row.verse, row.bibleVersion);
  if (live.version !== row.currentVersion + 1 || live.content_json !== row.newContentJson || live.plain_text !== row.plainText) {
    throw new Error(`${row.rowKey}: local SQL validation changed an unexpected field`);
  }
  const audit = validationDb.prepare(`SELECT * FROM edit_log WHERE row_key=?`).all(row.rowKey);
  if (audit.length !== 1 || audit[0].prev_version !== row.currentVersion || audit[0].new_version !== row.currentVersion + 1 || audit[0].source !== "data_repair_q_marker_loss") {
    throw new Error(`${row.rowKey}: local SQL validation found an invalid audit row`);
  }
  const oldCount = flatten(parseContent(row.oldContentJson)).markers.length;
  const newCount = flatten(parseContent(live.content_json)).markers.length;
  if (newCount !== oldCount + 1) throw new Error(`${row.rowKey}: repair did not add exactly one marker`);
}
validationDb.close();

mkdirSync(outDir, { recursive: true });
const reviewPath = resolve(outDir, "q-marker-restoration-review-2026-08-12.json");
const sqlPath = resolve(outDir, "restore-q-markers-2026-08-12.sql");
writeFileSync(reviewPath, JSON.stringify({ generatedAt, incident, rows: reviewedAll.map(({ oldContentJson, newContentJson, plainText, ...row }) => row) }, null, 2) + "\n");
writeFileSync(sqlPath, sql.join("\n") + "\n");
console.log(JSON.stringify({ reviewPath, sqlPath, restoreRows: reviewed.length, reviewRequired: reviewedAll.filter((row) => row.status !== "RESTORE").map((row) => `${row.rowKey}: ${row.reason}`), localSqlValidation: "passed", markers: reviewed.map((row) => `${row.rowKey} \\${row.marker.tag} ${row.marker.placement}`) }, null, 2));

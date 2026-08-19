import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const tags = ["q", "q1", "q2", "q3", "q4"];
const countExpr = (alias, tag) =>
  `(length(${alias}.payload_json)-length(replace(${alias}.payload_json,char(34)||'tag'||char(34)||':'||char(34)||'${tag}'||char(34),'')))/${tag.length + 8}`;

const markerColumns = tags
  .map((tag) => `${countExpr("el", tag)} AS ${tag}_count`)
  .join(",");

const lagColumns = tags
  .map((tag) => `LAG(${tag}_count) OVER w AS before_${tag}`)
  .join(",");

const sql = `
WITH snapshots AS (
  SELECT el.id, el.row_key, el.book, el.user_id, el.source, el.action,
         el.prev_version, el.new_version, el.created_at,
         json_extract(el.payload_json, '$.plain_text') AS plain_text,
         ${markerColumns}
    FROM edit_log el
   WHERE el.kind = 'verse' AND el.payload_json IS NOT NULL
), totals AS (
  SELECT *, q_count + q1_count + q2_count + q3_count + q4_count AS q_total
    FROM snapshots
), sequenced AS (
  SELECT *,
         LAG(q_total) OVER w AS before_total,
         LAG(q_total, 2) OVER w AS two_before_total,
         ${lagColumns},
         LAG(plain_text) OVER w AS before_plain_text,
         LAG(plain_text, 2) OVER w AS two_before_plain_text,
         LAG(created_at) OVER w AS before_created_at,
         LAG(user_id) OVER w AS before_user_id,
         LAG(source) OVER w AS before_source
    FROM totals
  WINDOW w AS (PARTITION BY row_key ORDER BY new_version, created_at, id)
)
SELECT s.id, s.row_key, s.book,
       COALESCE(u.dcs_username, '(no user)') AS username,
       COALESCE(s.source, 'manual') AS write_source,
       s.action, s.prev_version, s.new_version,
       s.user_id, s.before_user_id, COALESCE(s.before_source, 'manual') AS before_write_source,
       s.created_at, s.before_created_at,
       datetime(s.created_at, 'unixepoch') AS created_utc,
       s.two_before_total, s.before_total, s.q_total AS after_total,
       s.before_q, s.q_count AS after_q,
       s.before_q1, s.q1_count AS after_q1,
       s.before_q2, s.q2_count AS after_q2,
       s.before_q3, s.q3_count AS after_q3,
       s.before_q4, s.q4_count AS after_q4,
       CASE WHEN s.plain_text = s.before_plain_text THEN 1 ELSE 0 END AS plain_text_unchanged,
       CASE WHEN s.before_plain_text = s.two_before_plain_text THEN 1 ELSE 0 END AS prior_plain_text_unchanged
  FROM sequenced s
  LEFT JOIN users u ON u.id = s.user_id
 WHERE s.before_total IS NOT NULL AND s.q_total < s.before_total
 ORDER BY s.created_at DESC, s.id DESC
`.replace(/\s+/g, " ").trim();

const apiDir = resolve(import.meta.dirname, "..", "api");
const wranglerBin = resolve(apiDir, "..", "node_modules", "wrangler", "bin", "wrangler.js");
function executeD1(command) {
  const output = execFileSync(process.execPath, [
    wranglerBin,
    "d1",
    "execute",
    "bible_editor",
    "--remote",
    "--env",
    "production",
    "--json",
    "--command",
    command,
  ], { cwd: apiDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(output).flatMap((batch) => batch.results ?? []);
}

const events = executeD1(sql).map((event) => ({
  ...event,
  markers_lost: event.before_total - event.after_total,
  evidence:
    event.write_source === "manual" && event.plain_text_unchanged
      ? "strong"
      : event.write_source === "manual"
        ? "manual"
        : event.write_source === "dcs_reimport"
          ? "reimport"
          : "automation",
}));

function parseContent(value) {
  let parsedValue = value;
  for (let i = 0; i < 2 && typeof parsedValue === "string"; i++) {
    try { parsedValue = JSON.parse(parsedValue); } catch { return null; }
  }
  return parsedValue;
}

function markerPositions(value) {
  const stream = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (tags.includes(node.tag)) stream.push({ kind: "marker", tag: node.tag });
    const children = node.verseObjects ?? node.children;
    if (Array.isArray(children)) visit(children);
    else if (typeof node.text === "string") {
      for (const word of node.text.match(/[\p{L}\p{N}'’-]+/gu) ?? []) stream.push({ kind: "word", word });
    }
  };
  visit(parseContent(value));
  const words = stream.filter((item) => item.kind === "word").map((item) => item.word);
  let wordIndex = 0;
  return stream.flatMap((item) => {
    if (item.kind === "word") {
      wordIndex++;
      return [];
    }
    return [{
      tag: item.tag,
      word_index: wordIndex,
      before: words[wordIndex - 1] ?? "start",
      after: words[wordIndex] ?? "end",
      signature: `${item.tag}|${wordIndex}`,
    }];
  });
}

function multisetDifference(left, right) {
  const remaining = new Map();
  for (const item of right) remaining.set(item.signature, (remaining.get(item.signature) ?? 0) + 1);
  return left.filter((item) => {
    const count = remaining.get(item.signature) ?? 0;
    if (count) {
      remaining.set(item.signature, count - 1);
      return false;
    }
    return true;
  });
}

const baseRestorationCandidates = events
  .filter((event) =>
    event.write_source === "manual" &&
    event.before_write_source === "manual" &&
    event.user_id === event.before_user_id &&
    event.two_before_total !== null &&
    event.before_total > event.two_before_total &&
    event.markers_lost === 1 &&
    event.plain_text_unchanged &&
    event.prior_plain_text_unchanged &&
    event.created_at - event.before_created_at <= 15 * 60,
  )
  .map((event) => ({
    ...event,
    seconds_after_add: event.created_at - event.before_created_at,
    restore_version: event.prev_version,
  }));

const candidateKeys = [...new Set(baseRestorationCandidates.map((event) => event.row_key))];
const quotedKeys = candidateKeys.map((key) => `'${key.replaceAll("'", "''")}'`).join(",");
const candidatePayloads = candidateKeys.length
  ? executeD1(`
      SELECT 'history' AS snapshot_kind, row_key, new_version AS version,
             json_extract(payload_json, '$.content') AS content_json
        FROM edit_log
       WHERE kind = 'verse' AND row_key IN (${quotedKeys})
      UNION ALL
      SELECT 'current' AS snapshot_kind,
             book || '/' || chapter || '/' || verse || '/' || bible_version AS row_key,
             version, content_json
        FROM verses
       WHERE book || '/' || chapter || '/' || verse || '/' || bible_version IN (${quotedKeys})
    `.replace(/\s+/g, " ").trim())
  : [];

const restorationCandidates = baseRestorationCandidates
  .map((event) => {
    const restore = candidatePayloads.find((row) => row.snapshot_kind === "history" && row.row_key === event.row_key && row.version === event.restore_version);
    const loss = candidatePayloads.find((row) => row.snapshot_kind === "history" && row.row_key === event.row_key && row.version === event.new_version);
    const current = candidatePayloads.find((row) => row.snapshot_kind === "current" && row.row_key === event.row_key);
    const restoredMarkers = multisetDifference(
      markerPositions(restore?.content_json),
      markerPositions(loss?.content_json),
    );
    const currentMarkers = markerPositions(current?.content_json);
    return {
      ...event,
      current_version: current?.version ?? "?",
      restored_markers: restoredMarkers,
      still_missing: restoredMarkers.every(
        (marker) => !currentMarkers.some((current) => current.signature === marker.signature),
      ),
    };
  });

const gitSince = "2026-06-01T00:00:00Z";
const qMarkerRe = /\\q(?:[1-4])?(?=\\|\s|$)/g;
const repoSpecs = [
  { resource: "ULT", path: resolve(import.meta.dirname, "..", "..", "en_ult") },
  { resource: "UST", path: resolve(import.meta.dirname, "..", "..", "en_ust") },
];

function markerCounts(text) {
  const counts = { q: 0, q1: 0, q2: 0, q3: 0, q4: 0 };
  for (const marker of text.match(qMarkerRe) ?? []) counts[marker.slice(1)]++;
  return counts;
}

function addCounts(target, source) {
  for (const tag of tags) target[tag] += source[tag];
}

function scanDoor43History({ resource, path }) {
  const log = execFileSync(
    "git",
    ["log", "--first-parent", `--since=${gitSince}`, "--format=%H%x1f%P%x1f%cI%x1f%an%x1f%ae%x1f%s%x1e", "origin/master"],
    { cwd: path, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const commits = log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, committed_at, author, email, subject] = record.split("\x1f");
      return { sha, parent: parents.split(" ")[0], committed_at, author, email, subject };
    })
    .filter((commit) => commit.parent);

  const results = [];
  for (const commit of commits) {
    const diff = execFileSync(
      "git",
      ["diff", "--no-ext-diff", "--unified=0", commit.parent, commit.sha, "--", "*.usfm"],
      { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    let file = "";
    const files = new Map();
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) {
        file = line.slice(6).trim();
        continue;
      }
      if (!file || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      const direction = line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : null;
      if (!direction) continue;
      const counts = markerCounts(line.slice(1));
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      if (!total) continue;
      const entry = files.get(file) ?? {
        file,
        added: { q: 0, q1: 0, q2: 0, q3: 0, q4: 0 },
        deleted: { q: 0, q1: 0, q2: 0, q3: 0, q4: 0 },
        deleted_lines: [],
      };
      addCounts(entry[direction], counts);
      if (direction === "deleted" && entry.deleted_lines.length < 8) {
        entry.deleted_lines.push(line.slice(1).trim().slice(0, 240));
      }
      files.set(file, entry);
    }

    const losses = [...files.values()]
      .map((entry) => ({
        ...entry,
        added_total: Object.values(entry.added).reduce((sum, count) => sum + count, 0),
        deleted_total: Object.values(entry.deleted).reduce((sum, count) => sum + count, 0),
      }))
      .map((entry) => ({ ...entry, net_lost: entry.deleted_total - entry.added_total }))
      .filter((entry) => entry.net_lost > 0);
    if (!losses.length) continue;
    results.push({
      resource,
      ...commit,
      files: losses,
      net_lost: losses.reduce((sum, entry) => sum + entry.net_lost, 0),
      deleted_total: losses.reduce((sum, entry) => sum + entry.deleted_total, 0),
      added_total: losses.reduce((sum, entry) => sum + entry.added_total, 0),
    });
  }
  return results;
}

const door43Commits = repoSpecs.flatMap(scanDoor43History).sort((a, b) =>
  b.committed_at.localeCompare(a.committed_at),
);

function bookFromFile(file) {
  return file.match(/^\d{2}-([1-3]?[A-Z]{2,3})\.usfm$/)?.[1] ?? "";
}

for (const commit of door43Commits) {
  const when = Date.parse(commit.committed_at);
  const books = new Set(commit.files.map((entry) => bookFromFile(entry.file)));
  const nearby = events.filter((event) => {
    const [book, , , version] = event.row_key.split("/");
    const eventTime = Date.parse(`${event.created_utc.replace(" ", "T")}Z`);
    const leadTime = when - eventTime;
    return books.has(book) && version === commit.resource && leadTime >= 0 && leadTime <= 36 * 60 * 60 * 1000;
  });
  commit.nearby_d1 = nearby;
  commit.commit_class = /bible-editor/i.test(commit.subject) ? "bible-editor export" : "other Door43 edit";
}

const manual = events.filter((event) => event.write_source === "manual");
const strong = manual.filter((event) => event.plain_text_unchanged);
const totalLost = events.reduce((sum, event) => sum + event.markers_lost, 0);
const manualLost = manual.reduce((sum, event) => sum + event.markers_lost, 0);
const affectedRows = new Set(events.map((event) => event.row_key)).size;
const door43Lost = door43Commits.reduce((sum, commit) => sum + commit.net_lost, 0);
const door43Files = door43Commits.reduce((sum, commit) => sum + commit.files.length, 0);
const bibleEditorDoor43 = door43Commits.filter((commit) => commit.commit_class === "bible-editor export");
const bibleEditorDoor43Lost = bibleEditorDoor43.reduce((sum, commit) => sum + commit.net_lost, 0);

const byUser = [...new Set(manual.map((event) => event.username))]
  .map((username) => {
    const rows = manual.filter((event) => event.username === username);
    return {
      username,
      events: rows.length,
      rows: new Set(rows.map((event) => event.row_key)).size,
      lost: rows.reduce((sum, event) => sum + event.markers_lost, 0),
      unchanged: rows.filter((event) => event.plain_text_unchanged).length,
      first: [...rows].sort((a, b) => a.created_utc.localeCompare(b.created_utc))[0].created_utc,
      last: [...rows].sort((a, b) => b.created_utc.localeCompare(a.created_utc))[0].created_utc,
    };
  })
  .sort((a, b) => b.lost - a.lost);

const bySource = [...new Set(events.map((event) => event.write_source))]
  .map((source) => {
    const rows = events.filter((event) => event.write_source === source);
    return {
      source,
      events: rows.length,
      rows: new Set(rows.map((event) => event.row_key)).size,
      lost: rows.reduce((sum, event) => sum + event.markers_lost, 0),
      unchanged: rows.filter((event) => event.plain_text_unchanged).length,
    };
  })
  .sort((a, b) => b.lost - a.lost);

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const markerDelta = (event) =>
  tags
    .filter((tag) => event[`before_${tag}`] !== event[`after_${tag}`])
    .map((tag) => `\\${tag} ${event[`before_${tag}`]}→${event[`after_${tag}`]}`)
    .join(", ");

const restorationRows = restorationCandidates
  .map((event) => {
    const describeMarker = (marker) => {
      if (marker.after === "end") return `\\${marker.tag} after final word ${marker.word_index} (“${marker.before}”)`;
      if (marker.before === "start") return `\\${marker.tag} before first word (“${marker.after}”)`;
      return `\\${marker.tag} between words ${marker.word_index} and ${marker.word_index + 1} (“${marker.before}” | “${marker.after}”)`;
    };
    const markers = event.restored_markers.length
      ? event.restored_markers.map(describeMarker).join("; ")
      : "marker position requires manual payload comparison";
    return `<tr>
      <td><code>${esc(event.row_key)}</code></td>
      <td>${esc(event.username)}</td>
      <td>${esc(event.created_utc)}</td>
      <td>v${event.restore_version}</td>
      <td>v${event.new_version}</td>
      <td>${event.seconds_after_add}s</td>
      <td><code>${esc(markers)}</code></td>
      <td>v${esc(event.current_version)}</td>
      <td><span class="badge ${event.still_missing ? "strong" : "reimport"}">${event.still_missing ? "still missing" : "present now"}</span></td>
    </tr>`;
  })
  .join("\n");
const restorationDelays = restorationCandidates.map((event) => event.seconds_after_add);
const restorationDelayRange = restorationDelays.length
  ? `${Math.min(...restorationDelays)}–${Math.max(...restorationDelays)}`
  : "0";
const restoredCandidateCount = restorationCandidates.filter((event) => !event.still_missing).length;
const humanReviewCases = [
  ["MIC/5/13/UST", "Micah 5:13 → 5:14 (UST)", "The boundary changed q2,q2,q1 → q2,q1 → q1. The first apparent loss may be correction of a duplicate; a later save removed another q2.", "Decide whether verse 14 should begin q1, q2, or a stacked transition. Compare the intended poetic lines, not counts alone."],
  ["EZK/7/5/ULT", "Ezekiel 7:4 → 7:5 (ULT)", "The same q1 appeared as both the trailing marker on 7:4 and the leading marker on 7:5. The repair restored only the canonical trailing copy on 7:4.", "Confirm the exported USFM has exactly one q1 before verse 5 and that verse 5 is intended to be poetry."],
  ["NUM/21/28/ULT", "Numbers 21:28 → 21:29 (ULT)", "The apparent trailing-marker loss on verse 28 is already represented by a leading q1 on verse 29.", "Confirm there is exactly one q1 before verse 29. Do not restore another copy unless two distinct lines are intended."],
  ["NUM/21/29/ULT", "Numbers 21:29 → 21:30 (ULT)", "The apparent trailing-marker loss on verse 29 is already represented by a leading q1 on verse 30.", "Confirm there is exactly one q1 before verse 30 and that its poetry level is correct."],
  ["NUM/21/29/UST", "Numbers 21:29 → 21:30 (UST)", "The apparent trailing-marker loss on verse 29 is already represented by a leading q1 on verse 30.", "Confirm there is exactly one q1 before verse 30 and that its poetry level is correct."],
].map(([row, boundary, evidence, question]) => ({ row, boundary, evidence, question }));
const humanReviewRows = humanReviewCases.map((item) => `<tr>
  <td><code>${esc(item.row)}</code></td><td><strong>${esc(item.boundary)}</strong></td>
  <td>${esc(item.evidence)}</td><td>${esc(item.question)}</td>
</tr>`).join("\n");

const tableRows = events
  .map(
    (event) => `<tr data-source="${esc(event.write_source)}" data-evidence="${event.evidence}">
      <td>${esc(event.created_utc)}</td>
      <td><code>${esc(event.row_key)}</code></td>
      <td>v${esc(event.prev_version)}→v${esc(event.new_version)}</td>
      <td>${esc(event.username)}</td>
      <td>${esc(event.write_source)}</td>
      <td><span class="badge ${event.evidence}">${event.evidence}</span></td>
      <td class="num">${event.before_total}→${event.after_total} <strong>(−${event.markers_lost})</strong></td>
      <td><code>${esc(markerDelta(event))}</code></td>
      <td>${event.plain_text_unchanged ? "yes" : "no"}</td>
      <td>${esc(event.action)}</td>
      <td class="num">${event.id}</td>
    </tr>`,
  )
  .join("\n");

const userRows = byUser
  .map(
    (row) => `<tr><td>${esc(row.username)}</td><td>${row.events}</td><td>${row.rows}</td><td>${row.lost}</td><td>${row.unchanged}</td><td>${esc(row.first)}</td><td>${esc(row.last)}</td></tr>`,
  )
  .join("\n");

const sourceRows = bySource
  .map(
    (row) => `<tr><td>${esc(row.source)}</td><td>${row.events}</td><td>${row.rows}</td><td>${row.lost}</td><td>${row.unchanged}</td></tr>`,
  )
  .join("\n");

const door43Rows = door43Commits
  .map((commit) => {
    const repo = commit.resource === "ULT" ? "en_ult" : "en_ust";
    const fileSummary = commit.files
      .map((entry) => {
        const levels = tags
          .filter((tag) => entry.deleted[tag] !== entry.added[tag])
          .map((tag) => `\\${tag} ${entry.deleted[tag]}−/${entry.added[tag]}+`)
          .join(", ");
        return `<div><code>${esc(entry.file)}</code>: <strong>−${entry.net_lost} net</strong> <span class="muted">(${esc(levels)})</span></div>`;
      })
      .join("");
    const snippets = commit.files
      .flatMap((entry) => entry.deleted_lines.map((line) => `<div><code>− ${esc(line)}</code></div>`))
      .slice(0, 8)
      .join("");
    const nearby = commit.nearby_d1.length
      ? `${commit.nearby_d1.length} event(s): ${[...new Set(commit.nearby_d1.map((event) => `${event.row_key} (${event.username}/${event.write_source})`))].slice(0, 8).map(esc).join(", ")}`
      : "none in the preceding 36h for the same book/resource";
    return `<tr>
      <td>${esc(commit.committed_at)}</td>
      <td>${commit.resource}</td>
      <td><a href="https://git.door43.org/unfoldingWord/${repo}/commit/${commit.sha}"><code>${commit.sha.slice(0, 10)}</code></a></td>
      <td>${esc(commit.author)}</td>
      <td>${esc(commit.subject)}</td>
      <td><span class="badge ${commit.commit_class === 'bible-editor export' ? 'strong' : 'automation'}">${esc(commit.commit_class)}</span></td>
      <td class="num"><strong>−${commit.net_lost}</strong><br><span class="muted">${commit.deleted_total}− / ${commit.added_total}+</span></td>
      <td>${fileSummary}</td>
      <td>${esc(nearby)}</td>
      <td><details><summary>deleted lines</summary>${snippets}</details></td>
    </tr>`;
  })
  .join("\n");

const generatedAt = new Date().toISOString();
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Production D1 poetry-marker loss audit</title>
<style>
  :root { color-scheme: light; --ink:#182230; --muted:#617083; --line:#d9e0e8; --panel:#f6f8fa; --accent:#8c2f39; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif; color:var(--ink); background:#fff; }
  main { max-width:1500px; margin:auto; padding:32px; }
  h1 { margin:0 0 6px; font-size:30px; }
  h2 { margin-top:32px; }
  .muted { color:var(--muted); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:22px 0; }
  .card { border:1px solid var(--line); border-radius:10px; padding:16px; background:var(--panel); }
  .card strong { display:block; font-size:28px; }
  .finding { border-left:5px solid var(--accent); background:#fff5f5; padding:16px 18px; margin:20px 0; }
  .human-review { border:3px solid #a1121d; background:#fff0f1; padding:18px 20px; margin:24px 0; border-radius:10px; }
  .human-review h2 { color:#83101a; margin:0 0 8px; font-size:25px; }
  .human-review .callout { font-size:16px; font-weight:700; }
  .scope { background:#f2f7ff; border:1px solid #cfe0f7; padding:14px 18px; border-radius:8px; }
  table { width:100%; border-collapse:collapse; margin:12px 0 28px; }
  th,td { border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; }
  th { position:sticky; top:0; background:#eef2f6; z-index:1; white-space:nowrap; }
  tbody tr:hover { background:#f8fafc; }
  .num { text-align:right; white-space:nowrap; }
  code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
  .badge { display:inline-block; padding:2px 7px; border-radius:999px; font-size:12px; }
  .strong { background:#ffd9d9; color:#7b1721; }
  .manual { background:#fff0c2; color:#6b4d00; }
  .reimport { background:#dcecff; color:#164f86; }
  .automation { background:#e7e9ed; color:#48515d; }
  .controls { display:flex; gap:12px; flex-wrap:wrap; margin:14px 0; }
  input,select { padding:8px 10px; border:1px solid #adb7c3; border-radius:6px; font:inherit; }
  input { min-width:280px; }
  .scroll { max-height:70vh; overflow:auto; border:1px solid var(--line); border-radius:8px; }
  .scroll table { margin:0; }
  @media print { .controls { display:none; } .scroll { max-height:none; overflow:visible; border:0; } th { position:static; } main { max-width:none; padding:12px; } }
</style>
</head>
<body><main>
  <h1>Bible Editor / Door43 poetry-marker loss audit</h1>
  <p class="muted">Generated ${esc(generatedAt)} from read-only production D1 queries and first-parent Door43 history from ${esc(gitSince)} onward.</p>

  <div class="finding"><strong>Finding:</strong> historical evidence is well above the requested 2–3-event threshold. D1 records ${events.length} revision transitions across ${affectedRows} verse rows where the count of <code>\\q</code>/<code>\\q1</code>–<code>\\q4</code> nodes decreased. ${manual.length} were manual saves; ${strong.length} manual saves removed markers while leaving <code>plain_text</code> exactly unchanged.</div>

  <section class="human-review" role="alert">
    <h2>Human review required: 5 verse boundaries may still be wrong</h2>
    <p class="callout">Do not bulk-restore these five rows. A translator or USFM reviewer should inspect the rendered poetry and adjacent verses, then decide the intended marker level and ownership.</p>
    <p>Nine unambiguous marker losses were repaired in production D1. These five were deliberately excluded because their histories show duplicate, moved, or changing boundary markers. The reviewer should confirm that the exported ULT/UST contains exactly the intended poetry line before the named verse.</p>
    <table><thead><tr><th>D1 row</th><th>Human review boundary</th><th>Why automation stopped</th><th>What the human must decide</th></tr></thead><tbody>${humanReviewRows}</tbody></table>
  </section>

  <div class="cards">
    <div class="card"><span>All loss events</span><strong>${events.length}</strong><small>${affectedRows} distinct verse rows</small></div>
    <div class="card"><span>Markers removed</span><strong>${totalLost}</strong><small>all sources combined</small></div>
    <div class="card"><span>Manual-save events</span><strong>${manual.length}</strong><small>${manualLost} markers removed</small></div>
    <div class="card"><span>Strong structural signal</span><strong>${strong.length}</strong><small>manual save + unchanged text</small></div>
    <div class="card"><span>Door43 loss commits</span><strong>${door43Commits.length}</strong><small>${door43Lost} net markers across ${door43Files} file changes</small></div>
    <div class="card"><span>Bible Editor Door43 commits</span><strong>${bibleEditorDoor43.length}</strong><small>${bibleEditorDoor43Lost} net markers removed</small></div>
  </div>

  <div class="scope"><strong>Interpretation.</strong> “Strong” means a manual revision reduced structural poetry markers while its stored plain text was byte-for-byte unchanged. That is compelling evidence of structural loss during an editor save, but not absolute proof of a software defect: an editor can intentionally change formatting without changing words. “Manual” means text changed too, so intent is ambiguous. DCS reimports and named repair jobs are reported separately and must not be attributed to the editor UI. Per-verse accounting can also show a loss when a boundary marker was intentionally moved to an adjacent verse.</div>

  <h2>Post-repair status of the 14 strongest historical candidates</h2>
  <p>These ${restorationCandidates.length} rows have the add-then-lose fingerprint: the same editor added a poetry marker, then the immediately following manual save removed exactly one marker ${restorationDelayRange} seconds later while the stored verse text stayed identical. The current production query finds the historical marker present again on ${restoredCandidateCount} rows. The other ${restorationCandidates.length - restoredCandidateCount} are the deliberately excluded human-review cases above; adjacency and duplicate evidence means “still missing on this D1 row” does not necessarily mean the USFM marker is absent.</p>
  <table><thead><tr><th>Verse row</th><th>Editor</th><th>Loss UTC</th><th>Marker source</th><th>Loss revision</th><th>Delay</th><th>Historical marker position</th><th>Current revision</th><th>Current check</th></tr></thead><tbody>${restorationRows || '<tr><td colspan="9">No add-then-lose candidates found.</td></tr>'}</tbody></table>
  <div class="scope"><strong>Restoration boundary.</strong> The nine repaired rows received only their missing marker; later text and alignment work was preserved. The five excluded rows require the human decisions listed above. The remaining unchanged-text manual losses are review candidates, not automatic restores; intentional poetry-to-prose changes and markers moved across verse boundaries can look identical in count data.</div>

  <h2>Manual saves by editor</h2>
  <table><thead><tr><th>Editor</th><th>Events</th><th>Verse rows</th><th>Markers removed</th><th>Unchanged-text events</th><th>First UTC</th><th>Last UTC</th></tr></thead><tbody>${userRows}</tbody></table>

  <h2>All losses by write source</h2>
  <table><thead><tr><th>Write source</th><th>Events</th><th>Verse rows</th><th>Markers removed</th><th>Unchanged-text events</th></tr></thead><tbody>${sourceRows}</tbody></table>

  <h2>Door43 commits with net q-marker loss</h2>
  <p>Each row compares a commit with its first parent and includes only USFM files whose exact <code>\\q</code>/<code>\\q1</code>–<code>\\q4</code> marker count fell after accounting for additions in the same file. The correlation column is a lead, not proof: it shows earlier D1 marker-loss revisions in the same book/resource during the preceding 36 hours.</p>
  <div class="scroll"><table><thead><tr><th>Committed</th><th>Resource</th><th>Commit</th><th>Author</th><th>Subject</th><th>Class</th><th>Net q loss</th><th>Files / marker levels</th><th>Earlier D1 evidence</th><th>Deleted q lines</th></tr></thead><tbody>${door43Rows || '<tr><td colspan="10">No net-loss commits found in scope.</td></tr>'}</tbody></table></div>

  <h2>Revision-level evidence</h2>
  <div class="controls">
    <input id="search" type="search" placeholder="Filter row, editor, source, timestamp…">
    <select id="evidence"><option value="">All evidence classes</option><option value="strong">Strong only</option><option value="manual">Other manual saves</option><option value="reimport">DCS reimports</option><option value="automation">Other automation</option></select>
    <span id="visible" class="muted"></span>
  </div>
  <div class="scroll"><table id="events"><thead><tr><th>UTC</th><th>Verse row</th><th>Revision</th><th>Actor</th><th>Source</th><th>Evidence</th><th>q total</th><th>Marker changes</th><th>Text unchanged</th><th>Action</th><th>Audit ID</th></tr></thead><tbody>${tableRows}</tbody></table></div>

  <h2>Method and limitations</h2>
  <ul>
    <li>Source: append-only <code>edit_log</code> rows with <code>kind='verse'</code> and non-null full-snapshot <code>payload_json</code>.</li>
    <li>Each snapshot counts JSON nodes whose <code>tag</code> is exactly <code>q</code>, <code>q1</code>, <code>q2</code>, <code>q3</code>, or <code>q4</code>; consecutive revisions are compared within each <code>row_key</code>.</li>
    <li>This finds count decreases, not same-count level substitutions such as <code>\\q1</code>→<code>\\q2</code>, and not losses that occurred before the first retained audit snapshot.</li>
    <li>The audit proves what changed in D1 and when. It does not by itself identify whether the browser serializer, API payload, user action, DCS reimport, or a repair job originated the change.</li>
    <li>Door43 scope is each repository's <code>origin/master</code> first-parent history since ${esc(gitSince)}. Merge commits are compared to their first parent, so merged PR effects are visible without double-counting branch commits.</li>
    <li>A Door43 commit is included only when an individual USFM file has a net marker decrease. Marker moves or level substitutions with no net file loss are excluded.</li>
    <li>Timestamps are UTC. The database query was read-only and wrote zero rows.</li>
  </ul>
</main>
<script>
  const search = document.querySelector('#search');
  const evidence = document.querySelector('#evidence');
  const rows = [...document.querySelectorAll('#events tbody tr')];
  const visible = document.querySelector('#visible');
  function filter() {
    const q = search.value.trim().toLowerCase();
    const kind = evidence.value;
    let count = 0;
    for (const row of rows) {
      const show = (!kind || row.dataset.evidence === kind) && (!q || row.textContent.toLowerCase().includes(q));
      row.hidden = !show;
      if (show) count++;
    }
    visible.textContent = count + ' of ' + rows.length + ' events shown';
  }
  search.addEventListener('input', filter);
  evidence.addEventListener('change', filter);
  filter();
</script>
</body></html>`;

const reportsDir = resolve(import.meta.dirname, "..", "reports");
mkdirSync(reportsDir, { recursive: true });
const output = resolve(reportsDir, "d1-q-marker-loss-audit-2026-08-12.html");
writeFileSync(output, html, "utf8");
console.log(output);
console.log(JSON.stringify({ events: events.length, affectedRows, totalLost, manualEvents: manual.length, manualLost, strongEvents: strong.length, door43Commits: door43Commits.length, door43Files, door43Lost, bibleEditorDoor43Commits: bibleEditorDoor43.length, bibleEditorDoor43Lost }, null, 2));

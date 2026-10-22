// Sync watchdog: prove or disprove an `export_revert:<book>:<resource>` alert
// (issue #1233). READ-ONLY: Door43 GETs only (plus the collector's own
// read-only D1 queries, done by collect.mjs and passed in).
//
// The alert says "our export overwrote master's content at these refs". It is
// false at a ref where master never moved there between our previous export
// landing and tonight's export: the difference was our own D1 work, not a
// hand-edit on master (2026-10-22, alert 1327, EZK UST, issue #1231). So for
// each alert we compare two Door43 revisions of the file:
//   - prev:   the file at our last export commit on master before tonight's;
//   - master: the file at tonight's export commit's first parent (what master
//             held when the export landed).
// Unchanged at a ref (by the app's own verse / row split, export.ts) => false.
//
// Rule: a ref is called FALSE only when the evidence is airtight. Any doubt
// (snapshot not tied to this alert, previous export not provably our own
// render, export commit not found, unparseable dates, duplicate TSV IDs, parse
// failure) makes the ref UNKNOWN, never false.
//
// Pure parts (classifyExportRevertRefs, pickExportCommits, snapshotStatus,
// knownRenderShas) have unit tests in api/src/watchdogExportRevertCheck.test.mjs.
// The Door43 fetches are thin synchronous curl wrappers so collect.mjs's
// synchronous step() can call them.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

import { parseTsvRowsById, readUnconfirmedRenders, verseTextByRef } from "../../api/src/export.ts";
import { dcsResourceFile } from "../../api/src/dcsSources.ts";

const DOOR43_API = "https://git.door43.org/api/v1";

const allUnknown = (refs) => ({ falseRefs: [], realRefs: [], unknownRefs: [...new Set(refs)] });

// IDs that occur more than once in a TSV body, with every Reference each
// occurs at. parseTsvRowsById keeps only the last row per ID, so a duplicate
// would silently drop a row from the comparison.
function duplicateIdRefs(raw) {
  const seen = new Map();
  for (const line of raw.split(/\r?\n/).filter((l) => l.length > 0).slice(1)) {
    const cells = line.split("\t");
    const id = cells[1]?.trim();
    if (!id) continue;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(cells[0] ?? "");
  }
  const refs = new Set();
  for (const at of seen.values()) if (at.length > 1) for (const r of at) refs.add(r);
  return refs;
}

// Classify an alert's refs. `resource` is 'ult' | 'ust' (USFM) or 'tn' | 'tq' |
// 'twl' (TSV). Returns three buckets:
//   falseRefs   present on both sides and unchanged: master never moved there;
//   realRefs    present on master but changed, or absent, in prev: master moved;
//   unknownRefs a side failed to parse, the ref is not on master at all, or
//               (TSV) a row at the ref carries a duplicated ID on either side.
export function classifyExportRevertRefs(refs, prevExportText, masterAtParentText, resource) {
  const out = { falseRefs: [], realRefs: [], unknownRefs: [] };
  const unique = [...new Set(refs)];
  if (resource === "ult" || resource === "ust") {
    const prev = verseTextByRef(prevExportText);
    const master = verseTextByRef(masterAtParentText);
    if (prev === null || master === null) return allUnknown(unique);
    for (const ref of unique) {
      const m = master.get(ref);
      if (m === undefined) out.unknownRefs.push(ref);
      // Same rule as usfmRevertReport's base filter: exact parsed structure.
      else if (prev.get(ref) === m) out.falseRefs.push(ref);
      else out.realRefs.push(ref);
    }
    return out;
  }
  const prev = parseTsvRowsById(prevExportText);
  const master = parseTsvRowsById(masterAtParentText);
  if (prev === null || master === null) return allUnknown(unique);
  const dupRefs = new Set([...duplicateIdRefs(prevExportText), ...duplicateIdRefs(masterAtParentText)]);
  // Reference is column 0 in all three TSV layouts (TN/TQ/TWL_HEADERS in
  // export.ts); an alert ref is master's raw Reference cell. Several rows can
  // share one ref: the ref is false only when every row at it, on both sides,
  // is the same ID with the same cells (tsvRevertReport's base rule).
  const byRef = (rows) => {
    const m = new Map();
    for (const [id, cells] of rows) {
      const ref = cells[0] ?? "";
      if (!m.has(ref)) m.set(ref, new Map());
      m.get(ref).set(id, cells.join("\t"));
    }
    return m;
  };
  const prevByRef = byRef(prev);
  const masterByRef = byRef(master);
  for (const ref of unique) {
    const m = masterByRef.get(ref);
    if (!m || dupRefs.has(ref)) {
      out.unknownRefs.push(ref);
      continue;
    }
    const p = prevByRef.get(ref) ?? new Map();
    const same = m.size === p.size && [...m].every(([id, line]) => p.get(id) === line);
    (same ? out.falseRefs : out.realRefs).push(ref);
  }
  return out;
}

// Our export's master commit subject for one book+resource, including the
// `(review requested)` variant (exportWorkflow.ts) and Gitea's `(#N)` suffix.
// Anchored at the start like masterLineage.ts OURS_PREFIX, so a human
// `Revert "bible-editor: …"` does not match.
export function isOurExportSubject(message, book, resource) {
  const subject = String(message ?? "").split("\n")[0];
  const m = subject.match(/^bible-editor(?: export)?:\s+(\S+)\s+(\S+)\s+→\s+master\b/);
  return Boolean(m && m[1] === book && m[2] === resource);
}

// The export commit's squash merge lands a few minutes AFTER the alert (the
// alert is written at push time; 2026-10-22: alert 05:39:58, merge 05:42:33).
// The slack only absorbs clock skew between D1 and Door43.
const ALERT_SLACK_MS = 2 * 60 * 1000;

// Pure: pick the three commits from the file's history. `commits` is Gitea's
// `GET /repos/{o}/{r}/commits?path=` list, newest first ({sha, created,
// commit: {message}, parents: [{sha}]}). List POSITION decides "before".
//   ok                  tonight's export merged: master = its first parent.
//   export_not_merged   no export commit of ours at/after the alert. Master's
//                       state at export time cannot be pinned from commit
//                       dates alone (they are author dates, not ordered), so
//                       every ref stays unknown.
//   unparseable_date    a commit date in the walked window did not parse.
//   no_prev_export / no_master_commit   nothing to compare against.
export function pickExportCommits(commits, { book, resource, alertCreatedAtMs }) {
  const ours = (c) => isOurExportSubject(c?.commit?.message, book, resource);
  const when = (c) => Date.parse(c?.created ?? c?.commit?.committer?.date ?? "");
  if (!Number.isFinite(alertCreatedAtMs)) return { status: "unparseable_date" };
  let exportIdx = -1;
  for (let i = 0; i < commits.length; i++) {
    const t = when(commits[i]);
    if (!Number.isFinite(t)) return { status: "unparseable_date", at: commits[i]?.sha ?? null };
    if (t < alertCreatedAtMs - ALERT_SLACK_MS) break;
    if (ours(commits[i])) exportIdx = i; // keep walking: the OLDEST at/after the alert
  }
  if (exportIdx < 0) return { status: "export_not_merged", exportSha: null };
  const exportSha = commits[exportIdx].sha;
  const masterSha = commits[exportIdx].parents?.[0]?.sha ?? null;
  if (!masterSha) return { status: "no_master_commit", exportSha };
  const prev = commits.slice(exportIdx + 1).find(ours);
  if (!prev) return { status: "no_prev_export", exportSha, masterSha };
  return { status: "ok", exportSha, masterSha, prevExportSha: prev.sha };
}

// How far before the alert the export_reverts rows may have been written
// (the export computes the report, writes the rows, then the alert).
const SNAPSHOT_BEFORE_ALERT_S = 30 * 60;
const SNAPSHOT_AFTER_ALERT_S = 2 * 60;

// Pure: is the current export_reverts snapshot for (book, resource) provably
// the one this alert reported? null = yes; otherwise the status to report
// (every ref unknown).
//   alert          {id, eventKey, createdAtS}
//   newerAlertId   id of a newer alert for the same pair in this run, or null
//   generation     export_revert_generations row {generation} for the pair, or null
//   detectedAt     detected_at of every snapshot row
export function snapshotStatus({ alert, book, resource, newerAlertId, generation, detectedAt }) {
  if (newerAlertId != null) return "superseded_snapshot";
  if (!generation || alert.eventKey !== `${generation.generation}:export_revert:${book}:${resource}`) {
    return "snapshot_generation_mismatch";
  }
  if (detectedAt.length === 0) return "no_snapshot_rows";
  const c = alert.createdAtS;
  if (!Number.isFinite(c) || detectedAt.some((t) => !(t >= c - SNAPSHOT_BEFORE_ALERT_S && t <= c + SNAPSHOT_AFTER_ALERT_S))) {
    return "snapshot_time_mismatch";
  }
  return null;
}

// Pure: every blob sha we know we rendered and pushed for the pair, from its
// book_resource_syncs row. A previous export commit whose file bytes are not
// one of these may carry a human's edit (an edited review PR, a merge that
// folded in a hand-edit), so it cannot prove "master never moved".
export function knownRenderShas(syncRow) {
  if (!syncRow) return new Set();
  const list = readUnconfirmedRenders(syncRow) ?? [];
  return new Set([...list, syncRow.pushed_blob_sha, syncRow.prev_pushed_blob_sha].filter((x) => typeof x === "string" && x));
}

// Pure: are the picked commits provably the alert's export and our own
// previous render? null = yes; otherwise the status (every ref unknown).
//   exportBlobSha  blob of the file at the picked export commit
//   prevBlobSha    blob of the file at the picked previous export commit
//   pushedBlobSha  book_resource_syncs.pushed_blob_sha: the render the alert's
//                  export pushed. Pinning the export commit to it stops an
//                  EARLIER export's merge (inside the clock-skew slack) from
//                  standing in for tonight's while tonight's is unmerged.
//   knownRenders   knownRenderShas() for the pair
export function renderPinStatus({ exportBlobSha, prevBlobSha, pushedBlobSha, knownRenders }) {
  if (!pushedBlobSha || exportBlobSha !== pushedBlobSha) return "export_not_this_render";
  if (!knownRenders.has(prevBlobSha)) return "prev_not_our_render";
  if (prevBlobSha === exportBlobSha) return "prev_is_this_render";
  return null;
}

// ── Door43 GETs (impure, synchronous) ────────────────────────────────────────

// The token goes in on stdin as a curl config line, not argv, so it never
// shows in `ps`. A token that could break out of the quoted config value is
// refused rather than escaped.
function door43Get(url, token) {
  if (token && !/^[^\s"'\\]+$/.test(token)) throw new Error("DOOR43_TOKEN contains whitespace, a quote or a backslash");
  const config = token ? `header = "Authorization: token ${token}"\n` : "";
  return execFileSync("curl", ["-sS", "-f", "-m", "120", "-K", "-", url], {
    input: config,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Walks the file's master history (newest first) until `done(commits)` holds
// or `maxPages` pages are read.
export function fetchFileCommits(repo, path, token, { maxPages = 4, done = () => false } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${DOOR43_API}/repos/unfoldingWord/${encodeURIComponent(repo)}/commits` +
      `?path=${encodeURIComponent(path)}&sha=master&limit=50&page=${page}&stat=false&verification=false&files=false`;
    const batch = JSON.parse(door43Get(url, token).toString("utf8"));
    if (!Array.isArray(batch)) throw new Error(`Door43 commits: not a list (${JSON.stringify(batch).slice(0, 200)})`);
    all.push(...batch);
    if (batch.length === 0 || done(all)) break;
  }
  return all;
}

// File text at one commit. Requires a full 40-hex sha: measured 2026-10-22,
// the raw endpoint silently serves the DEFAULT BRANCH for a short or unknown
// `?ref=` (200, master's bytes), which would make every ref read as "false".
// Also returns the git blob sha of the bytes, for the bundle's evidence.
export function fetchFileAt(repo, path, sha, token) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error(`refusing non-full sha ${sha}`);
  const url =
    `${DOOR43_API}/repos/unfoldingWord/${encodeURIComponent(repo)}/raw/${encodeURIComponent(path)}` +
    `?ref=${sha}`;
  const bytes = door43Get(url, token);
  const blobSha = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { text: bytes.toString("utf8"), blobSha };
}

// One alert, end to end. `snapshot` is snapshotStatus()'s result (null = the
// refs are this alert's); `knownRenders` is knownRenderShas() for the pair;
// `pushedBlobSha` is book_resource_syncs.pushed_blob_sha (see renderPinStatus).
// Throws on any Door43 failure; collect.mjs wraps this in step().
export function checkExportRevertAlert({ alertId, book, resource, alertCreatedAtMs, refs, snapshot, knownRenders, pushedBlobSha }, token) {
  const file = dcsResourceFile(book, resource);
  if (!file) throw new Error(`no Door43 file for ${book} ${resource}`);
  const base = { alertId, book, resource, repo: file.repo, path: file.path, refs: refs.length };
  if (snapshot) return { ...base, status: snapshot, ...allUnknown(refs) };
  const commits = fetchFileCommits(file.repo, file.path, token, {
    done: (all) => pickExportCommits(all, { book, resource, alertCreatedAtMs }).status !== "no_prev_export",
  });
  const pick = pickExportCommits(commits, { book, resource, alertCreatedAtMs });
  if (pick.status !== "ok") return { ...base, ...pick, ...allUnknown(refs) };
  const exportBlobSha = fetchFileAt(file.repo, file.path, pick.exportSha, token).blobSha;
  const prev = fetchFileAt(file.repo, file.path, pick.prevExportSha, token);
  const pin = renderPinStatus({ exportBlobSha, prevBlobSha: prev.blobSha, pushedBlobSha, knownRenders });
  const shas = { exportBlobSha, prevBlobSha: prev.blobSha, pushedBlobSha: pushedBlobSha ?? null };
  if (pin) return { ...base, ...pick, ...shas, status: pin, ...allUnknown(refs) };
  const master = fetchFileAt(file.repo, file.path, pick.masterSha, token);
  const verdict = classifyExportRevertRefs(refs, prev.text, master.text, resource);
  return { ...base, ...pick, ...shas, masterBlobSha: master.blobSha, ...verdict };
}

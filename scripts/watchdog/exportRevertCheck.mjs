// Sync watchdog: prove or disprove an `export_revert:<book>:<resource>` alert
// (issue #1233). READ-ONLY: Door43 GETs only.
//
// The alert says "our export overwrote master's content at these refs". It is
// false at a ref where master never moved there between our previous export
// landing and tonight's export: the difference was our own D1 work, not a
// hand-edit on master (2026-10-22, alert 1327, EZK UST, issue #1231). So for
// each alert we compare two Door43 revisions of the file:
//   - prev:   the file at our last export commit on master before tonight's;
//   - master: the file at tonight's export commit's first parent (what master
//             held when the export landed).
// Equal at a ref (by the app's own verse / row split, export.ts) => false alarm.
//
// Pure parts (classifyExportRevertRefs, pickExportCommits) have unit tests in
// api/src/watchdogExportRevertCheck.test.mjs. The Door43 fetches are thin
// synchronous curl wrappers so collect.mjs's synchronous step() can call them.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

import { parseTsvRowsById, verseTextByRef } from "../../api/src/export.ts";
import { dcsResourceFile } from "../../api/src/dcsSources.ts";

const DOOR43_API = "https://git.door43.org/api/v1";

// Classify an alert's refs. `resource` is 'ult' | 'ust' (USFM) or 'tn' | 'tq' |
// 'twl' (TSV). Returns three buckets:
//   falseRefs   present on both sides and identical: master never moved there;
//   realRefs    present on master but changed, or absent, in prev: master moved;
//   unknownRefs a side failed to parse, or the ref is not on master at all.
export function classifyExportRevertRefs(refs, prevExportText, masterAtParentText, resource) {
  const out = { falseRefs: [], realRefs: [], unknownRefs: [] };
  const unique = [...new Set(refs)];
  if (resource === "ult" || resource === "ust") {
    const prev = verseTextByRef(prevExportText);
    const master = verseTextByRef(masterAtParentText);
    if (prev === null || master === null) return { ...out, unknownRefs: unique };
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
  if (prev === null || master === null) return { ...out, unknownRefs: unique };
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
    if (!m) {
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
// commit: {message}, parents: [{sha}]}). List POSITION decides "before"
// (dates carry mixed offsets and are not strictly ordered).
//   ok                  tonight's export merged: master = its first parent.
//   export_not_merged   no export commit at/after the alert yet (its PR is
//                       still open): master = the newest file commit dated
//                       before the alert.
//   no_prev_export / no_master_commit   nothing to compare against.
export function pickExportCommits(commits, { book, resource, alertCreatedAtMs }) {
  const ours = (c) => isOurExportSubject(c?.commit?.message, book, resource);
  const when = (c) => Date.parse(c?.created ?? c?.commit?.committer?.date ?? "");
  let exportIdx = -1;
  for (let i = 0; i < commits.length; i++) {
    if (when(commits[i]) < alertCreatedAtMs - ALERT_SLACK_MS) break;
    if (ours(commits[i])) exportIdx = i; // keep walking: the OLDEST at/after the alert
  }
  let masterSha;
  let prevFrom;
  let status = "ok";
  if (exportIdx >= 0) {
    masterSha = commits[exportIdx].parents?.[0]?.sha ?? null;
    prevFrom = exportIdx + 1;
    if (!masterSha) return { status: "no_master_commit", exportSha: commits[exportIdx].sha };
  } else {
    const at = commits.findIndex((c) => when(c) < alertCreatedAtMs);
    if (at < 0) return { status: "no_master_commit" };
    status = "export_not_merged";
    masterSha = commits[at].sha;
    prevFrom = at; // master may itself be our last export: then nothing moved
  }
  const prev = commits.slice(prevFrom).find(ours);
  const exportSha = exportIdx >= 0 ? commits[exportIdx].sha : null;
  if (!prev) return { status: "no_prev_export", exportSha, masterSha };
  return { status, exportSha, masterSha, prevExportSha: prev.sha };
}

// ── Door43 GETs (impure, synchronous) ────────────────────────────────────────

// The token goes in on stdin as a curl config line, not argv, so it never
// shows in `ps`.
function door43Get(url, token) {
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

// One alert, end to end. `rows` are its export_reverts rows ({ref}).
// Throws on any Door43 failure; collect.mjs wraps this in step().
export function checkExportRevertAlert({ alertId, book, resource, alertCreatedAtMs, refs }, token) {
  const file = dcsResourceFile(book, resource);
  if (!file) throw new Error(`no Door43 file for ${book} ${resource}`);
  const commits = fetchFileCommits(file.repo, file.path, token, {
    done: (all) => pickExportCommits(all, { book, resource, alertCreatedAtMs }).prevExportSha != null,
  });
  const pick = pickExportCommits(commits, { book, resource, alertCreatedAtMs });
  const base = { alertId, book, resource, repo: file.repo, path: file.path, refs: refs.length, ...pick };
  if (!pick.prevExportSha) return { ...base, falseRefs: [], realRefs: [], unknownRefs: [...new Set(refs)] };
  const prev = fetchFileAt(file.repo, file.path, pick.prevExportSha, token);
  const master = fetchFileAt(file.repo, file.path, pick.masterSha, token);
  const verdict = classifyExportRevertRefs(refs, prev.text, master.text, resource);
  return { ...base, prevBlobSha: prev.blobSha, masterBlobSha: master.blobSha, ...verdict };
}

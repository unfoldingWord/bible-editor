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
// knownRenderShas, and the #1240 groupRevertAlerts / splitRevertRefs /
// splitVerdict / revertSummaryLines) have unit tests in api/src/watchdogExportRevertCheck.test.mjs.
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
//   alert          {id, eventKey, createdAtS, group?}; group is the alert's
//                  source prefix, 'export_revert' (default) or
//                  'revert_probably_ours' (#1240)
//   newerAlertId   id of a newer alert for the same pair in this run, or null
//   generation     export_revert_generations row {generation} for the pair, or null
//   detectedAt     detected_at of every snapshot row
export function snapshotStatus({ alert, book, resource, newerAlertId, generation, detectedAt }) {
  if (newerAlertId != null) return "superseded_snapshot";
  const group = alert.group ?? "export_revert";
  if (!generation || alert.eventKey !== `${generation.generation}:${group}:${book}:${resource}`) {
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

// ── export_revert vs revert_probably_ours (#1240) ───────────────────────────
// Since #1231 one export-revert report writes up to two record alerts that
// share a generation (planRevertReportAlerts, export.ts): `export_revert:` for
// rows a person may have hand-edited, and a quiet `revert_probably_ours:` for
// rows the stored edit history says no person touched. export_reverts holds
// every row of both with no marker column, so the split comes from the alerts:
//   - only one alert: every row belongs to it;
//   - both: the probably-ours record lists its refs (up to
//     PROBABLY_OURS_LISTED_REFS, then "(+K more)"); the rest are export_revert's.
// Each side's "on N ..." count is checked against the snapshot. Any shortfall
// flags the split and puts the doubtful rows on the export_revert (loud)
// side. Every row gets the same Door43 proof either way; the split only
// decides which section of the summary reports it.
export const REVERT_ALERT_GROUPS = ["export_revert", "revert_probably_ours"];

// {group, book, resource} for a `<group>:<BOOK>:<res>` source, else null.
export function revertAlertSource(source) {
  const [group, book, resource] = String(source ?? "").split(":");
  return REVERT_ALERT_GROUPS.includes(group) && book && resource ? { group, book, resource } : null;
}

// Pure: one group per export-revert report. `alerts` are system_alerts rows
// {id, source, event_key, created_at, message}; other sources are ignored.
// A report is the alerts of one pair whose event_key carries the same
// generation; an alert whose event_key does not parse is a group of its own
// (snapshotStatus then calls it a mismatch). `anchor` is the alert the
// snapshot tie is checked against (export_revert when present).
// `newerAlertId` is the newest alert of a LATER report for the pair, so either
// source supersedes.
export function groupRevertAlerts(alerts) {
  const groups = new Map();
  for (const a of alerts) {
    const src = revertAlertSource(a.source);
    if (!src) continue;
    const { group, book, resource } = src;
    const suffix = `:${group}:${book}:${resource}`;
    const eventKey = a.event_key ?? null;
    const generation = typeof eventKey === "string" && eventKey.endsWith(suffix) ? eventKey.slice(0, -suffix.length) : null;
    const key = generation !== null ? `${book}:${resource}:${generation}` : `id:${a.id}`;
    if (!groups.has(key)) groups.set(key, { book, resource, generation, exportRevert: null, probablyOurs: null });
    const g = groups.get(key);
    const alert = { id: a.id, group, eventKey, createdAtS: Number(a.created_at), message: String(a.message ?? "") };
    const slot = group === "export_revert" ? "exportRevert" : "probablyOurs";
    if (!g[slot] || g[slot].id < a.id) g[slot] = alert;
  }
  const out = [...groups.values()].map((g) => ({ ...g, anchor: g.exportRevert ?? g.probablyOurs }));
  const ids = (g) => [g.exportRevert?.id, g.probablyOurs?.id].filter((x) => x != null);
  // Only a report whose event_key parsed may supersede another: a malformed
  // alert proves nothing about which report the snapshot belongs to, so it
  // must not cancel a valid report's Door43 proof. Its own group still fails
  // the snapshot tie (snapshotStatus), so it never yields a verdict.
  for (const g of out) {
    const top = Math.max(...ids(g));
    const later = out
      .filter((o) => o !== g && o.generation !== null && o.book === g.book && o.resource === g.resource)
      .flatMap(ids)
      .filter((id) => id > top);
    g.newerAlertId = later.length ? Math.max(...later) : null;
  }
  return out;
}

// "… overwrote master's current content on N row(s)/verse(s) …"
function exportRevertCount(message) {
  const m = message.match(/ on (\d+) row\(s\)\/verse\(s\) /);
  return m ? Number(m[1]) : null;
}

// "… replaced master's text on N verse(s) that are … not a lost hand-edit:
// <ref>, <ref> (+K more). The stored Door43 edit history …"
// {count, refs, unlisted}, or null when the wording does not match.
function probablyOursList(message) {
  const m = message.match(/ on (\d+) verse\(s\) that .*?not a lost hand-edit: (.*?)\. The stored Door43 edit history /s);
  if (!m) return null;
  let list = m[2];
  let unlisted = 0;
  const more = list.match(/ \(\+(\d+) more\)$/);
  if (more) {
    unlisted = Number(more[1]);
    list = list.slice(0, -more[0].length);
  }
  return { count: Number(m[1]), refs: list ? list.split(", ") : [], unlisted };
}

// Pure: split the snapshot's refs between a group's two alerts. Returns
// {exportRevertRefs, probablyOursRefs, split}; split is "exact", or
// "inexact: …" / "unverified: …" with the reason.
//
// A lone export_revert alert owns every row by construction, so no count is
// compared there: export_reverts is UNIQUE(book, resource, ref) and a TSV
// Reference often carries several tn rows, so a TSV alert's "on N row(s)"
// routinely exceeds the snapshot's row count (#1240 review F1).
//
// A probably-ours record is never trusted to own rows it does not list, even
// alone: writeAlert is best-effort, so the export_revert alert of the same
// report can be missing while the record landed. Its listed refs go quiet and
// every other row goes to the export_revert (loud) side, which collect.mjs
// reports even with no export_revert alert to name.
//
// Counts are compared for USFM only, where one verse ref is one entry;
// export.ts partitions USFM only (tsv_not_partitioned), so a probably-ours
// record on a TSV resource is not expected, and if one appears its counts are
// not comparable.
export function splitRevertRefs(rowRefs, group) {
  const rows = [...new Set(rowRefs)];
  if (!group.probablyOurs) return { exportRevertRefs: rows, probablyOursRefs: [], split: "exact" };
  const po = probablyOursList(group.probablyOurs.message);
  if (po === null) {
    return { exportRevertRefs: rows, probablyOursRefs: [], split: "unverified: the probably-ours record's ref list did not parse" };
  }
  const erCount = group.exportRevert ? exportRevertCount(group.exportRevert.message) : 0;
  const usfm = group.resource === "ult" || group.resource === "ust";
  const countMismatch =
    !usfm || (erCount !== null && erCount + po.count === rows.length)
      ? null
      : `unverified: alerts name ${erCount ?? "?"} export_revert${group.exportRevert ? "" : " (no alert found)"} + ${po.count} probably-ours row(s), snapshot has ${rows.length}`;
  const inRows = new Set(rows);
  const listed = new Set(po.refs.filter((r) => inRows.has(r)));
  const split =
    countMismatch ??
    (listed.size !== po.refs.length
      ? `unverified: ${po.refs.length - listed.size} listed probably-ours ref(s) not in the snapshot`
      : po.unlisted > 0
        ? `inexact: ${po.unlisted} probably-ours ref(s) not listed in the record, checked under export_revert`
        : "exact");
  return { exportRevertRefs: rows.filter((r) => !listed.has(r)), probablyOursRefs: rows.filter((r) => listed.has(r)), split };
}

// Pure: one check's verdict restricted to `refs` (one alert's share).
export function splitVerdict(verdict, refs) {
  const keep = new Set(refs);
  const only = (xs) => (xs ?? []).filter((r) => keep.has(r));
  return { ...verdict, refs: keep.size, falseRefs: only(verdict.falseRefs), realRefs: only(verdict.realRefs), unknownRefs: only(verdict.unknownRefs) };
}

// Pure: the bundle entries for one report: one per alert, each with its own
// share of the verdict. Rows on the export_revert side with no export_revert
// alert (see splitRevertRefs) still get an entry, alertId null, so they are
// reported in the loud section.
export function splitResults(verdict, split, group) {
  const out = [];
  if (group.exportRevert || split.exportRevertRefs.length > 0) {
    out.push({
      ...splitVerdict(verdict, split.exportRevertRefs),
      group: "export_revert",
      alertId: group.exportRevert?.id ?? null,
      recordId: group.exportRevert ? undefined : group.probablyOurs?.id,
      split: split.split,
    });
  }
  if (group.probablyOurs) {
    out.push({ ...splitVerdict(verdict, split.probablyOursRefs), group: "revert_probably_ours", alertId: group.probablyOurs.id, split: split.split });
  }
  return out;
}

// Pure: summary.md lines for the checked alerts. `loud` goes under the
// export_revert heading: every export_revert alert, plus any probably-ours
// record with a REAL ref (the edit history missed a hand-edit, as serious as
// an export_revert REAL). `quiet` is the per-record probably-ours tally.
// `failed` names the groups ('export_revert' / 'revert_probably_ours') with
// at least one alert whose check failed; each section notes only its own.
export function revertSummaryLines(results, { failed = [] } = {}) {
  const list = (xs) => (xs.length ? `${xs.length} (${xs.slice(0, 15).join(", ")}${xs.length > 15 ? ", …" : ""})` : "0");
  const where = (r) =>
    `${r.status}; prev export ${r.prevExportSha?.slice(0, 10) ?? "none"}, ` +
    `master ${r.masterSha?.slice(0, 10) ?? "none"}${r.exportSha ? ` (parent of ${r.exportSha.slice(0, 10)})` : ""}`;
  const splitNote = (r) => (r.split && r.split !== "exact" ? ` Ref split ${r.split}.` : "");
  const loud = [];
  const quiet = [];
  for (const r of results) {
    if (r.group === "revert_probably_ours") {
      quiet.push(
        `- Record ${r.alertId} ${r.book} ${r.resource}: probably ours: ${r.falseRefs.length} confirmed ours, ` +
          `${r.unknownRefs.length} undecided, ${r.realRefs.length} REAL. ${where(r)}.${splitNote(r)}`,
      );
      if (r.realRefs.length > 0) {
        loud.push(
          `- Record ${r.alertId} ${r.book} ${r.resource} (revert_probably_ours): REAL at some refs: the edit history missed a hand-edit ` +
            `that tonight's export overwrote. real ${list(r.realRefs)}. ${where(r)}.${splitNote(r)}`,
        );
      }
      continue;
    }
    const verdict =
      r.realRefs.length === 0 && r.unknownRefs.length === 0 && r.falseRefs.length > 0
        ? "FALSE ALARM (every ref unchanged on master since our last export, parsed verse/row comparison)"
        : r.realRefs.length > 0
          ? "REAL at some refs"
          : "UNDECIDED";
    // alertId null: rows the probably-ours record does not list, in a report
    // whose export_revert alert was not found (splitRevertRefs).
    const who =
      r.alertId == null
        ? `Refs not in probably-ours record ${r.recordId ?? "?"} ${r.book} ${r.resource} (no export_revert alert found)`
        : `Alert ${r.alertId} ${r.book} ${r.resource}`;
    loud.push(
      `- ${who}: ${verdict}. ${where(r)}. ` +
        `unchanged on master since our last export (parsed verse/row comparison) ${list(r.falseRefs)}; real ${list(r.realRefs)}; unknown ${list(r.unknownRefs)}${splitNote(r)}`,
    );
  }
  const checkedEr = results.some((r) => r.group !== "revert_probably_ours");
  if (failed.includes("export_revert")) loud.push("- An export_revert check failed, see errors.");
  else if (!checkedEr && quiet.length > 0) {
    loud.unshift(`- No export_revert alerts tonight (${quiet.length} probably-ours record(s) checked below).`);
  }
  if (failed.includes("revert_probably_ours")) quiet.push("- A revert_probably_ours check failed, see errors.");
  if (loud.length === 0) loud.push("- None checked.");
  if (quiet.length === 0) quiet.push("- None checked.");
  return { loud, quiet };
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

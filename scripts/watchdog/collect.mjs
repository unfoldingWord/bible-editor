#!/usr/bin/env node
// Nightly sync watchdog — evidence collector. READ-ONLY against prod D1.
//
// Run by the `nightly-dcs-d1-sync-check` routine (deferredreward/routines)
// after the 05:30 UTC Door43<->D1 sync, from a worktree at origin/main so the
// visible-change classifier below is the app's own current code:
//
//   node --experimental-strip-types --no-warnings scripts/watchdog/collect.mjs <outDir> [YYYY-MM-DD]
//
// Writes <outDir>/bundle.json (everything below) and <outDir>/summary.md.
// It changes nothing. The one repair it knows how to prove — resolving review
// rows whose flagged version has no visible difference from D1 now (the
// 2026-09-24 ZEC 1:17 false-alarm class, 181 rows) — is emitted as
// <outDir>/proposed-resolve.sql for a human to approve, never executed here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyVisibleAdoptionChange } from "../../api/src/visibleAdoptionChange.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: collect.mjs <outDir> [YYYY-MM-DD]");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const day = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const since = `unixepoch('${day} 05:30:00')`;

function q(sql) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql],
    { cwd: path.join(REPO, "api"), encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(raw.slice(raw.indexOf("["))).flatMap((r) => r.results ?? []);
}

const bundle = { day, collectedAt: new Date().toISOString(), errors: [] };
function step(name, fn) {
  try {
    return fn();
  } catch (e) {
    bundle.errors.push({ step: name, error: String(e?.stderr || e?.message || e).slice(0, 2000) });
    return null;
  }
}

bundle.deployed = step("deployed version", () =>
  JSON.parse(execFileSync("curl", ["-s", "-m", "20", "https://bible-editor-api.unfoldingword.workers.dev/version.json"], { encoding: "utf8" })),
);

bundle.syncRun = step("sync_run_log", () => ({
  byStatus: q(`SELECT event_type, status, count(*) n FROM sync_run_log
                WHERE run_id = 'nightly-${day}' GROUP BY 1,2 ORDER BY n DESC`),
  skipReasons: q(`SELECT json_extract(details_json,'$.dcsSkippedReason') reason, count(*) n FROM sync_run_log
                   WHERE run_id = 'nightly-${day}' AND status = 'skip' GROUP BY 1 ORDER BY n DESC`),
  notable: q(`SELECT book, resource, event_type, status, substr(details_json,1,400) details FROM sync_run_log
               WHERE run_id = 'nightly-${day}' AND status NOT IN ('success','skip') LIMIT 200`),
}));

bundle.newAlerts = step("alerts raised since the sync", () =>
  q(`SELECT id, username, source, kind, severity, datetime(created_at,'unixepoch') created, substr(message,1,600) message
       FROM system_alerts WHERE created_at >= ${since} AND resolved_at IS NULL ORDER BY id`),
);

bundle.mergeOutcomes = step("merge outcomes recorded tonight", () =>
  q(`SELECT book, resource, action, reason, count(*) n FROM verse_merge_conflicts
      WHERE last_recorded_at >= ${since} GROUP BY 1,2,3,4 ORDER BY n DESC`),
);

// Every open review row, classified with the app's own visible-change test:
// does the editor's text at overwritten_version still differ visibly from D1?
const active =
  step("open review rows", () =>
    q(`SELECT c.id, c.book, c.resource, c.chapter, c.verse, c.action, c.reason, c.overwritten_version ov,
              datetime(c.detected_at,'unixepoch') detected, c.last_recorded_at >= ${since} touched_tonight,
              v.version cur, v.content_json cur_json,
              (SELECT payload_json FROM edit_log e WHERE e.kind = 'verse'
                 AND e.row_key = c.book||'/'||c.chapter||'/'||c.verse||'/'||upper(c.resource)
                 AND e.new_version = c.overwritten_version ORDER BY e.id DESC LIMIT 1) ov_payload
         FROM verse_merge_conflicts c
         JOIN verses v ON v.book = c.book AND v.chapter = c.chapter AND v.verse = c.verse AND v.bible_version = upper(c.resource)
        WHERE c.resolved_at IS NULL
          AND c.action IN ('adopt_conflict','keep_alignment_refused','source_attr_divergent','keep_local_structure')`),
  ) ?? [];

const proven = [];
const real = [];
const other = [];
for (const r of active) {
  const row = {
    id: r.id, book: r.book, resource: r.resource, ref: `${r.chapter}:${r.verse}`, action: r.action, reason: r.reason,
    overwrittenVersion: r.ov, currentVersion: r.cur, detected: r.detected, touchedTonight: Boolean(r.touched_tonight),
  };
  if (r.action !== "adopt_conflict" || !r.ov_payload) {
    other.push(row);
    continue;
  }
  const p = JSON.parse(r.ov_payload);
  const c = p.content ?? p;
  const v = classifyVisibleAdoptionChange(typeof c === "string" ? c : JSON.stringify(c), r.cur_json);
  row.visible = [v.wordingChanged && "wording", v.punctuationChanged && "punctuation", v.alignmentChanged && "alignment"].filter(Boolean);
  (row.visible.length === 0 ? proven : real).push(row);
}
bundle.openReviews = { provenFalse: proven, real, other };

// The repair, as a proposal. Alerts qualify only when every ref they name is
// in the proven set (editor alerts), or when the proposal clears a source's
// last open row and the alert carries no no-ancestor warning (admin alerts).
const alerts =
  step("open verse-merge alerts", () =>
    q(`SELECT id, username, source, condition_key, message FROM system_alerts
        WHERE source LIKE 'verse_merge_conflict:%' AND resolved_at IS NULL AND kind = 'review'`),
  ) ?? [];
const provenRef = new Set(proven.map((r) => `${r.book}:${r.resource}:${r.ref}@v${r.overwrittenVersion}`));
const provenSources = new Set(proven.map((r) => `verse_merge_conflict:${r.book}:${r.resource}`));
const provenIds = new Set(proven.map((r) => r.id));
const sourcesStillOpen = new Set(
  active.filter((r) => !provenIds.has(r.id)).map((r) => `verse_merge_conflict:${r.book}:${r.resource}`),
);
const alertIds = [];
for (const a of alerts) {
  const [, book, res] = a.source.split(":");
  const m = a.condition_key.match(/"refs":(\[[^\]]*\])/);
  const refs = m ? JSON.parse(m[1]) : null;
  if (refs) {
    if (refs.length > 0 && refs.every((x) => provenRef.has(`${book}:${res}:${x}`))) alertIds.push(a.id);
  } else if (provenSources.has(a.source) && !sourcesStillOpen.has(a.source) && !/could not be adjudicated/.test(a.message)) {
    alertIds.push(a.id);
  }
}
bundle.proposal = { conflictIds: proven.map((r) => r.id), alertIds };
if (proven.length > 0) {
  const sql = [
    `-- Proposed by scripts/watchdog/collect.mjs for ${day}. NOT executed. Resolves ${proven.length} review row(s)`,
    `-- whose flagged version has no visible difference from D1 now, and ${alertIds.length} alert(s) naming only those.`,
    `UPDATE verse_merge_conflicts SET resolved_at = unixepoch(), resolved_by = 2`,
    `  WHERE id IN (${[...provenIds].join(",")}) AND resolved_at IS NULL AND action = 'adopt_conflict';`,
    alertIds.length
      ? `UPDATE system_alerts SET resolved_at = unixepoch() WHERE id IN (${alertIds.join(",")}) AND resolved_at IS NULL AND kind = 'review';`
      : "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "proposed-resolve.sql"), sql + "\n");
}

fs.writeFileSync(path.join(OUT, "bundle.json"), JSON.stringify(bundle, null, 1));

const statusLine = (bundle.syncRun?.byStatus ?? []).map((r) => `${r.event_type}/${r.status}=${r.n}`).join(", ") || "none";
const summary = [
  `# Sync watchdog ${day}`,
  ``,
  `- Deployed: ${bundle.deployed?.commit ?? "unknown"}`,
  `- Nightly run rows (nightly-${day}): ${statusLine}`,
  `- Non-success/skip rows: ${bundle.syncRun?.notable?.length ?? "unknown"}`,
  `- Alerts raised since 05:30 UTC and still open: ${bundle.newAlerts?.length ?? "unknown"}`,
  `- Open review rows: ${active.length} (proven false: ${proven.length}, real: ${real.length}, other kinds: ${other.length})`,
  `- Proposed resolve: ${proven.length} row(s), ${alertIds.length} alert(s)${proven.length ? " — see proposed-resolve.sql" : ""}`,
  `- Collector errors: ${bundle.errors.length}`,
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), summary + "\n");
console.log(summary);

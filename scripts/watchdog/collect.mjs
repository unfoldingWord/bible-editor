#!/usr/bin/env node
// Nightly sync watchdog — evidence collector. READ-ONLY against prod D1.
//
// Run by the `nightly-dcs-d1-sync-check` routine (deferredreward/routines)
// after the 05:30 UTC Door43<->D1 sync, from a worktree at origin/main so the
// visible-change classifier below is the app's own current code:
//
//   node --experimental-strip-types --no-warnings scripts/watchdog/collect.mjs <outDir> [YYYY-MM-DD]
//
// The export_revert check (#1233) also needs DOOR43_TOKEN in the environment
// (`source ~/.config/door43.env`) for read-only Door43 GETs; without it that
// check is recorded as a failed step.
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
  // wrangler may print log lines (e.g. "[WARNING] …") before the JSON array.
  const start = raw.search(/^\[\s*$|^\[\s*\{/m);
  if (start < 0) throw new Error(`no JSON in wrangler output: ${raw.slice(0, 300)}`);
  const res = JSON.parse(raw.slice(start));
  for (const r of res) if (r.success === false) throw new Error(`D1 reported failure: ${JSON.stringify(r).slice(0, 300)}`);
  return res.flatMap((r) => r.results ?? []);
}

const bundle = { day, collectedAt: new Date().toISOString(), errors: [] };
function step(name, fn) {
  try {
    return fn();
  } catch (e) {
    // With --json, wrangler writes its failure (e.g. "not authenticated") to
    // stdout, not stderr, so stdout goes first. e.message already repeats
    // stderr, so only its first line ("Command failed: …") is kept.
    const detail = [e?.stdout, e?.stderr].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
    const cmd = String(e?.message ?? "").split("\n")[0];
    bundle.errors.push({ step: name, error: (detail ? `${detail}\n${cmd}` : String(e?.message || e)).slice(0, 2000) });
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
               WHERE run_id = 'nightly-${day}' AND event_type = 'item_terminal' AND status NOT IN ('success','skip') LIMIT 200`),
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
              c.recorded_generation gen,
              v.version cur, v.content_json cur_json,
              (SELECT payload_json FROM edit_log e WHERE e.kind = 'verse'
                 AND e.row_key = c.book||'/'||c.chapter||'/'||c.verse||'/'||upper(c.resource)
                 AND e.new_version = c.overwritten_version AND e.created_at <= c.detected_at
               ORDER BY e.id DESC LIMIT 1) ov_payload
         FROM verse_merge_conflicts c
         LEFT JOIN verses v ON v.book = c.book AND v.chapter = c.chapter AND v.verse = c.verse AND v.bible_version = upper(c.resource)
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
  row.gen = r.gen;
  if (r.action !== "adopt_conflict" || !r.ov_payload || r.cur_json == null) {
    row.why = r.cur_json == null ? "verse row missing" : r.ov_payload ? "not an adopt_conflict" : "flagged version not in edit_log";
    other.push(row);
    continue;
  }
  try {
    const p = JSON.parse(r.ov_payload);
    const c = p.content ?? p;
    const v = classifyVisibleAdoptionChange(typeof c === "string" ? c : JSON.stringify(c), r.cur_json);
    row.visible = [v.wordingChanged && "wording", v.punctuationChanged && "punctuation", v.alignmentChanged && "alignment"].filter(Boolean);
    (row.visible.length === 0 ? proven : real).push(row);
  } catch (e) {
    row.why = `unclassifiable: ${String(e?.message ?? e).slice(0, 200)}`;
    other.push(row);
  }
}
bundle.openReviews = { provenFalse: proven, real, other };

// The repair, as a proposal. Only EDITOR alerts qualify, and only when every
// ref they name is in the proven set. Admin summary alerts are never proposed:
// they also carry no-ancestor and recording-failed warnings, and the next sync
// re-derives them from the rows anyway. Every statement is pinned to the exact
// state that was proven (row: overwritten_version + recorded_generation;
// alert: condition_key), so a proposal approved after the next sync has
// re-detected a verse or re-raised an alert matches nothing.
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
const alerts =
  step("open verse-merge alerts", () =>
    q(`SELECT id, username, source, condition_key FROM system_alerts
        WHERE source LIKE 'verse_merge_conflict:%' AND resolved_at IS NULL AND kind = 'review'
          AND username <> 'deferredreward' AND condition_key IS NOT NULL`),
  ) ?? [];
const provenRef = new Set(proven.map((r) => `${r.book}:${r.resource}:${r.ref}@v${r.overwrittenVersion}`));
const qualifying = [];
for (const a of alerts) {
  const [, book, res] = a.source.split(":");
  const m = String(a.condition_key).match(/"refs":(\[[^\]]*\])/);
  let refs = null;
  try {
    refs = m ? JSON.parse(m[1]) : null;
  } catch {
    refs = null;
  }
  if (refs && refs.length > 0 && refs.every((x) => provenRef.has(`${book}:${res}:${x}`))) qualifying.push(a);
}
bundle.proposal = { conflictIds: proven.map((r) => r.id), alertIds: qualifying.map((a) => a.id) };
if (proven.length > 0) {
  const rowPreds = proven.map((r) => `(id = ${r.id} AND overwritten_version = ${r.overwrittenVersion} AND recorded_generation = ${r.gen})`);
  const alertPreds = qualifying.map((a) => `(id = ${a.id} AND condition_key = ${sqlStr(a.condition_key)})`);
  const sql = [
    `-- Proposed by scripts/watchdog/collect.mjs for ${day}. NOT executed.`,
    `-- Resolves ${proven.length} review row(s) whose flagged version has no visible difference`,
    `-- (wording, punctuation, alignment; markers and whitespace are ignored, per the 2026-09-24`,
    `-- ruling that a markers-only overwrite is not an alert) from D1 now, and ${qualifying.length} editor`,
    `-- alert(s) naming only those rows. Each statement matches only the exact state that was proven.`,
    `UPDATE verse_merge_conflicts SET resolved_at = unixepoch(), resolved_by = 2`,
    `  WHERE resolved_at IS NULL AND action = 'adopt_conflict' AND (${rowPreds.join("\n    OR ")});`,
    alertPreds.length
      ? `UPDATE system_alerts SET resolved_at = unixepoch()\n  WHERE resolved_at IS NULL AND kind = 'review' AND (${alertPreds.join("\n    OR ")});`
      : "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "proposed-resolve.sql"), sql + "\n");
}

// export_revert alerts (#1233): for each one raised tonight, compare Door43's
// file at our previous export with master at tonight's export's first parent
// (exportRevertCheck.mjs). A ref unchanged between them is a false alarm:
// master never moved there. Any doubt leaves the ref unknown. Door43 GETs and
// read-only D1 SELECTs only; no proposal SQL is written for these, the routine
// reads the verdict and decides.
//
// #1240: the quiet `revert_probably_ours:` record of the same report is
// checked too, in the same Door43 pass (one per report), and reported in its
// own section. exportRevertCheck.mjs's groupRevertAlerts / splitRevertRefs say
// which export_reverts rows belong to which alert.
bundle.exportReverts = [];
const revertAlerts = (bundle.newAlerts ?? []).filter((x) =>
  ["export_revert:", "revert_probably_ours:"].some((p) => String(x.source).startsWith(p)),
);
// Loaded here, not statically, so a load failure in exportRevertCheck.mjs or
// export.ts's import graph lands in bundle.errors instead of killing the run.
const erc =
  revertAlerts.length === 0
    ? null
    : await import("./exportRevertCheck.mjs").catch((e) => {
        bundle.errors.push({ step: "load exportRevertCheck.mjs", error: String(e?.stack ?? e?.message ?? e).slice(0, 2000) });
        return null;
      });
// Full messages: newAlerts keeps only 600 characters, and the probably-ours
// record lists up to 300 refs.
const revertMeta =
  erc && revertAlerts.length > 0
    ? step("export_revert alert metadata", () =>
        q(`SELECT id, source, event_key, created_at, message FROM system_alerts
            WHERE id IN (${revertAlerts.map((a) => Number(a.id)).join(",")}) ORDER BY id`),
      )
    : null;
const created = new Map(revertAlerts.map((a) => [Number(a.id), a.created]));
// Which summary section(s) a failed step leaves unchecked.
const revertFailed = new Set();
if (erc && revertAlerts.length > 0 && !revertMeta) {
  for (const a of revertAlerts) revertFailed.add(String(a.source).split(":")[0]);
}
for (const g of erc && revertMeta ? erc.groupRevertAlerts(revertMeta) : []) {
  const { book, resource, anchor } = g;
  const res = step(`export_revert check ${anchor.id} ${book} ${resource}`, () => {
    if (!process.env.DOOR43_TOKEN) throw new Error("DOOR43_TOKEN not set (source ~/.config/door43.env)");
    const pair = `book = ${sqlStr(book)} AND resource = ${sqlStr(resource)}`;
    // export_reverts is a replace-all snapshot per (book, resource): its rows
    // are this report's only if no newer report for the pair exists tonight
    // and the pair's current generation is the one in the alert's event_key.
    const rows = q(`SELECT ref, detected_at FROM export_reverts WHERE ${pair} ORDER BY id`);
    const [generation] = q(`SELECT generation, observed_at FROM export_revert_generations WHERE ${pair}`);
    const [sync] = q(`SELECT pushed_blob_sha, prev_pushed_blob_sha, unconfirmed_renders_json FROM book_resource_syncs WHERE ${pair}`);
    const snapshot = erc.snapshotStatus({
      alert: anchor,
      book,
      resource,
      newerAlertId: g.newerAlertId,
      generation: generation ?? null,
      detectedAt: rows.map((r) => Number(r.detected_at)),
    });
    const out = erc.checkExportRevertAlert(
      {
        alertId: anchor.id,
        book,
        resource,
        alertCreatedAtMs: anchor.createdAtS * 1000,
        refs: rows.map((r) => r.ref),
        snapshot,
        knownRenders: erc.knownRenderShas(sync ?? null),
        pushedBlobSha: sync?.pushed_blob_sha ?? null,
      },
      process.env.DOOR43_TOKEN,
    );
    const at = rows.map((r) => r.detected_at);
    const detectedAt = at.length ? [Math.min(...at), Math.max(...at)] : null;
    const split = erc.splitRevertRefs(rows.map((r) => r.ref), g);
    return erc.splitResults(out, split, g).map((r) => ({ ...r, alertCreated: created.get(Number(r.alertId)), detectedAt }));
  });
  if (res) bundle.exportReverts.push(...res);
  else for (const a of [g.exportRevert, g.probablyOurs]) if (a) revertFailed.add(a.group);
}

fs.writeFileSync(path.join(OUT, "bundle.json"), JSON.stringify(bundle, null, 1));

const byStatus = bundle.syncRun?.byStatus ?? null;
const has = (ev) => (byStatus ?? []).some((r) => r.event_type === ev);
const runRecorded = byStatus != null && has("run_started") && has("run_completed");
const complete = bundle.errors.length === 0 && runRecorded && bundle.newAlerts != null;
const n = (x) => (x == null ? "unknown" : String(x));
const activeOk = !bundle.errors.some((e) => e.step === "open review rows");
// Without exportRevertCheck.mjs (no alerts, or it failed to load) each section
// says so for its own alerts.
const notLoaded = (prefix) => {
  const k = revertAlerts.filter((a) => String(a.source).startsWith(`${prefix}:`)).length;
  return [k > 0 ? `- CHECK FAILED TO LOAD: ${k} ${prefix} alert(s) unchecked (see errors, step "load exportRevertCheck.mjs").` : `- None checked.`];
};
const revertLines = erc
  ? erc.revertSummaryLines(bundle.exportReverts, { failed: [...revertFailed] })
  : { loud: notLoaded("export_revert"), quiet: notLoaded("revert_probably_ours") };
const summary = [
  `# Sync watchdog ${day}`,
  ``,
  complete
    ? `**Collector: complete.**`
    : `**Collector: INCOMPLETE — do not read the counts below as clean.** ` +
      [
        bundle.errors.length
          ? `${bundle.errors.length} step(s) failed (${bundle.errors.map((e) => e.step).join(", ")}). First error: ${bundle.errors[0].error.split("\n").slice(0, 4).join(" ").slice(0, 300)}`
          : "",
        byStatus != null && !runRecorded ? `no run_started/run_completed rows for nightly-${day} (did the sync run, or is the date wrong?)` : "",
      ].filter(Boolean).join("; "),
  ``,
  `- Deployed: ${bundle.deployed?.commit ?? "unknown"}`,
  `- Nightly run rows (nightly-${day}): ${byStatus == null ? "unknown" : byStatus.map((r) => `${r.event_type}/${r.status}=${r.n}`).join(", ") || "none"}`,
  `- Item rows not success/skip: ${n(bundle.syncRun?.notable?.length)}`,
  `- Skip reasons: ${bundle.syncRun?.skipReasons == null ? "unknown" : bundle.syncRun.skipReasons.map((r) => `${r.reason ?? "null"}=${r.n}`).join(", ") || "none"}`,
  `- Alerts raised since 05:30 UTC and still open: ${n(bundle.newAlerts?.length)}`,
  activeOk
    ? `- Open review rows: ${active.length} (proven false: ${proven.length}, real: ${real.length}, other: ${other.length})`
    : `- Open review rows: unknown (query failed)`,
  `- Proposed resolve: ${proven.length} row(s), ${qualifying.length} editor alert(s)${proven.length ? " — see proposed-resolve.sql" : ""}`,
  ``,
  `## export_revert alerts`,
  ``,
  ...revertLines.loud,
  ``,
  `## revert_probably_ours records`,
  ``,
  ...revertLines.quiet,
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), summary + "\n");
console.log(summary);

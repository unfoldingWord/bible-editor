// Mark the sync-overwrite conflicts a human has now adjudicated as resolved,
// so translators stop seeing "Door43's sync overwrote your edits" warnings for
// verses we have decided need no recovery.
//
// Usage: node scripts/resolve-adjudicated-conflicts.mjs <restore-decisions.jsonl> [--execute]
//
// WHY THIS IS NOT JUST TIDYING. An unresolved verse_merge_conflicts row keeps
// regenerating the editor banner on every sync run (verseMergeConflicts.ts
// re-derives its message fresh from every unresolved row each time), and the
// message names verses by @version as recoverable losses. For the rows below
// that claim is now false or moot, and leaving them unresolved trains people to
// ignore a warning that is sometimes real. Resolving is the honest end state:
// resolved_at means "a human adjudicated this", which is exactly what the sweep
// plus Benjamin's rulings did.
//
// WHAT IT DOES NOT TOUCH. Rows whose action is not 'adopt_conflict' (the kept-D1
// outcomes: keep_alignment_refused, source_attr_divergent, keep_ai_master) are
// left alone — those describe a live condition where tonight's export still
// writes D1 over master, and a human resolving them means something different.
// Already-resolved rows are skipped (resolved_at IS NULL guard), so the 38
// restores resolved by restore-overwritten-verses.mjs keep their own
// resolved_by attribution rather than being re-stamped by this pass.
//
// Attribution: resolved_by = Benjamin (uid 2), who made the calls. The per-verse
// reasoning lives in restore-decisions.jsonl and this script's commit message;
// the table has no free-text column.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const decisionsPath = args.find((a) => !a.startsWith("--"));
const EXECUTE = args.includes("--execute");
if (!decisionsPath) { console.error("usage: node scripts/resolve-adjudicated-conflicts.mjs <restore-decisions.jsonl> [--execute]"); process.exit(1); }

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const API_DIR = path.join(REPO, "api");
function d1(sqlRaw, attempts = 3) {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const req = createRequire(path.join(API_DIR, "package.json"));
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync(process.execPath,
        [req.resolve("wrangler/bin/wrangler.js"), "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql],
        { cwd: API_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const parsed = JSON.parse(out.slice(out.indexOf("[")));
      if (!parsed[0]?.success) throw new Error(`D1 failure: ${out.slice(0, 400)}`);
      return parsed[0].results ?? [];
    } catch (e) {
      if (i >= attempts) throw e;
      execFileSync(process.execPath, ["-e", `setTimeout(()=>{}, ${1500 * i})`]);
    }
  }
}

const BENJAMIN_UID = 2;
// Every decision except 'restore' (already resolved by the restore itself).
// Named explicitly rather than "everything else" so a new action added to the
// consolidator has to be considered here on purpose.
const RESOLVE_ACTIONS = new Set([
  "skip_maintainer_revert",   // richmahn hand-reverted these on Door43 (all MIC)
  "skip_justified",           // a Door43 human really edited this chapter in-window
  "skip_machine_artifact",    // the overwritten bytes were repair/normalize output
  "skip_already_repaired",    // a prior data_repair put content back
  "review_master_hazard",     // words survived verbatim; only alignment changed
  "review_redone",            // the translator redid the work themselves
  "review_width_sensitive",   // HOS 11:1 — Benjamin ruled: no quotation mark, keep current
]);

const decisions = fs.readFileSync(decisionsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const targets = decisions.filter((d) => RESOLVE_ACTIONS.has(d.action));
const byAction = {};
for (const t of targets) byAction[t.action] = (byAction[t.action] ?? 0) + 1;
console.log(`${targets.length} conflict row(s) to resolve${EXECUTE ? " — EXECUTE MODE" : " — dry run"}`);
console.log(JSON.stringify(byAction, null, 1));

// Chunked by book+resource so each statement stays short and auditable, and a
// single failure costs one group rather than the whole pass.
const groups = new Map();
for (const t of targets) {
  const k = `${t.book}|${t.resource}`;
  (groups.get(k) ?? groups.set(k, []).get(k)).push(t);
}

let totalOpen = 0;
const plan = [];
for (const [k, list] of groups) {
  const [book, resource] = k.split("|");
  const pairs = list.map((t) => `(${t.chapter},${t.verse})`).join(",");
  const open = d1(
    `SELECT COUNT(*) AS n FROM verse_merge_conflicts
      WHERE book='${book}' AND resource='${resource}' AND action='adopt_conflict'
        AND resolved_at IS NULL AND (chapter, verse) IN (VALUES ${pairs})`,
  )[0].n;
  totalOpen += open;
  plan.push({ book, resource, listed: list.length, open, pairs });
  console.log(`  ${book} ${resource}: ${list.length} listed, ${open} still open`);
}
console.log(`total still-open adopt_conflict rows in scope: ${totalOpen}`);

if (EXECUTE) {
  let ok = 0, failed = 0;
  for (const g of plan) {
    if (g.open === 0) continue;
    try {
      d1(`UPDATE verse_merge_conflicts SET resolved_at = unixepoch(), resolved_by = ${BENJAMIN_UID}
           WHERE book='${g.book}' AND resource='${g.resource}' AND action='adopt_conflict'
             AND resolved_at IS NULL AND (chapter, verse) IN (VALUES ${g.pairs})`);
      const left = d1(
        `SELECT COUNT(*) AS n FROM verse_merge_conflicts
          WHERE book='${g.book}' AND resource='${g.resource}' AND action='adopt_conflict'
            AND resolved_at IS NULL AND (chapter, verse) IN (VALUES ${g.pairs})`,
      )[0].n;
      if (left === 0) { ok += g.open; console.log(`  OK ${g.book} ${g.resource}: resolved ${g.open}`); }
      else { failed++; console.error(`  VERIFY FAILED ${g.book} ${g.resource}: ${left} still open`); }
    } catch (e) { failed++; console.error(`  ERROR ${g.book} ${g.resource}: ${String(e).slice(0, 200)}`); }
  }
  console.log(`\nresolved: ${ok}, failed groups: ${failed}`);
  const remaining = d1(
    `SELECT COUNT(*) AS n FROM verse_merge_conflicts WHERE action='adopt_conflict' AND resolved_at IS NULL`,
  )[0].n;
  console.log(`adopt_conflict rows still unresolved across ALL books: ${remaining}`);
}

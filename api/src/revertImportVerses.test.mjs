// #1439: the verse half of the revert report's imported-head partition
// (revertImportVerses.ts) and its record wording (export.ts
// planRevertReportAlerts, kind "usfm"). Edge cases that must stay loud; the
// payloads the real reimport writes are pinned in
// revertImportVersePayloadShape.test.mjs, the end-to-end shape in
// revertAfterImportVersesJourney.test.mjs.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/revertImportVerses.test.mjs
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier) && context.parentURL) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of [".ts", ".mjs", ".js"]) {
        if (existsSync(target + ext)) return { url: pathToFileURL(target + ext).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { loadPreImportVerses, masterVersesAsImported, partitionUsfmRevertEntriesByImport } = await import("./revertImportVerses.ts");
const { planRevertReportAlerts } = await import("./export.ts");
const { splitRevertRefs } = await import("../../scripts/watchdog/exportRevertCheck.mjs");

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const MASTER = [
  "\\id OBA",
  "\\c 1",
  "\\p",
  "\\v 1 one",
  "\\v 2 two",
  "\\v 3-4 three four",
  "\\v 4 four again",
  "\\v 5 five",
  "\\v 5 five again",
  "\\v 6 six",
  "",
].join("\n");

console.log("\n[1. master's verses as the import stores them: bridges, verses a bridge covers, and doubled keys are left out]");
const asImported = masterVersesAsImported(MASTER);
eq([...asImported.keys()], ["1:1", "1:2"], "only plain verses that appear once and no bridge covers (usfm-js drops a doubled \\v 5 and verse 6 after it)");
eq(masterVersesAsImported("\\c x\n\\v 1 broken"), masterVersesAsImported("\\c x\n\\v 1 broken"), "(a malformed file does not throw)");

console.log("\n[2. the partition]");
{
  const pre = new Map([...asImported].map(([ref, json]) => [ref, json]));
  const entries = ["1:1", "1:2", "1:3-4", "1:6"].map((ref) => ({ ref, class: "substantive" }));
  pre.set("1:2", asImported.get("1:2").replace("two", "TWO"));
  pre.set("1:6", null);
  const out = partitionUsfmRevertEntriesByImport(entries, asImported, pre, new Set());
  eq([out.attention.map((e) => e.ref), out.probablyOurs.map((e) => e.ref)], [["1:2", "1:3-4", "1:6"], ["1:1"]], "only an exact pre-import match is probably ours; a bridged ref and a null payload stay loud");
  const none = partitionUsfmRevertEntriesByImport(entries, null, pre, new Set());
  eq(none.probablyOurs, [], "master does not parse: every verse stays in attention");
}

console.log("\n[3. the loader picks the newest row at or before synced_at, of any action, and accepts only create/update]");
{
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...next) => stmt(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  const db = { prepare: (sql) => stmt(sql) };
  const NOW = 1_800_000_000;
  const SYNCED = NOW - 1000;
  const vo = (text) => JSON.stringify({ verseObjects: [{ type: "text", text }] });
  const log = (verse, action, content, at, book = "OBA") =>
    sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, source, created_at) VALUES ('verse', ?, ?, ?, ?, 'dcs_reimport', ?)`,
      )
      .run(`OBA/1/${verse}/ULT`, book, action, content == null ? null : JSON.stringify({ plain_text: "", content }), at);
  log(1, "update", vo("import"), SYNCED - 10); // the import's write: evidence
  log(2, "update", vo("import"), SYNCED - 10);
  log(2, "baseline", vo("pre-AI"), SYNCED - 5000); // back-dated but newer by id: no evidence
  log(3, "update", vo("import"), SYNCED - 10);
  log(3, "bridge", vo("bridged"), SYNCED - 5);
  log(4, "update", vo("import"), SYNCED - 10);
  log(4, "update", vo("app edit after the import"), SYNCED + 10); // after synced_at: ignored
  log(5, "update", vo("import"), SYNCED - 10);
  log(5, "update", vo("legacy null-book row"), SYNCED - 5, null); // pre-0017 NULL book: counts
  log(6, "restore", vo("restored"), SYNCED - 5);
  log(7, "update", "{not json", SYNCED - 5);
  log(8, "delete", null, SYNCED - 5);
  const refs = ["1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "1:7", "1:8", "1:9", "1:3-4"];
  const got = await loadPreImportVerses(db, "OBA", "ULT", refs, SYNCED, NOW);
  const text = (r) => {
    const v = got.get(r);
    return v == null ? v : JSON.parse(v)[0].text;
  };
  eq(text("1:1"), "import", "the import's update is read");
  eq(got.get("1:2"), null, "a newer 'baseline' row (back-dated) is no evidence, and hides the older update");
  eq(got.get("1:3"), null, "a newer 'bridge' row is no evidence");
  eq(text("1:4"), "import", "an app edit after synced_at is not the pre-import row");
  eq(text("1:5"), "legacy null-book row", "a NULL-book row for the same key counts as the newest");
  eq(got.get("1:6"), null, "'restore' is no evidence");
  eq(got.get("1:7"), null, "an unparseable payload is no evidence");
  eq(got.get("1:8"), null, "'delete' is no evidence");
  eq(got.has("1:9"), false, "no row: absent");
  eq(got.has("1:3-4"), false, "a bridged ref is not read");
}

console.log("\n[4. the record's wording for verses]");
{
  const SHA = "e1997bc45e" + "0".repeat(30);
  const sub = (ref) => ({ ref, class: "substantive" });
  const rows = [sub("1:2"), sub("1:5")];
  const plan = planRevertReportAlerts({
    book: "OBA", resource: "ult", kind: "usfm", attention: [], probablyOurs: rows,
    mechanical: true, branch: "b", generation: "g1", importedHead: { importedSha: SHA, rows },
  });
  const m = plan[0].message;
  eq(plan.map((a) => a.source), ["revert_probably_ours:OBA:ult"], "imported head: only the quiet record");
  eq(m.includes("on 2 verse(s)") && !/row/.test(m), true, "counts verses, never rows");
  eq(m.includes("held each of these verses as that import read it from master"), true, "says what was compared, not 'exactly as master has it'");
  eq(splitRevertRefs(["1:2", "1:5"], { book: "OBA", resource: "ult", exportRevert: null, probablyOurs: { id: 9, message: m } }).split, "exact", "the watchdog parses it");

  const byLineage = [sub("4:1"), sub("4:2")];
  const byImport = [sub("5:1")];
  const mixed = planRevertReportAlerts({
    book: "OBA", resource: "ult", kind: "usfm", attention: [], probablyOurs: [...byLineage, ...byImport],
    mechanical: false, branch: "b", generation: "g1", importedHead: { importedSha: SHA, rows: byImport },
  })[0].message;
  eq(/on 3 verse\(s\) .*hand-edit: 4:1, 4:2, 5:1\./s.test(mixed), true, "mixed: counts and lists every verse");
  eq(/No person touched 4:1, 4:2 since master last held our export\./.test(mixed), true, "mixed: the lineage verses get the lineage reason");
  eq(/For 5:1, the sync record shows Bible Editor imported master's current file .*held each verse as that import read it/.test(mixed), true, "mixed: the imported verse gets the import reason");
  const s = splitRevertRefs(["4:1", "4:2", "5:1"], { book: "OBA", resource: "ult", exportRevert: null, probablyOurs: { id: 9, message: mixed } });
  eq([s.probablyOursRefs, s.split], [["4:1", "4:2", "5:1"], "exact"], "mixed: the watchdog parses the full ref list");

  const tsv = planRevertReportAlerts({
    book: "2CH", resource: "tn", kind: "tsv", attention: [], probablyOurs: [sub("1:2")],
    mechanical: false, branch: "b", generation: "g1", importedHead: { importedSha: SHA, rows: [] },
  })[0].message;
  eq(/on 1 verse\(s\).*no person touched these verses/s.test(tsv), true, "TSV lineage-only wording unchanged");
}

if (failed > 0) {
  console.error(`\n${failed} revertImportVerses check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll revertImportVerses checks passed.");

// #1419: the revert report's imported-head partition trusts the edit_log
// payload the REAL reimport writes. This drives the real parser (parseTsv +
// parseTsvRow) and the real applyTsvRows on the real migration schema, then
// reads the payloads back with the real loadPreImportTsvRows and checks
// preImportRowMatchesMaster says "D1 held master's row" for every row, for
// tn, tq and twl. If the reimport's payload shape changes, this fails here
// instead of the quiet path silently going loud (or worse) in production.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/revertImportPayloadShape.test.mjs
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// bookReimport.ts imports siblings without an extension; resolve them the way
// keepMasterJourney.test.mjs does, so this file needs no run-tests.mjs entry.
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

const { applyTsvRows, parseTsvRowForTest } = await import("./bookReimport.ts");
const { parseTsv } = await import("./importParsers.ts");
const { loadPreImportTsvRows, parseTsvRowsById, preImportRowMatchesMaster } = await import("./export.ts");

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql, args = []) => ({
    _sql: sql,
    _args: args,
    bind: (...next) => stmt(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  const env = {
    DB: {
      prepare: (sql) => stmt(sql),
      batch: async (stmts) => {
        sqlite.exec("BEGIN");
        try {
          const out = stmts.map((s) => ({ meta: { changes: Number(sqlite.prepare(s._sql).run(...s._args).changes) } }));
          sqlite.exec("COMMIT");
          return out;
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
  return { sqlite, env };
}

const BOOK = "OBA";
const FILES = {
  tn:
    "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n" +
    'front:intro\tab00\t\t\t\t0\t# Obadiah\\n\\nIntro text.\n' +
    '1:1\tab01\t\trc://*/ta/man/translate/figs-metaphor\tוַיְהִי\t1\tA note with "straight quotes" and a literal\\nbreak.\n' +
    "1:2\tab02\t\t\t\t0\tTrailing literal newlines.\\n\\n\\n\n" +
    "1:3-4\tab03\tkeyterm\trc://*/ta/man/translate/figs-idiom\tq & r\t-1\tDouble  spaced  note \n",
  tq:
    "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n" +
    "1:1\tq001\t\t\t\tWho?\tHe did.\n" +
    "1:2\tq002\t\tוַיְהִי\t1\tWhat  happened?\tThis.\\n\n",
  twl:
    "Reference\tID\tTags\tOrigWords\tOccurrence\tTWLink\n" +
    "1:1\tw001\tkeyterm\tאֱלֹהִים\t1\trc://*/tw/dict/bible/kt/god\n" +
    "1:2\tw002\t\tיְהוָה\t2\trc://*/tw/dict/bible/kt/yahweh\n",
};
const TABLE = { tn: "tn_rows", tq: "tq_rows", twl: "twl_rows" };

for (const kind of ["tn", "tq", "twl"]) {
  console.log(`\n[${kind}: rows the reimport creates from master match master]`);
  const { env } = freshEnv();
  const master = FILES[kind];
  const parsed = parseTsv(master).rows.map((r) => parseTsvRowForTest(r, kind)).filter(Boolean);
  const counts = await applyTsvRows(env, BOOK, kind, parsed, null);
  ok(counts.inserted === parsed.length, `${kind}: the reimport inserted every row (${counts.inserted}/${parsed.length})`);
  const ids = parsed.map((p) => p.id);
  const syncedAt = Math.floor(Date.now() / 1000) + 5;
  const pre = await loadPreImportTsvRows(env.DB, kind, BOOK, ids, syncedAt);
  const masterRows = parseTsvRowsById(master);
  for (const id of ids) {
    ok(preImportRowMatchesMaster(masterRows.get(id), pre.get(id), kind), `${kind} ${id}: the logged create payload matches master's row`);
  }
  // A later master edit does not match the logged payload.
  const [first] = ids;
  const cells = [...masterRows.get(first)];
  cells[cells.length - 1] = cells[cells.length - 1] + " changed";
  ok(!preImportRowMatchesMaster(cells, pre.get(first), kind), `${kind} ${first}: a changed master row does not match`);
  // Writes after synced_at are not "as of the import".
  const before = await loadPreImportTsvRows(env.DB, kind, BOOK, ids, syncedAt - 3600);
  ok(before.size === 0, `${kind}: nothing logged before the import window -> no evidence`);
  // tq/twl history older than the sweep's retention window is no evidence;
  // tn history is never swept.
  const farFuture = syncedAt + 400 * 86400;
  const aged = await loadPreImportTsvRows(env.DB, kind, BOOK, ids, syncedAt, farFuture);
  ok(
    ids.every((id) => (kind === "tn" ? aged.get(id) != null : aged.get(id) === null)),
    `${kind}: an entry older than the edit_log retention window ${kind === "tn" ? "still counts (tn is never swept)" : "is no evidence"}`,
  );
}

console.log("\n[tn: a pristine row the reimport UPDATES to master's text matches master]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO ${TABLE.tn} (id, book, chapter, verse, ref_raw, support_reference, quote, occurrence, note, sort_order)
       VALUES ('ab02', ?, 1, 2, '1:2', NULL, NULL, 0, 'Old note.', 1)`,
    )
    .run(BOOK);
  const master = FILES.tn;
  const parsed = parseTsv(master).rows.map((r) => parseTsvRowForTest(r, "tn")).filter(Boolean);
  const counts = await applyTsvRows(env, BOOK, "tn", parsed, null);
  ok(counts.updated === 1, `the existing pristine row was updated from master (updated=${counts.updated})`);
  const log = sqlite.prepare(`SELECT action FROM edit_log WHERE kind = 'tn' AND row_key = 'ab02' ORDER BY id DESC LIMIT 1`).get();
  ok(log?.action === "update", `the reimport logged an update (got ${log?.action})`);
  const pre = await loadPreImportTsvRows(env.DB, "tn", BOOK, ["ab02"], Math.floor(Date.now() / 1000) + 5);
  ok(preImportRowMatchesMaster(parseTsvRowsById(master).get("ab02"), pre.get("ab02"), "tn"), "the logged update payload matches master's row");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nrevertImportPayloadShape: all passed");

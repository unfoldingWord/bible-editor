// Restore the DCS maintainer's 2026-08-07 hand cleanups of en_tn into D1.
//
// WHAT HAPPENED
//   On 2026-08-07 Richard Mahn hand-cleaned tn TSVs on unfoldingWord/en_tn
//   master (9 commits: removed stray tags, fixed rc:// links, fixed "Alternate
//   translation" labels, fixed markdown, fixed quotes, removed stray spaces).
//   D1 never absorbed those edits, so the nightly export on 2026-08-08 05:30 UTC
//   re-rendered D1 over master and reverted much of his work.
//
// WHY WE PATCH D1 AND NOT MASTER
//   D1 is the source of truth for the nightly render. Patching master alone gets
//   reverted again the next night. So the restore target is tn_rows.
//
// THREE-WAY COMPARE (per row id, per FIELD — a row can be RESTORE for `tags`
// and SKIP_CHANGED for `note`)
//   V_base = the field at c69d5cb77e  (master immediately BEFORE his first commit)
//   V_rich = the field at e2096cb70a  (master after his LAST commit that day)
//   V_ours = the field in our 2026-08-08 export commit for that book
//   V_now  = the field currently in prod D1
//   The candidate set is every (id, field) where V_base !== V_rich — i.e. what he
//   actually changed. Anything else is out of scope.
//
// BUCKETS
//   ALREADY_OK   V_now already equals V_rich — nothing to do.
//   AUTO_FIXED   note-only. V_now !== V_rich, but the CURRENT normalizeNoteText
//                (the stripSpaceBeforeLiteralN / dropWhitespaceOnlyLines /
//                normalizeNoteWhitespace normalizers just wired into
//                api/src/tsvFormat.ts) already renders V_now as V_rich, so the
//                next export emits his text with no D1 write. Must NOT be
//                double-counted as work.
//   RESTORE      what the next export would emit still equals V_ours — nobody has
//                touched it since our revert — so writing V_rich is safe.
//   SKIP_CHANGED neither. Somebody edited it after 2026-08-08. A HUMAN decides.
//
// APPLES-TO-APPLES CAVEAT (and the two signals we report)
//   V_ours comes from the exported TSV, so the `note` column there has been
//   through normalizeNoteText + TSV cell escaping, while V_now is D1's raw
//   stored value. A direct string compare is therefore NOT apples-to-apples. We
//   compare "what the next export would emit from V_now" against V_ours, which
//   is. As an INDEPENDENT second signal we also check `updated_at`: a row whose
//   updated_at predates our 2026-08-08 export commit cannot have been edited
//   since. Both signals are reported per row and every disagreement is listed —
//   those are the interesting cases (content says untouched but the timestamp
//   says edited, or the reverse).
//
// USAGE (from repo root; Node 24)
//   node --experimental-strip-types --no-warnings scripts/restore-rich-cleanups.mjs
//   node --experimental-strip-types --no-warnings scripts/restore-rich-cleanups.mjs --book HOS
//   node --experimental-strip-types --no-warnings scripts/restore-rich-cleanups.mjs --json out.json
//   node --experimental-strip-types --no-warnings scripts/restore-rich-cleanups.mjs --apply   # WRITES
//
// SAFETY
//   • Dry run is the DEFAULT. Nothing is written without an explicit --apply.
//   • Every D1 read is asserted to be a bare SELECT before it is handed to
//     wrangler (assertReadOnly below); the dry-run path cannot emit a write.
//   • --apply re-reads prod and re-buckets from scratch, and refuses any row that
//     has moved out of RESTORE since the dry run.
//   • Each UPDATE is version-CAS'd (AND version = <version read at apply time>)
//     and re-asserts deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0
//     AND hint = 0, so a concurrent editor, a trash, or a protected row wins.
//   • Each UPDATE is paired with an edit_log row (source='data_repair') that is
//     itself conditional on the UPDATE having landed.
//
// READ THE `tags` RESULT BEFORE APPLYING
//   Measured 2026-08-10: the bulk of the restore is HOS `tags`, and every one of
//   those is Rich clearing a value the AI pipeline wrote — "ISSUE:MATCH_FAIL",
//   "at-fit", "keep". Nothing in this repo writes them and no editor surface
//   renders `tags`, so they are pipeline diagnostics that leak to master. The
//   same values sit on ~1,715 further rows in books he has NOT cleaned, so
//   clearing 82 HOS rows here treats the symptom; filtering them at export time
//   treats the cause. That is a scope call for a human — this script reports it
//   and does not decide it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");
const outDir = resolve(repoRoot, "scripts", "out");
const cacheDir = resolve(outDir, "rich-restore-cache");

// ── Provenance: every SHA below was resolved from the DCS API, never guessed ──

// master immediately before Rich's first 2026-08-07 commit.
const BASE_SHA = "c69d5cb77e0e05a6f98464260cb31bf170f29df4";
// master after Rich's last 2026-08-07 commit (his 9 commits are a linear chain,
// with no other author in between, so this one tree carries all of his work).
const RICH_SHA = "e2096cb70aeb162189eb1dc92e1f6a122b8c856d";

// His 9 commits, for the report header (resolved short -> full via the API).
const RICH_COMMITS = [
  ["fdee7738c957041a76bc356b15c739ca3d051297", "Removes tags", "HOS"],
  ["06cbf89223b2eb06fcc4b8aef69f5621f5a2ff44", "Cleans up tags", "HOS"],
  ["3f41589163c5e6f7aaadeb5f0a61e7f771d16268", "Fixes bad links", "HOS ISA ZEC"],
  ["1582f2de65067a12d7b41ca284ce37f55b3d8a98", "Fixes bad ATs", "HOS ISA"],
  ["12c8c2fe0f3607759c1c68b181aca8d56441c459", "Fixes bad markdown", "HOS ISA"],
  ["d7917337b1e5732f5885d2bfe647cc681031dffd", "Fixes bad ATs", "DAN HOS ISA MIC NUM ZEC"],
  ["6437d32361bf0bbbc53fddb9e78943dcefad9d5f", "Fixees quote", "HOS"],
  ["f2939472311464dc91787fa5ef1870dbf3ef3317", "removes unnecessary spaces", "DAN EZK HOS ISA LAM MIC NUM"],
  ["e2096cb70aeb162189eb1dc92e1f6a122b8c856d", "Fixes quote", "HOS"],
];

// Our 2026-08-08 export: one commit per book (the export workflow commits each
// book separately). `ts` is the commit time, used as the updated_at cutoff.
const OURS = {
  DAN: { sha: "da3972ffc9e0de8113266fe481d80e4e8a1ab4bc", ts: "2026-08-08T05:46:59Z" },
  EZK: { sha: "8f9f98754e9056f4c9229ab4ed354c9102be34f2", ts: "2026-08-08T05:47:36Z" },
  HOS: { sha: "eb362af7a8600cfd96fde96e64120eeb2a658827", ts: "2026-08-08T05:48:32Z" },
  ISA: { sha: "64d004aa7c62205db1fb18c4bff7b0de6727bddc", ts: "2026-08-08T05:48:41Z" },
  LAM: { sha: "d5ac302b3895b2570cb2a0fb3278469733803543", ts: "2026-08-08T05:49:02Z" },
  MIC: { sha: "615b7cc68ac7eefb5d5a18f65ed9255c57689797", ts: "2026-08-08T05:49:57Z" },
  NUM: { sha: "d9304c55f67f664b2889eee37cddd1b9de9a03ae", ts: "2026-08-08T05:50:10Z" },
  ZEC: { sha: "09939215fa0eba541d0e4978296720192b9d707e", ts: "2026-08-08T05:50:31Z" },
};
const BOOKS = Object.keys(OURS);

// The export CRON fires at 05:30 UTC and renders D1 then; the commits land ~17
// minutes later. A row edited inside that window is genuinely ambiguous (the
// render may or may not have seen it), so it gets called out rather than
// silently folded into "untouched".
const CRON_START = Math.floor(Date.parse("2026-08-08T05:30:00Z") / 1000);

// TSV columns, in the order buildTnTsv writes them (api/src/export.ts).
const TSV_COLS = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence", "Note"];
// D1 column <-> TSV column, for the five fields we compare.
const FIELDS = [
  { db: "tags", tsv: "Tags" },
  { db: "support_reference", tsv: "SupportReference" },
  { db: "quote", tsv: "Quote" },
  { db: "occurrence", tsv: "Occurrence" },
  { db: "note", tsv: "Note" },
];

const D1_COLUMNS =
  "id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note," +
  " updated_by, version, updated_at, deleted_at, trashed_at, preserve, hint";

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const NO_FETCH = args.includes("--no-fetch");
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const bookFilter = (argVal("--book") || "").toUpperCase() || null;
const jsonOut = argVal("--json");
if (bookFilter && !BOOKS.includes(bookFilter)) {
  console.error(`--book ${bookFilter} is not one of ${BOOKS.join(", ")}`);
  process.exit(1);
}
const booksInScope = bookFilter ? [bookFilter] : BOOKS;

// ── which fields --apply may WRITE ────────────────────────────────────────────
// The ANALYSIS always covers all five fields — narrowing the write set must
// never narrow the evidence. This gate applies to the write path only.
//
// `tags` is EXCLUDED BY DEFAULT and deliberately so. Every HOS `tags` restore is
// Rich clearing a pipeline diagnostic ("ISSUE:MATCH_FAIL", "at-fit", "keep") that
// bp-assistant wrote; the same values sit on ~1,715 rows in books he has not
// cleaned, so clearing 82 HOS rows treats the symptom. The decision (2026-08-10)
// is to fix the cause with an export-time filter instead, so this script must not
// write a single `tags` value unless a human asks for it explicitly by name.
const ALL_FIELD_NAMES = FIELDS.map((f) => f.db);
const CONTENT_FIELD_NAMES = ALL_FIELD_NAMES.filter((f) => f !== "tags");
const fieldsArg = argVal("--fields");
let applyFieldNames = fieldsArg
  ? fieldsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : CONTENT_FIELD_NAMES.slice();
const unknownFields = applyFieldNames.filter((f) => !ALL_FIELD_NAMES.includes(f));
if (unknownFields.length) {
  console.error(`--fields: unknown field(s) ${unknownFields.join(", ")}; known: ${ALL_FIELD_NAMES.join(", ")}`);
  process.exit(1);
}
// --skip-tags is a belt-and-braces override: it can only ever REMOVE tags from
// the write set, never add it, so it is safe to pass alongside any --fields.
if (args.includes("--skip-tags")) applyFieldNames = applyFieldNames.filter((f) => f !== "tags");
const APPLY_FIELDS = new Set(applyFieldNames);
if (!APPLY_FIELDS.size) {
  console.error("--fields left nothing writable; refusing to run with an empty write set.");
  process.exit(1);
}

// A field may be written only if the analysis says it is a clean, unprotected
// RESTORE *and* it is in the write set.
const applyEligible = (f) => f.writable && APPLY_FIELDS.has(f.field);

// ── export-side render, shared with the Worker ────────────────────────────────
// Imported (never reimplemented) so this script and the nightly export cannot
// drift. pathToFileURL because a bare Windows path is not a legal ESM specifier.

const { normalizeNoteText } = await import(
  pathToFileURL(resolve(apiDir, "src", "tsvFormat.ts")).href
);
const { renderOccurrence } = await import(
  pathToFileURL(resolve(apiDir, "src", "occurrenceRule.ts")).href
);

// api/src/export.ts tsvCell, verbatim. A stored value only reaches master after
// this escaping, so it has to be applied before any compare against a TSV cell.
function tsvCell(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, " ");
}

// What the NEXT nightly export would put in the TSV for this field, given the
// row as it currently stands in D1. This is the only value that is
// apples-to-apples with a cell read out of master.
function renderField(dbField, row) {
  if (dbField === "note") return tsvCell(normalizeNoteText(row.note));
  if (dbField === "occurrence") return tsvCell(renderOccurrence("tn", row.quote, row.occurrence));
  return tsvCell(row[dbField]);
}

// ── DCS fetch ─────────────────────────────────────────────────────────────────

// TRAP: a bad raw path on DCS answers 200 with an ~11-byte error page, not an
// HTTP error. Never trust a body we have not length- and shape-checked.
const MIN_TSV_BYTES = 2000;

function fetchTsvRaw(sha, book) {
  const cacheFile = join(cacheDir, `${book}.${sha.slice(0, 10)}.tsv`);
  if (existsSync(cacheFile) && statSync(cacheFile).size >= MIN_TSV_BYTES) {
    return readFileSync(cacheFile, "utf8");
  }
  if (NO_FETCH) throw new Error(`--no-fetch but ${cacheFile} is missing or too small`);
  const url = `https://git.door43.org/unfoldingWord/en_tn/raw/commit/${sha}/tn_${book}.tsv`;
  const r = spawnSync("curl", ["-sSL", "--fail", url], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`curl failed for ${url}: ${r.stderr || r.status}`);
  const body = r.stdout ?? "";
  if (body.length < MIN_TSV_BYTES) {
    throw new Error(
      `REFUSING to parse ${book}@${sha.slice(0, 10)}: got ${body.length} bytes` +
        ` (< ${MIN_TSV_BYTES}). DCS answers a bad raw path with a tiny error page, not a 404.` +
        ` Body: ${JSON.stringify(body.slice(0, 200))}`,
    );
  }
  const header = body.split("\n", 1)[0].split("\t");
  if (header.join("\t") !== TSV_COLS.join("\t")) {
    throw new Error(
      `REFUSING to parse ${book}@${sha.slice(0, 10)}: unexpected header ${JSON.stringify(header)}`,
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, body, "utf8");
  return body;
}

// id -> { Reference, ID, Tags, SupportReference, Quote, Occurrence, Note }.
// Cells cannot contain a tab or a real newline (the export escapes both), so a
// naive split is correct here — and any row that does not have exactly 7 cells
// is surfaced, not silently dropped.
function parseTsv(text, label) {
  const lines = text.split("\n");
  const byId = new Map();
  const malformed = [];
  const dupes = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const cells = line.split("\t");
    if (cells.length !== TSV_COLS.length) {
      malformed.push({ line: i + 1, cells: cells.length, head: line.slice(0, 80) });
      continue;
    }
    const rec = {};
    TSV_COLS.forEach((c, j) => (rec[c] = cells[j]));
    if (byId.has(rec.ID)) dupes.push(rec.ID);
    else byId.set(rec.ID, rec);
  }
  if (malformed.length) {
    console.warn(`  ! ${label}: ${malformed.length} malformed line(s):`, malformed.slice(0, 3));
  }
  if (dupes.length) {
    console.warn(`  ! ${label}: ${dupes.length} duplicate id(s) (first wins):`, dupes.slice(0, 5));
  }
  return byId;
}

// ── D1 (read-only) ────────────────────────────────────────────────────────────

// Belt and braces: nothing that is not a bare SELECT ever reaches wrangler on
// the read path, whatever a future edit to this file does.
function assertReadOnly(sql) {
  const s = sql.trim().replace(/\s+/g, " ");
  if (!/^SELECT /i.test(s)) throw new Error(`read path refused a non-SELECT statement: ${s.slice(0, 120)}`);
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH)\b/i.test(s)) {
    throw new Error(`read path refused a statement containing a write keyword: ${s.slice(0, 120)}`);
  }
  return sql;
}

// Resolve wrangler's own JS entry point so we can invoke it with `node` and
// shell:false. Two reasons this matters:
//   • `npx` on Windows needs a shell, and a shell mangles the quotes and the
//     Unicode inside the SQL. Passing argv directly avoids the shell entirely.
//   • `--file` is NOT usable for reads: against --remote it routes through D1's
//     import endpoint, which answers with an upload SUMMARY ("Rows read": n)
//     instead of the selected rows — and reports changed_db:true even for a pure
//     SELECT. Reads go through --command, which returns real `results`.
const WRANGLER_BIN = [
  resolve(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
  resolve(apiDir, "node_modules", "wrangler", "bin", "wrangler.js"),
].find((p) => existsSync(p));
if (!WRANGLER_BIN) throw new Error("cannot find wrangler/bin/wrangler.js — run `npm install` first");

function runWrangler(extraArgs) {
  return spawnSync(
    process.execPath,
    [WRANGLER_BIN, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", ...extraArgs],
    { cwd: apiDir, encoding: "utf8", shell: false, maxBuffer: 512 * 1024 * 1024 },
  );
}

// wrangler interleaves progress chatter with its JSON on stdout; take the JSON.
function extractJson(stdout) {
  const s = stdout ?? "";
  const i = s.indexOf("[");
  const j = s.indexOf("{");
  const start = i < 0 ? j : j < 0 ? i : Math.min(i, j);
  if (start < 0) throw new Error(`wrangler produced no JSON:\n${s.slice(0, 2000)}`);
  return JSON.parse(s.slice(start));
}

function d1Select(sql) {
  assertReadOnly(sql);
  const r = runWrangler(["--command", sql]);
  if (r.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${r.status}).\n${(r.stderr || "").slice(0, 2000)}\n` +
        `If this is a 7403, run \`npx wrangler whoami\` once to refresh the OAuth token, then retry.`,
    );
  }
  let parsed;
  try {
    parsed = extractJson(r.stdout);
  } catch (e) {
    throw new Error(`wrangler did not return JSON: ${e.message}\n${(r.stdout || "").slice(0, 2000)}`);
  }
  if (parsed && !Array.isArray(parsed) && parsed.error) {
    throw new Error(`wrangler/Cloudflare error: ${parsed.error.text || parsed.error.name}`);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  for (const x of arr) {
    // A read must never report a write. If it does, stop — do not keep querying.
    if (x?.meta && Number(x.meta.rows_written ?? 0) > 0) {
      throw new Error(`a SELECT reported rows_written=${x.meta.rows_written} — aborting`);
    }
  }
  return arr.flatMap((x) => x.results ?? []);
}

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const sqlNum = (v) => (v == null ? "NULL" : String(Number(v)));

// Read the D1 rows for a set of ids, in chunks so no single statement gets huge.
function readD1Rows(book, ids) {
  const out = new Map();
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const sql =
      `SELECT ${D1_COLUMNS} FROM tn_rows` +
      ` WHERE book = ${sqlStr(book)} AND id IN (${slice.map(sqlStr).join(",")});`;
    for (const row of d1Select(sql)) out.set(row.id, row);
  }
  return out;
}

// ── analysis ──────────────────────────────────────────────────────────────────

function analyseBook(book) {
  const baseTsv = parseTsv(fetchTsvRaw(BASE_SHA, book), `${book}@base`);
  const richTsv = parseTsv(fetchTsvRaw(RICH_SHA, book), `${book}@rich`);
  const oursTsv = parseTsv(fetchTsvRaw(OURS[book].sha, book), `${book}@ours`);
  const cutoff = Math.floor(Date.parse(OURS[book].ts) / 1000);

  // What Rich actually changed: (id, field) pairs where base !== rich.
  const changed = []; // { id, field(db), tsvField, v_rich, v_base }
  const richAdded = [];
  const richRemoved = [];
  for (const [id, rich] of richTsv) {
    const base = baseTsv.get(id);
    if (!base) {
      richAdded.push(id);
      continue;
    }
    for (const f of FIELDS) {
      if (base[f.tsv] !== rich[f.tsv]) {
        changed.push({ id, field: f.db, tsvField: f.tsv, v_base: base[f.tsv], v_rich: rich[f.tsv] });
      }
    }
  }
  for (const id of baseTsv.keys()) if (!richTsv.has(id)) richRemoved.push(id);

  const ids = [...new Set(changed.map((c) => c.id))];
  const d1 = ids.length ? readD1Rows(book, ids) : new Map();

  const findings = [];
  for (const c of changed) {
    const ours = oursTsv.get(c.id);
    const row = d1.get(c.id);
    const v_ours = ours ? ours[c.tsvField] : null;

    if (!row) {
      findings.push({ book, ...c, bucket: "MISSING_IN_D1", v_ours, v_now: null, v_now_rendered: null });
      continue;
    }
    if (row.deleted_at != null || row.trashed_at != null) {
      findings.push({
        book, ...c, bucket: "DELETED_IN_D1", v_ours,
        v_now: row[c.field], v_now_rendered: renderField(c.field, row),
        version: row.version, updated_at: row.updated_at,
      });
      continue;
    }
    if (v_ours == null) {
      // Rich touched a row that our export commit does not contain at all.
      findings.push({
        book, ...c, bucket: "MISSING_IN_OURS", v_ours: null,
        v_now: row[c.field], v_now_rendered: renderField(c.field, row),
        version: row.version, updated_at: row.updated_at,
      });
      continue;
    }

    const rendered = renderField(c.field, row);   // what the NEXT export emits
    const raw = row[c.field] == null ? "" : String(row[c.field]);

    // The 2026-08-08 export ran the normalizers as they were THEN; `rendered`
    // runs them as they are NOW. On an untouched row those differ by exactly the
    // newly-added whitespace rules, so a plain `rendered === v_ours` would call
    // an untouched row SKIP_CHANGED whenever Rich's edit and a stray space sat in
    // the same note. Re-normalizing the exported cell with today's rules removes
    // that false positive without loosening the touched/untouched test itself.
    const oursRenormalized = c.field === "note" ? tsvCell(normalizeNoteText(v_ours)) : v_ours;

    let bucket;
    let restoreVia = null;
    if (raw === c.v_rich) bucket = "ALREADY_OK";
    else if (rendered === c.v_rich) bucket = "AUTO_FIXED";
    else if (rendered === v_ours) { bucket = "RESTORE"; restoreVia = "exact"; }
    else if (rendered === oursRenormalized) { bucket = "RESTORE"; restoreVia = "renormalized"; }
    else bucket = "SKIP_CHANGED";

    // Second, INDEPENDENT signal. `untouched` means the stored row predates the
    // export commit that reverted him, so nobody can have edited it since.
    const untouched = row.updated_at != null && row.updated_at <= cutoff;
    const inCronWindow = row.updated_at != null && row.updated_at > CRON_START && row.updated_at <= cutoff;
    const contentSaysUntouched = bucket === "RESTORE" || bucket === "AUTO_FIXED" || bucket === "ALREADY_OK";
    const signalsDisagree = contentSaysUntouched !== untouched;

    findings.push({
      book, ...c, bucket, restoreVia, v_ours,
      v_now: raw, v_now_rendered: rendered,
      version: row.version, updated_at: row.updated_at, updated_by: row.updated_by,
      preserve: row.preserve, hint: row.hint,
      ref_raw: row.ref_raw, chapter: row.chapter, verse: row.verse,
      untouched, inCronWindow, signalsDisagree,
      // Only rows that are BOTH content-clean and protection-clean may be written.
      writable: bucket === "RESTORE" && row.preserve === 0 && row.hint === 0,
    });
  }

  return { book, findings, richAdded, richRemoved, changedCount: changed.length, cutoff };
}

// ── SQL emission (apply path) ─────────────────────────────────────────────────

// One guarded UPDATE + one conditional edit_log row per restored ROW — NOT per
// field. Grouping is load-bearing, not cosmetic: HOS 10:10 (id z6jn) needs both
// `quote` and `occurrence` restored, and a statement-per-field emission pins BOTH
// to the version read at apply time. Run in sequence the first UPDATE bumps the
// row to version+1, so the second CAS matches nothing and is silently skipped —
// while its edit_log INSERT, gated on version+1, has by then become TRUE and
// would record a write that never happened. Worse, the half-applied result is a
// non-blank Quote with a blank Occurrence, which the DCS tn validator hard-
// rejects. Restoring a row is one logical repair, so it is one statement.
//
// The UPDATE cannot land on a row that moved: version CAS pins the exact revision
// read at apply time, and the protection predicates are re-asserted in the WHERE
// so a row trashed/deleted/protected between read and write is a no-op. The
// edit_log INSERT is a SELECT gated on the post-update state, so a skipped UPDATE
// also skips its audit row (never an audit trail for a write that did not
// happen). `updated_by` is deliberately NOT in the SET list: the row must stay
// attributed to the human who last edited it.
const rowKey = (f) => `${f.book}/${f.id}`;

function groupByRow(list) {
  const groups = new Map();
  for (const f of list) {
    if (!groups.has(rowKey(f))) groups.set(rowKey(f), []);
    groups.get(rowKey(f)).push(f);
  }
  return [...groups.values()];
}

function updateStatements(group, nowTs) {
  const [first] = group;
  // A group is one row at one revision. Anything else is a logic bug upstream.
  for (const f of group) {
    if (f.book !== first.book || f.id !== first.id) throw new Error(`group mixes rows: ${rowKey(f)} vs ${rowKey(first)}`);
    if (String(f.version) !== String(first.version)) {
      throw new Error(`group ${rowKey(first)} mixes versions ${first.version} and ${f.version}`);
    }
  }
  if (new Set(group.map((f) => f.field)).size !== group.length) {
    throw new Error(`group ${rowKey(first)} restores the same field twice`);
  }

  const sets = group.map((f) => {
    const value = f.field === "occurrence" ? sqlNum(f.v_rich === "" ? null : f.v_rich) : sqlStr(f.v_rich);
    return `${f.field} = ${value}`;
  });
  const payload = JSON.stringify({
    incident: "rich-2026-08-07-tn-cleanup-reverted-by-2026-08-08-export",
    fields: group.map((f) => ({ field: f.field, from: f.v_now, to: f.v_rich })),
    richSha: RICH_SHA,
    ourExportSha: OURS[first.book].sha,
  });
  const upd =
    `UPDATE tn_rows SET ${sets.join(", ")}, version = version + 1, updated_at = ${nowTs}` +
    ` WHERE book = ${sqlStr(first.book)} AND id = ${sqlStr(first.id)}` +
    ` AND version = ${sqlNum(first.version)}` +
    ` AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0;`;
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'tn',${sqlStr(first.id)},${sqlStr(first.book)},NULL,version-1,version,'restore_maintainer_cleanup',` +
    `${sqlStr(payload)},'data_repair',${nowTs}` +
    ` FROM tn_rows WHERE book = ${sqlStr(first.book)} AND id = ${sqlStr(first.id)}` +
    ` AND version = ${sqlNum(Number(first.version) + 1)};`;
  return [upd, log];
}

// ── report ────────────────────────────────────────────────────────────────────

const BUCKETS = ["RESTORE", "AUTO_FIXED", "ALREADY_OK", "SKIP_CHANGED", "MISSING_IN_D1", "MISSING_IN_OURS", "DELETED_IN_D1"];
const clip = (s, n = 80) => {
  if (s == null) return "‹null›";
  const one = String(s).replace(/\n/g, "\\n");
  return one.length > n ? one.slice(0, n) + "…" : one;
};
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function printBucketTable(findings) {
  const fieldNames = FIELDS.map((f) => f.db);
  const seen = new Set(findings.map((f) => f.bucket));
  const buckets = BUCKETS.filter((b) => seen.has(b));

  console.log(`\n${"═".repeat(100)}`);
  console.log("BUCKET COUNTS BY BOOK AND FIELD");
  console.log("═".repeat(100));
  const header = pad("book", 6) + pad("field", 19) + buckets.map((b) => padL(b, 16)).join("");
  console.log(header);
  console.log("─".repeat(header.length));

  const books = [...new Set(findings.map((f) => f.book))].sort();
  for (const book of books) {
    for (const field of fieldNames) {
      const rows = findings.filter((f) => f.book === book && f.field === field);
      if (!rows.length) continue;
      console.log(
        pad(book, 6) + pad(field, 19) +
          buckets.map((b) => padL(rows.filter((r) => r.bucket === b).length || "·", 16)).join(""),
      );
    }
    const br = findings.filter((f) => f.book === book);
    console.log(
      pad("", 6) + pad("── book total", 19) +
        buckets.map((b) => padL(br.filter((r) => r.bucket === b).length || "·", 16)).join(""),
    );
  }
  console.log("─".repeat(header.length));
  for (const field of fieldNames) {
    const rows = findings.filter((f) => f.field === field);
    if (!rows.length) continue;
    console.log(
      pad("ALL", 6) + pad(field, 19) +
        buckets.map((b) => padL(rows.filter((r) => r.bucket === b).length || "·", 16)).join(""),
    );
  }
  console.log("═".repeat(header.length));
  console.log(
    pad("TOTAL", 6) + pad("", 19) + buckets.map((b) => padL(findings.filter((r) => r.bucket === b).length, 16)).join(""),
  );
}

function printSkipChanged(findings) {
  const skips = findings.filter((f) => f.bucket === "SKIP_CHANGED");
  console.log(`\n${"═".repeat(100)}`);
  console.log(`SKIP_CHANGED — ${skips.length} field(s) a HUMAN must adjudicate (full list)`);
  console.log("  Someone edited these after our 2026-08-08 revert, so neither Rich's value nor ours is");
  console.log("  automatically right. V_now is shown raw; V_now(rendered) is what the next export emits.");
  console.log("═".repeat(100));
  if (!skips.length) {
    console.log("  (none)");
    return;
  }
  for (const f of skips) {
    console.log(
      `\n  ${f.book} ${f.ref_raw ?? `${f.chapter}:${f.verse}`}  id=${f.id}  field=${f.field}` +
        `  v=${f.version}  updated_at=${f.updated_at}${f.updated_at ? ` (${new Date(f.updated_at * 1000).toISOString()})` : ""}` +
        `  updated_by=${f.updated_by ?? "NULL"}`,
    );
    console.log(`      V_rich : ${clip(f.v_rich)}`);
    console.log(`      V_ours : ${clip(f.v_ours)}`);
    console.log(`      V_now  : ${clip(f.v_now)}`);
    if (f.v_now_rendered !== f.v_now) console.log(`      V_now* : ${clip(f.v_now_rendered)}   (* as the next export would emit it)`);
  }
}

function printSignalDisagreements(findings) {
  const dis = findings.filter((f) => f.signalsDisagree);
  console.log(`\n${"═".repeat(100)}`);
  console.log(`SIGNAL DISAGREEMENTS — ${dis.length} field(s)`);
  console.log("  Content compare and the updated_at cutoff do not agree. These are the cases where");
  console.log("  'nobody touched it' is not established by both signals; read them before applying.");
  console.log("═".repeat(100));
  if (!dis.length) {
    console.log("  (none — both signals agree on every candidate field)");
    return;
  }
  for (const f of dis.slice(0, 60)) {
    console.log(
      `  ${pad(f.book, 4)} id=${pad(f.id, 6)} field=${pad(f.field, 18)} bucket=${pad(f.bucket, 13)}` +
        ` updated_at=${f.updated_at} (${f.updated_at ? new Date(f.updated_at * 1000).toISOString() : "?"})` +
        ` content=${f.bucket === "SKIP_CHANGED" ? "TOUCHED" : "untouched"} timestamp=${f.untouched ? "untouched" : "TOUCHED"}`,
    );
  }
  if (dis.length > 60) console.log(`  … and ${dis.length - 60} more (see --json)`);
}

function printHosTags(findings) {
  console.log(`\n${"═".repeat(100)}`);
  console.log("HOS `tags` — the headline case (Rich's 'Removes tags' + 'Cleans up tags')");
  console.log("═".repeat(100));
  const hos = findings.filter((f) => f.book === "HOS" && f.field === "tags");
  console.log(`  Candidate HOS rows where Rich changed Tags : ${hos.length}`);
  for (const b of BUCKETS) {
    const n = hos.filter((f) => f.bucket === b).length;
    if (n) console.log(`    ${pad(b, 18)} ${n}`);
  }
  const emptied = hos.filter((f) => f.v_rich === "" && f.v_base !== "");
  console.log(`  …of which he CLEARED the tag entirely (base non-empty → rich empty): ${emptied.length}`);
  const rewrote = hos.filter((f) => f.v_rich !== "" && f.v_base !== "");
  console.log(`  …of which he REWROTE the tag (base non-empty → rich non-empty)    : ${rewrote.length}`);

  // WHICH tag values, not just how many. This is the load-bearing detail: the
  // values are pipeline diagnostics (bp-assistant writes them; nothing in this
  // repo does, and no editor surface renders `tags`), not translator content.
  // Clearing them row-by-row fixes HOS only — the same values sit on rows in
  // every other book, so the durable fix is an export-side filter. That is a
  // scope decision for a human, which is why this script only reports it.
  const trans = new Map();
  for (const f of hos) {
    if (f.bucket !== "RESTORE") continue;
    const k = `${JSON.stringify(f.v_now)} → ${JSON.stringify(f.v_rich)}`;
    trans.set(k, (trans.get(k) ?? 0) + 1);
  }
  if (trans.size) {
    console.log(`  RESTORE transitions (V_now → V_rich):`);
    for (const [k, n] of [...trans].sort((a, b) => b[1] - a[1])) console.log(`    ${padL(n, 5)}  ${k}`);
  }
}

function printSampleSql(findings, nowTs) {
  const eligible = findings.filter(applyEligible);
  const excluded = findings.filter((f) => f.writable && !APPLY_FIELDS.has(f.field));
  console.log(`\n${"═".repeat(100)}`);
  console.log(`SQL THAT --apply WOULD RUN — all ${eligible.length} restore(s) (PRINTED, NOT EXECUTED)`);
  console.log(`  write set (--fields) : ${[...APPLY_FIELDS].join(", ")}`);
  console.log(
    `  EXCLUDED by the write set: ${excluded.length} writable restore(s)` +
      (excluded.length ? ` — ${[...new Set(excluded.map((f) => f.field))].join(", ")}` : ""),
  );
  console.log("═".repeat(100));
  if (!eligible.length) {
    console.log("  (nothing to write)");
    return;
  }
  const groups = groupByRow(eligible);
  console.log(`  grouped into ${groups.length} row(s) — one UPDATE + one edit_log per ROW, not per field`);
  for (const g of groups) {
    console.log(`\n-- ${g[0].book} ${g[0].ref_raw} id=${g[0].id} v=${g[0].version} field(s)=${g.map((f) => f.field).join("+")}`);
    for (const f of g) {
      console.log(`--   ${f.field} from: ${clip(f.v_now, 100)}`);
      console.log(`--   ${f.field}   to: ${clip(f.v_rich, 100)}`);
    }
    for (const s of updateStatements(g, nowTs)) console.log(s);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

function runAnalysis(label) {
  console.log(`\n[${label}] reading DCS + prod D1 for ${booksInScope.join(", ")} …`);
  const all = [];
  const meta = [];
  const failures = [];
  for (const book of booksInScope) {
    try {
      const r = analyseBook(book);
      all.push(...r.findings);
      meta.push(r);
      console.log(
        `  ${pad(book, 4)} Rich changed ${padL(r.changedCount, 5)} field(s)` +
          ` across ${padL(new Set(r.findings.map((f) => f.id)).size, 4)} row(s)` +
          (r.richAdded.length ? `  +${r.richAdded.length} added` : "") +
          (r.richRemoved.length ? `  -${r.richRemoved.length} removed` : ""),
      );
    } catch (e) {
      failures.push({ book, error: String(e.message || e) });
      console.error(`  ${pad(book, 4)} FAILED: ${e.message || e}`);
    }
  }
  return { findings: all, meta, failures };
}

const nowTs = Math.floor(Date.now() / 1000);

console.log("═".repeat(100));
console.log("RESTORE RICH MAHN'S 2026-08-07 en_tn CLEANUPS INTO D1" + (APPLY ? "   *** APPLY MODE ***" : "   (DRY RUN)"));
console.log("═".repeat(100));
console.log(`  base (before him) : ${BASE_SHA}`);
console.log(`  rich (after him)  : ${RICH_SHA}`);
console.log(`  his 9 commits     :`);
for (const [sha, msg, books] of RICH_COMMITS) console.log(`     ${sha.slice(0, 10)}  ${pad(msg, 28)} ${books}`);
console.log(`  our revert        : per book, 2026-08-08 05:46–05:50Z (export cron fired ${new Date(CRON_START * 1000).toISOString()})`);
for (const b of booksInScope) console.log(`     ${pad(b, 4)} ${OURS[b].sha.slice(0, 10)}  ${OURS[b].ts}`);

const { findings, failures } = runAnalysis("analysis");

printBucketTable(findings);
printHosTags(findings);
printSignalDisagreements(findings);
printSkipChanged(findings);
printSampleSql(findings, nowTs);

const writable = findings.filter((f) => f.writable);
const autoFixed = findings.filter((f) => f.bucket === "AUTO_FIXED");
const restoreBlocked = findings.filter((f) => f.bucket === "RESTORE" && !f.writable);

console.log(`\n${"═".repeat(100)}`);
console.log("BOTTOM LINE");
console.log("═".repeat(100));
console.log(`  Fields Rich changed, in scope            : ${findings.length}`);
console.log(`  Need a D1 WRITE (RESTORE, writable)      : ${writable.length}   across ${new Set(writable.map((f) => f.book + "/" + f.id)).size} row(s)`);
const eligibleNow = findings.filter(applyEligible);
console.log(`     …IN the write set {${[...APPLY_FIELDS].join(",")}}  : ${eligibleNow.length}   across ${new Set(eligibleNow.map((f) => f.book + "/" + f.id)).size} row(s)  ← what --apply writes`);
console.log(`     …EXCLUDED by the write set           : ${writable.length - eligibleNow.length}   (not written; pass --fields to change)`);
console.log(`     …matched V_ours exactly               : ${writable.filter((f) => f.restoreVia === "exact").length}`);
console.log(`     …matched only after re-normalizing    : ${writable.filter((f) => f.restoreVia === "renormalized").length}   (the new normalizers moved the cell, not a human)`);
console.log(`  RESTORE but BLOCKED (preserve/hint set)  : ${restoreBlocked.length}`);
console.log(`  Handled by the new normalizers, no write : ${autoFixed.length}   (AUTO_FIXED — do NOT double-count)`);
console.log(`  Already correct in D1                    : ${findings.filter((f) => f.bucket === "ALREADY_OK").length}`);
console.log(`  Need a HUMAN decision                    : ${findings.filter((f) => f.bucket === "SKIP_CHANGED").length}`);
for (const b of ["MISSING_IN_D1", "MISSING_IN_OURS", "DELETED_IN_D1"]) {
  const n = findings.filter((f) => f.bucket === b).length;
  if (n) console.log(`  ${pad(b, 41)}: ${n}`);
}
if (failures.length) {
  console.log(`\n  !! ${failures.length} BOOK(S) FAILED — their numbers are ABSENT, not zero:`);
  for (const f of failures) console.log(`     ${f.book}: ${f.error}`);
}

if (jsonOut) {
  mkdirSync(dirname(resolve(repoRoot, jsonOut)), { recursive: true });
  writeFileSync(resolve(repoRoot, jsonOut), JSON.stringify({ findings, failures }, null, 2), "utf8");
  console.log(`\n  wrote full analysis → ${resolve(repoRoot, jsonOut)}`);
}

if (!APPLY) {
  console.log("\n  DRY RUN — nothing was written. Pass --apply to write the RESTORE rows to prod D1.");
  process.exit(failures.length ? 1 : 0);
}

// ── apply ─────────────────────────────────────────────────────────────────────
// Re-read prod and re-bucket from scratch; the dry-run numbers above are
// evidence for a human, never the authority for the write. Anything that has
// moved out of RESTORE since then is dropped here.

console.log(`\n${"═".repeat(100)}`);
console.log("APPLY — re-reading prod D1 and re-bucketing before writing");
console.log("═".repeat(100));
const second = runAnalysis("apply re-read");
if (second.failures.length) {
  console.error("  REFUSING to apply: a book failed on re-read. Fix the fetch/query first.");
  process.exit(1);
}
const key = (f) => `${f.book}/${f.id}/${f.field}`;
const before = new Map(findings.map((f) => [key(f), f]));
const final = [];
const dropped = [];
let excludedByFieldSet = 0;
for (const f of second.findings) {
  const prev = before.get(key(f));
  // Field gate FIRST, so an out-of-scope field can never reach the write path and
  // never clutters the drop list with noise that hides a real drop.
  if (!APPLY_FIELDS.has(f.field)) {
    if (f.writable) excludedByFieldSet++;
    continue;
  }
  if (!f.writable) {
    if (prev?.writable) dropped.push({ ...f, why: `moved out of writable RESTORE (now ${f.bucket})` });
    continue;
  }
  if (!prev?.writable) {
    dropped.push({ ...f, why: `newly writable since the dry run — not applying without a fresh review` });
    continue;
  }
  if (prev.version !== f.version) {
    dropped.push({ ...f, why: `version moved ${prev.version} → ${f.version} since the dry run` });
    continue;
  }
  final.push(f);
}
console.log(`  write set (--fields)          : ${[...APPLY_FIELDS].join(", ")}`);
console.log(`  excluded by the write set     : ${excludedByFieldSet} writable restore(s) NOT written`);
console.log(`  will write ${final.length} field(s); dropped ${dropped.length}`);
for (const d of dropped) console.log(`    DROPPED ${d.book} ${d.id} ${d.field}: ${d.why}`);
// Last line of defence: whatever the arg parsing did, nothing outside the write
// set may be emitted. A violation here means a logic bug, so stop, do not write.
for (const f of final) {
  if (!APPLY_FIELDS.has(f.field)) {
    console.error(`  ABORT: ${f.book} ${f.id} field=${f.field} is not in the write set but reached the write list.`);
    process.exit(1);
  }
}
if (!final.length) {
  console.log("  nothing to do.");
  process.exit(0);
}

const applyTs = Math.floor(Date.now() / 1000);
const finalGroups = groupByRow(final);
const HEADER_LINES = 6;
const lines = [
  `-- Restore Rich Mahn's 2026-08-07 en_tn cleanups into D1.`,
  `-- Generated ${new Date().toISOString()} by scripts/restore-rich-cleanups.mjs --apply`,
  `-- ${final.length} field update(s) across ${finalGroups.length} row(s); write set: ${[...APPLY_FIELDS].join(", ")}.`,
  `-- One UPDATE + one edit_log per ROW (a row's fields share one version CAS, so`,
  `-- emitting per field would let the first write invalidate the rest).`,
  `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file itself.`,
];
for (const g of finalGroups) lines.push(...updateStatements(g, applyTs));
mkdirSync(outDir, { recursive: true });
const applyFile = join(outDir, "restore-rich-cleanups.sql");
writeFileSync(applyFile, lines.join("\n") + "\n", "utf8");
console.log(`  wrote ${lines.length - HEADER_LINES} statement(s) for ${finalGroups.length} row(s) → ${applyFile}`);

const r = spawnSync(
  process.execPath,
  [WRANGLER_BIN, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--file", applyFile],
  { cwd: apiDir, encoding: "utf8", shell: false, maxBuffer: 512 * 1024 * 1024, stdio: "inherit" },
);
if (r.status !== 0) {
  console.error(`  wrangler exited ${r.status} — inspect ${applyFile} and prod before retrying.`);
  process.exit(1);
}
console.log(`  applied. Re-run without --apply to confirm every written field now buckets ALREADY_OK.`);

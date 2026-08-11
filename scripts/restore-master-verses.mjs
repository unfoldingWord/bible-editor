// Restore human hand-edits on DCS master that the nightly export reverted.
//
// WHAT HAPPENED (1CH / en_ult incident, 2026-08-10/11 — see STATE.md /
// docs/handoff.md for the write-up)
//   christopherrsmith committed a wholesale translationCore re-export of
//   13-1CH.usfm to unfoldingWord/en_ult master (commit 5905373879, 2026-08-10
//   16:29:09 UTC). Our nightly export (commit 00a4f29260, 2026-08-11 05:47:06
//   UTC — the very next commit on that file) rendered D1 over his work: D1
//   still held an OLDER human edit on those verses (updated_by != NULL), so
//   api/src/bookReimport.ts's pre-export DCS->D1 sync skipped absorbing his
//   fresh content into them (by design — a translator-edited verse is never
//   overwritten by the sync), and the export then wrote that stale D1 content
//   back onto master, erasing his revisions.
//
// WHY WE WRITE D1, NOT MASTER
//   D1 renders to master every night. Patching master alone gets reverted
//   again tomorrow. The restore target is the `verses` row.
//
// DECISION RULE (per verse)
//   Fetch the human's USFM at --source-commit, run it through the SAME
//   ingest pipeline the real DCS->D1 sync uses (extractVersesForRange, plus a
//   Hebrew-canonicalization pass — see INGEST PASSES below), and compare the
//   result to D1's CURRENT row for that verse:
//     • human text === D1 text                         -> NOT_REVERTED
//         (nothing to do; also catches verse-splitter false positives)
//     • human text differs, D1 updated_at is NULL       -> NO_TIMESTAMP
//         (shouldn't happen for this incident's mechanism — flagged for a
//         human, never auto-restored)
//     • human text differs, D1 updated_at < tC content date (the date baked
//       into the human's own `\id` line, e.g. "Thu Jul 16 2026 ...")
//                                                        -> RESTORE candidate
//         (D1's last edit predates his re-export, so his content is strictly
//         newer — safe to bring in)
//     • human text differs, D1 updated_at >= tC content date
//                                                        -> NEWER_EDIT_KEPT
//         (a translator edited AFTER his re-export — that edit is correctly
//         newer than his content and must NOT be clobbered)
//   RESTORE candidates then pass the guards below before being writable.
//
// INGEST PASSES (must match production, not be reinvented)
//   1. api/src/importParsers.ts:1014 extractVersesForRange(rawUsfm, ch, ch)
//        — the exact function api/src/bookReimport.ts calls for the nightly
//          DCS->D1 sync. Internally (verified by reading the source, not
//          guessed): sanitizeMarkerSpacing (importParsers.ts:1010) ->
//          usfm.toJSON -> per verse, in document order: normalizeWordPunctuation
//          (importParsers.ts:33) -> splitGluedAlignmentWords
//          (importParsers.ts:587) -> stripOrphanAlignmentMarkers
//          (importParsers.ts:632) -> dropDoubledLeadingMarkers
//          (importParsers.ts:819) -> collapseRedundantParagraphs
//          (importParsers.ts:867) -> collapseRedundantTsMilestones
//          (importParsers.ts:924). This is what satisfies trap #1
//          (splitGluedAlignmentWords MUST run) — it isn't bolted on here, it
//          is literally inside the function we call.
//   2. api/src/canonizeHebrew.ts:172 canonizeAlignmentSource(verseObjects,
//        uhbWords) — run PER VERSE after step 1, against that chapter's UHB
//        `\w` source words (read from D1, mirroring the loader at
//        api/src/pipelineImport.ts:1652 loadUhbSourceWords /
//        api/src/importParsers.ts:342 collectSourceWords). NOTE: this pass is
//        NOT inside extractVersesForRange — in production it only runs on the
//        AI-pipeline-apply path (api/src/pipelineImport.ts:1733), not on the
//        plain DCS->D1 sync, because ordinary master content is assumed to
//        already be byte-canonical. A wholesale tC re-export is exactly the
//        case that assumption doesn't hold (tC's own USFM writer emits NFC
//        combining-mark order, not UHB legacy order — the same defect class
//        documented in docs/hebrew-normalization.md for ZEC/LAM), so this
//        restore explicitly adds the pass the ordinary sync omits. This is
//        trap #2. Structure-preserving (only rewrites x-content/x-lemma
//        strings on existing milestones) — it can never unalign a word.
//
// VERSE-BOUNDARY SPLITTER SOUNDNESS (`\ts\*` / `\b`)
//   We do not roll our own verse splitter. extractVersesForRange is usfm-js
//   plus the two passes named above (dropDoubledLeadingMarkers,
//   collapseRedundantTsMilestones) that exist SPECIFICALLY to keep
//   `\ts\*`/`\b`/paragraph markers sitting on a verse boundary from being
//   mis-attributed to the wrong verse's content — the same failure mode that
//   produced the prior analysis's 7 false positives. Smoke-tested (see the
//   PR description / chat transcript) against a hand-built chapter boundary
//   carrying `\b` + `\ts\*` between 1:2 and 2:1: both markers land on
//   chapter 2's verse-0 (front) pseudo-verse with empty text, never inside
//   1:2's or 2:1's plain text — confirming boundary markers cannot leak into
//   adjacent verse content through this path.
//
// GUARDS (any failure skips that verse; reason is reported, never silently)
//   • Alignment integrity: proposed `\zaln` milestone count must be >= D1's
//     CURRENT milestone count for that verse (never SHRINK alignment
//     coverage — mirrors the shrink-guard discipline used elsewhere in this
//     repo for exactly this class of regression).
//   • D1's row must not have been edited TODAY (independent of the tC-date
//     test above — catches a same-day fix that landed after this morning's
//     export, which the tC-date test alone wouldn't distinguish from "old").
//   • The parsed proposed verse must not be empty / zero-word.
//   • version CAS: --apply re-reads D1 immediately before writing and pins
//     `AND version = <version observed at that re-read>`, so a translator
//     edit landing between planning and applying makes the UPDATE a no-op
//     (never a clobber) instead of being blindly applied.
//
// SCOPE — WHOLE BOOK vs A NAMED SET OF VERSES (--verses)
//   Without --verses this considers EVERY verse in the book, which is only ever
//   right when the source commit is a wholesale re-export of the whole file (the
//   1CH incident). For a maintainer's targeted cleanup — richmahn's 2026-08-07
//   marker/`\s1` fixes on a handful of JER/EZK/AMO verses — a whole-book run
//   would also "restore" every OTHER verse where his file happens to differ from
//   D1 and D1's last edit predates the boundary, which is emphatically not what
//   was asked for. Pass --verses to pin the run to exactly the refs under
//   discussion; anything outside the list is reported as OUT_OF_SCOPE and can
//   never be written.
//
// BOUNDARY DATE FOR A NON-tC SOURCE COMMIT (--tc-date)
//   The `\id`-line date only exists on a translationCore export. A hand-edit
//   commit (richmahn's) has no such stamp, so extractTcContentDate returns null
//   and the script refuses to guess — pass --tc-date with that commit's own
//   date, which for a hand edit IS the content date (he edited master in place,
//   so his content is exactly as new as his commit).
//
// USAGE (from repo root; Node 24)
//   node --experimental-strip-types --no-warnings scripts/restore-master-verses.mjs \
//     --book 1CH --resource ult --source-commit 5905373879
//   node --experimental-strip-types --no-warnings scripts/restore-master-verses.mjs \
//     --book 1CH --resource ult --source-commit 5905373879 --ours-commit 00a4f29260 --json out.json
//   node --experimental-strip-types --no-warnings scripts/restore-master-verses.mjs \
//     --book JER --resource ust --source-commit <richmahn-sha> \
//     --tc-date 2026-08-07T18:35:47Z --verses 32:25,32:35,37:10,38:13 \
//     --incident richmahn-2026-08-07-marker-cleanup-reverted-by-2026-08-08-export
//   node --experimental-strip-types --no-warnings scripts/restore-master-verses.mjs \
//     --book 1CH --resource ult --source-commit 5905373879 --apply   # WRITES
//
// SAFETY
//   • Dry run is the DEFAULT. Nothing is written without an explicit --apply.
//   • Every D1 read is asserted to be a bare SELECT before it reaches
//     wrangler (assertReadOnly), so the dry-run path cannot emit a write.
//   • --apply re-reads prod and re-derives the plan from scratch; anything
//     that moved off RESTORE (or whose version changed) since the dry run is
//     dropped, never force-applied.
//   • Each UPDATE is version-CAS'd; the paired edit_log row is an
//     INSERT...SELECT gated on the post-update state (version+1 AND the
//     exact new content_json), so a skipped UPDATE can never leave an audit
//     row behind for a write that didn't happen. `updated_by` is left NULL —
//     the restore is attributed via edit_log.source='data_repair' +
//     action='restore_master_verse' + a payload identifying the incident,
//     never to a translator's user id.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDir = resolve(repoRoot, "api");
const outDir = resolve(repoRoot, "scripts", "out");
const cacheDir = resolve(outDir, "restore-master-verses-cache");

// ── args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const NO_FETCH = args.includes("--no-fetch");
// --include-structural: also treat a NODE-STRUCTURE difference as a revert, not
// only a plain-text one. Required for marker-placement cleanups (\p / \s1 order,
// duplicate \q2, a comma reattached) which change no words at all and are
// therefore invisible to the plain-text test. Off by default so the 1CH
// re-export analysis stays exactly as it was.
const INCLUDE_STRUCTURAL = args.includes("--include-structural");
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const book = (argVal("--book") || "").toUpperCase();
const resource = (argVal("--resource") || "ult").toLowerCase(); // 'ult' | 'ust'
const bibleVersion = resource === "ust" ? "UST" : "ULT";
const sourceCommit = argVal("--source-commit");
const oursCommit = argVal("--ours-commit"); // optional, cross-check only
const tcDateOverride = argVal("--tc-date");
const jsonOut = argVal("--json");
const incident = argVal("--incident") || `${book.toLowerCase()}-${resource}-master-revert-${sourceCommit}`;

// --verses ch:vs[,ch:vs…] — restrict the run to exactly these refs. `null` means
// "whole book" (only appropriate for a wholesale re-export; see SCOPE above).
const verseFilter = (() => {
  const raw = argVal("--verses");
  if (!raw) return null;
  const set = new Set();
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+):(\d+)$/.exec(part.trim());
    if (!m) {
      console.error(`--verses: '${part}' is not a ch:vs ref`);
      process.exit(1);
    }
    set.add(`${Number(m[1])}:${Number(m[2])}`);
  }
  if (!set.size) {
    console.error("--verses was given but parsed to an empty set");
    process.exit(1);
  }
  return set;
})();

if (!book || !sourceCommit) {
  console.error(
    "usage: node scripts/restore-master-verses.mjs --book <BOOK> [--resource ult|ust] --source-commit <sha>" +
      " [--ours-commit <sha>] [--tc-date <iso>] [--verses ch:vs,ch:vs] [--incident <label>] [--json out.json] [--apply]",
  );
  process.exit(1);
}

// ── project's own ingest functions (imported, never reimplemented) ────────
// pathToFileURL because a bare Windows path is not a legal ESM specifier.

const { extractVersesForRange, collectSourceWords } = await import(
  pathToFileURL(resolve(apiDir, "src", "importParsers.ts")).href
);
const { canonizeAlignmentSource } = await import(
  pathToFileURL(resolve(apiDir, "src", "canonizeHebrew.ts")).href
);
const { BOOK_NUMBERS, NT_BOOKS } = await import(
  pathToFileURL(resolve(apiDir, "src", "dcsSources.ts")).href
);

const num = BOOK_NUMBERS[book];
if (!num) {
  console.error(`unknown book code: ${book}`);
  process.exit(1);
}
const usfmName = `${num}-${book}.usfm`;
const repo = resource === "ust" ? "unfoldingWord/en_ust" : "unfoldingWord/en_ult";
const srcRepo = NT_BOOKS.has(book) ? "unfoldingWord/el-x-koine_ugnt" : "unfoldingWord/hbo_uhb";
const srcBibleVersion = NT_BOOKS.has(book) ? "UGNT" : "UHB";

// ── DCS fetch (read-only), cached ──────────────────────────────────────────

const MIN_USFM_BYTES = 2000;

function fetchUsfmRaw(repoSlug, sha, file, label) {
  const cacheFile = join(cacheDir, `${label}.${sha.slice(0, 10)}.usfm`);
  if (existsSync(cacheFile) && statSync(cacheFile).size >= MIN_USFM_BYTES) {
    return readFileSync(cacheFile, "utf8");
  }
  if (NO_FETCH) throw new Error(`--no-fetch but ${cacheFile} is missing or too small`);
  const url = `https://git.door43.org/${repoSlug}/raw/commit/${sha}/${file}`;
  const r = spawnSync("curl", ["-sSL", "--fail", url], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`curl failed for ${url}: ${r.stderr || r.status}`);
  const body = r.stdout ?? "";
  if (body.length < MIN_USFM_BYTES || !body.startsWith("\\id ")) {
    throw new Error(
      `REFUSING to parse ${label}@${sha.slice(0, 10)}: got ${body.length} bytes,` +
        ` starts-with-\\id=${body.startsWith("\\id ")}. DCS answers a bad raw path with a` +
        ` small error page, not a 404. Body: ${JSON.stringify(body.slice(0, 200))}`,
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, body, "utf8");
  return body;
}

// Resolve a (possibly short) commit sha to its full sha + commit date via the
// DCS API (read-only, public, no token needed).
function resolveCommit(repoSlug, sha) {
  const url = `https://git.door43.org/api/v1/repos/${repoSlug}/git/commits/${sha}`;
  const r = spawnSync("curl", ["-sSL", "--fail", url], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`curl failed for ${url}: ${r.stderr || r.status}`);
  const json = JSON.parse(r.stdout);
  return { sha: json.sha, date: json.commit?.author?.date ?? json.created };
}

// `\id` line of a tC export looks like:
//   \id 1CH EN_ULT en_English_ltr Thu Jul 16 2026 09:25:39 GMT-0400 (Eastern Daylight Time) tc
// That date string is literally JS's own Date#toString() format, so a plain
// `new Date(str)` round-trips it correctly (verified on the real 1CH file).
function extractTcContentDate(rawUsfm) {
  const m = rawUsfm.match(/^\\id\s+\S+\s+\S+\s+\S+\s+(.+?)\s+tc\s*$/m);
  if (!m) return null;
  const d = new Date(m[1]);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// ── D1 (read-only) ──────────────────────────────────────────────────────────
// Mirrors scripts/restore-rich-cleanups.mjs verbatim (same wrangler-invocation
// reasoning: --command not --file for reads, node not npx, shell:false).

function assertReadOnly(sql) {
  const s = sql.trim().replace(/\s+/g, " ");
  if (!/^SELECT /i.test(s)) throw new Error(`read path refused a non-SELECT statement: ${s.slice(0, 120)}`);
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH)\b/i.test(s)) {
    throw new Error(`read path refused a statement containing a write keyword: ${s.slice(0, 120)}`);
  }
  return sql;
}

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
    if (x?.meta && Number(x.meta.rows_written ?? 0) > 0) {
      throw new Error(`a SELECT reported rows_written=${x.meta.rows_written} — aborting`);
    }
  }
  return arr.flatMap((x) => x.results ?? []);
}

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function readD1Verses(bookCode, bv) {
  const out = new Map(); // "ch:vs" -> row
  const sql =
    `SELECT chapter, verse, verse_end, content_json, plain_text, version, updated_by, updated_at` +
    ` FROM verses WHERE book = ${sqlStr(bookCode)} AND bible_version = ${sqlStr(bv)};`;
  for (const row of d1Select(sql)) out.set(`${row.chapter}:${row.verse}`, row);
  return out;
}

function readD1SourceVerses(bookCode, bv) {
  const out = new Map(); // chapter -> content_json[]
  const sql =
    `SELECT chapter, content_json FROM verses` +
    ` WHERE book = ${sqlStr(bookCode)} AND bible_version = ${sqlStr(bv)};`;
  for (const row of d1Select(sql)) {
    if (!out.has(row.chapter)) out.set(row.chapter, []);
    out.get(row.chapter).push(row.content_json);
  }
  return out;
}

// ── structural signature (for --include-structural) ────────────────────────
//
// WHY THIS EXISTS. The revert test above compares plain_text, which is exactly
// right for the 1CH incident (a re-export that changed WORDS and punctuation)
// and completely blind to the other shape this incident class takes: a
// maintainer's marker-placement cleanup. richmahn's 2026-08-07 fixes on
// JER/EZK/AMO ust moved `\p` and `\s1` around, deduplicated `\q2`, and
// reattached a comma — verified against DCS to change NO wording at all. Their
// plain_text is byte-identical to D1's, so a plain-text comparison buckets them
// NOT_REVERTED and restores nothing. --include-structural adds a second tier
// that compares the parsed node structure instead.
//
// It must not be a raw content_json comparison. usfm-js round-trips two
// EQUIVALENT USFM inputs to different-but-equivalent trees, and on the 1CH pair
// alone that noise accounts for 152 verses (measured): a whitespace run moves
// between a node's `nextChar` and a neighbouring text node, and `\ts\*` parses
// as {tag:"ts\\*"} or as {content:" ",endMarkerChar:" ",tag:"ts*"} depending on
// the character that follows it. So the signature deliberately erases exactly
// those two things and nothing else:
//   • pure-whitespace text nodes are dropped
//   • every `nextChar` is dropped
//   • any \ts / \ts\* milestone collapses to a bare {tag:"ts"}
//   • text values keep their characters but lose their internal whitespace
//   • node ORDER is preserved — which is the whole point, since "\p before \s1"
//     vs "\s1 before \p" IS the change we need to see
// Two verses with equal signatures differ only in usfm-js formatting noise;
// unequal signatures mean the markers, the alignment, or the words moved.
function structuralSignature(verseObjects) {
  const parts = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const text = n.text == null ? null : String(n.text);
      const pureWhitespace =
        !Array.isArray(n.children) &&
        text != null &&
        text.trim() === "" &&
        Object.keys(n).every((k) => k === "text" || k === "type" || k === "nextChar");
      if (!pureWhitespace) {
        if (/^ts\\?\*?$/.test(String(n.tag ?? ""))) {
          parts.push('{"tag":"ts"}');
        } else {
          const attrs = {};
          for (const k of Object.keys(n).sort()) {
            if (k === "nextChar" || k === "text" || k === "children") continue;
            attrs[k] = n[k];
          }
          parts.push(JSON.stringify(attrs) + "|" + (text == null ? "" : text.replace(/\s+/g, "")));
        }
      }
      if (Array.isArray(n.children)) {
        parts.push("(");
        walk(n.children);
        parts.push(")");
      }
    }
  };
  walk(verseObjects);
  return parts.join("");
}

// Ordered list of the non-alignment, non-word markers in a verse — the human-
// readable form of what a marker-placement cleanup actually moves. Alignment
// milestones and \w words are omitted so the paragraph/heading/poetry markers
// stand out; text nodes appear as `·` placeholders so ORDER stays visible.
function markerSequence(contentJson) {
  let parsed;
  try {
    parsed = JSON.parse(contentJson ?? "{}");
  } catch {
    return "‹unparseable›";
  }
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const tag = String(n.tag ?? "");
      if (tag === "w" || tag === "zaln") {
        // descend but don't name it
      } else if (tag) {
        out.push(`\\${tag}${n.text != null && String(n.text).trim() !== "" ? `(${String(n.text).trim().slice(0, 24)})` : ""}`);
      } else if (n.text != null && String(n.text).trim() !== "") {
        out.push("·");
      }
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(parsed.verseObjects ?? []);
  return out.join(" ");
}

function safeSignature(contentJson) {
  try {
    return structuralSignature(JSON.parse(contentJson ?? "{}").verseObjects ?? []);
  } catch {
    return null; // unparseable — caller treats a null as "cannot compare"
  }
}

// ── alignment / word counting (for the shrink-guard and the empty-verse guard) ──

function countAlignmentSpans(verseObjects) {
  let count = 0;
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln") count++;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return count;
}

function countWords(verseObjects) {
  let count = 0;
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") count++;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return count;
}

// ── build the proposed content for a verse: ingest passes 1 + 2 ────────────

function buildProposed(rawUsfm, uhbByChapter) {
  const extracts = extractVersesForRange(rawUsfm, 1, 999); // pass 1
  const out = new Map(); // "ch:vs" -> { chapter, verse, verseEnd, contentJson, plainText, alignSpans, wordCount }
  for (const v of extracts) {
    const parsed = JSON.parse(v.contentJson);
    const uhbWords = uhbByChapter.get(v.chapter) ?? [];
    if (Array.isArray(parsed.verseObjects) && uhbWords.length) {
      canonizeAlignmentSource(parsed.verseObjects, uhbWords); // pass 2
    }
    const contentJson = JSON.stringify(parsed);
    out.set(`${v.chapter}:${v.verse}`, {
      chapter: v.chapter,
      verse: v.verse,
      verseEnd: v.verseEnd,
      contentJson,
      plainText: v.plainText,
      signature: structuralSignature(parsed.verseObjects ?? []),
      alignSpans: countAlignmentSpans(parsed.verseObjects ?? []),
      wordCount: countWords(parsed.verseObjects ?? []),
    });
  }
  return out;
}

// ── main analysis ────────────────────────────────────────────────────────

console.log("═".repeat(100));
console.log(
  `RESTORE MASTER VERSES — ${book} ${bibleVersion}, source commit ${sourceCommit}` +
    (APPLY ? "   *** APPLY MODE ***" : "   (DRY RUN)"),
);
console.log("═".repeat(100));
console.log(
  `  revert test   : ${INCLUDE_STRUCTURAL ? "plain text OR node structure (--include-structural)" : "plain text only (default)"}`,
);
console.log(`  incident label: ${incident}`);

const humanResolved = resolveCommit(repo, sourceCommit);
console.log(`  human commit  : ${humanResolved.sha}  (${humanResolved.date})`);
let oursResolved = null;
if (oursCommit) {
  oursResolved = resolveCommit(repo, oursCommit);
  console.log(`  ours commit   : ${oursResolved.sha}  (${oursResolved.date})  [cross-check only]`);
} else {
  console.log(`  ours commit   : (none given — skipping the master cross-check; deciding on D1 vs human only)`);
}

const humanRaw = fetchUsfmRaw(repo, humanResolved.sha, usfmName, `${book}-${resource}-human`);
const oursRaw = oursResolved ? fetchUsfmRaw(repo, oursResolved.sha, usfmName, `${book}-${resource}-ours`) : null;

let tcDate = tcDateOverride ? new Date(tcDateOverride) : extractTcContentDate(humanRaw);
if (!tcDate || Number.isNaN(tcDate.getTime())) {
  console.error(
    "REFUSING to proceed: could not determine the tC content date from the human commit's \\id line," +
      " and no --tc-date override was given. Pass --tc-date <iso> explicitly.",
  );
  process.exit(1);
}
console.log(`  tC content date (from \\id line, or --tc-date): ${tcDate.toISOString()}`);

const srcRs = readD1SourceVerses(book, srcBibleVersion);
const uhbByChapter = new Map();
for (const [ch, jsons] of srcRs) {
  const words = [];
  for (const cj of jsons) {
    try {
      const p = JSON.parse(cj);
      words.push(...collectSourceWords(p.verseObjects ?? []));
    } catch {
      /* skip an unparseable source verse */
    }
  }
  uhbByChapter.set(ch, words);
}
console.log(
  `  loaded ${srcBibleVersion} source words for ${uhbByChapter.size} chapter(s) from D1 (read-only)`,
);

const humanProposed = buildProposed(humanRaw, uhbByChapter);
const oursProposed = oursRaw ? buildProposed(oursRaw, uhbByChapter) : null;

const d1Rows = readD1Verses(book, bibleVersion);
console.log(`  D1 currently holds ${d1Rows.size} ${bibleVersion} row(s) for ${book}`);

const todayStartUtc = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
})();

const BUCKETS = [
  "RESTORE",
  "OUT_OF_SCOPE",
  "NOT_REVERTED",
  "NEWER_EDIT_KEPT",
  "NO_TIMESTAMP",
  "MISSING_IN_D1",
  "EXCLUDE_ALIGNMENT_SHRINK",
  "EXCLUDE_EDITED_TODAY",
  "EXCLUDE_EMPTY",
  "SIGNAL_DISAGREEMENT",
];

const findings = [];
for (const [key, proposed] of humanProposed) {
  // --verses: anything not named is bucketed OUT_OF_SCOPE before any other test,
  // so it can never reach RESTORE and never be written.
  if (verseFilter && !verseFilter.has(key)) {
    findings.push({ key, bucket: "OUT_OF_SCOPE", chapter: proposed.chapter, verse: proposed.verse });
    continue;
  }
  const d1 = d1Rows.get(key);
  if (!d1) {
    findings.push({ key, bucket: "MISSING_IN_D1", chapter: proposed.chapter, verse: proposed.verse });
    continue;
  }

  const d1PlainText = d1.plain_text ?? "";
  const textSame = proposed.plainText === d1PlainText;
  // Structural tier (opt-in). A null D1 signature means its content_json would
  // not parse — we then refuse to claim a structural difference rather than
  // guess, so the verse falls back to the plain-text verdict alone.
  const d1Signature = INCLUDE_STRUCTURAL ? safeSignature(d1.content_json) : null;
  const structureSame = d1Signature == null ? true : proposed.signature === d1Signature;
  const sameAsD1 = textSame && structureSame;
  const diffKind = textSame ? (structureSame ? "none" : "structure") : structureSame ? "text" : "both";

  // Cross-check against master@oursCommit, if given: what our export actually
  // wrote should equal (or closely track) D1's current row, since no further
  // export has run since. A disagreement here means the row moved between the
  // export and this analysis, or the export didn't literally match D1 byte-
  // for-byte (e.g. USFM round-trip whitespace) — surfaced, not decided on.
  let signalsDisagree = false;
  if (oursProposed) {
    const ours = oursProposed.get(key);
    if (ours && ours.plainText !== d1PlainText) signalsDisagree = true;
  }

  if (sameAsD1) {
    findings.push({
      key, bucket: "NOT_REVERTED", chapter: proposed.chapter, verse: proposed.verse,
      d1PlainText, proposedPlainText: proposed.plainText, signalsDisagree, diffKind,
    });
    continue;
  }

  const base = {
    key,
    chapter: proposed.chapter,
    verse: proposed.verse,
    verseEnd: proposed.verseEnd,
    proposed,
    d1,
    d1PlainText,
    proposedPlainText: proposed.plainText,
    diffKind,
    d1AlignSpans: countAlignmentSpans(JSON.parse(d1.content_json ?? "{}").verseObjects ?? []),
    signalsDisagree,
  };

  if (d1.updated_at == null) {
    findings.push({ ...base, bucket: "NO_TIMESTAMP" });
    continue;
  }
  if (d1.updated_at >= tcDate.getTime() / 1000) {
    findings.push({ ...base, bucket: "NEWER_EDIT_KEPT" });
    continue;
  }
  // Candidate RESTORE — now run the guards, in order, reporting the first failure.
  if (d1.updated_at >= todayStartUtc) {
    findings.push({ ...base, bucket: "EXCLUDE_EDITED_TODAY" });
    continue;
  }
  if (proposed.wordCount === 0 || proposed.plainText.trim() === "") {
    findings.push({ ...base, bucket: "EXCLUDE_EMPTY" });
    continue;
  }
  if (proposed.alignSpans < base.d1AlignSpans) {
    findings.push({ ...base, bucket: "EXCLUDE_ALIGNMENT_SHRINK" });
    continue;
  }
  findings.push({ ...base, bucket: "RESTORE", writable: true });
}

// Also flag any D1 row that the human's file doesn't cover at all (verse
// deleted upstream, or an off-by-range mismatch) — reported, never guessed at.
const missingFromHuman = [];
for (const key of d1Rows.keys()) {
  if (verseFilter && !verseFilter.has(key)) continue;
  if (!humanProposed.has(key)) missingFromHuman.push(key);
}

// --verses refs that the human's file doesn't contain at all are a typo or a
// wrong source commit, not a finding — say so loudly rather than silently
// restoring nothing.
const requestedButAbsent = verseFilter ? [...verseFilter].filter((k) => !humanProposed.has(k)) : [];

// ── report ───────────────────────────────────────────────────────────────

function clip(s, n = 80) {
  if (s == null) return "‹null›";
  const one = String(s).replace(/\n/g, "\\n");
  return one.length > n ? one.slice(0, n) + "…" : one;
}
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\n${"═".repeat(100)}`);
console.log("BUCKET COUNTS");
console.log("═".repeat(100));
for (const b of BUCKETS) {
  const n = findings.filter((f) => f.bucket === b).length;
  if (n) console.log(`  ${pad(b, 28)} ${n}`);
}
if (verseFilter) {
  console.log(
    `\n  SCOPE: --verses pinned this run to ${verseFilter.size} ref(s): ${[...verseFilter].join(", ")}`,
  );
}
if (requestedButAbsent.length) {
  console.log(
    `\n  ! ${requestedButAbsent.length} --verses ref(s) are NOT PRESENT in the source commit's file` +
      ` (wrong ref or wrong --source-commit?): ${requestedButAbsent.join(", ")}`,
  );
}
if (missingFromHuman.length) {
  console.log(`  ${pad("MISSING_FROM_HUMAN_FILE", 28)} ${missingFromHuman.length}  (D1 rows the human's USFM doesn't cover)`);
}
const disagreements = findings.filter((f) => f.signalsDisagree);
if (disagreements.length) {
  console.log(`\n  ! ${disagreements.length} verse(s) where master@ours-commit disagrees with D1's current row (read, not decided on):`);
  for (const f of disagreements.slice(0, 20)) console.log(`      ${book} ${f.chapter}:${f.verse}`);
}

console.log(`\n${"═".repeat(100)}`);
console.log(`PER-VERSE TABLE — first 25 rows (full detail in --json if given)`);
console.log("═".repeat(100));
// With --verses, printing the whole book's OUT_OF_SCOPE rows would bury the
// handful of refs actually under review — so the tables below show in-scope only.
const sorted = findings
  .filter((f) => f.bucket !== "OUT_OF_SCOPE")
  .sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
for (const f of sorted.slice(0, 25)) {
  console.log(
    `  ${book} ${pad(`${f.chapter}:${f.verse}`, 8)} ${pad(f.bucket, 26)} diff=${pad(f.diffKind ?? "-", 10)}` +
      (f.d1AlignSpans != null
        ? ` spans d1=${f.d1AlignSpans} proposed=${f.proposed?.alignSpans ?? "-"}`
        : ""),
  );
  if (f.bucket !== "NOT_REVERTED" && f.d1PlainText != null) {
    console.log(`      D1 now  : ${clip(f.d1PlainText, 90)}`);
    console.log(`      proposed: ${clip(f.proposedPlainText, 90)}`);
    // A structure-only revert has identical plain text on both lines above, so
    // show the marker sequence — that IS the change being restored.
    if (f.diffKind === "structure" || f.diffKind === "both") {
      console.log(`      D1 markers      : ${clip(markerSequence(f.d1.content_json), 120)}`);
      console.log(`      proposed markers: ${clip(markerSequence(f.proposed.contentJson), 120)}`);
    }
  }
}
if (sorted.length > 25) console.log(`  … and ${sorted.length - 25} more`);

console.log(`\n${"═".repeat(100)}`);
console.log("EXCLUDED VERSES — every non-RESTORE reverted verse, with reason");
console.log("═".repeat(100));
const excluded = sorted.filter(
  (f) =>
    f.bucket !== "RESTORE" &&
    f.bucket !== "NOT_REVERTED" &&
    f.bucket !== "MISSING_IN_D1" &&
    f.bucket !== "OUT_OF_SCOPE",
);
if (!excluded.length) console.log("  (none)");
for (const f of excluded) {
  console.log(`  ${book} ${pad(`${f.chapter}:${f.verse}`, 8)} ${pad(f.bucket, 26)} updated_at=${f.d1.updated_at} (${f.d1.updated_at ? new Date(f.d1.updated_at * 1000).toISOString() : "?"}) updated_by=${f.d1.updated_by}`);
}

const restoreCandidates = findings.filter((f) => f.bucket === "RESTORE");
console.log(`\n${"═".repeat(100)}`);
console.log("BOTTOM LINE");
console.log("═".repeat(100));
const inScope = findings.filter((f) => f.bucket !== "OUT_OF_SCOPE");
console.log(`  Human-file verses parsed                 : ${humanProposed.size}`);
console.log(`  D1 rows for ${book} ${bibleVersion}                  : ${d1Rows.size}`);
if (verseFilter) console.log(`  In scope (--verses)                      : ${inScope.length} of ${findings.length}`);
console.log(`  Reverted (human differs from D1 now)     : ${inScope.length - inScope.filter((f) => f.bucket === "NOT_REVERTED" || f.bucket === "MISSING_IN_D1").length}`);
console.log(`  RESTORE (writable)                       : ${restoreCandidates.length}`);
{
  const k = {};
  for (const f of restoreCandidates) k[f.diffKind ?? "-"] = (k[f.diffKind ?? "-"] ?? 0) + 1;
  const parts = Object.entries(k).map(([a, b]) => `${a}=${b}`);
  if (parts.length) console.log(`    ...by what differs                     : ${parts.join("  ")}`);
}
console.log(`  NEWER_EDIT_KEPT (correctly not restored) : ${findings.filter((f) => f.bucket === "NEWER_EDIT_KEPT").length}`);
console.log(`  NO_TIMESTAMP (needs a human)              : ${findings.filter((f) => f.bucket === "NO_TIMESTAMP").length}`);
console.log(`  EXCLUDE_EDITED_TODAY                      : ${findings.filter((f) => f.bucket === "EXCLUDE_EDITED_TODAY").length}`);
console.log(`  EXCLUDE_EMPTY                              : ${findings.filter((f) => f.bucket === "EXCLUDE_EMPTY").length}`);
console.log(`  EXCLUDE_ALIGNMENT_SHRINK                  : ${findings.filter((f) => f.bucket === "EXCLUDE_ALIGNMENT_SHRINK").length}`);
console.log(`  NOT_REVERTED (splitter/no-op false positives caught): ${findings.filter((f) => f.bucket === "NOT_REVERTED").length}`);
console.log(`  MISSING_IN_D1                              : ${findings.filter((f) => f.bucket === "MISSING_IN_D1").length}`);

if (jsonOut) {
  mkdirSync(dirname(resolve(repoRoot, jsonOut)), { recursive: true });
  writeFileSync(
    resolve(repoRoot, jsonOut),
    JSON.stringify({ findings, missingFromHuman, tcDate: tcDate.toISOString() }, null, 2),
    "utf8",
  );
  console.log(`\n  wrote full analysis → ${resolve(repoRoot, jsonOut)}`);
}

// ── apply plan / apply ──────────────────────────────────────────────────

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function updateStatements(f, nowTs, expectedVersion) {
  const rowKey = `${book}/${f.chapter}/${f.verse}/${bibleVersion}`;
  const payload = JSON.stringify({
    incident,
    sourceCommit: humanResolved.sha,
    chapter: f.chapter,
    verse: f.verse,
    from: f.d1PlainText,
    to: f.proposedPlainText,
  });
  const upd =
    `UPDATE verses SET content_json = ${sqlStr(f.proposed.contentJson)}, plain_text = ${sqlStr(f.proposed.plainText)},` +
    ` verse_end = ${f.proposed.verseEnd == null ? "NULL" : f.proposed.verseEnd}, version = version + 1, updated_at = ${nowTs}` +
    ` WHERE book = ${sqlStr(book)} AND chapter = ${f.chapter} AND verse = ${f.verse}` +
    ` AND bible_version = ${sqlStr(bibleVersion)} AND version = ${expectedVersion};`;
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'verse',${sqlStr(rowKey)},${sqlStr(book)},NULL,${expectedVersion},${expectedVersion + 1},'restore_master_verse',` +
    `${sqlStr(payload)},'data_repair',${nowTs}` +
    ` FROM verses WHERE book = ${sqlStr(book)} AND chapter = ${f.chapter} AND verse = ${f.verse}` +
    ` AND bible_version = ${sqlStr(bibleVersion)} AND version = ${expectedVersion + 1}` +
    ` AND content_json = ${sqlStr(f.proposed.contentJson)};`;
  return [upd, log];
}

console.log(`\n${"═".repeat(100)}`);
console.log(`SQL THAT --apply WOULD RUN — all ${restoreCandidates.length} restore(s) (PRINTED, NOT EXECUTED)`);
console.log("═".repeat(100));
const nowTs = Math.floor(Date.now() / 1000);
if (!restoreCandidates.length) {
  console.log("  (nothing to write)");
} else {
  for (const f of restoreCandidates.slice(0, 25)) {
    console.log(`\n-- ${book} ${f.chapter}:${f.verse} v=${f.d1.version}`);
    for (const s of updateStatements(f, nowTs, f.d1.version)) console.log(s);
  }
  if (restoreCandidates.length > 25) console.log(`\n  … and ${restoreCandidates.length - 25} more`);
}

if (!APPLY) {
  console.log("\n  DRY RUN — nothing was written. Pass --apply to write the RESTORE rows to prod D1.");
  process.exit(0);
}

// ── APPLY: re-read prod, re-derive the plan, drop anything that moved ──────

console.log(`\n${"═".repeat(100)}`);
console.log("APPLY — re-reading prod D1 and re-deriving the plan before writing");
console.log("═".repeat(100));

const d1RowsNow = readD1Verses(book, bibleVersion);
const before = new Map(restoreCandidates.map((f) => [f.key, f]));
const finalWrites = [];
const dropped = [];
for (const [key, prev] of before) {
  const nowRow = d1RowsNow.get(key);
  if (!nowRow) {
    dropped.push({ key, why: "row disappeared from D1 since the dry run" });
    continue;
  }
  if (String(nowRow.version) !== String(prev.d1.version)) {
    dropped.push({ key, why: `version moved ${prev.d1.version} -> ${nowRow.version} since the dry run` });
    continue;
  }
  if (nowRow.updated_at != null && nowRow.updated_at >= todayStartUtc) {
    dropped.push({ key, why: "row was edited today since the dry run" });
    continue;
  }
  finalWrites.push({ ...prev, d1: nowRow });
}
console.log(`  will write ${finalWrites.length} verse(s); dropped ${dropped.length}`);
for (const d of dropped) console.log(`    DROPPED ${book} ${d.key}: ${d.why}`);

if (!finalWrites.length) {
  console.log("  nothing to do.");
  process.exit(0);
}

const applyTs = Math.floor(Date.now() / 1000);
const lines = [
  `-- Restore ${book} ${bibleVersion} human hand-edits reverted by the nightly export.`,
  `-- Generated ${new Date().toISOString()} by scripts/restore-master-verses.mjs --apply`,
  `-- source commit: ${humanResolved.sha}`,
  `-- ${finalWrites.length} verse(s). One UPDATE + one edit_log per verse, both version-CAS'd.`,
  `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file itself.`,
];
for (const f of finalWrites) lines.push(...updateStatements(f, applyTs, f.d1.version));
mkdirSync(outDir, { recursive: true });
const applyFile = join(outDir, `restore-master-verses-${book}-${bibleVersion}.sql`);
writeFileSync(applyFile, lines.join("\n") + "\n", "utf8");
console.log(`  wrote ${lines.length - 5} statement(s) for ${finalWrites.length} verse(s) → ${applyFile}`);

const r = spawnSync(
  process.execPath,
  [WRANGLER_BIN, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--file", applyFile],
  { cwd: apiDir, encoding: "utf8", shell: false, maxBuffer: 512 * 1024 * 1024, stdio: "inherit" },
);
if (r.status !== 0) {
  console.error(`  wrangler exited ${r.status} — inspect ${applyFile} and prod before retrying.`);
  process.exit(1);
}
console.log(`  applied. Re-run without --apply to confirm every written verse now buckets NOT_REVERTED.`);

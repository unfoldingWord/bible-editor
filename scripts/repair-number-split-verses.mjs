// Alignment-safe repair for the "number-split" defect — GitHub issue #452.
//
// ── WHAT IS BROKEN ─────────────────────────────────────────────────────────
//   Verses read `1, 000` / `22, 600` instead of `1,000` / `22,600`: a stray
//   space sits inside the thousands separator. In the stored verse tree the
//   broken number straddles two aligned word tokens, with the separator in a
//   plain text node between them:
//
//     \zaln-s |x-content="עֶשְׂרִ֥ים"\*\zaln-s |x-content="וְ⁠אַרְבָּעָ֖ה"\*\zaln-s |x-content="אָֽלֶף"\*
//        {tag:"w",  text:"24"}      ← left digits, an aligned word
//        {type:"text", text:", "}   ← THE DEFECT: this should be ","
//        {tag:"w",  text:"000"}     ← right digits, an aligned word
//
//   A naive string replace over the verse re-tokenizes the tree and destroys
//   the `\zaln-s`/`\zaln-e` milestones around those words — the exact failure
//   mode web/src/lib/replace.ts exists to prevent.
//
// ── WHAT THIS SCRIPT DOES ──────────────────────────────────────────────────
//   It deletes exactly one character — the space — from the text node that
//   owns it, and touches nothing else. No node is created, removed, split,
//   merged or reordered; no `\w` surface form changes; no `\zaln` milestone is
//   touched. Every other byte of content_json is preserved verbatim.
//
//   It reads a JSON dump of the affected `verses` rows (produced by a SELECT-
//   only `wrangler d1 execute --json`), transforms each verse, verifies the
//   result, and writes SQL to scripts/out/repair-number-split.sql. IT NEVER
//   TOUCHES PROD — generating and verifying the repair is the whole job; the
//   apply is a separate, human-approved step.
//
// ── WHY NOT smartEditVerse (the real edit engine) ──────────────────────────
//   Routing the join through web/src/lib/replace.ts smartEditVerse was tried
//   first and REJECTED on measurement, not preference. Joining `24, 000` into
//   `24,000` merges two `\w` tokens into one, so the engine's word-count-
//   matching "preserve" tier cannot fire and it falls to the localized-rewrite
//   tier, which splits the enclosing milestones into before/after halves.
//   Measured on the real prod rows:
//
//     1CH 7:4    zaln 14 → 17   (+3 spans, milestone chain split)
//     1CH 7:9    zaln 10 → 13   (+3)
//     1CH 7:11   zaln 15 → 19   (+4)
//     1CH 7:40   zaln 20 → 23   (+3)  AND the trailing `\ts\*` was REORDERED
//                                     ("26,000 \ts\* men." for "26, 000 men. \ts\*")
//
//   `preservedAlignment` came back false on every verse. Extra spans are not
//   free: one Hebrew source word covered by N milestone chains is the
//   doubled-alignment-card defect this repo has repaired twice before. The
//   issue's own acceptance criterion is "zero alignment spans lost (compare
//   zaln-e counts before/after per verse)", and this script asserts the
//   stronger property: zaln-s/zaln-e counts, `\w` counts, and the entire node
//   structure are BYTE-IDENTICAL before and after.
//
//   The target shape is not a guess either. 1CH 7:5 was fixed by hand in the
//   app by a translator (user 47, 2026-08-15) before this script existed, and
//   her result is exactly what a node-local space deletion produces:
//     {tag:"w",text:"87"} {type:"text",text:","} {tag:"w",text:"000"}
//   with the three-deep zaln chain around it untouched. This script reproduces
//   the human-verified fix mechanically.
//
//   Punctuation living OUTSIDE `\w` (`\w 24\w*,\w 000\w*`) is the correct
//   unfoldingWord form, not churn — see normalizeWordPunctuation in
//   api/src/importParsers.ts, which strips exactly that punctuation off `\w`
//   tokens on every import.
//
// ── THE SHAPE IS UNIFORM (measured, not assumed) ───────────────────────────
//   Surveyed against every matching row in prod D1 (183 rows, 203 defect
//   sites, corpus-wide, 2026-08-15):
//     201 sites  left=\w   comma+space in ONE text node of exactly ", "   right=\w
//       2 sites  all four characters inside one unaligned prose text node
//                (JER UST 52:28, 52:30 — no alignment present to preserve)
//   No other shape occurs. Anything that does not match is REFUSED, never
//   guessed at.
//
// ── GUARDS (a failing verse is refused, never silently written) ────────────
//   Per defect site:
//     • the character being deleted must be exactly U+0020;
//     • its owning node must NOT be a `\w` word token (deleting inside a word
//       would change that word's surface form and its alignment);
//     • no zero-width structural node (a marker, a milestone boundary) may sit
//       between the left digit and the right digit — that would mean the
//       number spans a real structural break, not a stray space.
//   Per verse, asserted before/after:
//     • `\zaln` milestone count identical (= `\zaln-s` count = `\zaln-e` count);
//     • `\w` word-token count identical;
//     • the ordered list of `\w` surface forms identical;
//     • total node count identical;
//     • the whitespace-insensitive structural signature identical — every node,
//       in order, with every attribute, differing only in whitespace. This is
//       the "diff the verse tree, whitespace-insensitive" check: since the ONLY
//       edit is a whitespace deletion, the signature must not move at all.
//   Per verse, asserted after a JSON round-trip (parse of the exact string that
//   goes into the SQL):
//     • the re-parsed tree still satisfies every check above;
//     • no `digit, space + 3 digits` site remains;
//     • the raw text equals the original raw text with exactly the recorded
//       space offsets removed — character for character;
//     • the number now reads joined (e.g. "1,000"), reported per verse.
//
// ── USAGE ──────────────────────────────────────────────────────────────────
//   1. Dump the affected rows (SELECT ONLY — never --file against --remote):
//
//        cd api
//        npx wrangler d1 execute bible_editor --remote --env production --json \
//          --command "SELECT book, chapter, verse, verse_end, bible_version, version, \
//                     content_json, plain_text, updated_at, updated_by FROM verses \
//                     WHERE book='1CH' AND bible_version='ULT' \
//                       AND plain_text GLOB '*[0-9], [0-9][0-9][0-9]*' \
//                     ORDER BY chapter, verse;" > ../scripts/out/number-split-dump.json
//
//   2. Build + verify the repair (writes SQL, touches nothing):
//
//        node scripts/repair-number-split-verses.mjs scripts/out/number-split-dump.json
//
//      Options:
//        --book 1CH          only these books (repeatable, comma-separated)
//        --bible-version ULT only these resources (comma-separated)
//        --out <path>        SQL output (default scripts/out/repair-number-split.sql)
//        --json <path>       write the full per-verse verification report
//
//   3. Apply — A SEPARATE, HUMAN-APPROVED STEP, NOT DONE BY THIS SCRIPT:
//
//        cd api
//        npx wrangler d1 execute bible_editor --remote --env production \
//          --file=../scripts/out/repair-number-split.sql
//
// ── THE SQL ────────────────────────────────────────────────────────────────
//   One UPDATE + one edit_log row per verse, following the established prod
//   verse-repair pattern (scripts/restore-master-verses.mjs):
//
//     • The UPDATE is version-CAS'd — `AND version = <version observed in the
//       dump>`. If a translator or the nightly reimport edits the row between
//       the dump and the apply, the UPDATE matches 0 rows and the repair is a
//       NO-OP for that verse. Nothing newer is ever clobbered. A skipped row
//       must be re-dumped and re-run, never force-applied.
//     • The audit row is `INSERT ... SELECT ... WHERE` the row is now at
//       version+1 AND carries exactly the content_json we wrote — so a no-op
//       UPDATE can never leave an orphan audit row behind, and a concurrent
//       edit that happens to land on version+1 does not match either.
//     • `source = 'data_repair'`, `action = 'repair_number_split'`,
//       `user_id = NULL` — this is a data repair, not a translator edit, and it
//       is never attributed to a person.
//     • `updated_by` is deliberately NOT in the SET clause. Leaving row
//       ownership untouched matches restore-master-verses.mjs. NOTE the
//       consequence: a row that is pristine (`updated_by IS NULL`) stays
//       eligible for overwrite by the nightly DCS→D1 sync, and master still
//       holds the broken bytes until our next export pushes the fix. PR #447's
//       own-publish recognition normally makes the sync skip the resource
//       entirely, so the repair survives the one night it needs to — but if
//       1CH ULT master is edited out-of-band before that export lands, the
//       repair can be reverted. Verify master after the next nightly export.
//     • No BEGIN/COMMIT: remote D1 rejects explicit transactions, and
//       `wrangler d1 execute --file` already applies the batch atomically.
//
//   `plain_text` is recomputed by applying the SAME join to the STORED
//   plain_text string rather than by re-deriving it from the tree, so the
//   column changes in exactly the one way the content changed and cannot pick
//   up incidental extraction churn. Any row whose stored plain_text had
//   already drifted from its tree is reported, not silently rewritten.
//
// Idempotent: re-running against a fresh dump of already-repaired rows finds
// no defect sites and emits no SQL.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argVal = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const listArg = (flag) => {
  const raw = argVal(flag);
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
};

// Positional = anything that is neither a flag nor the value consumed by one.
const VALUE_FLAGS = new Set(["--out", "--json", "--book", "--bible-version"]);
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    if (VALUE_FLAGS.has(argv[i])) i++;
    continue;
  }
  positionals.push(argv[i]);
}
const dumpArg = positionals[0];
if (!dumpArg) {
  console.error(
    "usage: node scripts/repair-number-split-verses.mjs <dump.json>" +
      " [--book 1CH] [--bible-version ULT] [--out <sql>] [--json <report>]",
  );
  process.exit(1);
}
const dumpPath = resolve(process.cwd(), dumpArg);
const bookFilter = listArg("--book");
const versionFilter = listArg("--bible-version");
const outDir = resolve(repoRoot, "scripts", "out");
const sqlPath = argVal("--out") ? resolve(process.cwd(), argVal("--out")) : resolve(outDir, "repair-number-split.sql");
const jsonPath = argVal("--json") ? resolve(process.cwd(), argVal("--json")) : null;

// ── the defect pattern ─────────────────────────────────────────────────────
//
// A digit, then ", ", then exactly three digits not followed by a fourth.
// Applied ONE SITE AT A TIME and re-derived after each deletion, because
// consecutive groups overlap: in "1, 100, 000" a single global pass consumes
// the "100" that the second site needs as its left digit, and would leave
// "1,100, 000" half-repaired. Iterating to a fixed point handles chained
// groups ("1,100,000", "200,000,000") correctly.
const DEFECT_RE = /(\d), (\d{3})(?!\d)/;

// ── tree model ─────────────────────────────────────────────────────────────

// Every node in document order, with the half-open [start, end) range of the
// raw character stream it contributes. Container nodes (milestones) and marker
// nodes contribute nothing and are recorded zero-width at their position, so a
// structural break between two digits is detectable rather than invisible.
function flatten(verseObjects) {
  const flat = [];
  let offset = 0;
  const walk = (nodes, parent) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== "object") continue;
      const text = typeof n.text === "string" ? n.text : "";
      flat.push({ node: n, parent, start: offset, end: offset + text.length });
      offset += text.length;
      if (Array.isArray(n.children)) walk(n.children, n);
    }
  };
  walk(verseObjects, null);
  const raw = flat.map((f) => (typeof f.node.text === "string" ? f.node.text : "")).join("");
  return { flat, raw };
}

const isWordToken = (n) => n && n.tag === "w";

function countZaln(verseObjects) {
  let c = 0;
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln") c++;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return c;
}

function wordSurfaces(verseObjects) {
  const out = [];
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") out.push(String(n.text ?? ""));
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return out;
}

function countNodes(verseObjects) {
  let c = 0;
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      c++;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return c;
}

// Whitespace-insensitive structural signature: every node, in document order,
// with every attribute it carries, and its text stripped of ALL whitespace.
// The only edit this script makes is deleting a space, so this signature MUST
// be identical before and after. Any milestone split, node reorder, word merge,
// marker move or attribute change shows up here as an inequality.
function signature(verseObjects) {
  const parts = [];
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      const attrs = {};
      for (const k of Object.keys(n).sort()) {
        if (k === "text" || k === "children") continue;
        attrs[k] = n[k];
      }
      parts.push(JSON.stringify(attrs) + "|" + String(n.text ?? "").replace(/\s+/g, ""));
      if (Array.isArray(n.children)) {
        parts.push("(");
        walk(n.children);
        parts.push(")");
      }
    }
  };
  walk(verseObjects);
  return parts.join("");
}

// ── the transform ──────────────────────────────────────────────────────────

// Repair every defect site in `verseObjects` IN PLACE (caller passes a clone).
// Returns { sites, error }. `sites` records the raw offset of each deleted
// space, in the coordinate system of the ORIGINAL raw text, so the caller can
// verify the final raw text character for character.
function repairTree(verseObjects) {
  const sites = [];
  // Offsets shift left by one for every earlier deletion; track the running
  // shift so recorded offsets stay in ORIGINAL coordinates.
  let shift = 0;
  for (let pass = 0; ; pass++) {
    if (pass > 64) return { sites, error: "did not reach a fixed point in 64 passes" };
    const { flat, raw } = flatten(verseObjects);
    const m = DEFECT_RE.exec(raw);
    if (!m) break;

    const iLeftDigit = m.index;
    const iSpace = m.index + 2;
    const iRightDigit = m.index + 3;

    const at = (i) => flat.findIndex((f) => i >= f.start && i < f.end);
    const leftIdx = at(iLeftDigit);
    const spaceIdx = at(iSpace);
    const rightIdx = at(iRightDigit);
    if (leftIdx < 0 || spaceIdx < 0 || rightIdx < 0) {
      return { sites, error: `could not locate the defect site at raw offset ${iSpace}` };
    }

    const spaceNode = flat[spaceIdx].node;
    const localIdx = iSpace - flat[spaceIdx].start;
    if (spaceNode.text[localIdx] !== " ") {
      return { sites, error: `character at raw offset ${iSpace} is not a plain space` };
    }
    if (isWordToken(spaceNode)) {
      return { sites, error: `the space sits inside a \\w word token ("${spaceNode.text}") — refusing` };
    }
    // No zero-width structural node (marker, milestone boundary) may sit
    // between the two digit-bearing nodes: that would mean the number spans a
    // genuine structural break rather than a stray space.
    for (let k = leftIdx + 1; k < rightIdx; k++) {
      if (flat[k].end === flat[k].start) {
        const n = flat[k].node;
        return {
          sites,
          error:
            `a structural node (${JSON.stringify({ tag: n.tag, type: n.type })}) sits between the` +
            ` digits at raw offset ${iSpace} — refusing`,
        };
      }
    }

    spaceNode.text = spaceNode.text.slice(0, localIdx) + spaceNode.text.slice(localIdx + 1);

    // Report the WHOLE number, not just the two digits the regex captured:
    // "36,000", not "6,000". Read it back out of the freshly repaired raw text
    // by walking outward over digits and commas from the join point.
    const healedRaw = flatten(verseObjects).raw;
    const isNumChar = (c) => c != null && /[\d,]/.test(c);
    let lo = iSpace - 1;
    while (lo > 0 && isNumChar(healedRaw[lo - 1])) lo--;
    let hi = iSpace;
    while (hi < healedRaw.length && isNumChar(healedRaw[hi])) hi++;

    sites.push({
      originalOffset: iSpace + shift,
      joined: healedRaw.slice(lo, hi).replace(/^,+|,+$/g, ""),
      was: raw.slice(Math.max(0, m.index - 24), m.index + m[0].length + 16),
    });
    shift += 1;
  }
  return { sites, error: null };
}

// Same join, applied to a flat string (used for plain_text).
function joinString(s) {
  let out = s;
  for (let i = 0; i < 64; i++) {
    const next = out.replace(DEFECT_RE, (_all, a, b) => a + "," + b);
    if (next === out) return out;
    out = next;
  }
  return out;
}

// ── input ──────────────────────────────────────────────────────────────────

// `wrangler d1 execute --json` wraps results as [{ results: [...], ... }];
// tolerate a bare array or a single object too, and tolerate wrangler's
// leading human-readable banner lines before the JSON.
function loadRows(text) {
  const i = text.indexOf("[");
  const j = text.indexOf("{");
  const start = i < 0 ? j : j < 0 ? i : Math.min(i, j);
  if (start < 0) throw new Error(`no JSON found in ${dumpPath}`);
  const parsed = JSON.parse(text.slice(start));
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length && arr[0] && Array.isArray(arr[0].results)) return arr.flatMap((x) => x.results || []);
  return arr;
}

const allRows = loadRows(readFileSync(dumpPath, "utf8"));
const rows = allRows.filter(
  (r) =>
    (!bookFilter || bookFilter.has(String(r.book).toUpperCase())) &&
    (!versionFilter || versionFilter.has(String(r.bible_version).toUpperCase())),
);

if (!rows.length) {
  console.error(`no rows to process from ${dumpPath} (after --book/--bible-version filters)`);
  process.exit(1);
}

// ── per-verse repair + verification ────────────────────────────────────────

const repaired = [];
const refused = [];
const clean = [];
const plainTextDrift = [];

for (const row of rows) {
  const ref = `${row.book} ${row.bible_version} ${row.chapter}:${row.verse}`;
  const refuse = (why) => refused.push({ ref, row, why });

  if (row.content_json == null) {
    refuse("content_json is NULL");
    continue;
  }
  let original;
  try {
    original = JSON.parse(row.content_json);
  } catch (e) {
    refuse(`content_json does not parse: ${e.message}`);
    continue;
  }
  if (!Array.isArray(original.verseObjects)) {
    refuse("content_json has no verseObjects array");
    continue;
  }
  if (row.version == null) {
    refuse("row has no version — cannot write a version-CAS'd UPDATE");
    continue;
  }

  const beforeFlat = flatten(original.verseObjects);
  if (!DEFECT_RE.test(beforeFlat.raw)) {
    clean.push(ref);
    continue;
  }

  const beforeStats = {
    zaln: countZaln(original.verseObjects),
    words: wordSurfaces(original.verseObjects),
    nodes: countNodes(original.verseObjects),
    signature: signature(original.verseObjects),
  };

  const workingContent = JSON.parse(row.content_json); // independent clone
  const { sites, error } = repairTree(workingContent.verseObjects);
  if (error) {
    refuse(error);
    continue;
  }
  if (!sites.length) {
    refuse("a defect site was detected but the transform produced no change");
    continue;
  }

  // The exact string that will go into the SQL, round-tripped back through
  // JSON.parse so every check below runs on what the database will actually
  // hold — not on the in-memory object we just mutated.
  const newContentJson = JSON.stringify(workingContent);
  let roundTripped;
  try {
    roundTripped = JSON.parse(newContentJson);
  } catch (e) {
    refuse(`repaired content_json does not round-trip: ${e.message}`);
    continue;
  }

  const afterFlat = flatten(roundTripped.verseObjects);
  const afterStats = {
    zaln: countZaln(roundTripped.verseObjects),
    words: wordSurfaces(roundTripped.verseObjects),
    nodes: countNodes(roundTripped.verseObjects),
    signature: signature(roundTripped.verseObjects),
  };

  const problems = [];
  if (afterStats.zaln !== beforeStats.zaln)
    problems.push(`zaln milestone count changed ${beforeStats.zaln} → ${afterStats.zaln}`);
  if (afterStats.words.length !== beforeStats.words.length)
    problems.push(`\\w count changed ${beforeStats.words.length} → ${afterStats.words.length}`);
  if (afterStats.words.join(" ") !== beforeStats.words.join(" "))
    problems.push("the ordered list of \\w surface forms changed");
  if (afterStats.nodes !== beforeStats.nodes)
    problems.push(`node count changed ${beforeStats.nodes} → ${afterStats.nodes}`);
  if (afterStats.signature !== beforeStats.signature)
    problems.push("whitespace-insensitive structural signature changed — the tree moved");

  // Character-exact: the new raw text must be the old raw text with exactly
  // the recorded space offsets removed, and nothing else.
  const dropped = new Set(sites.map((s) => s.originalOffset));
  const expectedRaw = [...beforeFlat.raw].filter((_c, i) => !dropped.has(i)).join("");
  if (afterFlat.raw !== expectedRaw)
    problems.push("raw text is not the original with exactly the recorded spaces removed");
  if (DEFECT_RE.test(afterFlat.raw)) problems.push("a defect site remains after the repair");

  if (problems.length) {
    refuse(problems.join("; "));
    continue;
  }

  // plain_text: apply the same join to the STORED string. Report (never
  // silently absorb) a row whose stored plain_text had already drifted from
  // its own tree — the drift predates this repair and is not ours to fix.
  const storedPlain = row.plain_text ?? "";
  const derivedBefore = beforeFlat.raw.replace(/\s+/g, " ").trim();
  if (storedPlain !== derivedBefore) plainTextDrift.push({ ref, storedPlain, derivedBefore });
  const newPlain = joinString(storedPlain);

  repaired.push({
    ref,
    row,
    sites,
    newContentJson,
    newPlain,
    zaln: beforeStats.zaln,
    words: beforeStats.words.length,
    nodes: beforeStats.nodes,
  });
}

// ── SQL ────────────────────────────────────────────────────────────────────

const sqlStr = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const nowTs = Math.floor(Date.now() / 1000);

function statementsFor(r) {
  const { row } = r;
  const rowKey = `${row.book}/${row.chapter}/${row.verse}/${row.bible_version}`;
  const v = Number(row.version);
  const match =
    `book = ${sqlStr(row.book)} AND chapter = ${Number(row.chapter)}` +
    ` AND verse = ${Number(row.verse)} AND bible_version = ${sqlStr(row.bible_version)}`;
  const payload = JSON.stringify({
    incident: "number-split-thousands-separator",
    issue: 452,
    sites: r.sites.map((s) => s.joined),
    from: row.plain_text ?? null,
    to: r.newPlain,
  });
  const update =
    `UPDATE verses SET content_json = ${sqlStr(r.newContentJson)}, plain_text = ${sqlStr(r.newPlain)},` +
    ` version = version + 1, updated_at = ${nowTs}` +
    ` WHERE ${match} AND version = ${v};`;
  // Guarded audit row. Two conditions, both necessary:
  //   1. the row is now at version+1 AND holds exactly the content we wrote —
  //      so a no-op UPDATE (the row moved on) leaves no orphan audit row, and a
  //      concurrent edit that happens to land on version+1 does not match;
  //   2. no audit row for this repair exists yet — so re-running the file after
  //      a partial apply (the natural recovery) cannot double-log. Without this
  //      the first condition alone stays TRUE forever after a successful apply,
  //      and every re-run appends another row. Verified: with the NOT EXISTS,
  //      applying the file twice leaves 38 verses and 38 audit rows.
  const log =
    `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,payload_json,source,created_at)` +
    ` SELECT 'verse',${sqlStr(rowKey)},${sqlStr(row.book)},NULL,${v},${v + 1},'repair_number_split',` +
    `${sqlStr(payload)},'data_repair',${nowTs}` +
    ` FROM verses WHERE ${match} AND version = ${v + 1} AND content_json = ${sqlStr(r.newContentJson)}` +
    ` AND NOT EXISTS (SELECT 1 FROM edit_log WHERE kind = 'verse' AND row_key = ${sqlStr(rowKey)}` +
    ` AND action = 'repair_number_split' AND new_version = ${v + 1});`;
  return [update, log];
}

const header = [
  "-- Repair the number-split defect (\"1, 000\" → \"1,000\") — GitHub issue #452.",
  `-- Generated ${new Date().toISOString()} by scripts/repair-number-split-verses.mjs`,
  `-- Source dump: ${dumpPath}`,
  `-- ${repaired.length} verse(s); ${repaired.reduce((n, r) => n + r.sites.length, 0)} defect site(s).`,
  "--",
  "-- Every verse below was verified BEFORE this file was written: zaln-s/zaln-e counts,",
  "-- \\w counts, \\w surface forms, node counts and the whitespace-insensitive structural",
  "-- signature are all identical before and after, and the raw text differs from the",
  "-- original by exactly the deleted space characters and nothing else.",
  "--",
  "-- Each UPDATE is version-CAS'd (AND version = <version read in the dump>): if the row",
  "-- moved on since the dump, the UPDATE matches 0 rows, the repair is skipped for that",
  "-- verse, and its edit_log row is not written either. Re-dump and re-run for any skipped",
  "-- row; never force-apply.",
  "--",
  "-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and `wrangler d1 execute",
  "-- --file` already applies the batch atomically.",
  "--",
  "-- Apply (human-approved step, from api/):",
  "--   npx wrangler d1 execute bible_editor --remote --env production \\",
  "--     --file=../scripts/out/repair-number-split.sql",
  "",
];

const lines = [...header];
for (const r of repaired) {
  lines.push(`-- ${r.ref}  v${r.row.version} → v${Number(r.row.version) + 1}  ` +
    `sites: ${r.sites.map((s) => s.joined).join(", ")}  (zaln ${r.zaln}, \\w ${r.words} — unchanged)`);
  lines.push(...statementsFor(r));
}

mkdirSync(dirname(sqlPath), { recursive: true });
writeFileSync(sqlPath, lines.join("\n") + "\n", "utf8");

// ── report ─────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
console.log("═".repeat(96));
console.log("REPAIR NUMBER-SPLIT VERSES — issue #452   (DRY BUILD: nothing is written to any database)");
console.log("═".repeat(96));
console.log(`  dump           : ${dumpPath}`);
console.log(`  rows in dump   : ${allRows.length}${rows.length !== allRows.length ? `  (${rows.length} after filters)` : ""}`);
console.log(`  repaired       : ${repaired.length}`);
console.log(`  defect sites   : ${repaired.reduce((n, r) => n + r.sites.length, 0)}`);
console.log(`  already clean  : ${clean.length}`);
console.log(`  REFUSED        : ${refused.length}`);
console.log("");

console.log("PER-VERSE VERIFICATION");
console.log("─".repeat(96));
console.log(`  ${pad("verse", 20)}${pad("zaln", 7)}${pad("\\w", 6)}${pad("nodes", 7)}${pad("sites", 6)}joined`);
for (const r of repaired) {
  console.log(
    `  ${pad(r.ref, 20)}${pad(`${r.zaln}=${r.zaln}`, 7)}${pad(`${r.words}`, 6)}${pad(`${r.nodes}`, 7)}` +
      `${pad(r.sites.length, 6)}${r.sites.map((s) => s.joined).join(", ")}`,
  );
}
console.log("");
console.log("  (zaln / \\w / nodes columns are before=after — a verse whose counts moved is REFUSED, not listed here)");

if (refused.length) {
  console.log("");
  console.log("REFUSED — NEEDS MANUAL REPAIR");
  console.log("─".repeat(96));
  for (const f of refused) console.log(`  ${pad(f.ref, 20)} ${f.why}`);
}

if (plainTextDrift.length) {
  console.log("");
  console.log(`PRE-EXISTING plain_text DRIFT (${plainTextDrift.length}) — stored plain_text already disagreed with its own tree.`);
  console.log("The repair applies the join to the STORED string, so this drift is neither fixed nor worsened here.");
  console.log("─".repeat(96));
  for (const d of plainTextDrift.slice(0, 10)) console.log(`  ${d.ref}`);
  if (plainTextDrift.length > 10) console.log(`  … and ${plainTextDrift.length - 10} more`);
}

console.log("");
console.log(`SQL written → ${sqlPath}`);
console.log("NOT APPLIED. Apply is a separate, human-approved step (see the header of that file).");

if (jsonPath) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dump: dumpPath,
        repaired: repaired.map((r) => ({
          ref: r.ref,
          book: r.row.book,
          chapter: r.row.chapter,
          verse: r.row.verse,
          bibleVersion: r.row.bible_version,
          version: r.row.version,
          updatedBy: r.row.updated_by ?? null,
          zaln: r.zaln,
          words: r.words,
          nodes: r.nodes,
          sites: r.sites,
          newPlainText: r.newPlain,
        })),
        refused: refused.map((f) => ({ ref: f.ref, why: f.why })),
        clean,
        plainTextDrift,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Report written → ${jsonPath}`);
}

process.exit(refused.length ? 2 : 0);

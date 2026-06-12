// Scan stored verses for compound alignment groups whose `\zaln-s` milestones
// are nested in the WRONG order — i.e. divergent from canonical UHB/UGNT text
// order. A few AI-generated alignments stamp a compound reversed (e.g. ZEC
// 6:13 UST nested הֵיכַל before its אֵת direct-object marker), which made the
// RTL card render the Hebrew backwards. This is GENERAL — it flags any reversed
// compound (verb+suffix, article+noun, preposition+noun, …), not just את cases.
//
// Detection is independent of the parser's own normalization: it walks the raw
// verseObjects, and for each nested zaln chain wrapping words it resolves each
// link to a source position and checks the chain is non-decreasing. Repair (when
// asked) rewrites content_json via parseAlignment→serializeAlignment, which now
// emits canonical order — applied ONLY to flagged verses, so clean rows never churn.
//
// Workflow:
//   1. Dump verses to JSON (run from api/):
//        npx wrangler d1 execute bible_editor_dev --local \
//          --command "SELECT book,chapter,verse,bible_version,content_json,version FROM verses" \
//          --json > ../scripts/out/verses-dump.json
//      (prod: bible_editor --remote --env production)
//   2. Scan (report only):
//        node --experimental-strip-types --no-warnings scripts/scan-align-order.mjs scripts/out/verses-dump.json
//   3. Emit repair SQL for flagged verses:
//        node --experimental-strip-types --no-warnings scripts/scan-align-order.mjs scripts/out/verses-dump.json --repair
//      → scripts/out/repair-align-order.sql   (apply with wrangler d1 execute --file=…)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAlignment, serializeAlignment } from "../web/src/lib/alignment.ts";
import { nfc } from "../web/src/lib/hebrew.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const dumpPath = process.argv[2];
const doRepair = process.argv.includes("--repair");
if (!dumpPath) {
  console.error("usage: node scripts/scan-align-order.mjs <verses-dump.json> [--repair]");
  process.exit(1);
}

// wrangler --json wraps results as [{ results: [...] }] (or sometimes a bare
// array). Normalize to the row array.
function loadRows(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw) && raw[0]?.results) return raw.flatMap((r) => r.results ?? []);
  if (Array.isArray(raw)) return raw;
  if (raw?.results) return raw.results;
  throw new Error("unrecognized dump shape");
}

const SOURCE_OF = { ULT: "UHB", UST: "UHB", GLT: "UHB", GST: "UHB" }; // OT; NT resolves UGNT below
function sourceVersionFor(targetVersion, hasUhb, hasUgnt) {
  // Prefer whichever OL source is present for that verse.
  if (hasUhb) return "UHB";
  if (hasUgnt) return "UGNT";
  return SOURCE_OF[targetVersion] ?? "UHB";
}

// Ordered source words (text NFC + strong + position) for one source verse's
// verseObjects, plus a resolver mirroring alignment.ts findSourcePosition.
function buildSourceWords(verseObjects) {
  const out = [];
  const textCounts = new Map();
  let pos = 0;
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") {
        const textKey = nfc(String(n.text ?? ""));
        const tOcc = (textCounts.get(textKey) ?? 0) + 1;
        textCounts.set(textKey, tOcc);
        out.push({ position: pos++, strong: String(n.strong ?? ""), textKey, textOccurrence: tOcc });
      } else if (n.type === "milestone" || (n.type === "section" && n.tag === "d")) {
        walk(n.children ?? []);
      }
    }
  };
  walk(verseObjects);
  return out;
}

function findSourcePosition(sourceWords, link) {
  const want = parseInt(link.occurrence, 10) || 1;
  if (link.content) {
    const wantKey = nfc(link.content);
    let count = 0, firstPos = -1;
    for (const sw of sourceWords) {
      if (sw.textKey === wantKey) {
        count++;
        if (firstPos === -1) firstPos = sw.position;
        if (count === want) return sw.position;
      }
    }
    if (firstPos !== -1) return firstPos;
  }
  if (link.strong) {
    let count = 0, firstPos = -1;
    for (const sw of sourceWords) {
      if (sw.strong === link.strong) {
        count++;
        if (firstPos === -1) firstPos = sw.position;
        if (count === want) return sw.position;
      }
    }
    if (firstPos !== -1) return firstPos;
  }
  return -1;
}

// Walk the target verseObjects collecting each zaln chain that directly wraps a
// word. Returns chains of >= 2 links (compounds) as arrays of {strong,occurrence,content}.
function collectCompoundChains(verseObjects) {
  const chains = [];
  const seen = new Set();
  const walk = (nodes, stack) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.tag === "zaln" && n.type === "milestone") {
        const link = {
          strong: String(n.strong ?? ""),
          occurrence: String(n.occurrence ?? ""),
          content: n.content !== undefined ? String(n.content) : "",
        };
        const nextStack = [...stack, link];
        const children = n.children ?? [];
        const wrapsWord = children.some((c) => c && c.type === "word" && c.tag === "w");
        if (wrapsWord && nextStack.length >= 2) {
          const key = nextStack.map((l) => `${l.strong}|${l.occurrence}|${nfc(l.content)}`).join("~");
          if (!seen.has(key)) {
            seen.add(key);
            chains.push(nextStack);
          }
        }
        walk(children, nextStack);
      } else if (n.children) {
        walk(n.children, stack);
      }
    }
  };
  walk(verseObjects, []);
  return chains;
}

const rows = loadRows(dumpPath);

// Index source verses by book/chapter/verse/version for pairing.
const byKey = new Map(); // `${book}/${ch}/${v}` -> { [version]: row }
for (const r of rows) {
  const k = `${r.book}/${r.chapter}/${r.verse}`;
  if (!byKey.has(k)) byKey.set(k, {});
  byKey.get(k)[r.bible_version] = r;
}

const TARGET_VERSIONS = new Set(["ULT", "UST", "GLT", "GST"]);
const flagged = []; // { book, chapter, verse, version, row, chains: [{order, positions}] }
const stats = new Map(); // `${book}/${version}` -> { verses, compounds, reversed }

for (const r of rows) {
  if (!TARGET_VERSIONS.has(r.bible_version)) continue;
  let content;
  try {
    content = JSON.parse(r.content_json);
  } catch {
    continue;
  }
  const vo = content?.verseObjects;
  if (!Array.isArray(vo)) continue;

  const peers = byKey.get(`${r.book}/${r.chapter}/${r.verse}`) ?? {};
  const srcVersion = sourceVersionFor(r.bible_version, !!peers.UHB, !!peers.UGNT);
  const srcRow = peers[srcVersion];
  if (!srcRow) continue;
  let srcContent;
  try {
    srcContent = JSON.parse(srcRow.content_json);
  } catch {
    continue;
  }
  const sourceWords = buildSourceWords(srcContent?.verseObjects ?? []);
  if (sourceWords.length === 0) continue;

  const statKey = `${r.book}/${r.bible_version}`;
  const st = stats.get(statKey) ?? { verses: 0, compounds: 0, reversed: 0 };
  st.verses++;

  const chains = collectCompoundChains(vo);
  const badChains = [];
  for (const chain of chains) {
    st.compounds++;
    const positions = chain.map((l) => findSourcePosition(sourceWords, l));
    // Only judge chains we can fully resolve (no -1). Unresolved links can't be
    // ordered confidently — skip rather than false-flag.
    if (positions.some((p) => p < 0)) continue;
    const ascending = positions.every((p, i) => i === 0 || p >= positions[i - 1]);
    if (!ascending) {
      st.reversed++;
      badChains.push({ order: chain.map((l) => l.content || l.strong), positions });
    }
  }
  stats.set(statKey, st);
  if (badChains.length > 0) {
    flagged.push({
      book: r.book, chapter: r.chapter, verse: r.verse, version: r.bible_version,
      row: r, srcRow, chains: badChains,
    });
  }
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log(`\nScanned ${rows.length} verse rows.\n`);
console.log("Per book/version (verses · compounds · REVERSED):");
const statRows = [...stats.entries()].sort();
for (const [k, s] of statRows) {
  const mark = s.reversed > 0 ? "  ⚠" : "";
  console.log(`  ${k.padEnd(14)} ${String(s.verses).padStart(5)} · ${String(s.compounds).padStart(5)} · ${String(s.reversed).padStart(4)}${mark}`);
}
console.log(`\nFlagged ${flagged.length} verse(s) with reversed compounds:`);
const PRINT_LIMIT = parseInt(process.env.SCAN_PRINT_LIMIT ?? "40", 10);
for (const f of flagged.slice(0, PRINT_LIMIT)) {
  for (const c of f.chains) {
    console.log(`  ${f.book} ${f.chapter}:${f.verse} ${f.version}  [${c.order.join(" + ")}]  positions ${JSON.stringify(c.positions)}`);
  }
}
if (flagged.length > PRINT_LIMIT) console.log(`  … and ${flagged.length - PRINT_LIMIT} more.`);

// ─── Repair ──────────────────────────────────────────────────────────────────
if (doRepair && flagged.length > 0) {
  const q = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const now = Math.floor(Date.now() / 1000);
  const lines = [
    `-- Repair reversed alignment-compound source order. Generated ${new Date().toISOString()}`,
    `-- ${flagged.length} verse(s). Each rewrites content_json via parse→serialize (canonical nesting),`,
    `-- bumps version (stale-client refetch), and logs an edit_log audit row.`,
    `-- No BEGIN/COMMIT: remote D1 rejects explicit transactions and wraps the file atomically itself.`,
  ];
  let rewritten = 0;
  for (const f of flagged) {
    const content = JSON.parse(f.row.content_json);
    const srcContent = JSON.parse(f.srcRow.content_json);
    const state = parseAlignment(content.verseObjects, srcContent.verseObjects);
    const newVo = serializeAlignment(state);
    const newContent = JSON.stringify({ ...content, verseObjects: newVo });
    if (newContent === f.row.content_json) continue; // nothing actually changed — skip
    rewritten++;
    const key = `${f.book}/${f.chapter}/${f.verse}/${f.version}`;
    lines.push(
      `UPDATE verses SET content_json = ${q(newContent)}, version = version + 1, updated_at = ${now}`,
      ` WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)};`,
      `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action, payload_json)`,
      `  SELECT 'verse', ${q(key)}, version - 1, version, 'normalize-align-order', ${q(newContent)}`,
      `    FROM verses WHERE book = ${q(f.book)} AND chapter = ${q(f.chapter)} AND verse = ${q(f.verse)} AND bible_version = ${q(f.version)};`,
    );
  }
  const outDir = resolve(repoRoot, "scripts/out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "repair-align-order.sql");
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote repair SQL for ${rewritten} verse(s): ${outPath}`);
}

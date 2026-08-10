// Sweep the GL corpus (ULT + UST) for reused-source-token defects and ask, per
// verse, whether the defect is actually VISIBLE on the aligner's cards.
//
// Why this exists: AMO 3:2 and AMO 3:7 UST both carry the api-side "Reused
// source token" lint flag, but only 3:7 shows doubled Hebrew. The detector
// (findReusedSourceWordIds, via buildPosMaps) is right in both cases — it reads
// raw `state.groups`. The chips, however, render off the DISPLAY group
// (AlignmentPanel's `g.source.map`), and stripCompoundOverlaps removes a
// compound's source word when a standalone card already owns it. That strip
// bails out only when it would remove EVERY word (`kept.length === 0`), so:
//   - AMO 3:7 — compound [אֶל, עֲבָדָיו], BOTH overlapped → kept.length 0 →
//     no-op escape hatch → compound survives → 4 red chips, visibly doubled.
//   - AMO 3:2 — compound [עַל, כֵּן, אֶפְקֹד], only אֶפְקֹד overlapped →
//     kept.length 2 → strip applies → the flagged chip is never rendered → a
//     lone red marker with no partner, and a translator clicks through from the
//     lint feed to a verse that looks clean.
// Whether the same defect class is visible therefore depends on compound arity,
// which is arbitrary. This sweep measures how often that happens.
//
// Reuses the REAL detectors and the REAL display pipeline — the api-side
// `lintUsfmVerses` and the panel's `buildDisplayGroups` / `buildPosMaps` — so
// the sweep can never drift from what ships. Runs with strip-types.
//
// Usage (from repo root):
//   node --experimental-strip-types scripts/scan-reused-token-visibility.mjs           # LOCAL dev D1
//   node --experimental-strip-types scripts/scan-reused-token-visibility.mjs --remote  # PROD D1
//   node --experimental-strip-types scripts/scan-reused-token-visibility.mjs --remote --book AMO
//   node --experimental-strip-types scripts/scan-reused-token-visibility.mjs --remote --json
//
// Exit code is ALWAYS 0 — this is a census, not a gate. The verses it lists are
// upstream data defects for a human to repair; the counts are the regression
// signal for a display fix (`invisible` should go to 0 while `total` holds).

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseAlignment } from "../web/src/lib/alignment.ts";
import {
  buildDisplayGroups,
  buildPosMaps,
  buildSourceIndexMap,
} from "../web/src/lib/alignmentHover.ts";
import { concatSourceRange } from "../web/src/lib/verseRange.ts";
import { lintUsfmVerses } from "../api/src/lint.ts";

const argv = process.argv.slice(2);
const remote = argv.includes("--remote");
const asJson = argv.includes("--json");
const bi = argv.indexOf("--book");
const onlyBook = bi >= 0 ? argv[bi + 1] : null;
const db = remote ? "bible_editor" : "bible_editor_dev";
const envFlag = remote ? "--remote --env production" : "--local";
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "api");

function query(sql) {
  // wrangler stdout is flaky through a pipe; capture to a string via execSync
  // and slice from the first '['. Retry the occasional transient CF auth error.
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw;
    try {
      raw = execSync(
        `npx wrangler d1 execute ${db} ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`,
        { cwd: apiDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      lastErr = e;
      // Check BOTH streams: wrangler writes its errors to stderr, so matching
      // only stdout meant the retry never fired and a transient CF auth blip
      // aborted the whole (~15 minute) census run.
      const out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
      if (out.includes("10000") || out.includes("Authentication")) continue;
      throw e;
    }
    const i = raw.indexOf("[");
    if (i < 0) { lastErr = new Error("no JSON in wrangler output"); continue; }
    return JSON.parse(raw.slice(i)).flatMap((p) => p.results ?? []);
  }
  throw lastErr;
}

const books = onlyBook
  ? [onlyBook]
  : query(
      "SELECT DISTINCT book FROM verses WHERE bible_version IN ('ULT','UST') ORDER BY book",
    ).map((r) => r.book);

const findings = [];
let versesScanned = 0;
// Verses excluded because no source could be resolved. Reported explicitly: a
// census used as an acceptance gate must never let a silent exclusion read as
// "covered everything."
let versesSkipped = 0;

for (const bk of books) {
  const rows = query(
    `SELECT chapter, verse, verse_end, bible_version, version, updated_by, content_json FROM verses ` +
      `WHERE book='${bk.replace(/'/g, "''")}' AND bible_version IN ('ULT','UST','UHB','UGNT') ` +
      `ORDER BY chapter, verse, bible_version`,
  );
  // Index the source (UHB for OT, UGNT for NT) per chapter, keyed by verse
  // START, as VerseDtos — the shape concatSourceRange expects.
  const sourceByChapter = new Map();
  for (const r of rows) {
    if (r.bible_version !== "UHB" && r.bible_version !== "UGNT") continue;
    let content;
    try {
      content = { verseObjects: JSON.parse(r.content_json).verseObjects ?? [] };
    } catch { continue; } // unparseable source row → verse can't be anchored
    const byStart = sourceByChapter.get(r.chapter) ?? {};
    byStart[r.verse] = { ...r, content };
    sourceByChapter.set(r.chapter, byStart);
  }
  let bookHits = 0;
  for (const r of rows) {
    if (r.bible_version !== "ULT" && r.bible_version !== "UST") continue;
    // A verse-BRIDGE target row (`\v 6-9` → verse=6, verse_end=9) must be paired
    // with the source for its FULL range, exactly as the app does: Shell.tsx
    // feeds AlignmentPanel a synthetic DTO from concatSourceRange, joining UHB
    // 6,7,8,9 into one token stream. Pairing a bridged row with only its first
    // source verse leaves every token from verses 7-9 unresolvable, so
    // reusedTokenKey falls back to content|occurrence and both the reform and
    // the marker run against a truncated source — the documented bridge-row
    // pairing trap. 86 ULT/UST rows in prod are bridged, and 14 of them land in
    // this census, so getting this wrong silently corrupts the very counts the
    // acceptance criteria in issues #419 / #421 are written against.
    const srcDto = concatSourceRange(
      sourceByChapter.get(r.chapter),
      r.verse,
      r.verse_end ?? r.verse,
    );
    const src = srcDto?.content?.verseObjects;
    if (!src) { versesSkipped++; continue; } // no source verse → nothing to anchor against
    let vos;
    try { vos = JSON.parse(r.content_json).verseObjects ?? []; } catch { continue; }
    versesScanned++;

    // api-side lint feed (the chip a translator clicks through from).
    const lint = lintUsfmVerses([
      {
        book: bk,
        chapter: r.chapter,
        verse: r.verse,
        verse_end: r.verse_end ?? null,
        bible_version: r.bible_version,
        content_json: r.content_json,
        plain_text: null,
        version: r.version,
        updated_by: r.updated_by,
        updated_at: 0,
      },
    ]).some((i) => i.check === "Reused source token");

    // Panel side: the detector's verdict, and how much of it survives to render.
    const state = parseAlignment(vos, src);
    const indexMap = buildSourceIndexMap(srcDto);
    const display = buildDisplayGroups(state, indexMap);
    const flagged = buildPosMaps(state, display, indexMap).reusedSourceIds;
    if (!lint && flagged.size === 0) continue;

    const rendered = new Set();
    for (const g of display) for (const s of g.source) if (flagged.has(s.id)) rendered.add(s.id);

    // A defect is only legible as "doubled Hebrew" when at least TWO flagged
    // chips actually draw — one lone red marker has no partner to compare to.
    const visibility =
      rendered.size >= 2 ? "visible" : rendered.size === 1 ? "one-chip" : "no-chip";
    findings.push({
      ref: `${bk} ${r.chapter}:${r.verse}`,
      resource: r.bible_version,
      version: r.version,
      updated_by: r.updated_by,
      lint,
      flagged: flagged.size,
      rendered: rendered.size,
      visibility,
    });
    bookHits++;
  }
  if (!asJson) console.error(`  ${bk}: ${bookHits} verse(s)`);
}

const counts = { visible: 0, "one-chip": 0, "no-chip": 0 };
for (const f of findings) counts[f.visibility]++;
const lintOnly = findings.filter((f) => f.lint && f.flagged === 0).length;
const uiOnly = findings.filter((f) => !f.lint && f.flagged > 0).length;

if (asJson) {
  console.log(
    JSON.stringify({ versesScanned, versesSkipped, counts, lintOnly, uiOnly, findings }, null, 2),
  );
} else {
  for (const f of findings) {
    console.log(
      `${f.ref.padEnd(14)} ${f.resource}  lint=${f.lint ? "Y" : "n"}  ` +
        `flagged=${f.flagged} rendered=${f.rendered}  ${f.visibility.toUpperCase()}` +
        (f.visibility === "visible" ? "" : "  <-- flagged but nothing doubled on screen"),
    );
  }
  console.log(
    `\n${findings.length} flagged verse(s) over ${versesScanned} scanned: ` +
      `${counts.visible} visible, ${counts["one-chip"]} one-chip-only, ${counts["no-chip"]} no-chip.`,
  );
  console.log(`detector disagreement: lintOnly=${lintOnly}, uiOnly=${uiOnly}`);
  console.log(`verses skipped (no resolvable source): ${versesSkipped}`);
}

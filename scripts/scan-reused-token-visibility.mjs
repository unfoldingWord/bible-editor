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
// upstream data defects for a human to repair.
//
// Visibility buckets, and which one is the display-fix regression signal:
//   - A row only gets a `visible` / `one-chip` / `no-chip` visibility bucket
//     when the MARKER actually flagged something (flagged.size > 0). These
//     three answer "of the rows the marker flagged, how many chips rendered?"
//   - Rows where the marker flagged nothing but lint did (a lint-only false
//     positive — the marker never had anything to render) land in a separate
//     `lint-only` bucket, not `no-chip`. Mixing them into `no-chip` would make
//     that bucket unable to reach 0 while ANY lint false positive exists, and
//     "flagged but nothing rendered" would then be true only by subtraction
//     from a header that never said so.
//   - `flaggedButUnrendered` is THE regression signal for a display fix: it
//     counts rows where some (display card, flagged token) pair never draws a
//     chip for that token — i.e. a real defect the marker found but the UI
//     failed to show. It can be 0 even while lint-only false positives
//     persist. The unit is deliberately the (card, token) pair, not a raw
//     flagged source-word id: a legitimately fused card (mergeSamePositionGroups
//     collapsing a one-token-to-N-target-run split, e.g. JER 36:30 UST) drops
//     the eaten group's id while still rendering a chip for the same physical
//     token, and counting by id alone misreads that as unrendered. See
//     groupsForCard usage below, which resolves a display card back to every
//     state group it fused before asking whether the token renders.
// Verse 0 (chapter-front, no real verse content) is excluded from the target
// scan, mirroring lintUsfmVerses's own skip of verse===0 — otherwise a verse-0
// row could only ever land as marker-only and would inflate versesScanned.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseAlignment } from "../web/src/lib/alignment.ts";
import {
  buildDisplayGroups,
  buildPosMaps,
  buildSourceIndexMap,
  unrenderedFlaggedTokenKeys,
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
// SOURCE (UHB/UGNT) rows that failed to parse and were dropped from the
// per-chapter index. Behaviour is unchanged (still dropped) — this just makes
// the drop attributable instead of silent. 0 expected.
let sourceRowsUnparseable = 0;
// Bridged target rows where concatSourceRange returned a DTO built from an
// INCOMPLETE verse range — some interior/trailing source verse was missing,
// so the row was still scanned but against a truncated source. Distinct from
// versesSkipped (no source at all): this is a partial-source row that looks
// covered but isn't.
let truncatedSourceRanges = 0;
const truncatedRefs = [];

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
    } catch { sourceRowsUnparseable++; continue; } // unparseable source row → verse can't be anchored
    const byStart = sourceByChapter.get(r.chapter) ?? {};
    byStart[r.verse] = { ...r, content };
    sourceByChapter.set(r.chapter, byStart);
  }
  let bookHits = 0;
  for (const r of rows) {
    if (r.bible_version !== "ULT" && r.bible_version !== "UST") continue;
    // Skip verse 0 (chapter-front, no real verse content) for symmetry with
    // lintUsfmVerses, which skips it too — otherwise a verse-0 row can only
    // ever appear as marker-only and inflates versesScanned.
    if (r.verse === 0) continue;
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
    // Guard verse_end the same way api/src/pipelineImport.ts's
    // sourceWordsForRange does: an anomalous verse_end < verse must not be
    // treated as the range end (concatSourceRange would then see start > end
    // and return null, silently dropping the verse from the census).
    const rangeEnd = r.verse_end != null && r.verse_end >= r.verse ? r.verse_end : r.verse;
    const srcDto = concatSourceRange(sourceByChapter.get(r.chapter), r.verse, rangeEnd);
    const src = srcDto?.content?.verseObjects;
    if (!src) { versesSkipped++; continue; } // no source verse → nothing to anchor against
    // concatSourceRange returns a DTO as soon as the START verse exists, but
    // silently skips any missing interior/trailing verse in [verse, rangeEnd]
    // — so a bridged row can pass the `!src` check above while still carrying
    // a TRUNCATED source. Detect that here rather than counting it as covered.
    if (rangeEnd > r.verse) {
      const chapterSource = sourceByChapter.get(r.chapter);
      for (let v = r.verse; v <= rangeEnd; v++) {
        if (!chapterSource?.[v]) {
          truncatedSourceRanges++;
          if (truncatedRefs.length < 10) truncatedRefs.push(`${bk} ${r.chapter}:${r.verse}-${rangeEnd} (missing v${v})`);
          break;
        }
      }
    }
    let vos;
    try { vos = JSON.parse(r.content_json).verseObjects ?? []; } catch { versesSkipped++; continue; }
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

    // Card/token check for `flaggedButUnrendered` (see header comment):
    // unrenderedFlaggedTokenKeys (web/src/lib/alignmentHover.ts) walks each
    // DISPLAY card back to every state group it fused via groupsForCard — the
    // same resolution AlignmentPanel uses for merge/clear — and returns the
    // reusedTokenKey of every flagged token that never draws a chip on any
    // card. Shared (not reimplemented here) so the committed regression test
    // in alignmentHover.test.mjs proves the exact function this census runs.
    const unrenderedTokens = unrenderedFlaggedTokenKeys(state, display, indexMap, flagged);
    const cardTokenUnrendered = unrenderedTokens.length > 0;

    // A defect is only legible as "doubled Hebrew" when at least TWO flagged
    // chips actually draw — one lone red marker has no partner to compare to.
    // These three buckets only apply when the MARKER flagged something; a
    // lint-only false positive (flagged.size === 0) has nothing to render and
    // gets its own `lint-only` bucket below, so it can't masquerade as a
    // display-fix regression.
    const visibility =
      flagged.size === 0
        ? "lint-only"
        : rendered.size >= 2
          ? "visible"
          : rendered.size === 1
            ? "one-chip"
            : "no-chip";
    findings.push({
      ref: `${bk} ${r.chapter}:${r.verse}`,
      resource: r.bible_version,
      version: r.version,
      updated_by: r.updated_by,
      lint,
      flagged: flagged.size,
      rendered: rendered.size,
      visibility,
      cardTokenUnrendered,
      unrenderedTokens,
    });
    bookHits++;
  }
  if (!asJson) console.error(`  ${bk}: ${bookHits} verse(s)`);
}

const counts = { visible: 0, "one-chip": 0, "no-chip": 0, "lint-only": 0 };
for (const f of findings) counts[f.visibility]++;
const lintOnly = findings.filter((f) => f.lint && f.flagged === 0).length;
const uiOnly = findings.filter((f) => !f.lint && f.flagged > 0).length;
// THE regression signal for a display fix: rows where some (display card,
// flagged token) pair never draws a chip for that token. Unlike `no-chip`,
// this can be 0 while lint-only false positives persist. See the
// `cardTokenUnrendered` computation above and the header comment for why the
// unit is a (card, token) pair rather than a raw flagged source-word id.
const flaggedButUnrendered = findings.filter((f) => f.cardTokenUnrendered).length;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        versesScanned,
        versesSkipped,
        sourceRowsUnparseable,
        truncatedSourceRanges,
        truncatedRefs,
        counts,
        lintOnly,
        uiOnly,
        flaggedButUnrendered,
        findings,
      },
      null,
      2,
    ),
  );
} else {
  for (const f of findings) {
    console.log(
      `${f.ref.padEnd(14)} ${f.resource}  lint=${f.lint ? "Y" : "n"}  ` +
        `flagged=${f.flagged} rendered=${f.rendered}  ${f.visibility.toUpperCase()}` +
        // Two DIFFERENT problems, so two different notes, and neither is the
        // flaggedButUnrendered GATE metric below (which is the (card, token)
        // check, not this raw-id ratio). A row can be `visible` (>=2 flagged
        // ids literally survive into display, so the doubling reads) and
        // STILL have a flagged id that doesn't literally survive — JER 36:30
        // UST is exactly that: 3 flagged, 2 rendered by id, yet
        // flaggedButUnrendered is 0 for it because the token still draws (a
        // legitimately fused card keeps only its survivor's id). Printing
        // "nothing doubled on screen" there would be false.
        (f.flagged > 0 && f.rendered < f.flagged
          ? f.visibility === "visible"
            ? `  <-- visible, but ${f.flagged - f.rendered} flagged id(s) don't literally survive into display (raw-id ratio, NOT the flaggedButUnrendered gate)`
            : "  <-- flagged but no raw id renders (raw-id ratio, NOT the flaggedButUnrendered gate)"
          : "") +
        // THE gate metric's own per-row attribution: which token(s) actually
        // never draw a chip on any card, so a nonzero reading doesn't force a
        // second full census run just to find the offending verse.
        (f.cardTokenUnrendered
          ? `  <-- flaggedButUnrendered: [${f.unrenderedTokens.join(", ")}] never render on any card`
          : ""),
    );
  }
  console.log(
    `\n${findings.length} flagged verse(s) over ${versesScanned} scanned: ` +
      `${counts.visible} visible, ${counts["one-chip"]} one-chip-only, ${counts["no-chip"]} no-chip, ` +
      `${counts["lint-only"]} lint-only.`,
  );
  console.log(`detector disagreement: lintOnly=${lintOnly}, uiOnly=${uiOnly}`);
  console.log(`flaggedButUnrendered (THE display-fix regression signal): ${flaggedButUnrendered}`);
  console.log(`verses skipped (no resolvable source / unparseable content): ${versesSkipped}`);
  console.log(`source rows unparseable (UHB/UGNT dropped from index): ${sourceRowsUnparseable}`);
  console.log(
    `truncated source ranges (bridged row missing an interior/trailing verse): ${truncatedSourceRanges}` +
      (truncatedRefs.length > 0
        ? `\n  ${truncatedRefs.join("\n  ")}` +
          (truncatedSourceRanges > truncatedRefs.length
            ? `\n  ...and ${truncatedSourceRanges - truncatedRefs.length} more`
            : "")
        : ""),
  );
}

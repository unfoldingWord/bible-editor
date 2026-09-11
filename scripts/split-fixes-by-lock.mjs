// Split the tn-quote and alignment-occurrence findings by whether the book is
// LOCKED, and emit an HTML worksheet for the locked half.
//
// WHY. bible-editor must not write to a locked book — those are published and
// the app is not the source of truth for them any more. So the SQL repair may
// only touch unlocked books, and everything found in a locked book has to be
// handed to an admin to apply on Door43 by hand. This script draws that line
// once, from the same lock rule the app uses, rather than leaving it to whoever
// runs the repair to remember.
//
// Lock rule mirrors effectiveBookLock / bookLock.ts: an explicit `book_locks`
// row wins in BOTH directions (including a deliberate locked=0 unlock of a
// published book); with no row, a published book is locked by default.
//
// Usage:
//   node --experimental-strip-types --no-warnings scripts/split-fixes-by-lock.mjs \
//     scripts/out/dump/tn.json scripts/out/dump/src-all.json scripts/out/dump/book-locks.json
//   → scripts/out/door43-fixes.html   (locked books, for an admin)
//   → stdout: the locked/unlocked split for both defect families

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTnQuote, sourceWordsByRef, wordsForRow } from "../api/src/lint.ts";
import { lintAlignmentOccurrences } from "../api/src/lint.ts";
import { PUBLISHED_BOOKS } from "../api/src/publishedGuard.ts";
import { readdirSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [tnPath, srcPath, locksPath, alignedDir] = process.argv.slice(2);
if (!tnPath || !srcPath || !locksPath) {
  console.error("usage: node scripts/split-fixes-by-lock.mjs <tn-dump> <src-dump> <book-locks-dump> [aligned-dir]");
  process.exit(1);
}
const rowsOf = (p) => {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
  if (Array.isArray(raw) && Array.isArray(raw[0]?.results)) return raw[0].results;
  return raw.results ?? raw;
};

// book -> true(locked) / false(explicitly unlocked). The dump is REQUIRED: this
// script decides which SQL may be applied, and the published-book fallback
// alone cannot see an admin's explicit lock on an unpublished book.
if (!existsSync(resolve(repoRoot, locksPath))) {
  console.error(`book_locks dump not found: ${locksPath}`);
  process.exit(1);
}
const explicit = new Map();
for (const r of rowsOf(locksPath)) {
  if (typeof r.book !== "string" || !("locked" in r)) {
    console.error(`${locksPath} is not a book_locks dump (need book, locked columns)`);
    process.exit(1);
  }
  explicit.set(r.book, Number(r.locked) === 1);
}
const isLocked = (book) => (explicit.has(book) ? explicit.get(book) : PUBLISHED_BOOKS.has(book));

const srcByBook = new Map();
for (const r of rowsOf(srcPath)) {
  if (!srcByBook.has(r.book)) srcByBook.set(r.book, []);
  srcByBook.get(r.book).push(r);
}
const wordsByBook = new Map();
for (const [b, rows] of srcByBook) wordsByBook.set(b, sourceWordsByRef(rows));

const findings = [];
for (const r of rowsOf(tnPath)) {
  const quote = (r.quote ?? "").trim();
  if (!quote || !/[֐-׿Ͱ-Ͽἀ-῿]/.test(quote)) continue;
  const byRef = wordsByBook.get(r.book);
  if (!byRef) continue;
  const toks = wordsForRow(byRef, r.chapter, r.verse, r.ref_raw);
  if (!toks.length) continue;
  const v = resolveTnQuote(quote, toks);
  if (v.ok) continue;
  findings.push({
    book: r.book, ref: r.ref_raw ?? `${r.chapter}:${r.verse}`, id: r.id,
    kind: v.kind, was: quote,
    fix: v.confident ? v.suggestion : "",
    proposal: v.suggestion,
    locked: isLocked(r.book),
  });
}

const locked = findings.filter((f) => f.locked);
const unlocked = findings.filter((f) => !f.locked);
const tally = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.book, (m.get(r.book) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b} ${n}`).join(", ");
};
console.log(`tn quote findings: ${findings.length}`);
console.log(`  UNLOCKED (repairable in-app): ${unlocked.length}  [${tally(unlocked)}]`);
console.log(`    of those, auto-repairable: ${unlocked.filter((f) => f.fix).length}`);
console.log(`  LOCKED   (Door43 by hand):    ${locked.length}  [${tally(locked)}]`);

// ── Alignment-occurrence findings, same lock split ──────────────────────────
const alignFindings = [];
if (alignedDir && existsSync(resolve(repoRoot, alignedDir))) {
  for (const f of readdirSync(resolve(repoRoot, alignedDir)).filter((n) => n.endsWith(".json"))) {
    const book = f.replace(/\.json$/, "");
    const byRef = wordsByBook.get(book);
    if (!byRef) continue;
    let aligned;
    try { aligned = rowsOf(`${alignedDir}/${f}`); } catch { continue; }
    for (const version of ["ULT", "UST"]) {
      for (const i of lintAlignmentOccurrences(aligned.filter((r) => r.bible_version === version), byRef)) {
        alignFindings.push({ book, ref: i.ref, version, message: i.message, check: i.check, locked: isLocked(book) });
      }
    }
  }
}
const alignLocked = alignFindings.filter((f) => f.locked);
if (alignFindings.length) {
  console.log(`\nalignment findings: ${alignFindings.length}`);
  console.log(`  UNLOCKED (repairable in-app): ${alignFindings.length - alignLocked.length}  [${tally(alignFindings.filter((f) => !f.locked))}]`);
  console.log(`  LOCKED   (Door43 by hand):    ${alignLocked.length}  [${tally(alignLocked)}]`);
}

// ── HTML worksheet for the locked books ─────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const KIND_LABEL = {
  order: "Words are not in source order",
  duplicate: "A source word is quoted twice",
  gap: "Discontiguous parts need a &amp; between them",
  joiners: "Missing invisible word joiners (U+2060)",
  absent: "A quoted word is not in the verse",
};
const byBook = new Map();
for (const f of locked) {
  if (!byBook.has(f.book)) byBook.set(f.book, []);
  byBook.get(f.book).push(f);
}
const rows = [...byBook].sort((a, b) => a[0].localeCompare(b[0])).map(([book, items]) => `
  <section>
    <h2>${esc(book)} <span class="count">${items.length}</span></h2>
    <table>
      <thead><tr><th>Reference</th><th>ID</th><th>Problem</th><th>Current quote</th><th>Suggested</th></tr></thead>
      <tbody>
        ${items.map((f) => `<tr>
          <td class="ref">${esc(f.ref)}</td>
          <td class="id"><code>${esc(f.id)}</code></td>
          <td>${KIND_LABEL[f.kind] ?? esc(f.kind)}${f.fix ? "" : ' <span class="manual">needs judgement</span>'}</td>
          <td class="heb">${esc(f.was)}</td>
          <td class="heb">${f.proposal ? esc(f.proposal) : '<span class="none">—</span>'}</td>
        </tr>`).join("\n        ")}
      </tbody>
    </table>
  </section>`).join("\n");

const html = `<title>Door43 quote fixes</title>
<style>
  :root { color-scheme: light; --ink:#231F20; --ocean:#014263; --inspire:#31ADE3; --line:#dfe6ea; --warn:#E59D33; }
  body { font: 15px/1.55 -apple-system, Segoe UI, Roboto, sans-serif; color: var(--ink); margin: 0; background:#fff; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { color: var(--ocean); font-size: 24px; margin: 0 0 6px; }
  .lede { color:#4a5b66; margin: 0 0 24px; max-width: 70ch; }
  .lede strong { color: var(--ink); }
  h2 { color: var(--ocean); font-size: 17px; margin: 32px 0 8px; border-bottom: 2px solid var(--inspire); padding-bottom: 4px; }
  .count { font-weight: 400; color:#6b7c87; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing:.04em; color:#6b7c87; border-bottom:1px solid var(--line); padding: 6px 8px; }
  td { border-bottom: 1px solid var(--line); padding: 8px; vertical-align: top; }
  .ref { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .id code { background:#f2f6f8; padding:1px 5px; border-radius:3px; font-size:12px; }
  .heb { direction: rtl; text-align: right; font-size: 18px; line-height: 1.9; font-family: "SBL Hebrew", "Ezra SIL", serif; }
  .manual { color: var(--warn); font-size: 12px; white-space: nowrap; }
  .none { color:#9aa8b0; }
  .note { background:#f6fbfd; border-left:3px solid var(--inspire); padding:12px 14px; margin:18px 0 0; font-size:14px; }
</style>
<div class="wrap">
  <h1>translationNotes quote fixes — locked books</h1>
  <p class="lede">
    These ${locked.length} quotes do not resolve against the Hebrew/Greek source verse they point at,
    so unfoldingWord's occurrence checker reports them as <code>Occurrence 1 not found</code>.
    Every book listed here is <strong>locked in bible-editor</strong>, so the app will not and should not
    write to it — these need applying on Door43 by hand.
  </p>
  <div class="note">
    <strong>Suggested</strong> is the same quote rebuilt in source order, using the source's own
    spelling and separators. Rows marked <span class="manual">needs judgement</span> are ambiguous:
    the words could map to more than one place in the verse, or a word is missing entirely, so the
    suggestion is a starting point rather than an answer. Everything else is a pure re-ordering or a
    missing gap marker — no wording changes.
  </div>
  ${rows || "<p>No quote problems in locked books.</p>"}
  ${alignLocked.length ? `
  <h1 style="margin-top:48px">Alignment occurrence numbers — locked books</h1>
  <p class="lede">
    ${alignLocked.length} alignment milestones declare an occurrence number the source verse
    contradicts — an <code>x-occurrence</code> or <code>x-occurrences</code> that counts a word more
    times than it appears. This is what makes the translationWords checker say
    <em>"nothing in the verse is aligned to"</em> a word that visibly is aligned.
    Fixing means editing the milestone attribute in the USFM on Door43.
  </p>
  <table>
    <thead><tr><th>Book</th><th>Ref</th><th>Resource</th><th>Problem</th></tr></thead>
    <tbody>
      ${alignLocked.map((f) => `<tr><td>${esc(f.book)}</td><td class="ref">${esc(f.ref)}</td><td>${esc(f.version)}</td><td>${esc(f.message)}</td></tr>`).join("")}
    </tbody>
  </table>` : ""}
</div>`;

// ── Strip locked books out of the occurrence repair SQL ─────────────────────
// scan-source-occurrences.mjs has no lock rule of its own, so filter its output
// here rather than leaving the operator to notice. Sections are delimited by
// the "-- ===== BOOK" headers the driver writes — exactly a 3-char book code
// and nothing else. Anything that is not that shape (a suffix, a preamble, a
// stray statement before the first header) is REFUSED rather than kept: a
// chunk we cannot attribute to a book cannot be proven unlocked.
const occAll = resolve(repoRoot, "scripts/out/repair-source-occurrences-all.sql");
if (existsSync(occAll)) {
  const parts = readFileSync(occAll, "utf8").split(/^-- ===== /m).filter((p) => p.trim());
  const kept = [];
  const dropped = new Map();
  for (const part of parts) {
    const header = part.split("\n")[0].trim();
    const m = /^([1-3A-Z]{3})$/.exec(header);
    if (!m) {
      console.error(`refusing to split repair-source-occurrences-all.sql: unrecognised section header "${header.slice(0, 60)}"`);
      process.exit(1);
    }
    const book = m[1];
    const n = (part.match(/^UPDATE verses/gm) ?? []).length;
    if (isLocked(book)) { dropped.set(book, n); continue; }
    kept.push("-- ===== " + part.replace(/\s+$/, "") + "\n");
  }
  const outFile = resolve(repoRoot, "scripts/out/repair-source-occurrences-unlocked.sql");
  const body = kept.join("\n");
  writeFileSync(outFile, body, "utf8");
  const keptN = (body.match(/^UPDATE verses/gm) ?? []).length;
  const droppedN = [...dropped.values()].reduce((a, b) => a + b, 0);
  console.log(`\nwrote scripts/out/repair-source-occurrences-unlocked.sql: ${keptN} UPDATE(s)`);
  console.log(`  withheld ${droppedN} in locked books [${[...dropped].map(([b, n]) => `${b} ${n}`).join(", ")}]`);
}

const outDir = resolve(repoRoot, "scripts/out");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "door43-fixes.html"), html, "utf8");
console.log(`\nwrote scripts/out/door43-fixes.html (${locked.length} row(s) across ${byBook.size} book(s))`);

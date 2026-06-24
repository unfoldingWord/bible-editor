// Validate AI-adapted batches and emit a prod UPDATE SQL. The LLM is a PROPOSAL:
// every quote it returns is hard-checked to be an EXACT span of the Isaiah UHB
// verse (maqqef/paseq-aware reconstruction), occurrence recomputed by position.
// Invalid/hallucinated quotes fall back to the deterministic quote + keep the
// flag. Flags clear only when: quote validates AND confidence=high AND not a
// reorder-zone note. Everything else keeps a (possibly softened) flag so the
// cleanup chip still points the proofreader at the uncertain notes.
//
// Resumable: processes whichever ai/out/batch*.json exist. OFFLINE except the
// caller applies the emitted SQL.
//
// Run: node scripts/validate-ai.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out/kings-isa");
const src = resolve(outDir, "src");
const outAi = resolve(outDir, "ai/out");

const nfc = (s) => (s ?? "").normalize("NFC");
const skel = (w) => nfc(w).replace(/[⁠־ ֑-ׇ]/g, "");

// maqqef/paseq-aware verse tokenization (mirror of migrate-parallel-notes.mjs)
function tokenizeBlob(blob) {
  const items = []; const re = /\\w\s+([^|\\]+)\|[^\\]*?\\w\*/g; let last = 0, m;
  while ((m = re.exec(blob))) {
    const sep = blob.slice(last, m.index); if (sep) items.push({ sep: sep.replace(/\s+/g, " ") });
    const surf = nfc(m[1].trim()); items.push({ w: surf, sk: skel(surf) }); last = m.index + m[0].length;
  }
  const tail = blob.slice(last); if (tail) items.push({ sep: tail.replace(/\s+/g, " ") });
  return items;
}
function parseUhbItems(raw) {
  const blobs = {}; let ch = 0, v = 0;
  for (const line of raw.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^\\c\s+(\d+)/))) { ch = +m[1]; v = 0; continue; }
    if ((m = line.match(/^\\v\s+(\d+)\s*(.*)$/))) { v = +m[1]; blobs[`${ch}:${v}`] = m[2] ? [m[2]] : []; continue; }
    if (v && blobs[`${ch}:${v}`]) blobs[`${ch}:${v}`].push(line);
  }
  const out = {}; for (const k of Object.keys(blobs)) out[k] = tokenizeBlob(blobs[k].join("\n"));
  return out;
}
const wordItemsOf = (items) => { const ws = []; items.forEach((it, idx) => { if (it.w != null) ws.push({ sk: it.sk, idx }); }); return ws; };
function reconstruct(items, wi, a, b) { let s = ""; for (let i = wi[a].idx; i <= wi[b].idx; i++) s += items[i].w != null ? items[i].w : items[i].sep; return s.trim(); }
function findSpans(qsk, wi) { const hits = []; for (let i = 0; i + qsk.length <= wi.length; i++) { let ok = true; for (let j = 0; j < qsk.length; j++) if (qsk[j] !== wi[i + j].sk) { ok = false; break; } if (ok) hits.push(i); } return hits; }

// Validate an AI quote string against the Isaiah verse items. Returns
// { ok, quote, occurrence } using EXACT consonantal-skeleton word matching
// (the AI is told to copy verbatim; skeleton tolerates only mark normalization).
function validateQuote(aiQuote, items) {
  const wi = wordItemsOf(items);
  const groups = aiQuote.split("&").map((s) => s.trim()).filter(Boolean);
  let firstStart = null, firstSk = null;
  const recon = [];
  for (const g of groups) {
    const qsk = g.split(/[\s־]+/).map(skel).filter(Boolean);
    if (!qsk.length) return { ok: false };
    const hits = findSpans(qsk, wi);
    if (!hits.length) return { ok: false };
    const start = hits[0];
    if (firstStart == null) { firstStart = start; firstSk = qsk; }
    recon.push(reconstruct(items, wi, start, start + qsk.length - 1));
  }
  const allFirst = findSpans(firstSk, wi);
  const occurrence = (allFirst.indexOf(firstStart) + 1) || 1;
  return { ok: true, quote: recon.join(" & "), occurrence, ambiguous: allFirst.length > 1 };
}

const isaItems = parseUhbItems(readFileSync(resolve(src, "hbo_uhb__23-ISA.usfm"), "utf8"));
const adapt = JSON.parse(readFileSync(resolve(outDir, "adapt-batch.json"), "utf8")).notes;
const byId = new Map(adapt.map((n) => [n.sourceId + "@" + n.isaRef, n]));

const q = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

const sql = [];
const report = { batches: 0, items: 0, quoteValidated: 0, quoteFallback: 0, flagsCleared: 0, flagsKept: 0, invalidQuotes: [] };
const updates = []; // {sourceId, isaRef, id?} resolved by id at apply time

const files = existsSync(outAi) ? readdirSync(outAi).filter((f) => /^batch\d+\.json$/.test(f)).sort() : [];
for (const f of files) {
  report.batches++;
  const data = JSON.parse(readFileSync(resolve(outAi, f), "utf8"));
  for (const r of data.results) {
    report.items++;
    const det = byId.get(r.sourceId + "@" + r.isaRef);
    if (!det) { console.warn(`  · no adapt record for ${r.sourceId}@${r.isaRef}`); continue; }
    const items = isaItems[r.isaRef] || [];
    let quote = det.quote, occurrence = det.occurrence, quoteOk = false;
    if (r.quote) {
      const v = validateQuote(r.quote, items);
      if (v.ok) { quote = v.quote; occurrence = v.occurrence; quoteOk = true; report.quoteValidated++; }
      else { report.quoteFallback++; report.invalidQuotes.push(`${r.sourceId}@${r.isaRef}: AI quote not an exact Isaiah span`); }
    }
    const aiDropped = r.note === null || r.note === undefined && r.noteChanged === true;
    const note = (r.noteChanged && typeof r.note === "string" && r.note.trim()) ? r.note : det.note;
    // flag policy (most severe first)
    const isReorder = det.zone === "reorder";
    const quoteStillUnresolved = !r.quote && /not found/.test(det.review_reason || "");
    let review_kind = null, review_reason = null;
    if (aiDropped) { review_kind = "delete-candidate"; review_reason = `AI judged this note likely INAPPLICABLE to Isaiah (source material absent/reworded) — review and consider deleting. From 2Ki ${det.sourceRef}: ${r.reason || ""}`.trim(); report.dropCandidates = (report.dropCandidates || 0) + 1; }
    else if (isReorder) { review_kind = "sundial"; review_reason = `Reordered/reworded 2Ki 20 → Isa 38 zone — verify placement + wording. ${r.reason || ""}`.trim(); }
    else if (quoteStillUnresolved || (r.quote && !quoteOk)) { review_kind = "quote"; review_reason = `Hebrew quote needs a human anchor (AI could not confirm). Source 2Ki ${det.sourceRef}.`; }
    else if (r.confidence && r.confidence !== "high") { review_kind = "adapted"; review_reason = `AI-adapted from 2Ki ${det.sourceRef} (confidence ${r.confidence}) — verify. ${r.reason || ""}`.trim(); }
    // else: quote validated + high confidence → clear the flag
    if (review_kind) report.flagsKept++; else report.flagsCleared++;
    updates.push({ sourceId: r.sourceId, isaRef: r.isaRef, ref_raw: r.isaRef, quote, occurrence, note, review_kind, review_reason });
  }
}

// Emit UPDATE SQL keyed by (book, chapter, verse, sort_order)? We don't have the
// minted id here (it was assigned in build-load-sql with the exclude list). To
// target precisely, match the loaded row by its edit_log migrated_from id. We
// instead resolve by the deterministic identity: book=ISA + ref_raw + the exact
// note we loaded. Simpler + robust: match on the loaded quote/note we inserted.
// -> We update by (book, chapter, verse) AND the migrated source id stored in
//    edit_log payload. Emit a correlated UPDATE.
for (const u of updates) {
  const [c, v] = u.isaRef.split(":").map(Number);
  sql.push(
    `UPDATE tn_rows SET quote=${q(u.quote)}, occurrence=${q(u.occurrence)}, note=${q(u.note)}, review_kind=${q(u.review_kind)}, review_reason=${q(u.review_reason)}, version=version+1, updated_at=unixepoch() ` +
    `WHERE book='ISA' AND chapter=${c} AND verse=${v} AND deleted_at IS NULL AND id IN (` +
    `SELECT row_key FROM edit_log WHERE kind='tn' AND book='ISA' AND source='parallel_migration' AND json_extract(payload_json,'$.migrated_from.id')=${q(u.sourceId)});`,
  );
}

writeFileSync(resolve(outDir, "update-ai-ISA.sql"), sql.join("\n") + "\n");
writeFileSync(resolve(outDir, "ai", "validate-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`wrote update-ai-ISA.sql (${sql.length} updates)`);

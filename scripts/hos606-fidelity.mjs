// #606 review harness. Two things:
//   1. F1 repro — a capture that kept a literal \ts\* label.
//   2. F2 self-fidelity sweep — re-anchoring a verse's OWN markers onto its OWN
//      marker-stripped text must reproduce that verse's layout byte-for-byte.
//      Any divergence is punctuation the re-anchor mislaid.
//
// Usage: node --experimental-strip-types --no-warnings scripts/hos606-fidelity.mjs [BOOK ...]
import { extractVersesForRange } from "../api/src/importParsers.ts";
import { extractEditableText } from "../web/src/lib/usfm.ts";
import {
  smartEditVerse,
  __reanchorMarkersForTest as reanchor,
  __stripMarkerTokensForTest as stripMarkers,
} from "../web/src/lib/replace.ts";

const w = (text, occ = "1", occs = "1") => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: "x", children, endTag: "zaln-e\\*",
});
const countTag = (c, re) => {
  let n = 0;
  const walk = (a) => { for (const v of a ?? []) { if (!v || typeof v !== "object") continue; if (typeof v.tag === "string" && re.test(v.tag)) n++; if (Array.isArray(v.children)) walk(v.children); } };
  walk(c?.verseObjects); return n;
};

// ---------------- F1 ----------------
{
  const verse = {
    verseObjects: [
      zaln("H1", [w("the"), t(" ")]),
      { tag: "ts", content: "\\*" },
      zaln("H2", [w("people"), t(" ")]),
      zaln("H3", [w("said"), t(",")]),
      t(" "),
      { type: "quote", tag: "q2" },
      zaln("H4", [w("light"), t(".")]),
      t("”"),
    ],
  };
  const old = extractEditableText(verse);
  const wellFormed = old.replace("”", "");
  // Chips gone but the \ts\* label survived the repaint.
  const dropped = wellFormed.replace(/\\q\d?\s?/g, "").replace(/\s+/g, " ").trim();
  const good = smartEditVerse(verse, old, wellFormed, { capturedFromDom: true });
  const bad = smartEditVerse(verse, old, dropped, { capturedFromDom: true });
  console.log("=== F1 ===");
  console.log("  baseline   :", JSON.stringify(old));
  console.log("  capture    :", JSON.stringify(dropped));
  console.log("  well-formed:", JSON.stringify(extractEditableText(good.content)), "ts nodes:", countTag(good.content, /^ts$/));
  console.log("  guarded    :", JSON.stringify(extractEditableText(bad.content)), "ts nodes:", countTag(bad.content, /^ts$/));
  console.log("  IDENTICAL  :", extractEditableText(bad.content) === extractEditableText(good.content));
}

// ---------------- F2 ----------------
const books = process.argv.slice(2).length ? process.argv.slice(2) : [["HOS", "28-HOS.usfm"], ["PRO", "20-PRO.usfm"]].map((x) => x.join(":"));
console.log("\n=== F2 self-fidelity sweep ===");
let grandTotal = 0, grandBad = 0;
for (const spec of books) {
  const [book, file] = spec.includes(":") ? spec.split(":") : [spec, null];
  const url = `https://git.door43.org/unfoldingWord/en_ult/raw/branch/master/${file}`;
  let raw;
  try { raw = await fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); }); }
  catch (e) { console.log(`  ${book}: fetch failed (${e.message}) — skipped`); continue; }
  const verses = extractVersesForRange(raw, 1, 200);
  let total = 0, bad = 0;
  const samples = [];
  for (const v of verses) {
    let content;
    try { content = JSON.parse(v.contentJson); } catch { continue; }
    const layout = extractEditableText(content);
    if (!/\\(?:q[1-4]?|p|b|m|pi\d?|ts)/.test(layout)) continue; // only marker verses
    total++;
    // Use the ENGINE's own stripper — a hand-rolled regex fuses `storm\q1 and`
    // into "stormand" and manufactures divergences that are not the
    // re-anchor's.
    const stripped = stripMarkers(layout).replace(/\s+/g, " ").trim();
    const round = reanchor(layout, stripped);
    if (round !== layout) {
      bad++;
      if (samples.length < 6) samples.push({ ref: `${book} ${v.chapter}:${v.verse}`, want: layout, got: round });
    }
  }
  grandTotal += total; grandBad += bad;
  console.log(`  ${book}: ${bad} mislaid / ${total} marker verses`);
  for (const s of samples) {
    console.log(`    ${s.ref}`);
    console.log(`      want: ${JSON.stringify(s.want.slice(0, 160))}`);
    console.log(`      got : ${JSON.stringify(s.got.slice(0, 160))}`);
  }
}
console.log(`  TOTAL: ${grandBad} mislaid / ${grandTotal} marker verses`);

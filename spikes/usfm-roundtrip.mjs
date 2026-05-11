// Spike: does usfm-js preserve word-alignment markers across a JSON round-trip?
//
// We import a real USFM file with \zaln-s/\zaln-e blocks, convert to the
// usfm-js verse-objects JSON tree, convert back to USFM, and verify that
// the alignment-bearing tokens survive intact. This validates the core
// claim in docs/plan.md: that we can store verse content as JSON in D1
// and reconstruct lossless USFM on nightly export.
//
// Run:  node spikes/usfm-roundtrip.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import usfm from "usfm-js";

const inputPath = resolve("docs/samples/31-OBA.usfm");
const original = readFileSync(inputPath, "utf8");

console.log(`source: ${inputPath}`);
console.log(`source size: ${original.length} bytes`);

// Parse to JSON
const json = usfm.toJSON(original);
const jsonSize = JSON.stringify(json).length;
console.log(`json size: ${jsonSize} bytes (${(jsonSize / original.length).toFixed(2)}x)`);

const chapters = Object.keys(json.chapters || {});
const verses = chapters.flatMap((c) =>
  Object.keys(json.chapters[c]).filter((k) => /^\d+$/.test(k)),
);
console.log(`parsed: ${chapters.length} chapters, ${verses.length} verses`);

// Round-trip back to USFM
const reEmitted = usfm.toUSFM(json, { forcedNewLines: true });
console.log(`re-emitted size: ${reEmitted.length} bytes`);

// Save outputs for visual inspection
writeFileSync(resolve("spikes/out/oba.json"), JSON.stringify(json, null, 2));
writeFileSync(resolve("spikes/out/oba.reemitted.usfm"), reEmitted);

// Counts that matter for alignment preservation
const counts = (s) => ({
  zalnStart: (s.match(/\\zaln-s/g) || []).length,
  zalnEnd: (s.match(/\\zaln-e\\\*/g) || []).length,
  wTokens: (s.match(/\\w /g) || []).length,
  xStrong: (s.match(/x-strong="/g) || []).length,
  xLemma: (s.match(/x-lemma="/g) || []).length,
  xMorph: (s.match(/x-morph="/g) || []).length,
  xContent: (s.match(/x-content="/g) || []).length,
  xOccurrence: (s.match(/x-occurrence="/g) || []).length,
  verses: (s.match(/\\v \d+/g) || []).length,
  chapters: (s.match(/\\c \d+/g) || []).length,
});

const a = counts(original);
const b = counts(reEmitted);

console.log("\nalignment marker counts (original → reemitted):");
let driftAny = false;
for (const k of Object.keys(a)) {
  const drift = b[k] - a[k];
  const status = drift === 0 ? "OK" : `DRIFT ${drift > 0 ? "+" : ""}${drift}`;
  if (drift !== 0) driftAny = true;
  console.log(`  ${k.padEnd(14)} ${String(a[k]).padStart(5)} → ${String(b[k]).padStart(5)}   ${status}`);
}

// Spot-check verse 1:1 byte-by-byte to feel out cosmetic vs semantic drift
const grab = (s, ch, vs) => {
  const m = s.match(
    new RegExp(`\\\\v ${vs}\\b[\\s\\S]*?(?=\\\\v \\d|\\\\c \\d|$)`),
  );
  return m ? m[0].trim() : "(not found)";
};
console.log("\n--- verse 1:1 (original) ---");
console.log(grab(original, 1, 1).slice(0, 400));
console.log("\n--- verse 1:1 (re-emitted) ---");
console.log(grab(reEmitted, 1, 1).slice(0, 400));

if (driftAny) {
  console.log("\nRESULT: alignment counts drifted — investigate before relying on round-trip.");
  process.exit(1);
} else {
  console.log("\nRESULT: alignment markers fully preserved across JSON round-trip.");
}

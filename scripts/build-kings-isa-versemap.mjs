// Build the frozen 2 Kings 18-20 → Isaiah 36-39 verse map.
//
// Targets are grounded in (a) the per-verse Hebrew word-overlap analysis run in
// scripts/analyze-kings-isa.mjs and (b) the well-known parallel structure of the
// two accounts. Where a Kings verse maps to more than one Isaiah verse (a split)
// or the surrounding text is reordered/reworded, the per-NOTE quote-span placement
// in the migration engine refines/flags within these candidates — this file only
// fixes the candidate set + the zone classification.
//
// zone:
//   clean   - near-verbatim, monotonic; quote re-anchor expected to succeed
//   split   - one Kings verse spans two Isaiah verses; placement by quote span
//   reorder - Isaiah moves/rewords this material; FLAG every note for review
//   exclude_no_parallel  - no Isaiah parallel exists; notes are NOT migrated
//   exclude_target_human - Isaiah side already done by a human; do NOT touch
//
// Run: node scripts/build-kings-isa-versemap.mjs  (writes scripts/kings-isa-versemap.json)
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Segment rules → expanded per-verse map. Each rule covers a contiguous Kings
// span. `isaFor(kv)` returns the Isaiah target ref(s) for Kings chapter:verse.
const segments = [
  // ── 2 Kings 18 → Isaiah 36 ──
  { ki: ["18:1", "18:12"], zone: "exclude_no_parallel",
    note: "Isaiah's account begins at 2Ki 18:13; 18:1-12 (Hezekiah's reign summary) has no Isaiah parallel." },
  { ki: ["18:13", "18:13"], isa: (v) => ["36:1"], zone: "clean" },
  { ki: ["18:14", "18:16"], zone: "exclude_no_parallel",
    note: "Tribute payment to Sennacherib — omitted entirely in Isaiah 36." },
  // 18:17 → 36:2, then offset -15 through 18:37 → 36:22
  { ki: ["18:17", "18:37"], isa: (c, v) => [`36:${v - 15}`], zone: "clean" },

  // ── 2 Kings 19 → Isaiah 37 ──
  // 19:1-9 → 37:1-9, but Isaiah 37:1-9 is ALREADY DONE BY A HUMAN → do not touch.
  { ki: ["19:1", "19:9"], isa: (c, v) => [`37:${v}`], zone: "exclude_target_human",
    note: "Isa 37:1-9 already adapted by the proofreader — excluded from migration." },
  // 19:10-14 → 37:10-14 (offset 0)
  { ki: ["19:10", "19:14"], isa: (c, v) => [`37:${v}`], zone: "clean" },
  // 19:15 → 37:15-16 (Hezekiah's prayer; one Kings verse split across two)
  { ki: ["19:15", "19:15"], isa: () => ["37:15", "37:16"], zone: "split",
    note: "2Ki 19:15 is split into Isa 37:15 (prayer intro) + 37:16 (address to Yahweh)." },
  // 19:16-37 → 37:17-38 (offset +1)
  { ki: ["19:16", "19:37"], isa: (c, v) => [`37:${v + 1}`], zone: "clean" },

  // ── 2 Kings 20 → Isaiah 38-39 ──
  { ki: ["20:1", "20:3"], isa: (c, v) => [`38:${v}`], zone: "clean" },
  // 20:4-6 — Yahweh's response; Isaiah rewords. Map 1:1 but flag.
  { ki: ["20:4", "20:6"], isa: (c, v) => [`38:${v}`], zone: "reorder",
    note: "Yahweh's healing response — reworded in Isaiah; verify quotes/wording." },
  // The sign + the poultice are REORDERED in Isaiah (moved to 38:21-22, 38:7-8).
  { ki: ["20:7", "20:7"], isa: () => ["38:21"], zone: "reorder",
    note: "The fig-poultice cure is moved to Isa 38:21." },
  { ki: ["20:8", "20:8"], isa: () => ["38:22"], zone: "reorder",
    note: "Hezekiah's request for a sign is moved to Isa 38:22." },
  { ki: ["20:9", "20:11"], isa: () => ["38:7", "38:8"], zone: "reorder",
    note: "The shadow/sundial sign — heavily compressed and reworded in Isa 38:7-8; flag all." },
  // Isa 38:9-20 (Hezekiah's writing/psalm) is unique to Isaiah — no Kings source.
  { ki: ["20:12", "20:19"], isa: (c, v) => [`39:${v - 11}`], zone: "clean" },
  { ki: ["20:20", "20:21"], zone: "exclude_no_parallel",
    note: "Hezekiah's other deeds + death — no Isaiah parallel." },
];

const map = {};
for (const seg of segments) {
  const [start, end] = seg.ki;
  const [ch, vStart] = start.split(":").map(Number);
  const vEnd = Number(end.split(":")[1]);
  for (let v = vStart; v <= vEnd; v++) {
    const key = `${ch}:${v}`;
    map[key] = {
      isa: seg.isa ? seg.isa(ch, v) : [],
      zone: seg.zone,
      ...(seg.note ? { note: seg.note } : {}),
    };
  }
}

const out = {
  source: "2KI", target: "ISA",
  // Pinned at generation time by the migration engine before any load; the SHAs
  // make the artifacts reproducible (Codex #11). Left null here.
  sourceShas: { uhb: null, ult: null, tn: null },
  targetShas: { uhb: null, ult: null },
  excludedTargetVerses: {
    "37": "1-9 (already adapted by a human)",
    "38": "9-20 (Hezekiah's writing — unique to Isaiah, no Kings source)",
  },
  map,
};

const dest = resolve(here, "kings-isa-versemap.json");
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
const zones = {};
for (const k of Object.keys(map)) zones[map[k].zone] = (zones[map[k].zone] || 0) + 1;
console.log(`wrote ${dest}`);
console.log("verses by zone:", zones);

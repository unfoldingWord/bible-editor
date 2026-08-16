// Regression tests for the number-split repair core (GitHub issue #452).
// Run from the repo root:
//   npm run test:scripts
//   node --experimental-strip-types --no-warnings scripts/lib/numberSplit.test.mjs
//
// Not a test framework; a failed assert exits non-zero.
//
// These fixtures are synthetic — no production dump is needed. Every one of
// them either reproduces a defect an independent review actually found by
// running the script, or pins an invariant the repair must never break.

import {
  DEFECT_RE,
  DETECT_RE,
  repairTree,
  repairVerse,
  joinString,
  flatten,
  countZaln,
  countNodes,
  wordSurfaces,
} from "./numberSplit.mjs";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok: ${msg}`);
}

// ── fixture helpers ────────────────────────────────────────────────────────

const w = (text) => ({ tag: "w", type: "word", text });
const t = (text) => ({ type: "text", text });
const zaln = (content, children) => ({ tag: "zaln", type: "milestone", content, children });
const cj = (verseObjects) => JSON.stringify({ verseObjects });

// The real prod shape: three nested zaln milestones (Hebrew "twenty" +
// "and-four" + "thousand") wrapping the English "24" + ", " + "000".
const realShape = () => [
  t("And "),
  zaln("עֶשְׂרִ֥ים", [zaln("וְ⁠אַרְבָּעָ֖ה", [zaln("אָֽלֶף", [w("24"), t(", "), w("000")])])]),
  t(" men."),
];

// ── the pattern itself ─────────────────────────────────────────────────────

console.log("DEFECT_RE / DETECT_RE");
assert(DEFECT_RE.test("24, 000"), "DEFECT_RE matches a single plain space");
assert(!DEFECT_RE.test("24,000"), "DEFECT_RE does not match an already-joined number");
assert(!DEFECT_RE.test("24, 0000"), "DEFECT_RE requires exactly three digits (no fourth)");
assert(!DEFECT_RE.test("24, 00"), "DEFECT_RE requires three digits, not two");
assert(DETECT_RE.test("24, 000"), "DETECT_RE matches a non-breaking space");
assert(!DEFECT_RE.test("24, 000"), "DEFECT_RE does NOT match a non-breaking space");
assert(DETECT_RE.test("24,  000"), "DETECT_RE matches a doubled space");
assert(!DEFECT_RE.test("24,  000"), "DEFECT_RE does NOT match a doubled space");
assert(!DETECT_RE.test("24,000"), "DETECT_RE does not match an already-joined number");

// ── the happy path ─────────────────────────────────────────────────────────

console.log("\nhappy path — the real prod shape");
{
  const vos = realShape();
  const zalnBefore = countZaln(vos);
  const nodesBefore = countNodes(vos);
  const wordsBefore = wordSurfaces(vos).join("|");
  const { sites, error } = repairTree(vos);
  assert(error === null, "real shape: no error");
  assert(sites.length === 1, "real shape: exactly one site");
  assert(sites[0].joined === "24,000", `real shape: reports the WHOLE number (got ${sites[0].joined})`);
  assert(flatten(vos).raw === "And 24,000 men.", "real shape: raw text is joined");
  assert(countZaln(vos) === zalnBefore, "real shape: zaln milestone count unchanged");
  assert(countNodes(vos) === nodesBefore, "real shape: node count unchanged");
  assert(wordSurfaces(vos).join("|") === wordsBefore, "real shape: \\w surface forms unchanged");
  assert(
    JSON.stringify(vos[1].children[0].children[0].children.map((n) => n.text)) ===
      JSON.stringify(["24", ",", "000"]),
    "real shape: the separator node became a bare comma, the \\w tokens are untouched",
  );
}

// ── chained groups ─────────────────────────────────────────────────────────

console.log("\nchained groups (the overlap that a single global pass gets wrong)");
{
  const vos = [w("1"), t(", "), w("100"), t(", "), w("000")];
  const { sites, error } = repairTree(vos);
  assert(error === null, "1, 100, 000: no error");
  assert(sites.length === 2, `1, 100, 000: two deletions (got ${sites.length})`);
  assert(flatten(vos).raw === "1,100,000", "1, 100, 000 → 1,100,000 (fixed point reached)");
  assert(
    sites[sites.length - 1].joined === "1,100,000",
    "1, 100, 000: final site reports the whole chained number",
  );
}
{
  const vos = [t("The number was 200, 000, 000.")];
  const { error } = repairTree(vos);
  assert(error === null, "200, 000, 000: no error");
  assert(flatten(vos).raw === "The number was 200,000,000.", "200, 000, 000 → 200,000,000");
}
assert(joinString("1, 100, 000") === "1,100,000", "joinString reaches the same fixed point");
assert(joinString("no numbers here") === "no numbers here", "joinString leaves clean text alone");

// ── two independent sites in one verse ─────────────────────────────────────

console.log("\ntwo independent sites");
{
  const vos = [w("4"), t(", "), w("000"), t(" and 4"), t(", "), w("000")];
  const { sites, error } = repairTree(vos);
  assert(error === null, "two sites: no error");
  assert(sites.length === 2, "two sites: two deletions");
  assert(flatten(vos).raw === "4,000 and 4,000", "two independent sites both joined");
}

// ── REFUSAL: a milestone CLOSES between the digits ─────────────────────────
//
// Found by an independent review. Every node the site touches is text-or-\w
// and none is zero-width, so the flat-order guard passes — but "24" is inside
// the alignment span and "000" is outside it. Joining bridges an alignment
// boundary.

console.log("\nREFUSAL: alignment boundary between the digits");
{
  const vos = [zaln("אָֽלֶף", [w("24"), t(", ")]), w("000")];
  const { sites, error } = repairTree(vos);
  assert(error !== null, "milestone closing between the digits is REFUSED");
  assert(/siblings|boundary/.test(error), `refusal names the boundary (got: ${error})`);
  assert(sites.length === 0, "milestone-close: nothing was written before refusing");
  assert(flatten(vos).raw === "24, 000", "milestone-close: the tree is left untouched");
}
{
  // The mirror case: a milestone OPENS between the digits.
  const vos = [w("24"), t(", "), zaln("אָֽלֶף", [w("000")])];
  const { error } = repairTree(vos);
  assert(error !== null, "milestone opening between the digits is REFUSED");
}

// ── REFUSAL: a marker node carrying the following text ─────────────────────
//
// usfm-js parks the text after a marker on the MARKER node itself, so this
// node is NOT zero-width. The "space" being deleted is really the space
// before a \q1 — the documented marker-fusion hazard.

console.log("\nREFUSAL: marker node carrying text");
{
  const vos = [w("24"), t(", "), { tag: "q1", type: "paragraph", text: "000 men." }];
  const { sites, error } = repairTree(vos);
  assert(error !== null, "marker node carrying the right-hand digits is REFUSED");
  assert(/non-text node/.test(error), `refusal names the non-text node (got: ${error})`);
  assert(sites.length === 0, "marker case: nothing written before refusing");
}

// ── REFUSAL: the space lives inside a \w token ─────────────────────────────

console.log("\nREFUSAL: separator inside a \\w token");
{
  const vos = [w("24, 000")];
  const { sites, error } = repairTree(vos);
  assert(error !== null, "a space inside a \\w word token is REFUSED");
  assert(/word token/.test(error), `refusal names the \\w token (got: ${error})`);
  assert(sites.length === 0, "in-\\w case: nothing written before refusing");
}

// ── REFUSAL: non-space whitespace separator ────────────────────────────────
//
// plain_text is whitespace-collapsed at ingest, so an NBSP in the tree shows
// up as a plain space in the column the dump SELECTs on. Bucketing this as
// "tree already repaired" was a false all-clear on a broken verse.

console.log("\nREFUSAL: non-space whitespace separator");
for (const [label, sep] of [["non-breaking space", " "], ["newline", "\n"], ["doubled space", "  "]]) {
  const r = repairVerse(cj([w("3"), t(`,${sep}`), w("000")]), `3, 000 men`);
  assert(r.status === "refused", `${label} separator is REFUSED, not silently skipped`);
  assert(
    /not a single plain space/.test(r.why),
    `${label}: refusal explains the separator (got: ${r.why})`,
  );
}

// ── repairVerse buckets ────────────────────────────────────────────────────

console.log("\nrepairVerse buckets");
{
  const r = repairVerse(cj(realShape()), "And 24, 000 men.");
  assert(r.status === "repaired", "a genuine defect is repaired");
  assert(r.newPlain === "And 24,000 men.", "plain_text is joined from the STORED string");
  assert(r.stats.zaln === 3, "stats report the (unchanged) zaln count");
  assert(JSON.parse(r.newContentJson).verseObjects.length === 3, "content_json round-trips");
}
{
  const r = repairVerse(cj([t("There were 5,000 men.")]), "There were 5,000 men.");
  assert(r.status === "clean", "a clean tree with clean plain_text is 'clean'");
}
{
  const r = repairVerse(cj([t("There were 5,000 men.")]), "There were 5, 000 men.");
  assert(r.status === "plain_text_only", "clean tree + stale plain_text is its own bucket");
  assert(r.newPlain === "There were 5,000 men.", "plain_text_only reports what it would become");
}
{
  const r = repairVerse(cj([w("24"), t(", "), w("000")]), null);
  assert(r.status === "refused", "a NULL plain_text is REFUSED, not defaulted to ''");
  assert(/NULL/.test(r.why), "NULL plain_text refusal says so");
}
{
  const r = repairVerse("{not json", "x");
  assert(r.status === "refused", "unparseable content_json is refused");
}
{
  const r = repairVerse(JSON.stringify({ nope: 1 }), "x");
  assert(r.status === "refused", "content_json without verseObjects is refused");
}

// ── the unaligned-prose shape (JER UST 52:28/52:30 in prod) ────────────────

console.log("\nunaligned prose (no alignment to preserve)");
{
  const r = repairVerse(cj([t("That was a total of 4, 600 Israelites.")]), "That was a total of 4, 600 Israelites.");
  assert(r.status === "repaired", "unaligned prose is repaired");
  assert(r.stats.zaln === 0 && r.stats.words === 0, "unaligned prose has no zaln and no \\w");
  assert(
    JSON.parse(r.newContentJson).verseObjects[0].text === "That was a total of 4,600 Israelites.",
    "unaligned prose joins in place",
  );
}

// ── idempotency ────────────────────────────────────────────────────────────

console.log("\nidempotency");
{
  const first = repairVerse(cj(realShape()), "And 24, 000 men.");
  const second = repairVerse(first.newContentJson, first.newPlain);
  assert(second.status === "clean", "re-running over a repaired verse reports 'clean'");
}

// ── the guard that cannot be automated ─────────────────────────────────────
//
// Pinned as a KNOWN LIMITATION, not a bug: a legitimate enumeration matches
// the pattern and repairs "perfectly". Only a human reading the sentence can
// catch it, which is why the CLI prints surrounding context for every site.

console.log("\nknown limitation: a legitimate list is indistinguishable");
{
  const r = repairVerse(cj([t("of ages 5, 300, and 900 years")]), "of ages 5, 300, and 900 years");
  assert(
    r.status === "repaired",
    "a legitimate enumeration IS repaired — no automated check can catch it (hence the context lines)",
  );
  assert(
    r.sites[0].was.includes("ages 5, 300"),
    "the site carries surrounding context so a human can spot it in the report",
  );
}

console.log(`\nnumberSplit: all ${passed} assertions passed`);

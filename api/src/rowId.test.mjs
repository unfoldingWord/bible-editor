// Unit tests for rowId.ts — the row-id grammar + the deterministic coerceRowId
// guard (Guard 1 of the DCS→D1 reimport hardening). Run from api/:
//   node --experimental-strip-types --no-warnings src/rowId.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { ROW_ID_RE, isValidRowId, coerceRowId, newRowId, deriveAltRowId } from "./rowId.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- isValidRowId / ROW_ID_RE ---
for (const good of ["abcd", "a1b2", "z9z9", "abc1", "k84q"]) {
  assert(isValidRowId(good), `valid id accepted: ${good}`);
}
for (const bad of ["1abc", "0xy9", "abc", "abcde", "ABCD", "", "a-bc", "12", "99999", "a bc"]) {
  assert(!isValidRowId(bad), `invalid id rejected: ${JSON.stringify(bad)}`);
}

// --- coerceRowId: no-op for valid ids ---
for (const good of ["abcd", "a1b2", "z9z9", "k84q"]) {
  assert(coerceRowId(good) === good, `coerce is a no-op for valid id: ${good}`);
}

// --- coerceRowId: malformed → valid, deterministic, idempotent ---
const BAD = ["1abc", "0xy9", "12", "99999", "ABCD", "a-bc", "2222", "x", "zzzzz"];
for (const bad of BAD) {
  const c = coerceRowId(bad);
  assert(isValidRowId(c), `coerce(${JSON.stringify(bad)}) = ${c} is a valid id`);
  assert(coerceRowId(bad) === c, `coerce(${JSON.stringify(bad)}) is deterministic`);
  // Idempotent: the output is already valid, so a second pass leaves it alone —
  // this is what makes the reimport stable across nights (a re-run of the same
  // dirty master maps the bad id to the same good id, so no second copy).
  assert(coerceRowId(c) === c, `coerce is idempotent for ${JSON.stringify(bad)} → ${c}`);
}

// Anchor one mapping so an accidental change to the hash is caught.
assert(coerceRowId("1abc") === "w6w6", `coerce("1abc") is stable === w6w6 (got ${coerceRowId("1abc")})`);

// Distinct bad ids generally map to distinct good ids (collision is possible but
// must be rare — assert no collisions across this sample).
{
  const seen = new Map();
  for (const bad of BAD) {
    const c = coerceRowId(bad);
    assert(!seen.has(c), `no coerce collision: ${JSON.stringify(bad)} and ${seen.get(c)} both → ${c}`);
    seen.set(c, bad);
  }
}

// --- newRowId always satisfies the grammar (sampled) ---
{
  let allValid = true;
  let bad = "";
  for (let i = 0; i < 2000; i++) {
    const id = newRowId();
    if (!isValidRowId(id)) { allValid = false; bad = id; break; }
  }
  assert(allValid, `newRowId() matches the grammar across 2000 samples${bad ? ` (offender: ${bad})` : ""}`);
}

// --- deriveAltRowId: deterministic, distinct per attempt, always valid, not a no-op ---
{
  assert(
    deriveAltRowId("hoig", 1) === deriveAltRowId("hoig", 1),
    "deriveAltRowId is deterministic across repeated calls for the same (seed, attempt)",
  );

  const perAttempt = [];
  for (let attempt = 1; attempt <= 7; attempt++) perAttempt.push(deriveAltRowId("hoig", attempt));
  const distinct = new Set(perAttempt);
  assert(
    distinct.size === 7,
    `deriveAltRowId produces 7 distinct ids across attempts 1..7 for one seed (got ${distinct.size}: ${perAttempt.join(",")})`,
  );

  for (const attempt of [0, 1, 2, 7]) {
    const good = deriveAltRowId("abcd", attempt);
    assert(ROW_ID_RE.test(good), `deriveAltRowId("abcd", ${attempt}) = ${good} satisfies ROW_ID_RE`);
    const fromBadSeed = deriveAltRowId("9BAD", attempt);
    assert(
      ROW_ID_RE.test(fromBadSeed),
      `deriveAltRowId("9BAD", ${attempt}) = ${fromBadSeed} satisfies ROW_ID_RE even for a malformed input seed`,
    );
  }

  assert(
    deriveAltRowId("abcd", 1) !== "abcd",
    `deriveAltRowId is not a no-op: deriveAltRowId("abcd", 1) (${deriveAltRowId("abcd", 1)}) differs from the seed`,
  );
}

// --- deriveAltRowId: entropy regression guard ---
// The reachable-output space is 24*32^3 = 786432. The old broken
// implementation collapsed to only 96 reachable ids because the low 5 bits of
// the FNV recurrence formed a closed cycle — dense enough that two colliding
// proposals in one chapter could derive the SAME alternate id, at which point
// the second silently UPDATEs over the first instead of getting its own row.
// This test asserts the fixed implementation's spread is nowhere near that
// collapsed pool: 200k draws from a 786432-id space should yield ~176560
// distinct values under ideal uniform hashing (birthday-paradox expectation);
// 150000 is set well below that so ordinary hash variance can't flake it,
// while still being far above the 96-id collapse this guards against.
{
  const seen = new Set();
  for (let i = 0; i < 200_000; i++) {
    seen.add(deriveAltRowId(`seed${i}`, 1));
  }
  assert(
    seen.size >= 150_000,
    `deriveAltRowId spreads across at least 150000 distinct ids out of 200000 draws (got ${seen.size}) — ` +
      `a collapsed output pool (the old bug reached only 96) lets two colliding proposals in one chapter ` +
      `derive the same alternate id, at which point the second silently UPDATEs over the first`,
  );
}

console.log("rowId.test.mjs: all assertions passed");

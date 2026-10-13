// utf8ToBase64 (export.ts) memory + byte-identity tests, issue #1182. Run from api/:
//   node --experimental-strip-types --no-warnings src/exportBase64.test.mjs
//
// The nightly export of JER UST (~6 MB USFM) ran out of the Worker's 128 MB
// isolate. The old encoder built its binary string one byte at a time
// (`bin += String.fromCharCode(b)`), which leaves a rope of ~6M one-character
// strings live until btoa flattens it: about 200 MB in Node for JER UST. The
// encoded bytes go to Door43 as the file content and are compared with
// master's base64 to decide commit vs skip, so the replacement must produce
// exactly the same output.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { utf8ToBase64, usfmAlignmentShrinkRefused } from "./export.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// The encoder export.ts shipped before #1182: the reference for byte identity.
function oldUtf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function same(s, label) {
  const want = oldUtf8ToBase64(s);
  assert(utf8ToBase64(s) === want, `${label}: matches the old encoder`);
  assert(want === Buffer.from(s, "utf8").toString("base64"), `${label}: old encoder matches Buffer (sanity)`);
}

console.log("utf8ToBase64 byte identity");
same("", "empty string");
same("a", "1 byte");
same("ab", "2 bytes");
same("abc", "3 bytes");
// Legacy UHB mark order (consonant, dagesh, vowel) and NFC must both pass through untouched.
same("\\w בְּ⁠רֵאשִׁ֖ית|x-strong=\"b:H7225\"\\w* וּ⁠בָּ֣א", "Hebrew with combining marks");
same("בּ".normalize("NFC") + "בּ".normalize("NFD"), "Hebrew NFC vs NFD");
same("emoji 😀 astral 𝔘 and 𐤀 Phoenician", "astral / emoji characters");
same("“quoted” — dash é", "two- and three-byte characters");
// Chunk-boundary cases: any chunk size the implementation uses must be a
// multiple of 3 bytes, or base64 padding lands mid-string. Cover lengths
// around several plausible chunk sizes, plus multi-byte characters that
// straddle them.
for (const n of [0x2000 * 3, 0x8000]) {
  for (const len of [n - 1, n, n + 1, 2 * n + 2]) same("x".repeat(len), `ascii length ${len}`);
  same("x".repeat(n - 1) + "😀" + "y", `emoji straddling byte ${n}`);
  same("x".repeat(n - 2) + "בּ" + "y", `Hebrew straddling byte ${n}`);
}

// Large inputs: compare against Buffer, not the old encoder. The old encoder
// needs ~200 MB of heap on a book this size, which the test run should not pay.
function sameAsBuffer(s, label) {
  assert(utf8ToBase64(s) === Buffer.from(s, "utf8").toString("base64"), `${label}: matches Buffer`);
}

// ~6 MB of mixed Hebrew + ASCII + emoji, the size of JER UST.
const unit = "\\zaln-s |x-strong=\"H1697\" x-content=\"דְּבַר\"\\*\\w word|x-occurrence=\"1\"\\w*\\zaln-e\\* 😀\n";
const repeats = Math.ceil(6_000_000 / Buffer.byteLength(unit));
const big = unit.repeat(repeats);
sameAsBuffer(big, `synthetic ${(Buffer.byteLength(big) / 1e6).toFixed(1)} MB book`);

// Memory: encode the synthetic book in a child process with a capped old
// space. The new encoder needs ~28 MB in Node on JER UST, including the
// ~21 MB baseline of loading the file and export.ts
// (scripts/measure-export-memory.mjs, which also shows the old encoder
// needing ~206 MB). The cap is the Worker's 128 MB, so the headroom is wide.
// The child prints the encoded length so a crash, a missing export, or a
// wrong result each fail with a visible reason.
console.log("utf8ToBase64 memory");
const CAP_MB = 128;
const exportUrl = new URL("./export.ts", import.meta.url).href;
const expectedLength = Buffer.from(big, "utf8").toString("base64").length;
const childCode = `
  import { utf8ToBase64 } from ${JSON.stringify(exportUrl)};
  const big = ${JSON.stringify(unit)}.repeat(${repeats});
  console.log("b64len=" + utf8ToBase64(big).length);
`;
const child = spawnSync(process.execPath, [
  `--max-old-space-size=${CAP_MB}`, "--max-semi-space-size=1",
  "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", childCode,
], { encoding: "utf8" });
if (child.status !== 0) console.error(child.stderr.slice(-2000));
assert(
  child.status === 0 && child.stdout.trim() === `b64len=${expectedLength}`,
  `new encoder encodes a 6 MB book within a ${CAP_MB} MB heap (status ${child.status}, ${child.stdout.trim() || "no output"})`,
);

// Real data, when present (gitignored; not in CI):
//   curl -s -o ../scripts/out/24-JER-ust.usfm https://git.door43.org/unfoldingWord/en_ust/raw/branch/master/24-JER.usfm
const jerPath = fileURLToPath(new URL("../../scripts/out/24-JER-ust.usfm", import.meta.url));
if (existsSync(jerPath)) {
  console.log("JER UST (real data)");
  const jer = readFileSync(jerPath, "utf8");
  sameAsBuffer(jer, "JER UST");
  // The shrink guard is not changed by #1182; pin its verdict on the real
  // book so a later memory change to it cannot silently flip the result.
  const i = jer.indexOf(" the ", jer.length >> 1);
  assert(i !== -1, `JER UST has " the " in its second half to edit`);
  const master = jer.slice(0, i) + " a " + jer.slice(i + 5);
  const self = usfmAlignmentShrinkRefused(jer, jer);
  assert(self.refused === false && self.offenders.length === 0, "guard: JER UST vs itself is not refused");
  const oneWord = usfmAlignmentShrinkRefused(jer, master);
  assert(oneWord.refused === false && oneWord.offenders.length === 0, "guard: JER UST vs a one-word master edit is not refused");
} else {
  console.log(`  skip: JER UST comparison (${jerPath} not downloaded)`);
}

console.log("exportBase64 tests passed");

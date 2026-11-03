// Tests for curlyQuotes.ts — straight-quote curlification and the paste
// replacement logic (curl direction of the FIRST pasted char decided by the
// character before the caret, without letting the ellipsis collapse eat the
// seed).
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/curlyQuotes.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors
// src/lib/replace.test.mjs.

import { curlifyString, curlifyPaste, pasteReplacement } from "./curlyQuotes.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── Baseline: curlifyString behavior unchanged ───────────────────────────
{
  console.log("\n[Baseline] curlifyString");
  assert(curlifyString(`"hello"`) === "“hello”", `plain double quotes curl (got ${JSON.stringify(curlifyString(`"hello"`))})`);
  assert(curlifyString("don't") === "don’t", `contextual apostrophe (got ${JSON.stringify(curlifyString("don't"))})`);
  assert(curlifyString("wait...") === "wait…", `triple dots collapse to ellipsis (got ${JSON.stringify(curlifyString("wait..."))})`);
}

// ─── Regression: paste ellipsis collapse must not cross the seed boundary ──
// Bug: handlePaste computed `curlifyString((prev ?? "") + text).slice(prev ? 1 : 0)`.
// With prev "." and pasted "...", the /\.\.\.+/ collapse merged the SEED dot
// into the ellipsis ("...." → "…"), so slice(1) removed the ellipsis instead
// of the seed — the paste inserted NOTHING. Pasting "...abc" after "." lost
// the ellipsis entirely (".abc"). curlifyPaste must keep the dot-collapse
// inside the pasted text.
{
  console.log("\n[Paste seam] ellipsis collapse stays inside the pasted text");
  assert(
    curlifyPaste("...", ".") === "…",
    `paste "..." after "." inserts an ellipsis (got ${JSON.stringify(curlifyPaste("...", "."))})`,
  );
  assert(
    curlifyPaste("...abc", ".") === "…abc",
    `paste "...abc" after "." keeps the ellipsis (got ${JSON.stringify(curlifyPaste("...abc", "."))})`,
  );
}

// ─── Seeded quote direction: prev char decides the first quote's curl ──────
{
  console.log("\n[Paste seam] first quote's direction comes from prev char");
  assert(
    curlifyPaste(`"hello`, " ") === "“hello",
    `paste '"hello' after a space opens (got ${JSON.stringify(curlifyPaste(`"hello`, " "))})`,
  );
  assert(
    curlifyPaste(`"hello`, "a") === "”hello",
    `paste '"hello' after a letter closes (got ${JSON.stringify(curlifyPaste(`"hello`, "a"))})`,
  );
  assert(
    curlifyPaste(`'`, "n") === "’",
    `paste "'" after a letter is an apostrophe (got ${JSON.stringify(curlifyPaste(`'`, "n"))})`,
  );
  assert(
    curlifyPaste(`"hi"`, undefined) === "“hi”",
    `no prev context: first quote opens (got ${JSON.stringify(curlifyPaste(`"hi"`, undefined))})`,
  );
  // Later quotes still keyed off the (already curlified) preceding pasted char,
  // not the prev context.
  assert(
    curlifyPaste(`"a" "b"`, "x") === "”a” “b”",
    `only the FIRST quote uses prev context (got ${JSON.stringify(curlifyPaste(`"a" "b"`, "x"))})`,
  );
}

// Pasting T4T (or any rich source) into a verse editor: the default paste
// carried the copied cell's <em> and color/background spans into the editor,
// where they survived the save and styled later typing, until the verse
// remounted. A contentEditable paste must always go in as plain text, even
// when there is no straight quote or "..." to rewrite. Fields keep the
// browser default in that case (they never take HTML).
{
  const t4t = "So tell this to the people: I will help you again.";
  assert(
    pasteReplacement(t4t, "x", "editable") === t4t,
    "editable: plain text with no quotes is still inserted as plain text",
  );
  assert(
    pasteReplacement(t4t, "x", "field") === null,
    "field: plain text with no quotes keeps the browser default",
  );
  assert(
    pasteReplacement(`say "hi"`, " ", "field") === "say “hi”",
    "field: straight quotes are still curled",
  );
  assert(
    pasteReplacement(`say "hi"`, " ", "editable") === "say “hi”",
    "editable: straight quotes are still curled",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll curlyQuotes tests passed.");

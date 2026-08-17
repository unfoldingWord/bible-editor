// Regression coverage for issue #491: POST /api/rows/:kind must normalize
// book case and refuse to mint a row for a chapter that doesn't exist.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/rowsCreateGuard.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBookCode, CHAPTER_EXISTS_SQL } from "./rowsCreateGuard.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[normalizeBookCode]");
eq(normalizeBookCode("psa"), "PSA", "lowercase -> uppercase");
eq(normalizeBookCode("Psa"), "PSA", "mixed case -> uppercase");
eq(normalizeBookCode("PSA"), "PSA", "already uppercase -> unchanged");
eq(normalizeBookCode("1co"), "1CO", "leading digit book code still uppercases");

console.log("\n[CHAPTER_EXISTS_SQL — the exact fragment rows.ts binds against real D1]");
{
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite
    .prepare(
      `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
       VALUES ('PSA', 1, 1, NULL, 'ULT', '{}', 'text')`,
    )
    .run();

  const probe = (book, chapter) => {
    const r = sqlite.prepare(CHAPTER_EXISTS_SQL).all(book, chapter);
    return r.length > 0;
  };

  eq(probe("PSA", 1), true, "a real (book, chapter) pair is found");
  eq(probe("PSA", 999), false, "a fabricated out-of-range chapter on a real book is rejected");
  eq(probe("ZEC", 1), false, "a real chapter number on a book that doesn't exist at all is rejected");
  eq(
    probe("PSA", 0),
    true,
    "chapter 0 (book-level front:intro pseudo-chapter, which has no verses rows of its own) is accepted when the BOOK is real",
  );
  eq(
    probe("ZEC", 0),
    false,
    "chapter 0 is still rejected when the book itself doesn't exist — the OR clause proves the book, not just any row",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll rowsCreateGuard assertions passed.");

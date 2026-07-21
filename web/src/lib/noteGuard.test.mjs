// Regression suite for the blank-note save guard. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/noteGuard.test.mjs
//
// Pins the exact prod bug: a substantive note (NUM 22:10 v4) blanked to "" and
// saved as v5. wouldBlankExistingNote must flag that transition so NoteCard can
// block the silent overwrite.

import { isBlankNoteText, wouldBlankExistingNote } from "./noteGuard.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── isBlankNoteText ──
assert(isBlankNoteText(""), "empty string is blank");
assert(isBlankNoteText(null), "null is blank");
assert(isBlankNoteText(undefined), "undefined is blank");
assert(isBlankNoteText("   "), "whitespace-only is blank");
assert(isBlankNoteText("\n\n"), "real newlines only is blank");
assert(isBlankNoteText("\\n\\n"), "TSV newline escapes only is blank");
assert(isBlankNoteText(" \\n \t"), "mixed whitespace + TSV escape is blank");
assert(!isBlankNoteText("Alternate translation: …"), "substantive note is not blank");
assert(!isBlankNoteText("  x  "), "text with surrounding whitespace is not blank");

// ── wouldBlankExistingNote — the guarded transition ──
const fullNote =
  "If it would be clearer in your language, you could translate this so that " +
  "there is not a quotation within a quotation.";
assert(
  wouldBlankExistingNote(fullNote, ""),
  "NUM 22:10 case: full note → empty string is a blank-out",
);
assert(
  wouldBlankExistingNote(fullNote, "   "),
  "full note → whitespace is a blank-out",
);
assert(
  wouldBlankExistingNote(fullNote, null),
  "full note → null is a blank-out",
);
assert(
  wouldBlankExistingNote("line one\\nline two", "\\n"),
  "TSV multiline note → lone newline escape is a blank-out",
);

// ── wouldBlankExistingNote — transitions that must NOT be blocked ──
assert(
  !wouldBlankExistingNote(fullNote, "revised note"),
  "full note → different substantive note is allowed",
);
assert(
  !wouldBlankExistingNote("", ""),
  "already-blank → blank is not data loss (new/imported stub)",
);
assert(
  !wouldBlankExistingNote(null, ""),
  "null baseline → empty is not a blank-out",
);
assert(
  !wouldBlankExistingNote("   ", ""),
  "whitespace baseline → empty is not a blank-out",
);
assert(
  !wouldBlankExistingNote("", fullNote),
  "blank → substantive (first authoring) is allowed",
);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll noteGuard tests passed");
}

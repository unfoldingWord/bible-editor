// Regression suite for the blank-note save guard. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/noteGuard.test.mjs
//
// Pins the exact prod bug: a substantive note (NUM 22:10 v4) blanked to "" and
// saved as v5. wouldBlankExistingNote must flag that transition so NoteCard can
// block the silent overwrite.

import {
  isAbandonedBlankStub,
  isBlankNoteText,
  wouldBlankExistingNote,
} from "./noteGuard.ts";

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

// ── isAbandonedBlankStub — the create-path gap ──
//
// Pins the second prod bug: JER 36:21 `fa9t` / 36:24 `c3u7`, created 2026-07-27/28
// with note:"" by "Add note" and never filled. wouldBlankExistingNote above
// structurally cannot catch these (blank→blank returns false), and the API create
// route accepts note:"" by design, so the stub has to be discarded on the way out.

// A freshly-created, still-untouched stub as Shell's onNoteCreate leaves it.
function stub(over = {}) {
  return {
    version: 1,
    updated_by: 30,
    note: "",
    quote: null,
    support_reference: null,
    tags: null,
    occurrence: null,
    trashed_at: null,
    preserve: 0,
    hint: 0,
    ...over,
  };
}
const emptyLocal = { note: "", quote: "", supportRef: null, hydrated: true };

assert(
  isAbandonedBlankStub(stub(), emptyLocal),
  "JER fa9t case: app-created v1 stub, nothing typed → discard",
);
assert(
  isAbandonedBlankStub(stub({ note: "   " }), { ...emptyLocal, note: "  \\n " }),
  "whitespace/TSV-escape-only stub → discard",
);

// The 11 genuine upstream empties (2CH 13:4 ai78, JER 52:28 l6dd, …) are
// version 1 with updated_by NULL and DO exist on en_tn master. Touching them
// would delete real upstream rows.
assert(
  !isAbandonedBlankStub(stub({ updated_by: null }), emptyLocal),
  "upstream empty (updated_by NULL) is left alone",
);

// Anything the user could lose must block the discard.
assert(
  !isAbandonedBlankStub(stub(), { ...emptyLocal, note: "typed but unsaved" }),
  "unsaved draft body in local state blocks discard",
);
assert(
  !isAbandonedBlankStub(stub(), { ...emptyLocal, quote: "בְּרֵאשִׁית" }),
  "quote picked but body not yet typed blocks discard",
);
assert(
  !isAbandonedBlankStub(stub(), {
    ...emptyLocal,
    supportRef: "rc://*/ta/man/translate/figs-metaphor",
  }),
  "support reference chosen but body not yet typed blocks discard",
);
assert(
  !isAbandonedBlankStub(stub(), { ...emptyLocal, hydrated: false }),
  "pre-hydration local state is not evidence of emptiness → no discard",
);
assert(
  !isAbandonedBlankStub(stub({ version: 2 }), emptyLocal),
  "a row edited at least once is not a stub",
);
assert(
  !isAbandonedBlankStub(stub({ hint: 1 }), emptyLocal),
  "hint stub is intentionally empty (queued for the AI pipeline) → keep",
);
assert(
  !isAbandonedBlankStub(stub({ preserve: 1 }), emptyLocal),
  "explicit preserve bit → keep",
);
assert(
  !isAbandonedBlankStub(stub({ trashed_at: 1750000000 }), emptyLocal),
  "already trashed → nothing to discard",
);
assert(
  !isAbandonedBlankStub(stub({ quote: "בְּרֵאשִׁית" }), emptyLocal),
  "row already carries a saved quote → keep",
);
assert(
  !isAbandonedBlankStub(stub({ occurrence: 1 }), emptyLocal),
  "row carries an occurrence → keep",
);
assert(
  !isAbandonedBlankStub(stub({ tags: "figs-metaphor" }), emptyLocal),
  "row carries tags → keep",
);
assert(
  !isAbandonedBlankStub(stub({ note: fullNote }), { ...emptyLocal, note: fullNote }),
  "a real note is never a stub",
);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll noteGuard tests passed");
}

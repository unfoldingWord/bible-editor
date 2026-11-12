// Regression for issue #1330: restoring a tn Quote from history must bring its
// Occurrence back. Since #1329, clearing a Quote stores Occurrence 0; the
// restore patch used to carry only quote/note/support_reference, so the server's
// requiredOccurrence healed the 0 to 1 and the note anchored to the wrong copy
// of the word.

import assert from "node:assert/strict";
import { buildTnRestorePatch } from "./tnRestorePatch.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

const HEB = "בַּיּ֣וֹם הַה֗וּא";
const SR = "rc://*/ta/man/translate/figs-idiom";

// The row after the Quote was cleared: blank quote, server-forced Occurrence 0.
const cleared = { quote: "", note: "Some note.", support_reference: SR };

{
  const patch = buildTnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: SR, occurrence: 2 },
    cleared,
    0,
  );
  check(patch.quote === HEB, "restoring a Hebrew quote sends the quote");
  check(
    patch.occurrence === 2,
    `snapshot Occurrence 2 over current 0 is sent (got ${JSON.stringify(patch.occurrence)})`,
  );
  check(!("note" in patch), "an unchanged note is not sent");
}

{
  const patch = buildTnRestorePatch(
    { quote: HEB, note: "Older note.", support_reference: SR, occurrence: 1 },
    { quote: HEB, note: "Some note.", support_reference: SR },
    3,
  );
  check(patch.note === "Older note.", "a note-only restore sends the note");
  check(
    !("occurrence" in patch),
    "a note-only restore sends no occurrence, so it cannot undo an occurrence-only repair",
  );
}

{
  const patch = buildTnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: SR, occurrence: null },
    cleared,
    0,
  );
  check(patch.quote === HEB, "quote restore with a null snapshot occurrence sends the quote");
  check(!("occurrence" in patch), "a null snapshot occurrence is not sent");
}

{
  const patch = buildTnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: SR, occurrence: 2 },
    { quote: "an English gloss", note: "Some note.", support_reference: SR },
    2,
  );
  check(patch.quote === HEB, "quote restore with an unchanged occurrence sends the quote");
  check(!("occurrence" in patch), "an occurrence equal to the current one is not sent");
}

{
  const patch = buildTnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: SR, occurrence: 2 },
    { quote: HEB, note: "Some note.", support_reference: SR },
    0,
  );
  check(Object.keys(patch).length === 0, "restoring the current content sends an empty patch");
}

console.log(`\n${passed} assertions passed`);

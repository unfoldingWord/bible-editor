// Footnote edit / delete (footnotes.ts). The invariant under test: a footnote
// change touches only that footnote — every `\w` word, `\zaln` milestone and
// other footnote comes back as the same node — and a delete never fuses the
// words on either side of the note.

import assert from "node:assert/strict";
import usfm from "usfm-js";
import { listFootnotes, editFootnote, footnoteContentError, footnoteDisplayText } from "./footnotes.ts";
import { extractPlainText, extractEditableText } from "./usfm.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

const SRC = String.raw`\id GEN
\c 1
\p
\v 1 \zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="א"\*\w In|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\f + \fr 1:1 \ft Or \fqa beginning\fqa*.\f* \zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="ב"\*\w the|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\f + \ft end note\f*
\w more|x-occurrence="1" x-occurrences="1"\w*.
\v 2 text\f + \ft two\f* rest.
\v 3 \zaln-s |x-strong="H3" x-occurrence="1" x-occurrences="1" x-content="ג"\*\w God|x-occurrence="1" x-occurrences="1"\w*\f + \ft split\f* \w said|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*.
`;
const book = usfm.toJSON(SRC);
const vo = (v) => book.chapters["1"][v].verseObjects;
// A well-formed footnote inside a milestone, built by hand (usfm-js itself
// splits such a note into fragments — see verse 3 above).
const nested = () => [
  {
    tag: "zaln", type: "milestone", strong: "H3", content: "ג",
    children: [
      { text: "God", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
      { tag: "f", type: "footnote", content: "+ \\ft nested", endTag: "f*", nextChar: " " },
      { text: "said", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
    ],
    endTag: "zaln-e\\*",
  },
  { type: "text", text: "." },
];
const toUsfm = (verseObjects) =>
  usfm.toUSFM({ headers: [], chapters: { 1: { 1: { verseObjects } } } }, { forcedNewLines: true });

// --- listing ---
const v1 = listFootnotes(vo("1"));
check(v1.length === 2, "verse 1 lists both footnotes");
check(v1[0].content === String.raw`+ \fr 1:1 \ft Or \fqa beginning\fqa*.`, "raw body kept as stored");
check(v1[0].text === "Or beginning.", "display text drops caller, \\fr and markers");
check(v1[1].text === "end note", "second footnote text");
check(listFootnotes(nested()).length === 1, "footnote nested inside a \\zaln milestone is listed");
check(listFootnotes(vo("3")).length === 0, "usfm-js's split fragments of a milestone-nested note are not offered for edit");
check(listFootnotes([]).length === 0 && listFootnotes(undefined).length === 0, "empty / missing tree lists nothing");
check(
  listFootnotes([{ tag: "sp", text: "", children: [{ tag: "f", type: "footnote", content: "+ \\ft x", endTag: "f*" }] }]).length === 0,
  "a footnote inside a \\sp label belongs to the header band and is skipped",
);
check(footnoteDisplayText("a \\ft custom caller") === "custom caller", "custom caller stripped");

// --- edit ---
{
  const before = vo("1");
  const after = editFootnote(before, { index: 0, content: "+ \\ft Or start." });
  check(after !== before, "edit returns a new tree");
  check(after[0] === before[0] && after[2] === before[2] && after[3] === before[3], "untouched nodes are shared (alignment untouched)");
  check(after[1].content === "+ \\ft Or start." && after[1].nextChar === " ", "edited body written, nextChar kept");
  check(extractPlainText(after) === extractPlainText(before), "plain text unchanged by a footnote edit");
  check(extractEditableText(after) === extractEditableText(before), "editable text unchanged by a footnote edit");
  check(toUsfm(after).includes("\\f + \\ft Or start.\\f*"), "export writes the new body");
  check(editFootnote(before, { index: 0, content: before[1].content }) === before, "same body ⇒ same tree (no save)");
  check(editFootnote(before, { index: 9, content: "+ \\ft x" }) === before, "out-of-range index ⇒ same tree");
}
{
  const before = nested();
  const after = editFootnote(before, { index: 0, content: "+ \\ft changed" });
  check(after[0] !== before[0] && after[0].children[0] === before[0].children[0], "nested edit rebuilds only the milestone path");
  check(after[0].strong === "H3" && after[0].children.length === before[0].children.length, "milestone attrs and child count kept");
}

// --- delete ---
{
  const before = vo("2");
  const after = editFootnote(before, { index: 0, content: null });
  check(listFootnotes(after).length === 0, "footnote removed");
  check(extractPlainText(after) === "text rest.", "delete keeps the words apart (nextChar separator survives)");
  check(!toUsfm(after).includes("\\f"), "export carries no footnote");
}
{
  const before = vo("1");
  const after = editFootnote(before, { index: 0, content: null });
  check(listFootnotes(after).length === 1 && listFootnotes(after)[0].text === "end note", "deleting the first leaves the second");
  check(after.filter((n) => n.type === "milestone").every((m, i) => m === before.filter((n) => n.type === "milestone")[i]), "milestones shared after delete");
  check(extractPlainText(after) === extractPlainText(before), "plain text unchanged (no double / missing space)");
  const after2 = editFootnote(before, { index: 1, content: null });
  check(extractPlainText(after2) === "In the more.", "deleting a line-end footnote keeps `the` and `more` apart");
}
{
  const before = nested();
  const after = editFootnote(before, { index: 0, content: null });
  check(extractPlainText(after) === extractPlainText(before), "nested delete keeps the words apart");
  check(after[0].children.filter((c) => c.type === "word").length === 2, "both aligned words stay in the milestone");
}

// --- validation ---
check(footnoteContentError("+ \\ft fine") === null, "valid body accepted");
check(footnoteContentError("   ") !== null, "empty body refused");
check(footnoteContentError("+ \\ft a\\f*") !== null, "closing \\f* refused");
check(footnoteContentError("+ \\ft a \\v 2 b") !== null, "verse marker refused");
check(footnoteContentError("+ \\ft a\nb") !== null, "newline refused");
check(footnoteContentError("+ \\ft see \\fqa word\\fqa*") === null, "footnote-internal markers allowed");

console.log(`footnotes: ${passed} passed`);

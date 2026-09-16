// Issue #788 — semantic visible axes of an adopt_conflict.
import assert from "node:assert/strict";
import {
  ACTION_ADOPT_NO_VISIBLE_CHANGE,
  adoptionReasonAxes,
  classifyVisibleAdoptionChange,
  REASON_BOTH_CHANGED_ALIGNMENT,
  REASON_BOTH_CHANGED_NO_VISIBLE,
  REASON_BOTH_CHANGED_PUNCTUATION,
  REASON_BOTH_CHANGED_PUNCTUATION_ALIGNMENT,
  REASON_BOTH_CHANGED_WORDING,
  REASON_BOTH_CHANGED_WORDING_ALIGNMENT,
  REASON_BOTH_CHANGED_WORDING_PUNCTUATION,
  REASON_BOTH_CHANGED_WORDING_PUNCTUATION_ALIGNMENT,
  refineAdoptConflictForVisibleChange,
} from "./visibleAdoptionChange.ts";

function word(text, sourceKeyParts) {
  const w = { type: "word", tag: "w", text, content: text, occurrence: "1", occurrences: "1" };
  if (!sourceKeyParts) return w;
  return {
    type: "milestone",
    tag: "zaln",
    strong: sourceKeyParts.strong,
    occurrence: sourceKeyParts.occurrence ?? "1",
    occurrences: sourceKeyParts.occurrences ?? "1",
    content: sourceKeyParts.content,
    children: [w],
  };
}

function verse(...nodes) {
  return { verseObjects: nodes };
}

function reason(ours, theirs) {
  return refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", ours, theirs);
}

{
  const ours = verse(word("Hello", { strong: "H1", content: "א" }), { type: "text", text: " world" });
  const theirs = verse(word("Hello", { strong: "H1", content: "א" }), { type: "text", text: "  world\n" }, { type: "text", text: "" });
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.deepEqual(v, { wordingChanged: false, punctuationChanged: false, alignmentChanged: false }, "whitespace/tree churn is no visible change");
  const refined = reason(ours, theirs);
  assert.equal(refined.action, ACTION_ADOPT_NO_VISIBLE_CHANGE, "whitespace-only is audit-only");
  assert.equal(refined.reason, REASON_BOTH_CHANGED_NO_VISIBLE);
}

{
  // NFC means decomposed vs composed accents do not create a false wording axis.
  const ours = verse({ type: "text", text: "cafe\u0301" });
  const theirs = verse({ type: "text", text: "caf\u00e9" });
  assert.equal(reason(ours, theirs).reason, REASON_BOTH_CHANGED_NO_VISIBLE, "NFC-equivalent text is no visible change");
}

{
  // Unicode punctuation is intentionally its own axis; punctuation does not
  // imply wording. Curly quotes and an em dash exercise non-ASCII punctuation.
  const ours = verse({ type: "text", text: "He said \u2018yes\u2019\u2014now." });
  const theirs = verse({ type: "text", text: "He said \u201cyes\u201d-now!" });
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.deepEqual(v, { wordingChanged: false, punctuationChanged: true, alignmentChanged: false }, "Unicode punctuation is distinct from wording");
  assert.equal(reason(ours, theirs).reason, REASON_BOTH_CHANGED_PUNCTUATION, "punctuation-only has its canonical reason");
  assert.equal(
    reason(verse({ type: "text", text: "a,b" }), verse({ type: "text", text: "ab," })).reason,
    REASON_BOTH_CHANGED_PUNCTUATION,
    "moving punctuation is detected even when its character multiset is unchanged",
  );
  assert.equal(
    reason(verse({ type: "text", text: "cat, now" }), verse({ type: "text", text: "elephant, later" })).reason,
    REASON_BOTH_CHANGED_WORDING,
    "word length and spelling do not manufacture a punctuation change",
  );
  assert.equal(
    reason(verse({ type: "text", text: "cat, now" }), verse({ type: "text", text: "dog; later" })).reason,
    REASON_BOTH_CHANGED_WORDING_PUNCTUATION,
    "wording plus punctuation has its own canonical reason",
  );
  assert.equal(
    reason(verse({ type: "text", text: "דבר טוב" }), verse({ type: "text", text: "דבר־טוב" })).reason,
    REASON_BOTH_CHANGED_PUNCTUATION,
    "Hebrew maqaf is punctuation, while the surrounding Hebrew wording is unchanged",
  );
}

{
  // Marks and symbols stay wording; braces do too, despite being Unicode P.
  const mark = reason(verse({ type: "text", text: "a\u0301" }), verse({ type: "text", text: "a" }));
  assert.equal(mark.reason, REASON_BOTH_CHANGED_WORDING, "a combining mark is wording, not punctuation");
  const hebrewMark = reason(verse({ type: "text", text: "בָ" }), verse({ type: "text", text: "בַ" }));
  assert.equal(hebrewMark.reason, REASON_BOTH_CHANGED_WORDING, "a Hebrew vowel-point change is wording, not punctuation");
  const symbol = reason(verse({ type: "text", text: "Price \u20aa5" }), verse({ type: "text", text: "Price $5" }));
  assert.equal(symbol.reason, REASON_BOTH_CHANGED_WORDING, "symbols are wording");
  const braces = reason(verse({ type: "text", text: "{name}" }), verse({ type: "text", text: "name" }));
  assert.equal(braces.reason, REASON_BOTH_CHANGED_WORDING, "semantic braces are wording, not punctuation");
}

{
  // Target wording changed, but sourceKey order did not: alignment must stay
  // false. This is the regression for the old text+sourceKey fingerprint.
  const ours = verse(word("Hello", { strong: "H1", content: "א" }));
  const theirs = verse(word("Goodbye", { strong: "H1", content: "א" }));
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.deepEqual(v, { wordingChanged: true, punctuationChanged: false, alignmentChanged: false }, "target surface is not an alignment fingerprint input");
  assert.equal(reason(ours, theirs).reason, REASON_BOTH_CHANGED_WORDING);
}

{
  const ours = verse(word("Hello", { strong: "H1", content: "א" }), { type: "text", text: " " }, word("world", { strong: "H2", content: "ב" }));
  const theirs = verse(word("Hello", { strong: "H9", content: "ז" }), { type: "text", text: " " }, word("world", { strong: "H2", content: "ב" }));
  assert.equal(reason(ours, theirs).reason, REASON_BOTH_CHANGED_ALIGNMENT, "same wording with a re-pointed sourceKey is alignment-only");
}

{
  // All remaining non-empty combinations are canonical and preserve source-key
  // ORDER (same keys in a different target-word order is alignment change).
  const base = verse(word("one", { strong: "H1", content: "א" }), { type: "text", text: " " }, word("two", { strong: "H2", content: "ב" }));
  const wordingAlignment = verse(word("uno", { strong: "H2", content: "ב" }), { type: "text", text: " " }, word("two", { strong: "H1", content: "א" }));
  assert.equal(reason(base, wordingAlignment).reason, REASON_BOTH_CHANGED_WORDING_ALIGNMENT, "wording + reordered source keys is canonical");
  const punctuationAlignment = verse(word("one", { strong: "H2", content: "ב" }), { type: "text", text: ", " }, word("two", { strong: "H1", content: "א" }));
  assert.equal(reason(base, punctuationAlignment).reason, REASON_BOTH_CHANGED_PUNCTUATION_ALIGNMENT, "punctuation + reordered source keys is canonical");
  const all = verse(word("uno", { strong: "H2", content: "ב" }), { type: "text", text: ", " }, word("two", { strong: "H1", content: "א" }));
  assert.equal(reason(base, all).reason, REASON_BOTH_CHANGED_WORDING_PUNCTUATION_ALIGNMENT, "all three axes have an explicit canonical reason");
}

{
  // Malformed JSON and a malformed tree must over-warn, never collapse to
  // no-visible-change because both helpers happened to extract an empty string.
  assert.deepEqual(
    classifyVisibleAdoptionChange("{bad json", verse({ type: "text", text: "ok" })),
    { wordingChanged: true, punctuationChanged: true, alignmentChanged: true },
    "malformed JSON fails closed",
  );
  assert.deepEqual(
    classifyVisibleAdoptionChange({ verseObjects: [{ type: "text", text: 7 }] }, verse({ type: "text", text: "ok" })),
    { wordingChanged: true, punctuationChanged: true, alignmentChanged: true },
    "malformed node shape fails closed",
  );
  assert.deepEqual(
    classifyVisibleAdoptionChange({ verseObjects: [{ mystery: "bytes we cannot read" }] }, verse({ type: "text", text: "ok" })),
    { wordingChanged: true, punctuationChanged: true, alignmentChanged: true },
    "an unrecognized object cannot be mistaken for empty text",
  );
  assert.deepEqual(
    classifyVisibleAdoptionChange(
      { verseObjects: [{ type: "opaque", value: "old" }] },
      { verseObjects: [{ type: "opaque", value: "new" }] },
    ),
    { wordingChanged: true, punctuationChanged: true, alignmentChanged: true },
    "an opaque typed node cannot be mistaken for no visible change",
  );
}

{
  // Legacy and unknown persisted reasons are compatibility/fail-safe helpers.
  assert.deepEqual(adoptionReasonAxes("both_changed"), { wording: true, punctuation: false, alignment: true }, "legacy both_changed keeps its original axes without inventing punctuation");
  assert.deepEqual(adoptionReasonAxes("both_changed_future_axis"), { wording: true, punctuation: false, alignment: true }, "unknown reason fails safe on legacy axes without inventing punctuation");
  assert.deepEqual(adoptionReasonAxes("__proto__"), { wording: true, punctuation: false, alignment: true }, "prototype-key reason cannot bypass the fail-safe fallback");
  assert.deepEqual(adoptionReasonAxes("constructor"), { wording: true, punctuation: false, alignment: true }, "constructor-key reason cannot bypass the fail-safe fallback");
}

{
  const refined = refineAdoptConflictForVisibleChange("adopt", "master_changed", "{}", "{}");
  assert.equal(refined.action, "adopt", "non-conflict actions pass through untouched");
  assert.equal(refined.reason, "master_changed");
}

console.log("visibleAdoptionChange.test.mjs: ok");

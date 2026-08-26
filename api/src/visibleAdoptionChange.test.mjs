// Issue #633 — visible axes of an adopt_conflict (plain text + alignment groups).
import assert from "node:assert/strict";
import {
  ACTION_ADOPT_NO_VISIBLE_CHANGE,
  classifyVisibleAdoptionChange,
  REASON_BOTH_CHANGED,
  REASON_BOTH_CHANGED_ALIGNMENT,
  REASON_BOTH_CHANGED_NO_VISIBLE,
  REASON_BOTH_CHANGED_WORDING,
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

{
  const ours = verse(word("Hello", { strong: "H1", content: "א" }), { type: "text", text: " " }, word("world", { strong: "H2", content: "ב" }));
  const theirs = verse(
    word("Hello", { strong: "H1", content: "א" }),
    { type: "text", text: " " },
    word("world", { strong: "H2", content: "ב" }),
    // Cosmetic tree churn: empty text node / nextChar-shaped noise that
    // stableKey can still see as a diff (#627 / #633 phantom class).
    { type: "text", text: "" },
  );
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.equal(v.wordingChanged, false, "identical plain text → wording unchanged");
  assert.equal(v.alignmentChanged, false, "identical alignment groups → alignment unchanged");
  const refined = refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", ours, theirs);
  assert.equal(refined.action, ACTION_ADOPT_NO_VISIBLE_CHANGE, "no-visible → audit-only action");
  assert.equal(refined.reason, REASON_BOTH_CHANGED_NO_VISIBLE);
}

{
  // JER-shaped replay: six verses whose words + groups match must all refine
  // to adopt_no_visible_change (the alert filter excludes that action).
  const refs = ["40:5", "40:6", "40:10", "41:5", "41:6", "41:10"];
  for (const ref of refs) {
    const content = verse(
      word(`text-${ref}`, { strong: "H40", content: "יר" }),
      { type: "text", text: " " },
      word("shared", { strong: "H41", content: "מש" }),
    );
    // theirs differs only by an extra empty text node — invisible.
    const theirs = verse(
      word(`text-${ref}`, { strong: "H40", content: "יר" }),
      { type: "text", text: " " },
      word("shared", { strong: "H41", content: "מש" }),
      { type: "text", text: "" },
    );
    const refined = refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", content, theirs);
    assert.equal(
      refined.action,
      ACTION_ADOPT_NO_VISIBLE_CHANGE,
      `${ref}: no editor alert action`,
    );
  }
}

{
  const ours = verse(word("Hello", { strong: "H1", content: "א" }));
  const theirs = verse(word("Goodbye", { strong: "H1", content: "א" }));
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.equal(v.wordingChanged, true, "different plain text → wording changed");
  assert.equal(v.alignmentChanged, true, "target word text is part of the group fingerprint");
  const refined = refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", ours, theirs);
  assert.equal(refined.action, "adopt_conflict");
  // Word text change flips both axes (plain text + group fingerprint).
  assert.equal(refined.reason, REASON_BOTH_CHANGED);
}

{
  // Same target words, re-pointed source milestone → alignment-only.
  const ours = verse(word("Hello", { strong: "H1", content: "א" }), { type: "text", text: " " }, word("world", { strong: "H2", content: "ב" }));
  const theirs = verse(word("Hello", { strong: "H9", content: "ז" }), { type: "text", text: " " }, word("world", { strong: "H2", content: "ב" }));
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.equal(v.wordingChanged, false, "same plain text");
  assert.equal(v.alignmentChanged, true, "sourceKey re-point → alignment changed");
  const refined = refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", ours, theirs);
  assert.equal(refined.action, "adopt_conflict");
  assert.equal(refined.reason, REASON_BOTH_CHANGED_ALIGNMENT);
}

{
  // Wording change that keeps the same sourceKey on a single-word verse is
  // unusual (fingerprint includes word text), so build a multi-word case where
  // an unaligned text node changes wording without touching \w sourceKeys —
  // extractPlainText includes bare text nodes.
  const ours = verse(
    word("Hello", { strong: "H1", content: "א" }),
    { type: "text", text: " there" },
  );
  const theirs = verse(
    word("Hello", { strong: "H1", content: "א" }),
    { type: "text", text: " elsewhere" },
  );
  const v = classifyVisibleAdoptionChange(ours, theirs);
  assert.equal(v.wordingChanged, true, "bare text node change → wording");
  assert.equal(v.alignmentChanged, false, "\\w + sourceKey sequence unchanged → groups match");
  const refined = refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", ours, theirs);
  assert.equal(refined.reason, REASON_BOTH_CHANGED_WORDING);
}

{
  // Non-conflict actions pass through untouched.
  const refined = refineAdoptConflictForVisibleChange("adopt", "master_changed", "{}", "{}");
  assert.equal(refined.action, "adopt");
  assert.equal(refined.reason, "master_changed");
}

{
  // JSON string inputs (how bookReimport stores content_json) work the same.
  const content = JSON.stringify(verse(word("A", { strong: "H1", content: "א" })));
  const same = refineAdoptConflictForVisibleChange("adopt_conflict", "both_changed", content, content);
  assert.equal(same.action, ACTION_ADOPT_NO_VISIBLE_CHANGE);
}

console.log("visibleAdoptionChange.test.mjs: ok");

import assert from "node:assert/strict";
import { overlayFindMarks, renderHighlightedHTML, renderEditableHTML } from "./highlight.ts";
import { extractPlainText } from "./usfm.ts";

for (const tag of ["p", "q1", "q2"]) {
  const verseObjects = [
    { type: "text", text: "good" },
    { type: "paragraph", tag },
    { type: "text", text: "good" },
  ];
  const plain = extractPlainText({ verseObjects });
  assert.equal(plain, "good good");
  for (const render of [renderHighlightedHTML, renderEditableHTML]) {
    const html = render(verseObjects, new Set());
    const marked = overlayFindMarks(html, /good/g, { start: 5, end: 9 });
    assert.equal((marked.match(/be-find-active/g) ?? []).length, 1, `${tag}: correct active occurrence`);
    assert.ok(marked.indexOf("be-find-active") > marked.indexOf("</mark>"), `${tag}: second occurrence active`);
    const competing = overlayFindMarks(html, /goodgood|good/g, null);
    assert.equal((competing.match(/<mark /g) ?? []).length, 2, `${tag}: phantom cross-block word cannot swallow valid hits`);
    assert.equal(overlayFindMarks(html, /goodgood/g, null), html, `${tag}: no cross-block concatenated hit`);
    assert.equal((overlayFindMarks(html, /good$/g, { start: 5, end: 9 }).match(/be-find-active/g) ?? []).length,
      1, `${tag}: terminal block keeps end-of-verse regex anchors`);
    assert.equal(overlayFindMarks(html, /good\s+good/g, null), html, `${tag}: spanning runs still skipped safely`);
    assert.equal(marked.replace(/<mark[^>]*>|<\/mark>/g, ""), html, `${tag}: decoration preserves markup/text`);
  }
}
// Search indexes plain_text, which includes an acrostic label even though the
// separate editable baseline omits it. Preserve those search coordinates.
{
  const verseObjects = [
    { type: "quote", tag: "qa", text: "ALEPH" },
    { type: "quote", tag: "q1" },
    { type: "text", text: "good" },
  ];
  assert.equal(extractPlainText({ verseObjects }), "ALEPH good");
  const html = renderHighlightedHTML(verseObjects, new Set());
  assert.ok(overlayFindMarks(html, /good/g, { start: 6, end: 10 }).includes("be-find-active"));
  assert.ok(overlayFindMarks(html, /ALEPH/g, { start: 0, end: 5 }).includes("be-find-active"));
}
console.log("readonly Find: paragraph/poetry active offsets, no phantom cross-block hits, editable parity passed");

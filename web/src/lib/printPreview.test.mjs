// Tests for printPreview.ts — the Door43-shaped HTML render. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/printPreview.test.mjs

import { renderPrintPreviewHtml, buildPrintPreviewDocument } from "./printPreview.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function mkVerse(chapter, verse, verseObjects, extra = {}) {
  return {
    book: "ZEC",
    chapter,
    verse,
    verse_end: null,
    bible_version: "ULT",
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects },
    ...extra,
  };
}
const w = (text) => ({ tag: "w", type: "word", text, occurrence: "1", occurrences: "1" });
const zaln = (...children) => ({ tag: "zaln", type: "milestone", strong: "H1", content: "x", children, endTag: "zaln-e\\*" });
const t = (text) => ({ type: "text", text });
const renderRaw = (verses) => renderPrintPreviewHtml({ book: "ZEC", bibleVersion: "ULT", verses });
// Reading view: the always-emitted Markers-mode labels stripped, as CSS hides them.
const MARKER_RE = /<span class="usfm-marker">[^<]*<\/span>/g;
const render = (verses) => renderRaw(verses).replace(MARKER_RE, "");
const markersOf = (html) => [...html.matchAll(MARKER_RE)].map((m) => m[0].replace(/<[^>]+>/g, ""));

// --- prose chapter: chapter number + inline verse labels, alignment flattened ---
{
  const html = render([
    mkVerse(2, 0, [{ tag: "p", type: "paragraph" }]),
    mkVerse(2, 1, [zaln(w("And"), t(" "), w("I")), t(" saw "), t("{was}"), t(".")]),
    mkVerse(2, 2, [zaln(w("Then")), t(".")]),
  ]);
  assert(
    html.startsWith('<p class="paras_usfm_p"><span class="marks_chapter_label">2</span><span class="marks_verses_label">1</span>And I saw'),
    "chapter number is an inline span at the head of the first paragraph, verse 1 label follows it",
  );
  assert(html.includes('<span class="marks_verses_label">2</span>Then.'), "later verses continue inline in the same paragraph");
  assert(!html.includes("zaln") && !html.includes('"w"'), "alignment structure is flattened to text");
  assert(html.includes('<span class="implied-word-text">was</span>'), "implied-word braces get Door43's span shape");
  assert((html.match(/<p /g) ?? []).length === 1, "one paragraph for one \\p");
}

// --- poetry: leading \q lands the verse number on its own line; q1 → q ---
{
  const html = render([
    // usfm-js attaches the \q that leads verse 5 to the END of verse 4's objects.
    mkVerse(2, 4, [t("saying,"), { tag: "q1", type: "quote" }, t("‘Jerusalem will be inhabited."), { tag: "q1", type: "quote" }]),
    mkVerse(2, 5, [t("And I will be a wall.’”"), { tag: "p", type: "paragraph" }, { tag: "q1", type: "quote" }]),
    mkVerse(2, 6, [t("“Woe!"), { tag: "q2", type: "quote", text: "“" }]),
    mkVerse(2, 7, [t("Escape!”")]),
  ]);
  const paras = html.split("\n");
  assert(paras[0].startsWith('<p class="paras_usfm_p">') && paras[0].includes("saying,</p>"), "text before the marker stays in the prose paragraph");
  assert(paras[1] === '<p class="paras_usfm_q">‘Jerusalem will be inhabited.</p>', "\\q1 renders as paras_usfm_q (Proskomma drops the 1)");
  assert(paras[2].startsWith('<p class="paras_usfm_q"><span class="marks_verses_label">5</span>And I'), "verse 5 label is the first child of its \\q line");
  assert(paras[3] === '<p class="paras_usfm_p"></p>', "an empty \\p between stanzas is kept (it is what makes the blank line)");
  assert(paras[4].startsWith('<p class="paras_usfm_q"><span class="marks_verses_label">6</span>“Woe!'), "verse 6 starts the next stanza's first line");
  assert(paras[5] === '<p class="paras_usfm_q2">“<span class="marks_verses_label">7</span>Escape!”</p>', "opening quote parked on the \\q2 marker is emitted as content, before the next verse's label");
}

// --- headings, \b, chunk dividers, Selah, footnotes, verse ranges ---
{
  const bridge = mkVerse(13, 4, [t("Bridged text.")], { verse_end: 5 });
  const html = render([
    // `\c 13 \p \s1 … \v 1` (ZEC 13 UST): the empty \p must not take the chapter
    // number, and verse 1 must open its own paragraph, not flow into the <h1>.
    mkVerse(13, 0, [
      { tag: "p", type: "paragraph" },
      { tag: "s5", type: "section" },
      { tag: "s1", type: "section", content: "Getting rid of idols\n" },
    ]),
    mkVerse(13, 1, [t("In that day"), { tag: "ts\\*" }, t(" a spring."), { tag: "b", type: "paragraph" }, { tag: "q1", type: "quote" }]),
    mkVerse(13, 2, [t("Praise him. "), { tag: "qs", type: "quote", text: "Selah", endTag: "qs*" }]),
    mkVerse(13, 3, [
      t("A word"),
      { tag: "f", type: "footnote", content: "+ \\ft Some read \\fqa another word\\fqa* here.", endTag: "f*", nextChar: " " },
      t("follows."),
    ]),
    // A component-expanded index hands the same range row over under every
    // verse in its span; it must render once.
    bridge,
    bridge,
  ]);
  const paras = html.split("\n");
  assert(!html.includes("s5") && !html.includes("ts"), "\\s5 and \\ts\\* chunk dividers render nothing in reading view");
  assert(paras[0] === '<p class="paras_usfm_p"></p>', "the empty \\p ahead of the heading stays empty: it must not take the chapter number");
  assert(paras[1] === '<h1 class="paras_usfm_s">Getting rid of idols</h1>', "\\s1 renders as <h1 class=paras_usfm_s> without a verse label");
  assert(paras[2].startsWith('<p class="paras_usfm_p"><span class="marks_chapter_label">13</span><span class="marks_verses_label">1</span>In that day a spring.'), "chapter number skips the heading and lands in the first paragraph with content");
  assert(paras[3] === '<p class="paras_usfm_b"></p>', "\\b is an empty paras_usfm_b block");
  assert(paras[4].includes('Praise him. <span class="wrappers_usfm_qs">Selah</span>'), "\\qs Selah is an inline wrapper span (floated right by CSS), not a line break");
  assert(
    paras[4].includes('A word<span class="paras_usfm_f footnote">Some read <span class="wrappers_usfm_fqa">another word</span> here.</span> follows.'),
    "footnote renders inline with caller dropped, \\fqa quoted text wrapped, and the nextChar space kept before the next word",
  );
  assert(paras[4].includes('<span class="marks_verses_label">4-5</span>Bridged text.') && paras[4].split("Bridged text.").length === 2, "a verse bridge is labelled once as 4-5");
}

// --- markers with no usfm-js `type` (\qm1, \li1) still open their own line ---
{
  const html = render([
    mkVerse(3, 0, [{ tag: "qm1", content: "Margin poem\n" }]),
    mkVerse(3, 1, [t("first"), { tag: "qm2", nextChar: "\n" }]),
    mkVerse(3, 2, [t("second"), { tag: "li1", content: "an item\n" }]),
  ]);
  const paras = html.split("\n");
  assert(paras[0] === '<p class="paras_usfm_qm"><span class="marks_chapter_label">3</span>Margin poem <span class="marks_verses_label">1</span>first</p>', "\\qm1 (no type) opens a line and its own text is verse content");
  assert(paras[1] === '<p class="paras_usfm_qm2"><span class="marks_verses_label">2</span>second</p>', "\\qm2 (no type) opens a line for the next verse");
  assert(paras[2] === '<p class="paras_usfm_li">an item</p>', "\\li1 (no type) opens a list line with its content");
}

// --- Markers mode: every marker survives as a usfm-marker label, in order ---
{
  const raw = renderRaw([
    mkVerse(2, 0, [{ tag: "p", type: "paragraph" }, { tag: "s1", type: "section", content: "Title\n" }]),
    mkVerse(2, 1, [
      t("The "),
      { tag: "nd", text: "Lord", endTag: "nd*", nextChar: " " },
      t("spoke"),
      { tag: "f", type: "footnote", content: "+ \\ft Or \\fqa said\\fqa*", endTag: "f*", nextChar: " " },
      { tag: "ts\\*" },
      { tag: "q1", type: "quote" },
    ]),
    mkVerse(2, 2, [t("and more"), { tag: "s5", type: "section" }]),
  ]);
  assert(
    markersOf(raw).join(" ") === "\\p \\s1 \\p \\c \\v \\nd \\nd* \\f + \\ft \\fqa \\fqa* \\f* \\ts\\* \\q1 \\v \\s5",
    "marker labels appear in document order: block markers, \\c, \\v, wrapper open/close, footnote internals, chunk dividers",
  );
  assert(raw.includes('<span class="marks_chapter_label"><span class="usfm-marker">\\c</span>2</span>'), "\\c label sits inside the chapter number span");
  assert(raw.includes('<span class="wrappers_usfm_nd"><span class="usfm-marker">\\nd</span>Lord<span class="usfm-marker">\\nd*</span></span> spoke'), "wrapper keeps its open/close labels and trailing nextChar space");
  assert(!raw.includes("<script"), "nothing unescaped");
}

// --- hostile stored data cannot break out of attributes/markup ---
{
  const raw = renderRaw([
    mkVerse(4, 1, [
      t('<img src=x onerror="alert(1)">'),
      { tag: 'x" onmouseover="alert(1)', text: "hi", endTag: "x*" },
      { tag: "f", type: "footnote", content: '+ \\ft </span><script>1</script> \\fqa <b>\\fqa*', endTag: "f*" },
    ]),
  ]);
  assert(!raw.includes("<img") && !raw.includes("<script") && !raw.includes("<b>"), "text, wrapper and footnote content are entity-escaped");
  assert(raw.includes('class="wrappers_usfm_x">') && !raw.includes('onmouseover="alert'), "a malformed tag degrades to class x and never reaches an attribute");
}

// --- standalone document ---
{
  const doc = buildPrintPreviewDocument("ZEC 2 · ULT", "<p>x</p>", true);
  assert(doc.includes("<title>ZEC 2 · ULT</title>") && doc.includes(".paras_usfm_q2") && doc.includes('<div class="print-preview show-markers">'), "document embeds title, stylesheet, body and the Markers-mode class");
  assert(buildPrintPreviewDocument("t", "").includes('<div class="print-preview">'), "Markers-mode class is absent by default");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nprintPreview.test.mjs: all assertions passed");

// Tests for printPreview.ts — the Preview-app-shaped HTML render. Run from web/:
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
const render = (verses) => renderPrintPreviewHtml({ book: "ZEC", bibleVersion: "ULT", verses });

// --- prose chapter: drop-cap + inline verse labels, alignment flattened ---
{
  const html = render([
    mkVerse(2, 0, [{ tag: "p", type: "paragraph" }]),
    mkVerse(2, 1, [zaln(w("And"), t(" "), w("I")), t(" saw "), t("{was}"), t(".")]),
    mkVerse(2, 2, [zaln(w("Then")), t(".")]),
  ]);
  assert(
    html.startsWith('<p class="paras_usfm_p"><span class="marks_chapter_label">2</span><span class="marks_verses_label">1</span>And I saw'),
    "chapter number is an inline drop-cap span at the head of the first paragraph, verse 1 label follows it",
  );
  assert(html.includes('<span class="marks_verses_label">2</span>Then.'), "later verses continue inline in the same paragraph");
  assert(!html.includes("zaln") && !html.includes('"w"'), "alignment structure is flattened to text");
  assert(html.includes('<span class="implied-word-text">was</span>'), "implied-word braces get the Preview app's span shape");
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
    // No \p between the heading and \v 1 (as in ZEC 13 UST): verse text must
    // still open its own paragraph rather than flowing into the <h1>.
    mkVerse(13, 0, [
      { tag: "p", type: "paragraph" },
      { tag: "s5", type: "section" },
      { tag: "s1", type: "section", content: "Getting rid of idols\n" },
    ]),
    mkVerse(13, 1, [t("In that day"), { tag: "ts\\*" }, t(" a spring."), { tag: "b", type: "paragraph" }, { tag: "q1", type: "quote" }]),
    mkVerse(13, 2, [t("Praise him. "), { tag: "qs", type: "quote", text: "Selah", endTag: "qs*" }]),
    mkVerse(13, 3, [
      t("A word"),
      { tag: "f", type: "footnote", content: "+ \\ft Some read \\fqa another word\\fqa* here.", endTag: "f*" },
      t(" follows."),
    ]),
    // A component-expanded index hands the same range row over under every
    // verse in its span; it must render once.
    bridge,
    bridge,
  ]);
  const paras = html.split("\n");
  assert(!html.includes("s5") && !html.includes("ts"), "\\s5 and \\ts\\* chunk dividers render nothing");
  assert(paras[0] === '<p class="paras_usfm_p"></p>', "the empty \\p ahead of the heading stays empty: it must not take the chapter number");
  assert(paras[1] === '<h1 class="paras_usfm_s">Getting rid of idols</h1>', "\\s1 renders as <h1 class=paras_usfm_s> without a verse label");
  assert(paras[2].startsWith('<p class="paras_usfm_p"><span class="marks_chapter_label">13</span><span class="marks_verses_label">1</span>In that day a spring.'), "chapter drop-cap skips the heading and lands in the first paragraph with content");
  assert(paras[3] === '<p class="paras_usfm_b"></p>', "\\b is an empty paras_usfm_b block");
  assert(paras[4].includes('Praise him. <span class="wrappers_usfm_qs">Selah</span>'), "\\qs Selah is an inline wrapper span (floated right by CSS), not a line break");
  assert(
    paras[4].includes('A word<span class="paras_usfm_f">Some read <span class="wrappers_usfm_fqa">another word</span> here.</span> follows.'),
    "footnote renders inline with caller dropped and \\fqa quoted text wrapped",
  );
  assert(paras[4].includes('<span class="marks_verses_label">4-5</span>Bridged text.') && paras[4].split("Bridged text.").length === 2, "a verse bridge is labelled once as 4-5");
}

// --- standalone document ---
{
  const doc = buildPrintPreviewDocument("ZEC 2 · ULT", "<p>x</p>");
  assert(doc.includes("<title>ZEC 2 · ULT</title>") && doc.includes(".paras_usfm_q2") && doc.includes('<div class="print-preview">'), "document embeds title, stylesheet and body");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nprintPreview.test.mjs: all assertions passed");

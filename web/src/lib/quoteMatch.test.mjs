// Tests for quoteMatch.ts — quote matching over the print preview's HTML. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/quoteMatch.test.mjs

import { annotateQuotes, quoteSummaryHtml } from "./quoteMatch.ts";
import { renderPrintPreviewHtml } from "./printPreview.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const t = (text) => ({ type: "text", text });
const p = () => ({ tag: "p", type: "paragraph" });
const fn = (content) => ({ tag: "f", type: "footnote", content, endTag: "f*" });
function v(chapter, verse, ...verseObjects) {
  return { book: "EZK", chapter, verse, verse_end: null, bible_version: "ULT", plain_text: null, version: 1, updated_by: null, updated_at: 0, content: { verseObjects } };
}
const render = (verses) => renderPrintPreviewHtml({ book: "EZK", bibleVersion: "ULT", verses });
const msgs = (r) => r.problems.map((x) => `${x.ref.chapter}:${x.ref.verse} ${x.severity} ${x.message}`);

// --- balanced nesting: levels alternate, pairs numbered, no problems ---
{
  const r = annotateQuotes(
    render([v(16, 0, p()), v(16, 1, t("He said, “Say, ‘Thus says Yahweh, “Live!” ’ ")), v(16, 2, t("and then”—the declaration."))]),
    { atBookEnd: true },
  );
  assert(r.problems.length === 0, `balanced chapter has no problems (${msgs(r).join(" | ")})`);
  assert(r.pairs === 3, "three pairs matched");
  assert(r.html.includes('<span class="qm qm-l1" title="Opens quote 1 (level 1); closed at 16:2.">“<sub class="qm-n">1</sub></span>'), "level-1 opener names where it closes");
  assert(r.html.includes('class="qm qm-l3"'), "third level coloured as level 3");
  assert(r.html.includes('Closes quote 1 (level 1), opened at 16:1.'), "closer names its opener");
  assert(!r.html.includes("qm-carry"), "no carry badge when nothing is open at the chapter start");
}

// --- apostrophes are not quotes ---
{
  const r = annotateQuotes(render([v(1, 1, t("“Yahweh’s word, the sisters’ sons,” he said."))]), { atBookEnd: true });
  assert(r.problems.length === 0 && r.pairs === 1, `apostrophes inside and after words are ignored (${msgs(r).join(" | ")})`);
  assert(!r.html.includes('">’'), "apostrophes get no quote span");
}

// --- ’ after a letter closes an open ‘ but is marked uncertain ---
{
  const r = annotateQuotes(render([v(1, 1, t("He said ‘go’ and left."))]), { atBookEnd: true });
  assert(r.pairs === 1, "‘go’ pairs");
  assert(!r.html.includes("qm-warn") && r.html.includes("possessive"), "a letter-final ’ close says on hover it might be a possessive, without a yellow mark");
}

// --- stray close, unclosed at book end ---
{
  const r = annotateQuotes(render([v(2, 1, t("Then he left.” And “she spoke."))]), { atBookEnd: true });
  const m = msgs(r);
  assert(m.some((x) => x.startsWith("2:1 error ” closes nothing")), "stray ” reported with its verse");
  assert(m.some((x) => x.includes("never closed (still open at the end of the book)")), "unclosed “ at book end is an error");
  assert((r.html.match(/qm-bad/g) ?? []).length === 2, "both marks are red");
}

// --- open at the end of a chapter-only render is info, not error ---
{
  const r = annotateQuotes(render([v(3, 1, t("He said, “Go."))]), { atBookEnd: false });
  assert(r.problems.length === 0, "a quote open at the end of a chapter is not an error");
  assert(r.openAtEnd.length === 1 && r.openAtEnd[0].ref.verse === "1", "it is listed as open at the end");
  assert(r.html.includes("qm-open"), "and marked as still open");
}

// --- wrong-order close: ” while ‘ is open closes the “ and reports the ‘; recovery keeps later text clean ---
{
  const r = annotateQuotes(
    render([v(13, 1, t("“Say, ‘Thus says Yahweh.”")), v(13, 2, t("Then “again” he spoke."))]),
    { atBookEnd: true },
  );
  const m = msgs(r);
  assert(m.length === 1 && m[0].startsWith("13:1 error ‘2 is never closed"), `the skipped ‘ is the single error (${m.join(" | ")})`);
  assert(r.openAtEnd.length === 0, "recovery closes the outer “ so nothing leaks into later chapters");
}

// --- same-kind nesting is a warning ---
{
  const r = annotateQuotes(render([v(1, 1, t("“One. “Two.” Three.”"))]), { atBookEnd: true });
  assert(msgs(r).some((x) => x.includes("opens directly inside “1")), "“ inside “ is flagged");
}

// --- carry-in from earlier chapters: badge at the chapter number, closers pair with it ---
{
  const earlier = annotateQuotes(render([v(13, 1, t("He said, “Son of man, say, ‘Thus says Yahweh."))]), { atBookEnd: false });
  assert(earlier.openAtEnd.length === 2, "two quotes still open after chapter 13");
  const r = annotateQuotes(render([v(14, 1, t("Go.’ ”")), v(14, 2, t("Done."))]), { carryIn: earlier.openAtEnd, atBookEnd: false });
  assert(r.problems.length === 0 && r.pairs === 2, `carried-in quotes close cleanly in chapter 14 (${msgs(r).join(" | ")})`);
  assert(r.html.includes('class="qm-carry"') && r.html.includes("Still open from before this chapter: “1 13:1, ‘2 13:1"), "badge after the chapter number lists what carries in");
  assert(r.html.includes("opened at 13:1 (an earlier chapter)"), "closer names the earlier chapter's opener");
  const s = quoteSummaryHtml(r, { carry: { state: "ready", earlierErrors: 0 } });
  assert(s.includes("Open from earlier chapters:</strong> “ 13:1, ‘ 13:1"), "summary lists the carry-in");
}

// --- whole book: badge appears at each chapter a quote spans ---
{
  const r = annotateQuotes(render([v(1, 1, t("“Start.")), v(2, 1, t("Middle.")), v(3, 1, t("End.”"))]), { atBookEnd: true });
  assert((r.html.match(/class="qm-carry"/g) ?? []).length === 2, "chapters 2 and 3 both carry the open quote");
  assert(r.problems.length === 0, "and the book balances");
}

// --- footnotes, headings and markers are skipped; straight quotes reported ---
{
  const r = annotateQuotes(
    render([v(1, 0, { tag: "s1", type: "section", content: "The “title" }), v(1, 1, t("Word"), fn("+ \\ft Or “x "), t(' then "y'))]),
    { atBookEnd: true },
  );
  const m = msgs(r);
  assert(m.length === 1 && m[0].includes("straight"), `only the straight quote is reported (${m.join(" | ")})`);
}

// --- review fixes: paragraph boundary separates words; implied-word braces are see-through ---
{
  const r = annotateQuotes(render([v(1, 1, t("He said, ‘go’"), p(), t("Then he left."))]), { atBookEnd: true });
  assert(r.pairs === 1 && r.problems.length === 0, `’ at a paragraph end closes the quote (${msgs(r).join(" | ")})`);
  const r2 = annotateQuotes(render([v(1, 1, t("“See {the people}’s land,” he said."))]), { atBookEnd: true });
  assert(r2.pairs === 1 && r2.problems.length === 0, `{implied}’s is a possessive (${msgs(r2).join(" | ")})`);
  assert(quoteSummaryHtml(null, { carry: { state: "loading" } }).includes("Checking earlier chapters"), "loading summary renders without a result");
}

// --- problems link to their marks; summary collapses ---
{
  const r = annotateQuotes(render([v(2, 1, t("Then he left.” And “she spoke."))]), { atBookEnd: true });
  assert(r.problems.every((x) => x.target), "every problem in the text has a jump target");
  for (const x of r.problems) assert(r.html.includes(`<span id="${x.target}" class="qm`), `target ${x.target} is a mark in the text`);
  const s = quoteSummaryHtml(r, { carry: { state: "book" } });
  assert(s.startsWith('<details class="qm-summary" open><summary class="qm-head">'), "summary is an open <details> by default");
  assert(s.includes(`data-qm-target="${r.problems[0].target}"`) && s.includes(`href="#${r.problems[0].target}"`), "problem links carry the target");
  // A carried-in quote that a closer exposes points at that closer.
  const c = annotateQuotes(render([v(5, 1, t("Go.” Done."))]), { carryIn: [{ mark: "“", ref: { chapter: 4, verse: "1" } }, { mark: "‘", ref: { chapter: 4, verse: "2" } }] });
  const p0 = c.problems.find((x) => x.message.startsWith("‘2 is never closed"));
  assert(p0 && c.html.includes(`<span id="${p0.target}" class="qm qm-l1"`), "carried-in unclosed quote links to the ” that closed past it");
  const clean = annotateQuotes(render([v(1, 1, t("“Fine.”"))]), { atBookEnd: true });
  assert(!clean.html.includes(" id="), "marks without problems get no id");
}

// --- off means untouched: annotate only changes text marks and badges ---
{
  const html = render([v(1, 1, t("No quotes here."))]);
  assert(annotateQuotes(html).html === html, "text without quote marks is byte-identical");
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall quoteMatch tests passed");

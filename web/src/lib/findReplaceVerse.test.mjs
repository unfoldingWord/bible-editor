// Tests for findReplaceVerse.ts — a find/replace saves curly quotes (#1276).
//
// #1273 made verse text saves curl straight quotes, but find/replace saved its
// result as typed, so a replacement containing ' or " was stored straight. And
// because the 409 / sibling rebase curls both sides of every text op, a
// replace whose only change was ’ → ' was adopted as "no change" on the rebase
// path but saved straight on the normal path: the outcome depended on timing.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/findReplaceVerse.test.mjs

import assert from "node:assert/strict";
import { bibleReplaceSummaryText, finalizeFindReplace, findReplaceVerse, replaceAllInVerse } from "./findReplaceVerse.ts";
import { smartEditVerse, smartReplaceVerse } from "./replace.ts";
import { curlifyVerseContent } from "./curlyVerse.ts";
import { extractEditableText, extractPlainText } from "./usfm.ts";
import { rebaseVersePatch } from "../sync/verseRebase.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const w = (text, occ = "1", occs = "1") => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: "x", children, endTag: "zaln-e\\*",
});

// "word:strong>strong" for every \w in document order ("word:" when unaligned).
function alignedWords(content) {
  const out = [];
  const walk = (nodes, chain) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const next = n.type === "milestone" && n.tag === "zaln" ? [...chain, n.strong] : chain;
      if (n.type === "word" && n.tag === "w") out.push(`${n.text}:${next.join(">")}`);
      if (Array.isArray(n.children)) walk(n.children, next);
    }
  };
  walk(content.verseObjects, []);
  return out;
}
const hasStraightQuote = (content) => /['"]/.test(alignedWords(content).join(" ")) || /['"]/.test(extractEditableText(content));

// ── A replacement with a straight ' is saved curled, alignment kept ─────────
{
  console.log("\n[#1276] find/replace inserting baby's saves baby’s");
  const verse = {
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("child")]), t(" "), zaln("H3", [w("toy")]), t(" "),
      zaln("H4", [w("of")]), t(" "), zaln("H5", [w("Yahweh’s")]), t(" "), zaln("H6", [w("house")]), t("."),
    ],
  };
  const plain = "the child toy of Yahweh’s house.";
  const before = alignedWords(verse);
  const r = findReplaceVerse(verse, plain, /child/g, 4, 5, "baby's");
  check(r.plainText === "the baby’s toy of Yahweh’s house.", `plainText is curled (got ${JSON.stringify(r.plainText)})`);
  check(r.plainText === extractPlainText(r.content), "plainText is the curled tree's plain text");
  check(!hasStraightQuote(r.content), "no straight quote left in the saved tree");
  const after = alignedWords(r.content);
  check(after.length === before.length, "word count unchanged");
  check(
    [0, 2, 3, 4, 5].every((i) => after[i] === before[i]),
    `untouched aligned words keep their alignment (${after.join(" ")})`,
  );
  // The engine unaligns a word whose text it replaced, quotes or not.
  check(after[1] === "baby’s:", `the replaced word is curled (got ${after[1]})`);

  // A word-count-changing replacement (localized rewrite tier) also curls and
  // leaves the untouched words aligned.
  const r2 = findReplaceVerse(verse, plain, /child/g, 4, 5, "little one's");
  check(r2.plainText === "the little one’s toy of Yahweh’s house.", `two-word replacement curled (got ${JSON.stringify(r2.plainText)})`);
  const after2 = alignedWords(r2.content);
  check(
    ["the:H1", "toy:H3", "of:H4", "Yahweh’s:H5", "house:H6"].every((x) => after2.includes(x)),
    `untouched words keep alignment after a word-count change (${after2.join(" ")})`,
  );

  // The rebase path agrees: re-applying the op onto the same server tree
  // yields the same text (no divergence).
  const rb = rebaseVersePatch({ content: r.content, plain_text: r.plainText, alignment_intent: "find_replace" }, verse);
  check(rb.kind === "rebased", "find_replace op rebases");
  check(extractEditableText(rb.patch.content) === extractEditableText(r.content), "rebase path saves the same curled text");
  check(alignedWords(rb.patch.content).join(" ") === after.join(" "), "rebase path keeps the same alignment");

  // Rebased onto a server row another tab re-aligned meanwhile (house now
  // H7) that still stores the aligned word as Yahweh's: the replace lands
  // curled, the server's alignment survives, and the straight-quote word is
  // not read as an edit (it keeps H5).
  const server = {
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("child")]), t(" "), zaln("H3", [w("toy")]), t(" "),
      zaln("H4", [w("of")]), t(" "), zaln("H5", [w("Yahweh's")]), t(" "), zaln("H7", [w("house")]), t("."),
    ],
  };
  const rb2 = rebaseVersePatch({ content: r.content, plain_text: r.plainText, alignment_intent: "find_replace" }, server);
  check(rb2.kind === "rebased", "rebases onto the re-aligned server row");
  check(
    extractEditableText(rb2.patch.content) === "the baby’s toy of Yahweh’s house.",
    `the replace lands, curled (got ${JSON.stringify(extractEditableText(rb2.patch.content))})`,
  );
  check(
    alignedWords(rb2.patch.content).join(" ") === "the:H1 baby’s: toy:H3 of:H4 Yahweh’s:H5 house:H7",
    `server alignment kept on the rebase (${alignedWords(rb2.patch.content).join(" ")})`,
  );
}

// ── A ’ → ' replace is a no-op on both paths ─────────────────────────────────
{
  console.log("\n[#1276] find/replace ’ → ' changes nothing");
  const verse = {
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby’s")]), t(" "), zaln("H3", [w("toy")]), t("."),
    ],
  };
  const plain = "the baby’s toy.";
  const r = findReplaceVerse(verse, plain, /’/g, 8, 1, "'");
  check(r.plainText === plain, `normal path: plainText unchanged, so the overlay queues nothing (got ${JSON.stringify(r.plainText)})`);
  check(JSON.stringify(r.content) === JSON.stringify(verse), "normal path: content unchanged");

  // The caller's stored plain text is handed back as given, so the overlay's
  // `result.plainText === verse.plain_text` check holds even when the stored
  // string is not byte-equal to extractPlainText(content).
  const storedPlain = "the  baby’s toy.";
  const rWs = findReplaceVerse(verse, storedPlain, /’/g, 9, 1, "'");
  check(rWs.plainText === storedPlain, "normal path: the stored plain text is returned as is");

  // Rebase path: an op carrying the raw (uncurled) engine output, as an older
  // build queued it, adopts the server tree, so both paths end at the verse
  // as saved.
  const raw = smartReplaceVerse(verse, plain, /’/g, 8, 1, "'");
  const rb = rebaseVersePatch({ content: raw.content, plain_text: raw.plainText, alignment_intent: "find_replace" }, verse);
  check(rb.kind === "rebased", "rebase path: rebased");
  check(rb.patch.plain_text === r.plainText, "rebase path and normal path agree (no divergence)");
  check(alignedWords(rb.patch.content).join(" ") === alignedWords(verse).join(" "), "rebase path: alignment unchanged");
}

// ── A replace the engine leaves unchanged stays a no-op ─────────────────────
//
// A verse can still hold a legacy straight quote. A replace that changes no
// text (`toy` → `toy`, or a case-insensitive `yahweh` → `Yahweh` on
// `Yahweh`) must not turn into a curl-only save of that quote: that would
// bump the version and claim "replaced 1 verse" (once per verse on replace
// all).
{
  console.log("\n[#1276] an identity replace on a verse with a legacy straight quote changes nothing");
  const verse = {
    verseObjects: [zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby's")]), t(" "), zaln("H3", [w("toy")]), t(".")],
  };
  const plain = "the baby's toy.";
  const r = findReplaceVerse(verse, plain, /toy/gi, 11, 3, "toy");
  check(r.plainText === plain, `plainText unchanged (got ${JSON.stringify(r.plainText)})`);
}

// ── Replace all: a step the curl would undo must not stop later matches ─────
//
// Replace all replaces one match at a time. Curling after each step made a
// step the curl undoes look like "no change", so the loop stopped and later
// real matches in the same verse were skipped (case-insensitive `don’t` →
// `Don't` on "Don’t go and don’t stay." left the second one alone).
{
  console.log("\n[#1276 A1] replace all: a curl-undone first match does not stop the rest");
  const verse = {
    verseObjects: [
      zaln("H1", [w("Don’t")]), t(" "), zaln("H2", [w("go")]), t(" "), zaln("H3", [w("and")]), t(" "),
      zaln("H4", [w("don’t")]), t(" "), zaln("H5", [w("stay")]), t("."),
    ],
  };
  const plain = "Don’t go and don’t stay.";
  const r = replaceAllInVerse(verse, plain, /don’t/gi, 2, "Don't");
  check(r.plainText === "Don’t go and Don’t stay.", `every match replaced, curled (got ${JSON.stringify(r.plainText)})`);
  check(r.plainText === extractPlainText(r.content), "plainText is the saved tree's plain text");
  check(!hasStraightQuote(r.content), "no straight quote left in the saved tree");
  check(
    ["go:H2", "and:H3", "stay:H5"].every((x) => alignedWords(r.content).includes(x)),
    `untouched words keep alignment (${alignedWords(r.content).join(" ")})`,
  );
}

// Finding a straight quote: curling after the first step turned the verse's
// other straight quotes curly, so the next pass found nothing and the
// replace-all count the confirm dialog showed was not honored.
{
  console.log("\n[#1276 A2] replace all of a straight quote replaces every one");
  const verse = { verseObjects: [zaln("H1", [w("a's")]), t(" "), zaln("H2", [w("b's")])] };
  const r = replaceAllInVerse(verse, "a's b's", /'/g, 2, "X");
  check(r.plainText === "aXs bXs", `both matches replaced (got ${JSON.stringify(r.plainText)})`);
}

// Replace all of ’ → ' is still a no-op for the verse as a whole.
{
  console.log("\n[#1276] replace all ’ → ' changes nothing");
  const verse = {
    verseObjects: [zaln("H1", [w("baby’s")]), t(" "), zaln("H2", [w("Yahweh’s")]), t(" "), zaln("H3", [w("toy")])],
  };
  const plain = "baby’s Yahweh’s toy";
  const r = replaceAllInVerse(verse, plain, /’/g, 2, "'");
  check(r.plainText === plain, `plainText unchanged, so nothing is queued (got ${JSON.stringify(r.plainText)})`);
  check(JSON.stringify(r.content) === JSON.stringify(verse), "content unchanged");
}

// ── finalizeFindReplace directly ─────────────────────────────────────────────
{
  console.log("\n[#1276] finalizeFindReplace");
  const verse = { verseObjects: [zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby’s")]), t(" "), zaln("H3", [w("toy")])] };
  const plain = "the baby’s toy";
  const same = { content: verse, plainText: plain, preservedAlignment: true };
  check(finalizeFindReplace(verse, plain, same) === same, "an unchanged result is returned as is");

  const straight = { verseObjects: [zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby's")]), t(" "), zaln("H3", [w("toy")])] };
  const undone = finalizeFindReplace(verse, plain, { content: straight, plainText: "the baby's toy", preservedAlignment: false });
  check(undone.content === verse && undone.plainText === plain, "a change the curl undoes hands back the saved verse and plain text");

  const changed = { verseObjects: [zaln("H1", [w("a")]), t(" "), zaln("H2", [w("baby's")]), t(" "), zaln("H3", [w("toy")])] };
  const out = finalizeFindReplace(verse, plain, { content: changed, plainText: "a baby's toy", preservedAlignment: false });
  check(out.plainText === "a baby’s toy" && extractPlainText(out.content) === out.plainText, "a real change is curled, plain text from the tree");
  check(out.preservedAlignment === false, "the steps' preservedAlignment is kept");
  check(alignedWords(changed)[1] === "baby's:H2", "the engine's tree is not mutated");
}

// ── Quote-free replaces are untouched ────────────────────────────────────────
{
  console.log("\n[#1276] a replace with no quotes is exactly smartReplaceVerse's result");
  const verse = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), zaln("H3", [w("clearly")])] };
  const a = findReplaceVerse(verse, "he sees clearly", /sees/g, 3, 4, "saw");
  const b = smartReplaceVerse(verse, "he sees clearly", /sees/g, 3, 4, "saw");
  check(JSON.stringify(a) === JSON.stringify(b), "same content, plainText and preservedAlignment");
}

// #1305: a line marker with no text node on either side (`H1[name] \q1
// H2[this]`) separates two words only by being a marker. The engine's own
// plainText adds nothing at a marker, so the saved plain_text read
// `my namethis is` (ZEC 10:12 ULT, after removing the dash in `name\q1 —this`).
// The saved plain text must be the tree's, as every other verse save stores.
{
  console.log("\n[#1305] find/replace beside a bare line marker saves the tree's plain text");
  // As the app builds it: a line break typed after `name`, before the dash.
  const unbroken = {
    verseObjects: [
      zaln("H0", [w("my")]), t(" "), zaln("H1", [w("name")]), t("—"), zaln("H2", [w("this")]), t(" "), zaln("H3", [w("is")]), t("."),
    ],
  };
  const typed = extractEditableText(unbroken);
  const dashed = curlifyVerseContent(
    smartEditVerse(unbroken, typed, typed.replace("name", "name\\q1 "), { capturedFromDom: true }).content,
  );
  check(extractEditableText(dashed) === "my name\\q1 —this is.", `setup: line break before the dash (got ${JSON.stringify(extractEditableText(dashed))})`);
  const plain = extractPlainText(dashed);
  check(plain === "my name —this is.", `setup: stored plain text (got ${JSON.stringify(plain)})`);
  const one = findReplaceVerse(dashed, plain, /—/g, plain.indexOf("—"), 1, "");
  const shape = one.content.verseObjects
    .map((n) => (n.tag === "zaln" ? n.strong : n.type === "text" ? JSON.stringify(n.text) : `\\${n.tag}`))
    .join(" ");
  check(shape === 'H0 " " H1 \\q1 H2 " " H3 "."', `setup: no text node either side of the marker (got ${shape})`);
  check(one.plainText === "my name this is.", `replace: plain text keeps the words apart (got ${JSON.stringify(one.plainText)})`);
  check(one.plainText === extractPlainText(one.content), "replace: plain text is the saved tree's");
  const all = replaceAllInVerse(dashed, plain, /—/g, 1, "");
  check(all.plainText === "my name this is.", `replace all: plain text keeps the words apart (got ${JSON.stringify(all.plainText)})`);
  check(all.plainText === extractPlainText(all.content), "replace all: plain text is the saved tree's");
  // The bare-marker verse as now stored: a replace that changes nothing, and
  // a replace all with no match, stay no-ops (the overlay compares plainText
  // with the stored plain text).
  const stored = one.content;
  const storedPlain = extractPlainText(stored);
  const same = findReplaceVerse(stored, storedPlain, /this/g, storedPlain.indexOf("this"), 4, "this");
  check(same.plainText === storedPlain, `same-text replace is a no-op (got ${JSON.stringify(same.plainText)})`);
  const none = replaceAllInVerse(stored, storedPlain, /zzz/g, 1, "x");
  check(none.plainText === storedPlain && none.content === stored, "replace all with no match is a no-op");
  // A row saved before the fix stores the fused text: still a no-op.
  const fused = "my namethis is.";
  const legacy = findReplaceVerse(stored, fused, /this/g, fused.indexOf("this"), 4, "this");
  check(legacy.plainText === fused, `same-text replace on a fused stored row is a no-op (got ${JSON.stringify(legacy.plainText)})`);
  // The stored plain text now has a space the engine's own text lacks: a
  // match after the marker must still land on the right characters.
  const after = findReplaceVerse(stored, storedPlain, /this/g, storedPlain.indexOf("this"), 4, "that");
  check(after.plainText === "my name that is.", `replace after the marker (got ${JSON.stringify(after.plainText)})`);
  // Alignment as the same replace leaves it in a verse with no marker (the
  // replaced word itself is new, so it is unaligned there too).
  const flat = {
    verseObjects: [zaln("H0", [w("my")]), t(" "), zaln("H1", [w("name")]), t(" "), zaln("H2", [w("this")]), t(" "), zaln("H3", [w("is")]), t(".")],
  };
  const flatPlain = extractPlainText(flat);
  const flatAfter = alignedWords(findReplaceVerse(flat, flatPlain, /this/g, flatPlain.indexOf("this"), 4, "that").content).join(" ");
  check(
    alignedWords(after.content).join(" ") === flatAfter,
    `replace after the marker: alignment as without the marker, ${flatAfter} (got ${alignedWords(after.content).join(" ")})`,
  );
  const twice = replaceAllInVerse(stored, storedPlain, /is/g, 2, "as");
  check(twice.plainText === "my name thas as.", `replace all, two matches after the marker (got ${JSON.stringify(twice.plainText)})`);
  const flatTwice = alignedWords(replaceAllInVerse(flat, flatPlain, /is/g, 2, "as").content).join(" ");
  check(
    alignedWords(twice.content).join(" ") === flatTwice,
    `replace all: alignment as without the marker, ${flatTwice} (got ${alignedWords(twice.content).join(" ")})`,
  );
}

// #1311 (item 4): a same-text replace on a bare-marker verse (`H1[name] \q1
// H2[this]`) that also holds a legacy straight quote elsewhere. The engine's
// own plainText reads `namethis`, so the first no-op check missed it, the curl
// rewrote the unrelated `'Go'`, and a save nobody asked for was queued.
{
  console.log("\n[#1311] same-text replace beside a bare line marker does not curl an unrelated quote");
  const verse = {
    verseObjects: [
      zaln("H0", [w("my")]), t(" "), zaln("H1", [w("name")]), { type: "quote", tag: "q1" }, zaln("H2", [w("this")]), t(" "), zaln("H3", [w("set")]), t(". 'Go'"),
    ],
  };
  const plain = extractPlainText(verse);
  check(plain === "my name this set. 'Go'", `setup: stored plain text (got ${JSON.stringify(plain)})`);
  const same = findReplaceVerse(verse, plain, /this/g, plain.indexOf("this"), 4, "this");
  check(same.plainText === plain, `this -> this: no save queued (got ${JSON.stringify(same.plainText)})`);
  check(same.content === verse, "this -> this: the verse is handed back unchanged");
  // Replace all already skips a step with no visible change; pin it.
  const all = replaceAllInVerse(verse, plain, /this/g, 1, "this");
  check(all.plainText === plain && all.content === verse, `replace all this -> this: no save queued (got ${JSON.stringify(all.plainText)})`);
}

// #1285: the summary counts only verses queued for save. A verse the save's
// alignment guard refused is reported as not replaced, never as "replaced".
{
  const s = (versesReplaced, alignmentLost, readOnlySkipped, alignmentRefused) =>
    bibleReplaceSummaryText({ versesReplaced, alignmentLost, readOnlySkipped, alignmentRefused });
  check(s(1, 0, 0, 0) === "replaced 1 verse", "a saved replace: replaced 1 verse");
  check(s(3, 1, 0, 0) === "replaced 3 verses — alignment milestones destroyed in 1", "unchanged wording for alignment loss");
  check(
    s(0, 0, 0, 1) === "1 verse not replaced: it would lose word alignment",
    "a refused single replace leads with the refusal, no \"replaced 0 verses\"",
  );
  check(
    s(1, 0, 0, 2) === "replaced 1 verse — 2 verses not replaced: they would lose word alignment",
    "replace-all with refusals: counts saved and refused verses separately",
  );
  check(
    s(0, 0, 2, 1) === "1 verse not replaced: it would lose word alignment — 2 matches in UHB/UGNT skipped (read-only)",
    "refusal plus read-only skips",
  );
  check(s(0, 0, 1, 0) === "replaced 0 verses — 1 match in UHB/UGNT skipped (read-only)", "unchanged wording for read-only skips");
  // A verse whose stored text is out of date beside a header label (#1339).
  const stale = (versesReplaced, staleRefused) =>
    bibleReplaceSummaryText({ versesReplaced, alignmentLost: 0, readOnlySkipped: 0, alignmentRefused: 0, staleRefused });
  check(
    stale(0, 1) === "1 verse not replaced: its saved search text is out of date",
    "a stale-text refusal leads with the refusal, no \"replaced 0 verses\"",
  );
  check(
    stale(2, 3) === "replaced 2 verses — 3 verses not replaced: their saved search text is out of date",
    "replace-all with stale-text refusals: counts both",
  );
}

// A `\sp` label written as words (#1350). A replace across one goes through,
// the label staying before its line marker. When the engine refuses a verse
// (here: the label is followed by a footnote, not a line marker, so it has no
// anchor), single replace and replace-all report the refused matches (the
// overlay shows the count) instead of skipping them silently.
{
  const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
  const t = (text) => ({ type: "text", text });
  const label = { tag: "sp", nextChar: " ", children: [w("The"), t(" "), w("man"), t("\n")], endTag: "" };
  const verse = { verseObjects: [w("A"), t(" "), w("home"), t(".\n"), label, { tag: "q1", type: "quote" }, w("He"), t(" "), w("ran"), t(" "), w("home"), t(".")] };
  const plain = extractPlainText(verse);
  check(plain === "A home. He ran home.", `setup: plain text skips the label (got ${JSON.stringify(plain)})`);
  const across = findReplaceVerse(verse, plain, /home\. He/g, plain.indexOf("home. He"), 8, "home. She");
  const vos = across.content.verseObjects;
  const li = vos.findIndex((n) => n.tag === "sp");
  check(across.labelRefusals === undefined && across.plainText === "A home. She ran home." && vos[li + 1]?.tag === "q1",
    `replace across the label: replaced, label still before its \\q1 (got ${JSON.stringify(across.plainText)})`);
  // "home. He" -> "home and he": before #1360 the engine saved "he" before the
  // line break, so in front of the label too, and this was refused. The
  // recased word now stays after the break, so the replace saves with the
  // label still between "and" and "\q1 he".
  const bareVerse = { verseObjects: [t("“"), w("home"), label, { tag: "q1", type: "quote" }, w("He"), t(" "), w("ran"), t(" "), w("home"), t(".")] };
  const barePlain = extractPlainText(bareVerse);
  {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const kept = findReplaceVerse(verse, plain, /home\. He/g, plain.indexOf("home. He"), 8, "home and he");
      const kvos = kept.content.verseObjects;
      const ki = kvos.findIndex((n) => n.tag === "sp");
      check(kept.labelRefusals === undefined && kept.plainText === "A home and he ran home." && kvos[ki + 1]?.tag === "q1" && kvos[ki + 2]?.text === "he",
        `a recase after the label's line break: saved, "he" still after the label (got ${JSON.stringify(kept.plainText)})`);
      // A line marker with no text beside it (`“home \sp … \q1 He`):
      // deleting the word before it moves the kept `He` before the break
      // (replace.test.mjs Case 91 pins that for `“name\q1 this`), which would
      // put it in front of the label. Refused and counted (review round 4 of
      // #1350, item 1). A recase there (`home He` -> `home; he`) stays after
      // the break since #1361, so it no longer serves here.
      check(barePlain === "“home He ran home.", `setup: bare-marker label verse (got ${JSON.stringify(barePlain)})`);
      const moved = findReplaceVerse(bareVerse, barePlain, /home He/g, barePlain.indexOf("home He"), 7, "He");
      check(moved.labelRefusals === 1 && moved.plainText === barePlain, `a replace that moves a word across the label: refused (got ${JSON.stringify(moved.plainText)})`);
    } finally {
      console.warn = warn;
    }
  }

  const footnote = { tag: "f", type: "footnote", content: "+ \\ft a note", endTag: "f*" };
  const odd = { verseObjects: [w("A"), t(" "), w("home"), t(".\n"), label, footnote, { tag: "q1", type: "quote" }, w("He"), t(" "), w("ran"), t(" "), w("home"), t(".")] };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const one = findReplaceVerse(odd, plain, /ran/g, plain.indexOf("ran"), 3, "went");
    check(one.labelRefusals === 1 && one.plainText === plain && one.content === odd, `single replace in a verse whose label can't be anchored: refused, counted, verse untouched (got ${one.labelRefusals})`);
    const all = replaceAllInVerse(odd, plain, /home/g, 2, "house");
    check(all.labelRefusals === 2 && all.plainText === plain, `replace-all there: both matches counted once, nothing replaced (got ${all.labelRefusals})`);
    const clean = replaceAllInVerse(verse, plain, /ran/g, 1, "went");
    check(clean.labelRefusals === undefined && clean.plainText === "A home. He went home.", "no refusal: no count");
    // A replacement that matches the pattern again ("ran" -> "and he ran")
    // ends the loop at its cap right after an applied step, before the pass
    // meets the refused "home. He" again: that refusal must still be counted
    // (review round 4 of #1350).
    const re = /home He|ran/g;
    const rematch = replaceAllInVerse(bareVerse, barePlain, re, 2, "He ran");
    check(rematch.labelRefusals === 1, `replace-all whose replacement re-matches: the refused match is still counted (got ${rematch.labelRefusals})`);
  } finally {
    console.warn = warn;
  }
  const lbl = (versesReplaced, labelRefused) =>
    bibleReplaceSummaryText({ versesReplaced, alignmentLost: 0, readOnlySkipped: 0, alignmentRefused: 0, labelRefused });
  check(lbl(0, 1) === "1 match not replaced: it would move a speaker label", `a label refusal leads with the refusal (got ${lbl(0, 1)})`);
  check(lbl(2, 3) === "replaced 2 verses — 3 matches not replaced: they would move a speaker label", `replace-all with label refusals counts both (got ${lbl(2, 3)})`);

  // #1354 item 5a: a refusal because the label has no line break after it
  // (label-shape) says that, not "would move a speaker label".
  {
    const warn2 = console.warn;
    console.warn = () => {};
    try {
      const one = findReplaceVerse(odd, plain, /ran/g, plain.indexOf("ran"), 3, "went");
      check(one.labelShapeRefusals === 1, `single replace in a label-shape verse: counted as a shape refusal (got ${one.labelShapeRefusals})`);
      const all = replaceAllInVerse(odd, plain, /home/g, 2, "house");
      check(all.labelShapeRefusals === 2, `replace-all in a label-shape verse: both counted as shape refusals (got ${all.labelShapeRefusals})`);
      const moved = findReplaceVerse(verse, plain, /home\. He/g, plain.indexOf("home. He"), 8, "home and he");
      check(moved.labelShapeRefusals === undefined, `a label-moved refusal is not a shape refusal (got ${moved.labelShapeRefusals})`);
    } finally {
      console.warn = warn2;
    }
    const shape = (versesReplaced, labelRefused, labelShapeRefused) =>
      bibleReplaceSummaryText({ versesReplaced, alignmentLost: 0, readOnlySkipped: 0, alignmentRefused: 0, labelRefused, labelShapeRefused });
    check(shape(0, 1, 1) === "1 match not replaced: its verse has a speaker label with no line break after it",
      `a shape refusal gives its own reason (got ${shape(0, 1, 1)})`);
    check(shape(1, 3, 2) === "replaced 1 verse — 1 match not replaced: it would move a speaker label — 2 matches not replaced: their verse has a speaker label with no line break after it",
      `both kinds of refusal, each with its reason (got ${shape(1, 3, 2)})`);
  }
}

// #1366 item 1: a match refused because it would drop or change a `\sp` label
// (label-lost) is counted on its own and the summary gives that reason, not
// "would move a speaker label". The verse: a plain-text label with body text
// (not a line marker) after it, which the engine still sees; replacing across
// it would drop it.
{
  console.log("\n[#1366 item 1] A label-lost refusal gets its own count and summary line");
  const lost = { verseObjects: [t("A home. "), { tag: "sp", text: "The man\n" }, t("He ran.")] };
  const plain = extractPlainText(lost);
  check(plain === "A home. He ran.", `setup: plain text skips the label (got ${JSON.stringify(plain)})`);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const one = findReplaceVerse(lost, plain, /home\. He/g, plain.indexOf("home. He"), 8, "home; he");
    check(one.labelRefusals === 1 && one.labelLostRefusals === 1 && one.labelShapeRefusals === undefined && one.plainText === plain,
      `single replace that would drop the label: refused, counted as label-lost (got lost=${one.labelLostRefusals}, all=${one.labelRefusals})`);
    const all = replaceAllInVerse(lost, plain, /home\. He/g, 1, "home; he");
    check(all.labelRefusals === 1 && all.labelLostRefusals === 1 && all.plainText === plain,
      `replace-all: the same refusal counted as label-lost (got lost=${all.labelLostRefusals})`);
  } finally {
    console.warn = warn;
  }
  const sum = (versesReplaced, labelRefused, labelShapeRefused, labelLostRefused) =>
    bibleReplaceSummaryText({ versesReplaced, alignmentLost: 0, readOnlySkipped: 0, alignmentRefused: 0, labelRefused, labelShapeRefused, labelLostRefused });
  check(sum(0, 1, 0, 1) === "1 match not replaced: it would remove or change a speaker label", `a label-lost refusal gives its own reason (got ${sum(0, 1, 0, 1)})`);
  check(sum(1, 4, 1, 2) === "replaced 1 verse — 1 match not replaced: it would move a speaker label — 1 match not replaced: its verse has a speaker label with no line break after it — 2 matches not replaced: they would remove or change a speaker label",
    `all three kinds of label refusal, each with its reason (got ${sum(1, 4, 1, 2)})`);
}

// #1366 item 7 (the issue's comment): `home He` -> `home; she too` beside a
// word label whose line marker has no text beside it. The new words replace
// `He`, the first word of the speech, but the engine anchored them to the kept
// `home` and saved them before the label and its line break. They now go after
// the label (`home; \sp … \q1 she too ran`), and the words the replace did not
// touch keep their alignment.
{
  console.log("\n[#1366 item 7] New words replacing the first word after a label's line break go after the label");
  const label = () => ({ tag: "sp", nextChar: " ", children: [w("The"), t(" "), w("man"), t("\n")], endTag: "" });
  const q1 = () => ({ tag: "q1", type: "quote" });
  const words = (content) => {
    const out = [];
    for (const n of content.verseObjects) {
      if (n.tag === "sp") out.push("[SP]");
      else if (n.tag === "q1") out.push("\\q1");
      else for (const x of extractPlainText({ verseObjects: [n] }).split(/\s+/).filter(Boolean)) out.push(x);
    }
    return out.join(" ");
  };
  const run = (content, find, replacement) => {
    const plain = extractPlainText(content);
    const at = plain.indexOf(find);
    check(at >= 0, `setup: ${JSON.stringify(plain)} contains ${JSON.stringify(find)}`);
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    return findReplaceVerse(JSON.parse(JSON.stringify(content)), plain, re, at, find.length, replacement);
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    // The issue's tree: unaligned words, a bare marker.
    const bare = { verseObjects: [w("A"), t(" "), w("home"), label(), q1(), w("He"), t(" "), w("ran"), t(" "), w("home"), t(".")] };
    const r1 = run(bare, "home He", "home; she too");
    check(r1.labelRefusals === undefined && words(r1.content) === "A home; [SP] \\q1 she too ran home.",
      `bare marker: "she too" saved after the label (got ${JSON.stringify(words(r1.content))}, refused=${r1.labelRefusals})`);
    // Text beside the marker (`home.⏎ \sp … \q1 He`): the same move.
    const beside = { verseObjects: [w("A"), t(" "), w("home"), t(".\n"), label(), q1(), w("He"), t(" "), w("ran"), t(" "), w("home"), t(".")] };
    const r2 = run(beside, "home. He", "home; she too");
    check(r2.labelRefusals === undefined && words(r2.content) === "A home; [SP] \\q1 she too ran home.",
      `text beside the marker: "she too" saved after the label (got ${JSON.stringify(words(r2.content))})`);
    // Aligned words: only the replaced "He" loses its alignment.
    const aligned = {
      verseObjects: [zaln("H1", [w("A")]), t(" "), zaln("H2", [w("home")]), label(), q1(), zaln("H3", [w("He")]), t(" "), zaln("H4", [w("ran")]), t(" "), zaln("H5", [w("home")]), t(".")],
    };
    const r3 = run(aligned, "home He", "home; she too");
    check(r3.labelRefusals === undefined && words(r3.content) === "A home; [SP] \\q1 she too ran home.",
      `aligned: "she too" saved after the label (got ${JSON.stringify(words(r3.content))})`);
    check(JSON.stringify(alignedWords(r3.content).filter((x) => !x.endsWith(":"))) === JSON.stringify(["A:H1", "home:H2", "The:", "man:", "ran:H4", "home:H5"].filter((x) => !x.endsWith(":"))),
      `aligned: every untouched word keeps its alignment (got ${JSON.stringify(alignedWords(r3.content))})`);
    // Old words on both sides of the line break replaced by words the engine
    // put all before it: which of them starts the speech can't be told, so
    // the replace is refused rather than guessed.
    const both = { verseObjects: [w("A"), t(" "), w("home"), t(" "), w("now"), label(), q1(), w("He"), t(" "), w("ran"), t(" "), w("home"), t(".")] };
    const r4 = run(both, "now He", "then she too");
    const kept4 = words(r4.content);
    check(r4.labelRefusals === 1 || /\[SP\] \\q1 (she|then)/.test(kept4) && !/she.*\[SP\]/.test(kept4),
      `old words on both sides of the break: refused, or no word of the speech before the label (got ${JSON.stringify(kept4)}, refused=${r4.labelRefusals})`);
    // A plain deletion of the speech's first word still saves as before.
    const r5 = run(bare, "home He", "home");
    check(r5.labelRefusals === undefined && words(r5.content) === "A home [SP] \\q1 ran home.", `deleting "He": saved, label in place (got ${JSON.stringify(words(r5.content))})`);
  } finally {
    console.warn = warn;
  }
}

console.log(`\nfindReplaceVerse: all ${passed} checks passed.`);

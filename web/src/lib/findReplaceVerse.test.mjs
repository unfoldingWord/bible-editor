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
import { findReplaceVerse } from "./findReplaceVerse.ts";
import { smartReplaceVerse } from "./replace.ts";
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

// ── Quote-free replaces are untouched ────────────────────────────────────────
{
  console.log("\n[#1276] a replace with no quotes is exactly smartReplaceVerse's result");
  const verse = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), zaln("H3", [w("clearly")])] };
  const a = findReplaceVerse(verse, "he sees clearly", /sees/g, 3, 4, "saw");
  const b = smartReplaceVerse(verse, "he sees clearly", /sees/g, 3, 4, "saw");
  check(JSON.stringify(a) === JSON.stringify(b), "same content, plainText and preservedAlignment");
}

console.log(`\nfindReplaceVerse: all ${passed} checks passed.`);

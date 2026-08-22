// Tests for web/src/sync/verseRebase.ts — rebasing a verse PATCH op onto a
// newer server row before re-arming it (issue #564).
//
// The defect: outbox.resolveConflict and threadVersionToSiblings re-armed a
// verse op by bumping expectedVersion and re-sending the op's content
// VERBATIM. That content was diffed from a baseline older than the server
// row, so a genuinely concurrent save produced one of two bad outcomes:
//   - stale content DROPS alignments the server row has → the server's
//     guardBlocksSave refuses and the translator can only discard the edit;
//   - stale content CARRIES alignments/text the server moved past → 200,
//     silently reverting the other party's work.
//
// rebaseVersePatch re-applies the op's TEXT INTENT onto the server's current
// tree via smartEditVerse instead. These tests pin both directions from the
// issue: (a) the rebase preserves the server's concurrent alignments while
// applying the text edit, and (b) content that genuinely drops server
// alignments is still refused truthfully — the guard predicate fires on it
// (the server-side backstop is unchanged; when the rebase falls back to
// verbatim, that refusal is exactly what the translator sees).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/verseRebase.test.mjs

import assert from "node:assert/strict";
import { rebaseVersePatch } from "./verseRebase.ts";
import { analyzeAlignmentDelta, guardBlocksSave } from "../lib/alignmentDelta.ts";
import { extractEditableText } from "../lib/usfm.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// Fixture helpers — same shapes as lib/replace.test.mjs.
const w = (text, occ = "1", occs = "1") => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: "x", children, endTag: "zaln-e\\*",
});

// [word text, zaln source chain (strongs, ">"-joined) or null] in document order.
function wordSources(content) {
  const out = [];
  const walk = (nodes, chain) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const isZ = n.type === "milestone" && n.tag === "zaln";
      const next = isZ ? [...chain, n.strong] : chain;
      if (n.type === "word" && n.tag === "w") out.push([n.text, next.join(">") || null]);
      if (Array.isArray(n.children)) walk(n.children, next);
    }
  };
  walk(content?.verseObjects ?? content, []);
  return out;
}
const sourceOf = (content, word) => (wordSources(content).find(([tx]) => tx === word) ?? [])[1] ?? null;

// ── Direction (a): rebase preserves the server's concurrent alignments ──────
//
// Timeline: op's baseline had "clearly" UNALIGNED; the user edited sees→saw.
// Concurrently another party aligned "clearly" (H3) on the server. Verbatim
// re-send would drop H3 → refused (`unexpected_alignment_loss`); the rebase
// applies the text edit onto the server tree so "clearly" keeps H3.
{
  console.log("\n[a] Rebase applies the text edit while keeping the server's concurrent alignment");
  const server = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), zaln("H3", [w("clearly")])] };
  const stale = { verseObjects: [zaln("H1", [w("he")]), t(" "), w("saw"), t(" "), w("clearly")] };

  // Pre-fix repro: the verbatim content is exactly what the server guard
  // refuses — this is also direction (b)'s truth-check: whenever the rebase
  // has to fall back to verbatim, alignment-dropping content is still refused.
  const verbatimDelta = analyzeAlignmentDelta(server, stale);
  check(
    guardBlocksSave(verbatimDelta, "text_edit") === true,
    "verbatim stale content drops the server's H3 → guard refuses (the pre-#564 dead end / the truthful refusal when rebase falls back)",
  );
  check(
    verbatimDelta.unexpectedLosses.some((l) => l.text === "clearly"),
    "the verbatim refusal names the collaterally-dropped word",
  );

  const out = rebaseVersePatch({ content: stale, plain_text: "he saw clearly", alignment_intent: "text_edit" }, server);
  check(out.kind === "rebased", "text_edit op rebases");
  check(extractEditableText(out.patch.content) === "he saw clearly", "the op's text edit (sees→saw) is applied");
  check(sourceOf(out.patch.content, "clearly") === "H3", "the server's concurrent alignment on 'clearly' survives");
  check(sourceOf(out.patch.content, "he") === "H1", "untouched 'he' keeps its alignment");
  check(out.patch.plain_text === "he saw clearly", "plain_text is recomputed from the rebased tree");
  check(
    guardBlocksSave(analyzeAlignmentDelta(server, out.patch.content), "text_edit") === false,
    "the rebased content passes the server guard (previously-refused save now lands)",
  );
}

// ── Direction (b), quiet twin: stale content must not RESURRECT alignments
// (or text) the server row moved past ──────────────────────────────────────
//
// Timeline: op's baseline had "he" aligned (H1); the server has since
// unaligned it. The op's text edit is clearly→plainly. Verbatim re-send
// would 200 and silently re-add H1, reverting the other party's work; the
// rebase starts from the server tree, so "he" stays bare.
{
  console.log("\n[b] Rebase does not resurrect alignments the server dropped");
  const server = { verseObjects: [w("he"), t(" "), zaln("H2", [w("sees")]), t(" "), w("clearly")] };
  const stale = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), w("plainly")] };
  const out = rebaseVersePatch({ content: stale, alignment_intent: "text_edit" }, server);
  check(out.kind === "rebased", "text_edit op rebases");
  check(extractEditableText(out.patch.content) === "he sees plainly", "the op's text edit (clearly→plainly) is applied");
  check(sourceOf(out.patch.content, "he") === null, "'he' stays unaligned — the server's removal is respected");
  check(sourceOf(out.patch.content, "sees") === "H2", "'sees' keeps the alignment both sides agree on");
}

// ── Text already identical: the op adopts the server tree wholesale ────────
//
// The purest quiet-twin fix: with no text delta left to apply, the rebased
// content IS the server's — a stale resend can no longer revert the server's
// alignment state under a clean If-Match.
{
  console.log("\n[c] Same text → rebase adopts the server's tree (no stale-alignment resend)");
  const server = { verseObjects: [w("he"), t(" "), zaln("H2", [w("sees")]), t(" "), w("plainly")] };
  const stale = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), w("plainly")] };
  const out = rebaseVersePatch({ content: stale, alignment_intent: "text_edit" }, server);
  check(out.kind === "rebased", "same-text op still rebases");
  check(
    JSON.stringify(wordSources(out.patch.content)) === JSON.stringify(wordSources(server)),
    "rebased word alignments equal the server's exactly",
  );
}

// ── alignment_edit ops: structure is the intent, so no text-space rebase ───
{
  console.log("\n[d] alignment_edit: verbatim on same text, refuse_thread across a text change");
  const opContent = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), w("plainly")] };
  const serverSameText = { verseObjects: [w("he"), t(" "), w("sees"), t(" "), w("plainly")] };
  const serverNewText = { verseObjects: [w("he"), t(" "), w("saw"), t(" "), w("plainly")] };
  check(
    rebaseVersePatch({ content: opContent, alignment_intent: "alignment_edit" }, serverSameText).kind === "verbatim",
    "text unchanged → the alignment work re-sends verbatim (last-write-wins on alignment)",
  );
  check(
    rebaseVersePatch({ content: opContent, alignment_intent: "alignment_edit" }, serverNewText).kind === "refuse_thread",
    "text changed → refuse to auto-thread (a verbatim resend would silently revert the text, guard-exempt)",
  );
}

// ── confirmed_text_edit: rebases like text_edit, keeps its own intent ──────
//
// Issue #575: the escalated "Save anyway" flow (Shell.tsx's pendingAlignmentLoss
// confirm) re-enqueues a text edit with alignment_intent "confirmed_text_edit"
// rather than "alignment_edit" — its intent is the TEXT, not an alignment
// structure. rebaseVersePatch has no special-case branch for it, so it falls
// through to the same text-space rebase as text_edit (unlike alignment_edit,
// which is intentionally NOT rebased in text space — see [d] above). The
// rebased patch must also keep the guard-exempt intent, so a still-colliding
// rebase lands as the user already confirmed rather than tripping the guard
// again on the server.
{
  console.log("\n[d2] confirmed_text_edit rebases like text_edit and preserves its intent");
  const server = { verseObjects: [zaln("H1", [w("he")]), t(" "), zaln("H2", [w("sees")]), t(" "), zaln("H3", [w("clearly")])] };
  const stale = { verseObjects: [zaln("H1", [w("he")]), t(" "), w("saw"), t(" "), w("clearly")] };
  const out = rebaseVersePatch(
    { content: stale, plain_text: "he saw clearly", alignment_intent: "confirmed_text_edit" },
    server,
  );
  check(out.kind === "rebased", "confirmed_text_edit op rebases (not refuse_thread/verbatim like alignment_edit)");
  check(extractEditableText(out.patch.content) === "he saw clearly", "the op's text edit (sees→saw) is applied");
  check(sourceOf(out.patch.content, "clearly") === "H3", "the server's concurrent alignment on 'clearly' survives");
  check(
    out.patch.alignment_intent === "confirmed_text_edit",
    "the rebased patch keeps the confirmed_text_edit intent (guard-exempt if it still collides)",
  );
}

// ── Hebrew: combining-mark order is not a text change ──────────────────────
//
// UHB stores consonant-DAGESH-vowel; NFC canonical order puts the vowel
// first. Same text to a translator — the alignment_edit gate must compare
// via nfc() or every UHB-order verse would spuriously refuse_thread.
{
  console.log("\n[e] Hebrew combining-mark order compares equal via nfc()");
  const legacy = String.fromCharCode(0x05d1, 0x05bc, 0x05b4); // bet, dagesh, hiriq (UHB order)
  const canon = legacy.normalize("NFC"); // bet, hiriq, dagesh
  assert.notEqual(legacy, canon, "fixture sanity: the raw byte orders differ");
  const server = { verseObjects: [zaln("H1", [w(canon)])] };
  const stale = { verseObjects: [zaln("H1", [w(legacy)])] };
  check(
    extractEditableText(server) !== extractEditableText(stale),
    "raw editable texts differ (byte order)",
  );
  check(
    rebaseVersePatch({ content: stale, alignment_intent: "alignment_edit" }, server).kind === "verbatim",
    "alignment_edit across a pure mark-order difference is NOT treated as a text change",
  );
}

// ── Hebrew, text path: mark-order-only difference must not run the engine ──
//
// smartEditVerse's own no-op branch compares RAW strings, so a UHB-order op
// against an NFC-order server row would look like a real edit to it. The
// rebase's nfc gate short-circuits first, adopting the server tree wholesale
// — no phantom diff, no mark churn on untouched words.
{
  console.log("\n[e2] text_edit across a pure mark-order difference adopts the server tree");
  const legacy = String.fromCharCode(0x05d1, 0x05bc, 0x05b4); // bet, dagesh, hiriq (UHB order)
  const canon = legacy.normalize("NFC"); // bet, hiriq, dagesh
  const server = { verseObjects: [zaln("H1", [w(canon)])] };
  const stale = { verseObjects: [w(legacy)] }; // stale baseline had it unaligned too
  const out = rebaseVersePatch({ content: stale, alignment_intent: "text_edit" }, server);
  check(out.kind === "rebased", "text_edit op with nfc-equal text still rebases");
  check(
    JSON.stringify(out.patch.content) === JSON.stringify(server),
    "the server tree is adopted byte-for-byte (alignment and mark order both the server's)",
  );
}

// ── Conservative fall-throughs ──────────────────────────────────────────────
{
  console.log("\n[f] Non-rebasable shapes fall back to verbatim");
  const content = { verseObjects: [zaln("H1", [w("he")])] };
  check(
    rebaseVersePatch({ content, alignment_intent: "section_edit" }, content).kind === "verbatim",
    "section_edit stays verbatim (\\s edits are invisible to the text-space rebase)",
  );
  check(
    rebaseVersePatch({ plain_text: "x" }, content).kind === "verbatim",
    "a patch without content has nothing to rebase",
  );
  check(
    rebaseVersePatch({ content }, undefined).kind === "verbatim",
    "no server content → verbatim (pre-#564 behavior; the server guard remains the backstop)",
  );
}

// ── Engine robustness under rebase: multi-region edits + reassembly-
// disqualifying shapes still keep untouched alignments ──────────────────────
//
// Two separated word edits with a split-unit word ("Yahweh"+"’s" under one
// milestone) present — the shape that disqualifies the occurrence-keyed
// reassembly tier (ZEC 9:1 class). The remaining tiers must still keep the
// untouched middle word aligned; if the engine ever regresses to flattening
// here, the rebased save would start tripping the guard — truthfully, but
// this pins that today it does not have to.
{
  console.log("\n[g] Split-unit + two separated edits: untouched word keeps the server's alignment");
  const server = {
    verseObjects: [
      zaln("H0", [w("Yahweh"), t("’s")]), t(" "),
      zaln("H2", [w("word")]), t(" "),
      zaln("H3", [w("came")]), t(" "),
      zaln("H4", [w("here")]),
    ],
  };
  const stale = {
    verseObjects: [
      zaln("H0", [w("Yahweh"), t("’s")]), t(" "),
      w("speech"), t(" "), w("came"), t(" "), w("there"),
    ],
  };
  const out = rebaseVersePatch({ content: stale, alignment_intent: "text_edit" }, server);
  check(out.kind === "rebased", "rebases despite the reassembly-disqualifying split-unit word");
  check(extractEditableText(out.patch.content) === "Yahweh’s speech came there", "both separated edits applied");
  check(sourceOf(out.patch.content, "came") === "H3", "untouched 'came' keeps its server alignment");
  check(
    guardBlocksSave(analyzeAlignmentDelta(server, out.patch.content), "text_edit") === false,
    "the rebased content passes the guard",
  );
}

console.log(`\nverseRebase: all ${passed} checks passed.`);

import { analyzeAlignmentDelta, guardBlocksSave } from "./alignmentDelta.ts";

let failed = 0;
function assert(ok, msg) {
  if (!ok) {
    failed++;
    console.error("FAIL:", msg);
  }
}

const w = (text) => ({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  type: "milestone",
  tag: "zaln",
  strong,
  occurrence: "1",
  occurrences: "1",
  content: strong,
  children,
});
const content = (verseObjects) => ({ verseObjects });

{
  console.log("[alignmentDelta api] punctuation save cannot drop unchanged alignment");
  const before = content([zaln("H1", [w("He")]), t(" "), zaln("H2", [w("came")])]);
  const after = content([zaln("H1", [w("He")]), t(", "), w("came")]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.wordSequenceUnchanged, "word sequence is unchanged");
  assert(delta.unexpectedLosses.length === 1, "one unchanged word lost alignment");
  assert(delta.unexpectedLosses[0]?.text === "came", "lost word is came");
}

{
  console.log("[alignmentDelta api] edited word may unalign without blocking survivors");
  const before = content([
    zaln("H1", [w("He")]), t(" "),
    zaln("H2", [w("came")]), t(" "),
    zaln("H3", [w("home")]),
  ]);
  const after = content([
    zaln("H1", [w("He")]), t(" "),
    w("went"), t(" "),
    zaln("H3", [w("home")]),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.unexpectedLosses.length === 0, "only the changed word unaligned");
}

{
  console.log("[alignmentDelta api] collateral loss after a word edit is blocked");
  const before = content([
    zaln("H1", [w("He")]), t(" "),
    zaln("H2", [w("came")]), t(" "),
    zaln("H3", [w("home")]),
  ]);
  const after = content([
    zaln("H1", [w("He")]), t(" "),
    w("went"), t(" "),
    w("home"),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.unexpectedLosses.length === 1, "unchanged survivor loss is unexpected");
  assert(delta.unexpectedLosses[0]?.text === "home", "lost survivor is home");
  // The ENFORCED predicate must actually fire here. Pre-#227-fix this case only
  // asserted the analyzer's report, not the guard — and the guard's
  // `wordSequenceUnchanged` narrowing (here "went" changed the sequence) meant
  // it never fired. Assert the real thing now.
  assert(guardBlocksSave(delta, "text_edit"), "guard BLOCKS a text_edit with collateral loss");
  assert(!guardBlocksSave(delta, "alignment_edit"), "alignment_edit is still exempt");
}

{
  // Regression for the bug this PR fixes: the 1CH 4:21 shape. A one-word
  // spelling edit (Lekah→Lecah) flips wordSequenceUnchanged to false, AND a
  // neighbor the translator never touched ("Shelah") loses its \zaln source.
  // The pre-fix narrowed predicate (unexpectedLosses>0 && wordSequenceUnchanged)
  // did NOT fire on this — which is exactly how it shipped to master. The
  // de-narrowed guard MUST fire.
  console.log("[alignmentDelta api] 1CH 4:21 shape: one-word edit + collateral de-align fires the guard");
  const before = content([
    zaln("H1", [w("Lekah")]), t(" "),
    zaln("H2", [w("and")]), t(" "),
    zaln("H3", [w("Shelah")]),
  ]);
  // "Lekah"→"Lecah" is the intended edit (legitimately drops its own \zaln);
  // "Shelah" is untouched but lost its milestone — collateral loss.
  const after = content([
    w("Lecah"), t(" "),
    zaln("H2", [w("and")]), t(" "),
    w("Shelah"),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(!delta.wordSequenceUnchanged, "word sequence DID change (Lekah→Lecah) — the narrowing trap");
  assert(
    delta.unexpectedLosses.some((l) => l.text === "Shelah"),
    "untouched neighbor Shelah is reported as collateral loss",
  );
  assert(
    !delta.unexpectedLosses.some((l) => l.text === "Lekah" || l.text === "Lecah"),
    "the intentionally-edited word is NOT reported as collateral loss",
  );
  assert(guardBlocksSave(delta, "text_edit"), "de-narrowed guard FIRES on the 1CH 4:21 shape");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll API alignmentDelta tests passed.");


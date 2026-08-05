// Regression suite for the Occurrence invariant (occurrenceRule.ts) — the rule
// that keeps the create/patch paths from minting a row whose Occurrence cell
// Door43's validator hard-rejects, silently stopping a whole book+resource from
// publishing.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/occurrenceRule.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors export.test.mjs.
//
// The two live prod cases this suite pins:
//   twl DAN 3:5 `xf8f` — "add word" posted no occurrence at all, so it landed
//     NULL and rendered a blank Occurrence cell. validate_twl_files.py:
//     "Occurrence column cannot be blank." (no severity kwarg => error).
//   tn  JER 37:5 `bfyt` — quote "the Chaldeans, the ones laying siege" with a
//     NULL occurrence. Gateway-Language, so the old hasOrigLang-only rule never
//     fired and the render passed the null straight through to a blank
//     cell. validate_tn_files.py allows a blank Occurrence only when Quote is
//     ALSO blank, so this was an error too.

import { requiredOccurrence, renderOccurrence, hasOrigLang } from "./occurrenceRule.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
const eq = (actual, expected, msg) =>
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

const HEB = "אֶת חֶלְקֵי⁠הֶֽם";
const GRK = "ἐν ἀρχῇ";
const GL = "the Chaldeans, the ones laying siege";

// ─── hasOrigLang: the script test ────────────────────────────────────────
{
  console.log("\n[hasOrigLang]");
  assert(hasOrigLang(HEB), "Hebrew is original-language");
  assert(hasOrigLang(GRK), "Greek is original-language");
  assert(!hasOrigLang(GL), "English is not original-language");
  assert(!hasOrigLang(""), "empty string is not original-language");
}

// ─── twl: unconditional, blank AND 0 are both hard errors ────────────────
// validate_twl_files.py OCCURRENCE_RE = ^[1-9][0-9]*$, checked regardless of
// what OrigWords holds (a blank OrigWords is only severity="warning").
{
  console.log("\n[twl] occurrence must be a positive integer, whatever OrigWords holds");
  eq(requiredOccurrence("twl", "", null), 1,
     "THE DAN 3:5 xf8f CASE: blank OrigWords + no occurrence -> 1, not blank");
  eq(requiredOccurrence("twl", "", undefined), 1,
     "occurrence key absent entirely (the 'add word' POST) -> 1");
  eq(requiredOccurrence("twl", "fall down", null), 1,
     "GL OrigWords + null -> 1 (hasOrigLang would NOT have caught this)");
  eq(requiredOccurrence("twl", HEB, null), 1, "Hebrew OrigWords + null -> 1");
  eq(requiredOccurrence("twl", HEB, 0), 1, "occurrence 0 is a hard error for twl -> 1");
  eq(requiredOccurrence("twl", "", 0), 1, "blank OrigWords + 0 -> 1");
  eq(requiredOccurrence("twl", HEB, 1), null, "a valid 1 is left untouched");
  eq(requiredOccurrence("twl", HEB, 2), null,
     "a real second-occurrence target is NEVER rewritten");
}

// ─── tn: blank is legal ONLY when the Quote is also blank ─────────────────
// validate_tn_files.py: occurrence_is_allowed_blank = (occurrence == "" and _quote == "")
{
  console.log("\n[tn] a non-blank Quote of ANY script needs an integer Occurrence");
  eq(requiredOccurrence("tn", GL, null), 1,
     "THE JER 37:5 bfyt CASE: Gateway-Language quote + null -> 1");
  eq(requiredOccurrence("tn", HEB, null), 1, "Hebrew quote + null -> 1 (pre-existing OL clause)");
  eq(requiredOccurrence("tn", GRK, null), 1, "Greek quote + null -> 1");
  // NOT trimmed: the validator compares the raw cell (`_quote == ""`), so a
  // whitespace-only Quote does NOT license a blank Occurrence. Confirmed by
  // running the real validate_tn_files.py on a "   " quote with a blank
  // Occurrence — it errors.
  eq(requiredOccurrence("tn", "   ", null), 1,
     "whitespace-only quote is NOT blank to the validator -> still needs an integer");

  console.log("\n[tn] a general note (blank Quote) must KEEP its blank Occurrence");
  // This is the create path today: onNoteCreate posts note:"" with no quote and
  // no occurrence. Blank+blank is explicitly legal, and forcing a 1 here would
  // write a meaningless occurrence onto every new note.
  eq(requiredOccurrence("tn", null, null), null, "no quote, no occurrence -> leave blank");
  eq(requiredOccurrence("tn", "", null), null, "blank quote, no occurrence -> leave blank");
  eq(requiredOccurrence("tn", undefined, undefined), null, "both keys absent -> leave blank");

  console.log("\n[tn] existing valid values are not churned");
  eq(requiredOccurrence("tn", GL, 0), null,
     "occurrence 0 is VALID for tn (regex accepts '0') -> not healed, no version bump");
  eq(requiredOccurrence("tn", GL, 2), null, "a real second-occurrence target stands");
  eq(requiredOccurrence("tn", HEB, -1), null, "tn's -1 'all occurrences' is preserved");
  eq(requiredOccurrence("tn", HEB, 0), 1,
     "but OL quote + 0 still heals to 1 — the long-standing rule, unchanged");
}

// ─── tq: its validator permits a blank Occurrence, so nothing is forced ──
// validate_tq_files.py: `if occurrence != "" and not RE.fullmatch(...)`
{
  console.log("\n[tq] blank is always legal; only the OL clause applies");
  eq(requiredOccurrence("tq", GL, null), null,
     "GL quote + null is NOT forced for tq — no validator gain, and healing would churn master");
  eq(requiredOccurrence("tq", HEB, null), 1, "Hebrew quote + null -> 1 (OL clause, unchanged)");
  eq(requiredOccurrence("tq", HEB, 0), 1, "Hebrew quote + 0 -> 1");
  eq(requiredOccurrence("tq", "", null), null, "blank quote -> leave blank");
  eq(requiredOccurrence("tq", HEB, 3), null, "real target untouched");
}

// ─── negative occurrences ────────────────────────────────────────────────
// Zod's .int() accepts negatives, so these reach the handler. Each assertion
// below was confirmed against the real validator: twl rejects -1 ("must be a
// positive integer"), tn/tq accept -1 but reject -2.
{
  console.log("\n[negatives] only tn/tq's -1 'all occurrences' is legal");
  eq(requiredOccurrence("twl", "word", -1), 1,
     "twl -1 violates ^[1-9][0-9]*$ -> forced to 1");
  eq(requiredOccurrence("twl", "word", -5), 1, "twl -5 -> 1");
  eq(requiredOccurrence("tn", "some quote", -1), null,
     "tn -1 IS legal ('all occurrences') -> preserved, never rewritten");
  eq(requiredOccurrence("tq", "some quote", -1), null, "tq -1 is legal -> preserved");
  eq(requiredOccurrence("tn", "some quote", -2), 1,
     "tn -2 violates ^(?:-1|[0-9]+)$ -> forced to 1");
  eq(requiredOccurrence("tq", "some quote", -2), 1, "tq -2 -> 1");
  eq(requiredOccurrence("tn", "", -2), 1, "tn -2 is invalid even with a blank quote");
}

// ─── non-numeric junk is treated as absent, never coerced into the cell ──
{
  console.log("\n[coercion safety]");
  eq(requiredOccurrence("twl", HEB, "2"), 1,
     "a STRING '2' is not a number -> treated as absent and forced to 1 (never stored as text)");
  eq(requiredOccurrence("twl", HEB, NaN), 1, "NaN is not a valid occurrence -> 1");
  eq(requiredOccurrence("twl", HEB, 1.5), 1, "a non-integer is not a valid occurrence -> 1");

  // Out-of-range integers are about RENDERING, not size: String(1e21) is
  // "1e+21", which matches neither kind's digits-only regex.
  console.log("\n[range] values that would render in exponential notation");
  assert(String(1e21) === "1e+21", "precondition: String(1e21) really is '1e+21'");
  eq(requiredOccurrence("twl", HEB, 1e21), 1, "twl 1e21 would render '1e+21' -> forced to 1");
  eq(requiredOccurrence("tn", "some quote", 1e21), 1, "tn 1e21 -> forced to 1");
  eq(requiredOccurrence("tq", "some quote", 1e21), 1, "tq 1e21 -> forced to 1");
  eq(requiredOccurrence("tn", "some quote", Number.MAX_SAFE_INTEGER), null,
     "a large but SAFE integer still renders as plain digits -> left alone");
  eq(requiredOccurrence("tn", "some quote", Infinity), 1, "Infinity -> 1");
}

// ─── renderOccurrence: the render heals every hard-reject case ───────────
// Occurrence is not editable in the UI, so an invalid cell is pre-existing
// damage from master that no translator can fix. The render therefore applies
// the same per-kind rule as the save path rather than letting the export HOLD.
// What it must NOT do is fill a blank that is already legal (quote-less tn) —
// that would churn the nightly diff for thousands of rows.
{
  console.log("\n[renderOccurrence] render-time coercion heals what the guard would reject");
  eq(renderOccurrence("tn", HEB, null), 1, "OL quote + null renders as 1");
  eq(renderOccurrence("tn", HEB, 0), 1, "OL quote + 0 renders as 1");
  eq(renderOccurrence("tn", GL, null), 1,
     "GL quote + null now renders 1 (prod JER 37:5 bfyt — used to HOLD all of JER TN)");
  eq(renderOccurrence("tn", "", null), null,
     "quote-less tn renders blank — legal, and filling it would churn the diff");
  eq(renderOccurrence("tn", null, null), null, "null quote + null renders blank");
  eq(renderOccurrence("tn", HEB, 2), 2, "existing target passes through");
  eq(renderOccurrence("tn", "some quote", -5), 1, "tn occurrence below -1 heals to 1");
  eq(renderOccurrence("tn", "some quote", -1), -1, "tn -1 ('all occurrences') passes through");

  // twl demands a positive integer whatever OrigWords holds — so blank and 0
  // both heal to 1, never 0. This is prod twl DAN 3:5 xf8f.
  eq(renderOccurrence("twl", "", null), 1,
     "blank OrigWords + blank occurrence renders 1 (DAN 3:5 xf8f — used to HOLD all of DAN TWL)");
  eq(renderOccurrence("twl", GL, 0), 1, "twl 0 heals to 1 (0 is never legal for twl)");
  eq(renderOccurrence("twl", HEB, 3), 3, "existing twl target passes through");

  // tq's validator allows a blank unconditionally, so nothing to force there.
  eq(renderOccurrence("tq", GL, null), null, "tq GL quote + blank stays blank (always legal)");
}

// ─── The end-to-end claim: a fresh row from either create path renders OK ─
// Simulate the POST handler's seed step followed by the export renderer, and
// assert the rendered Occurrence cell satisfies each kind's validator regex.
{
  console.log("\n[end-to-end] create-then-render for every kind");
  const TWL_RE = /^[1-9][0-9]*$/;         // validate_twl_files.py
  const TN_RE = /^(?:-1|[0-9]+)$/;        // validate_tn_files.py

  function createThenRender(kind, quote, occurrence) {
    const seeded = requiredOccurrence(kind, quote, occurrence);
    const stored = seeded != null ? seeded : (typeof occurrence === "number" ? occurrence : null);
    const rendered = renderOccurrence(kind, typeof quote === "string" ? quote : null, stored);
    return rendered == null ? "" : String(rendered);
  }

  // The "add word" POST verbatim: orig_words "", tw_link "", no occurrence.
  const twlCell = createThenRender("twl", "", undefined);
  assert(TWL_RE.test(twlCell),
    `"add word" twl row renders a validator-legal Occurrence (got ${JSON.stringify(twlCell)})`);

  // A tn note whose quote was later set to Gateway-Language text.
  const tnCell = createThenRender("tn", GL, undefined);
  assert(tnCell !== "" && TN_RE.test(tnCell),
    `GL-quoted tn row renders a non-blank legal Occurrence (got ${JSON.stringify(tnCell)})`);

  // A general tn note keeps the blank that its validator explicitly allows.
  const generalCell = createThenRender("tn", "", undefined);
  eq(generalCell, "", "quote-less tn note still renders a blank Occurrence (legal, and no churn)");
}

console.log(failed === 0 ? "\nAll occurrenceRule tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

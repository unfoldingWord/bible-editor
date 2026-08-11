// Flag/escalate lint for the bible-editor side — the DCS checks that the export
// normalizers CANNOT auto-fix because they need a human decision. Run pre-export
// (escalate integrity issues to system_alerts) and on demand via
// GET /api/books/:book/lint (the in-app per-book "issues to clean up" flag).
//
// The Worker can't run DCS's Python validators, so this is a focused TS port of
// the judgement-call subset of validate_tn_files.py / validate_usfm_files.py:
//   TN: unmatched/mismatched square brackets (13), an Alternate-translation label
//       with no sentence terminator before it (12), a malformed Reference (6), a
//       malformed rc:// SupportReference (7).
//   USFM: unbalanced \f / \f* footnotes (6), missing verses (5).
// The MECHANICAL checks (formatting, trailing \n, straight quotes, label spacing,
// reference order, ids, occurrence) are auto-fixed at export and are NOT linted
// here. See docs/export-validation-cleanup.md.

import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { parseVerseContentJson } from "./contentJson.ts";
import { isTsMilestone } from "./importParsers.ts";
import { parseRefOrderKey } from "./tsvFormat.ts";

export type IssueBucket = "flag" | "escalate";

export interface LintIssue {
  check: string; // DCS check name
  bucket: IssueBucket; // flag = human decision in-app; escalate = admin banner
  ref: string; // chapter:verse (or chapter) for navigation
  rowId?: string; // row id (for jump-to-row)
  message: string;
}

// A required field is "blank" when it is missing or only whitespace. Computed
// dynamically from the live row (NOT persisted as review_kind) so the flag is
// always current and self-clears the instant the field is filled in or the row
// is deleted. This replaces hand-stamping review_kind='blank-note' via SQL.
function isBlankRequired(s: string | null | undefined): boolean {
  return !s || s.trim() === "";
}

// Chapter 0 is ONLY ever legal as the literal "front:intro" (see
// chapterZeroGuard.ts) — a book has no chapter numbered 0 with real verses,
// so "0:1", "0:intro", "0:front" etc. have no valid rendering. The negative
// lookahead excludes a leading "0:" from the three numeric-chapter branches
// while leaving "front:intro" itself untouched (see the ISA ee2w "0:1"
// incident, STATE.md).
const REFERENCE_RE = /^(?:front:intro|(?!0:)\d+:intro|(?!0:)\d+:front|(?!0:)\d+:\d+(?:[,-][\d,:-]*\d+)*)$/;
const SUPPORT_REFERENCE_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;
const ALT_LABEL_RE = /Alternat(?:e|ive)( *)([Tt])ranslation/g;

// Port of validate_tn_files.py validate_paired_square_brackets. Returns the
// human-readable problems with `[ ]` nesting in a note.
function bracketProblems(note: string): string[] {
  const out: string[] = [];
  const stack: Array<{ len: number; pos: number }> = [];
  let i = 0;
  while (i < note.length) {
    const ch = note[i];
    if (ch !== "[" && ch !== "]") {
      i++;
      continue;
    }
    let j = i;
    while (j < note.length && note[j] === ch) j++;
    const runLen = j - i;
    const token = ch.repeat(runLen);
    if (ch === "[") {
      stack.push({ len: runLen, pos: i });
    } else if (stack.length === 0) {
      out.push(`Closing bracket '${token}' at character ${i + 1} has no matching opening bracket.`);
    } else {
      const open = stack.pop()!;
      if (open.len !== runLen) {
        out.push(
          `Opening bracket '${"[".repeat(open.len)}' at character ${open.pos + 1} is closed by '${token}' at character ${i + 1}; bracket sizes must match.`,
        );
      }
    }
    i = j;
  }
  for (const open of stack) {
    out.push(`Opening bracket '${"[".repeat(open.len)}' at character ${open.pos + 1} has no matching closing bracket.`);
  }
  return out;
}

// Port of the JUDGEMENT-CALL subset of validate_alternate_translation_label:
// a label whose preceding text has no sentence terminator (the auto-fix can't
// know which punctuation belongs there). Spacing/spelling/case are auto-fixed at
// export, so they are not reported here.
function altLabelProblems(note: string): string[] {
  const out: string[] = [];
  for (const m of note.matchAll(ALT_LABEL_RE)) {
    const start = m.index ?? 0;
    if (start === 0) continue;
    const precedingTwo = note.slice(Math.max(0, start - 2), start);
    if (precedingTwo === "  ") continue; // double-space → auto-fixed at export
    if (!/^[^a-z] $/.test(precedingTwo)) {
      out.push("An 'Alternate translation' label has no sentence punctuation before it.");
    }
  }
  return out;
}

export function lintTnRows(rows: TnRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = r.ref_raw;
    if (r.ref_raw && !REFERENCE_RE.test(r.ref_raw)) {
      issues.push({ check: "6. Reference", bucket: "flag", ref, rowId: r.id, message: `Reference '${r.ref_raw}' is not a valid format.` });
    }
    if (r.support_reference && !SUPPORT_REFERENCE_RE.test(r.support_reference)) {
      issues.push({ check: "7. SupportReference", bucket: "flag", ref, rowId: r.id, message: `SupportReference '${r.support_reference}' is not a valid rc:// link.` });
    }
    // A tn row with no note is invalid content: section-header rows carry their
    // `# Heading` text IN the note, so there is no legitimately note-less tn
    // row. DCS's validator agrees but only advisorily — `validate_tn_files.py`
    // raises "Note column cannot be blank" at severity="warning", which by its
    // own ErrorCollector ("Only hard errors decide the exit code") exits 0 and
    // merges. So a blank note DOES reach Door43, which is exactly why this flag
    // matters: nothing downstream will stop it. Use chapter:verse for the ref
    // (jump-to-note loads the chapter parsed from it).
    if (isBlankRequired(r.note)) {
      issues.push({
        check: "Empty note",
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: "Empty note — DCS only warns, so this row publishes blank on the next export. Add a note or delete the row.",
      });
    }
    const note = r.note ?? "";
    for (const msg of bracketProblems(note)) {
      issues.push({ check: "13. Paired Square Bracket", bucket: "flag", ref, rowId: r.id, message: msg });
    }
    for (const msg of altLabelProblems(note)) {
      issues.push({ check: "12. Alternate translation Label", bucket: "flag", ref, rowId: r.id, message: msg });
    }
    // Workflow-only review flag for adapted/migrated notes (review_kind set).
    // Not a DCS check — surfaces the human-verify queue in the same chip.
    // Use chapter:verse for the ref (ref_raw can be a stale/adapted range, and
    // jump-to-note loads the chapter parsed from this ref).
    if (r.review_kind) {
      issues.push({
        check: "Adapted note — verify",
        bucket: "flag",
        ref: `${r.chapter}:${r.verse}`,
        rowId: r.id,
        message: r.review_reason ?? "Adapted from a parallel passage — verify the Hebrew quote and wording.",
      });
    }
  }
  return issues;
}

// tq rows: both question and response are REQUIRED. As with the tn note above,
// DCS's `validate_tq_files.py` reports a blank one at severity="warning", so it
// publishes rather than blocks — this lint is the only thing that flags it. (tq
// has no other flag/escalate DCS check the export can't auto-fix, so this is the
// whole tq lint today.)
export function lintTqRows(rows: TqRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = `${r.chapter}:${r.verse}`;
    if (isBlankRequired(r.question)) {
      issues.push({ check: "Empty question", bucket: "flag", ref, rowId: r.id, message: "Empty question — DCS only warns, so this row publishes blank on the next export. Add a question or delete the row." });
    }
    if (isBlankRequired(r.response)) {
      issues.push({ check: "Empty response", bucket: "flag", ref, rowId: r.id, message: "Empty response — DCS only warns, so this row publishes blank on the next export. Add a response or delete the row." });
    }
  }
  return issues;
}

// twl rows: both OrigWords (orig_words) and TWLink (tw_link) are REQUIRED. Same
// severity story as tn/tq — `validate_twl_files.py` warns on a blank OrigWords
// or TWLink and exits 0, so a blank TWLink publishes as an unresolvable link.
export function lintTwlRows(rows: TwlRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const r of rows) {
    const ref = `${r.chapter}:${r.verse}`;
    if (isBlankRequired(r.orig_words)) {
      issues.push({ check: "Empty OrigWords", bucket: "flag", ref, rowId: r.id, message: "Empty OrigWords — DCS only warns, so this row publishes blank on the next export. Add the original-language word(s) or delete the row." });
    }
    if (isBlankRequired(r.tw_link)) {
      issues.push({ check: "Empty TWLink", bucket: "flag", ref, rowId: r.id, message: "Empty TWLink — DCS only warns, so this row publishes with no link on the next export. Add a translationWords link or delete the row." });
    }
  }
  return issues;
}

// Count UNCLOSED footnotes in a verse's parsed nodes. usfm-js represents a
// whole footnote as ONE node `{ tag: "f", ... }`: a balanced `\f … \f*` carries
// a non-empty `endTag` ("f*"), an unclosed footnote has `endTag` "" / missing
// (its inner markers live in `content`, NOT as `\f*` text — so counting `\f*` in
// text would never see the close and would flag every normal footnote). Only a
// footnote node without an endTag is an integrity problem.
function footnoteDelta(nodes: unknown[]): number {
  let delta = 0;
  const walk = (list: unknown[]): void => {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["tag"] === "f") {
        const endTag = typeof o["endTag"] === "string" ? (o["endTag"] as string) : "";
        if (!endTag) delta += 1; // open footnote with no matching \f*
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(nodes);
  return delta;
}

// True when any `\zaln-s` in the verse carries an x-content that spans a
// CROSS-WORD joiner — maqqef (U+05BE), minus (U+2212), or a hyphen/dash. That
// glues two original-language words into one source token (carrying only the
// first word's, often wrong, strong), which strands the joined word in the
// aligner — the AI-aligner defect seen in Amos UST. The web aligner re-anchors
// it off the UHB on open, but the stored data can't self-heal until it is
// touched/back-filled, so we flag it for a human. Excludes the zero-width
// joiners (U+2060/U+200D) that legitimately sit INSIDE one UHB word.
function contentHasGlueJoiner(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? -1;
    if (cp === 0x05be || cp === 0x002d || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) return true;
  }
  return false;
}
function hasGluedMilestone(nodes: unknown[]): boolean {
  const walk = (list: unknown[]): boolean => {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (
        o["type"] === "milestone" && o["tag"] === "zaln" &&
        typeof o["content"] === "string" && contentHasGlueJoiner(o["content"] as string)
      ) {
        return true;
      }
      const children = o["children"];
      if (Array.isArray(children) && walk(children)) return true;
    }
    return false;
  };
  return walk(nodes);
}

// True when the verse's alignment data has one physical source token claimed by
// two or more DISTINCT top-level chains — a data defect that renders as
// "doubled" Hebrew in the aligner (see web/src/lib/alignment.ts
// findReusedSourcePositions and the ZEC 14:8 UST case it documents: a compound
// milestone chain wraps בַּקַּיִץ+וּבָחֹרֶף as "throughout the whole year" AND two
// separate single-word chains wrap the same two tokens again as "in the hot
// season" / "and in the cold season"). Lint has no UHB/UGNT rows, so identity is
// keyed on `nfc(x-content)|x-occurrence` rather than resolved source position —
// each TOP-LEVEL `\zaln-s` is a "chain": itself plus every zaln nested inside it,
// in document order (mirrors how hasGluedMilestone/dropDuplicateSourceMilestones
// treat nested zalns as belonging to their outer chain). A key that appears in
// two chains sharing the SAME full chain key (the joined key sequence) is the
// legitimate one-token-to-N-target-runs split (JER 28:1) — not flagged, since
// that is exactly what the aligner panel's mergeSamePositionGroups fuses into
// one card. Only a key shared across chains with DIFFERING full chain keys is a
// real defect. Scope: this is the ACROSS-chain defect only. A single chain that
// wraps the same token twice (the JER 31:33 shape) dedupes to one key here and
// is not reported — detectDoubledSourceMilestones in web/src/lib/alignment.ts
// owns that one.
//
// This check DISAGREES with the aligner's marker in BOTH directions. Measured
// against the whole of prod D1 — 37 books, 51,848 ULT/UST verses with a source
// verse, via scripts/scan-reused-token-visibility.mjs, before and after the
// chain-signature fix below:
//
//              flagged  both  lint-only  marker-only
//   before        58     20      18          20
//   after         50     19      10          21
//
// The lint-only column is this check's false positives. All of them trace to
// identity here being keyed on RAW x-occurrence while findReusedSourceWordIds
// runs after parseAlignment has reformed occurrences against the real UHB/UGNT.
// The CHAIN SIGNATURE fix closes 8 (JER 33:7, 33:11, 35:3, 35:11, 37:9, 37:10,
// MAT 9:20, ZEC 11:11) — two chains over the SAME tokens used to differ only in
// a raw x-occurrence the reform normalizes away (JER 33:7 writes וַהֲשִׁבֹתִי as
// occurrence 1 in one chain and 2 in the other, of a token the UHB contains
// once). The signature now strips the occurrence suffix before comparing chains,
// so that legitimate one-token-to-two-target-runs split no longer looks like two
// distinct chains.
//
// TRUST THE NUMBERS ABOVE, NOT EARLIER ONES. An earlier revision of this comment
// claimed 63 flagged / 12 lint-only / 4 remaining. Those came from a census
// script that paired verse-BRIDGE target rows (`\v 6-9`) with only their FIRST
// source verse, so the marker ran against a truncated source and spuriously
// "flagged" six verses that are in fact lint-only (1CH 8:8, 1CH 8:12, ACT 1:24,
// JOS 14:3, LEV 24:10, MAT 7:13). The script now pairs the full range via the
// app's own concatSourceRange. Any future figure quoted here must come from that
// fixed script.
//
// The 10 that remain are DELIBERATELY still flagged: 1CH 8:8, 1CH 8:12,
// 1CH 22:19, ACT 1:24, JOS 14:3, LEV 24:10, MAT 7:13, PSA 71:9, REV 4:9 all
// stamp two genuinely distinct source tokens with the same x-occurrence, so
// telling them apart needs the real occurrence reform this check cannot run;
// and HAB 1:3 is the reversed-nesting case below. Lint cries wolf on these BY
// CHOICE — see the reverted-suppression note next for what the cheap
// alternative cost.
//
// A source-token-count suppression (count real source `\w` tokens per NFC
// content, suppress when the source holds at least as many as there are chains
// claiming it) was tried and REVERTED, because it silenced lint on verses the
// marker still flags as real. **Its evidence is only partly re-verified.** With
// the fixed script, 1CH 6:78 UST is still a genuine defect it would suppress
// (source has וְאֶת three times, the target stamps FOUR milestones, marker
// flags 4 words) — but LEV 24:10 UST, the other verse originally cited, is
// NOT a real defect at all (marker flags 0; it is one of the 10 lint-only
// false positives above). So the revert rests on 1CH 6:78 alone and has not
// been re-measured end to end against the fixed script. Do not treat "the
// suppressor is definitively wrong" as settled: re-measure both directions
// before either restoring or re-rejecting it. The two regression tests below
// (LEV 24:10 / 1CH 6:78 shapes) pin the LINT behaviour for those shapes, which
// is stable either way — but the LEV one is NOT evidence of a real defect.
// The occurrence-insensitive signature has a KNOWN HOLE, and it is accepted
// deliberately, as a CLASS: any two chains whose unique-key lists agree on
// content sequence but differ in one or more occurrence numbers now sign
// identically, so a token they share is not reported. Instances of the class:
//   - `[A|1, B|1]` + `[A|1, B|2]` both sign as "A,B" (the original case below).
//   - `[A|1, A|2]` + `[A|2, A|3]` both sign as "A,A" (share the A|2 token).
//   - `[A|1, A|2]` + `[A|2, A|1]` both sign as "A,A" (same-content reversal —
//     see the HAB 1:3 note below for why this differs from DIFFERENT-content
//     reversal, which still flags).
//   - `[A|1, B|1, C|1]` + `[A|1, B|2, C|1]` both sign as "A,B,C" (the differing
//     occurrence sits in the middle, not at an edge).
// That shape is STRUCTURALLY IDENTICAL to the JER 33:7 split this fix
// exists to stop flagging — chains differing only in one token's occurrence,
// with the shared tokens being the ones at issue. What separates "one alignment
// written twice" from "two alignments both claiming A" is solely whether the
// source contains the differing word once or twice, which is exactly the
// judgement this check cannot make without running the reform. So the choice is
// only WHICH WAY to be wrong, and it was made on measurement: keeping the old
// behaviour costs 8 false positives, this one costs 1 verse. Corpus-wide,
// exactly 9 verses lost their flag here — 8 with the marker clean (real false
// positives) and ONE, JER 37:5 UST, where the marker still flags and renders
// the defect in red. Do not "close" this hole by restoring the full-key
// signature without re-measuring both directions.
//   - HAB 1:3 — NOT an occurrence artefact at all, and NOT an instance of the
//     class above: the two chains carry the SAME keys but with DIFFERENT
//     x-content (אָוֶן vs וְעָמָל) in REVERSED nesting order, so their signatures
//     genuinely differ and this check still flags. Reversed nesting is only
//     absorbed into the hole above when the reversed tokens share the SAME
//     content (see the same-content-reversal instance above) — in that case
//     the signature collapses just like any other occurrence-only difference.
//     The aligner's marker resolves the HAB 1:3 case to one canonical source
//     order and exempts it as a split. A real encoding oddity, not a false
//     positive — do not weaken either detector to reconcile it.
//
// The single verse this fix stops flagging that the
// right reason: its real reuse (שִׁמְעָם claimed by a compound and a standalone)
// is invisible to a check with no source rows in BOTH the old and new logic —
// the old lint=Y came from an unrelated occurrence artefact in the same verse.
//
// Two further mechanisms still push the other way (marker flags, this check
// silent), both rooted in lint never resolving actual source POSITIONS (only
// content+occurrence identity):
//   1. A merged shared prefix hides reuse. findTopLevelZalns treats an outermost
//      `\zaln-s` plus all nesting as one chain; parseAlignment makes a group per
//      word-bearing chain. So `\zaln-s A\*\zaln-s B\*\w x\w*\zaln-e\*\zaln-s
//      C\*\w y\w*\zaln-e\*\zaln-e\*` reports nothing here and flags A there,
//      while the un-merged encoding of the SAME alignment reports it — whether
//      the defect is seen depends on how the writer nested it.
//   2. A milestone with x-content but no x-occurrence is dropped here (see
//      zalnLintKey) where parseAlignment defaults it to 1, which can collapse
//      two differing chain keys into one and silence a real reuse.
// The aligner's marker remains the more reliable of the two for those two
// mechanisms — do not reconcile by weakening the marker. See
// web/src/lib/alignment.ts's comment on findReusedSourceWordIds, which points
// back here rather than restating counts.
function zalnLintKey(node: Record<string, unknown>): string | null {
  const content = node["content"];
  if (typeof content !== "string" || content === "") return null;
  // A MISSING occurrence is unknown, not 1. Defaulting it would key two
  // genuinely distinct occurrences of a repeated word identically and flag a
  // correctly aligned verse. Unkeyable milestones are simply not evidence.
  const occurrence = node["occurrence"];
  if (occurrence === undefined || occurrence === null || occurrence === "") return null;
  return `${content.normalize("NFC")}|${String(occurrence)}`;
}
function isZalnMilestone(n: unknown): n is Record<string, unknown> {
  return !!n && typeof n === "object" && (n as Record<string, unknown>)["type"] === "milestone" &&
    (n as Record<string, unknown>)["tag"] === "zaln";
}
// Depth-first keys of every zaln in this chain (the node itself, then nested
// zalns reached through it or through non-zaln wrapper children).
function collectZalnChainKeys(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  const key = zalnLintKey(node);
  if (key !== null) out.push(key);
  const children = node["children"];
  if (Array.isArray(children)) out.push(...collectZalnChainKeysFromList(children));
  return out;
}
function collectZalnChainKeysFromList(nodes: unknown[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (isZalnMilestone(n)) {
      out.push(...collectZalnChainKeys(n));
      continue;
    }
    const children = (n as Record<string, unknown> | null)?.["children"];
    if (Array.isArray(children)) out.push(...collectZalnChainKeysFromList(children));
  }
  return out;
}
// Top-level zaln nodes: the first zaln found on any path is a chain root — its
// own nested zalns are NOT separately collected here (they belong to its chain).
function findTopLevelZalns(nodes: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const n of nodes) {
    if (isZalnMilestone(n)) {
      out.push(n);
      continue;
    }
    const children = (n as Record<string, unknown> | null)?.["children"];
    if (Array.isArray(children)) out.push(...findTopLevelZalns(children));
  }
  return out;
}
// Strip the trailing `|<occurrence>` off a zalnLintKey, leaving just the NFC
// content. Used to build the chain SIGNATURE (see below) — token IDENTITY
// (chainKeysByToken's map key) keeps the full key including occurrence.
function stripOccurrenceSuffix(key: string): string {
  const i = key.lastIndexOf("|");
  return i === -1 ? key : key.slice(0, i);
}

function hasReusedSourceToken(nodes: unknown[]): boolean {
  const chains = findTopLevelZalns(nodes).map(collectZalnChainKeys);
  const chainKeysByToken = new Map<string, Set<string>>();
  for (const keys of chains) {
    // De-duplicate WITHIN the chain before taking its identity, exactly as
    // findReusedSourceWordIds does per group (`!tokens.includes(k)`). Without
    // this, a chain that wraps one token twice (the JER 31:33 shape) keyed as
    // "A,A" while a standalone claiming that token keyed as "A" — two distinct
    // sequences, so lint flagged a verse the aligner marks nothing on, because
    // the aligner's group had already collapsed to the single key "A". A
    // translator would click through from the lint feed to a clean-looking
    // verse. The within-chain doubling is real but belongs to
    // detectDoubledSourceMilestones (see the scope note above), not here.
    // RESIDUAL: this dedup is occurrence-SENSITIVE (Set(keys) compares full
    // keys, occurrence included), so it only closes the shape where the
    // repeat is numbered IDENTICALLY: [A|1, A|1, B|1] + [A|1, B|1] silences,
    // but [A|1, A|2, B|1] + [A|1, B|1] still flags (1 issue) — verified. That
    // is the AI doubled-source-milestone defect: the source holds A once, the
    // marker dedups it to one position and stays silent, and lint flags a
    // false positive in a class this check explicitly disclaims owning. Not
    // fixed here; some of the 10 remaining lint-only verses may be this shape
    // (not verified per-verse).
    const uniqueKeys = [...new Set(keys)];
    // The chain SIGNATURE strips occurrence before joining (deliberately NOT
    // deduped again — positional multiplicity must survive, so [A|1, A|2]
    // signs as "A,A" not "A"). This is what lets two chains over the SAME
    // tokens that differ only by a raw, un-reformed occurrence number collapse
    // into the same signature instead of registering as two distinct chains
    // (see the scope comment above).
    // Joined with U+0001, not a comma: x-content can itself legally contain a
    // comma (e.g. a source token "A,B"), and joining with "," would let
    // [X|1, "A,B"|1] and [X|1, A|1, B|1] both sign as "X,A,B", silencing a
    // reused X. U+0001 cannot occur in USFM x-content, so it can't collide.
    const signature = uniqueKeys.map(stripOccurrenceSuffix).join("");
    for (const key of uniqueKeys) {
      const set = chainKeysByToken.get(key) ?? new Set<string>();
      set.add(signature);
      chainKeysByToken.set(key, set);
    }
  }
  for (const set of chainKeysByToken.values()) {
    if (set.size >= 2) return true;
  }
  return false;
}

// Paragraph / poetry tags that legitimately open a chapter. Mirror of
// PARAGRAPH_TAGS in web/src/lib/usfm.ts — keep in sync.
//
// `\ts\*` is DELIBERATELY absent: a chunk divider is a translator-section
// milestone, not a line-layout marker, so a chapter whose only leading node is
// `\ts\*` still has no paragraph and must still flag. Character wrappers
// (`\qs Selah\qs*`) are also `type:"quote"` but carry verse CONTENT rather than
// a break — they're excluded by the tag-set test, since `qs` isn't in the set.
// `b` is DELIBERATELY absent, unlike PARAGRAPH_TAGS: `\b` is a blank line, not a
// paragraph opener, so a chapter whose front matter ends in `\b` still needs a
// real `\p`/`\q` and must keep flagging.
const CHAPTER_OPENING_TAGS: ReadonlySet<string> = new Set([
  "p", "m", "mi", "nb", "pi", "pi1", "pi2", "pi3", "pc",
  "q", "q1", "q2", "q3", "q4", "qm", "qm1", "qm2", "qm3",
]);

function isChapterOpeningMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if (t !== "paragraph" && t !== "quote") return false;
  const tag = o["tag"];
  return typeof tag === "string" && CHAPTER_OPENING_TAGS.has(tag);
}

// Nodes that carry no verse content and so must not stop the edge scans below.
// This mirrors trailingMarkerRunStart in web/src/lib/usfm.ts — keep the two in
// sync, because the app uses that function to decide which markers introduce the
// next verse, and a lint that disagreed would flag chapters the editor already
// shows as correctly marked (or stay silent on ones it shows as bare).
//
// Transparent: whitespace-only text (including U+200B, which the editor's empty
// -block placeholder leaves behind) and `\ts\*` chunk milestones. The `\ts\*`
// case is the Micah 4 lesson: prod stores tails as `\q1` then `\ts\*`, so a scan
// that stopped at the divider would never see the `\q1` behind it and would
// report a marked chapter as bare. Section headings (`\s1`) are deliberately NOT
// transparent — the app stops at them too, so a `\p` sitting BEFORE a heading
// does not introduce the verse that follows the heading.
function isTransparentToEdgeScan(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["text"];
  if (typeof t === "string" && /^[\s​]*$/.test(t)) return true;
  return isTsMilestone(o);
}

// POSITION MATTERS, and getting it wrong makes this lint useless. An opening
// marker only counts if it sits at the boundary between the chapter start and
// verse 1: trailing on the front matter, or leading verse 1 itself. Scanning the
// whole array instead (an `Array.some`) silently passes every poetry chapter,
// because verse 1 of a poetic verse carries its own mid-verse `\q1`/`\q2` line
// breaks — MIC 2:1 UST is exactly that, and it hid a real missing-marker defect.
function endsWithOpeningMarker(nodes: unknown[]): boolean {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (isChapterOpeningMarker(nodes[i])) return true;
    if (isTransparentToEdgeScan(nodes[i])) continue;
    return false;
  }
  return false;
}

// A verse row's parsed `verseObjects`, or [] when the row is absent or its stored
// JSON is unreadable. Lint must survive a corrupt row rather than throw and take
// the whole book's report down with it — a corrupt intro simply reads as "carries
// no marker", which is the safe direction (it flags for a human to look).
function verseObjectsOf(row: VerseRow | undefined): unknown[] {
  if (!row) return [];
  let parsed: unknown;
  try {
    parsed = parseVerseContentJson(row);
  } catch {
    return [];
  }
  const vos = (parsed as { verseObjects?: unknown[] })?.verseObjects;
  return Array.isArray(vos) ? vos : [];
}

function startsWithOpeningMarker(nodes: unknown[]): boolean {
  for (const node of nodes) {
    if (isChapterOpeningMarker(node)) return true;
    if (isTransparentToEdgeScan(node)) continue;
    return false;
  }
  return false;
}

// Flag chapters whose verse 1 is not introduced by a paragraph / poetry marker
// (issue #378). USFM puts that marker BEFORE `\v 1`, so usfm-js parks it on the
// chapter-front pseudo-verse that we store as verse 0 — meaning the marker is
// normally the TRAILING content of verse 0, not the leading content of verse 1.
// Two distinct defects produce an unmarked chapter, and both are reported here:
//
//   1. no verse-0 row exists at all (the observed case: MIC 5 ULT, MIC 2 UST) —
//      nothing can hold the marker, and the editor cannot even create it without
//      the verse-0 upsert path in verses.ts;
//   2. a verse-0 row exists but holds no opening marker (e.g. only a `\d` Psalm
//      superscription, or only a `\ts\*` chunk divider).
//
// Checking verse 1's own LEADING nodes as well keeps this from false-positiving
// if usfm-js ever parks the marker inside verse 1 instead of on the front matter.
// Both checks are position-sensitive — see endsWithOpeningMarker for why.
// Bucket is `flag`, not `escalate`: this needs a human to choose WHICH marker
// belongs (`\p` prose vs `\q1` poetry), and it does not corrupt the export.
export function lintChapterOpeningMarkers(verses: VerseRow[]): LintIssue[] {
  const byChapter = new Map<number, { front?: VerseRow; first?: VerseRow }>();
  for (const v of verses) {
    if (v.verse !== 0 && v.verse !== 1) continue;
    const slot = byChapter.get(v.chapter) ?? {};
    if (v.verse === 0) slot.front = v;
    else slot.first = v;
    byChapter.set(v.chapter, slot);
  }
  const issues: LintIssue[] = [];
  for (const chapter of [...byChapter.keys()].sort((a, b) => a - b)) {
    const { front, first } = byChapter.get(chapter)!;
    // A chapter with no verse 1 isn't scripture we can judge (front matter,
    // partial load) — say nothing rather than guess.
    if (!first) continue;
    if (endsWithOpeningMarker(verseObjectsOf(front))) continue;
    if (startsWithOpeningMarker(verseObjectsOf(first))) continue;
    issues.push({
      check: "Chapter opening marker",
      bucket: "flag",
      // Point at the intro row — that's where the fix goes, and it's a valid
      // navigation target even when the row doesn't exist yet.
      ref: `${chapter}:0`,
      message: front
        ? `chapter ${chapter} starts without a paragraph / poetry marker (\\p, \\q1, …) — add one to the chapter intro.`
        : `chapter ${chapter} has no chapter-intro row, so it starts without a paragraph / poetry marker (\\p, \\q1, …) — add one to the chapter intro.`,
    });
  }
  return issues;
}

// USFM (ult/ust) integrity lint over the stored verse rows: unbalanced footnotes
// and joiner-glued alignment milestones, per verse. (Verse-coverage / chapter-
// count are guarded by the export shrink guard and validated whole-file
// downstream; not duplicated here.)
export function lintUsfmVerses(verses: VerseRow[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const v of verses) {
    if (v.verse === 0) continue;
    let parsed: unknown;
    try {
      parsed = parseVerseContentJson(v);
    } catch {
      continue;
    }
    const vos = (parsed as { verseObjects?: unknown[] })?.verseObjects;
    if (!Array.isArray(vos)) continue;
    const ref = `${v.chapter}:${v.verse}`;
    const delta = footnoteDelta(vos);
    if (delta !== 0) {
      issues.push({
        check: "6. Footnote Syntax",
        bucket: "escalate",
        ref,
        message: delta > 0 ? `${delta} unclosed footnote(s) (\\f without \\f*).` : `${-delta} extra footnote close(s) (\\f* without \\f).`,
      });
    }
    if (hasGluedMilestone(vos)) {
      issues.push({
        check: "Glued alignment",
        bucket: "escalate",
        ref,
        message: "alignment milestone x-content spans a maqqef/minus (two source words glued into one).",
      });
    }
    if (hasReusedSourceToken(vos)) {
      issues.push({
        check: "Reused source token",
        bucket: "flag",
        ref,
        message: "the same source word is aligned in more than one group (renders as doubled Hebrew); re-align the verse.",
      });
    }
  }
  return issues;
}

// True when a reference parses (used to keep lint robust to odd inputs).
export function refSortable(ref: string): boolean {
  return parseRefOrderKey(ref) !== null;
}

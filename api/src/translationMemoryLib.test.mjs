// Unit tests for translationMemoryLib.ts — CSV round-trip, closed-picklist
// validation, and term dedup. Pure functions only (no D1), so runnable under the
// strip-types runner like the other api tests.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/translationMemoryLib.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  TERM_STATUSES,
  REGISTERS,
  isTermStatus,
  isRegister,
  parseCsvRows,
  parseTermsCsv,
  serializeTermsCsv,
  dedupeTerms,
  termKey,
} from "./translationMemoryLib.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log("[picklists] closed enums guard bad values");
{
  assert(isTermStatus("preferred") && isTermStatus("forbidden") && isTermStatus("do_not_translate"), "valid statuses accepted");
  assert(!isTermStatus("banned") && !isTermStatus("") && !isTermStatus(3), "invalid statuses rejected");
  assert(TERM_STATUSES.length === 5, "exactly 5 term statuses");
  assert(isRegister("formal") && isRegister("default") && isRegister("informal"), "valid registers accepted");
  assert(!isRegister("casual") && !isRegister(null), "invalid registers rejected");
  assert(REGISTERS.length === 3, "exactly 3 registers");
}

console.log("[parseCsvRows] RFC-4180 quoting");
{
  const rows = parseCsvRows('a,b,c\r\n"quoted, comma","has ""quote""","line\nbreak"\n');
  assert(rows.length === 2, "two rows parsed");
  assert(rows[0].join("|") === "a|b|c", "plain header row");
  assert(rows[1][0] === "quoted, comma", "quoted comma preserved");
  assert(rows[1][1] === 'has "quote"', "escaped double-quote unescaped");
  assert(rows[1][2] === "line\nbreak", "embedded newline preserved");
}

console.log("[parseCsvRows] BOM + trailing blank line");
{
  const rows = parseCsvRows("﻿concept_id,source_term\nkt/god,God\n\n");
  assert(rows.length === 2, "BOM stripped, trailing blank line dropped");
  assert(rows[0][0] === "concept_id", "BOM not attached to first header cell");
}

console.log("[parseTermsCsv] happy path with all columns");
{
  const csv =
    "concept_id,source_term,target_term,status,replacement,comment,tw_link\n" +
    "kt/god,God,الله,preferred,,the standard rendering,rc://*/tw/dict/bible/kt/god\n" +
    "kt/god,god,إله,forbidden,الله,pagan sense,\n";
  const { terms, errors } = parseTermsCsv(csv);
  assert(errors.length === 0, "no parse errors");
  assert(terms.length === 2, "two terms parsed");
  assert(terms[0].target_term === "الله" && terms[0].tw_link.includes("kt/god"), "row 1 fields");
  assert(terms[1].status === "forbidden" && terms[1].replacement === "الله", "forbidden row carries replacement");
  assert(terms[0].comment === "the standard rendering", "comment parsed");
}

console.log("[parseTermsCsv] column reordering + missing optional columns");
{
  const csv = "source_term,concept_id,status\nGod,kt/god,admitted\nLord,kt/lord,\n";
  const { terms, errors } = parseTermsCsv(csv);
  assert(errors.length === 0, "no errors with reordered/missing columns");
  assert(terms[0].concept_id === "kt/god" && terms[0].status === "admitted", "columns matched by header name");
  assert(terms[1].status === "preferred", "empty status defaults to preferred");
  assert(terms[0].target_term === null, "missing optional column is null");
}

console.log("[parseTermsCsv] error rows are reported, not guessed");
{
  const csv = "concept_id,source_term,status\nkt/god,God,banned\n,Empty,preferred\nkt/lord,Lord,forbidden\n";
  const { terms, errors } = parseTermsCsv(csv);
  assert(terms.length === 1, "only the one valid row is kept");
  assert(terms[0].source_term === "Lord", "the valid row survived");
  assert(errors.length === 2, "two error rows reported");
  assert(errors[0].line === 2 && /invalid status/.test(errors[0].message), "bad status reported with line number");
  assert(errors[1].line === 3 && /required/.test(errors[1].message), "missing concept_id reported");
}

console.log("[parseTermsCsv] header without required columns");
{
  const { terms, errors } = parseTermsCsv("foo,bar\n1,2\n");
  assert(terms.length === 0 && errors.length === 1, "no terms, one header error");
  assert(/concept_id and source_term/.test(errors[0].message), "header error names the missing columns");
}

console.log("[serializeTermsCsv] round-trips through parse");
{
  const original =
    "concept_id,source_term,target_term,status,replacement,comment,tw_link\n" +
    'kt/god,God,"الله, the One",preferred,,"has, comma",\n';
  const { terms } = parseTermsCsv(original);
  const out = serializeTermsCsv(terms);
  const reparsed = parseTermsCsv(out).terms;
  assert(reparsed.length === 1, "one row survives round-trip");
  assert(reparsed[0].target_term === "الله, the One", "comma-bearing target survives quoting");
  assert(reparsed[0].comment === "has, comma", "comma-bearing comment survives quoting");
  assert(out.startsWith("concept_id,source_term,target_term,status,replacement,comment,tw_link"), "canonical header emitted");
}

console.log("[termKey + dedupeTerms] identity + last-wins dedup");
{
  const a = { concept_id: "kt/God", source_term: "God ", status: "preferred" };
  const b = { concept_id: "kt/god", source_term: "god", status: "preferred" };
  assert(termKey(a) === termKey(b), "termKey is case/space-insensitive on concept+source");
  const batch = [
    { concept_id: "kt/god", source_term: "God", status: "preferred", target_term: "first", replacement: null, comment: null, tw_link: null },
    { concept_id: "kt/god", source_term: "God", status: "preferred", target_term: "second", replacement: null, comment: null, tw_link: null },
    { concept_id: "kt/god", source_term: "God", status: "forbidden", target_term: "x", replacement: null, comment: null, tw_link: null },
  ];
  const deduped = dedupeTerms(batch);
  assert(deduped.length === 2, "same (concept,source,status) collapses; different status kept");
  const pref = deduped.find((t) => t.status === "preferred");
  assert(pref.target_term === "second", "last-wins on collision");
}

console.log("\nAll translationMemoryLib tests passed.");

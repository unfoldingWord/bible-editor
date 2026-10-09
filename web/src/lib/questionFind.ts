// Pure helpers for the Find overlay's TQ (translation questions) scope.
// Only `question` and `response` are searched or rewritten — ref_raw, quote,
// occurrence and tags are structural and never touched. Kept free of React so
// the node test runner can exercise it (questionFind.test.mjs).

import type { TqRow } from "../sync/api";

export type QuestionField = "question" | "response";

export const QUESTION_FIELDS: readonly QuestionField[] = ["question", "response"];

// One hit. `start`/`end` index into the field's string; `occurrence` is the
// 0-based index among THAT field's matches (the row highlights its own matches
// in the same order, so it can pick the Nth without sharing string positions).
export interface QuestionMatch {
  chapter: number;
  verse: number;
  rowId: string;
  field: QuestionField;
  start: number;
  end: number;
  occurrence: number;
  matchText: string;
}

// Override key for a just-replaced field value.
export const questionOverrideKey = (rowId: string, field: QuestionField): string =>
  `${rowId}:${field}`;

// Replace every regex match in a plain string with the replacement inserted
// LITERALLY (no `$1` / `$&` substitution), matching smartReplaceVerse's
// scripture semantics. Returns the new text and the number of occurrences
// replaced. Guards the zero-width-match case so an empty-matching pattern
// can't loop forever.
export function replaceAllLiteral(
  text: string,
  re: RegExp,
  replacement: string,
): { text: string; count: number } {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(re.source, flags);
  let out = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    out += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    count += 1;
    if (m[0].length === 0) g.lastIndex++;
  }
  return { text: out + text.slice(last), count };
}

// Every occurrence of `re` in the question / response text of each live row.
// `overrides` holds just-replaced field values (see questionOverrideKey) so the
// list refreshes before the live rows catch up. Deleted rows are skipped.
export function collectQuestionMatches(
  rows: TqRow[],
  re: RegExp | null,
  overrides?: Map<string, string>,
): QuestionMatch[] {
  if (!re) return [];
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const out: QuestionMatch[] = [];
  for (const r of rows) {
    if (r.deleted_at != null) continue;
    for (const field of QUESTION_FIELDS) {
      const text = overrides?.get(questionOverrideKey(r.id, field)) ?? r[field];
      if (!text) continue;
      // Fresh /g regex per field so lastIndex doesn't bleed across fields.
      const local = new RegExp(re.source, flags);
      let m: RegExpExecArray | null;
      let occ = 0;
      while ((m = local.exec(text)) !== null) {
        out.push({
          chapter: r.chapter,
          verse: r.verse,
          rowId: r.id,
          field,
          start: m.index,
          end: m.index + m[0].length,
          occurrence: occ,
          matchText: m[0],
        });
        occ += 1;
        if (m[0].length === 0) local.lastIndex++;
      }
    }
  }
  return out;
}

// Rewrite ONE match in `text` with the literal replacement. Returns null when
// the match no longer lines up with the text (drift) or nothing would change.
export function applyQuestionMatch(
  text: string,
  m: { start: number; end: number; matchText: string },
  replacement: string,
): string | null {
  if (!text || m.start < 0 || m.end > text.length || m.start >= m.end) return null;
  // The match list can lag a saved edit; never splice at offsets that no
  // longer hold the matched text.
  if (text.slice(m.start, m.end) !== m.matchText) return null;
  const next = text.slice(0, m.start) + replacement + text.slice(m.end);
  return next === text ? null : next;
}

// Would this edit blank a field that had text? Replace skips those: an empty
// question or response is almost never what a find/replace meant.
export function wouldEmptyField(before: string, after: string): boolean {
  return before.trim() !== "" && after.trim() === "";
}

// Compile a lifted find query the way the overlay does: escape literals unless
// regex mode, case-insensitive unless requested. Invalid regex -> null.
export function buildFindRegex(q: {
  find: string;
  regex: boolean;
  caseSensitive: boolean;
}): RegExp | null {
  if (!q.find) return null;
  try {
    const pattern = q.regex ? q.find : q.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(pattern, q.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

// Char range of the Nth (0-based) match of `re` in `text`, or null.
export function nthMatchRange(
  text: string,
  re: RegExp,
  n: number,
): { start: number; end: number } | null {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = g.exec(text)) !== null) {
    if (i === n) return { start: m.index, end: m.index + m[0].length };
    i += 1;
    if (m[0].length === 0) g.lastIndex++;
  }
  return null;
}

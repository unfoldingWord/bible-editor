// Quick-fill templates for the two most common TN shapes. Placeholder
// convention:
//   - Bare ALL-CAPS tokens (NOTE, REF) are double-click-selectable so the
//     editor can replace them in one shot.
//   - Bracketed [ALT] matches the canonical TSV form for the alternate-
//     translation slot — double-clicking ALT selects just the inner word,
//     leaving the brackets in place (which is how the corpus is written).
// Wording matches docs/samples/en_tn_tn_ZEC.tsv (TCM) and tn_OBA.tsv (SH).

export const TCM =
  "This could mean: (1) NOTE Alternate translation: [ALT] (2) NOTE Alternate translation: [ALT]";

const BOOK_NAMES: Record<string, string> = {
  GEN: "Genesis", EXO: "Exodus", LEV: "Leviticus", NUM: "Numbers",
  DEU: "Deuteronomy", JOS: "Joshua", JDG: "Judges", RUT: "Ruth",
  "1SA": "1 Samuel", "2SA": "2 Samuel", "1KI": "1 Kings", "2KI": "2 Kings",
  "1CH": "1 Chronicles", "2CH": "2 Chronicles", EZR: "Ezra", NEH: "Nehemiah",
  EST: "Esther", JOB: "Job", PSA: "Psalms", PRO: "Proverbs",
  ECC: "Ecclesiastes", SNG: "Song of Songs", ISA: "Isaiah", JER: "Jeremiah",
  LAM: "Lamentations", EZK: "Ezekiel", DAN: "Daniel", HOS: "Hosea",
  JOL: "Joel", AMO: "Amos", OBA: "Obadiah", JON: "Jonah", MIC: "Micah",
  NAM: "Nahum", HAB: "Habakkuk", ZEP: "Zephaniah", HAG: "Haggai",
  ZEC: "Zechariah", MAL: "Malachi",
  MAT: "Matthew", MRK: "Mark", LUK: "Luke", JHN: "John", ACT: "Acts",
  ROM: "Romans", "1CO": "1 Corinthians", "2CO": "2 Corinthians",
  GAL: "Galatians", EPH: "Ephesians", PHP: "Philippians", COL: "Colossians",
  "1TH": "1 Thessalonians", "2TH": "2 Thessalonians", "1TI": "1 Timothy",
  "2TI": "2 Timothy", TIT: "Titus", PHM: "Philemon", HEB: "Hebrews",
  JAS: "James", "1PE": "1 Peter", "2PE": "2 Peter", "1JN": "1 John",
  "2JN": "2 John", "3JN": "3 John", JUD: "Jude", REV: "Revelation",
};

export function buildSH(bookCode: string): string {
  const name = BOOK_NAMES[bookCode.toUpperCase()] ?? bookCode;
  return `See how you translated these same phrases in [${name} 1:1](../01/01.md). Alternate translation: [ALT]`;
}

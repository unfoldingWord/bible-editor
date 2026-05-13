// Pure parsing helpers shared between the inbound AI-pipeline importer
// (api/src/pipelineImport.ts) and the future inbound-from-DCS path. The
// existing one-shot scripts/import-book.mjs is the historical reference;
// these helpers are now the canonical Worker-side source.

import usfm from "usfm-js";

export interface VerseExtract {
  chapter: number;
  verse: number;
  contentJson: string;       // JSON-stringified verseObj suitable for verses.content_json
  plainText: string;
}

// Walk verse-objects and concatenate all text. Mirrors the logic in
// scripts/import-book.mjs (extractPlainText). usfm-js verse-object shapes:
//   { type: 'text', text: '...' }
//   { type: 'word', text: '...', occurrence, ... }
//   { type: 'milestone', tag: 'zaln-s', children: [...] }
//   { type: 'paragraph', tag: 'p' }
function extractPlainText(verseObj: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos || []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as { text?: unknown; children?: unknown[] };
      if (typeof v.text === "string") parts.push(v.text);
      if (Array.isArray(v.children)) walk(v.children);
    }
  };
  const top = verseObj as { verseObjects?: unknown[] };
  walk(top.verseObjects ?? []);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// Extract every verse in [startChapter, endChapter] from a whole-book USFM
// blob. Verse keys like 'front' or 'intro' are skipped; a hyphenated key
// (e.g. '12-13') collapses to its first verse number for indexing.
export function extractVersesForRange(
  rawUsfm: string,
  startChapter: number,
  endChapter: number,
): VerseExtract[] {
  const json = usfm.toJSON(rawUsfm);
  const out: VerseExtract[] = [];
  const chapters = json.chapters ?? {};
  for (const chapterKey of Object.keys(chapters)) {
    const chNum = parseInt(chapterKey, 10);
    if (!Number.isFinite(chNum)) continue;
    if (chNum < startChapter || chNum > endChapter) continue;
    const chapterObj = chapters[chapterKey] as Record<string, unknown>;
    for (const verseKey of Object.keys(chapterObj)) {
      if (!/^\d+(-\d+)?$/.test(verseKey)) continue;
      const vNum = parseInt(verseKey.split("-")[0], 10);
      if (!Number.isFinite(vNum)) continue;
      const verseObj = chapterObj[verseKey];
      out.push({
        chapter: chNum,
        verse: vNum,
        contentJson: JSON.stringify(verseObj),
        plainText: extractPlainText(verseObj),
      });
    }
  }
  return out;
}

// 'front:intro' -> [0, 0]
// '1:intro'     -> [1, 0]
// '1:1'         -> [1, 1]
// '1:1-3'       -> [1, 1] (range collapses to first verse for indexing)
export function refParts(refRaw: string | null | undefined): [number, number] {
  if (!refRaw) return [0, 0];
  const [ch, vs] = refRaw.split(":");
  const chNum = ch === "front" ? 0 : parseInt(ch, 10) || 0;
  const vsNum =
    !vs || vs === "intro" ? 0 : parseInt(vs.split("-")[0], 10) || 0;
  return [chNum, vsNum];
}

export interface ParsedTsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

// Naive split-by-tab parser matching scripts/import-book.mjs. The
// unfoldingWord TSVs don't quote tabs inside cells, so this is sufficient.
export function parseTsv(raw: string): ParsedTsv {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = cells[i] ?? "";
    });
    return o;
  });
  return { headers, rows };
}

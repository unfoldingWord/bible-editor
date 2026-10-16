import type { VerseDto } from "../sync/api";
import { verseHasUnalignedWork } from "./alignment.ts";
import { buildVerseIndex, sourceForTargetRow } from "./verseRange.ts";

function verseObjectsOf(dto: VerseDto | null | undefined): unknown[] | null {
  const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

// Which version the Alignment tab should open on for `verse`: the one of ULT /
// UST that has unaligned words when exactly one does, otherwise null (both or
// neither — the caller keeps whatever version it would have used). Each row is
// judged against the source it covers, so a verse inside a bridge resolves to
// its covering row (the verse tiles key by row start, so they would not flag it).
export function versionNeedingAlignment(
  verses: Record<string, Record<number, VerseDto>> | undefined,
  verse: number,
): "ULT" | "UST" | null {
  if (!verses || verse <= 0) return null;
  const source = verses.UHB ?? verses.UGNT ?? {};
  const needs = (bv: "ULT" | "UST") => {
    const row = buildVerseIndex(verses[bv])[verse];
    const vo = verseObjectsOf(row);
    return !!vo && verseHasUnalignedWork(vo, verseObjectsOf(sourceForTargetRow(source, row)));
  };
  const ult = needs("ULT");
  const ust = needs("UST");
  if (ult === ust) return null;
  return ult ? "ULT" : "UST";
}

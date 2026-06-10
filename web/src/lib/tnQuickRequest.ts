// Build a TnQuickRequest payload from a translation-note row and the
// chapter it lives in. Pure — all the data the bot needs is already in
// the loaded ChapterPayload, so the Worker can stay a thin proxy.
//
// Two flows depending on what the user has put in the QUOTE field:
//
//   English mode (typical first-time path): user typed the English
//   support phrase from ULT into QUOTE before clicking sparkles. The
//   English IS `ult.selection`; we look it up against the ULT
//   alignment to derive `hebrewGuess`, then use that Hebrew to find
//   the parallel `ust.selection`. If the English doesn't align to
//   anything, fail fast — the bot would 422 no_rtl on an empty guess
//   and the user deserves a clearer message.
//
//   Hebrew mode (regenerate path): after the AI has run once, QUOTE
//   contains Hebrew. We use that Hebrew as `hebrewGuess` and derive
//   ULT/UST selections from it via the same alignment lookup that
//   drives verse highlighting. Lets a translator tweak the issue
//   type and re-run without retyping English.
//
// Context: prev/next 5 verses within the current chapter; we don't
// fetch neighboring chapters here (spec allows shorter arrays at
// chapter edges).

import type { ChapterPayload, TnRow, TnQuickRequest, VerseDto } from "../sync/api";
import {
  extractTargetSelectionText,
  findSourceForTargetText,
} from "./highlight";
import { shortSupport } from "./supportReference";
import { buildVerseIndex } from "./verseRange";

const CONTEXT_WINDOW = 5;
const HEBREW_GAP = /[&…]+|\.{3}/g;
// Hebrew Unicode block. Presence of even one char flips us into
// "regenerate from existing Hebrew quote" mode.
const HEBREW_CHAR = /[֐-׿]/;

function hasHebrew(s: string): boolean {
  return HEBREW_CHAR.test(s);
}

function extractPlainText(verseObjects: unknown[]): string {
  let out = "";
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      const type = o["type"];
      if (type === "text") {
        out += String(o["text"] ?? "");
      } else if (type === "word") {
        out += String(o["text"] ?? "");
      } else if (type === "milestone") {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return out.replace(/\s+/g, " ").trim();
}

function plainOf(v: VerseDto | undefined): string {
  if (!v) return "";
  if (v.plain_text) return v.plain_text;
  const vo = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? extractPlainText(vo) : "";
}

function verseObjectsOf(v: VerseDto | undefined): unknown[] | null {
  if (!v) return null;
  const vo = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

function gatherContext(
  byVerse: Record<number, VerseDto> | undefined,
  verse: number,
): { prev5: string[]; next5: string[] } {
  if (!byVerse) return { prev5: [], next5: [] };
  const prev5: string[] = [];
  for (let v = Math.max(1, verse - CONTEXT_WINDOW); v < verse; v++) {
    const text = plainOf(byVerse[v]);
    if (text) prev5.push(text);
  }
  const next5: string[] = [];
  for (let v = verse + 1; v <= verse + CONTEXT_WINDOW; v++) {
    if (!byVerse[v]) break;
    const text = plainOf(byVerse[v]);
    if (text) next5.push(text);
  }
  return { prev5, next5 };
}

function cleanHebrew(quote: string): string {
  return quote.replace(HEBREW_GAP, " ").replace(/\s+/g, " ").trim();
}

export interface BuildTnQuickRequestError {
  reason:
    | "missing_support_reference"
    | "missing_quote"
    | "missing_ult_verse"
    | "missing_ust_verse"
    | "hebrew_not_found";
}

export type BuildTnQuickRequestResult =
  | { ok: true; request: TnQuickRequest }
  | { ok: false; error: BuildTnQuickRequestError };

export function buildTnQuickRequest(
  row: TnRow,
  data: ChapterPayload,
): BuildTnQuickRequestResult {
  if (!row.support_reference) {
    return { ok: false, error: { reason: "missing_support_reference" } };
  }
  const rawQuote = (row.quote ?? "").trim();
  if (!rawQuote) {
    return { ok: false, error: { reason: "missing_quote" } };
  }

  const ultByVerse = data.verses.ULT;
  const ustByVerse = data.verses.UST;
  // Resolve through the expanded index — verses[bv] is keyed by verse_start,
  // so a direct [row.verse] lookup misses bridged ranges (\v 8-9).
  const ultVerse = buildVerseIndex(ultByVerse)[row.verse];
  const ustVerse = buildVerseIndex(ustByVerse)[row.verse];

  const ultText = plainOf(ultVerse);
  const ustText = plainOf(ustVerse);
  if (!ultText) return { ok: false, error: { reason: "missing_ult_verse" } };
  if (!ustText) return { ok: false, error: { reason: "missing_ust_verse" } };

  const ultVo = verseObjectsOf(ultVerse);
  const ustVo = verseObjectsOf(ustVerse);
  // UHB/UGNT verse for OL-anchoring the selection lookups — without it,
  // extractTargetSelectionText permanently degrades to GL-only matching
  // even though the source is already in the payload.
  const sourceVo =
    verseObjectsOf(buildVerseIndex(data.verses.UHB ?? data.verses.UGNT)[row.verse]) ?? undefined;

  let ultSelection: string;
  let ustSelection: string;
  let hebrewGuess: string;

  if (hasHebrew(rawQuote)) {
    // Regenerate path: the row already has a Hebrew quote (typically
    // from a previous AI run). Derive English from the same alignment
    // that drives highlighting.
    const occurrence = row.occurrence ?? 1;
    hebrewGuess = cleanHebrew(rawQuote);
    ultSelection =
      (ultVo && extractTargetSelectionText(ultVo, rawQuote, occurrence, sourceVo)) ||
      ultText.slice(0, 500);
    ustSelection =
      (ustVo && extractTargetSelectionText(ustVo, rawQuote, occurrence, sourceVo)) ||
      ustText.slice(0, 500);
  } else {
    // English path: user typed English from ULT. The English IS the
    // ULT selection; look it up against ULT alignment for the Hebrew
    // guess, then use the Hebrew to find the parallel UST phrase.
    if (!ultVo) {
      return { ok: false, error: { reason: "hebrew_not_found" } };
    }
    const derivedHebrew = findSourceForTargetText(ultVo, rawQuote);
    if (!derivedHebrew) {
      return { ok: false, error: { reason: "hebrew_not_found" } };
    }
    hebrewGuess = derivedHebrew;
    ultSelection = rawQuote;
    ustSelection =
      (ustVo && extractTargetSelectionText(ustVo, derivedHebrew, 1, sourceVo)) ||
      ustText.slice(0, 500);
  }

  const ultCtx = gatherContext(ultByVerse, row.verse);
  const ustCtx = gatherContext(ustByVerse, row.verse);

  const request: TnQuickRequest = {
    ref: {
      book: row.book,
      chapter: row.chapter,
      verse: row.verse,
    },
    issueType: shortSupport(row.support_reference),
    ult: {
      selection: ultSelection.slice(0, 500),
      verse: ultText,
      context: ultCtx,
    },
    ust: {
      selection: ustSelection.slice(0, 500),
      verse: ustText,
      context: ustCtx,
    },
    hebrewGuess: hebrewGuess.slice(0, 500),
  };

  return { ok: true, request };
}

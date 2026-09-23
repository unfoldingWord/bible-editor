// Client-side USFM export. Renders one or more chapters of a single bible
// version back to a USFM string, in two variants:
//   - aligned:   the stored verseObjects verbatim (\zaln-s / \w milestones kept)
//   - unaligned: \zaln milestones unwrapped and \w words flattened to bare text,
//                so the output is plain scripture with paragraph/poetry markers
//                preserved but no alignment structure.
//
// This mirrors the server's api/src/export.ts `buildUsfm` chapter-assembly,
// header synthesis, AND its final normalizeUsfmFormatting() reflow (mirrored into
// web/src/lib/usfmFormat.ts), so a downloaded file matches the DCS-valid line
// layout the nightly export produces. We keep it client-only (no export API
// endpoint) — usfm-js is already bundled (web/package.json) and every verse's
// content_json is already in hand via useChapter / api.getChapter.

import usfm from "usfm-js";
import type { VerseDto } from "../sync/api.ts";
import { normalizeUsfmFormatting } from "./usfmFormat.ts";

// Mirror of buildUsfm's target-occurrence heal (api/src/export.ts). Renumbers
// target `\w` occurrence/occurrences from document position so a stale stored
// row never ships invalid USFM. Source `\zaln-s` occurrence lives on the
// milestone, not on `\w`, so it is untouched. No-op on clean verses. Mutates in
// place. Only meaningful for the aligned ULT/UST variant.
function recomputeTargetOccurrences(verseObjects: unknown[]): void {
  if (!Array.isArray(verseObjects)) return;
  const words: Array<Record<string, unknown>> = [];
  const collect = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        words.push(o);
      } else if (Array.isArray(o["children"])) {
        collect(o["children"] as unknown[]);
      }
    }
  };
  collect(verseObjects);
  const totals = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const running = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    const n = (running.get(key) ?? 0) + 1;
    running.set(key, n);
    w["occurrence"] = String(n);
    w["occurrences"] = String(totals.get(key) ?? 1);
  }
}

// Deep-clone a verseObjects subtree while removing alignment structure:
//   - `\zaln` milestones are dropped, their children spliced in place
//     (recursively unwrapped — milestones nest for compound alignments).
//   - `\w` word nodes are replaced by a bare `{type:"text", text}` node.
// Every other node (paragraph/poetry markers, section headers, footnotes,
// plain text, character wrappers like \qs) is preserved, recursing into any
// children. Whitespace text nodes that separate words in the source tree are
// preserved as-is, so flattened words stay space-separated.
function stripAlignmentNodes(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      out.push(node);
      continue;
    }
    const o = node as Record<string, unknown>;
    // Alignment milestone → unwrap: keep only its (stripped) children.
    if (o["type"] === "milestone" && o["tag"] === "zaln") {
      if (Array.isArray(o["children"])) out.push(...stripAlignmentNodes(o["children"] as unknown[]));
      continue;
    }
    // Word → bare text. Drops strong/lemma/morph/occurrence attrs. A normal `\w`
    // always carries string text; a malformed one with children instead is still
    // preserved by recursing rather than silently dropped.
    if (o["type"] === "word" && o["tag"] === "w") {
      if (typeof o["text"] === "string") out.push({ type: "text", text: o["text"] });
      else if (Array.isArray(o["children"])) out.push(...stripAlignmentNodes(o["children"] as unknown[]));
      continue;
    }
    // Anything else: keep, recursing into children.
    if (Array.isArray(o["children"])) {
      out.push({ ...o, children: stripAlignmentNodes(o["children"] as unknown[]) });
    } else {
      out.push(o);
    }
  }
  return out;
}

// Minimal USFM headers, mirroring synthesizeHeaders in api/src/export.ts. The
// client has no access to book_usfm_meta.headers_json, so we synthesize the
// same shape the nightly export falls back to.
function synthesizeHeaders(book: string, bibleVersion: string): unknown[] {
  return [
    { tag: "id", content: `${book} ${bibleVersion} — bible-editor export` },
    { tag: "usfm", content: "3.0" },
    { tag: "ide", content: "UTF-8" },
    { tag: "h", content: book },
    { tag: "toc1", content: book },
    { tag: "toc2", content: book },
    { tag: "toc3", content: book.toLowerCase() },
    { tag: "mt1", content: book },
  ];
}

export interface BuildUsfmOptions {
  aligned: boolean;
}

// Render a set of verses (one bible version, one or more chapters) to a USFM
// string. Verses may span chapters — they are grouped by chapter and emitted in
// order. `verse === 0` is the chapter-front pseudo-verse (usfm-js key "front");
// multi-verse blocks (verse_end > verse) round-trip via the "N-M" key.
export function buildUsfmFromVerses(
  book: string,
  bibleVersion: string,
  verses: VerseDto[],
  { aligned }: BuildUsfmOptions,
): string {
  const bv = bibleVersion.toUpperCase();
  const isTarget = bv === "ULT" || bv === "UST";
  const chapters: Record<string, Record<string, unknown>> = {};

  const sorted = [...verses].sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  for (const v of sorted) {
    const content = v.content as { verseObjects?: unknown[] } | null;
    let verseObjects = Array.isArray(content?.verseObjects) ? content!.verseObjects : [];
    if (aligned) {
      // Clone so the occurrence heal never mutates the cached DTO.
      verseObjects = structuredClone(verseObjects);
      if (isTarget) recomputeTargetOccurrences(verseObjects);
    } else {
      // Clone first: stripAlignmentNodes pushes leaf nodes it doesn't transform
      // (anything that isn't a \zaln milestone or \w word) through by reference,
      // and usfm.toUSFM mutates those nodes in place (trims/deletes text props),
      // which would otherwise rewrite the cached verse DTO as a side effect.
      verseObjects = stripAlignmentNodes(structuredClone(verseObjects));
    }
    const ch = String(v.chapter);
    if (!chapters[ch]) chapters[ch] = {};
    // Keyed by verseKey, so if a range row (verse_end > verse) is passed more than
    // once — the caller may hand us a component-expanded index keyed under every
    // verse in the span — the duplicates collapse to the same "N-M" key rather
    // than emitting twice. (ChapterPayload.verses is keyed by lead verse, so in
    // practice each row arrives once; this makes the function order/dup-safe.)
    const verseKey =
      v.verse === 0
        ? "front"
        : v.verse_end != null && v.verse_end > v.verse
          ? `${v.verse}-${v.verse_end}`
          : String(v.verse);
    chapters[ch][verseKey] = { verseObjects };
  }

  const headers = synthesizeHeaders(book, bibleVersion);
  const rendered = usfm.toUSFM({ headers, chapters } as unknown as { chapters: Record<string, unknown> }, {
    forcedNewLines: true,
  });
  // normalizeUsfmFormatting's blank-line pass treats everything up to the first
  // blank line as header (so it doesn't wedge blanks between \id/\h/\toc). Real
  // DCS headers end with a blank line before the body; our synthesized ones don't,
  // so insert that separator before the first \c — otherwise the whole file reads
  // as "header" and the body reflow is skipped. Idempotent (skips if already blank).
  const withHeaderBreak = rendered.replace(/([^\n])\n(\\c\s+\d+)/, "$1\n\n$2");
  // Reflow to the DCS Check-8 line layout (blank lines, own-line markers, one \v
  // per line, \ts* repair) so the download matches the nightly export. Inert
  // whitespace/marker moves only — alignment untouched. See usfmFormat.ts.
  return normalizeUsfmFormatting(withHeaderBreak);
}

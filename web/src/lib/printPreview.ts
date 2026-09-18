// "Print preview": typeset HTML for one or more chapters of a single bible
// version, so a translator can see what the nightly export will look like on
// Door43 *before* it lands there (the DCS/Preview-app view is otherwise a day
// behind every save).
//
// Door43 renders scripture with Proskomma → SOFRIA → HTML
// (unfoldingWord/door43-preview-renderers, src/renderers/alignedBibleRenderer.js).
// We do not pull that stack in (graphql + cheerio + @babel/core, and it needs
// Node-global shims under Vite); instead this emits the SAME element/class
// shape its renderer produces — `<p class="paras_usfm_q2">`,
// `<span class="marks_verses_label">`, `<span class="wrappers_usfm_nd">` — and
// PRINT_PREVIEW_CSS below is that renderer's stylesheet (proskomma-json-tools
// `renderStyles` + its `extraWebCss`), copied from its rendered output and
// scoped. So indents, blank lines and chapter/verse numbers follow Door43's
// rules, not our own guesses. Known divergences: it is a different parser, so
// exotic USFM may differ; `\qs Selah` is floated right (Door43 only italicises
// it).
//
// Markers mode (Paratext's "standard" view): every block, verse, chapter,
// character wrapper and footnote also carries its USFM marker in a tiny grey
// `usfm-marker` span. The spans are always emitted and hidden by CSS; the
// `show-markers` class on the root reveals them, so the same HTML serves both
// looks and the print/new-tab document keeps whichever the user chose.
//
// Walker shape mirrors chapterCopy.ts: verses in document order; an in-flow
// marker closes the current block and opens the next. Because usfm-js attaches
// a verse's leading \q to the PREVIOUS verse's trailing objects, sequential
// processing lands each verse number at the start of its own line with no
// drift handling. Alignment (\zaln/\w) is flattened to text; \ts\* and \s5
// chunk dividers are invisible except as markers (Door43 strips \s5 too).

import type { VerseDto } from "../sync/api.ts";
import { PARAGRAPH_TAGS, isInFlowMarker, isCharacterWrapper, isTsMilestone } from "./usfm.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Marker tags come from stored data; only a plain marker name may reach a class
// attribute. Anything else (a malformed tag) degrades to "x" rather than
// breaking out of the attribute.
function safeTag(tag: string): string {
  return /^[a-z][a-z0-9]*$/.test(tag) ? tag : "x";
}

// Class suffix Door43 uses: Proskomma normalizes the "1" level away
// (\q1 → q, \s1 → s, \mt1 → mt, \li1 → li, \pi1 → pi); deeper levels keep it.
function usfmClass(tag: string): string {
  return safeTag(tag).replace(/^([a-z]+)1$/, "$1");
}

// The tiny grey marker label of Markers mode. `text` is the literal USFM
// (`\p`, `\v`, `\nd*`), shown verbatim.
function marker(text: string): string {
  return `<span class="usfm-marker">${escapeHtml(text)}</span>`;
}

// Heading-style paragraph markers → HTML heading level, from
// proskomma-json-tools sofria2html.js `paragraph`. Everything else is <p>.
function htmlTagFor(cls: string): string {
  if (["s", "ms", "imt", "imte", "mt"].includes(cls)) return "h1";
  if (["s2", "ms2", "imt2", "imte2", "mt2", "mr", "sr"].includes(cls)) return "h2";
  if (["s3", "ms3", "imt3", "imte3", "mt3", "r", "d"].includes(cls)) return "h3";
  if (["s4", "ms4", "imt4", "imte4", "mt4"].includes(cls)) return "h4";
  return "p";
}

// usfm-js parks a heading's text on `content` (`\s1` → {type:"section",
// content}); `\d` and friends arrive as a bare marker followed by ordinary
// text/word nodes. Either way they open a block of their own.
const HEADING_TAGS: ReadonlySet<string> = new Set([
  "s", "s1", "s2", "s3", "s4", "ms", "ms1", "ms2", "ms3", "mr", "sr", "r", "d", "sp", "cl", "qa",
]);
// Headings that never host the chapter number. `\d` (Psalm superscription) is
// deliberately absent so a Psalm's number lands beside its title, as on Door43.
const SECTION_HEADING_TAGS: ReadonlySet<string> = new Set([...HEADING_TAGS].filter((t) => t !== "d"));

// Chunk dividers: never rendered as content. `\s5` is the legacy chunk marker
// Door43 strips (`usfm.replace(/\\s5 *\n/g, '')`); `\ts\*` is its replacement.
function isChunkDivider(o: Record<string, unknown>): boolean {
  return isTsMilestone(o) || o["tag"] === "s5";
}

// Implied-word braces `{…}`, rendered like Door43 outside editor mode: the
// braces are hidden and the word shown in grey. Markers mode shows the braces.
function impliedWords(escaped: string): string {
  return escaped
    .replace(/\{/g, '<span class="implied-word"><span class="implied-word-start">{</span><span class="implied-word-text">')
    .replace(/\}/g, '</span><span class="implied-word-end">}</span></span>');
}

// Footnote body: `+ \ft text \fqa quoted\fqa* text` → inline HTML with the
// caller dropped and \fq/\fqa/\fk quotes wrapped like Door43 does. Every inner
// marker survives as a Markers-mode label.
function footnoteHtml(content: string): string {
  const m = /^\s*([+\-*?]?)\s*([\s\S]*)$/.exec(content);
  const caller = m ? m[1] : "";
  let s = escapeHtml(m ? m[2] : content);
  // One pass: a closed quote pair becomes a styled span between its labels;
  // any other marker (\ft, an unclosed \fq …) becomes a label only. A single
  // pass so the labels' own `\fqa` text is never re-matched.
  s = s.replace(
    /\\(fqa|fq|fk|fr)\s+([\s\S]*?)\\\1\*|\\([a-z]+\d?\*?)\s?/g,
    (_m, pair: string | undefined, body: string, lone: string | undefined) =>
      pair !== undefined
        ? `${marker(`\\${pair}`)}<span class="wrappers_usfm_${pair}">${body}</span>${marker(`\\${pair}*`)}`
        : marker(`\\${lone}`),
  );
  const open = marker(caller ? `\\f ${caller}` : "\\f");
  return `<span class="paras_usfm_f footnote">${open}${s.trim()}${marker("\\f*")}</span>`;
}

// usfm-js parks the whitespace that follows a closed marker (`\f*`, `\nd*`) on
// the node's `nextChar`, and the next text node starts without it. Without this
// the word after a footnote glues to it.
function trailing(o: Record<string, unknown>): string {
  return typeof o["nextChar"] === "string" ? escapeHtml(o["nextChar"] as string) : "";
}

// Inline HTML for one content node (text, flattened word, character wrapper,
// footnote), recursing through alignment milestones and wrappers.
function inlineHtml(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  const tag = typeof o["tag"] === "string" ? (o["tag"] as string) : null;
  if (tag && o["type"] === "footnote" && typeof o["content"] === "string") {
    return footnoteHtml(o["content"] as string) + trailing(o);
  }
  let inner = typeof o["text"] === "string" ? impliedWords(escapeHtml(o["text"] as string)) : "";
  if (Array.isArray(o["children"])) inner += (o["children"] as unknown[]).map(inlineHtml).join("");
  // Character-style wrapper (\qs Selah\qs*, \add …\add*, \nd LORD\nd*): Door43
  // wraps these in a styled span. \zaln/\w carry no endTag, so alignment
  // structure passes through as bare text.
  if (tag && tag !== "w" && tag !== "zaln" && (typeof o["endTag"] === "string" || isCharacterWrapper(o))) {
    const cls = usfmClass(tag);
    return `<span class="wrappers_usfm_${cls}">${marker(`\\${safeTag(tag)}`)}${inner}${marker(`\\${safeTag(tag)}*`)}</span>${trailing(o)}`;
  }
  return inner;
}

interface Block {
  tag: string;
  parts: string[];
}

export interface PrintPreviewInput {
  book: string;
  bibleVersion: string;
  verses: VerseDto[];
}

// Render verses (one version, one or more chapters) to the Door43 HTML shape.
// Returns the inner HTML; wrap it in `<div class="print-preview">` (plus
// `show-markers` for Markers mode) with PRINT_PREVIEW_CSS applied.
export function renderPrintPreviewHtml({ verses }: PrintPreviewInput): string {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  // The chapter number is emitted inline as the first child of the first
  // paragraph after \c that receives content (Door43 puts it inline too), never
  // as its own block. Held here until then — an empty `\p` ahead of a
  // chapter-opening `\s1` (ZEC 13 UST: `\c 13 \p \s1 … \v 1`) must not
  // swallow it, and a section heading never hosts it.
  let pendingChapter: number | null = null;

  const open = (tag: string): void => {
    cur = { tag, parts: [] };
    blocks.push(cur);
  };
  // `isContent` false = a label only (a chunk divider's marker), which must not
  // count as the paragraph content that pulls the chapter number in.
  const emit = (html: string, isContent = true): void => {
    if (html === "") return;
    if (!cur) open("p");
    if (isContent && pendingChapter !== null && !SECTION_HEADING_TAGS.has(cur!.tag)) {
      cur!.parts.push(`<span class="marks_chapter_label">${marker("\\c")}${pendingChapter}</span>`);
      pendingChapter = null;
    }
    cur!.parts.push(html);
  };

  // Dedupe by (chapter, verse): a multi-verse range row may arrive keyed under
  // every verse in its span. Verse 0 is the chapter-front pseudo-verse
  // (\s1 heading, Psalm \d superscription) — real content, no verse number.
  const byKey = new Map<string, VerseDto>();
  for (const v of verses) {
    const k = `${v.chapter}:${v.verse}`;
    if (!byKey.has(k)) byKey.set(k, v);
  }
  const sorted = [...byKey.values()].sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);

  let chapter = -1;
  for (const v of sorted) {
    if (v.chapter !== chapter) {
      chapter = v.chapter;
      cur = null;
      pendingChapter = chapter;
    }
    const content = v.content as { verseObjects?: unknown[] } | null;
    const vos = Array.isArray(content?.verseObjects) ? content!.verseObjects : [];
    // Defer the verse number until the verse's first real content, so a verse
    // whose own objects START with \p/\q gets its number on the new line, not
    // stranded at the end of the previous one.
    let pendingLabel: string | null =
      v.verse === 0
        ? null
        : v.verse_end != null && v.verse_end > v.verse
          ? `${v.verse}-${v.verse_end}`
          : String(v.verse);
    const flushLabel = (): void => {
      if (pendingLabel === null) return;
      emit(`<span class="marks_verses_label">${marker("\\v")}${pendingLabel}</span>`);
      pendingLabel = null;
    };
    const emitContent = (html: string): void => {
      if (html === "") return;
      if (/\S/.test(html)) flushLabel();
      emit(html);
    };

    for (const node of vos) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const tag = typeof o["tag"] === "string" ? (o["tag"] as string) : "";
      if (isChunkDivider(o)) {
        // Invisible in reading; Markers mode still shows where the chunk is.
        emit(marker(tag === "s5" ? "\\s5" : "\\ts\\*"), false);
        continue;
      }
      const isHeading = HEADING_TAGS.has(tag) && !isCharacterWrapper(o);
      // Line markers are matched by TAG as well as by usfm-js `type`: the raw
      // parse gives `\qm1` and the `\li` family no `type` at all (verified
      // against usfm-js 3.5), so a type-only test drops the line and glues or
      // loses its text.
      if (isHeading || ((PARAGRAPH_TAGS.has(tag) || isInFlowMarker(o)) && !isCharacterWrapper(o))) {
        open(tag);
        // Heading text usfm-js parked on `content`; leading punctuation (or a
        // whole bare line, `\li1 item`) it parked on the marker's own `text` /
        // `content` is verse content (see usfm.ts liftMarkerText).
        for (const key of ["content", "text"]) {
          if (typeof o[key] !== "string") continue;
          // Not trimmed: a trailing space here separates the marker's own text
          // from the words that follow; block assembly collapses whitespace.
          const t = impliedWords(escapeHtml(o[key] as string));
          // A heading's label (\qa Aleph, \s1 …) must not pull the pending verse
          // number into the heading; a line marker's text is verse content.
          if (isHeading) emit(t);
          else emitContent(t);
        }
        // A heading that carried its own text is complete: verse text that
        // follows without a \p of its own (ZEC 13 UST: `\s1 … \v 1`) must open
        // a fresh paragraph, not flow into the <h1>. A bare \d stays open — its
        // title is the ordinary text that follows it.
        if (isHeading && (typeof o["content"] === "string" || typeof o["text"] === "string")) cur = null;
        continue;
      }
      emitContent(inlineHtml(o));
    }
    // A verse with no textual content still surfaces its number.
    flushLabel();
  }

  // Empty blocks are kept on purpose: an empty `\p` between two poetry
  // stanzas is what produces the blank line before the next stanza's first
  // `\q` (its 1em paragraph margin beats the 0.5ex poetry margin), exactly
  // as Proskomma's empty paragraph does on Door43.
  return blocks
    .map((b) => {
      const cls = usfmClass(b.tag);
      const el = htmlTagFor(cls);
      // Collapse the newlines usfm-js parks in text nodes — line breaks are
      // structural (blocks), never text.
      const body = b.parts.join("").replace(/\s+/g, " ").trim();
      return `<${el} class="paras_usfm_${cls}">${marker(`\\${safeTag(b.tag)}`)}${body}</${el}>`;
    })
    .join("\n");
}

// Stylesheet, copied from the rendered output of door43-preview-renderers'
// alignedBibleRenderer (proskomma-json-tools `renderStyles.styleAsCSS` + its
// `extraWebCss`), with empty rules dropped and every selector scoped under
// `.print-preview` so nothing leaks into the editor. Page-level rules and the
// Markers-mode rules at the end are ours. Kept on a white page in both color
// modes: it previews paper.
export const PRINT_PREVIEW_CSS = `
.print-preview { font-family: "Times New Roman", Times, serif; font-size: 1.05rem; color: #111; background: #fff; padding: 2rem 2.5rem; max-width: 46rem; margin: 0 auto; }
.print-preview .print-preview-title { text-align: center; font-size: 1.3em; margin: 0 0 1.5em; color: #495057; }

/* proskomma-json-tools renderStyles, as Door43 renders with it */
.print-preview .paras_default { font-size: medium; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_d { font-style: italic; }
.print-preview .paras_usfm_f { font-size: small; }
.print-preview .paras_usfm_imt { font-weight: bold; font-style: italic; font-size: xx-large; text-align: center; }
.print-preview .paras_usfm_imt2 { font-weight: bold; font-style: italic; font-size: x-large; text-align: center; }
.print-preview .paras_usfm_imt3 { font-weight: bold; font-style: italic; font-size: large; text-align: center; }
.print-preview .paras_usfm_imte { font-weight: bold; font-style: italic; font-size: xx-large; text-align: center; }
.print-preview .paras_usfm_io { padding-left: 1.5em; }
.print-preview .paras_usfm_io2 { padding-left: 3em; }
.print-preview .paras_usfm_ip { text-indent: 1.5em; }
.print-preview .paras_usfm_is { font-weight: bold; font-size: x-large; }
.print-preview .paras_usfm_is2 { font-weight: bold; font-size: large; }
.print-preview .paras_usfm_li { list-style-type: disc; padding-left: 3em; text-indent: -1.5em; }
.print-preview .paras_usfm_li2 { list-style-type: disc; padding-left: 4.5em; text-indent: -1.5em; }
.print-preview .paras_usfm_li3 { list-style-type: disc; padding-left: 6em; text-indent: -1.5em; }
.print-preview .paras_usfm_mi { padding-left: 1.5em; }
.print-preview .paras_usfm_mr { font-size: large; font-style: italic; }
.print-preview .paras_usfm_ms { font-size: large; font-weight: bold; }
.print-preview .paras_usfm_ms2 { font-weight: bold; }
.print-preview .paras_usfm_mt { font-weight: bold; font-style: italic; font-size: xx-large; text-align: center; }
.print-preview .paras_usfm_mt2 { font-weight: bold; font-style: italic; font-size: x-large; text-align: center; }
.print-preview .paras_usfm_mt3 { font-weight: bold; font-style: italic; font-size: large; text-align: center; }
.print-preview .paras_usfm_p { text-indent: 1.5em; }
.print-preview .paras_usfm_pc { text-align: center; }
.print-preview .paras_usfm_pi { padding-left: 1.5em; text-indent: 1.5em; }
.print-preview .paras_usfm_pi2 { padding-left: 3em; text-indent: 1.5em; }
.print-preview .paras_usfm_pi3 { padding-left: 4.5em; text-indent: 1.5em; }
.print-preview .paras_usfm_q { padding-left: 1.5em; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_q2 { padding-left: 3em; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_q3 { padding-left: 4.5em; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_q4 { padding-left: 6em; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_qa { font-weight: bold; font-size: x-large; }
.print-preview .paras_usfm_qr { text-align: right; }
.print-preview .paras_usfm_r { font-weight: bold; }
.print-preview .paras_usfm_s { font-style: italic; font-size: xx-large; }
.print-preview .paras_usfm_s2 { font-style: italic; font-size: x-large; }
.print-preview .paras_usfm_s3 { font-style: italic; font-size: large; }
.print-preview .paras_usfm_sr { font-size: large; }
.print-preview .paras_usfm_x { font-size: small; }
.print-preview .marks_chapter_label { font-size: xx-large; margin-right: 0.5em; }
.print-preview .marks_verses_label { font-weight: bold; font-size: small; vertical-align: super; margin-right: 0.5em; }
.print-preview .wrappers_usfm_add { font-style: italic; }
.print-preview .wrappers_usfm_bd { font-weight: bold; }
.print-preview .wrappers_usfm_bdit { font-weight: bold; font-style: italic; }
.print-preview .wrappers_usfm_bk { font-weight: bold; }
.print-preview .wrappers_usfm_fq { font-style: italic; }
.print-preview .wrappers_usfm_fqa { font-style: italic; }
.print-preview .wrappers_usfm_fr { font-weight: bold; }
.print-preview .wrappers_usfm_it { font-style: italic; }
.print-preview .wrappers_usfm_nd { font-weight: bold; font-size: smaller; text-transform: uppercase; }
.print-preview .wrappers_usfm_sc { font-size: smaller; text-transform: uppercase; }
.print-preview .wrappers_usfm_tl { font-style: italic; }
.print-preview .wrappers_usfm_wj { color: #D00; }
.print-preview .wrappers_usfm_xo { font-weight: bold; }
/* alignedBibleRenderer extraWebCss */
.print-preview .footnote { padding-left: 0.5em; padding-right: 0.5em; background-color: #ccc; margin-top: 1em; margin-bottom: 1em; }
.print-preview .implied-word-text { color: #999; font-weight: bold; font-size: 0.9em; }
.print-preview .implied-word-start, .print-preview .implied-word-end { display: none; }

/* Ours: Selah sits at the right margin (Door43 only italicises it). */
.print-preview .wrappers_usfm_qs { float: right; font-style: italic; margin-left: 1em; }

/* Markers mode (Paratext "standard" view): tiny grey USFM labels inline. */
.print-preview .usfm-marker { display: none; }
.print-preview.show-markers .usfm-marker { display: inline; font-family: "Times New Roman", Times, serif; font-size: 0.6em; font-weight: normal; font-style: normal; text-transform: none; vertical-align: baseline; color: #8a8a8a; margin-right: 0.25em; white-space: nowrap; }
.print-preview.show-markers .marks_verses_label .usfm-marker { font-size: 0.85em; margin-right: 0.15em; }
.print-preview.show-markers .marks_chapter_label .usfm-marker { font-size: 0.45em; vertical-align: middle; }
.print-preview.show-markers .paras_usfm_f .usfm-marker { color: #666; }
.print-preview.show-markers .implied-word-start, .print-preview.show-markers .implied-word-end { display: inline; color: #999; }

@media print {
  @page { margin: 20mm 25mm; }
  .print-preview { max-width: none; padding: 0; font-size: 11pt; }
  .print-preview h1, .print-preview h2, .print-preview h3 { break-after: avoid; }
}
`;

// Standalone document (used for the print window / "open in new tab") — the
// same HTML and CSS the inline preview shows.
export function buildPrintPreviewDocument(title: string, bodyHtml: string, showMarkers = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; background: #fff; }
${PRINT_PREVIEW_CSS}
</style>
</head>
<body>
<div class="print-preview${showMarkers ? " show-markers" : ""}">
<h2 class="print-preview-title">${escapeHtml(title)}</h2>
${bodyHtml}
</div>
</body>
</html>`;
}

// "Print preview": typeset HTML for one or more chapters of a single bible
// version, so a translator can see what the nightly export will look like on
// Door43 *before* it lands there (the DCS/Preview-app view is otherwise a day
// behind every save).
//
// The Door43 preview app renders scripture with Proskomma → SOFRIA → HTML
// (door43-preview-app/src/components/Bible.jsx). We do not pull that stack in
// (graphql + cheerio + @babel/core, and it needs Node-global shims under Vite);
// instead this emits the SAME element/class shape its renderer produces —
// `<p class="paras_usfm_q2">`, `<span class="marks_verses_label">`,
// `<span class="wrappers_usfm_qs">` — and PRINT_PREVIEW_CSS below is that app's
// stylesheet (proskomma-json-tools renderStyles + Bible.jsx webCss), copied
// verbatim where it matters. So indents, blank lines, drop-cap chapter numbers
// and Selah placement follow the Preview app's rules, not our own guesses.
// Known divergence: it is a different parser, so exotic USFM may differ.
//
// Walker shape mirrors chapterCopy.ts: verses in document order; an in-flow
// marker closes the current block and opens the next. Because usfm-js attaches
// a verse's leading \q to the PREVIOUS verse's trailing objects, sequential
// processing lands each verse number at the start of its own line with no
// drift handling. Alignment (\zaln/\w) is flattened to text; \ts\* and \s5
// chunk dividers are invisible (the Preview app strips \s5 too).

import type { VerseDto } from "../sync/api.ts";
import { isInFlowMarker, isCharacterWrapper, isTsMilestone } from "./usfm.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Class suffix the Preview app uses: Proskomma normalizes the "1" level away
// (\q1 → q, \s1 → s, \mt1 → mt, \li1 → li, \pi1 → pi); deeper levels keep it.
function usfmClass(tag: string): string {
  return tag.replace(/^([a-z]+)1$/, "$1");
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
// Headings that never host the chapter drop-cap. `\d` (Psalm superscription)
// is deliberately absent: the Preview app's poetry CSS parks the chapter number
// beside a \d, so a Psalm's number lands where it does there.
const SECTION_HEADING_TAGS: ReadonlySet<string> = new Set([...HEADING_TAGS].filter((t) => t !== "d"));

// Chunk dividers: never rendered. `\s5` is the legacy chunk marker the Preview
// app strips (`usfm.replace(/\\s5 *\n/g, '')`); `\ts\*` is its replacement.
function isChunkDivider(o: Record<string, unknown>): boolean {
  return isTsMilestone(o) || o["tag"] === "s5";
}

// Implied-word braces `{…}`, rendered like the Preview app outside editor
// mode: the braces are hidden and the word shown in grey.
function impliedWords(escaped: string): string {
  return escaped
    .replace(/\{/g, '<span class="implied-word"><span class="implied-word-start">{</span><span class="implied-word-text">')
    .replace(/\}/g, '</span><span class="implied-word-end">}</span></span>');
}

// Footnote body: `+ \ft text \fqa quoted\fqa* text` → inline HTML with the
// caller dropped and \fq/\fqa/\fk quotes wrapped like the Preview app does.
function footnoteHtml(content: string): string {
  let s = content.replace(/^\s*[+\-*?]\s*/, "");
  s = escapeHtml(s);
  s = s.replace(/\\(fqa|fq|fk|fr)\s+([\s\S]*?)\\\1\*/g, (_m, tag: string, body: string) =>
    `<span class="wrappers_usfm_${tag}">${body}</span>`);
  s = s.replace(/\\[a-z]+\d?\*?\s?/g, "");
  return `<span class="paras_usfm_f">${s.trim()}</span>`;
}

// Inline HTML for one content node (text, flattened word, character wrapper,
// footnote), recursing through alignment milestones and wrappers.
function inlineHtml(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  const tag = typeof o["tag"] === "string" ? (o["tag"] as string) : null;
  if (tag && o["type"] === "footnote" && typeof o["content"] === "string") {
    return footnoteHtml(o["content"] as string);
  }
  let inner = typeof o["text"] === "string" ? impliedWords(escapeHtml(o["text"] as string)) : "";
  if (Array.isArray(o["children"])) inner += (o["children"] as unknown[]).map(inlineHtml).join("");
  // Character-style wrapper (\qs Selah\qs*, \add …\add*, \nd LORD\nd*): the
  // Preview app wraps these in a styled span. \zaln/\w carry no endTag, so
  // alignment structure passes through as bare text.
  if (tag && tag !== "w" && tag !== "zaln" && (typeof o["endTag"] === "string" || isCharacterWrapper(o))) {
    return `<span class="wrappers_usfm_${usfmClass(tag)}">${inner}</span>`;
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

// Render verses (one version, one or more chapters) to the Preview-app HTML
// shape. Returns the inner HTML; wrap it in `<div class="print-preview">` with
// PRINT_PREVIEW_CSS applied.
export function renderPrintPreviewHtml({ verses }: PrintPreviewInput): string {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  // The chapter number is emitted inline as the first child of the first
  // paragraph after \c that receives content (the Preview app's drop-cap),
  // never as its own block. Held here until then — an empty `\p` ahead of a
  // chapter-opening `\s1` (ZEC 13 UST: `\c 13 \p \s1 …  1`) must not
  // swallow it, and a section heading never hosts it.
  let pendingChapter: number | null = null;

  const open = (tag: string): void => {
    cur = { tag, parts: [] };
    blocks.push(cur);
  };
  const emit = (html: string): void => {
    if (html === "") return;
    if (!cur) open("p");
    if (pendingChapter !== null && !SECTION_HEADING_TAGS.has(cur!.tag)) {
      cur!.parts.push(`<span class="marks_chapter_label">${pendingChapter}</span>`);
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
      emit(`<span class="marks_verses_label">${pendingLabel}</span>`);
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
      if (isChunkDivider(o)) continue;
      const isHeading = HEADING_TAGS.has(tag) && !isCharacterWrapper(o);
      if (isHeading || (isInFlowMarker(o) && !isCharacterWrapper(o))) {
        open(tag);
        // Heading text usfm-js parked on `content`; leading punctuation it parked
        // on the marker's own `text` (a real opening quote — see usfm.ts
        // liftMarkerText) is content too.
        if (typeof o["content"] === "string") emit(impliedWords(escapeHtml((o["content"] as string).trim())));
        if (typeof o["text"] === "string") {
          const t = impliedWords(escapeHtml(o["text"] as string));
          // A heading's label (\qa Aleph) must not pull the pending verse number
          // into the heading; an in-flow marker's leading quote is verse content.
          if (isHeading) emit(t);
          else emitContent(t);
        }
        // A heading that carried its own text is complete: verse text that
        // follows without a \p of its own (ZEC 13 UST: `\s1 …  1`) must open
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
  // as Proskomma's empty paragraph does in the Preview app.
  return blocks
    .map((b) => {
      const cls = usfmClass(b.tag);
      const el = htmlTagFor(cls);
      // Collapse the newlines usfm-js parks in text nodes — line breaks are
      // structural (blocks), never text.
      const body = b.parts.join("").replace(/\s+/g, " ").trim();
      return `<${el} class="paras_usfm_${cls}">${body}</${el}>`;
    })
    .join("\n");
}

// Stylesheet: proskomma-json-tools `renderStyles` base rules (the values the
// Preview app actually renders with) followed by the Bible-specific overrides
// from door43-preview-app Bible.jsx `webCss` — including its poetry gutter
// layout, which parks leading verse numbers in one column and the chapter
// drop-cap to its left. Scoped under `.print-preview` so it cannot leak into
// the editor. Kept on a white page in both color modes: it previews paper.
export const PRINT_PREVIEW_CSS = `
.print-preview { font-family: "Noto Serif", "Charis SIL", Georgia, "Times New Roman", serif; font-size: 1.05rem; line-height: 1.6; color: #111; background: #fff; padding: 2rem 2.5rem; max-width: 46rem; margin: 0 auto; }
.print-preview h1, .print-preview h2, .print-preview h3, .print-preview h4 { color: #495057; margin-top: 1.5em; margin-bottom: 0.5em; font-weight: bold; line-height: 1.2; }
.print-preview h1 { font-size: 2em; padding-bottom: 0.3em; }
.print-preview h2 { font-size: 1.5em; }
.print-preview h3 { font-size: 1.25em; }
.print-preview p { margin: 1em 0; line-height: 1.6; }
.print-preview .print-preview-title { text-align: center; font-size: 1.3em; margin: 0 0 1.5em; color: #495057; }

/* proskomma-json-tools renderStyles (base) */
.print-preview .paras_usfm_b   { height: 1em; }
.print-preview .paras_usfm_d   { font-style: italic; }
.print-preview .paras_usfm_f   { font-size: small; }
.print-preview .paras_usfm_li  { list-style-type: disc; padding-left: 3em;   text-indent: -1.5em; }
.print-preview .paras_usfm_li2 { list-style-type: disc; padding-left: 4.5em; text-indent: -1.5em; }
.print-preview .paras_usfm_li3 { list-style-type: disc; padding-left: 6em;   text-indent: -1.5em; }
.print-preview .paras_usfm_mi  { padding-left: 1.5em; }
.print-preview .paras_usfm_mr  { font-size: large; font-style: italic; }
.print-preview .paras_usfm_ms  { font-size: large; font-weight: bold; }
.print-preview .paras_usfm_ms2 { font-weight: bold; }
.print-preview .paras_usfm_mt  { font-weight: bold; font-style: italic; font-size: xx-large; text-align: center; }
.print-preview .paras_usfm_mt2 { font-weight: bold; font-style: italic; font-size: x-large;  text-align: center; }
.print-preview .paras_usfm_mt3 { font-weight: bold; font-style: italic; font-size: large;    text-align: center; }
.print-preview .paras_usfm_p   { text-indent: 1.5em; }
.print-preview .paras_usfm_pc  { text-align: center; }
.print-preview .paras_usfm_pi  { padding-left: 1.5em; text-indent: 1.5em; }
.print-preview .paras_usfm_pi2 { padding-left: 3em;   text-indent: 1.5em; }
.print-preview .paras_usfm_pi3 { padding-left: 4.5em; text-indent: 1.5em; }
.print-preview .paras_usfm_q   { padding-left: 1.5em; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_q2  { padding-left: 3em;   margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_q3  { padding-left: 4.5em; margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_q4  { padding-left: 6em;   margin-top: 0.5ex; margin-bottom: 0.5ex; }
.print-preview .paras_usfm_qa  { font-weight: bold; font-size: x-large; }
.print-preview .paras_usfm_qr  { text-align: right; }
.print-preview .paras_usfm_r   { font-weight: bold; }
.print-preview .paras_usfm_s   { font-style: italic; font-size: xx-large; }
.print-preview .paras_usfm_s2  { font-style: italic; font-size: x-large; }
.print-preview .paras_usfm_s3  { font-style: italic; font-size: large; }
.print-preview .paras_usfm_sr  { font-size: large; }
.print-preview .marks_chapter_label { float: left; font-size: xx-large; margin-right: 0.5em; }
.print-preview .marks_verses_label  { font-weight: bold; font-size: small; vertical-align: super; margin-right: 0.5em; }
.print-preview .wrappers_usfm_add  { font-style: italic; }
.print-preview .wrappers_usfm_bd   { font-weight: bold; }
.print-preview .wrappers_usfm_bdit { font-weight: bold; font-style: italic; }
.print-preview .wrappers_usfm_bk   { font-weight: bold; }
.print-preview .wrappers_usfm_fq, .print-preview .wrappers_usfm_fqa { font-style: italic; }
.print-preview .wrappers_usfm_fr   { font-weight: bold; }
.print-preview .wrappers_usfm_it   { font-style: italic; }
.print-preview .wrappers_usfm_nd   { font-weight: bold; font-size: smaller; text-transform: uppercase; }
.print-preview .wrappers_usfm_qs   { float: right; font-style: italic; }
.print-preview .wrappers_usfm_sc   { font-size: smaller; text-transform: uppercase; }
.print-preview .wrappers_usfm_tl   { font-style: italic; }
.print-preview .wrappers_usfm_wj   { color: #D00; }
.print-preview .paras_usfm_f { padding-left: 0.5em; padding-right: 0.5em; background-color: #CCC; margin-top: 1em; margin-bottom: 1em; }
.print-preview .implied-word-text { color: #999; font-weight: bold; font-size: 0.9em; }
.print-preview .implied-word-start, .print-preview .implied-word-end { display: none; }

/* door43-preview-app Bible.jsx webCss overrides */
.print-preview .paras_usfm_d { font-size: 1em !important; }
.print-preview .paras_usfm_p:has(.marks_chapter_label) { padding-left: 0 !important; text-indent: 0 !important; }

/* Poetry hanging-indent alignment (verbatim from Bible.jsx):
   body-text x = c-gutter + q-gutter + level*step; the leading verse number is
   parked out of flow at --c-gutter so "1" and "10" align, and a chapter-start
   drop-cap is parked in the column to its left. */
.print-preview .paras_usfm_d,
.print-preview .paras_usfm_q  { --q-level: 0; }
.print-preview .paras_usfm_q2 { --q-level: 1; }
.print-preview .paras_usfm_q3 { --q-level: 2; }
.print-preview .paras_usfm_q4 { --q-level: 3; }
.print-preview .paras_usfm_d,
.print-preview .paras_usfm_q,
.print-preview .paras_usfm_q2,
.print-preview .paras_usfm_q3,
.print-preview .paras_usfm_q4 {
  --c-gutter: 4rem;
  --q-gutter: 1.6rem;
  --q-step: 1.5rem;
  padding-left: calc(var(--c-gutter) + var(--q-gutter) + var(--q-level, 0) * var(--q-step));
}
.print-preview .paras_usfm_d { font-style: italic; font-weight: bold; padding-left: var(--c-gutter); }
.print-preview .paras_usfm_d:has(> .marks_verses_label:first-child),
.print-preview .paras_usfm_d:has(> .marks_chapter_label:first-child + .marks_verses_label) {
  padding-left: calc(var(--c-gutter) + var(--q-gutter));
}
.print-preview .marks_chapter_label { font-weight: normal !important; font-style: normal !important; }
.print-preview .paras_usfm_d:has(> .marks_verses_label:first-child),
.print-preview .paras_usfm_q:has(> .marks_verses_label:first-child),
.print-preview .paras_usfm_q2:has(> .marks_verses_label:first-child),
.print-preview .paras_usfm_q3:has(> .marks_verses_label:first-child),
.print-preview .paras_usfm_q4:has(> .marks_verses_label:first-child),
.print-preview .paras_usfm_d:has(> .marks_chapter_label:first-child + .marks_verses_label),
.print-preview .paras_usfm_q:has(> .marks_chapter_label:first-child + .marks_verses_label),
.print-preview .paras_usfm_q2:has(> .marks_chapter_label:first-child + .marks_verses_label),
.print-preview .paras_usfm_q3:has(> .marks_chapter_label:first-child + .marks_verses_label),
.print-preview .paras_usfm_q4:has(> .marks_chapter_label:first-child + .marks_verses_label) {
  position: relative;
  text-indent: 0;
}
.print-preview .paras_usfm_d  > .marks_verses_label:first-child,
.print-preview .paras_usfm_q  > .marks_verses_label:first-child,
.print-preview .paras_usfm_q2 > .marks_verses_label:first-child,
.print-preview .paras_usfm_q3 > .marks_verses_label:first-child,
.print-preview .paras_usfm_q4 > .marks_verses_label:first-child,
.print-preview .paras_usfm_d  > .marks_chapter_label:first-child + .marks_verses_label,
.print-preview .paras_usfm_q  > .marks_chapter_label:first-child + .marks_verses_label,
.print-preview .paras_usfm_q2 > .marks_chapter_label:first-child + .marks_verses_label,
.print-preview .paras_usfm_q3 > .marks_chapter_label:first-child + .marks_verses_label,
.print-preview .paras_usfm_q4 > .marks_chapter_label:first-child + .marks_verses_label {
  position: absolute;
  left: var(--c-gutter);
  box-sizing: border-box;
  width: var(--q-gutter);
  margin-right: 0;
  padding-right: 0.35rem;
  text-indent: 0;
  text-align: left;
}
.print-preview .paras_usfm_d:has(.marks_chapter_label),
.print-preview .paras_usfm_q:has(.marks_chapter_label),
.print-preview .paras_usfm_q2:has(.marks_chapter_label),
.print-preview .paras_usfm_q3:has(.marks_chapter_label),
.print-preview .paras_usfm_q4:has(.marks_chapter_label) {
  position: relative;
  padding-top: 1em;
}
.print-preview .paras_usfm_d  > .marks_chapter_label,
.print-preview .paras_usfm_q  > .marks_chapter_label,
.print-preview .paras_usfm_q2 > .marks_chapter_label,
.print-preview .paras_usfm_q3 > .marks_chapter_label,
.print-preview .paras_usfm_q4 > .marks_chapter_label {
  position: absolute;
  top: 0;
  left: 0;
  width: var(--c-gutter);
  box-sizing: border-box;
  float: none;
  margin-right: 0;
  padding-right: 0.3rem;
}

@media print {
  @page { margin: 20mm 25mm; }
  .print-preview { max-width: none; padding: 0; font-size: 11pt; }
  .print-preview h1, .print-preview h2, .print-preview h3 { break-after: avoid; }
}
`;

// Standalone document (used for the print window / "open in new tab") — the
// same HTML and CSS the inline preview shows.
export function buildPrintPreviewDocument(title: string, bodyHtml: string): string {
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
<div class="print-preview">
<h2 class="print-preview-title">${escapeHtml(title)}</h2>
${bodyHtml}
</div>
</body>
</html>`;
}

// Rich "copy chapter to Word" helper. Turns a chapter's verses (one or more
// bible versions) into clean HTML + plain-text for the clipboard, so pasting
// into Word yields readable scripture: superscript verse numbers, poetry lines
// broken and indented per \q level, paragraphs separated, alignment stripped.
//
// We walk each verse's verseObjects in document order. In-flow markers (\p, \q1
// …) flush the current line and start a new one; because usfm-js attaches a
// verse's leading \q to the PREVIOUS verse's trailing objects, processing verses
// in sequence lands each new poetic line's verse number at the start of its line
// with no special drift handling.

import type { VerseDto } from "../sync/api.ts";
import { isInFlowMarker, isCharacterWrapper, isTsMilestone } from "./usfm.ts";

// Non-printing sentinels wrap a verse number in the assembled line text so we
// can reliably promote just the number to a superscript later (a plain
// space-delimited match would hit ordinary words too). Stripped in both flavours.
const NUM_OPEN = String.fromCharCode(1);
const NUM_CLOSE = String.fromCharCode(2);
const NUM_RE = new RegExp(`${NUM_OPEN}([^${NUM_CLOSE}]+)${NUM_CLOSE}`, "g");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Indent level (in \q steps) for an in-flow marker; 0 = flush-left paragraph.
// `null` means "blank line" (\b). Poetry markers q/q1..q4/qm* indent; plain
// paragraph markers reset to the left margin.
function markerIndent(tag: string): number | null {
  if (tag === "b") return null;
  const m = /^q(m)?([1-4])?$/.exec(tag);
  if (m) return m[2] ? Number(m[2]) : 1;
  return 0;
}

interface Line {
  indent: number;
  text: string;
}

// Collect the bare text of a node subtree, dropping alignment structure:
// \w words and text nodes contribute their `text`; \zaln milestones and
// character wrappers recurse into children. In-flow markers are handled by the
// caller (top level), so skip them here.
function collectText(nodes: unknown[], into: string[]): void {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;
    if (isInFlowMarker(o) && !isCharacterWrapper(o)) continue;
    if (typeof o["text"] === "string") into.push(o["text"] as string);
    if (Array.isArray(o["children"])) collectText(o["children"] as unknown[], into);
  }
}

// Build the flowing lines for one chapter of one version.
function chapterLines(verses: VerseDto[]): Line[] {
  const lines: Line[] = [];
  let cur: Line = { indent: 0, text: "" };
  const flush = (): void => {
    lines.push(cur);
    cur = { indent: 0, text: "" };
  };

  // Dedupe by leading verse: a multi-verse range row is keyed under every verse
  // in its span by the caller, so the same DTO can arrive multiple times. Verse 0
  // is the chapter-front pseudo-verse (Psalm superscription `\d`, chapter-leading
  // `\s1`) — real scripture, so it is KEPT (rendered without a verse number),
  // matching the USFM export's `front` handling.
  const byVerse = new Map<number, VerseDto>();
  for (const v of verses) {
    if (!byVerse.has(v.verse)) byVerse.set(v.verse, v);
  }
  const sorted = [...byVerse.values()].sort((a, b) => a.verse - b.verse);

  for (const v of sorted) {
    const content = v.content as { verseObjects?: unknown[] } | null;
    const vos = Array.isArray(content?.verseObjects) ? content!.verseObjects : [];
    // Defer the verse number until the verse's first real (non-whitespace)
    // content: a verse whose own objects START with an in-flow marker (`\p`/`\q`)
    // would otherwise strand the number on the previous line, then break to a new
    // line for the body. Emitting on first content keeps the number with its text.
    let pendingLabel: string | null =
      v.verse === 0
        ? null
        : v.verse_end != null && v.verse_end > v.verse
          ? `${v.verse}-${v.verse_end}`
          : String(v.verse);
    const flushLabel = (): void => {
      if (pendingLabel === null) return;
      if (cur.text && !cur.text.endsWith(" ")) cur.text += " ";
      cur.text += `${NUM_OPEN}${pendingLabel}${NUM_CLOSE} `;
      pendingLabel = null;
    };
    const emitContent = (s: string): void => {
      if (s === "") return;
      if (/\S/.test(s)) flushLabel();
      cur.text += s;
    };
    for (const node of vos) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (isInFlowMarker(o) && !isCharacterWrapper(o)) {
        // `\ts\*` is a translator chunk divider, invisible in reading — it must
        // not insert a paragraph break into the copied text.
        if (isTsMilestone(o)) continue;
        const ind = markerIndent(String(o["tag"] ?? ""));
        if (ind === null) {
          flush();
          lines.push({ indent: 0, text: "" }); // blank line
        } else {
          flush();
          cur.indent = ind;
        }
        // Leading punctuation usfm-js parked on the marker node (real content).
        if (typeof o["text"] === "string") emitContent(o["text"] as string);
        continue;
      }
      const parts: string[] = [];
      collectText([o], parts);
      emitContent(parts.join(""));
    }
    // A verse with no textual content at all still surfaces its number.
    flushLabel();
  }
  flush();
  // Collapse ALL whitespace (incl. the \n usfm-js parks in text nodes) to single
  // spaces per line — real line breaks are structural (separate Line entries from
  // markers), never text-node newlines. Trim ends, drop leading/consecutive blanks.
  return lines
    .map((l) => ({ indent: l.indent, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((l, i, arr) => !(l.text === "" && (i === 0 || arr[i - 1].text === "")));
}

function linesToHtml(lines: Line[]): string {
  return lines
    .map((l) => {
      if (l.text === "") return "<p></p>";
      const withSup = escapeHtml(l.text).replace(NUM_RE, (_m, n) => `<sup>${n}</sup>`);
      const margin = l.indent > 0 ? ` style="margin:0 0 0 ${l.indent * 1.5}em"` : ' style="margin:0"';
      return `<p${margin}>${withSup}</p>`;
    })
    .join("");
}

function linesToText(lines: Line[]): string {
  return lines
    .map((l) => {
      if (l.text === "") return "";
      const indent = "  ".repeat(l.indent);
      return indent + l.text.replace(NUM_RE, (_m, n) => n);
    })
    .join("\n");
}

export interface ChapterCopyBlock {
  version: string;
  verses: VerseDto[];
}

// Build { html, text } for one or more version blocks of a single chapter.
export function buildChapterClipboard(
  book: string,
  chapter: number,
  blocks: ChapterCopyBlock[],
): { html: string; text: string } {
  const heading = `${book} ${chapter}`;
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  const multi = blocks.length > 1;
  for (const b of blocks) {
    const lines = chapterLines(b.verses);
    const title = multi ? `${heading} · ${b.version}` : heading;
    htmlParts.push(`<p style="margin:0"><strong>${escapeHtml(title)}</strong></p>`);
    htmlParts.push(linesToHtml(lines));
    textParts.push(title, linesToText(lines), "");
  }
  return { html: htmlParts.join(""), text: textParts.join("\n").trim() };
}

// Write both HTML and plain-text flavours to the clipboard. Falls back to
// plain-text writeText where the async ClipboardItem API is unavailable.
export async function copyChapterToClipboard(
  book: string,
  chapter: number,
  blocks: ChapterCopyBlock[],
): Promise<void> {
  const { html, text } = buildChapterClipboard(book, chapter, blocks);
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return;
    }
  } catch {
    // fall through to plain text
  }
  // Guard the fallback too: `navigator.clipboard` is undefined in a non-secure
  // (plain-HTTP) context, so the optional chaining above skips it — dereferencing
  // it unconditionally here would throw a TypeError instead of degrading quietly.
  await navigator.clipboard?.writeText(text);
}

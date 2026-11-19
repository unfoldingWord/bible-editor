// Footnote (`\f … \f*`) editing for a verse's content tree.
//
// usfm-js parses a footnote as one opaque node:
//   { tag: "f", type: "footnote", content: "+ \\ft Or \\fqa x\\fqa*.", endTag: "f*", nextChar?: " " }
// Its body lives on `content`, which extractEditableText never reads, so the
// verse editor's contentEditable does not show footnotes and a text edit cannot
// reach them (the text engine in replace.ts carries them through untouched).
// This module is the separate affordance: it finds the verse's footnotes and
// rewrites or removes one of them structurally, the way editHeaderBand does for
// a section heading. No `\w` word and no `\zaln` milestone is touched, so an
// edit here can never unalign a word.
//
// Scope: footnotes in the verse body, including those nested inside an
// alignment milestone. Footnotes inside a `\sp` label (or any other header
// label node) belong to the header band (#1366) and are skipped here, so the
// indexes below and SectionHeaderBand's read-only notes never overlap.

import { isHeaderLabelNode } from "./usfm.ts";

export interface FootnoteInfo {
  // Position in body order (depth-first). The handle editFootnote takes.
  index: number;
  tag: string;
  // The raw note body as stored, e.g. `+ \fr 1:1 \ft Or \fqa beginning\fqa*.`
  content: string;
  // Readable text: caller, `\fr` reference and marker tokens stripped.
  text: string;
}

function isFootnoteNode(node: unknown): node is Record<string, unknown> {
  const o = node as Record<string, unknown> | null;
  // Well-formed only: a closed note (`endTag` "f*" / "fe*") with a string
  // body. usfm-js cannot parse a note nested inside a `\zaln` milestone; it
  // splits it into `{type:"footnote", content:"+ "}`, a `{tag:"ft"}` and a
  // stray `{tag:"f*"}`. Those fragments are left alone rather than half-edited.
  return (
    !!o &&
    typeof o === "object" &&
    o["type"] === "footnote" &&
    typeof o["content"] === "string" &&
    typeof o["endTag"] === "string" &&
    /^fe?\*$/.test(o["endTag"] as string)
  );
}

// Every body footnote, depth-first, as [node, siblings array, index in it].
function walkFootnotes(
  nodes: unknown[],
  visit: (node: Record<string, unknown>, siblings: unknown[], i: number) => void,
): void {
  nodes.forEach((n, i) => {
    if (!n || typeof n !== "object") return;
    if (isHeaderLabelNode(n)) return;
    if (isFootnoteNode(n)) {
      visit(n, nodes, i);
      return;
    }
    const kids = (n as Record<string, unknown>)["children"];
    if (Array.isArray(kids)) walkFootnotes(kids, visit);
  });
}

// `+ \fr 1:1 \ft Or \fqa beginning\fqa*.` -> `Or beginning.`
export function footnoteDisplayText(content: string): string {
  return content
    .replace(/^\s*[+\-]\s+/, "") // caller
    .replace(/^\s*\S\s+(?=\\)/, "") // a custom caller character (`\f a \ft …`)
    .replace(/\\fr\s+[^\\]*/g, "") // origin reference
    .replace(/\\\+?[a-z]+\d*\*/g, "") // closing markers
    .replace(/\\\+?[a-z]+\d*\s?/g, "") // opening markers
    .replace(/\s+/g, " ")
    .trim();
}

export function listFootnotes(verseObjects: unknown[] | null | undefined): FootnoteInfo[] {
  const out: FootnoteInfo[] = [];
  if (!Array.isArray(verseObjects)) return out;
  walkFootnotes(verseObjects, (node) => {
    const content = typeof node["content"] === "string" ? (node["content"] as string) : "";
    out.push({
      index: out.length,
      tag: typeof node["tag"] === "string" ? (node["tag"] as string) : "f",
      content,
      text: footnoteDisplayText(content),
    });
  });
  return out;
}

// Why a typed note body cannot be saved, or null when it can. The body is
// written between `\f ` and `\f*` on export, so it must not close the note
// itself, open another, or carry a chapter/verse/paragraph break.
export function footnoteContentError(content: string): string | null {
  const s = content.trim();
  if (!s) return "The footnote is empty. Use Delete to remove it.";
  if (/[\r\n]/.test(s)) return "A footnote must be on one line.";
  if (/\\f\*|\\fe\*/.test(s)) return "Leave out the closing \\f* — it is added for you.";
  if (/\\(f|fe|x|v|c|p|q\d*|m|s\d*)(?=\s|$)/.test(s)) {
    return "A footnote cannot contain another note, a verse, chapter, paragraph or heading marker.";
  }
  return null;
}

function endsWithSpace(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  if (typeof o["nextChar"] === "string" && /\s$/.test(o["nextChar"] as string)) return true;
  if (o["type"] === "text" && typeof o["text"] === "string") return /\s$/.test(o["text"] as string);
  return false;
}

function startsWithSpace(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  return o["type"] === "text" && typeof o["text"] === "string" && /^\s/.test(o["text"] as string);
}

// Rewrite (content: string) or delete (content: null) the `index`-th body
// footnote. Returns a new tree that shares every untouched node with the input;
// returns the input itself when nothing changes (no such footnote, or the same
// body), so the caller can skip the save.
//
// Delete keeps the words on either side apart: usfm-js parks the space or line
// break after `\f*` on the note's `nextChar` (#1372). When neither neighbour
// already supplies whitespace, that separator survives as a text node, so
// `text\f + \ft n\f* rest` becomes `text rest`, never `textrest`.
export function editFootnote(
  verseObjects: unknown[],
  change: { index: number; content: string | null },
): unknown[] {
  let seen = 0;
  let done = false;
  const rebuild = (nodes: unknown[], depth: number): unknown[] => {
    let changed = false;
    const out: unknown[] = [];
    nodes.forEach((n, i) => {
      if (done || !n || typeof n !== "object" || isHeaderLabelNode(n)) {
        out.push(n);
        return;
      }
      if (isFootnoteNode(n)) {
        if (seen++ !== change.index) {
          out.push(n);
          return;
        }
        done = true;
        if (change.content === null) {
          changed = true;
          const sep = typeof n["nextChar"] === "string" ? (n["nextChar"] as string) : "";
          const prev = out[out.length - 1];
          const next = nodes[i + 1];
          if (/\s/.test(sep) && !endsWithSpace(prev) && !startsWithSpace(next) && prev !== undefined && (next !== undefined || depth > 0)) {
            out.push({ type: "text", text: /\n/.test(sep) ? "\n" : " " });
          }
          return;
        }
        const body = change.content.trim();
        if (body === n["content"]) {
          out.push(n);
          return;
        }
        changed = true;
        out.push({ ...n, content: body });
        return;
      }
      const kids = (n as Record<string, unknown>)["children"];
      if (Array.isArray(kids)) {
        const nk = rebuild(kids, depth + 1);
        if (nk !== kids) {
          changed = true;
          out.push({ ...(n as Record<string, unknown>), children: nk });
          return;
        }
      }
      out.push(n);
    });
    return changed ? out : nodes;
  };
  return rebuild(verseObjects, 0);
}

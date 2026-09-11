// Hoists an opening quote/bracket that the relayout tiers in replace.ts left
// stranded INSIDE the preceding word's \zaln alignment milestone (as trailing
// text after the milestone's last \w) out to a TOP-LEVEL text node between
// the two milestones — the shape usfm-js needs to keep the opener on the same
// output line as the word that follows it. Left inside the milestone, usfm-js
// serializes `\zaln-e\*` BEFORE the opener, and Door43's renderer inserts a
// stray space after it (see JER 31:10 / JER 31:18 on en_ult master). Closing
// punctuation trailing a milestone (e.g. ", ") is accepted uW form and is
// left untouched — only an opener triggers the move.
//
// Pure, no imports from replace.ts (mirrors a couple of its predicates
// locally so this module has no dependency on the edit engine).

import { isInFlowMarker, isCharacterWrapper } from "./usfm.ts";

export const OPENING_PUNCT_RE = /[“‘(\[{]/u;

interface Slot {
  kind: "word" | "text";
  arr: unknown[];
  idx: number;
  text?: string;
}

function isWordLeaf(node: Record<string, unknown>): boolean {
  return node["type"] === "word" && node["tag"] === "w";
}

// Flattens `nodes` (and the children of any nested milestone/wrapper within
// it) into document-order word/text slots. Each slot keeps a reference to
// its OWN containing array + index, so a caller can mutate the underlying
// node in place regardless of nesting depth.
function flattenLeaves(nodes: unknown[], out: Slot[]): void {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx] as Record<string, unknown> | null;
    if (!n) continue;
    if (isWordLeaf(n)) {
      out.push({ kind: "word", arr: nodes, idx });
      continue;
    }
    if (n["type"] === "text") {
      out.push({ kind: "text", arr: nodes, idx, text: String(n["text"] ?? "") });
      continue;
    }
    const kids = n["children"];
    if (Array.isArray(kids)) flattenLeaves(kids, out);
  }
}

function collectTrailingText(children: unknown[]): { hasWord: boolean; text: string; leaves: Slot[] } {
  const slots: Slot[] = [];
  flattenLeaves(children, slots);
  let lastWordIdx = -1;
  for (let i = 0; i < slots.length; i++) if (slots[i].kind === "word") lastWordIdx = i;
  if (lastWordIdx === -1) return { hasWord: false, text: "", leaves: [] };
  const trailing = slots.slice(lastWordIdx + 1).filter((s) => s.kind === "text");
  const text = trailing.map((s) => s.text ?? "").join("");
  return { hasWord: true, text, leaves: trailing };
}

// Drop pure empty-text leaves (`{type:"text", text:""}`) left behind after
// blanking the hoisted trailing leaves. Mirrors pruneEmptyText in replace.ts
// (duplicated, not imported — this module must not depend on replace.ts).
function pruneEmptyTextNodes(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const n of nodes) {
    const o = n as Record<string, unknown> | null;
    if (o && o["type"] === "text" && o["text"] === "" && !o["children"]) continue;
    if (o && Array.isArray(o["children"])) out.push({ ...o, children: pruneEmptyTextNodes(o["children"] as unknown[]) });
    else out.push(n);
  }
  return out;
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

// True for a `{type:"text", ...}` node whose text is empty or whitespace-only
// (and has no children). Used to look PAST such a node when deciding whether
// the next real thing after a milestone is an in-flow marker — usfm-js parks
// a structural `\n` between milestones as its own text node, and that node
// must not hide an `\q1`/`\p` line-break marker one slot further on.
function isWhitespaceOnlyText(n: unknown): boolean {
  const o = n as Record<string, unknown> | null;
  return !!o && o["type"] === "text" && !o["children"] && /^\s*$/u.test(String(o["text"] ?? ""));
}

// Hoists stranded trailing openers within one array of sibling nodes
// (mutates `nodes` and the objects in it in place — callers own the clone).
// Recurses into each `\zaln` milestone's children FIRST, then processes
// milestones at the current level exactly as before. A multi-source
// alignment can nest milestones (`OUTER[ INNER1[say, "‘"], INNER2[The] ]`)
// with no trailing text after OUTER's own last word, so without the
// recursion INNER1's stranded opener is invisible from OUTER's level. A
// trailing opener hoisted out of an INNER milestone becomes a new sibling
// inside OUTER's children; if that sibling is itself now OUTER's own
// trailing text, the current-level pass below picks it up and bubbles it
// further — intended.
function hoistLevel(nodes: unknown[]): void {
  for (const n of nodes) {
    const o = n as Record<string, unknown> | null;
    if (o && o["type"] === "milestone" && o["tag"] === "zaln" && Array.isArray(o["children"])) {
      hoistLevel(o["children"] as unknown[]);
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Record<string, unknown> | null;
    if (!node || node["type"] !== "milestone" || node["tag"] !== "zaln") continue;
    const children = node["children"];
    if (!Array.isArray(children)) continue;

    const info = collectTrailingText(children);
    if (!info.hasWord || info.text === "") continue;
    if (!OPENING_PUNCT_RE.test(info.text)) continue;

    // The guard looks PAST whitespace-only text siblings (usfm-js parks a
    // structural `\n` between milestones as its own text node) to find the
    // first real thing following the milestone. Never move text across a
    // line-break marker (\q1/\p/\b/\m-style) found there. A character
    // wrapper (\qs) holds content, not a line break, so it's fine. If
    // nothing follows (the milestone is last), there's nothing to guard
    // against — still hoist.
    let guardIdx = i + 1;
    while (guardIdx < nodes.length && isWhitespaceOnlyText(nodes[guardIdx])) guardIdx++;
    const guard = nodes[guardIdx] as Record<string, unknown> | undefined;
    if (guard && isInFlowMarker(guard) && !isCharacterWrapper(guard)) continue;

    // The prepend/step-over logic below keeps targeting the IMMEDIATE
    // sibling, not the (possibly further) guard node.
    const next = nodes[i + 1] as Record<string, unknown> | undefined;

    for (const leaf of info.leaves) {
      const existing = leaf.arr[leaf.idx] as Record<string, unknown>;
      leaf.arr[leaf.idx] = { ...existing, text: "" };
    }
    node["children"] = pruneEmptyTextNodes(children);

    if (next && next["type"] === "text") {
      // The opener must be GLUED to the following `\zaln-s` for usfm-js to
      // emit it on that marker's line. A structural newline stored as the next
      // sibling (usfm-js keeps `\n` between milestones as a text node) would
      // otherwise land after the opener and re-create the stray space. So the
      // closing part keeps its place and the opener run steps over the
      // sibling's leading whitespace: `, ‘` + `\nThe` → `, \n‘` + `The` — the
      // canonical tC layout (`\zaln-e\*,` ⏎ `‘\zaln-s …`). Only whitespace
      // changes position; every non-space character keeps its order.
      const nextText = String(next["text"] ?? "");
      const lead = nextText.match(/^\s*/u)?.[0] ?? "";
      const openerAt = info.text.search(OPENING_PUNCT_RE);
      // When the sibling already supplies whitespace, drop the closing part's
      // own trailing whitespace so the bytes come out as the canonical
      // `\zaln-e\*,` ⏎ `‘\zaln-s` rather than `, ` ⏎ `‘`.
      const closing = lead ? info.text.slice(0, openerAt).replace(/\s+$/u, "") : info.text.slice(0, openerAt);
      const opener = info.text.slice(openerAt);
      next["text"] = closing + lead + opener + nextText.slice(lead.length);
    } else {
      nodes.splice(i + 1, 0, { type: "text", text: info.text });
    }
  }
}

// Returns a NEW verseObjects array (does not mutate the input) with every
// `\zaln` milestone's (at any depth) stranded trailing opener moved to a
// top-level (relative to its own array) text node right after it. Idempotent,
// and preserves the verse's concatenated text exactly, except that an opener
// may step over the following sibling's leading whitespace (see below) so it
// stays glued to the next `\zaln-s`.
export function hoistOpeningPunctuation(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const clone = deepClone(verseObjects) as unknown[];
  hoistLevel(clone);
  return clone;
}

// Concatenate every `text` field in a verseObjects tree, recursing into
// children — no whitespace collapsing, no marker-separator rules. Used to
// detect whether a hoist actually changed the verse's raw text (it can, by
// stepping an opener over a sibling's leading whitespace) so callers know
// whether a cached plain_text needs recomputing.
export function concatVerseText(nodes: unknown[]): string {
  let out = "";
  for (const n of nodes ?? []) {
    const o = n as Record<string, unknown> | null;
    if (!o) continue;
    if (typeof o["text"] === "string") out += o["text"];
    if (Array.isArray(o["children"])) out += concatVerseText(o["children"] as unknown[]);
  }
  return out;
}

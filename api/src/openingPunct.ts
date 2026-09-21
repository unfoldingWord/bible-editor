// Mirror of web/src/lib/openingPunct.ts (api can't import from web/ — see the
// header comment of alignmentDelta.ts for why each layer keeps its own copy).
// Below the detector (used by lint) this file ALSO mirrors the fix itself
// (`hoistOpeningPunctuation`), wired into pipelineImport.ts's ULT/UST
// self-heal chain (#778) — belt-and-braces on the AI pipeline's write path,
// since bp-assistant emits the correct shape today and the web copy already
// fixes the same defect on every in-app save. Keep the two copies in sync,
// predicates included: this file deliberately does NOT reuse
// importParsers.ts's isInFlowMarker, which is a documented DELIBERATE
// DIVERGENCE from the web semantics for unrelated reasons (plain_text/
// dropDoubledLeadingMarkers). The hoist needs the web module's exact guard
// semantics, so it keeps its own local copies, same as the web module keeps
// its own local copies of usfm.ts's predicates rather than importing them.
//
// The defect: a relayout in web/src/lib/replace.ts can write an opening
// quote/bracket into a `\zaln` milestone's trailing text (after its last
// `\w`), instead of leaving it as top-level text between milestones. usfm-js
// then serializes the opener BEFORE the milestone's close, and Door43's
// renderer inserts a stray space after it (JER 31:10 / JER 31:18 on en_ult
// master).

export const OPENING_PUNCT_RE = /[“‘(\[{]/u;

function isWordLeaf(node: Record<string, unknown>): boolean {
  return node["type"] === "word" && node["tag"] === "w";
}

// Trailing text of a milestone's subtree, after its last `\w` word leaf
// (recursing into nested milestones). Returns null when the subtree has no
// word leaf at all.
function trailingTextAfterLastWord(nodes: unknown[]): string | null {
  let lastWordFlatIndex = -1;
  const flat: { kind: "word" | "text"; text?: string }[] = [];

  const flatten = (list: unknown[]): void => {
    for (const n of list) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (isWordLeaf(o)) {
        flat.push({ kind: "word" });
        continue;
      }
      if (o["type"] === "text") {
        flat.push({ kind: "text", text: String(o["text"] ?? "") });
        continue;
      }
      const kids = o["children"];
      if (Array.isArray(kids)) flatten(kids);
    }
  };
  flatten(nodes);
  for (let i = 0; i < flat.length; i++) if (flat[i].kind === "word") lastWordFlatIndex = i;
  if (lastWordFlatIndex === -1) return null;
  return flat
    .slice(lastWordFlatIndex + 1)
    .filter((s) => s.kind === "text")
    .map((s) => s.text ?? "")
    .join("");
}

// True when any `\zaln` milestone AT ANY DEPTH has its own trailing text
// (after its own last `\w`) matching an opening quote/bracket.
//
// Recurses into each milestone's children FIRST: a multi-source alignment can
// nest milestones (`OUTER[ INNER1[say, trailing "‘"], INNER2[The] ]`), and
// INNER1's trailing text is masked at OUTER's level because OUTER's own last
// word (inside INNER2) comes after it — trailingTextAfterLastWord finds no
// trailing text at all in that case. Checking INNER1 on its own catches it.
export function hasOpeningPunctInsideMilestone(nodes: unknown[]): boolean {
  if (!Array.isArray(nodes)) return false;
  for (const n of nodes) {
    const o = n as Record<string, unknown> | null;
    if (!o) continue;
    if (o["type"] === "milestone" && o["tag"] === "zaln") {
      const children = o["children"];
      if (Array.isArray(children)) {
        if (hasOpeningPunctInsideMilestone(children)) return true;
        const trailing = trailingTextAfterLastWord(children);
        if (trailing != null && OPENING_PUNCT_RE.test(trailing)) return true;
      }
    }
  }
  return false;
}

// ─── The fix (mirrors web/src/lib/openingPunct.ts's hoistLevel/hoistOpeningPunctuation) ───

// Local mirror of usfm.ts's isTsMilestone — matches the REAL usfm-js 3.5.0
// `\ts\*` shape (`{tag:"ts\\*"}`/`{tag:"ts*"}`) as well as the legacy
// `{tag:"ts", content:"\\*"|"*"}` shape. Deliberately NOT the same predicate
// importParsers.ts's isInFlowMarker uses (that one is a documented divergence
// for plain_text/dropDoubledLeadingMarkers) — the hoist's guard must match
// the web module's semantics exactly.
function isTsMilestoneLocal(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const tag = o["tag"];
  if (tag === "ts\\*" || tag === "ts*") return true;
  return tag === "ts" && (o["content"] === "\\*" || o["content"] === "*");
}

// Local mirror of usfm.ts's isInFlowMarker.
function isInFlowMarkerLocal(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if ((t === "paragraph" || t === "quote") && typeof o["tag"] === "string") return true;
  if (isTsMilestoneLocal(o)) return true;
  return false;
}

// Local mirror of usfm.ts's isCharacterWrapper (only "qs" is a wrapper tag on
// either side today).
const CHARACTER_WRAPPER_TAGS: ReadonlySet<string> = new Set(["qs"]);
function isCharacterWrapperLocal(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  if (typeof o["endTag"] === "string" && o["endTag"] !== "" && typeof o["tag"] === "string" && CHARACTER_WRAPPER_TAGS.has(o["tag"]))
    return true;
  return typeof o["tag"] === "string" && CHARACTER_WRAPPER_TAGS.has(o["tag"]);
}

interface Slot {
  kind: "word" | "text";
  arr: unknown[];
  idx: number;
  text?: string;
}

// Flattens `nodes` (and the children of any nested milestone/wrapper within
// it) into document-order word/text slots, each keeping a reference to its
// OWN containing array + index so a caller can mutate the underlying node in
// place regardless of nesting depth. Mirrors web/src/lib/openingPunct.ts's
// flattenLeaves.
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

// Drop pure empty-text leaves left behind after blanking the hoisted trailing
// leaves. Mirrors pruneEmptyText in replace.ts (duplicated, not imported —
// this module must not depend on the web edit engine).
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
// (and has no children) — usfm-js parks a structural `\n` between milestones
// as its own text node, and that node must not hide an in-flow marker one
// slot further on.
function isWhitespaceOnlyText(n: unknown): boolean {
  const o = n as Record<string, unknown> | null;
  return !!o && o["type"] === "text" && !o["children"] && /^\s*$/u.test(String(o["text"] ?? ""));
}

// Hoists stranded trailing openers within one array of sibling nodes
// (mutates `nodes` and the objects in it in place — callers own the clone).
// Recurses into each `\zaln` milestone's children first (a multi-source
// alignment can nest milestones), then processes milestones at the current
// level. Mirrors web/src/lib/openingPunct.ts's hoistLevel exactly.
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

    let guardIdx = i + 1;
    while (guardIdx < nodes.length && isWhitespaceOnlyText(nodes[guardIdx])) guardIdx++;
    const guard = nodes[guardIdx] as Record<string, unknown> | undefined;
    if (guard && isInFlowMarkerLocal(guard) && !isCharacterWrapperLocal(guard)) continue;

    const next = nodes[i + 1] as Record<string, unknown> | undefined;

    for (const leaf of info.leaves) {
      const existing = leaf.arr[leaf.idx] as Record<string, unknown>;
      leaf.arr[leaf.idx] = { ...existing, text: "" };
    }
    node["children"] = pruneEmptyTextNodes(children);

    if (next && next["type"] === "text") {
      const nextText = String(next["text"] ?? "");
      const lead = nextText.match(/^\s*/u)?.[0] ?? "";
      const openerAt = info.text.search(OPENING_PUNCT_RE);
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
// may step over the following sibling's leading whitespace so it stays glued
// to the next `\zaln-s`. Mirrors web/src/lib/openingPunct.ts's
// hoistOpeningPunctuation.
export function hoistOpeningPunctuation(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const clone = deepClone(verseObjects) as unknown[];
  hoistLevel(clone);
  return clone;
}

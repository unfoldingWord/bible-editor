// Mirror of web/src/lib/openingPunct.ts's detection half (api can't import
// from web/ — see the header comment of alignmentDelta.ts for why each layer
// keeps its own copy). This file only DETECTS the defect for lint; the fix
// (hoisting the opener to a top-level text node) lives in the web copy and is
// applied when the translator next saves the verse in the editor.
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

// True when any TOP-LEVEL `\zaln` milestone's trailing text (after its last
// `\w`, anywhere in its subtree) matches an opening quote/bracket.
export function hasOpeningPunctInsideMilestone(nodes: unknown[]): boolean {
  if (!Array.isArray(nodes)) return false;
  for (const n of nodes) {
    const o = n as Record<string, unknown> | null;
    if (!o) continue;
    if (o["type"] === "milestone" && o["tag"] === "zaln") {
      const children = o["children"];
      if (Array.isArray(children)) {
        const trailing = trailingTextAfterLastWord(children);
        if (trailing != null && OPENING_PUNCT_RE.test(trailing)) return true;
      }
    }
  }
  return false;
}

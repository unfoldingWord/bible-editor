// Opening punctuation trapped inside an alignment milestone (issue #777).
//
// THE DEFECT, MEASURED. usfm-js emits a NEWLINE between two adjacent top-level
// `\zaln` milestones and nowhere else:
//
//   zaln[… \w say, t(", ‘")] , zaln[…]   →  \w say\w*, ‘\zaln-e\*\n\zaln-s …
//   zaln[… \w say, t(", ")], t("‘"), zaln[…] →  \w say\w*, \zaln-e\*‘\zaln-s …
//
// Door43's renderer turns that newline into a SPACE. When the milestone's
// trailing text ends in a closing character (`, `) the space is harmless — it
// is the inter-word space. When it ends in an OPENING bracket/quote the space
// lands on the wrong side of it and the reader sees `say, ‘ The one…`
// (en_ult JER 31:10 and 31:18 on master).
//
// HOW THE TREE GETS INTO THAT SHAPE. The AI pipeline writes the opener
// correctly — as the leading text child of the FOLLOWING milestone. But every
// relayout tier in replace.ts treats an inter-word gap as ONE atom and writes
// the whole gap into the FIRST text leaf it finds for that gap, which is the
// trailing text child of the PRECEDING milestone (relayoutUnchangedWords'
// `leaf.node["text"] = gaps[ti]`; smartRebuildRange's `__gapAfter`, which is
// emitted right beside the word leaf and therefore inside its milestone).
// A single in-app edit anywhere in the verse re-lays every gap, so one
// `guard`→`protect` save was enough to move the opener.
//
// THE FIX. After the edit tiers have run, move such a trailing text run OUT of
// the milestone to a top-level text node sitting between the closing milestone
// and the next opening one — `\zaln-e\*, ‘\zaln-s` on one line, which is the
// shape real uW data already uses (see the JER_29_31 fixture in
// replace.test.mjs, whose `,\n‘` gap is a TOP-LEVEL text node between two
// milestones) and which replace.ts already prefers for the verse-LEADING gap
// (see `topLevelIndexOf`: "splice a verse-leading gap OUTSIDE the first
// milestone … rather than burying the opening quote inside the first \zaln").
//
// The move is raw-text preserving: the same characters in the same order, only
// a different node owns them. No `\w` moves, so no word can unalign.
//
// api/src/openingPunct.ts is a deliberate MIRROR of this module (api cannot
// import web/), following the api/src/alignmentDelta.ts precedent. Keep the two
// in sync — the api copy is what the pipeline self-heal chain, the lint check
// and the repair script use.

type Rec = Record<string, unknown>;

/**
 * Characters that OPEN a bracketed/quoted span. A space must fall BEFORE one of
 * these, never after, so one of these immediately in front of a `\zaln-e\*`
 * that is followed by a `\zaln-s` is the defect.
 *
 * Straight `"` / `'` are included even though the editor curls them: legacy
 * rows and AI output still carry them, and the hoist is raw-text preserving, so
 * including a character that turns out to be a CLOSING straight quote costs
 * nothing — the rendered characters are identical either way, only the newline
 * moves.
 */
export const OPENING_PUNCT_CHARS = "\"'“‘([{";

function hasOpeningPunct(s: string): boolean {
  for (const ch of s) if (OPENING_PUNCT_CHARS.includes(ch)) return true;
  return false;
}

function isZalnMilestone(n: unknown): n is Rec {
  const o = n as Rec | null;
  return !!o && typeof o === "object" && o["type"] === "milestone" && o["tag"] === "zaln";
}

function isWordNode(o: Rec): boolean {
  return o["type"] === "word" && o["tag"] === "w";
}

interface LeafRef {
  kind: "word" | "text" | "other";
  parent: unknown[];
  index: number;
  node: Rec;
}

// Every leaf of a milestone subtree in document order. `other` is anything that
// carries raw text but is neither a `\w` nor a plain text node — usfm-js parks
// post-marker text on the MARKER node, and moving a marker is not this module's
// job, so an `other` after the last word aborts the hoist for that milestone.
function subtreeLeaves(nodes: unknown[]): LeafRef[] {
  const out: LeafRef[] = [];
  const walk = (arr: unknown[]): void => {
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i] as Rec | null;
      if (!o || typeof o !== "object") continue;
      if (isWordNode(o)) out.push({ kind: "word", parent: arr, index: i, node: o });
      else if (o["type"] === "text" && typeof o["text"] === "string") out.push({ kind: "text", parent: arr, index: i, node: o });
      else if (typeof o["text"] === "string" && o["text"] !== "") out.push({ kind: "other", parent: arr, index: i, node: o });
      const ch = o["children"];
      if (Array.isArray(ch)) walk(ch);
    }
  };
  walk(nodes);
  return out;
}

// The text leaves that follow the LAST `\w` of this milestone's subtree — i.e.
// what serializes between the final `\w*` and the `\zaln-e\*` run. Returns null
// when the milestone holds no word at all (pruneDeadMilestones' problem, not
// ours) or when a non-text node trails the last word (see `other` above).
function trailingTextLeaves(milestone: Rec): LeafRef[] | null {
  const children = milestone["children"];
  if (!Array.isArray(children)) return null;
  const leaves = subtreeLeaves(children);
  let lastWord = -1;
  for (let i = 0; i < leaves.length; i++) if (leaves[i].kind === "word") lastWord = i;
  if (lastWord === -1) return null;
  const tail = leaves.slice(lastWord + 1);
  if (tail.some((l) => l.kind !== "text")) return null;
  return tail;
}

export interface OpeningPunctFinding {
  /** Index in `verseObjects` of the milestone holding the trapped punctuation. */
  index: number;
  /** The trailing text run that must move out (e.g. `", ‘"`). */
  text: string;
}

/**
 * READ-ONLY detection: top-level `\zaln` milestones whose trailing text carries
 * an opening bracket/quote AND which are immediately followed by another
 * top-level `\zaln` — the exact pair that makes usfm-js emit the newline.
 *
 * The "followed by another milestone" half is not a nicety: with ANY other node
 * in between (a bare text node, a bare `\w`, a `\q` marker) usfm-js emits no
 * newline there and the verse renders correctly, so those shapes are left
 * alone. A following in-flow marker is excluded by the same test — the marker
 * owns that line break and its punctuation placement belongs to
 * reconcileMarkers / splitGapAtMarker in replace.ts, not here.
 */
export function findOpeningPunctInAlignment(verseObjects: unknown[]): OpeningPunctFinding[] {
  const out: OpeningPunctFinding[] = [];
  if (!Array.isArray(verseObjects)) return out;
  for (let i = 0; i < verseObjects.length - 1; i++) {
    const node = verseObjects[i];
    if (!isZalnMilestone(node)) continue;
    if (!isZalnMilestone(verseObjects[i + 1])) continue;
    const tail = trailingTextLeaves(node);
    if (!tail || tail.length === 0) continue;
    const text = tail.map((l) => String(l.node["text"])).join("");
    if (!hasOpeningPunct(text)) continue;
    out.push({ index: i, text });
  }
  return out;
}

function rawTextOf(nodes: unknown[]): string {
  const parts: string[] = [];
  const walk = (arr: unknown[]): void => {
    for (const n of arr) {
      const o = n as Rec | null;
      if (!o || typeof o !== "object") continue;
      if (typeof o["text"] === "string") parts.push(o["text"]);
      const ch = o["children"];
      if (Array.isArray(ch)) walk(ch);
    }
  };
  walk(nodes);
  return parts.join("");
}

/**
 * Move any trapped opening punctuation out to a top-level text node placed
 * immediately after its milestone. Returns the SAME array reference when there
 * is nothing to fix (the overwhelmingly common case), so this is cheap to run
 * unconditionally at the end of every edit.
 *
 * Raw-text preserving by construction and self-checked: if the concatenated
 * text of the tree would change for any reason the original array is returned
 * untouched, because a cosmetic line-break fix must never be able to alter a
 * verse's words.
 */
export function hoistOpeningPunctuation(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  if (findOpeningPunctInAlignment(verseObjects).length === 0) return verseObjects;

  const before = rawTextOf(verseObjects);
  // Work on a private copy: callers hand us trees they may still hold a
  // reference to, and the removal below splices nested children arrays.
  const clone = JSON.parse(JSON.stringify(verseObjects)) as unknown[];
  const findings = findOpeningPunctInAlignment(clone);
  const hoistedAt = new Map<number, string>();
  for (const f of findings) {
    const milestone = clone[f.index] as Rec;
    const tail = trailingTextLeaves(milestone);
    if (!tail || tail.length === 0) continue;
    // Splice highest index first within each parent array so earlier indices
    // stay valid (mirrors the insertion bookkeeping in replace.ts).
    const byArray = new Map<unknown[], number[]>();
    for (const l of tail) {
      const list = byArray.get(l.parent) ?? [];
      list.push(l.index);
      byArray.set(l.parent, list);
    }
    for (const [arr, idxs] of byArray) {
      idxs.sort((a, b) => b - a);
      for (const idx of idxs) arr.splice(idx, 1);
    }
    hoistedAt.set(f.index, f.text);
  }

  const out: unknown[] = [];
  for (let i = 0; i < clone.length; i++) {
    out.push(clone[i]);
    const text = hoistedAt.get(i);
    if (text !== undefined) out.push({ type: "text", text });
  }

  if (rawTextOf(out) !== before) return verseObjects;
  return out;
}

// Which source verse each part of a joined bridge source came from (#1401).
//
// A bridged ULT/UST row (2CH 9:10-12) aligns against its source verses joined
// into one verseObjects array (verseRange.ts `concatSourceRange`). tCore counts
// a source word's x-occurrence PER SOURCE VERSE inside such a bridge and names
// that verse on the milestone as `x-ref="9:12"` (usfm-js key `ref`), so the
// aligner has to know where each verse starts in the joined array.
//
// Kept in a side table keyed by the joined array rather than written onto its
// nodes: highlights, the unaligned checks and bridgeNoteAnchor walk the same
// array, and none of them should see a new node or field.

export interface BridgeVerseStart {
  // Index into the joined top-level verseObjects where this verse's nodes begin.
  index: number;
  // "chapter:verse", the x-ref spelling tCore writes.
  ref: string;
}

const starts = new WeakMap<object, BridgeVerseStart[]>();

export function markBridgeSource(verseObjects: unknown[], verseStarts: BridgeVerseStart[]): void {
  starts.set(verseObjects, verseStarts);
}

// The verse starts of a joined bridge source, or null for anything else
// (a single verse, or an array that did not come from concatSourceRange).
export function bridgeVerseStarts(verseObjects: unknown): BridgeVerseStart[] | null {
  if (!verseObjects || typeof verseObjects !== "object") return null;
  return starts.get(verseObjects) ?? null;
}

// The x-ref of each top-level node of `verseObjects` (undefined when it is not
// a joined bridge source). Index i of the result belongs to node i.
export function topLevelRefs(verseObjects: unknown[]): (string | undefined)[] | null {
  const list = bridgeVerseStarts(verseObjects);
  if (!list || list.length === 0) return null;
  const out: (string | undefined)[] = new Array(verseObjects.length);
  let k = -1;
  for (let i = 0; i < verseObjects.length; i++) {
    while (k + 1 < list.length && list[k + 1].index <= i) k++;
    out[i] = k >= 0 ? list[k].ref : undefined;
  }
  return out;
}

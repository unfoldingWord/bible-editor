// Per-chapter cache of the Strong's numbers in a chapter's UHB verses, used by
// Shell to warm the lexicon (#898). Keyed on the identity of the UHB verses
// object itself, not on book/chapter:
//
// - A ULT/UST save or `verse.updated` replaces only that version's slot
//   (`reduceVerses` in verseStructure.ts), so `data.verses.UHB` keeps its
//   identity and the chapter is not walked again.
// - Each chapter's payload has its own UHB object, so one chapter's list can
//   never be served for another, even while useChapter keeps the previous
//   chapter's data on screen during a chapter change (#892).
// - A refetch that builds a new UHB object is walked again, which is correct.
//
// The WeakMap lets a chapter's entry go once its UHB object is dropped.
// `collect` is injected (Shell passes HebrewLine's collectStrongs) so this
// module has no .tsx import and runs under the node test runner.

export function createUhbStrongsCache<V extends { content?: unknown }>(
  collect: (verseObjects: unknown[]) => string[],
): (verses: Record<number, V> | undefined) => readonly string[] {
  const cache = new WeakMap<object, readonly string[]>();
  return (verses) => {
    if (!verses) return [];
    const hit = cache.get(verses);
    if (hit) return hit;
    const out: string[] = [];
    for (const v of Object.values(verses)) {
      const objs = (v.content as { verseObjects?: unknown[] } | null | undefined)?.verseObjects;
      if (Array.isArray(objs)) out.push(...collect(objs));
    }
    cache.set(verses, out);
    return out;
  };
}

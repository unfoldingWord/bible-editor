// Fetches non-AI alignment suggestions for the source Strong's numbers in the
// current verse. The backend (/api/align/suggest) ranks candidate target
// surfaces from the precomputed alignment-memory frequency table (wordMAP
// memory over the canonical ULT/UST), with a lexicon gloss/definition
// fallback. This hook is intentionally dumb: one fetch per (bible, strong-set),
// cached module-wide; the component does the word-bank intersection so unsaved
// edits never need a round-trip.

import { useEffect, useState } from "react";

export interface AlignCandidate {
  surface: string; // lowercased target surface, e.g. "beginning"
  confidence: number; // 0..1
  source: "memory" | "lexicon";
  count?: number; // corpus frequency (memory only)
}

export interface AlignPhrase {
  phrase: string; // e.g. "the earth"
  tokens: string[]; // ["the","earth"]
  confidence: number; // 0..1
  count: number;
}

export interface AlignSuggestion {
  words: AlignCandidate[];
  phrases: AlignPhrase[];
}

type SuggestionMap = Record<string, AlignSuggestion>; // keyed by the raw strong sent

// Module-level cache so flipping between verses / re-renders doesn't refetch.
const cache = new Map<string, SuggestionMap>();
const EMPTY: SuggestionMap = {};

export function useAlignmentSuggestions(
  bibleVersion: string,
  rawStrongs: string[],
): SuggestionMap {
  const bible = (bibleVersion || "ult").toLowerCase();
  const unique = [...new Set(rawStrongs)].filter(Boolean).sort();
  const key = `${bible}::${unique.join(",")}`;
  const [, force] = useState(0);

  useEffect(() => {
    if (unique.length === 0 || cache.has(key)) return;
    let cancelled = false;
    const url = `/api/align/suggest?bible=${encodeURIComponent(bible)}&strongs=${encodeURIComponent(unique.join(","))}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : { suggestions: {} }))
      .then((data: { suggestions?: SuggestionMap }) => {
        if (cancelled) return;
        cache.set(key, data.suggestions ?? {});
        force((t) => t + 1);
      })
      .catch(() => {
        // Network failure: cache empty so we don't hammer, but a later verse
        // (different key) can still try.
        if (!cancelled) {
          cache.set(key, {});
          force((t) => t + 1);
        }
      });
    return () => {
      cancelled = true;
    };
    // key encodes bible + the sorted strong set; rawStrongs identity is moot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return cache.get(key) ?? EMPTY;
}

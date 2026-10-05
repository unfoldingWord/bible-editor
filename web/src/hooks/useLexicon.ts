// Module-level lexicon cache: each unique Strong's key is fetched at most
// once per page load. Components subscribe via useLexicon, which batches
// requested strongs into a single GET /api/lexicon?strongs=... call.
//
// The in-memory cache (lexiconStore.ts) is mirrored to IndexedDB via
// lexiconCache.ts so F5 (or reload while offline) still renders tooltips and
// resource cards without hitting the network.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { fetchLexiconEntries } from "../sync/api";
import { getEntries as getCachedEntries, putEntries as putCachedEntries } from "../sync/lexiconCache";
import { createLexiconStore, type LexiconEntry } from "./lexiconStore";

export { normalizeStrong, type LexiconEntry } from "./lexiconStore";

const store = createLexiconStore({
  fetchEntries: fetchLexiconEntries,
  getCached: getCachedEntries,
  putCached: putCachedEntries,
});

// Subscribe to lexicon updates for the given raw Strong's. Returns a map
// keyed by the *input* raw form so callers can look up by what they have.
// The Map keeps its identity until the requested set changes or the store's
// version moves (an entry resolved somewhere in the app), instead of being
// rebuilt on every render (#898). useSyncExternalStore re-reads the version
// after subscribing, so a fetch that resolved between this component's render
// and its subscription is not missed.
export function useLexicon(rawStrongs: string[]): Map<string, LexiconEntry | null> {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const joined = rawStrongs.join(",");
  useEffect(() => {
    void store.ensure(rawStrongs);
    // joined captures the set of strongs; rawStrongs identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  // `version` is only a dependency: lookup() reads the store's cache, which
  // changes exactly when version does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => store.lookup(rawStrongs), [joined, version]);
}

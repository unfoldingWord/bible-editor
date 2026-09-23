import { useEffect, useState } from "react";
import { api, type Catalogs } from "../sync/api";
import { createResourceCache } from "./resourceCache";

// Persisted alongside the in-memory cache so an F5 while offline still shows
// type-ahead suggestions. Single payload, ~50-100KB — localStorage is the
// right tool (synchronous read, no schema, room to spare).
// v2: added twTitles (feeds canonicalTwlOrder headword anchoring). Bumped so
// a stale v1 payload (no twTitles) is never served — even under
// stale-while-revalidate — which would silently disagree with the export
// until the background refresh landed. The old v1 key is left alone.
const STORAGE_KEY = "bible-editor.catalogs.v2";

// #886: catalogs change on the scale of a tw_articles/tw import, not on every
// verse click — re-share the last fetch for this long instead of refetching
// on every NoteCard/WordRow mount.
const CACHE_TTL_MS = 10 * 60 * 1000;

function readPersisted(): Catalogs | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Catalogs>;
    if (!Array.isArray(parsed.supportReferences) || !Array.isArray(parsed.twLinks)) return null;
    return {
      supportReferences: parsed.supportReferences,
      twLinks: parsed.twLinks,
      disambiguationGroups: parsed.disambiguationGroups,
      disambiguationIndex: parsed.disambiguationIndex,
      twTitles: parsed.twTitles,
    };
  } catch {
    return null;
  }
}

function writePersisted(c: Catalogs) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* quota or private mode — soft fail */
  }
}

// Single in-module cache so every NoteCard/WordsTable shares the same fetch.
// Hydrate synchronously from localStorage so first render shows real data
// even if we're currently offline.
const resourceCache = createResourceCache<Catalogs>({
  fetcher: () => api.getCatalogs(),
  read: readPersisted,
  write: writePersisted,
  ttlMs: CACHE_TTL_MS,
});

// twTitles arrives as a plain Record; every consumer wants it as a Map. Built
// once per distinct record (module scope, keyed by reference) instead of once
// per hook call, so mounting N NoteCards/WordRows doesn't rebuild an ~950
// entry Map N times over.
let twTitlesMemo: { rec: Record<string, string> | undefined; map: Map<string, string> } | null =
  null;
function getTwTitlesMap(rec: Record<string, string> | undefined): Map<string, string> {
  if (twTitlesMemo && twTitlesMemo.rec === rec) return twTitlesMemo.map;
  const map = new Map(Object.entries(rec ?? {}));
  twTitlesMemo = { rec, map };
  return map;
}

// twTitles arrives from the API as a Record and is handed on as a Map (what
// canonicalTwlOrder takes), so the wire field has to be Omit-ted before being
// re-declared — intersecting Catalogs directly would demand a value that is
// both a Record and a Map, which nothing can satisfy.
export function useCatalogs(): Omit<Catalogs, "twTitles"> & { twTitles: Map<string, string> } {
  const [val, setVal] = useState<Catalogs>(
    () => resourceCache.getCached() ?? { supportReferences: [], twLinks: [] },
  );
  useEffect(() => {
    let mounted = true;
    // Stale-while-revalidate: render the cached value synchronously (above),
    // and kick off a background refresh (a no-op network call within the TTL
    // of the last one). If the refresh fails (e.g. offline), we keep showing
    // the cached value — no error surface.
    resourceCache
      .load()
      .then((c) => {
        if (mounted) setVal(c);
      })
      .catch(() => {
        /* keep cached value */
      });
    const unsubscribe = resourceCache.subscribe(setVal);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const twTitles = getTwTitlesMap(val.twTitles);
  return { ...val, twTitles };
}

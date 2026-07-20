import { useEffect, useMemo, useState } from "react";
import { api, type Catalogs } from "../sync/api";

// Persisted alongside the in-memory cache so an F5 while offline still shows
// type-ahead suggestions. Single payload, ~50-100KB — localStorage is the
// right tool (synchronous read, no schema, room to spare).
// v2: added twTitles (feeds canonicalTwlOrder headword anchoring). Bumped so
// a stale v1 payload (no twTitles) is never served — even under
// stale-while-revalidate — which would silently disagree with the export
// until the background refresh landed. The old v1 key is left alone.
const STORAGE_KEY = "bible-editor.catalogs.v2";

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
let cache: Catalogs | null = readPersisted();
let inflight: Promise<Catalogs> | null = null;
const subscribers = new Set<(c: Catalogs) => void>();

function load(): Promise<Catalogs> {
  if (inflight) return inflight;
  inflight = api.getCatalogs().then((c) => {
    cache = c;
    inflight = null;
    writePersisted(c);
    for (const s of subscribers) s(c);
    return c;
  }).catch((err) => {
    // Don't cache the rejection — a failed first fetch must retry on the
    // next mount, not leave pickers empty for the whole session.
    inflight = null;
    throw err;
  });
  return inflight;
}

// twTitles arrives from the API as a Record and is handed on as a Map (what
// canonicalTwlOrder takes), so the wire field has to be Omit-ted before being
// re-declared — intersecting Catalogs directly would demand a value that is
// both a Record and a Map, which nothing can satisfy.
export function useCatalogs(): Omit<Catalogs, "twTitles"> & { twTitles: Map<string, string> } {
  const [val, setVal] = useState<Catalogs>(
    () => cache ?? { supportReferences: [], twLinks: [] },
  );
  useEffect(() => {
    let mounted = true;
    // Stale-while-revalidate: render the cached value synchronously (above),
    // and kick off a background refresh. If the refresh fails (e.g. offline),
    // we keep showing the cached value — no error surface.
    load().then((c) => {
      if (mounted) setVal(c);
    }).catch(() => { /* keep cached value */ });
    subscribers.add(setVal);
    return () => {
      mounted = false;
      subscribers.delete(setVal);
    };
  }, []);
  // Memoized so callers (e.g. canonicalTwlOrder call sites) don't rebuild the
  // Map on every render — only when the underlying record actually changes.
  const twTitles = useMemo(() => new Map(Object.entries(val.twTitles ?? {})), [val.twTitles]);
  return { ...val, twTitles };
}

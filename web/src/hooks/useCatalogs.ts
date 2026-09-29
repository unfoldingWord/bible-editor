import { useEffect, useState } from "react";
import { api, type Catalogs } from "../sync/api";

// Persisted alongside the in-memory cache so an F5 while offline still shows
// type-ahead suggestions. Single payload, ~50-100KB — localStorage is the
// right tool (synchronous read, no schema, room to spare).
// v2: added twTitles (feeds canonicalTwlOrder headword anchoring). Bumped so
// a stale v1 payload (no twTitles) is never served — even under
// stale-while-revalidate — which would silently disagree with the export
// until the background refresh landed. The old v1 key is left alone.
const STORAGE_KEY = "bible-editor.catalogs.v2";

// A successful fetch is trusted this long before a mount revalidates. Every
// NoteCard / WordRow mounts this hook, so without a TTL each verse change
// re-downloaded the whole catalog (#886). Matches the server's memo TTL.
const TTL_MS = 10 * 60 * 1000;

// Returns the raw string too: it is exactly what the last fetch wrote, so a
// refresh can compare against it without re-serializing the cache.
function readPersisted(): { c: Catalogs; raw: string } | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Catalogs>;
    if (!Array.isArray(parsed.supportReferences) || !Array.isArray(parsed.twLinks)) return null;
    return {
      c: {
        supportReferences: parsed.supportReferences,
        twLinks: parsed.twLinks,
        disambiguationGroups: parsed.disambiguationGroups,
        disambiguationIndex: parsed.disambiguationIndex,
        twTitles: parsed.twTitles,
      },
      raw,
    };
  } catch {
    return null;
  }
}

function writePersisted(raw: string) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    /* quota or private mode — soft fail */
  }
}

// twTitles arrives from the API as a Record and is handed on as a Map (what
// canonicalTwlOrder takes). Built once per cache value and shared by every
// hook call, so consumers get one stable Map instead of ~950-entry copies.
const toTitles = (c: Catalogs | null) => new Map(Object.entries(c?.twTitles ?? {}));
const EMPTY: Catalogs = { supportReferences: [], twLinks: [] };
const EMPTY_TITLES = new Map<string, string>();

// Single in-module cache so every NoteCard/WordsTable shares the same fetch.
// Hydrate synchronously from localStorage so first render shows real data
// even if we're currently offline.
const persisted = readPersisted();
let cache: Catalogs | null = persisted?.c ?? null;
let cacheRaw: string | null = persisted?.raw ?? null;
let titles = toTitles(cache);
// 0 = not fetched this page load, so the first mount still revalidates the
// localStorage copy (stale-while-revalidate).
let fetchedAt = 0;
let inflight: Promise<Catalogs> | null = null;
const subscribers = new Set<(c: Catalogs) => void>();

function load(): Promise<Catalogs> {
  if (cache && Date.now() - fetchedAt < TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.getCatalogs().then((c) => {
    fetchedAt = Date.now();
    inflight = null;
    // Unchanged payload: keep the existing object so subscribers' setState is
    // a no-op (no re-render wave) and skip the ~100KB localStorage write.
    const raw = JSON.stringify(c);
    if (cache && raw === cacheRaw) return cache;
    cache = c;
    cacheRaw = raw;
    titles = toTitles(c);
    writePersisted(raw);
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

// The wire twTitles field has to be Omit-ted before being re-declared as a
// Map — intersecting Catalogs directly would demand a value that is both a
// Record and a Map, which nothing can satisfy.
export function useCatalogs(): Omit<Catalogs, "twTitles"> & { twTitles: Map<string, string> } {
  const [val, setVal] = useState<Catalogs>(() => cache ?? EMPTY);
  useEffect(() => {
    let mounted = true;
    // Stale-while-revalidate: render the cached value synchronously (above),
    // and revalidate in the background once the TTL has lapsed. If the
    // refresh fails (e.g. offline), we keep showing the cached value.
    load().then((c) => {
      if (mounted) setVal(c);
    }).catch(() => { /* keep cached value */ });
    subscribers.add(setVal);
    return () => {
      mounted = false;
      subscribers.delete(setVal);
    };
  }, []);
  // The shared Map belongs to `cache`. val differs from it only before the
  // first successful load (EMPTY) or for the render between a refresh landing
  // and this component's setState.
  const twTitles = val === cache ? titles : val === EMPTY ? EMPTY_TITLES : toTitles(val);
  return { ...val, twTitles };
}

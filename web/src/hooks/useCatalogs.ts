import { useEffect, useState } from "react";
import { api, type Catalogs } from "../sync/api";

// Persisted alongside the in-memory cache so an F5 while offline still shows
// type-ahead suggestions. Single payload, ~50-100KB — localStorage is the
// right tool (synchronous read, no schema, room to spare).
const STORAGE_KEY = "bible-editor.catalogs.v1";

function readPersisted(): Catalogs | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Catalogs>;
    if (!Array.isArray(parsed.supportReferences) || !Array.isArray(parsed.twLinks)) return null;
    return { supportReferences: parsed.supportReferences, twLinks: parsed.twLinks };
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

export function useCatalogs(): Catalogs {
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
  return val;
}

import { useEffect, useState } from "react";
import { api, type NoteTemplate } from "../sync/api";
import { createResourceCache } from "./resourceCache";

// Per-support-reference note templates, keyed by short support reference
// (e.g. "figs-metaphor"). Mirrors useCatalogs: a single shared fetch, a
// localStorage cache so an F5 while offline still has templates, and
// stale-while-revalidate on mount. The server edge-caches the upstream sheet
// in ~8h buckets, so revalidating on every chapter navigation is cheap — but
// #886 found the client side still refetched (and re-rendered every
// consumer) on every mount regardless, hence the same TTL share as
// useCatalogs.
type TemplateMap = Record<string, NoteTemplate[]>;

const STORAGE_KEY = "bible-editor.note-templates.v1";
const CACHE_TTL_MS = 10 * 60 * 1000;

function readPersisted(): TemplateMap | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as TemplateMap;
  } catch {
    return null;
  }
}

function writePersisted(m: TemplateMap) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* quota or private mode — soft fail */
  }
}

const resourceCache = createResourceCache<TemplateMap>({
  fetcher: () => api.getNoteTemplates().then((res) => res.templates),
  read: readPersisted,
  write: writePersisted,
  ttlMs: CACHE_TTL_MS,
});

export function useNoteTemplates(): TemplateMap {
  const [val, setVal] = useState<TemplateMap>(() => resourceCache.getCached() ?? {});
  useEffect(() => {
    let mounted = true;
    // Stale-while-revalidate: render the cached value synchronously (above),
    // kick off a background refresh, and keep the cached value if it fails
    // (e.g. offline, or the server's upstream sheet fetch is down).
    resourceCache
      .load()
      .then((m) => {
        if (mounted) setVal(m);
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
  return val;
}

import { useEffect, useState } from "react";
import { api, type NoteTemplate } from "../sync/api";

// Per-support-reference note templates, keyed by short support reference
// (e.g. "figs-metaphor"). Mirrors useCatalogs: a single shared fetch, a
// localStorage cache so an F5 while offline still has templates, and
// stale-while-revalidate on the first mount, then a TTL so later mounts (one
// per NoteCard, i.e. every verse change) reuse the cache (#886).
type TemplateMap = Record<string, NoteTemplate[]>;

const STORAGE_KEY = "bible-editor.note-templates.v1";

const TTL_MS = 10 * 60 * 1000;

// Returns the raw string too, so a refresh can detect an unchanged payload.
function readPersisted(): { m: TemplateMap; raw: string } | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { m: parsed as TemplateMap, raw };
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

const persisted = readPersisted();
let cache: TemplateMap | null = persisted?.m ?? null;
let cacheRaw: string | null = persisted?.raw ?? null;
let fetchedAt = 0;
let inflight: Promise<TemplateMap> | null = null;
const subscribers = new Set<(m: TemplateMap) => void>();

function load(): Promise<TemplateMap> {
  if (cache && Date.now() - fetchedAt < TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api
    .getNoteTemplates()
    .then((res) => {
      fetchedAt = Date.now();
      inflight = null;
      // Unchanged: keep the existing object so setState is a no-op, and skip
      // the localStorage write.
      const raw = JSON.stringify(res.templates);
      if (cache && raw === cacheRaw) return cache;
      cache = res.templates;
      cacheRaw = raw;
      writePersisted(raw);
      for (const s of subscribers) s(res.templates);
      return res.templates;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export function useNoteTemplates(): TemplateMap {
  const [val, setVal] = useState<TemplateMap>(() => cache ?? {});
  useEffect(() => {
    let mounted = true;
    // Stale-while-revalidate: render the cached value synchronously (above),
    // revalidate in the background once the TTL has lapsed, and keep the
    // cached value if it fails (e.g. offline, or the server's upstream sheet
    // fetch is down).
    load()
      .then((m) => {
        if (mounted) setVal(m);
      })
      .catch(() => {
        /* keep cached value */
      });
    subscribers.add(setVal);
    return () => {
      mounted = false;
      subscribers.delete(setVal);
    };
  }, []);
  return val;
}

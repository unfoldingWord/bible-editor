import { useEffect, useState } from "react";
import { api, type NoteTemplate } from "../sync/api";

// Per-support-reference note templates, keyed by short support reference
// (e.g. "figs-metaphor"). Mirrors useCatalogs: a single shared fetch, a
// localStorage cache so an F5 while offline still has templates, and
// stale-while-revalidate on mount. The server edge-caches the upstream sheet
// in ~8h buckets, so revalidating on every chapter navigation is cheap.
type TemplateMap = Record<string, NoteTemplate[]>;

const STORAGE_KEY = "bible-editor.note-templates.v1";

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

let cache: TemplateMap | null = readPersisted();
let inflight: Promise<TemplateMap> | null = null;
const subscribers = new Set<(m: TemplateMap) => void>();

function load(): Promise<TemplateMap> {
  if (inflight) return inflight;
  inflight = api
    .getNoteTemplates()
    .then((res) => {
      cache = res.templates;
      inflight = null;
      writePersisted(res.templates);
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
    // kick off a background refresh, and keep the cached value if it fails
    // (e.g. offline, or the server's upstream sheet fetch is down).
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

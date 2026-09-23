// Shared module-scope cache for hooks that fan a single fetch out to many
// mounted consumers (useCatalogs, useNoteTemplates): a TTL so a burst of
// mounts within the window reuses the last fetch instead of re-issuing one
// per mount, and a content-equality check so a revalidation that comes back
// unchanged skips the localStorage rewrite and the subscriber fan-out (which
// would otherwise re-render every mounted consumer for no reason). See #886.
export interface ResourceCacheOptions<T> {
  fetcher: () => Promise<T>;
  read: () => T | null;
  write: (value: T) => void;
  ttlMs: number;
  now?: () => number;
}

export interface ResourceCache<T> {
  getCached: () => T | null;
  load: () => Promise<T>;
  subscribe: (fn: (value: T) => void) => () => void;
}

export function createResourceCache<T>(opts: ResourceCacheOptions<T>): ResourceCache<T> {
  const now = opts.now ?? Date.now;
  let cache: T | null = opts.read();
  let inflight: Promise<T> | null = null;
  let fetchedAt = 0;
  let lastSerialized: string | null = cache !== null ? JSON.stringify(cache) : null;
  const subscribers = new Set<(value: T) => void>();

  function load(): Promise<T> {
    if (inflight) return inflight;
    // Within the TTL of a successful fetch, every caller shares that result —
    // no network round trip per mount.
    if (cache !== null && now() - fetchedAt < opts.ttlMs) {
      return Promise.resolve(cache);
    }
    inflight = opts
      .fetcher()
      .then((value) => {
        inflight = null;
        fetchedAt = now();
        const serialized = JSON.stringify(value);
        // Unchanged since the last fetch: keep the existing reference so
        // consumers that memoize off it (e.g. a derived Map) bail out, and
        // skip the localStorage write and subscriber notify.
        if (cache !== null && serialized === lastSerialized) return cache;
        lastSerialized = serialized;
        cache = value;
        opts.write(value);
        for (const s of subscribers) s(value);
        return value;
      })
      .catch((err) => {
        // Don't cache the rejection — the next mount (or the next call once
        // the TTL check above fails open) must retry, not stay empty.
        inflight = null;
        throw err;
      });
    return inflight;
  }

  return {
    getCached: () => cache,
    load,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// The lexicon store behind useLexicon, kept free of React and of the network
// and IndexedDB modules so it can be unit-tested with fakes
// (lexiconStore.test.mjs). useLexicon.ts creates the one app-wide instance.
//
// Each unique Strong's key is fetched at most once per page load. `version`
// bumps every time the in-memory cache changes, and useLexicon reads it with
// useSyncExternalStore. That hook re-checks `getVersion()` after it
// subscribes, so a component that rendered before a fetch resolved but
// subscribed after it still re-renders. A plain useState + subscribe in
// useEffect misses that case: ensure() finds every key cached, returns
// without notifying, and the component keeps a Map of nulls (#898, the
// review finding on PR #940).

export interface LexiconEntry {
  strong: string;
  resource: "uhal" | "ugl";
  lemma: string | null;
  part_of_speech: string | null;
  gloss: string | null;
  definition: string | null;
}

export interface LexiconStoreDeps {
  // Network lookup for normalized keys. Must throw on failure (non-OK status,
  // timeout, offline) so a failed lookup is not cached as "no such entry".
  fetchEntries: (strongs: string[]) => Promise<LexiconEntry[]>;
  getCached: (strongs: string[]) => Promise<Map<string, LexiconEntry | null>>;
  putCached: (map: Map<string, LexiconEntry | null>) => Promise<void>;
}

// Reduce 'b:H2320', 'H2148a', etc. to the keys the API can resolve. Returns
// the exact form and an alpha-stripped fallback ('H2148a' → ['H2148a','H2148']).
export function normalizeStrong(raw: string): string[] {
  if (!raw) return [];
  const m = raw.match(/[HG]\d+[a-z]?/i);
  if (!m) return [];
  const exact = m[0].toUpperCase().replace(/^([HG])0+/, "$1");
  const base = exact.replace(/[A-Z]$/, "");
  return exact === base ? [exact] : [exact, base];
}

export function createLexiconStore(deps: LexiconStoreDeps) {
  const cache = new Map<string, LexiconEntry | null>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();
  let version = 0;

  function changed() {
    version++;
    for (const fn of subscribers) fn();
  }

  async function ensure(rawStrongs: string[]): Promise<void> {
    const candidates: string[] = [];
    for (const s of rawStrongs) {
      for (const k of normalizeStrong(s)) {
        if (!cache.has(k) && !inFlight.has(k)) candidates.push(k);
      }
    }
    if (candidates.length === 0) return;

    // Try the persistent cache first: every IDB hit is one less network
    // call, and the only path that works while offline.
    const cached = await deps.getCached(candidates);
    for (const [k, entry] of cached) cache.set(k, entry);
    const want = candidates.filter((k) => !cache.has(k));
    if (cached.size > 0) changed();
    if (want.length === 0) return;

    for (const k of want) inFlight.add(k);
    try {
      const entries = await deps.fetchEntries(want);
      const byStrong = new Map(entries.map((e) => [e.strong, e]));
      const fresh = new Map<string, LexiconEntry | null>();
      for (const k of want) {
        const entry = byStrong.get(k) ?? null;
        cache.set(k, entry);
        fresh.set(k, entry);
      }
      // Persist for next reload. Includes nulls so an explicit "we asked, no
      // such Strong's" answer is remembered too.
      void deps.putCached(fresh);
      changed();
    } catch {
      // Network failure, timeout or non-OK status: don't poison the cache
      // (in memory or IndexedDB) with nulls, so a later call can retry.
    } finally {
      for (const k of want) inFlight.delete(k);
    }
  }

  function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  function getVersion(): number {
    return version;
  }

  // Map keyed by the *input* raw form, so callers look up by what they have.
  function lookup(rawStrongs: string[]): Map<string, LexiconEntry | null> {
    const out = new Map<string, LexiconEntry | null>();
    for (const raw of rawStrongs) {
      let hit: LexiconEntry | null = null;
      for (const k of normalizeStrong(raw)) {
        const v = cache.get(k);
        if (v) {
          hit = v;
          break;
        }
      }
      out.set(raw, hit);
    }
    return out;
  }

  return { ensure, subscribe, getVersion, lookup };
}

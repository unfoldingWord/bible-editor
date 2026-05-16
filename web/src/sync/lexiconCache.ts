// IndexedDB-backed lexicon cache. Strong's entries are content-addressable —
// H2320 means the same thing forever — so we treat IDB hits as authoritative
// and never invalidate within a schema version. A future shape change just
// bumps DB_VERSION and the upgrade tears down the store.
//
// The in-memory `cache` Map in useLexicon stays the synchronous read source
// (React renders shouldn't hit IDB on every word). This module warms it from
// IDB at startup and writes through on successful network fetches.

import { openDB, type IDBPDatabase } from "idb";

import type { LexiconEntry } from "../hooks/useLexicon";

const DB_NAME = "bible-editor-lexicon";
const DB_VERSION = 1;
const STORE = "lexicon";

// Stored shape: `{strong, entry}` where `entry` is the LexiconEntry or null
// for explicit "we asked and there's no entry". Storing null misses lets us
// skip a network roundtrip for known-empty Strong's keys.
interface LexiconRow {
  strong: string;
  entry: LexiconEntry | null;
}

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "strong" });
        }
      },
    });
  }
  return dbp;
}

export async function getEntries(
  strongs: string[],
): Promise<Map<string, LexiconEntry | null>> {
  const out = new Map<string, LexiconEntry | null>();
  if (strongs.length === 0) return out;
  try {
    const idb = await db();
    const tx = idb.transaction(STORE, "readonly");
    for (const k of strongs) {
      const row = (await tx.store.get(k)) as LexiconRow | undefined;
      if (row) out.set(k, row.entry);
    }
    await tx.done;
  } catch {
    /* IDB blocked / private mode — degrade to no-cache */
  }
  return out;
}

export async function putEntries(map: Map<string, LexiconEntry | null>): Promise<void> {
  if (map.size === 0) return;
  try {
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    for (const [strong, entry] of map) {
      await tx.store.put({ strong, entry } satisfies LexiconRow);
    }
    await tx.done;
  } catch {
    /* soft fail */
  }
}

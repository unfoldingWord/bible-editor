// Per-browser display prefs kept in localStorage, with one live value per key
// so every control showing a pref stays in step (issue #1228): the Scripture
// toolbar toggle and the Display settings menu both read and write here.
//
// The browser's `storage` event only fires in *other* tabs, so a same-tab
// write notifies subscribers directly; the window listener covers other tabs.
// Values written here also live in memory, so a write still takes effect in
// this tab when localStorage refuses it (private mode, quota).
//
// Pure module (no React) so the strip-types test runner can load it; the
// hook lives in ../hooks/usePref.ts.

// Columns mode: stronger tint on the active verse (#1226). "0" = off; on by default.
export const PREF_COLUMNS_EMPHASIZE_ACTIVE = "be:columnsEmphasizeActive";

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
const memory = new Map<string, string | null>();
let windowListenerInstalled = false;

function notify(key: string) {
  listeners.get(key)?.forEach((fn) => fn());
}

function onStorage(e: { key: string | null; newValue: string | null }) {
  // key === null: another tab called localStorage.clear().
  if (e.key === null) {
    memory.clear();
    for (const key of Array.from(listeners.keys())) notify(key);
    return;
  }
  if (!listeners.has(e.key) && !memory.has(e.key)) return;
  memory.set(e.key, e.newValue);
  notify(e.key);
}

export function readPref(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  notify(key);
}

export function subscribePref(key: string, fn: Listener): () => void {
  if (!windowListenerInstalled && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    windowListenerInstalled = true;
  }
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
  };
}

export function parseBoolPref(raw: string | null, fallback: boolean): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return fallback;
}

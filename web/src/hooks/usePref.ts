import { useCallback, useSyncExternalStore } from "react";
import { parseBoolPref, readPref, subscribePref, writePref } from "../lib/prefStore";

// A boolean display pref shared by every control that shows it, in this tab
// and others (issue #1228). Stored as "1"/"0"; absent means `fallback`.
export function useBoolPref(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const raw = useSyncExternalStore(
    useCallback((cb: () => void) => subscribePref(key, cb), [key]),
    () => readPref(key),
  );
  const set = useCallback((v: boolean) => writePref(key, v ? "1" : "0"), [key]);
  return [parseBoolPref(raw, fallback), set];
}

import { useCallback, useEffect, useState } from "react";
import { api, type Term, type TranslationPrefs, type TranslationExample } from "../sync/api";

// Preferences singleton (brief + instructions + register + assisted flag).
// `enabled === false` yields an idle result so the caller can gate on the
// translation-project check without conditionally calling the hook.
export function useTranslationPrefs(enabled: boolean): {
  prefs: TranslationPrefs | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const [prefs, setPrefs] = useState<TranslationPrefs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled) {
      setPrefs(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTranslationPrefs()
      .then((res) => {
        if (cancelled) return;
        setPrefs(res.prefs);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  return { prefs, loading, error, refetch };
}

// Terminology list, filterable by status / free-text query.
export function useTerms(
  enabled: boolean,
  opts: { status?: string; q?: string },
): { terms: Term[]; loading: boolean; error: Error | null; refetch: () => void } {
  const [terms, setTerms] = useState<Term[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  const { status, q } = opts;

  useEffect(() => {
    if (!enabled) {
      setTerms([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTerms({ status, q })
      .then((res) => {
        if (cancelled) return;
        setTerms(res.terms);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, status, q, reloadKey]);

  return { terms, loading, error, refetch };
}

// Validated-examples browse (read-only). resource + optional filters.
export function useExamples(
  enabled: boolean,
  opts: { resource: "tn" | "tq"; supportReference?: string; q?: string; limit?: number },
): { examples: TranslationExample[]; loading: boolean; error: Error | null; refetch: () => void } {
  const [examples, setExamples] = useState<TranslationExample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  const { resource, supportReference, q, limit } = opts;

  useEffect(() => {
    if (!enabled) {
      setExamples([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getExamples({ resource, supportReference, q, limit })
      .then((res) => {
        if (cancelled) return;
        setExamples(res.examples);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, resource, supportReference, q, limit, reloadKey]);

  return { examples, loading, error, refetch };
}

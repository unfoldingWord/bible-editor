// useChapter — pulls the whole chapter payload from the API and provides
// helpers for optimistic local mutations. Listens to outbox results so a
// successful drain refreshes the affected row in place without a full
// re-fetch (cheap and avoids flicker).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ChapterPayload, type TnRow, type TqRow, type TwlRow } from "../sync/api";
import { onOutboxResult } from "../sync/outbox";

type Status = "idle" | "loading" | "ready" | "error";

export interface UseChapterReturn {
  status: Status;
  data: ChapterPayload | null;
  error: string | null;
  refetch: () => Promise<void>;
  applyLocalRowPatch: (kind: "tn" | "tq" | "twl", id: string, patch: Partial<TnRow & TqRow & TwlRow>) => void;
  applyLocalRowReplacement: (kind: "tn" | "tq" | "twl", row: TnRow | TqRow | TwlRow) => void;
}

export function useChapter(book: string, chapter: number): UseChapterReturn {
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<ChapterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refetch = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const payload = await api.getChapter(book, chapter);
      if (!mounted.current) return;
      setData(payload);
      setStatus("ready");
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof ApiError ? `HTTP ${e.status}` : String(e));
      setStatus("error");
    }
  }, [book, chapter]);

  useEffect(() => {
    mounted.current = true;
    void refetch();
    return () => {
      mounted.current = false;
    };
  }, [refetch]);

  const applyLocalRowPatch = useCallback<UseChapterReturn["applyLocalRowPatch"]>(
    (kind, id, patch) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowReplacement = useCallback<UseChapterReturn["applyLocalRowReplacement"]>(
    (kind, row) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === row.id ? row : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  // Adopt server-confirmed values when an outbox op succeeds.
  useEffect(() => {
    return onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      if (op.target.kind !== "row") return;
      const u = result.updated as TnRow | TqRow | TwlRow;
      if (u && u.book === book && u.chapter === chapter) {
        applyLocalRowReplacement(op.target.rowKind, u);
      }
    });
  }, [book, chapter, applyLocalRowReplacement]);

  return { status, data, error, refetch, applyLocalRowPatch, applyLocalRowReplacement };
}

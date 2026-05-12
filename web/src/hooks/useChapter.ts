// useChapter — pulls the whole chapter payload from the API and provides
// helpers for optimistic local mutations. Listens to outbox results so a
// successful drain refreshes the affected row in place without a full
// re-fetch (cheap and avoids flicker).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type ChapterPayload,
  type TnRow,
  type TqRow,
  type TwlRow,
  type VerseDto,
} from "../sync/api";
import { onOutboxResult } from "../sync/outbox";

type Status = "idle" | "loading" | "ready" | "error";

export interface UseChapterReturn {
  status: Status;
  data: ChapterPayload | null;
  error: string | null;
  refetch: () => Promise<void>;
  applyLocalRowPatch: (kind: "tn" | "tq" | "twl", id: string, patch: Partial<TnRow & TqRow & TwlRow>) => void;
  applyLocalRowReplacement: (kind: "tn" | "tq" | "twl", row: TnRow | TqRow | TwlRow) => void;
  applyLocalRowDelete: (kind: "tn" | "tq" | "twl", id: string) => void;
  applyLocalRowInsert: (
    kind: "tn" | "tq" | "twl",
    row: TnRow | TqRow | TwlRow,
    position?: { afterId?: string },
  ) => void;
  applyLocalVerse: (verse: VerseDto) => void;
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

  const applyLocalRowDelete = useCallback<UseChapterReturn["applyLocalRowDelete"]>(
    (kind, id) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.filter((r) => r.id !== id);
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowInsert = useCallback<UseChapterReturn["applyLocalRowInsert"]>(
    (kind, row, position) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        // Skip if a row with this id is already present (e.g. createRow response
        // racing with an outbox replacement).
        if (list.some((r) => r.id === row.id)) return prev;
        let next: Array<TnRow | TqRow | TwlRow>;
        const afterId = position?.afterId;
        if (afterId) {
          const idx = list.findIndex((r) => r.id === afterId);
          if (idx >= 0) {
            next = [...list.slice(0, idx + 1), row, ...list.slice(idx + 1)];
          } else {
            next = [...list, row];
          }
        } else {
          next = [...list, row];
        }
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalVerse = useCallback<UseChapterReturn["applyLocalVerse"]>(
    (verse) => {
      setData((prev) => {
        if (!prev) return prev;
        const byVersion = prev.verses[verse.bible_version] ?? {};
        const nextVersion = { ...byVersion, [verse.verse]: verse };
        return {
          ...prev,
          verses: { ...prev.verses, [verse.bible_version]: nextVersion },
        };
      });
    },
    [],
  );

  // Adopt server-confirmed values when an outbox op succeeds.
  useEffect(() => {
    return onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      if (op.target.kind === "row") {
        const u = result.updated as TnRow | TqRow | TwlRow;
        if (u && u.book === book && u.chapter === chapter) {
          applyLocalRowReplacement(op.target.rowKind, u);
        }
        return;
      }
      if (op.target.kind === "verse") {
        const v = result.updated as VerseDto;
        if (v && v.book === book && v.chapter === chapter) {
          applyLocalVerse(v);
        }
      }
    });
  }, [book, chapter, applyLocalRowReplacement, applyLocalVerse]);

  return {
    status,
    data,
    error,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
    applyLocalVerse,
  };
}

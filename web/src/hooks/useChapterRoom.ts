// React wrapper around openChapterRoom — subscribes to the live event
// stream for {book, chapter} and dispatches typed handlers.
//
// Handlers are held in a ref so the caller can pass fresh closures every
// render without retriggering the WS reconnect. The effect only depends
// on (book, chapter); it tears down the socket on unmount or when the
// chapter changes.

import { useEffect, useRef } from "react";
import { openChapterRoom } from "../sync/wsClient";
import type { TnRow, TqRow, TwlRow, VerseDto } from "../sync/api";

type RowKind = "tn" | "tq" | "twl";
type AnyRow = TnRow | TqRow | TwlRow;

interface WireEvent {
  type: string;
  kind?: RowKind;
  row?: AnyRow;
  id?: string;
  version?: number;
  verse?: VerseDto;
}

export interface UseChapterRoomHandlers {
  onUpsert: (kind: RowKind, row: AnyRow) => void;
  onDelete: (kind: RowKind, id: string) => void;
  onVerseUpdate: (verse: VerseDto) => void;
}

export function useChapterRoom(
  book: string,
  chapter: number,
  handlers: UseChapterRoomHandlers,
): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const cleanup = openChapterRoom(book, chapter, {
      onEvent: (raw) => {
        const ev = raw as WireEvent | null;
        if (!ev || typeof ev.type !== "string") return;
        if (ev.type === "row.upserted" && ev.kind && ev.row) {
          handlersRef.current.onUpsert(ev.kind, ev.row);
          return;
        }
        if (ev.type === "row.deleted" && ev.kind && typeof ev.id === "string") {
          handlersRef.current.onDelete(ev.kind, ev.id);
          return;
        }
        if (ev.type === "verse.updated" && ev.verse) {
          handlersRef.current.onVerseUpdate(ev.verse);
          return;
        }
      },
    });
    return cleanup;
  }, [book, chapter]);
}

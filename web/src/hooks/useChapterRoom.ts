// React wrapper around openChapterRoom — subscribes to the live event
// stream for {book, chapter} and dispatches typed handlers.
//
// Handlers are held in a ref so the caller can pass fresh closures every
// render without retriggering the WS reconnect. The effect only depends
// on (book, chapter); it tears down the socket on unmount or when the
// chapter changes.

import { useEffect, useRef } from "react";
import { openChapterRoom } from "../sync/wsClient";
import type { TnRow, TqRow, TwlRow, VerseDto, VerseStatus, LaneCheckState, VerseLaneCheck, CheckLane, TwlOrderLock, CommentDto } from "../sync/api";

type RowKind = "tn" | "tq" | "twl";
type AnyRow = TnRow | TqRow | TwlRow;

interface WireEvent {
  type: string;
  kind?: RowKind;
  row?: AnyRow;
  id?: string;
  version?: number;
  verse?: VerseDto;
  status?: VerseStatus;
  check?: LaneCheckState;
  lane?: CheckLane;
  checks?: VerseLaneCheck[];
  book?: string;
  chapter?: number;
  pipeline_type?: string;
  // TWL manual-order lock. `verseNum` rather than reusing `verse` above, which
  // already means a VerseDto on the wire — a same-named field of a different
  // type in one union is exactly the kind of thing that type-checks and then
  // fails at runtime.
  verseNum?: number;
  lock?: TwlOrderLock | null;
  comment?: CommentDto;
}

export interface UseChapterRoomHandlers {
  onUpsert: (kind: RowKind, row: AnyRow) => void;
  onDelete: (kind: RowKind, id: string) => void;
  onVerseUpdate: (verse: VerseDto) => void;
  onVerseStatusUpdate: (status: VerseStatus) => void;
  onLaneCheckUpdate: (check: LaneCheckState) => void;
  onLaneCheckBulkUpdate: (lane: CheckLane, checks: VerseLaneCheck[]) => void;
  // Another tab took a verse's TWL order manual (or handed it back). Ordering is
  // a whole-verse switch, so a stale tab would otherwise keep showing the other
  // order until a reload.
  onTwlOrderLockUpdate?: (verse: number, lock: TwlOrderLock | null) => void;
  // An AI pipeline wrote rows into this chapter out of band — the row list is
  // stale. Optional: tabs that don't care (or aren't this chapter) can ignore it.
  onPipelineApplied?: (book: string, chapter: number, pipelineType: string) => void;
  // A comment was created, edited, resolved, or deleted (soft) by any tab.
  // Optional: tabs without a comments UI mounted can ignore it.
  onCommentUpdate?: (comment: CommentDto) => void;
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
        if (ev.type === "verse_status.updated" && ev.status) {
          handlersRef.current.onVerseStatusUpdate(ev.status);
          return;
        }
        if (ev.type === "lane_check.updated" && ev.check) {
          handlersRef.current.onLaneCheckUpdate(ev.check);
          return;
        }
        if (ev.type === "comment.updated" && ev.comment) {
          handlersRef.current.onCommentUpdate?.(ev.comment);
          return;
        }
        if (ev.type === "lane_check.bulk" && ev.lane && Array.isArray(ev.checks)) {
          handlersRef.current.onLaneCheckBulkUpdate(ev.lane, ev.checks);
          return;
        }
        if (ev.type === "twl_order_lock.updated" && typeof ev.verseNum === "number") {
          handlersRef.current.onTwlOrderLockUpdate?.(ev.verseNum, ev.lock ?? null);
          return;
        }
        if (
          ev.type === "chapter.pipeline_applied" &&
          typeof ev.book === "string" &&
          typeof ev.chapter === "number" &&
          typeof ev.pipeline_type === "string"
        ) {
          handlersRef.current.onPipelineApplied?.(ev.book, ev.chapter, ev.pipeline_type);
          return;
        }
      },
    });
    return cleanup;
  }, [book, chapter]);
}

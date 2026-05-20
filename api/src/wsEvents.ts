// Shared types + fanout helper for ChapterRoom broadcasts.
//
// Server-initiated path: rows.ts (and any other handler that mutates a
// chapter's row state) calls broadcastChapter(...) after the DB commit
// succeeds. The ChapterRoom DO receives a POST /broadcast and sends the
// stringified event to every connected WebSocket in the room.
//
// Wire format is a discriminated union on `type`. Clients dedupe by row
// version (incoming version <= local version → ignore), which also makes
// the originating user's own tab idempotent (their HTTP response already
// updated their state).

import type { Env } from "./index";
import type { RowKind, TnRow, TqRow, TwlRow, VerseDto, VerseStatus } from "./types";

export type WsEvent =
  | { type: "row.upserted"; kind: RowKind; row: TnRow | TqRow | TwlRow }
  | { type: "row.deleted"; kind: RowKind; id: string; version: number }
  | { type: "verse.updated"; verse: VerseDto }
  | { type: "verse_status.updated"; status: VerseStatus };

export async function broadcastChapter(
  env: Env,
  book: string,
  chapter: number,
  event: WsEvent,
): Promise<void> {
  try {
    const id = env.CHAPTER_ROOM.idFromName(`${book}:${chapter}`);
    const stub = env.CHAPTER_ROOM.get(id);
    await stub.fetch(
      new Request("http://do/broadcast", {
        method: "POST",
        body: JSON.stringify(event),
        headers: { "content-type": "application/json" },
      }),
    );
  } catch (e) {
    // A fanout failure shouldn't roll back a committed DB write — the row
    // is already persisted, the worst case is the other tab refreshes
    // manually (today's behavior).
    console.error("broadcastChapter failed", {
      book,
      chapter,
      type: event.type,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

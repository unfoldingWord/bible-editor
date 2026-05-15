// Thin WebSocket connection manager for the per-chapter ChapterRoom DO.
//
// Opens a socket to /api/ws/chapter/:book/:chapter with the user's JWT in
// the subprotocol slot ("bearer.<jwt>") — the standard Authorization
// header isn't settable on `new WebSocket(...)` so subprotocol is the
// browser-compatible escape hatch.
//
// Listen-only for now: clients don't push anything on this socket. Server
// broadcasts on row writes (see api/src/rows.ts → broadcastChapter).
//
// Reconnects with exponential backoff (1s, 2s, 4s, ..., cap 30s). On a
// successful `open`, backoff resets to 1s so a brief blip during a deploy
// doesn't leave the client paused for half a minute on the next failure.

import { getAuthToken } from "./api";

export interface WsHandlers {
  onEvent: (event: unknown) => void;
  onOpen?: () => void;
  onError?: (e: Event) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function wsUrl(book: string, chapter: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/ws/chapter/${encodeURIComponent(book)}/${chapter}`;
}

export function openChapterRoom(
  book: string,
  chapter: number,
  handlers: WsHandlers,
): () => void {
  let disposed = false;
  let socket: WebSocket | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (disposed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (disposed) return;
    const token = getAuthToken();
    if (!token) {
      // Token not yet in localStorage (App.tsx still completing its dev
      // mint). Hold off and try again — don't burn the backoff window on
      // a state that resolves in <1s.
      reconnectTimer = setTimeout(connect, 250);
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(book, chapter), [`bearer.${token}`]);
    } catch (e) {
      handlers.onError?.(new Event("error"));
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      backoffMs = INITIAL_BACKOFF_MS;
      handlers.onOpen?.();
    });
    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        handlers.onEvent(data);
      } catch {
        // Malformed frame — ignore. Server only sends JSON.
      }
    });
    ws.addEventListener("error", (ev) => {
      handlers.onError?.(ev);
    });
    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      if (!disposed) scheduleReconnect();
    });
  };

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      try {
        socket.close(1000, "client disconnect");
      } catch {
        /* best effort */
      }
      socket = null;
    }
  };
}

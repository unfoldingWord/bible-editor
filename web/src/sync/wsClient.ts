// Thin WebSocket connection manager for the per-chapter ChapterRoom DO.
//
// Opens a same-origin WebSocket to /api/ws/chapter/:book/:chapter. The
// Access cookie travels with the upgrade request automatically (cookies
// ride on WS handshakes same-origin); no token plumbing needed on the
// client.
//
// Listen-only for now: clients don't push anything on this socket. Server
// broadcasts on row writes (see api/src/rows.ts → broadcastChapter).
//
// Reconnects with exponential backoff (1s, 2s, 4s, ..., cap 30s). On a
// successful `open`, backoff resets to 1s so a brief blip during a deploy
// doesn't leave the client paused for half a minute on the next failure.

export interface WsHandlers {
  onEvent: (event: unknown) => void;
  onOpen?: () => void;
  onError?: (e: Event) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

// App-level JSON ping/pong. Cloudflare's native WebSocket ping/pong is only
// available via the hibernation API (state.acceptWebSocket), which this DO
// doesn't use yet. Picked 20s / 40s so a half-open socket (laptop closed,
// load balancer dropped the connection without FIN) is detected within a
// reasonable window without burning bandwidth on healthy idle sockets.
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 40_000;

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

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongDeadline: ReturnType<typeof setTimeout> | null = null;
  let visibilityHandler: (() => void) | null = null;

  const clearHeartbeat = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (pongDeadline) { clearTimeout(pongDeadline); pongDeadline = null; }
    if (visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
  };

  const armPongDeadline = () => {
    if (pongDeadline) clearTimeout(pongDeadline);
    pongDeadline = setTimeout(() => {
      // The server hasn't replied to our ping. Force-close with a private
      // code (4000-4999 is application-defined) — the existing close
      // handler reconnects, so this is the cheap way to recover a half-open
      // socket without growing the state machine.
      const ws = socket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(4001, "pong timeout"); } catch { /* best effort */ }
      }
    }, PONG_TIMEOUT_MS);
  };

  const connect = () => {
    if (disposed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(book, chapter));
    } catch (e) {
      handlers.onError?.(new Event("error"));
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      backoffMs = INITIAL_BACKOFF_MS;
      handlers.onOpen?.();
      // Start the heartbeat once we know the connection actually opened.
      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* will surface via close */ }
        armPongDeadline();
      }, PING_INTERVAL_MS);
      // Background tabs throttle setInterval to ~1min; when the tab returns
      // to foreground the pong deadline armed before sleep can fire
      // immediately. Reset the deadline on visibility so we don't tear down
      // a connection that's actually fine.
      if (typeof document !== "undefined") {
        visibilityHandler = () => {
          if (!document.hidden && pongDeadline) {
            armPongDeadline();
          }
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      }
    });
    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        // Swallow pong frames — they're plumbing, not events for callers.
        if (data && typeof data === "object" && (data as { type?: unknown }).type === "pong") {
          if (pongDeadline) { clearTimeout(pongDeadline); pongDeadline = null; }
          return;
        }
        handlers.onEvent(data);
      } catch {
        // Malformed frame — ignore. Server only sends JSON.
      }
    });
    ws.addEventListener("error", (ev) => {
      handlers.onError?.(ev);
    });
    ws.addEventListener("close", () => {
      clearHeartbeat();
      if (socket === ws) socket = null;
      if (!disposed) scheduleReconnect();
    });
  };

  connect();

  return () => {
    disposed = true;
    clearHeartbeat();
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

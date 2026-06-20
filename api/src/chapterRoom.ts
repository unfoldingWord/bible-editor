import type { Env } from "./index";
import type { WsEvent } from "./wsEvents";

// One DO per {book, chapter}. Holds a Set of open WebSockets; server-
// initiated broadcasts (POST /broadcast, called from rows.ts) fan to all
// of them. Clients are listen-only for the MVP — no client→client echo,
// no presence; both are future polish that won't require redoing this.
//
// In-memory state is fine because the DO stays alive only while at least
// one socket is open. Hibernation (state.acceptWebSocket) is deliberately
// skipped for now; revisit if active rooms grow enough that DO duration
// billing matters.
// Max concurrent WS clients per chapter room. A single DO holds these all in
// memory and fans every broadcast through them, so the cap protects against
// both runaway memory and broadcast amplification (one PATCH × N sockets).
// Real chapter rooms peak at a handful of translators; 100 is well above
// any legitimate load.
const MAX_CLIENTS_PER_ROOM = 100;

export class ChapterRoom implements DurableObject {
  private clients = new Set<WebSocket>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    void this.state;
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/broadcast") {
      let event: WsEvent;
      try {
        event = (await request.json()) as WsEvent;
      } catch {
        return new Response("invalid body", { status: 400 });
      }
      const payload = JSON.stringify(event);
      for (const ws of this.clients) {
        if (ws.readyState === WebSocket.READY_STATE_OPEN) {
          try {
            ws.send(payload);
          } catch {
            // Dead socket — the close listener will prune it. Best effort.
          }
        }
      }
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // Cap before accept() — once we accept the socket, refusing it later is
    // an ugly handshake error in the browser.
    if (this.clients.size >= MAX_CLIENTS_PER_ROOM) {
      return new Response("room full", { status: 503 });
    }

    // ACCEPTED TRADEOFF — listen-only presence sockets are not re-validated.
    // index.ts verifies the JWT once, at the upgrade request. After accept()
    // the socket is never re-checked, so a tab whose token expires keeps
    // receiving broadcasts until the socket itself drops (tab close, network
    // blip, or the 20s app-ping detecting a half-open connection). This is
    // intentional: our JWT TTL is deliberately decoupled from the DCS access
    // token, the socket carries no write authority (HTTP + If-Match is the
    // only mutation path and re-authes every request), and the broadcast
    // payload is non-sensitive editorial presence/change-hint data. Re-auth on
    // a long-lived presence socket would be a large change for no security
    // gain here; if that calculus ever changes (sensitive payloads, write
    // capability), this is the place to add periodic re-validation.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    this.clients.add(server);
    // App-level pong reply. Clients ping every 20s to detect half-open
    // sockets; without this the client would tear down healthy connections.
    server.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (data && typeof data === "object" && (data as { type?: unknown }).type === "ping") {
          server.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        /* malformed frame — ignore */
      }
    });
    server.addEventListener("close", () => this.clients.delete(server));
    server.addEventListener("error", () => this.clients.delete(server));

    // Echo the negotiated subprotocol so the browser handshake completes.
    // index.ts already verified the JWT carried in this header — the DO
    // doesn't re-validate; it just bounces the value back to the client.
    const protoHeader = request.headers.get("sec-websocket-protocol");
    const init: ResponseInit & { webSocket: WebSocket } = {
      status: 101,
      webSocket: client,
    };
    if (protoHeader) {
      const proto = protoHeader.split(",")[0].trim();
      init.headers = { "sec-websocket-protocol": proto };
    }
    return new Response(null, init);
  }
}

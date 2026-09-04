// Pure open-handling for the ChapterRoom WebSocket (wsClient.ts). Framework-
// and DOM-free so the strip-types runner can test it without a fake socket
// (wsOpen.test.mjs).
//
// WHY THIS IS ITS OWN SEAM. The subscription's structural events
// (verse.bridged / verse.split) have no replay: anything broadcast before the
// socket is up, or while it is down, is gone. The subscriber's remedy is a
// merging refetch (Shell → useChapter.refetch({ keepNewerLocal: true })), and
// the invariant it must uphold is:
//
//   the verse map the tab ends up with derives from a snapshot taken AFTER the
//   room subscription was established, or is reconciled by a merging refetch
//   issued after it.
//
// The first open used to be excluded from that refetch (only `onReconnect`
// fired, gated on "had any socket opened before"), on the theory that the
// mount GET already covered it. It does not: the mount GET starts
// independently of the socket, so a bridge/split committed after the GET's
// snapshot but before the socket's first `open` was never seen — the tab kept
// a deleted verse (whose next save 404s) or lacked split-created verses until
// a reload. `notifyOpen` therefore fires `onOpen` on EVERY open, first
// included, and tells the subscriber which kind it was.

export interface WsOpenInfo {
  /**
   * True when an earlier socket in this subscription's lifetime had already
   * reached `open` — i.e. this open is a recovery after a drop. False for the
   * first open. Subscribers reconcile on both; the flag is informational
   * (logging, backoff decisions), not a gate on reconciliation.
   */
  reconnect: boolean;
}

export interface WsOpenHandlers {
  /** Fired on every successful `open`, first connection included. */
  onOpen?: (info: WsOpenInfo) => void;
  /**
   * Convenience: fired only when `info.reconnect` is true. Kept so a consumer
   * that only cares about recoveries need not inspect the flag. Anything that
   * must not miss structural events must use `onOpen`, not this.
   */
  onReconnect?: () => void;
}

/**
 * What a successful `open` means, given whether any earlier socket in this
 * subscription had opened.
 */
export function describeOpen(everOpened: boolean): WsOpenInfo {
  return { reconnect: everOpened };
}

/**
 * Deliver the notifications for one successful `open`. `onOpen` always fires
 * (with the reconnect flag); `onReconnect` fires only for a reconnect. Returns
 * the info so the caller can log or assert on it.
 */
export function notifyOpen(handlers: WsOpenHandlers, everOpened: boolean): WsOpenInfo {
  const info = describeOpen(everOpened);
  handlers.onOpen?.(info);
  if (info.reconnect) handlers.onReconnect?.();
  return info;
}

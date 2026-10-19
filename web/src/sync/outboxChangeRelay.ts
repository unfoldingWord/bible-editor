// #1220 item 4: the outbox lives in IndexedDB, shared by every tab, but its
// subscriber notifications are tab-local. So when one tab changed the outbox
// (a newer save landed and released a held Text done mark, a refused op was
// discarded or retried), the other tabs kept showing the old waiting mark or
// refused chip until their own next outbox event.
//
// Each tab announces its outbox changes over a BroadcastChannel; every other
// tab re-reads the outbox and re-notifies its subscribers. The re-read is a
// local notify only, so it never announces again (BroadcastChannel also never
// delivers to the sender), and no message loops between tabs.
//
// Pure apart from the injected channel, so it is unit-tested in
// outboxChangeRelay.test.mjs (outbox.ts cannot be imported in Node).

interface RelayChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  removeEventListener?(type: "message", fn: (e: { data: unknown }) => void): void;
}

export interface OutboxChangeRelay {
  /** This tab changed the outbox: tell the other tabs to re-read it. */
  announce(): void;
  close(): void;
}

export function createOutboxChangeRelay(deps: {
  channel: RelayChannel | null;
  onRemoteChange(): void;
}): OutboxChangeRelay {
  const onMessage = () => deps.onRemoteChange();
  deps.channel?.addEventListener("message", onMessage);
  return {
    announce() {
      try {
        deps.channel?.postMessage({ changed: true });
      } catch {
        /* a closed channel: the other tabs catch up on their next event */
      }
    },
    close() {
      deps.channel?.removeEventListener?.("message", onMessage);
    },
  };
}

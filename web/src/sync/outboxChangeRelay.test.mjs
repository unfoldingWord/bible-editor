// Tests for web/src/sync/outboxChangeRelay.ts (#1220 item 4): a change to the
// shared outbox in one tab makes every other tab re-read it, so a Text done
// mark released (or a refused chip cleared) in one tab clears in the others.

import assert from "node:assert/strict";

// Missing-module fallback so the cases fail on the outcome, not on the import.
const mod = await import("./outboxChangeRelay.ts").catch(() => ({}));

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// In-memory BroadcastChannel: delivered to every other channel, never the
// sender's, asynchronously.
function hub() {
  const chans = new Set();
  return {
    channel() {
      const ch = {
        listeners: new Set(),
        postMessage(m) {
          const data = structuredClone(m);
          for (const o of chans) if (o !== ch) for (const l of o.listeners) setTimeout(() => l({ data }), 0);
        },
        addEventListener(type, fn) {
          if (type === "message") ch.listeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === "message") ch.listeners.delete(fn);
        },
      };
      chans.add(ch);
      return ch;
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const make = (h) => {
  const t = { reread: 0 };
  t.relay = mod.createOutboxChangeRelay?.({ channel: h ? h.channel() : null, onRemoteChange: () => t.reread++ }) ?? {
    announce: () => {},
    close: () => {},
  };
  return t;
};

{
  const h = hub();
  const a = make(h);
  const b = make(h);
  const c = make(h);
  a.relay.announce();
  await tick();
  check(b.reread === 1 && c.reread === 1, "a change in one tab makes every other tab re-read the outbox");
  check(a.reread === 0, "the announcing tab is not told about its own change");
  await tick();
  check(a.reread === 0 && b.reread === 1, "a remote re-read does not bounce back");
  b.relay.close();
  a.relay.announce();
  await tick();
  check(b.reread === 1 && c.reread === 2, "a closed relay stops listening");
}
{
  const t = make(null);
  t.relay.announce();
  check(!!mod.createOutboxChangeRelay && t.reread === 0, "no BroadcastChannel: announce is a no-op");
}
{
  const throwing = { postMessage() { throw new Error("closed"); }, addEventListener() {} };
  const relay = mod.createOutboxChangeRelay?.({ channel: throwing, onRemoteChange() {} });
  let ok = !!relay;
  try {
    relay?.announce();
  } catch {
    ok = false;
  }
  check(ok, "a failing post never throws into the outbox");
}
console.log(`outboxChangeRelay: ${passed} passed`);

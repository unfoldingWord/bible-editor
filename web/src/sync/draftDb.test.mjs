import assert from "node:assert/strict";
import { createDraftDbConnection } from "./draftDb.ts";

// #1102: a fake opener. Each open makes a fresh fake db; `failNext` makes that
// db's next op throw InvalidStateError, the way IndexedDB does once the
// browser has closed the connection.
function harness() {
  const opened = [];
  const conn = createDraftDbConnection(async (callbacks) => {
    const d = {
      id: opened.length + 1,
      callbacks,
      closed: false,
      failNext: false,
      puts: [],
      close() { this.closed = true; },
      put(value) {
        if (this.failNext || this.closed) {
          this.failNext = false;
          const err = new Error("The database connection is closing.");
          err.name = "InvalidStateError";
          return Promise.reject(err);
        }
        this.puts.push(value);
        return Promise.resolve();
      },
    };
    opened.push(d);
    return d;
  });
  return { conn, opened };
}

// Success check: an op that throws InvalidStateError once reopens and succeeds.
{
  const { conn, opened } = harness();
  await conn.run((d) => d.put("a"));
  assert.equal(opened.length, 1);
  opened[0].failNext = true;
  await conn.run((d) => d.put("b"));
  assert.equal(opened.length, 2, "reopened after InvalidStateError");
  assert.deepEqual(opened[1].puts, ["b"]);
  // Later writes keep using the new connection.
  await conn.run((d) => d.put("c"));
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[1].puts, ["b", "c"]);
}

// Retries once, not forever: a second InvalidStateError surfaces.
{
  const conn = createDraftDbConnection(async () => ({
    close() {},
    put() { const e = new Error("closing"); e.name = "InvalidStateError"; return Promise.reject(e); },
  }));
  await assert.rejects(conn.run((d) => d.put("x")), { name: "InvalidStateError" });
}

// Other errors are not retried.
{
  let opens = 0;
  const conn = createDraftDbConnection(async () => {
    opens += 1;
    return { close() {}, put() { const e = new Error("full"); e.name = "QuotaExceededError"; return Promise.reject(e); } };
  });
  await assert.rejects(conn.run((d) => d.put("x")), { name: "QuotaExceededError" });
  assert.equal(opens, 1);
}

// `terminated` (browser closed the connection) drops the cache: the next op reopens.
{
  const { conn, opened } = harness();
  await conn.run((d) => d.put("a"));
  opened[0].callbacks.terminated();
  assert.equal(conn.handle(), null);
  await conn.run((d) => d.put("b"));
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[1].puts, ["b"]);
}

// `blocking` (another tab wants a newer version, or a delete) closes and drops.
{
  const { conn, opened } = harness();
  await conn.run((d) => d.put("a"));
  opened[0].callbacks.blocking();
  assert.equal(opened[0].closed, true);
  assert.equal(conn.handle(), null);
  await conn.run((d) => d.put("b"));
  assert.equal(opened.length, 2);
}

// A late callback from an old connection must not drop the newer one.
{
  const { conn, opened } = harness();
  await conn.run((d) => d.put("a"));
  opened[0].callbacks.terminated();
  await conn.run((d) => d.put("b"));
  opened[0].callbacks.terminated();
  opened[0].callbacks.blocking();
  assert.equal(conn.handle(), opened[1]);
  assert.equal(opened[1].closed, false);
}

// #1103 guarantee: with an open handle, the op is issued synchronously (no
// await before it), so a pagehide/beforeunload flush queues its request in time.
{
  const { conn, opened } = harness();
  await conn.run((d) => d.put("a"));
  const p = conn.run((d) => d.put("sync"));
  assert.deepEqual(opened[0].puts, ["a", "sync"], "put issued before run() returned");
  await p;
}

// A failed open is not cached forever: the next op tries again.
{
  let opens = 0;
  const conn = createDraftDbConnection(async () => {
    opens += 1;
    if (opens === 1) throw new Error("open failed");
    return { close() {}, put() { return Promise.resolve("ok"); } };
  });
  await assert.rejects(conn.run((d) => d.put("x")), /open failed/);
  assert.equal(await conn.run((d) => d.put("y")), "ok");
  assert.equal(opens, 2);
}

console.log("draftDb.test.mjs: ok");

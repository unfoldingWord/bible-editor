// The drafts database connection, cached but recoverable (#1102). The browser
// can close an open IndexedDB connection on its own: site data cleared, Safari
// dropping a long-backgrounded tab, another tab deleting or upgrading the
// database. A cache that never resets then fails every later backup write
// until reload. Here the cache is dropped when the connection is terminated or
// is blocking another tab, and an op that fails with InvalidStateError (the
// error a closed connection throws) reopens and retries once.
//
// Kept free of browser and app imports so it can be unit-tested with a fake
// opener (draftDb.test.mjs).

export interface DraftDbCallbacks {
  /** The browser closed the connection abnormally. */
  terminated(): void;
  /** This connection is holding up a newer version or a delete elsewhere. */
  blocking(): void;
}

interface Closable { close(): void }

function isInvalidState(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { name?: unknown }).name === "InvalidStateError";
}

export function createDraftDbConnection<D extends Closable>(
  open: (callbacks: DraftDbCallbacks) => Promise<D>,
) {
  let dbp: Promise<D> | null = null;
  // The opened handle, kept so a flush inside pagehide/beforeunload can issue
  // its op synchronously, with no await before it (#901 review A1).
  let handle: D | null = null;

  function connect(): Promise<D> {
    if (dbp) return dbp;
    let opened: D | null = null;
    // Each callback drops only its own connection, never a newer one.
    const drop = () => {
      if (dbp === mine) { dbp = null; handle = null; }
    };
    const mine: Promise<D> = open({
      terminated: drop,
      blocking: () => {
        drop();
        try { opened?.close(); } catch { /* already closed */ }
      },
    }).then(
      (d) => {
        opened = d;
        if (dbp === mine) handle = d;
        return d;
      },
      (error) => { drop(); throw error; },
    );
    dbp = mine;
    return mine;
  }

  // Forget `d` if it is still the cached connection.
  function invalidate(d: D): void {
    if (handle !== d) return;
    dbp = null;
    handle = null;
    try { d.close(); } catch { /* already closed */ }
  }

  function attempt<T>(op: (d: D) => T | Promise<T>): { used: D | null; result: Promise<T> } {
    const d = handle;
    if (d) {
      // Synchronous on purpose: idb creates the transaction and request
      // before its first await (#1103).
      try { return { used: d, result: Promise.resolve(op(d)) }; }
      catch (error) { return { used: d, result: Promise.reject(error) }; }
    }
    let used: D | null = null;
    const result = connect().then((x) => { used = x; return op(x); });
    return { get used() { return used; }, result };
  }

  /** Run `op` on the open database, reopening once if it was closed. */
  function run<T>(op: (d: D) => T | Promise<T>): Promise<T> {
    const first = attempt(op);
    return first.result.catch((error) => {
      if (!isInvalidState(error)) throw error;
      if (first.used) invalidate(first.used);
      return attempt(op).result;
    });
  }

  return { run, handle: () => handle };
}

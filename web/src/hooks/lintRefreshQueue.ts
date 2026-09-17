// A refresh invalidates the running request: callers must wait for a request
// STARTED after their refresh, but a burst only needs one follow-up request.
export function createLintRefreshQueue(run: () => Promise<void>) {
  let running = false;
  let disposed = false;
  let pending: Array<() => void> = [];
  async function drain() {
    running = true;
    while (!disposed && pending.length) {
      const waiters = pending;
      pending = [];
      try {
        await run();
      } catch {
        // The owner reports request errors; an unsuccessful request still
        // settles its callers and must not strand later invalidations.
      } finally {
        for (const resolve of waiters) resolve();
      }
    }
    running = false;
  }
  return {
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      const completion = new Promise<void>((resolve) => pending.push(resolve));
      if (!running) void drain();
      return completion;
    },
    dispose() {
      disposed = true;
      for (const resolve of pending) resolve();
      pending = [];
    },
  };
}

// Coalesces the draft backup's IndexedDB writes (#901 step 2, option B).
//
// Every keystroke used to put a whole draft record and notify every listener.
// This keeps the first keystroke of a burst immediate (so the unsaved chip and
// the crash backup appear at once), then writes only the latest value at most
// once per `intervalMs` while typing continues. A quiet interval closes the
// window, so the next keystroke is immediate again.
//
// Callers flush before anything that must see the latest typing on disk (a
// save capturing the draft's generation, a read, a page hide); see drafts.ts.
// A crash (not a normal tab close, which flushes on pagehide) can lose at most
// the last `intervalMs` of typing.
//
// Pure and clock-injected so it runs under plain Node tests.

export interface CoalescerClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface DraftWriteCoalescer<T> {
  // Queue `value` as `key`'s latest. Writes at once when no window is open.
  write(key: string, value: T): void;
  // Write `key`'s queued value now; resolves once every write started for
  // `key` so far has settled.
  flush(key: string): Promise<void>;
  flushAll(): Promise<void>;
  // Drop `key`'s queued value and close its window (the draft was cleared).
  cancel(key: string): void;
}

interface Window<T> {
  timer: unknown;
  queued?: { value: T };
}

export function createDraftWriteCoalescer<T>(
  persist: (key: string, value: T) => Promise<void>,
  intervalMs: number,
  clock: CoalescerClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  },
): DraftWriteCoalescer<T> {
  const windows = new Map<string, Window<T>>();
  const inFlight = new Map<string, Set<Promise<void>>>();

  // `persist` is called synchronously so IndexedDB transactions are created in
  // call order: a later write never lands under an earlier one.
  const start = (key: string, value: T) => {
    let active = inFlight.get(key);
    if (!active) inFlight.set(key, active = new Set());
    const set = active;
    let started: Promise<void>;
    try {
      started = persist(key, value);
    } catch (error) {
      started = Promise.reject(error);
    }
    const p: Promise<void> = started
      .catch((error) => {
        // A failed backup write keeps the last good record; the next keystroke
        // or flush tries again. Never throw out of a timer.
        console.warn("Unable to write draft backup", error);
      })
      .finally(() => {
        set.delete(p);
        if (!set.size && inFlight.get(key) === set) inFlight.delete(key);
      });
    set.add(p);
  };

  const arm = (key: string): unknown => clock.setTimeout(() => {
    const w = windows.get(key);
    if (!w) return;
    if (!w.queued) {
      windows.delete(key);
      return;
    }
    const { value } = w.queued;
    w.queued = undefined;
    w.timer = arm(key);
    start(key, value);
  }, intervalMs);

  const flush = (key: string): Promise<void> => {
    const w = windows.get(key);
    if (w?.queued) {
      const { value } = w.queued;
      w.queued = undefined;
      start(key, value);
    }
    const active = inFlight.get(key);
    return active ? Promise.all([...active]).then(() => undefined) : Promise.resolve();
  };

  return {
    write(key, value) {
      const w = windows.get(key);
      if (w) {
        w.queued = { value };
        return;
      }
      windows.set(key, { timer: arm(key) });
      start(key, value);
    },
    flush,
    async flushAll() {
      await Promise.all([...new Set([...windows.keys(), ...inFlight.keys()])].map(flush));
    },
    cancel(key) {
      const w = windows.get(key);
      if (!w) return;
      clock.clearTimeout(w.timer);
      windows.delete(key);
    },
  };
}

// One hydration read shared by every editor. Subsequent commits refresh only
// their key; an older in-flight read must never replace a newer notification.
export function createDraftSnapshot<T extends { key: string; updatedAt: number }>(
  readAll: () => Promise<T[]>,
  readKey: (key: string) => Promise<T | undefined>,
) {
  const records = new Map<string, T>();
  const revisions = new Map<string, number>();
  const subscribers = new Set<(all: T[]) => void>();
  const keyed = new Map<string, Set<(record: T | undefined) => void>>();
  const pending = new Map<string, Promise<void>>();
  const mutations = new Map<string, Set<Promise<void>>>();
  const failures = new Map<string, unknown>();
  let hydration: Promise<void> | undefined;
  const snapshot = () => [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  const ready = () => hydration ??= readAll().then((all) => {
    for (const record of all) records.set(record.key, record);
  }).catch((error) => { hydration = undefined; throw error; });
  const settled = async (key?: string) => {
    await ready();
    // Recovery can finish after a commit has already requested a refresh.
    // Never publish recovery's absent/older record in that window: editors
    // use absence to clear their dirty flag and release their edit session.
    for (;;) {
      const waits = key === undefined
        ? [...pending.values(), ...[...mutations.values()].flatMap((set) => [...set])]
        : [...(pending.has(key) ? [pending.get(key)!] : []), ...mutations.get(key) ?? []];
      if (!waits.length) {
        if (key === undefined ? failures.size : failures.has(key)) {
          throw key === undefined ? failures.values().next().value : failures.get(key);
        }
        return;
      }
      await Promise.all(waits);
    }
  };
  return {
    beginMutation(key: string) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      let active = mutations.get(key);
      if (!active) mutations.set(key, active = new Set());
      active.add(wait);
      return () => {
        active.delete(wait);
        if (!active.size) mutations.delete(key);
        release();
      };
    },
    subscribe(fn: (all: T[]) => void) {
      subscribers.add(fn);
      void settled().then(() => { if (subscribers.has(fn)) fn(snapshot()); }).catch(() => {});
      return () => { subscribers.delete(fn); };
    },
    subscribeKey(key: string, fn: (record: T | undefined) => void) {
      let listeners = keyed.get(key);
      if (!listeners) keyed.set(key, listeners = new Set());
      listeners.add(fn);
      void settled(key).then(() => { if (listeners.has(fn)) fn(records.get(key)); }).catch(() => {});
      return () => {
        listeners.delete(fn);
        if (!listeners.size) keyed.delete(key);
      };
    },
    refresh(key: string) {
      const revision = (revisions.get(key) ?? 0) + 1;
      revisions.set(key, revision);
      let succeeded = false;
      const task = (async () => {
        await ready();
        if (revisions.get(key) !== revision) return;
        const record = await readKey(key);
        if (revisions.get(key) !== revision) return;
        if (record) records.set(key, record);
        else records.delete(key);
        failures.delete(key);
        succeeded = true;
      })().catch((error) => {
        if (revisions.get(key) === revision) failures.set(key, error);
        throw error;
      }).finally(() => {
        if (pending.get(key) !== task) return;
        pending.delete(key);
        if (!succeeded) return;
        void settled(key).then(() => {
          if (revisions.get(key) !== revision) return;
          for (const fn of keyed.get(key) ?? []) fn(records.get(key));
        }).catch(() => {});
        void settled().then(() => {
          if (revisions.get(key) !== revision || !subscribers.size) return;
          const all = snapshot();
          for (const fn of subscribers) fn(all);
        }).catch(() => {});
      });
      pending.set(key, task);
      return task;
    },
  };
}

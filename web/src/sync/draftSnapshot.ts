// A keystroke replaces a draft's record (new payload/updatedAt/generation)
// without ever adding or removing a key. A whole-list subscriber that shows
// only *which* drafts exist and their `meta` — never their live content,
// including the generation a save is in flight for — gains nothing from
// re-rendering on every one of those replacements. Wrap `subscribe` with this
// to skip callbacks whose (key, meta) pairs are unchanged from the last one
// delivered.
//
// `meta` counts, not just the key: a row draft's key (drafts.ts's rowKey) has
// no chapter/verse, but its meta does, and moving the row to another verse
// with an unsaved draft open rewrites meta under the SAME key. Comparing keys
// alone froze SyncStatusBar's jump menu at the old verse (#901 review A1).
//
// SyncStatusBar's count/jump-menu is exactly that: key + meta text.
// UnsavedToasts is NOT a fit despite the similar "which drafts" framing
// — it also matches a draft's CURRENT `generation` against in-flight outbox
// ops (verseDraftHasActiveSave) to decide whether a save is already covering
// this draft, and a generation changes on every keystroke. Deduping by key
// alone would freeze it at whichever generation was current when the key set
// last changed, so a later keystroke's generation could go uncompared against
// its own save (toast wrongly hidden) or a stale generation could fail to
// match the save it actually triggered (toast wrongly stuck showing
// "unsaved"). See #901's review (2026-10-02) for both failure modes.
export function dedupeByKeys<T extends { key: string; meta?: unknown }>(
  subscribe: (fn: (all: T[]) => void) => () => void,
): (fn: (all: T[]) => void) => () => void {
  return (fn) => {
    let lastSignature: string | undefined;
    return subscribe((all) => {
      const signature = all
        .map((r) => `${r.key}\u0001${JSON.stringify(r.meta)}`)
        .sort()
        .join("\u0000");
      if (signature === lastSignature) return;
      lastSignature = signature;
      fn(all);
    });
  };
}

// One hydration read shared by every editor. Subsequent commits refresh only
// their key; an older in-flight read must never replace a newer notification.
export function createDraftSnapshot<T extends { key: string; updatedAt: number }>(
  readAll: () => Promise<T[]>,
  readKey: (key: string) => Promise<T | undefined>,
) {
  const records = new Map<string, T>();
  const revisions = new Map<string, number>();
  const subscribers = new Set<(all: T[]) => void>();
  // Keyed listeners get `remote = true` when the refresh that wins delivery
  // (the latest revision) came from another tab (#806). A mounted editor with
  // no local typing ignores those, so it never latches another tab's
  // half-typed text. No marker outlives its refresh, so a failed or
  // superseded refresh cannot mislabel a later one; a superseded local
  // refresh reaching a clean cell as remote is harmless (it typed nothing).
  // The mount callback is always `remote = false`.
  const keyed = new Map<string, Set<(record: T | undefined, remote: boolean) => void>>();
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
        // A recorded failure only withholds the *keyed* view for its own key
        // (absence there is misread as "clear dirty, release the edit
        // session"). The whole-list view is a snapshot of what we do know;
        // inheriting one key's failure would freeze every other key's
        // notifications until that exact key is retried.
        if (key !== undefined && failures.has(key)) throw failures.get(key);
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
    subscribeKey(key: string, fn: (record: T | undefined, remote: boolean) => void) {
      let listeners = keyed.get(key);
      if (!listeners) keyed.set(key, listeners = new Set());
      listeners.add(fn);
      void settled(key).then(() => { if (listeners.has(fn)) fn(records.get(key), false); }).catch(() => {});
      return () => {
        listeners.delete(fn);
        if (!listeners.size) keyed.delete(key);
      };
    },
    refresh(key: string, origin: "local" | "remote" = "local") {
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
          const remote = origin === "remote";
          for (const fn of keyed.get(key) ?? []) fn(records.get(key), remote);
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

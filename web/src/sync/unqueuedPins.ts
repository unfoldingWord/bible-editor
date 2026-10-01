// Issue #1050: the verse-base pin of a save that queued nothing.
//
// saveVerseDraft pins the verse base before it knows whether the save will go
// out. Normally the queued op's outbox exit releases that pin. A save can also
// end with nothing queued: refused because a book lock landed (#1046), or its
// "Words will be unaligned" confirm cancelled. The dual aligner's reading line
// then still shows the edit, made against the pinned base, so the pin must
// stay: saving that edit after the verse moved has to 409, not diff the old
// text against the new verse and overwrite the change. But no outbox exit will
// ever release it, so it is recorded here and released when the editor stops
// showing the edit.
//
// The release is synchronous (unpinVerseBaseIfIdle, whose pendingKeys check
// keeps a live keystroke-draft session's pin, #474). An async release left a
// gap in which a new save reused the old pin and 409'd, and a late unpin could
// pull the pin out from under a save queued meanwhile.
//
// Kept free of drafts.ts (side-effecting at import) so a plain Node test can
// import it; the caller injects the unpin.

export interface UnqueuedPinTracker {
  // A save of `key` begins: whatever an earlier attempt recorded is decided
  // again by this one.
  started(key: string): void;
  // The save was queued: its outbox exit owns the pin from here.
  queued(key: string): void;
  // The save queued nothing. `stillEditing` reports whether the editor still
  // shows the edit; when it no longer does (the line was undone while the save
  // was in flight) the pin is released now, since nothing else would. Without
  // a probe the key is recorded.
  abandoned(key: string, stillEditing?: () => boolean): void;
  // The editor no longer shows an unsaved edit of `key` (it went clean by any
  // path, or unmounted). Releases the pin only for a recorded key.
  dropped(key: string): void;
  holds(key: string): boolean;
}

export function createUnqueuedPinTracker(unpinIfIdle: (key: string) => void): UnqueuedPinTracker {
  const held = new Set<string>();
  return {
    started(key) {
      held.delete(key);
    },
    queued(key) {
      held.delete(key);
    },
    abandoned(key, stillEditing) {
      if (stillEditing && !stillEditing()) {
        held.delete(key);
        unpinIfIdle(key);
        return;
      }
      held.add(key);
    },
    dropped(key) {
      if (held.delete(key)) unpinIfIdle(key);
    },
    holds(key) {
      return held.has(key);
    },
  };
}

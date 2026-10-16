// Verse ops queued by THIS tab (#1060). The outbox is shared IndexedDB with a
// cross-tab-exclusive drain, so the tab that sees an op land is often not the
// tab that queued it, and an op is the same record either way. A reading
// line's hold (versePin.ts) moves its pin forward only for this tab's own
// landed saves: those are edits the translator made here, on top of what the
// line shows. Any other change (another tab, another editor, a reimport) must
// keep the old base so the line's save 409s.
//
// Per-tab memory, like the pin map: a reload forgets it, and the holds with it.
// Kept free of outbox.ts (side-effecting at import) so a Node test can import it.

const ownOps = new Set<string>();

export function noteOwnVerseOp(id: string): void {
  ownOps.add(id);
}

// Whether this tab queued op `id`; forgets it, since each op exits once.
export function takeOwnVerseOp(id: string | undefined): boolean {
  if (id === undefined) return false;
  return ownOps.delete(id);
}

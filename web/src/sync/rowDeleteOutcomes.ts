// This tab's feed of row-DELETE outcomes from every tab (#1119): the outbox's
// local result / discard announcements, relayed to the other tabs over a
// BroadcastChannel and merged with theirs. The logic lives in
// pendingRowDeletes.ts (createRowDeleteOutcomes) so it is unit-tested; this
// module only wires it to the outbox. Loaded at import, like the outbox's own
// listeners, so a tab relays what it drains even before anything subscribes.

import { onOutboxDiscard, onOutboxResult } from "./outbox";
import { clearOwnRowDelete, createRowDeleteOutcomes, isOwnRowDelete } from "./pendingRowDeletes";

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("be-row-delete-outcomes") : null;

export const rowDeleteOutcomes = createRowDeleteOutcomes({
  onResult: onOutboxResult,
  onDiscard: onOutboxDiscard,
  channel,
  isOwn: isOwnRowDelete,
  clearOwn: clearOwnRowDelete,
});

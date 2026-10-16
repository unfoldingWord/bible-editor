// This tab's relay of refused note moves across tabs (#1174). The logic lives
// in refusedTnMoves.ts so it is unit-tested; this module only wires it to the
// outbox. Loaded at import, like rowDeleteOutcomes.ts, so a tab relays the
// refusals it drains even before anything subscribes.

import { onOutboxResult } from "./outbox";
import { createRefusedTnMoveRelay } from "./refusedTnMoves";

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("be-tn-move-refusals") : null;

export const tnMoveRelay = createRefusedTnMoveRelay({ onResult: onOutboxResult, channel });

// Dev only: a hot reload would otherwise leave the old instance relaying.
import.meta.hot?.dispose(() => {
  tnMoveRelay.close();
  channel?.close();
});

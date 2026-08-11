// Pure decision: when the nightly Door43->D1 sync finds D1 and master disagree
// on a verse's content_json, which side wins, and can we tell?
//
// Incident (2026-08-11, 1CH, commit 5905373879 on unfoldingWord/en_ult master):
// the pre-existing sync skipped any verse a human had ever edited in the app,
// so an out-of-band correction made directly on Door43 master never reached
// D1 — and the next nightly export then rendered D1 over master, silently
// reverting the human's Door43 work. 192 verses of 1CH were reverted this way.
//
// The fix is to recover the ancestor: the content_json we ourselves last
// published to master. It is NOT kept alongside the verse row — it is
// recovered from edit_log, as the newest kind='verse' payload for this verse
// dated before book_resource_syncs.master_confirmed_at for this (book,
// resource) — the watermark the export stamps only when it has POSITIVELY
// measured that our rendered output matches what master holds, NOT merely
// when we last pushed to a `-be-` branch (an unmerged branch push is routine
// here and is not proof master moved) (see bookReimport.ts's applyVerseRows).
// edit_log has a 180-day
// retention sweep (index.ts), so once a verse's pre-export history ages out
// the ancestor becomes unrecoverable — keep_no_base must stay a first-class,
// expected outcome, not a bug. With the ancestor in hand, a difference can be
// ATTRIBUTED to whichever side actually moved, instead of guessing from D1
// and master alone:
//   - if master still equals the ancestor, master never moved — the
//     difference is ours, and keeping D1 is simply correct (this was already
//     the behavior before this module existed).
//   - if D1 still equals the ancestor, we never moved — master's edit is safe
//     to adopt.
//   - if BOTH moved since the ancestor, master wins (it is the side a human
//     just touched by hand on Door43), but a human must review the collision.
// When no ancestor is recoverable at all, attribution is impossible and we
// must keep D1 — the pre-existing, safe default.
//
// Refusing to adopt when doing so would cost alignment is comparatively cheap
// here: the fallback on refusal is "flag this one verse for a human to look
// at," never "freeze an entire book," unlike the export-time shrink guard at
// export.ts:640 (usfmAlignmentShrinkRefused), which has held JER ULT out of
// every nightly export since 2026-07-31 over a single word. A per-verse
// refusal here costs one verse; it does not block anything else in the book.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shrinkGuard.ts and reimportSyncGate.ts for the same pattern.
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";

export type VerseMergeAction =
  | "keep_converged" // ours and theirs already identical
  | "keep_no_base" // no ancestor recoverable — cannot attribute, keep D1
  | "keep_master_unchanged" // master === base: their side never moved
  | "keep_alignment_refused" // adopting would lose alignment — keep D1, needs a human
  | "adopt" // master moved, we did not
  | "adopt_conflict"; // both moved — master wins, but a human must review

export interface VerseMergeInput {
  /** content_json we last published to master, or null when unrecoverable. */
  base: string | null;
  /** D1's current content_json. */
  ours: string;
  /** Master's current content_json, ALREADY normalized by extractVersesForRange. */
  theirs: string;
  /** True when a human edit_log row exists after our last export commit. */
  humanEditedSinceExport: boolean;
}

export interface VerseMergeResult {
  action: VerseMergeAction;
  /** action is "adopt" | "adopt_conflict" */
  adopt: boolean;
  /** needs a human: "adopt_conflict" | "keep_alignment_refused" */
  conflict: boolean;
  /** short stable machine reason, safe to persist and to log */
  reason: string;
  /** present only when the alignment comparison actually ran */
  alignment?: { beforeAligned: number; afterAligned: number; lostWords: string[] };
}

// Recursively sorts object keys so two content_json strings that differ only
// by writer-dependent key order compare equal. Arrays keep their order —
// order is semantic in verseObjects. Returns null when the input does not
// parse; callers must treat null as never equal to anything, including
// another null (two unparseable inputs are not "the same unparseable thing").
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function stableKey(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return JSON.stringify(sortKeysDeep(parsed));
}

// Two stableKey results are "equal" only when both are non-null and match.
// A null on either side (unparseable JSON) is never equal to anything.
function keysEqual(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

export function computeVerseMerge(input: VerseMergeInput): VerseMergeResult {
  const { base, ours, theirs, humanEditedSinceExport } = input;

  const oursKey = stableKey(ours);
  const theirsKey = stableKey(theirs);

  // 1. ours and theirs already identical.
  if (keysEqual(oursKey, theirsKey)) {
    return { action: "keep_converged", adopt: false, conflict: false, reason: "converged" };
  }

  // 2. No ancestor recoverable — cannot attribute, keep D1.
  if (base === null) {
    return { action: "keep_no_base", adopt: false, conflict: false, reason: "no_base" };
  }

  const baseKey = stableKey(base);

  // 3. Master never moved since the ancestor — the difference is ours.
  if (keysEqual(baseKey, theirsKey)) {
    return { action: "keep_master_unchanged", adopt: false, conflict: false, reason: "master_unchanged" };
  }

  // 4. Alignment guard: refuse to adopt master's content if doing so would
  // lose alignment on words neither side meant to touch. Either side failing
  // to parse makes the comparison itself untrustworthy — fail closed.
  if (oursKey === null || theirsKey === null) {
    return { action: "keep_alignment_refused", adopt: false, conflict: true, reason: "unparseable" };
  }
  const delta = analyzeAlignmentDelta(JSON.parse(ours), JSON.parse(theirs));
  const lostWords = delta.unexpectedLosses.filter((loss) => loss.reason === "lost").map((loss) => loss.text);
  if (delta.afterAligned < delta.beforeAligned || lostWords.length > 0) {
    return {
      action: "keep_alignment_refused",
      adopt: false,
      conflict: true,
      reason: "alignment_shrink",
      alignment: {
        beforeAligned: delta.beforeAligned,
        afterAligned: delta.afterAligned,
        lostWords: lostWords.slice(0, 10),
      },
    };
  }

  // 5. Byte equality with the base is the strong proof our side did not move.
  // humanEditedSinceExport is an independent belt closing a seconds-wide race
  // between the export's D1 read and its commit: bytes can match the base
  // while a human edit_log row still landed in that window.
  if (keysEqual(oursKey, baseKey) && !humanEditedSinceExport) {
    return { action: "adopt", adopt: true, conflict: false, reason: "master_only" };
  }

  // 6. Both sides moved since the ancestor — master wins, a human must review.
  return { action: "adopt_conflict", adopt: true, conflict: true, reason: "both_changed" };
}

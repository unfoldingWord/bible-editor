// Pure decision logic behind Shell.tsx's onUpsert handler for the
// ChapterRoom WS `row.upserted` broadcast. WS is a hint only — HTTP +
// If-Match stays the source of truth (see CLAUDE.md's Save protocol) — so
// this never invents a write; it only decides whether an already-server-
// computed row should replace what's cached locally in this tab.
//
// Two server-side write paths intentionally patch a row WITHOUT bumping
// `version` (api/src/rows.ts): the preserve/hint/trashed_at bit-toggles on
// tn rows, and the reorder-only fast path that patches `sort_order` alone
// (a drag must not read as a new "version" in the history dialog, since
// sort_order is positional metadata, not content — see the comment above
// that fast path). A plain "apply on absent, or on version > existing"
// guard drops both kinds of same-version broadcast, so this widens the
// same-version carve-out to also catch a sort_order difference — issue
// #671: a drag-reorder in tab A never reordered tab B until an unrelated
// refetch. tn/twl are the only kinds a drag can currently reorder (tq's
// PATCH schema has no sort_order field at all — see TqPatch in
// api/src/rows.ts), but the comparison is written generically over
// `row.sort_order` rather than kind-gated: TqRow carries the field too
// (migration 0025), so this stays correct without a follow-up edit if tq
// reordering is ever wired up.
import type { RowKind, TnRow, TqRow, TwlRow } from "../sync/api";

export type UpsertableRow = TnRow | TqRow | TwlRow;

/**
 * True when an incoming `row.upserted` broadcast should replace the row
 * this tab has cached (`existing`, undefined when the row isn't cached at
 * all yet).
 */
export function shouldApplyUpsert(
  kind: RowKind,
  incoming: UpsertableRow,
  existing: UpsertableRow | undefined,
): boolean {
  if (!existing) return true;
  if (incoming.version > existing.version) return true;
  if (incoming.version !== existing.version) return false;

  // Same version: only apply if a known non-versioning field actually
  // changed. Anything else at this point is either the originating tab's
  // own echo (already applied via the PATCH response) or a stale/duplicate
  // broadcast — never assume it's newer just because it arrived.
  if (incoming.sort_order !== existing.sort_order) return true;

  if (kind === "tn") {
    const a = incoming as TnRow;
    const b = existing as TnRow;
    return a.preserve !== b.preserve || a.hint !== b.hint || a.trashed_at !== b.trashed_at;
  }

  return false;
}

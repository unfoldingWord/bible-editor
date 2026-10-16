// #1115: what a translation question (QuestionsTable) or word link
// (WordsTable) diffs its local typing against, so a save the server refuses
// (409 chapter_locked) or the user discards from the sync drawer stays on
// screen as unsaved, with Save (retry) and Undo (discard), the way NoteCard
// already behaves.
//
// The trap: Shell's enqueueRow applies the patch to the cached row at an
// UNCHANGED version before the PATCH is answered. A row that diffed against
// the cached row therefore read as saved the moment Save was clicked, and a
// refusal (which drops the op; no 200 ever follows) left the refused text
// looking saved until the next reload. The baseline here is the last
// server-confirmed values, and it moves only when the row's version does
// (a 200, a restore, a WS upsert, an AI apply).
//
// Pure (no React, no IndexedDB) so the rules are unit-tested in
// rowEditBaseline.test.mjs.

export interface RowBaseline<F> {
  fields: F;
  version: number;
}

// Keep `prev` while the row is at the same version; rebase onto the row's
// fields once the version moves (or on the first call, `prev` null).
export function rebaseRowBaseline<F>(prev: RowBaseline<F> | null, rowFields: F, rowVersion: number): RowBaseline<F> {
  if (prev && prev.version === rowVersion) return prev;
  return { fields: rowFields, version: rowVersion };
}

// On mount, a remounted row (verse switched and back, no refetch) finds the
// cached row still holding refused text at the same version. The draft the
// row wrote carries the baseline it was diffed against; trust it only when it
// was written at the row's current version. A draft from an older version
// means the row has moved since, and the row is then the baseline.
export function baselineFromDraft<F>(
  payload: unknown,
  draftVersion: number | undefined,
  rowVersion: number,
): RowBaseline<F> | null {
  if (draftVersion === undefined || draftVersion !== rowVersion) return null;
  const baseline = (payload as { baseline?: unknown } | undefined)?.baseline;
  if (!baseline || typeof baseline !== "object") return null;
  return { fields: baseline as F, version: rowVersion };
}

// The fields of `local` that differ from `base` (strict equality).
export function rowFieldDiff<F extends object>(local: F, base: F): Partial<F> {
  const out: Partial<F> = {};
  for (const k of Object.keys(local) as (keyof F)[]) {
    if (local[k] !== base[k]) out[k] = local[k];
  }
  return out;
}

// The row's local fields after the cached row changed, field by field: a field
// holding unsaved typing (it differs from `prevBase`, the baseline it was
// diffed against before this change) keeps it; every other field takes the
// row's value. So kept typing survives a new version (an AI run's apply after
// a chapter_locked refusal, another tab's save, the row's own reorder landing)
// and a same-version refetch, while a clean field still follows the server and
// a find/replace applied to the cache. The caller rebases the baseline onto
// the new row, so a kept field still reads as unsaved, as NoteCard does. The
// server stores these fields as sent, so our own save landing leaves the
// row clean (local equals the new row).
export function resyncLocalFields<F extends object>(local: F, prevBase: F, row: F): F {
  const out = { ...local };
  for (const k of Object.keys(local) as (keyof F)[]) {
    if (local[k] === prevBase[k]) out[k] = row[k];
  }
  return out;
}

// The ids of rows of `rowKind` with an edit-field save still in the outbox
// (pending, in flight, in conflict or failed). Reorders and moves are not
// edits (see isKeptRowEditOp).
export function queuedKeptEditIds(
  ops: readonly { target: { kind: string; rowKind?: string; id?: string }; action: string; patch?: Record<string, unknown> }[],
  rowKind: "tq" | "twl",
): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.target.rowKind === rowKind && op.target.id && isKeptRowEditOp(op)) ids.add(op.target.id);
  }
  return [...ids].sort();
}

// Save and Undo stay off while a save of the row is queued, so an Undo cannot
// be overtaken by the save landing and a double click cannot send two PATCHes.
// Also from the click until the outbox's next snapshot, which already holds
// the new op (`seq` counts snapshots). Unlike NoteCard's savePendingVersion,
// it reopens on a refusal or discard: those remove the op from the outbox.
export function saveGateClosed(args: { queued: boolean; clickedAtSeq: number | null; seq: number }): boolean {
  return args.queued || (args.clickedAtSeq !== null && args.clickedAtSeq === args.seq);
}

// Whether a refused row op is a question/word-link edit that the row keeps on
// screen as unsaved (so the refusal toast must not say "dropped"). A reorder
// or a word-link verse move only carries position fields; those are not kept.
const KEPT_FIELDS: Record<string, readonly string[]> = {
  tq: ["ref_raw", "question", "response"],
  twl: ["orig_words", "tw_link", "occurrence"],
};
export function isKeptRowEditOp(op: {
  target: { kind: string; rowKind?: string };
  action: string;
  patch?: Record<string, unknown>;
}): boolean {
  const patch = op.patch;
  if (op.target.kind !== "row" || op.action !== "patch" || !patch) return false;
  const fields = KEPT_FIELDS[op.target.rowKind ?? ""];
  return !!fields && fields.some((f) => f in patch);
}

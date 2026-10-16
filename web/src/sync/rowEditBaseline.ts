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

// Whether a change in the cached row should overwrite the row's local fields.
// A new version always does (unchanged from before #1115). A same-version
// change (a find/replace applied optimistically, a refetch carrying the
// server's text back over the refused text) only reaches a row with no
// unsaved typing, so it can never wipe kept work.
export function shouldSyncFromRow(args: { versionMoved: boolean; dirty: boolean }): boolean {
  return args.versionMoved || !args.dirty;
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

// #1115: an edit to a translation question (tq) or word link (twl) that the
// server refuses (409 chapter_locked, or a discard in the sync drawer) stays on
// screen marked unsaved, like a translation note. The row component compares
// its fields against a PIN: the server-confirmed values and the version they
// were typed against, never against the cached row (the cache holds the
// optimistic text of every save until it lands or is rolled back).
//
// A save always sends the pin's version as If-Match and the pin's values as
// the op's conflict baseline. When the server has moved on under kept typing,
// the save 409s into the outbox's existing conflict path
// (classifyRowPatchConflict: another field changed -> merge; the same field
// changed -> the conflict prompt). Nothing here threads versions itself.
//
// Pure (no React, no IndexedDB) so the rules are unit-tested in
// rowEditPin.test.mjs.

export type RowFields = Record<string, string | number | null>;

export interface RowPin<F extends RowFields> {
  version: number;
  // Display values (what the inputs compare against).
  shown: F;
  // The row's raw values for the same keys (sent as the conflict baseline).
  raw: Record<string, unknown>;
}

// What this row's last Save sent: the pin version it was typed against, the
// cached row's version at the click (the optimistic apply lands at that
// version, which can be newer than the pin), and the display values of the
// fields it carried.
export interface RowSubmission {
  version: number;
  rowVersion: number;
  // Set when the save left the outbox without landing (refused or discarded):
  // no longer in flight even if the cache still shows its text.
  settled?: boolean;
  shown: RowFields;
}

export function sameFields(a: RowFields, b: RowFields, keys: readonly string[]): boolean {
  return keys.every((k) => a[k] === b[k]);
}

// The cached row's version moved away from the pin. Decide whether the pin may
// follow it, and which local fields follow too.
//
// Each field must be safe to move onto the new row:
//   - local equals the pin (untouched): it follows the server's value;
//   - local equals the new row: the server already has what is on screen;
//   - local is kept typing: safe only if the server did not change that field
//     (new row equals the pin) or holds exactly what this row last submitted
//     (our own save landed while more typing followed).
// If every field is safe, re-pin to the row. Otherwise keep the old pin and
// the local text unchanged: the next Save goes out against the old version
// and lands in the conflict path instead of silently overwriting the server.
export function rebaseRowPin<F extends RowFields>(args: {
  pin: RowPin<F>;
  row: RowPin<F>;
  local: F;
  submitted: RowSubmission | null;
  keys: readonly (keyof F & string)[];
}): { pin: RowPin<F>; local: F } | null {
  const { pin, row, local, submitted, keys } = args;
  if (row.version === pin.version) return null;
  // The cache at the click's version holds our own optimistic text (or, after
  // a refusal, the server's values put back), not a server confirmation of
  // it: "the row equals what is on screen" would be our echo. Wait for the
  // next version.
  if (submitted && row.version === submitted.rowVersion) return null;
  const sent = submitted && submitted.version === pin.version ? submitted.shown : null;
  const next = { ...local };
  for (const k of keys) {
    if (local[k] === pin.shown[k]) {
      next[k] = row.shown[k];
      continue;
    }
    if (local[k] === row.shown[k]) continue;
    if (row.shown[k] === pin.shown[k]) continue;
    if (sent && k in sent && sent[k] === row.shown[k]) continue;
    return null;
  }
  return { pin: row, local: next };
}

// The fields that differ from the pin, as a patch of display values.
export function rowPinDiff<F extends RowFields>(
  pin: RowPin<F>,
  local: F,
  keys: readonly (keyof F & string)[],
): Partial<F> {
  const out: Partial<F> = {};
  for (const k of keys) if (local[k] !== pin.shown[k]) out[k] = local[k];
  return out;
}

// The conflict baseline for a patch: the pin's raw values of its fields.
export function rowPinBaseline<F extends RowFields>(
  pin: RowPin<F>,
  patch: Partial<F>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = pin.raw[k];
  return out;
}

// True while this row's Save is on its way: the cache shows exactly the
// submitted text at the click's version (the optimistic apply). A 200 moves the
// version (the pin follows); a refusal or discard puts the server's values back
// in the cache (Shell's rollback), which reopens Save and Undo. Derived from
// the cache rather than outbox events, so an unrelated outbox update can never
// reopen it early.
export function rowSaveInFlight<F extends RowFields>(args: {
  pin: RowPin<F>;
  row: RowPin<F>;
  local: F;
  submitted: RowSubmission | null;
  keys: readonly (keyof F & string)[];
}): boolean {
  const { pin, row, local, submitted, keys } = args;
  if (!submitted || submitted.settled || submitted.version !== pin.version) return false;
  if (row.version !== submitted.rowVersion) return false;
  if (sameFields(local, pin.shown, keys)) return false;
  // Only the submitted fields: a history restore leaves a dirty ref unsent.
  for (const k of Object.keys(submitted.shown)) {
    if (submitted.shown[k] !== local[k as keyof F]) return false;
    if (row.shown[k as keyof F] !== local[k as keyof F]) return false;
  }
  return true;
}

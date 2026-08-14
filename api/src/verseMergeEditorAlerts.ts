// Pure logic behind the editor-alert fan-out in verseMergeConflicts.ts (see
// that file's header comment for the full "why"). Split into its own module
// — with zero imports — so it is unit-testable without pulling in Hono/auth,
// the same separation reimportSyncGate.ts and alignmentDelta.ts use for their
// pure decisions.
//
// 2026-08-14 prod audit fix (DEFECT 1 — wrong audience): the merge-conflict
// banner alert only ever reached the admin (verseMergeConflicts.ts's
// ALERT_USERNAME) — all 19 live conflict alerts landed there and NONE
// reached the editors whose work was actually overwritten (bethoakes,
// pjoakes, Carolyn1970, Grant_Ailie…). An 'adopt_conflict' row means Door43's
// version replaced a human edit; this attributes the overwrite to the human
// who made that edit — the edit_log row that produced `overwritten_version`
// — so verseMergeConflicts.ts can give them their own alert, in addition to
// (not instead of) the admin's.

export interface OverwrittenVerseRef {
  chapter: number;
  verse: number;
  overwrittenVersion: number;
}

// edit_log has no (book, chapter, verse, resource) columns of its own — only
// `row_key`, a single opaque string `book/chapter/verse/BIBLEVERSION` — so a
// plain multi-column WHERE can't express "this exact verse at this exact
// version" without a chapter x verse x version cross product. The
// concatenated-string match this key feeds (see verseMergeConflicts.ts's
// lookupEditorUsernames) is SQLite's standard workaround for a tuple IN() it
// doesn't support; verseMergeConflicts.test.mjs includes a
// same-verse-different-version collision case that a cross product would
// get wrong.
export function editLogKey(book: string, resource: string, ref: OverwrittenVerseRef): string {
  return `${book}/${ref.chapter}/${ref.verse}/${resource.toUpperCase()}:${ref.overwrittenVersion}`;
}

// Given the verses that were overwritten this run and the (key -> username)
// lookup already fetched from D1, produce one message per affected editor. A
// verse whose edit_log row has no user_id (an AI-pipeline edit with no human
// author) or whose ancestor aged out of edit_log's 180-day sweep has no entry
// in `usernameByKey` and is silently excluded — there is no human to notify,
// and the admin alert already covers the audit trail for it.
export function groupOverwrittenVersesByEditor(
  book: string,
  resource: string,
  overwritten: OverwrittenVerseRef[],
  usernameByKey: Map<string, string>,
): Map<string, { refs: string[]; message: string }> {
  const byUser = new Map<string, string[]>();
  for (const ref of overwritten) {
    const username = usernameByKey.get(editLogKey(book, resource, ref));
    if (!username) continue;
    const list = byUser.get(username) ?? [];
    list.push(`${ref.chapter}:${ref.verse}@v${ref.overwrittenVersion}`);
    byUser.set(username, list);
  }
  const out = new Map<string, { refs: string[]; message: string }>();
  for (const [username, refs] of byUser) {
    const message =
      `Door43's nightly sync overwrote your edit${refs.length === 1 ? "" : "s"} in ${book} ` +
      `${resource.toUpperCase()} at ${refs.length} verse(s) with Door43's version: ${refs.join(", ")}. Your ` +
      `replaced text is still recoverable from each verse's version history, at the version number given ` +
      `after @v.`;
    out.set(username, { refs, message });
  }
  return out;
}

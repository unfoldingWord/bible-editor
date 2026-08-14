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

// D1 caps prepared statements at 100 bind variables (see align.ts's
// STRONG_CHUNK for the same limit hit by a different query). This query binds
// `book` plus one key per overwritten verse, so callers MUST chunk `refs` to
// at most this many before calling buildEditorLookupQuery — a "1CH-scale"
// event (174 verses in one run, per this codebase's own history) would
// otherwise silently exceed the limit and throw.
export const EDITOR_LOOKUP_CHUNK = 90;

// The exact SQL text for the editor-attribution JOIN, exported (not just used
// inline in verseMergeConflicts.ts) so verseMergeConflicts.test.mjs can run
// this literal query against real SQLite instead of hand-duplicating it — a
// duplicated copy could silently drift from the production query while still
// passing its own tests. Caller (verseMergeConflicts.ts's lookupEditorUsernames)
// is responsible for chunking `refs` to at most EDITOR_LOOKUP_CHUNK first.
export function buildEditorLookupQuery(
  book: string,
  resource: string,
  refs: OverwrittenVerseRef[],
): { sql: string; keys: string[] } {
  const keys = refs.map((r) => editLogKey(book, resource, r));
  const sql = `SELECT (el.row_key || ':' || el.new_version) AS key, u.dcs_username AS username
     FROM edit_log el
     JOIN users u ON u.id = el.user_id
    WHERE el.kind = 'verse' AND el.book = ?1
      AND (el.row_key || ':' || el.new_version) IN (${keys.map((_, i) => `?${i + 2}`).join(",")})`;
  return { sql, keys };
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

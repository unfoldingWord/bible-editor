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
    // "Door43's sync", not "Door43's nightly sync": this fan-out fires from
    // raiseVerseMergeConflictAlert, which runs on both the 05:30 UTC cron AND
    // the user-triggered POST /:book/reimport route — the admin message in
    // verseMergeConflicts.ts already made this exact correction (its own
    // "FIX I"), and this message must not reintroduce the same overclaim.
    const message =
      `Door43's sync overwrote your edit${refs.length === 1 ? "" : "s"} in ${book} ` +
      `${resource.toUpperCase()} at ${refs.length} verse(s) with Door43's version: ${refs.join(", ")}. Your ` +
      `replaced text is still recoverable from each verse's version history, at the version number given ` +
      `after @v.`;
    out.set(username, { refs, message });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dismissal stickiness (2026-08-14 six-angle review fix). raiseVerseMergeConflictAlert
// re-derives its `desired` state (the admin message plus each affected
// editor's message) FRESH from verse_merge_conflicts on every call — and it
// is called on EVERY reimport run for a (book, resource), not just when
// something changed tonight. Without this, a user who dismisses the alert
// sees it reappear the very next run, because the old code unconditionally
// deleted-then-reinserted every message regardless of whether an identical,
// already-dismissed copy already existed.
//
// Pure so it's unit-testable without D1: given the CURRENT system_alerts
// state for this exact `source` (one row per username, if any) and the
// FRESH content this run computed, decide what actually needs to change.
//   - A username with a DISMISSED row whose message is BYTE-IDENTICAL to the
//     fresh content: leave it alone entirely (sticky — the user has seen and
//     dismissed exactly this information; don't resurrect it).
//   - A username with an UNDISMISSED row whose message is already identical:
//     also leave it alone (avoids pointless churn / a fresh `created_at`
//     with no new information).
//   - Otherwise (no existing row, or existing content differs): delete any
//     existing UNDISMISSED row for that username (a dismissed one is never
//     touched — deleting it would silently un-dismiss it) and insert the
//     fresh message.
//   - A username that HAD a row for this source but is no longer in
//     `desired` at all (their conflicts all resolved or converged) has their
//     stale UNDISMISSED row cleared (a dismissed one is left as historical
//     record — nothing to insert in its place).
export interface ExistingAlertState {
  message: string;
  dismissedAt: number | null;
}

// The per-outcome guidance sentences in the ADMIN banner (raiseVerseMergeConflictAlert).
// Pure so verseMergeConflicts.test.mjs can prove the classification without a
// D1/Env harness — the same split every other helper in this file uses.
//
// Classified by ACTION, never by `overwritten_version`: the pointer is a
// nullable recovery aid, the action is the fact. Deriving "did we take Door43's
// version?" from a nullable column is exactly what once let a refusal row that
// acquired a pointer report itself as an overwrite (see this table's history);
// keyed on action, that cannot recur, and a THIRD kept-D1 action
// ('source_attr_divergent') can be added without the two-action `!==` shortcut
// silently miscounting it as an overwrite.
//   - 'adopt_conflict'         -> Door43's version was taken OVER the editor's.
//   - 'keep_alignment_refused' -> kept D1; adopting would have cost alignment.
//   - 'source_attr_divergent'  -> kept D1; master's original-language source fix
//                                 couldn't be placed (repeated source word).
// Both kept-D1 outcomes carry the same warning: nothing was taken, so tonight's
// export will still write D1 back over master until a human resolves it.
export function buildMergeConflictGuidance(
  rows: Array<{ action: string }>,
  opts: { recordingFailed?: boolean; noBaseCount?: number } = {},
): string {
  const overwritten = rows.filter((r) => r.action === "adopt_conflict").length;
  const keptAlignment = rows.filter((r) => r.action === "keep_alignment_refused").length;
  const keptSourceAttr = rows.filter((r) => r.action === "source_attr_divergent").length;
  return [
    overwritten > 0
      ? `${overwritten} took Door43's version over the editor's — the replaced text is still in that verse's ` +
        `version history, at the version number given after @v in its ref above.`
      : "",
    keptAlignment > 0
      ? `${keptAlignment} kept the editor's version because adopting Door43's would have cost alignment — Door43's ` +
        `change has NOT been taken, so tonight's export will still write over it until someone resolves it.`
      : "",
    keptSourceAttr > 0
      ? `${keptSourceAttr} kept D1 because Door43's original-language source fix (the spelling/pointing/morphology ` +
        `on \\zaln-s) could not be placed unambiguously — the same source word repeats in the verse — so Door43's ` +
        `change has NOT been taken, and tonight's export will write over it until someone resolves it by hand.`
      : "",
    opts.recordingFailed
      ? "NOTE: at least one merge-conflict recording failed to write to verse_merge_conflicts this run " +
        "(see worker logs) — this table and count may be missing rows from tonight's sync."
      : "",
    opts.noBaseCount
      ? `${opts.noBaseCount} verse(s) could not be adjudicated because their edit history has aged out (no ` +
        `recoverable ancestor) — a Door43-side change to them will still be overwritten by tonight's export.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function planSystemAlertWrites(
  existing: Map<string, ExistingAlertState>,
  desired: Map<string, string>,
): { toDelete: string[]; toInsert: Array<{ username: string; message: string }> } {
  const toDelete: string[] = [];
  const toInsert: Array<{ username: string; message: string }> = [];
  for (const [username, message] of desired) {
    const ex = existing.get(username);
    if (ex && ex.message === message) continue; // sticky/no-op — see header comment
    if (ex && ex.dismissedAt == null) toDelete.push(username);
    toInsert.push({ username, message });
  }
  for (const [username, ex] of existing) {
    if (!desired.has(username) && ex.dismissedAt == null) toDelete.push(username);
  }
  return { toDelete, toInsert };
}

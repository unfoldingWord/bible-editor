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
  /**
   * verse_merge_conflicts.reason for this overwrite (issue #633). Names what a
   * reader can see changed — wording, alignment, or both — so the editor
   * message can say which, instead of always implying Door43 replaced their
   * text with someone else's work.
   */
  reason?: string;
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

// Issue #633 axes — string compares stay local so this module keeps its
// zero-import contract (see file header). Reasons are minted by
// visibleAdoptionChange.ts's refineAdoptConflictForVisibleChange.
function reasonImpliesWordingChange(reason: string | undefined): boolean {
  if (reason == null || reason === "") return true;
  if (reason === "both_changed_alignment" || reason === "both_changed_no_visible") return false;
  return (
    reason === "both_changed" ||
    reason === "both_changed_wording" ||
    reason.startsWith("both_changed")
  );
}

function reasonImpliesAlignmentChange(reason: string | undefined): boolean {
  if (reason == null || reason === "") return true;
  if (reason === "both_changed_wording" || reason === "both_changed_no_visible") return false;
  return (
    reason === "both_changed" ||
    reason === "both_changed_alignment" ||
    reason.startsWith("both_changed")
  );
}

/** What-changed clause for an overwrite alert (issue #633). */
export function describeOverwriteAxes(reasons: Array<string | undefined>): string {
  const wording = reasons.some((r) => reasonImpliesWordingChange(r));
  const alignment = reasons.some((r) => reasonImpliesAlignmentChange(r));
  if (wording && alignment) return "The wording and the alignment changed.";
  if (wording) return "The wording changed.";
  if (alignment) return "The alignment changed (the wording did not).";
  // Unreachable for alertable adopt_conflict rows; keep a neutral fallback.
  return "Door43's version was taken.";
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
  const byUser = new Map<string, { refs: string[]; reasons: Array<string | undefined> }>();
  for (const ref of overwritten) {
    const username = usernameByKey.get(editLogKey(book, resource, ref));
    if (!username) continue;
    const entry = byUser.get(username) ?? { refs: [], reasons: [] };
    entry.refs.push(`${ref.chapter}:${ref.verse}@v${ref.overwrittenVersion}`);
    entry.reasons.push(ref.reason);
    byUser.set(username, entry);
  }
  const out = new Map<string, { refs: string[]; message: string }>();
  for (const [username, { refs, reasons }] of byUser) {
    // "Door43's sync", not "Door43's nightly sync": this fan-out fires from
    // raiseVerseMergeConflictAlert, which runs on both the 05:30 UTC cron AND
    // the user-triggered POST /:book/reimport route — the admin message in
    // verseMergeConflicts.ts already made this exact correction (its own
    // "FIX I"), and this message must not reintroduce the same overclaim.
    //
    // Issue #633: name what actually differs (wording vs alignment). The
    // version-history recovery sentence stays when wording changed; when only
    // alignment changed, point at the previous alignment rather than implying
    // the words were replaced — and never tell the editor to re-save.
    const axes = describeOverwriteAxes(reasons);
    const wording = reasons.some((r) => reasonImpliesWordingChange(r));
    const recovery = wording
      ? `Your replaced text is still recoverable from each verse's version history, at the version number given after @v.`
      : `Your previous alignment is still recoverable from each verse's version history, at the version number given after @v.`;
    const message =
      `Door43's sync overwrote your edit${refs.length === 1 ? "" : "s"} in ${book} ` +
      `${resource.toUpperCase()} at ${refs.length} verse(s) with Door43's version: ${refs.join(", ")}. ` +
      `${axes} ${recovery}`;
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
//   - 'keep_ai_master'         -> kept D1; both sides moved, but the commit
//                                 lineage found no human commit behind master's
//                                 side (#540 item 2).
// The first two kept-D1 outcomes carry the same warning: nothing was taken, so
// tonight's export will still write D1 back over master until a human resolves
// it. 'keep_ai_master' is the one that does NOT — publishing D1 is the intended
// outcome there, so its sentence must not borrow their warning.

// Cap on how many no-ancestor refs the sentence lists inline, matching the
// `+N more` shape raiseVerseMergeConflictAlert already uses for its conflict
// refs. `noBaseCount` stays authoritative for the number. bookReimport.ts
// collects exactly this many (NO_BASE_REF_CAP) — collecting more would ride
// through every Workflow step's serialized return value and then be discarded
// here, since this sentence is the only consumer.
export const NO_BASE_REF_DISPLAY = 10;

export interface GroupableConflictRow {
  chapter: number;
  verse: number;
  reason: string;
  overwrittenVersion: number | null;
  detectedAt?: number | null;
}

// Same cap raiseVerseMergeConflictAlert has always used for its flat ref list
// (see the pre-#624 `rows.slice(0, 10)` / `+N more` this replaces).
export const MERGE_CONFLICT_REFS_DISPLAY = 10;

function plainDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// Issue #624: a sync-warning alert used to name a flat, unjoined list of refs
// (`Refs: 38:2, 41:9, …`) alongside a SEPARATE reason-count breakdown
// (`1 alignment_shrink, 6 source_attr_ambiguous, …`) — nothing joined a given
// ref to the reason it was flagged for, so triaging the one reason that
// actually needs hand work (alignment_shrink / keep_alignment_refused) meant
// querying prod D1 to find which ref it was. This groups the same refs under
// their reason instead, each group also carrying the OLDEST `detected_at` in
// THAT REASON — not just among the displayed refs — as a plain date, so "how
// long has this been sitting" survives the display cap.
//
// The cap is spent round-robin across reasons rather than taken off the front
// of the list (PR #630 review F1/F2). Taking the first N in chapter order let
// the cap swallow a whole reason: twelve source_attr_ambiguous rows in ch.3
// plus the single alignment_shrink at 40:5 rendered the ch.3 refs and nothing
// else, so the ONE ref needing hand work — the stated point of this clause —
// was the one a reader could not see. Round-robin gives every reason its first
// ref before any reason gets a second.
//
// It also makes the per-reason date honest. `first flagged` is the oldest
// detected_at in the WHOLE reason, not just among the refs shown, so under the
// old front-slice a group could be dated by a row it never listed — a reader
// opening every ref found nothing that old. Now a group is either complete, in
// which case the oldest row IS listed, or it carries its own `+K more` and the
// date visibly belongs to the part not shown. Per-group markers also replace
// the single trailing `+N more`, which sat after the last group and read as
// that group's alone.
//
// Reason order follows first appearance in `rows`, which the caller already
// orders by chapter/verse — this keeps this clause's reason order identical to
// the reasonBreakdown parenthetical, built from the same rows in the same
// order. A reason can still miss out entirely, but only when the distinct
// reason count exceeds the cap outright; those rows are counted in the
// trailing clause rather than silently dropped.
export function buildGroupedRefsClause(rows: GroupableConflictRow[], cap: number = MERGE_CONFLICT_REFS_DISPLAY): string {
  if (rows.length === 0) return "";
  const oldestByReason = new Map<string, number>();
  for (const r of rows) {
    if (r.detectedAt == null) continue;
    const cur = oldestByReason.get(r.reason);
    if (cur == null || r.detectedAt < cur) oldestByReason.set(r.reason, r.detectedAt);
  }
  const order: string[] = [];
  const byReason = new Map<string, GroupableConflictRow[]>();
  for (const r of rows) {
    let group = byReason.get(r.reason);
    if (!group) {
      group = [];
      byReason.set(r.reason, group);
      order.push(r.reason);
    }
    group.push(r);
  }
  // Round-robin: pass N hands every reason its Nth ref, so the cap runs out
  // across reasons evenly instead of down the front of one.
  const shown = new Map<string, GroupableConflictRow[]>();
  let budget = cap;
  for (let pass = 0; budget > 0; pass++) {
    let placedAny = false;
    for (const reason of order) {
      if (budget === 0) break;
      const all = byReason.get(reason) ?? [];
      if (pass >= all.length) continue;
      const list = shown.get(reason);
      if (list) list.push(all[pass]);
      else shown.set(reason, [all[pass]]);
      budget--;
      placedAny = true;
    }
    if (!placedAny) break;
  }
  const clauses: string[] = [];
  let unlistedReasonRows = 0;
  for (const reason of order) {
    const all = byReason.get(reason) ?? [];
    const group = shown.get(reason);
    if (!group) {
      // Only reachable when the distinct reason count exceeds the cap.
      unlistedReasonRows += all.length;
      continue;
    }
    const refsStr = group
      .map((r) => `${r.chapter}:${r.verse}${r.overwrittenVersion != null ? `@v${r.overwrittenVersion}` : ""}`)
      .join(", ");
    const hidden = all.length - group.length;
    const moreStr = hidden > 0 ? `, +${hidden} more` : "";
    const oldest = oldestByReason.get(reason);
    const dateStr = oldest != null ? ` (first flagged ${plainDate(oldest)})` : "";
    clauses.push(`${reason}: ${refsStr}${moreStr}${dateStr}.`);
  }
  const more = unlistedReasonRows > 0 ? ` +${unlistedReasonRows} more in reasons not listed.` : "";
  return ` ${clauses.join(" ")}${more}`;
}

export function buildMergeConflictGuidance(
  rows: Array<{ action: string; reason?: string }>,
  opts: { recordingFailed?: boolean; noBaseCount?: number; noBaseRefs?: string[] } = {},
): string {
  const overwrittenRows = rows.filter((r) => r.action === "adopt_conflict");
  const overwritten = overwrittenRows.length;
  const keptAlignment = rows.filter((r) => r.action === "keep_alignment_refused").length;
  const keptSourceAttr = rows.filter((r) => r.action === "source_attr_divergent").length;
  const keptAiMaster = rows.filter((r) => r.action === "keep_ai_master").length;
  // Issue #633: name wording vs alignment on the admin sentence too. Split
  // recovery copy so an alignment-only overwrite never claims "replaced text".
  const overwriteAxes = describeOverwriteAxes(overwrittenRows.map((r) => r.reason));
  const overwriteWording = overwrittenRows.some((r) => reasonImpliesWordingChange(r.reason));
  const overwriteRecovery = overwriteWording
    ? `the replaced text is still in that verse's version history, at the version number given after @v in its ref above.`
    : `the previous alignment is still in that verse's version history, at the version number given after @v in its ref above.`;
  return [
    overwritten > 0
      ? `${overwritten} took Door43's version over the editor's — ${overwriteAxes} ${overwriteRecovery}`
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
    // Bounded to what was measured, and to what will actually happen — see the
    // matching note over the TSV reason in bookReimport.ts for each clause:
    // "the unfoldingWord bot account" (not "the note pipeline" — the rule is an
    // author email, and that account also pushes scripture and pushes on a
    // human's behalf); "no commit from a Door43 editor's own account" (not "no
    // maintainer edit" — a maintainer may have directed it); "the next export
    // that runs for this resource" (not "tonight's export" — the watermark is
    // withheld for the whole book+resource by a systemic refusal, a lock, or a
    // recording failure, any of which can be described in this same banner);
    // "since the last confirmed publish" (not "since the last sync" — the walk
    // starts at master_confirmed_at). Past tense on the measurement because
    // these rows survive across runs until a human resolves them.
    keptAiMaster > 0
      ? `${keptAiMaster} kept the editor's version even though Door43 changed too: when these were checked, ` +
        `every Door43 commit to this file since the last confirmed publish came from Bible Editor's own export ` +
        `or the unfoldingWord bot account — no commit from a Door43 editor's own account was found. Nothing of ` +
        `Door43's was taken, so the next export that runs for this resource writes the editor's version over ` +
        `Door43's. If Door43's version is the one you want, put it in the app before then.`
      : "",
    opts.recordingFailed
      ? "NOTE: at least one merge-conflict recording failed to write to verse_merge_conflicts this run " +
        "(see worker logs) — this table and count may be missing rows from tonight's sync."
      : "",
    opts.noBaseCount ? buildNoBaseSentence(opts.noBaseCount, opts.noBaseRefs) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// The `keep_no_base` sentence. Two corrections over the version this replaces,
// both from the 2026-08-19 prod measurement behind issue #537:
//
// 1. IT NAMED NO VERSES. A sentence whose own point is "tonight's export may
//    overwrite a Door43 edit here" has to say where "here" is — the same rule
//    the adjudicated refs already follow (`40:5@v8, …`). keep_no_base writes no
//    verse_merge_conflicts row, so the banner is the only channel these verses
//    have. No `@vN` suffix: nothing was overwritten yet, so there is no replaced
//    version to point a restore at.
//
// 2. IT ASSERTED A CAUSE WE HAD NOT MEASURED. The old text said the edit history
//    "has aged out". Prod on 2026-08-19: edit_log spans 93 days (oldest entry
//    2026-05-18), so the 180-day sweep in index.ts has never deleted a row and
//    could not have caused a single one of the 190 verses then in this state.
//    Every one of them was simply never written to edit_log before its book's
//    master-confirmed watermark. Aging out remains POSSIBLE once the table is
//    older than 180 days, which is exactly why this may not name either limb.
//
//    Nor may it name the *third* limb. What is actually measured is one thing:
//    computeVerseMerge received `base === null`. That happens when no edit_log
//    row exists at or before the boundary, AND when a row exists whose payload
//    carries no `content` or does not parse (verseContentJsonFromPayload —
//    verseHistory.test.mjs covers both). In those last two the ancestor did
//    survive; it was simply not RECOVERABLE. So the wording says exactly that,
//    which is the accurate half of the sentence this replaced. (Standing rule —
//    an alert states only what it measured; see STATE.md's alert-wording
//    lessons. That rule applies to the replacement too, which is why the first
//    draft's "no ancestor survives" did not stand either.)
//
// Scope note: the ancestor lookup is PER VERSE (row_key = book/chapter/verse/
// RESOURCE), so this must not say "this book's edit history" — thousands of
// other verses in the same book have perfectly good ancestors, and a
// non-developer could read the book-wide phrasing as "the history is gone".
// Fingerprints shared by buildNoBaseSentence (admin) and
// groupNoBaseVersesByEditor (translator fan-out). keep_no_base writes no
// verse_merge_conflicts row, so the banner message is the only durable
// carrier of that warning until the next reimport — clearResolvedConflictBannerIfLast
// must not delete an alert that still carries one just because the last
// ordinary conflict resolved (PR #631 review P1).
export const NO_BASE_ADMIN_FINGERPRINT = "no ancestor was recoverable";
export const NO_BASE_EDITOR_FINGERPRINT = "no earlier version was recoverable to compare against";

export function alertMessageCarriesNoBaseWarning(message: string): boolean {
  return (
    message.includes(NO_BASE_ADMIN_FINGERPRINT) || message.includes(NO_BASE_EDITOR_FINGERPRINT)
  );
}

export function buildNoBaseSentence(count: number, refs?: string[]): string {
  // Never list more refs than the count claims. Unreachable today (refs are
  // pushed on the same branch that increments the count, and nothing decrements
  // it), but the invariant is cheap to enforce and the helper is exported.
  const listed = (refs ?? []).slice(0, Math.min(count, NO_BASE_REF_DISPLAY));
  // `refs` is a capped sample and can be short of `count` — or empty, for a
  // Workflow chunk memoized before it was collected. Only claim "+N more"
  // against what we actually listed, and stay silent rather than guess when the
  // sample is missing entirely. "sample" is load-bearing: on a mixed run the
  // listed refs are not necessarily the first N, so a reader must not take the
  // unlisted remainder to be a contiguous tail.
  const more = count > listed.length ? `; +${count - listed.length} more` : "";
  const where = listed.length > 0 ? ` Verses (sample): ${listed.join(", ")}${more}.` : "";
  return (
    `${count} verse(s) could not be adjudicated: ${NO_BASE_ADMIN_FINGERPRINT} for them from before this ` +
    `book+resource's master-confirmed watermark, so the sync could not tell which side changed, and so it ` +
    `kept the app's version.${where} ` +
    `Nothing was overwritten in these — but a Door43-side change to them will still be overwritten by ` +
    `tonight's export.`
  );
}

// ---------------------------------------------------------------------------
// keep_no_base editor fan-out (issue #544). buildNoBaseSentence (above) tells
// the ADMIN which verses could not be adjudicated and warns that tonight's
// export may still overwrite a Door43-side change to them — but until now
// that warning reached nobody who could act on it: groupOverwrittenVersesByEditor
// only fires for 'adopt_conflict' rows, and a keep_no_base verse writes no
// verse_merge_conflicts row at all (there was nothing to adjudicate), so the
// translator who owns the app-side text never learned tonight's export might
// still clobber a Door43 edit to "their" verse.
//
// Attribution reuses the exact same edit_log JOIN groupOverwrittenVersesByEditor
// uses (editLogKey / buildEditorLookupQuery), just keyed differently: an
// overwritten verse looks up `overwrittenVersion` (the D1 version that WAS
// replaced); a keep_no_base verse has no such thing — nothing was replaced —
// so it looks up its CURRENT D1 version instead, i.e. the version whose
// edit_log row is this verse's most recent edit. The caller (bookReimport.ts)
// only reaches this path for a verse already established as genuinely
// human-edited (not AI-only — see applyVerseRows' `aiOnly` branch, which
// `continue`s before computeVerseMerge ever runs), so that edit_log row is
// the human who "last edited it in the app," per the issue's own wording.
//
// CRITICAL WORDING RULE: unlike groupOverwrittenVersesByEditor's message,
// this one must NEVER say anything was overwritten — nothing was. D1 was kept
// precisely because no ancestor was recoverable to tell which side changed.
export interface NoBaseVerseRef {
  chapter: number;
  verse: number;
  /** The verse's CURRENT D1 version at read time (NOT a replaced version —
   *  nothing was overwritten). Reused as the edit_log lookup key the same way
   *  OverwrittenVerseRef.overwrittenVersion is, via editLogKey. */
  version: number;
}

export function groupNoBaseVersesByEditor(
  book: string,
  resource: string,
  noBase: NoBaseVerseRef[],
  usernameByKey: Map<string, string>,
): Map<string, { refs: string[]; message: string }> {
  const byUser = new Map<string, string[]>();
  for (const ref of noBase) {
    const username = usernameByKey.get(
      editLogKey(book, resource, { chapter: ref.chapter, verse: ref.verse, overwrittenVersion: ref.version }),
    );
    if (!username) continue; // no human on this verse's current version — nothing to notify
    const list = byUser.get(username) ?? [];
    list.push(`${ref.chapter}:${ref.verse}`); // no "@vN" — nothing was overwritten, so there is no replaced version to point at
    byUser.set(username, list);
  }
  const out = new Map<string, { refs: string[]; message: string }>();
  for (const [username, refs] of byUser) {
    const message =
      `Door43's sync could not tell whether your edit or a Door43-side edit is newer, for ${refs.length} ` +
      `verse(s) you last edited in ${book} ${resource.toUpperCase()}: ${refs.join(", ")} — ${NO_BASE_EDITOR_FINGERPRINT}, ` +
      `so it kept your version for now. Nothing has been overwritten — but if ` +
      `Door43 has changed ${refs.length === 1 ? "it" : "them"} since, tonight's export will still overwrite your ` +
      `text there unless you open and re-save the verse${refs.length === 1 ? "" : "s"} here first.`;
    out.set(username, { refs, message });
  }
  return out;
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

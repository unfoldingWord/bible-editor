// The one-line human summary of a "Pull from Door43" result, shown as a snackbar
// message by ImportFromDoor43Dialog.
//
// Extracted out of that component purely so it can be tested: the component
// imports MUI, which the repo's strip-types test runner can't load, so any
// assertion about this wording had to be done by eye in a browser. It is pure
// string formatting over an API response — exactly the shape that should be a
// plain module with a test (see reimportSummary.test.mjs).

import type { ReimportResponse } from "../sync/api";

export function summarizeReimport(res: ReimportResponse): string {
  const t = res.totals;
  const parts: string[] = [];
  if (t.updated) parts.push(`${t.updated} updated`);
  if (t.reimported_ai) parts.push(`${t.reimported_ai} refreshed (AI-generated)`);
  if (t.inserted) parts.push(`${t.inserted} inserted`);
  if (t.skipped_edited) parts.push(`${t.skipped_edited} skipped (already edited)`);
  if (t.skipped_locked) parts.push(`${t.skipped_locked} skipped (AI pipeline running)`);
  if (t.skipped_noop) parts.push(`${t.skipped_noop} unchanged`);
  // Issue #609. NOT folded into "unchanged": these verses DID differ from Door43
  // byte-for-byte. The sync declined to adopt the difference because rendering
  // both versions through the export produces identical USFM — so the wording says
  // what was actually measured ("identical once exported"), not the weaker
  // "formatting", which would understate a difference that could change word
  // boundaries. On a chapter the last export reflowed, every verse can land here,
  // so without this line the list would be empty and the snackbar would report "no
  // changes" for a pull that declined every verse.
  if (t.skipped_normalized) parts.push(`${t.skipped_normalized} identical once exported`);
  // Issue #639, same precedent as skipped_normalized directly above: a decision
  // the sync made that nobody can see from the row counts. Without these two
  // lines a pull that refused a whole resource reports "no changes" — the single
  // most misleading thing this snackbar could say about a refusal, since the
  // operator would reasonably read it as "Door43 and the app already agree".
  //
  // Worded per-resource ("file"), because the measurement is per (book,
  // resource) and other resources for the same book are unaffected.
  if (t.stale_base_held) {
    parts.push(`${t.stale_base_held} file(s) held — Door43 has an older translationCore export (see alerts)`);
  }
  // The override having been USED gets its own, louder line: this one published a
  // known revert rather than refusing it.
  if (t.stale_base_overridden) {
    parts.push(`${t.stale_base_overridden} stale file(s) ADOPTED by override — will publish to Door43`);
  }
  if (t.source_attr_reconciled) parts.push(`${t.source_attr_reconciled} source-attr fix(es) synced from master`);
  if (t.merge_adopted) parts.push(`${t.merge_adopted} adopted from master (out-of-band correction)`);
  // Kept the app's version of a two-sided change, because no commit from a
  // Door43 editor's own account was found behind Door43's side (#540 item 2).
  //
  // Subtracted from the conflict line rather than added beside it: on the verse
  // side merge_kept_ai is a strict subset of merge_conflicts, so listing both
  // reported the same three rows as six. `Math.max(0, …)` is not tidying a
  // negative away — on the TSV side merge_conflicts is only incremented for a
  // row that also ADOPTED a field, so a kept-only row is genuinely outside it,
  // and the counters can legitimately cross.
  const keptOverDoor43 = t.merge_kept_ai ?? 0;
  const mergedFromDoor43 = Math.max(0, (t.merge_conflicts ?? 0) - keptOverDoor43);
  if (mergedFromDoor43) parts.push(`${mergedFromDoor43} flagged for review (merge conflict)`);
  // Names the direction, like every other line in this list, and does not
  // promise a publish it cannot schedule — the export is the nightly one, not
  // something the reader of this snackbar triggers.
  if (keptOverDoor43)
    parts.push(
      `${keptOverDoor43} kept the app's version over Door43's (no Door43 editor's commit found) — ` +
        `check before the next export`,
    );
  // Rows whose Reference disagrees between the app and Door43. Split by who
  // moved (api/src/tsvMerge.ts's classifyTsvRefMove) because only the held cases
  // need anyone's attention — a move the app made is an ordinary edit the export
  // publishes, and reporting it as "flagged" is what used to tell a translator to
  // undo her own work. The held cases are summed because the human action is the
  // same for all of them, and the per-row flag carries the specific reason.
  //
  // "differs between here and Door43" - deliberately directionless. The bucket
  // includes `unattributable`, where the sync explicitly could NOT say which side
  // moved, and `ours_moved_conflict`, where WE moved it. Any phrasing that reads
  // as "Door43 changed this" would assert in the summary the very thing the
  // per-row reasons are careful not to claim. The per-row reason carries the
  // specific, measured story; this line only says a human should look.
  const refHeld =
    (t.ref_moved_theirs ?? 0) +
    (t.ref_moved_both ?? 0) +
    (t.ref_moved_unattributable ?? 0) +
    (t.ref_moved_ours_conflict ?? 0);
  if (refHeld) parts.push(`${refHeld} flagged for review (reference differs between here and Door43)`);
  // Door43 held exactly the file our last export pushed, so its changes were our
  // own merged export rather than anyone else's edit. The pull still ran; what
  // changed is that those edits are no longer mistaken for someone else's work
  // (see api/src/ownPublish.ts).
  if (t.own_publish_converged)
    parts.push(`${t.own_publish_converged} resource(s) confirmed as holding our last export`);
  // Master rows that could NOT be imported because their id is already taken in
  // D1 by a soft-deleted row (ids are never released). Worth saying out loud
  // rather than burying in "skipped": the rows are genuinely missing from D1.
  //
  // Says ONLY that. It deliberately does NOT mention the sync watermark, even
  // though these counters do withhold it on the nightly path: this string is the
  // snackbar for the *manual* "Pull from Door43" action, which runs runReimport
  // (api/src/bookReimport.ts) — a path that never touches book_resource_syncs at
  // all. Claiming "book left marked out of sync" here would assert an effect
  // this run did not have. See api/src/reimportClassify.ts / GitHub issue #427.
  const blocked = (t.tombstone_blocked ?? 0) + (t.conflict_skipped ?? 0);
  if (blocked) parts.push(`${blocked} NOT imported (ID still held by a deleted row)`);
  // A reissued tombstone (master carries the id at a DIFFERENT reference) whose
  // slot this run reclaimed for master automatically (issue #427, option 1) —
  // informational, not actionable, so it sits after the blocked-row line rather
  // than competing with it for attention.
  if (t.tombstone_reclaimed) parts.push(`${t.tombstone_reclaimed} reissued tombstone(s) reclaimed`);
  if (t.dcs_404) parts.push(`${t.dcs_404} resource(s) not on DCS`);
  if (parts.length === 0) return `Imported ${res.book} — no changes.`;
  return `Imported ${res.book}: ${parts.join(", ")}.`;
}

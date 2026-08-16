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
  if (t.source_attr_reconciled) parts.push(`${t.source_attr_reconciled} source-attr fix(es) synced from master`);
  if (t.merge_adopted) parts.push(`${t.merge_adopted} adopted from master (out-of-band correction)`);
  if (t.merge_conflicts) parts.push(`${t.merge_conflicts} flagged for review (merge conflict)`);
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
  if (t.dcs_404) parts.push(`${t.dcs_404} resource(s) not on DCS`);
  if (parts.length === 0) return `Imported ${res.book} — no changes.`;
  return `Imported ${res.book}: ${parts.join(", ")}.`;
}

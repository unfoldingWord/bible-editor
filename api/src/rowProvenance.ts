/**
 * Issue #686 — the row-level answer to "what was the last change here, was it
 * Bible Editor or Door43, and who did it".
 *
 * Migration 0060 added `last_change_action` / `last_change_source` /
 * `last_change_actor` to tn_rows, tq_rows, twl_rows and verses. This module owns
 * the vocabulary and the actor wording so that the ~45 write sites across
 * rows.ts, verses.ts, pipelineImport.ts, bookImport.ts, bookReimport.ts,
 * twlSortOrderApply.ts and index.ts cannot drift into three spellings of the
 * same fact.
 *
 * WHY DENORMALIZED COLUMNS RATHER THAN A VIEW OVER edit_log. #686's own survey
 * is the reason: several paths that move a row (in-app reorder, review-flag
 * clear, reimport ref_moved clear, reimport reorder, applyTwlSortOrderUpdates,
 * the whole-book import wipe/reinsert) write NO edit_log row at all, so a view
 * would confidently report the wrong change — the last one that happened to be
 * audited. Stamping the row in the SAME statement as the write cannot be out of
 * step with the write, which is the whole property being bought.
 *
 * NO import of `hono` here, and none of Env: `api/src/*.test.mjs` runs under
 * plain `node --experimental-strip-types`, which cannot resolve `hono` from
 * node_modules (STATE.md, "A module that imports hono cannot be unit-tested").
 * The DB is taken as a structural parameter for the same reason.
 */

import { displayAuthor, type MasterLineage, type MasterLineageSummary } from "./masterLineage.ts";

/**
 * WHAT the last change was. Small and self-explanatory on purpose — this string
 * is destined for a translator-facing chip, not for a machine to branch on.
 *
 * The `sync_*` values are separated from their in-app equivalents ('sync_merge'
 * vs 'update', 'sync_reorder' vs 'reorder') because the distinction is the
 * entire point of the issue: "Door43 changed this" and "someone here changed
 * this" have to be legible apart even though both are, mechanically, an UPDATE.
 */
export type LastChangeAction =
  /** A row/verse created in the app (POST /api/rows, verse-0 create). */
  | "create"
  /** A content edit through the app's PATCH path. */
  | "update"
  /** Soft delete (`deleted_at` set). */
  | "delete"
  /** A restore-from-history write. */
  | "restore"
  /** sort_order changed and nothing else — the drag fast path. */
  | "reorder"
  /** tn preserve bit toggled (either direction). */
  | "preserve"
  /** tn hint bit toggled (either direction). */
  | "hint"
  /** tn moved to the trash tray. */
  | "trash"
  /** tn brought back out of the trash tray. */
  | "untrash"
  /** A review flag cleared (the no-op re-save ack, or the nightly stale sweep). */
  | "review_clear"
  /** A review flag dismissed through the dismiss-review endpoint. */
  | "dismiss_review"
  /** The AI pipeline rewrote a hint note in place. */
  | "hint_expansion"
  /** The AI pipeline created/overwrote/pruned this row. */
  | "ai_apply"
  /** The whole-book bootstrap import wrote this row. */
  | "import"
  /** The nightly promoted a trashed tn row to a soft delete. */
  | "finalize_trash"
  /** The nightly DCS sync merged or adopted master's value. */
  | "sync_merge"
  /** The nightly DCS sync re-seeded the row from master (AI/pristine reseed, resurrect, reclaim). */
  | "sync_reseed"
  /** The nightly DCS sync soft-deleted a row master no longer carries. */
  | "sync_prune"
  /** The nightly DCS sync (or the canonical TWL reorder) changed only sort_order. */
  | "sync_reorder";

/** WHERE the change happened. */
export type LastChangeSource =
  /** A signed-in human acting in Bible Editor. */
  | "user"
  /** The AI pipeline's auto-apply, however it was started. */
  | "ai_pipeline"
  /** The Door43 → D1 nightly sync / reimport. */
  | "dcs_sync"
  /** The whole-book bootstrap import. */
  | "import"
  /** An unattended path with no human behind it (cron housekeeping). */
  | "system";

/**
 * The three values, in the order every statement in this codebase binds them.
 * Passing them as one tuple is what keeps a three-parameter stamp from being
 * bound out of order at one of ~45 call sites.
 */
export interface RowProvenance {
  action: LastChangeAction;
  source: LastChangeSource;
  /**
   * WHO, as a human-readable string. Never a users.id: a denormalized name is
   * the point — it has to still answer the question after the user row is
   * renamed, merged or deleted. Null only where the writer genuinely has no
   * identity to state, which reads as "consult edit_log" exactly like a NULL
   * column does.
   */
  actor: string | null;
}

/** The three column names, in bind order — for an INSERT column list. */
export const PROVENANCE_COLUMNS = ["last_change_action", "last_change_source", "last_change_actor"] as const;

/**
 * `last_change_action = ?7, last_change_source = ?8, last_change_actor = ?9`
 * for an UPDATE's SET list, starting at the given 1-based parameter index.
 *
 * Built rather than written out because most of these statements already number
 * their parameters by hand, several build their SET list dynamically, and a
 * hand-typed `?12` that is actually `?11` binds an action into a content column.
 */
export function provenanceSet(firstParam: number): string {
  return (
    `last_change_action = ?${firstParam}, ` +
    `last_change_source = ?${firstParam + 1}, ` +
    `last_change_actor = ?${firstParam + 2}`
  );
}

/** The tuple to `.bind(...)`, in the order `provenanceSet` / `PROVENANCE_COLUMNS` expect. */
export function provenanceValues(p: RowProvenance): [string, string, string | null] {
  return [p.action, p.source, p.actor];
}

/**
 * "AI pipeline (run by justplainjane47)" — both facts in one string.
 *
 * A machine wrote the row; a named human asked it to. Collapsing that to either
 * one alone is exactly the lie #686 is about: `updated_by` already stores the
 * starter's id, and reading THAT as the actor is what makes the row claim a
 * human typed an AI note. When the starter cannot be named the string still says
 * a pipeline wrote it, which is the load-bearing half.
 */
export function aiPipelineActor(username: string | null | undefined): string {
  return username ? `AI pipeline (run by ${username})` : "AI pipeline";
}

/** What a `source: 'user'` write stamps when the username could not be resolved. */
function userFallbackActor(userId: number | null | undefined): string {
  return typeof userId === "number" ? `user #${userId}` : "unknown user";
}

/**
 * The DCS username for a write, JWT first and D1 second.
 *
 * JWT first because this runs on the row-save hot path and the claim is already
 * in memory (`auth.ts` puts it on the Hono context); the `users` lookup is the
 * fallback for a token minted before the claim existed. Never throws and never
 * returns null — a save must not fail because a name lookup did, and a NULL
 * actor on a write we KNOW a user made would read as "no change since the
 * migration", so an unresolvable user is stamped as `user #<id>`: honest, and
 * still joinable back to the users table by hand.
 */
export async function resolveActorUsername(
  db: { prepare: (sql: string) => { bind: (...v: unknown[]) => { first: <T>() => Promise<T | null> } } },
  userId: number | null | undefined,
  fromJwt?: string | null,
): Promise<string> {
  if (fromJwt) return fromJwt;
  if (typeof userId !== "number") return userFallbackActor(userId);
  try {
    const row = await db
      .prepare(`SELECT dcs_username FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ dcs_username: string }>();
    return row?.dcs_username || userFallbackActor(userId);
  } catch {
    return userFallbackActor(userId);
  }
}

/** What a dcs_sync write stamps when the run measured nothing it can name. */
export const DOOR43_ACTOR_UNMEASURED = "Door43 sync";
/** What a dcs_sync write stamps when a COMPLETE walk found no human commit. */
export const DOOR43_ACTOR_AI_PUSH = "Door43 (AI/bot push)";

/**
 * How many Door43 authors a stamp names. Two, not three: this is an actor
 * field read at a glance beside a row, and the full evidence (every measured
 * sha, author and date) already lives in `review_master_json` / the persisted
 * lineage for anyone doing forensics.
 */
const DOOR43_NAMED_AUTHORS_MAX = 2;

/**
 * Who moved master, for a `source: 'dcs_sync'` write — and ONLY what the run's
 * lineage actually measured (#684's rule, applied to the actor column):
 *
 *   - lineage absent, or its walk INCOMPLETE  → "Door43 sync"
 *     Nobody established who, or even that anyone, moved the file. An
 *     incomplete walk is not evidence of absence.
 *   - a COMPLETE walk that found no human commit → "Door43 (AI/bot push)"
 *     This one IS a measurement: the walk finished and every commit in the
 *     window was ours or a bot's.
 *   - human commits measured WITH identity → "Door43: NAME" / "Door43: A and B"
 *   - human commits measured with NO legible identity, or a summary persisted
 *     before #684 (`humanCommits` absent) → "Door43 sync"
 *     Something moved master and this record cannot say who. Naming the
 *     newest author from a field that was never populated is precisely the
 *     fabrication the rule forbids.
 *
 * Names go through masterLineage's `displayAuthor` — the same bidi-isolate and
 * clamp treatment the review reasons use, because this is the same third-party
 * free text landing in the same kind of one-line UI. Distinct authors only,
 * newest first (the order `humanCommits` already carries).
 *
 * Pure — no fetch, no D1.
 */
export function door43Actor(lineage: MasterLineage | MasterLineageSummary | null | undefined): string {
  if (lineage == null) return DOOR43_ACTOR_UNMEASURED;
  if (lineage.incomplete !== false) return DOOR43_ACTOR_UNMEASURED;
  if (lineage.hasHumanCommit !== true) return DOOR43_ACTOR_AI_PUSH;

  // Both lineage shapes, same as describeHumanCommits: the full form carries
  // every commit, the compacted form carries `humanCommits` — and absent
  // `humanCommits` on a compacted summary means identity was NOT measured.
  const authors: (string | null)[] =
    "commits" in lineage
      ? lineage.commits.filter((c) => c.kind === "human").map((c) => c.authorName ?? null)
      : (lineage.humanCommits ?? []).map((c) => c.author);

  const named: string[] = [];
  let extra = 0;
  for (const a of authors) {
    const who = displayAuthor(a);
    if (!who || named.includes(who)) continue;
    if (named.length < DOOR43_NAMED_AUTHORS_MAX) named.push(who);
    else extra++;
  }
  if (named.length === 0) return DOOR43_ACTOR_UNMEASURED;
  // "and others" rather than a count: the count would be of the authors this
  // lineage's capped evidence happened to carry, not of everyone who touched
  // the file, and a precise-looking number that is not the real one is worse
  // than the vaguer true statement.
  const list = named.join(" and ");
  return `Door43: ${list}${extra > 0 ? " and others" : ""}`;
}

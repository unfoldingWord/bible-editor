// Turning a server refusal into something a translator can read.
//
// The outbox classifies any non-retryable 4xx as `fatal` and parks the op in
// the failed-edits panel. It used to record only `http 400` and throw the
// server's own explanation away — so a *correct* validation refusal reached
// the translator as their text silently reverting, indistinguishable from the
// app losing work (issue #370, split out of #366, where exactly that cost
// three delete attempts and a misdirected investigation).
//
// This module is deliberately pure (no React, no IndexedDB, no fetch) so the
// body → reason → sentence chain is unit-testable: see refusalReason.test.mjs.

/** The `fatal` shape from outbox.ts, narrowed to what we read here. */
interface ResultLike {
  kind: string;
  serverReason?: string;
}

// Upper bound on a stored/rendered reason. One API `message` echoes unbounded
// caller input back (see serverRefusalReason), and this string is persisted.
const MAX_REASON_CHARS = 200;

/**
 * Lift the server's explanation out of an error response body.
 *
 * Preference order, most specific first:
 *  1. `message` — already a finished human sentence (e.g. the raw-TAB guard in
 *     api/src/rows.ts), so it is passed through verbatim.
 *  2. `reason` — the narrow sub-code (`empty_verse_objects`,
 *     `unsafe_marker_tag`), which says far more than its parent `error`.
 *  3. `error` — the broad code (`invalid_body`, `not_found`, …).
 *
 * Returns undefined when the body carries nothing usable — the caller then
 * falls back to the bare status, exactly as before.
 */
export function serverRefusalReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = b[key];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  };
  // `book_locked` is the one body where `reason` is free-text written by a
  // human ("published in v86", an admin's lock note) rather than a code. On
  // its own that fragment explains nothing, so keep the code as the key and
  // carry the note as a suffix for explainRefusal to append.
  if (str("error") === "book_locked") {
    const note = str("reason");
    return note ? `book_locked: ${note}` : "book_locked";
  }
  const found = str("message") ?? str("reason") ?? str("error");
  // One `message` (the chapter-0 ref guard in api/src/rows.ts) echoes the
  // caller's own `ref_raw`, which has no length bound in its schema. This
  // string is persisted to IndexedDB and rendered in a panel that wraps rather
  // than ellipsing, so cap it here instead of letting one row push the rest of
  // the list off screen.
  if (found && found.length > MAX_REASON_CHARS) {
    return `${found.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`;
  }
  return found;
}

/**
 * The value that belongs on `op.lastErrorReason` for a given drain result.
 * Only a refusal carries one; every other outcome clears the field so a reason
 * from an earlier attempt can't linger on an op that later failed for a
 * different cause. Kept here (rather than inline in drainPass) so the rule the
 * op record is written from is directly testable.
 */
export function reasonForOp(result: ResultLike): string | undefined {
  return result.kind === "fatal" ? result.serverReason : undefined;
}

// Machine code → plain sentence. Keys are matched against the *whole* reason
// string; anything unmatched falls through to the raw string, which is still
// better than "http 400" and keeps a support conversation possible without a
// `wrangler tail`.
//
// Copy rule: say what the server would not accept, in a translator's words.
// Do NOT repeat "your previous text is safe" here — the panel says that once,
// above the list, so it doesn't drone on every row.
const PLAIN_REASONS: Record<string, string> = {
  // --- verse content guards (api/src/verses.ts) ---
  empty_verse_objects: "The server will not save a completely empty verse.",
  unsafe_marker_tag: "This text contains a formatting code the server does not allow.",
  source_text_is_read_only: "Hebrew and Greek source texts cannot be edited.",
  unexpected_alignment_loss:
    "Saving this would have dropped word alignments your edit did not touch.",

  // --- shape / validation (api/src/rows.ts, api/src/verses.ts) ---
  invalid_body: "The server did not accept the contents of this edit.",
  invalid_content: "The server did not accept the contents of this edit.",
  invalid_json: "The server could not read this edit.",
  validation_failed: "This edit did not pass the server's checks.",
  empty_patch: "This edit had no changes in it to save.",

  // --- addressing (wrong book / kind / version identifier) ---
  invalid_kind: "This edit was addressed to something the server does not recognise.",
  invalid_bible_version: "This edit was addressed to something the server does not recognise.",
  invalid_params: "This edit was addressed to something the server does not recognise.",
  book_required: "This edit was addressed to something the server does not recognise.",

  // --- the thing being edited is gone ---
  not_found: "The note or verse this edit belongs to no longer exists on the server.",
  unknown_chapter: "That chapter no longer exists on the server.",

  // --- permissions ---
  not_an_editor: "Your account does not have permission to edit, so this change was not saved.",
  book_locked: "This book is locked for editing, so the change was not saved.",
  // Defensive only — not reachable today, kept so a future routing change
  // degrades to a sentence rather than a bare code. `read_only` is thrown
  // client-side with no body (api.ts) and viewers are short-circuited at
  // enqueue anyway; `chapter_locked` ops are deleted in drainPass, never
  // failed; `forbidden` always ships `reason: "not_an_editor"`, which wins the
  // preference order in serverRefusalReason.
  read_only: "Your account has read-only access, so this change was not saved.",
  chapter_locked: "An AI run was working on this chapter, so the change was not applied.",
  forbidden: "Your account does not have permission to make this change.",

  // --- protocol ---
  if_match_required: "This edit was sent without a version stamp, so the server would not apply it.",
};

/**
 * Plain sentence for a stored reason.
 *
 * Some reasons arrive as `code: detail` — `unexpected_alignment_loss` appends a
 * sample of the words at risk, `book_locked` appends the lock note. Match on the
 * leading code and keep the detail in parentheses, since it is the part that
 * tells the translator which case they are in. Unknown reasons (including the
 * server's own prose `message` fields) come back unchanged.
 */
export function explainRefusal(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const exact = PLAIN_REASONS[reason];
  if (exact) return exact;
  const colon = reason.indexOf(":");
  if (colon > 0) {
    const head = reason.slice(0, colon).trim();
    const detail = reason.slice(colon + 1).trim();
    const sentence = PLAIN_REASONS[head];
    if (sentence) return detail ? `${sentence} (${detail})` : sentence;
  }
  return reason;
}

/**
 * Does this failed op still have a future?
 *
 * Ops reach `failed` by exactly two routes (see drainPass): the retry-cap
 * branch, which always stamps `max_attempts_exceeded` and is auto-revived by
 * reviveMaxAttemptsFailed when the tab is focused, connectivity returns, or
 * the session refreshes; and the fatal branch, which is the server saying no
 * and will never succeed on a resend. So the sentinel alone separates "will
 * try again" from "refused".
 *
 * THIS IS THE ONLY DEFINITION of that predicate. reviveMaxAttemptsFailed
 * imports it rather than re-testing the literal, so the set of ops the UI
 * labels "still trying" and the set the outbox actually revives cannot drift
 * apart — which is exactly the bug that would make the label a lie.
 */
export function willRetryOnItsOwn(lastError: string | undefined): boolean {
  return lastError === MAX_ATTEMPTS_SENTINEL;
}

/** `lastError` stamped on an op that ran out of retries. */
export const MAX_ATTEMPTS_SENTINEL = "max_attempts_exceeded";

/** The subset of a stored op that a drop guard is allowed to judge. */
export interface DropGuardRecord {
  status: string;
  lastError?: string;
}

export interface DropGuardOpts {
  /** Only delete when the stored record still has this status. */
  onlyIfStatus?: string;
  /**
   * Only delete when the stored record's refused-ness still matches. `true`
   * means "must currently be a refusal"; `false` means "must currently be a
   * will-retry op". Omit for no constraint.
   */
  onlyIfRefused?: boolean;
}

/**
 * May a drop delete the CURRENT stored record?
 *
 * The dangerous case this exists for: the failed-ops panel builds its discard
 * list from one tab's snapshot, but cross-tab writes never reach that tab's
 * subscription. Another tab can retry an op between the dialog opening and the
 * user confirming, so by delete time the record can have moved from "refused"
 * to "ran out of retries, will revive on its own" — an op the UI now promises
 * is coming back. Checking only `status === "failed"` would delete it anyway,
 * because both classes are `failed`. So the refused-ness is re-checked here,
 * against the freshly-read record, inside the same transaction as the delete.
 *
 * Pure and exported so the rule is testable without IndexedDB.
 */
export function dropGuardAllows(
  current: DropGuardRecord,
  opts?: DropGuardOpts,
): boolean {
  // A request is already on the wire — deleting underneath it would race the
  // 200 handler's own delete.
  if (current.status === "in_flight") return false;
  if (opts?.onlyIfStatus !== undefined && current.status !== opts.onlyIfStatus) return false;
  if (
    opts?.onlyIfRefused !== undefined &&
    willRetryOnItsOwn(current.lastError) === opts.onlyIfRefused
  ) {
    return false;
  }
  return true;
}

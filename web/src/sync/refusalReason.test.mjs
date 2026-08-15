// Tests for web/src/sync/refusalReason.ts — the body → reason → sentence chain
// behind issue #370. Before this, the outbox recorded only "http 400" and the
// server's own explanation was dropped on the floor, so a *correct* validation
// refusal reached the translator as their text silently reverting.
//
// The error bodies asserted here are copied from the API's real call sites
// (api/src/rows.ts, api/src/verses.ts, api/src/auth.ts, api/src/bookLock.ts),
// so a change to either side should make this fail rather than silently
// degrade the drawer back to a bare status code.

import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS_SENTINEL,
  dropGuardAllows,
  explainRefusal,
  reasonForOp,
  serverRefusalReason,
  willRetryOnItsOwn,
} from "./refusalReason.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// --- serverRefusalReason: lifting the explanation out of a real body ---

// The #366 case: deleting every word of a verse. api/src/verses.ts:240.
check(
  serverRefusalReason({ error: "invalid_body", reason: "empty_verse_objects" }) ===
    "empty_verse_objects",
  "prefers the narrow `reason` over the overloaded `error`",
);

// api/src/verses.ts:244
check(
  serverRefusalReason({ error: "invalid_content", reason: "unsafe_marker_tag" }) ===
    "unsafe_marker_tag",
  "unsafe marker tag surfaces its specific reason",
);

// api/src/rows.ts:221 — the only bodies carrying finished prose use `message`.
check(
  serverRefusalReason({
    error: "invalid_body",
    message: "Field 'quote' contains a raw TAB character, which is not allowed.",
  }) === "Field 'quote' contains a raw TAB character, which is not allowed.",
  "`message` prose wins over both codes",
);

// api/src/verses.ts:234 — typing into the Hebrew/Greek column.
check(
  serverRefusalReason({ error: "source_text_is_read_only" }) === "source_text_is_read_only",
  "falls back to `error` when nothing more specific is present",
);

// api/src/rows.ts:213 — zod failure; `details` is a nested tree, not prose.
check(
  serverRefusalReason({ error: "invalid_body", details: { note: { _errors: [] } } }) ===
    "invalid_body",
  "ignores the zod `details` tree and keeps the code",
);

// api/src/auth.ts:239
check(
  serverRefusalReason({ error: "forbidden", reason: "not_an_editor" }) === "not_an_editor",
  "role refusal surfaces not_an_editor",
);

// api/src/bookLock.ts — the ONE body where `reason` is human-written free text
// rather than a code. On its own "published in v86" explains nothing, so the
// code stays the key and the note rides along as a suffix.
check(
  serverRefusalReason({ error: "book_locked", book: "RUT", reason: "published in v86" }) ===
    "book_locked: published in v86",
  "book_locked keeps its code and carries the lock note as a suffix",
);
check(
  serverRefusalReason({ error: "book_locked", book: "RUT" }) === "book_locked",
  "book_locked with no note is just the code",
);

// Bodies with nothing usable must yield undefined so the caller keeps its
// existing bare-status behaviour instead of rendering junk.
check(serverRefusalReason(undefined) === undefined, "undefined body → no reason");
check(serverRefusalReason(null) === undefined, "null body → no reason");
check(serverRefusalReason("plain text") === undefined, "non-object body → no reason");
check(serverRefusalReason({}) === undefined, "empty body → no reason");
check(serverRefusalReason({ error: "   " }) === undefined, "whitespace-only code → no reason");
check(serverRefusalReason({ error: 42 }) === undefined, "non-string code → no reason");

// api/src/rows.ts chapter-0 guard echoes the caller's own unbounded `ref_raw`
// into `message`. This string is persisted to IndexedDB and rendered in a
// wrapping panel, so it must be capped rather than allowed to push the rest of
// the failed list off screen.
const huge = serverRefusalReason({ error: "invalid_body", message: "x".repeat(5000) });
check(huge.length === 200, "an unbounded server message is capped at 200 chars");
check(huge.endsWith("…"), "the capped message is visibly elided");
const exact200 = serverRefusalReason({ error: "invalid_body", message: "y".repeat(200) });
check(exact200 === "y".repeat(200), "a message exactly at the cap is left intact");

// --- reasonForOp: what actually lands on the op record ---
// This is the exact rule drainPass writes op.lastErrorReason from, so these
// assertions are the "the reason survives to the op record" guarantee minus
// the IndexedDB round-trip (which is not unit-testable without a browser).

check(
  reasonForOp({ kind: "fatal", reason: "http 400", serverReason: "empty_verse_objects" }) ===
    "empty_verse_objects",
  "a refusal carries the server reason onto the op",
);
check(
  reasonForOp({ kind: "fatal", reason: "http 400" }) === undefined,
  "a refusal with no server explanation leaves the field empty",
);
// Every non-fatal outcome must CLEAR the field — otherwise a reason from an
// earlier attempt would still be on screen after the op failed for another
// cause, or while it is merely retrying.
for (const kind of ["ok", "retry", "conflict", "locked"]) {
  check(
    reasonForOp({ kind, serverReason: "stale_from_last_time" }) === undefined,
    `a "${kind}" result clears any reason left from an earlier attempt`,
  );
}

// --- explainRefusal: code → sentence a translator can act on ---

check(
  explainRefusal("empty_verse_objects") === "The server will not save a completely empty verse.",
  "known code becomes a plain sentence",
);
check(
  explainRefusal("source_text_is_read_only") === "Hebrew and Greek source texts cannot be edited.",
  "read-only source gets its own sentence",
);

// `code: detail` — the detail is the half that says WHICH case you are in, so
// it is kept in parentheses rather than dropped.
check(
  explainRefusal("book_locked: published in v86") ===
    "This book is locked for editing, so the change was not saved. (published in v86)",
  "book_locked keeps its lock note alongside the sentence",
);
check(
  explainRefusal("unexpected_alignment_loss: the, LORD") ===
    "Saving this would have dropped word alignments your edit did not touch. (the, LORD)",
  "alignment-loss keeps the sample of words at risk",
);
check(
  explainRefusal("book_locked") ===
    "This book is locked for editing, so the change was not saved.",
  "a bare code with no detail gets the sentence alone",
);

// Server prose passes straight through — it is already a finished sentence.
const tabMsg = "Field 'quote' contains a raw TAB character, which is not allowed.";
check(explainRefusal(tabMsg) === tabMsg, "server prose is shown verbatim");

// An unmapped code is still better than "http 400": it keeps a support
// conversation possible without a `wrangler tail`.
check(
  explainRefusal("some_future_guard") === "some_future_guard",
  "an unmapped code falls back to the raw string rather than vanishing",
);
check(explainRefusal(undefined) === undefined, "no reason → nothing to explain");
check(explainRefusal("") === undefined, "empty reason → nothing to explain");

// --- willRetryOnItsOwn: refused vs merely stalled ---
// Ops reach `failed` by exactly two routes in drainPass. Only the retry-cap
// route is revived by reviveMaxAttemptsFailed, so the sentinel alone separates
// "will come back on its own" from "the server said no".

check(
  willRetryOnItsOwn("max_attempts_exceeded") === true,
  "a retry-cap failure is presented as still trying",
);
// The sentinel is exported so outbox.ts stamps it and reviveMaxAttemptsFailed
// filters on this same predicate. If they ever drift, the UI would promise a
// retry for ops nothing revives — pin the literal here.
check(
  MAX_ATTEMPTS_SENTINEL === "max_attempts_exceeded",
  "the exported sentinel is the literal the outbox stamps",
);
check(
  willRetryOnItsOwn(MAX_ATTEMPTS_SENTINEL) === true,
  "the predicate and the exported sentinel agree",
);
check(willRetryOnItsOwn("http 400") === false, "a refusal is presented as permanent");
check(
  willRetryOnItsOwn("unexpected_alignment_loss: the") === false,
  "an alignment-loss refusal is permanent",
);
check(willRetryOnItsOwn(undefined) === false, "no sentinel → treated as a refusal");

// --- dropGuardAllows: the destructive guard, re-judged at delete time ---
//
// THE REGRESSION THIS EXISTS FOR. Tab A opens "discard N refused changes".
// Tab B retries one of those ops; it exhausts the cap and re-parks as failed
// with the max-attempts sentinel — i.e. it is now in the will-retry class that
// this panel labels "not saved yet, it will try again". Cross-tab writes never
// reach Tab A's subscription, so Tab A still believes it is a refusal. If the
// delete only checked `status === "failed"` it would destroy that edit, because
// BOTH classes are `failed`. The guard must re-read and re-judge.

const refusedRecord = { status: "failed", lastError: "http 400" };
const willRetryRecord = { status: "failed", lastError: MAX_ATTEMPTS_SENTINEL };

check(
  dropGuardAllows(refusedRecord, { onlyIfStatus: "failed", onlyIfRefused: true }) === true,
  "a still-refused op is discarded by the refused-discard flow",
);
check(
  dropGuardAllows(willRetryRecord, { onlyIfStatus: "failed", onlyIfRefused: true }) === false,
  "REGRESSION: an op that became will-retry since the dialog opened SURVIVES the refused-discard",
);
check(
  dropGuardAllows(willRetryRecord, { onlyIfStatus: "failed", onlyIfRefused: false }) === true,
  "a will-retry op is still discardable when that is the class the user was shown",
);
check(
  dropGuardAllows(refusedRecord, { onlyIfStatus: "failed", onlyIfRefused: false }) === false,
  "the mirror case: an op that became a refusal survives a will-retry discard",
);

// The pre-existing guarantees must survive the new option.
check(
  dropGuardAllows({ status: "in_flight", lastError: "http 400" }, undefined) === false,
  "an in-flight op is never dropped — a request is already on the wire",
);
check(
  dropGuardAllows(
    { status: "in_flight", lastError: "http 400" },
    { onlyIfStatus: "failed", onlyIfRefused: true },
  ) === false,
  "in_flight outranks every other option",
);
check(
  dropGuardAllows({ status: "pending" }, { onlyIfStatus: "conflict" }) === false,
  "a conflict re-armed to pending by another tab is not dropped",
);
check(
  dropGuardAllows({ status: "conflict" }, { onlyIfStatus: "conflict" }) === true,
  "a still-conflicted op is dropped by the unresolvable-conflict flow",
);
check(
  dropGuardAllows({ status: "failed", lastError: "http 400" }, undefined) === true,
  "with no options the guard allows the drop (unconditional callers unchanged)",
);
// A record predating lastErrorReason/sentinel bookkeeping: undefined lastError
// classifies as a refusal, so it is reachable by the refused-discard flow
// rather than becoming undeletable.
check(
  dropGuardAllows({ status: "failed" }, { onlyIfStatus: "failed", onlyIfRefused: true }) === true,
  "a legacy failed record with no lastError is still discardable as a refusal",
);

console.log(`\nrefusalReason: ${passed} checks passed`);

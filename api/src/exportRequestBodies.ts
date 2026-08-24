// Request-body schemas for the two routes that can push a LOCKED book to Door43:
// POST /api/exports/run (exports.ts) and POST /api/books/:book/lock/push
// (bookImport.ts). Pure — zod only, no Hono, no Env — so the strictness below is
// unit-testable without a route harness. Same separation as lockPushExportParams
// and prunableBranches in export.ts.
//
// WHY .strict() IS THE POINT OF THIS FILE. Both bodies carry `branchName`, which
// is what turns a push into "stage for review" instead of "publish straight to
// master, auto-merged by DCS". zod's default is to STRIP unknown keys, so
// `{"branch_name": "..."}` or a plural `{"branchNames": "..."}` would parse
// clean, lose the key, and publish unreviewed — while the caller who typed it
// believed they had asked for review, and got a 200 saying so.
//
// That is the same consequence the explicit `invalid_branch_name` 400 exists to
// prevent, so it fails the same way instead of failing open. It matters most on
// /exports/run, because that is the route the docs hand people for a one-off
// curl, which is exactly where a key gets misspelled.
import { z } from "zod";

export const RunExportBody = z
  .object({
    book: z.string().min(1).max(8).optional(),
    resource: z.enum(["tn", "tq", "twl", "ult", "ust"]).optional(),
    dryDcs: z.boolean().optional(),
    // Opt-in to the post-export validate-and-merge orchestrator. Defaults
    // unset (= false) so a manual single-book test export doesn't trigger
    // the real auto-merge workflow on DCS. The 06:00 UTC cron passes true.
    validateAndMerge: z.boolean().optional(),
    // Override the TSV shrink guard for a verified-intentional bulk deletion.
    // Requires book + resource to be set; the workflow ignores it otherwise.
    allowShrink: z.boolean().optional(),
    // FIX H: override reimportSyncGate.ts's systemic-merge-refusal gate for a
    // book+resource a human has verified by hand — same requirement as
    // allowShrink (book + resource both set); the workflow ignores it otherwise.
    allowMergeRefusal: z.boolean().optional(),
    // Issue #473 option A: override reimportSyncGate.ts's conflict_skipped /
    // tombstone_blocked watermark withhold for a book+resource whose ID
    // collision a human has verified is a genuine reissue, not a pending
    // delete. Same requirement as allowShrink/allowMergeRefusal (book +
    // resource both set); the workflow ignores it otherwise. Unlike those two,
    // this does not just resume a stalled sync — it consents to Door43 losing
    // the blocked row(s) on the next export (see raiseTombstoneBlockAlert).
    allowIdBlocked: z.boolean().optional(),
    // Override the book-lock gate for a deliberate fix to a frozen (published or
    // explicitly locked) book. Requires book + resource to be set; the workflow
    // ignores it otherwise.
    allowLocked: z.boolean().optional(),
    // Explicit branch name, for a locked-book correction a uW maintainer must
    // review and merge by hand rather than DCS's merge bot doing it. Requires
    // book + resource, and must not contain `-be-` (that substring is what makes
    // DCS auto-merge, which is the thing this override exists to avoid). See
    // branchOverrideAllowed in export.ts.
    branchName: z.string().min(1).max(80).optional(),
    // #581: explicit, auditable acknowledgement that an allowLocked export
    // against a locked/published book WILL be auto-merged into master by DCS's
    // own merge-be-pr.yaml, because no branchName was given. Without either
    // this or branchName, such a request 400s — see autoMergeConfirmationRequired
    // in publishedGuard.ts. Ignored for an unlocked book.
    allowAutoMerge: z.boolean().optional(),
  })
  .strict();

export const LockPushBody = z
  .object({
    branchName: z.string().min(1).max(80).optional(),
  })
  .strict();

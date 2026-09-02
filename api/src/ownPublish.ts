// Recognize "master moved because OUR export merged" — as distinct from "a
// human edited master out of band."
//
// THE INCIDENT (prod forensics, 2026-08-14). verseMerge.ts's three-way merge
// attributes a D1-vs-master difference by comparing both sides against an
// ancestor recovered as of book_resource_syncs.master_confirmed_at (migration
// 0045). That watermark is stamped from exactly one observation:
// export.ts's isMasterConfirmed, which is true ONLY when commitToDcs's
// pre-check found master ALREADY byte-identical to our render (`branchTouched:
// false`). Every night the export actually PUSHES a `-be-` branch, the branch
// later merges, master moves — and the watermark stays where it was. The next
// sync therefore reads `theirs != base`, a condition whose whole purpose is to
// detect a FOREIGN commit on master, for content that is our own; every verse
// a translator edited in the app since then lands on computeVerseMerge's step 6
// (`adopt_conflict`, master wins) and the app edit is silently overwritten.
// AMO ch2 edits from 2026-08-13 were reverted at 2026-08-14 01:07 UTC this way
// (AMO/2/16/ULT reverted byte-identically to the previously published text);
// 168 adopt_conflicts landed across the fleet in two days.
//
// THE RECOGNITION. When master's current file bytes are EXACTLY the bytes we
// last handed to Door43 for this (book, resource), master's movement is the
// merge of our own export and nothing else. There is then no foreign edit to
// adjudicate, so the watermark is advanced to the D1-read time of that render.
//
// What the caller does NEXT is its own decision, and the two callers differ on
// purpose (see bookReimport.ts):
//   - the nightly cron also SKIPS the resource's row work — master holds our own
//     render, so there is nothing to import, and skipping is what actually leaves
//     a translator's edit untouched;
//   - the user/admin "Pull from Door43" route only advances the watermark and
//     then imports as usual, because a human explicitly asked to pull master and
//     silently doing nothing would both ignore that request and disable the
//     restore-from-master repair route.
//
// WHY BYTES, NOT COMMIT METADATA. The merged `-be-` PR lands on master as a
// squashed commit authored by DCS's validate-and-merge Action, so neither the
// author nor the message is a dependable identity for our content (and both
// are attacker/automation-shaped strings, not evidence). The rendered bytes
// are. Comparison is on a git blob SHA — sha1 over `blob <bytelen>\0` + the
// UTF-8 bytes — which is exact-bytes identity, is what `git hash-object`
// produces, and is what Gitea reports as a file's `sha`, so a prod
// disagreement can be diagnosed with one shell command.
//
// FAIL-SAFE DIRECTION. Recognition can only ever DECLINE (fall back to the
// pre-existing merge). It has no way to manufacture a false "this is ours":
// the only input that returns `recognized` is a full-file byte match against a
// hash we ourselves recorded at push time. A foreign commit layered on top of
// our merge, a partial merge, a maintainer's hand edit, a re-encoded file — all
// change the bytes, all decline, all get the normal three-way merge, which is
// exactly the behavior that is correct for them.
//
// Pure (no D1, no network) so it's regression-testable without a Workflow
// context — same convention as verseMerge.ts, shrinkGuard.ts and
// reimportSyncGate.ts. See ownPublish.test.mjs, which reproduces the AMOS
// timeline end to end and asserts BOTH the pre-fix `adopt_conflict` and the
// post-fix "app edit kept".

// Git blob SHA of a string's UTF-8 bytes: sha1("blob " + byteLength + "\0" +
// bytes), lowercase hex. Identical to `git hash-object <file>` and to the `sha`
// Gitea returns for a file from its contents API.
//
// BOM ASYMMETRY, acknowledged rather than handled: the sync hashes a STRING that
// `fetchText` produced with `new TextDecoder("utf-8")`, which strips a leading BOM,
// while the export hashes its render directly. So a BOM'd file on master would
// re-encode a few bytes short of git's view and decline recognition. That is the
// fail-safe direction (decline → the normal merge), our own renders never emit a
// BOM, and unfoldingWord's USFM/TSV files don't carry one — so this is a note for
// whoever debugs an unexplained permanent decline, not a bug to pre-emptively fix.
//
// SHA-1 is used because that is the hash git itself uses for object identity —
// this is a content-identity check against a value git/Gitea produced, NOT a
// security boundary, so SHA-1's collision weakness is not in play here: the
// adversary would have to be our own export renderer, and a decline is
// harmless anyway (see FAIL-SAFE DIRECTION above).
export async function gitBlobSha(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// gitBlobSha, but a failure becomes `null` (the `master_blob_unknown` decline)
// instead of an exception. This is what the SYNC must use, and the distinction is
// not academic: the sync hashes master inside `planAndStageBookResources`, which
// runs in a retried Workflow step, and on the user path inside a request handler.
// An unguarded throw there would burn both retries and fail the whole book's
// sync, or 500 a "Pull from Door43" — strictly worse outcomes than the merge this
// recognition exists to avoid. Declining just runs the pre-existing merge.
// (Reachable throws are unlikely but real: `crypto.subtle` unavailable, a digest
// OperationError, an allocation failure on a very large file.)
export async function gitBlobShaOrNull(content: string): Promise<string | null> {
  try {
    return await gitBlobSha(content);
  } catch (e) {
    console.error("gitBlobSha failed; own-publish recognition will decline", {
      bytes: content.length,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export interface OwnPublishInput {
  /** Git blob SHA of master's CURRENT file bytes, or null when unhashable. */
  masterBlobSha: string | null;
  /** book_resource_syncs.pushed_blob_sha — the render we last pushed. */
  pushedBlobSha: string | null;
  /** book_resource_syncs.pushed_read_at — that render's D1-read time. */
  pushedReadAt: number | null;
}

// Discriminated on `recognized` so a caller that checks it gets `readAt: number`
// with no cast — the timestamp and the verdict cannot drift apart, and there is
// no shape in which a caller can read a watermark out of a decline.
export type OwnPublishResult =
  | {
      recognized: true;
      /**
       * The timestamp to stamp as master_confirmed_at: the render's D1-READ
       * time, so any app edit made after it is correctly dated AFTER the
       * watermark rather than folded into the merge ancestor.
       */
      readAt: number;
      reason: "own_publish";
    }
  | {
      recognized: false;
      readAt: null;
      /** Short stable machine reason, safe to log. */
      reason: "no_pushed_render" | "master_blob_unknown" | "content_differs" | "no_pushed_read_at";
    };

// The decision. Every "no" is a distinct, nameable reason so a prod log can say
// which one fired rather than just "didn't match".
export function recognizeOwnPublish(input: OwnPublishInput): OwnPublishResult {
  const { masterBlobSha, pushedBlobSha, pushedReadAt } = input;

  // Warm-up: no export has recorded a render for this (book, resource) yet
  // (migration 0048 does not backfill). Inert, exactly like 0045's NULL
  // master_confirmed_at — never treat "not yet measured" as "converged".
  if (!pushedBlobSha) {
    return { recognized: false, readAt: null, reason: "no_pushed_render" };
  }

  // Master's bytes weren't hashable (fetch returned nothing / hashing threw).
  // Absent measurement is not evidence — decline.
  if (!masterBlobSha) {
    return { recognized: false, readAt: null, reason: "master_blob_unknown" };
  }

  // The ordinary "master genuinely differs from what we published" case: a
  // foreign commit, a partial merge, or our branch simply hasn't merged yet.
  if (masterBlobSha !== pushedBlobSha) {
    return { recognized: false, readAt: null, reason: "content_differs" };
  }

  // Bytes match but we have no read time to stamp. Should be impossible (both
  // columns are written together by recordPushedRender), so it means the row
  // was written by something else or half-written. Decline rather than invent a
  // timestamp: a watermark stamped at the wrong time is the failure mode this
  // whole module exists to fix, and `Date.now()` here would be strictly worse
  // than the status quo — it would date the ancestor cutoff AFTER app edits
  // that master never received.
  if (pushedReadAt == null) {
    return { recognized: false, readAt: null, reason: "no_pushed_read_at" };
  }

  return { recognized: true, readAt: pushedReadAt, reason: "own_publish" };
}

// ---------------------------------------------------------------------------
// Attributing a `content_differs` decline.
//
// A decline says master's bytes are not the render we last pushed. Two things
// produce that, and the byte comparison alone cannot tell them apart:
//   (a) somebody else committed to the file after our push landed — an editor,
//       or the bp-assistant pipeline's evening pushes (measured on prod
//       2026-09-02: en_tq's tq_JER.tsv had a bot commit between every one of
//       our nightly merges for a week, which is what tripped the inert banner);
//   (b) Door43's validate-and-merge job rewrote our bytes when it merged, so
//       master never reads as our own render — the one way recognition can be
//       quietly inert while the nightly reverts continue.
// The question is answered DIRECTLY, not inferred from who committed last: find
// the merge of the render we pushed — the newest `ours` commit on master dated
// at or after the render's D1 read — and read the file's blob sha AT THAT
// COMMIT (dcsSources.ts fileBlobShaAtCommit, one tree read). Equal to the blob
// we pushed: the merge preserved our bytes, and tonight's mismatch is whatever
// landed after it (a), which the walk names. Different: the merge changed our
// bytes (b), measured even when a bot pushed on top afterwards — a cold review
// of the first draft showed that inferring from the newest commit alone let an
// interleaved bot push reset a real rewrite's count and hide it. No `ours`
// commit dated after the read: tonight's `-be-` branch has not merged yet,
// which is a normal state and measures nothing. Two pure steps so both have
// unit tests; bookReimport.ts owns the fetches, the counter and the banner.
//
// Measured against git.door43.org 2026-09-02, five recent `bible-editor:` PRs
// across three books: the PR head's blob sha equalled master's blob sha at the
// squash commit every time — so (b) is not happening today. This code exists
// so that, the day it does, the banner says so from evidence instead of
// listing both explanations and asking a human to run `git hash-object`.

/** The structural subset of masterLineage.ts's ClassifiedCommit this reads. */
export interface OwnPublishDeclineCommit {
  sha: string;
  kind: "ours" | "ai" | "human";
  /** commit.author.date, ISO-8601. */
  date?: string | null;
  authorName?: string | null;
}

export type OurMergeAfterRead =
  | { found: true; commit: OwnPublishDeclineCommit }
  | { found: false; reason: "no_commits" | "no_pushed_read_at" | "no_commit_date" | "merge_pending" };

// Step 1 (pure): which commit merged the render we pushed? `commits` is the
// walk, newest-first, over a window that starts at or before the render read
// (master_confirmed_at is always older than pushed_read_at; a dedicated walk
// from pushed_read_at is used when there is no watermark yet).
//
// Measured 2026-09-02 on en_tq #864: a Gitea squash commit's author date is the
// merge time itself (05:42:19Z, for a -be- branch committed 05:41:14Z), and
// both sit AFTER recordPushedRender's D1 read of that render. So the newest
// `ours` commit dated >= the read is tonight's merge; an `ours` commit dated
// before it is an earlier night's, and if that is all there is, tonight's
// branch is still waiting to merge.
export function findOurMergeAfterRead(
  commits: readonly OwnPublishDeclineCommit[],
  pushedReadAt: number | null,
): OurMergeAfterRead {
  if (commits.length === 0) return { found: false, reason: "no_commits" };
  if (pushedReadAt == null) return { found: false, reason: "no_pushed_read_at" };
  let undatedOurs = 0;
  for (const c of commits) {
    if (c.kind !== "ours") continue;
    const at = c.date ? Date.parse(c.date) : NaN;
    if (!Number.isFinite(at)) {
      undatedOurs++;
      continue;
    }
    if (at / 1000 >= pushedReadAt) return { found: true, commit: c };
  }
  // An undated `ours` commit cannot be placed relative to the read, so "pending"
  // would be a guess; say what was actually missing.
  return { found: false, reason: undatedOurs > 0 ? "no_commit_date" : "merge_pending" };
}

export type OwnPublishDeclineVerdict =
  | {
      /** The merge landed the bytes we pushed; whatever is newest on master now came after it. */
      verdict: "preserved";
      mergeSha: string;
      mergeDate: string | null;
      /** Master's newest commit — the cause of tonight's byte mismatch — when it is not that merge. */
      newest: { kind: "ai" | "human" | "ours"; sha: string; author: string | null; date: string | null } | null;
    }
  | {
      /** The merge of our push holds bytes other than the ones we pushed. */
      verdict: "rewritten";
      mergeSha: string;
      mergeDate: string | null;
      mergedBlobSha: string;
    }
  | {
      verdict: "unmeasured";
      reason: "no_commits" | "no_pushed_read_at" | "no_commit_date" | "merge_pending" | "merge_blob_unknown";
    };

// Step 2 (pure): the verdict, given step 1's answer and the blob sha the caller
// read at that merge commit (`null` when the read failed — absence is not a
// match, and not a mismatch either).
export function judgeOwnPublishDecline(input: {
  ourMerge: OurMergeAfterRead;
  mergedBlobSha: string | null;
  pushedBlobSha: string;
  /** The walk's newest commit, for naming what landed after a preserved merge. */
  newest: OwnPublishDeclineCommit | null | undefined;
}): OwnPublishDeclineVerdict {
  const { ourMerge, mergedBlobSha, pushedBlobSha, newest } = input;
  if (!ourMerge.found) return { verdict: "unmeasured", reason: ourMerge.reason };
  if (!mergedBlobSha) return { verdict: "unmeasured", reason: "merge_blob_unknown" };
  const { commit } = ourMerge;
  if (mergedBlobSha !== pushedBlobSha) {
    return { verdict: "rewritten", mergeSha: commit.sha, mergeDate: commit.date ?? null, mergedBlobSha };
  }
  return {
    verdict: "preserved",
    mergeSha: commit.sha,
    mergeDate: commit.date ?? null,
    newest:
      newest && newest.sha !== commit.sha
        ? { kind: newest.kind, sha: newest.sha, author: newest.authorName ?? null, date: newest.date ?? null }
        : null,
  };
}

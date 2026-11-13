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

import { completeParentList } from "./masterLineage.ts";

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
// the merge of the render we pushed — the `ours` commit on master whose subject
// carries our export PR's number, `(#N)`, which Gitea appends on a squash merge
// (measured: `bible-editor: JER tq → master (#864)`) — and read the file's blob
// sha AT THAT COMMIT (dcsSources.ts fileBlobShaAtCommit, one tree read). Equal
// to the blob we pushed: the merge preserved our bytes, and tonight's mismatch
// is whatever landed after it (a), which the walk names. Different: the merge
// changed our bytes (b), measured even when a bot pushed on top afterwards — a
// cold review of the first draft showed that inferring from the newest commit
// alone let an interleaved bot push reset a real rewrite's count and hide it.
// No commit with that PR number: tonight's `-be-` branch has not merged yet,
// which is a normal state and measures nothing. Matching by PR number rather
// than by date (the second draft) is what keeps two overlapping exports of the
// same pair apart: export A's merge landing after export B's render was read
// would otherwise be compared against B's blob and read as a rewrite (Codex
// review on PR #704). Two pure steps so both have unit tests; bookReimport.ts
// owns the fetches, the counter and the banner.
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

export type OurMergeMatch =
  | { found: true; commit: OwnPublishDeclineCommit }
  | { found: false; reason: "no_commits" | "no_pr_number" | "merge_pending" };

// Step 1 (pure): which commit merged the render we pushed? `commits` is the
// walk, newest-first, over a window that starts at or before the render read
// (master_confirmed_at is always older than pushed_read_at; a dedicated walk
// from pushed_read_at is used when there is no watermark yet). `prNumber` is
// the export PR opened for that render (book_resource_syncs.pushed_pr_number,
// stamped by the export onto the pushed render itself and guarded on its read
// time; null when PR creation failed or nothing is recorded).
//
// Gitea's squash merge titles the master commit `<PR title> (#N)` — measured on
// every `bible-editor:` merge in en_tq's history — and only `ours` commits are
// eligible, so a human `Revert "bible-editor: … (#N)"` (classified human) can
// never be taken for the merge itself.
export function findOurMergeForPr(
  commits: readonly (OwnPublishDeclineCommit & { message?: string | null })[],
  prNumber: number | null,
): OurMergeMatch {
  if (commits.length === 0) return { found: false, reason: "no_commits" };
  if (prNumber == null || !Number.isInteger(prNumber) || prNumber <= 0) return { found: false, reason: "no_pr_number" };
  const tag = `(#${prNumber})`;
  for (const c of commits) {
    if (c.kind !== "ours") continue;
    const subject = (c.message ?? "").split("\n", 1)[0];
    if (subject.includes(tag)) return { found: true, commit: c };
  }
  return { found: false, reason: "merge_pending" };
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
      reason: "no_commits" | "no_pr_number" | "merge_pending" | "merge_blob_unknown";
    };

// Step 2 (pure): the verdict, given step 1's answer and the blob sha the caller
// read at that merge commit (`null` when the read failed — absence is not a
// match, and not a mismatch either).
export function judgeOwnPublishDecline(input: {
  ourMerge: OurMergeMatch;
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

// Step 3 (#1349): may a PRESERVED merge's render be stamped as master's
// ancestor? Until #1349 any human commit anywhere in the walk withheld the
// stamp, so a maintainer committing after our merge froze the watermark on the
// export before it. The next sync then judged both sides against that older
// render: an app edit we had already published read as "D1 changed", the
// maintainer's later fix as "master unchanged", and the merge reverted his fix
// (2CH twl av3p, 2026-11-12) or dropped a newer app edit (EZK tn x7oy).
//
// TWO RULES, chosen by whether the walk holds a human commit.
//
// 1. No human commit anywhere in the walk: the rule #658 shipped with. The
//    stamp stands on the walk alone and no ancestry is read, so a bot pushing
//    on top of our merge never costs a Door43 read or hits a cap.
//
// 2. At least one human commit: strict proof, one kind of evidence. A sha is
//    PROVEN when its parent list is complete and well formed and every parent
//    is already proven; our merge is the only seed. Parents come from the walk
//    (only when its parser saw a complete list), then from the ledger's
//    repo-wide parents, then from one Door43 lookup per sha (`readParents`).
//    A malformed, empty or missing list from any source is unknown and
//    withholds. A commit's history LISTING reaching our merge is never used: it
//    shows our merge is AN ancestor, never that the commit's other ancestry is
//    clean (review: a single-parent commit over an unwalked merge of our merge
//    and a side line). Then:
//    - every human commit BELOW our merge withholds. It may have landed between
//      our render read and our merge, and Door43 gives no push time to rule
//      that out: a committer date does not move on a late push or on a PR
//      merge of an older commit;
//    - every commit ABOVE our merge, of any kind, must be proven. A parent that
//      is a known ancestor of our merge (in the walk below it, or on our
//      merge's own parent chain) is not a descendant, so the proof fails there
//      without spending reads;
//    - every non-human commit BELOW our merge must be on our merge's parent
//      chain (a bot commit on a side branch older than our merge, joined by a
//      merge the path walk does not show, is not).
//    Every Door43 lookup counts toward `maxReads`; past it the stamp is
//    withheld. On the live path the below-merge check walks every repo commit
//    between the previous export and ours, one lookup each (2CH twl 11-12: 11
//    commits to other books), so a busy repo or a long-frozen watermark
//    exceeds the cap there; the ledger's repo-wide parents make that free.
export type LineageStampAncestry =
  | { ok: true; ancestryReads: number }
  | {
      ok: false;
      reason:
        | "merge_not_in_walk"
        | "human_before_merge"
        | "parents_unknown"
        | "not_descendant"
        | "below_merge_unproven"
        | "read_failed"
        | "read_cap";
      sha: string | null;
      ancestryReads: number;
    };

export interface LineageStampCommit {
  sha: string;
  kind: "ours" | "ai" | "human";
  allParentShas?: string[];
  parentsCheck?: "complete" | "malformed";
}

type ParentsFailure = "parents_unknown" | "read_failed" | "read_cap";

export async function judgeLineageStampAncestry(
  commits: readonly LineageStampCommit[],
  mergeSha: string,
  opts: {
    /** The ledger's parents for every repo commit in its window; null = malformed. */
    repoParents?: ReadonlyMap<string, readonly string[] | null>;
    /** Every parent of one commit, from Door43; null when the read failed. */
    readParents: (sha: string) => Promise<string[] | null>;
    maxReads: number;
  },
): Promise<LineageStampAncestry> {
  // Rule 1.
  if (!commits.some((c) => c.kind === "human")) return { ok: true, ancestryReads: 0 };

  // Rule 2.
  const mergeIdx = commits.findIndex((c) => c.sha === mergeSha);
  if (mergeIdx < 0) return { ok: false, reason: "merge_not_in_walk", sha: null, ancestryReads: 0 };
  const below = commits.slice(mergeIdx + 1);
  const humanBelow = below.find((c) => c.kind === "human");
  if (humanBelow) return { ok: false, reason: "human_before_merge", sha: humanBelow.sha, ancestryReads: 0 };

  const walkBySha = new Map(commits.map((c) => [c.sha, c]));
  const known = new Map<string, string[]>();
  let reads = 0;
  // Parents of one sha, or why they are unknown. `free` refuses to spend a
  // Door43 read (returns null when one would be needed).
  const parentsOf = async (sha: string, free = false): Promise<string[] | ParentsFailure | null> => {
    const cached = known.get(sha);
    if (cached) return cached;
    let list: string[] | null = null;
    const w = walkBySha.get(sha);
    if (w?.parentsCheck === "malformed") return "parents_unknown";
    if (w?.parentsCheck === "complete") list = completeParentList(w.allParentShas);
    if ((list == null || list.length === 0) && opts.repoParents?.has(sha)) {
      const stored = opts.repoParents.get(sha);
      if (stored == null) return "parents_unknown";
      list = completeParentList(stored);
      if (list == null) return "parents_unknown";
    }
    if (list == null || list.length === 0) {
      if (free) return null;
      if (reads >= opts.maxReads) return "read_cap";
      reads++;
      const read = await opts.readParents(sha);
      if (read == null) return "read_failed";
      list = completeParentList(read);
    }
    // No commit after our render read is a root, so an empty list is unknown.
    if (list == null || list.length === 0) return "parents_unknown";
    known.set(sha, list);
    return list;
  };
  const fail = (reason: Exclude<LineageStampAncestry, { ok: true }>["reason"], sha: string | null): LineageStampAncestry =>
    ({ ok: false, reason, sha, ancestryReads: reads });

  // Our merge's ancestors reachable without a read. None of them descends
  // from our merge, and neither (for this proof) does a commit below it in the
  // walk, so a proof that reaches one fails at once.
  const freeAncestors = new Set<string>();
  {
    const queue = [mergeSha];
    for (let q = 0; q < queue.length; q++) {
      const ps = await parentsOf(queue[q], true);
      if (!Array.isArray(ps)) continue;
      for (const p of ps) {
        if (freeAncestors.has(p)) continue;
        freeAncestors.add(p);
        queue.push(p);
      }
    }
  }
  const notDescendant = new Set([...freeAncestors, ...below.map((c) => c.sha)]);

  // Above our merge: prove each commit, oldest first, depth-first through its
  // parents. `proven.add` below is the only place a sha becomes proven.
  const proven = new Set([mergeSha]);
  const expanded = new Set<string>();
  for (let i = mergeIdx - 1; i >= 0; i--) {
    const stack = [commits[i].sha];
    while (stack.length > 0) {
      const sha = stack[stack.length - 1];
      if (proven.has(sha)) {
        stack.pop();
        continue;
      }
      if (notDescendant.has(sha)) return fail("not_descendant", sha);
      const ps = await parentsOf(sha);
      if (!Array.isArray(ps)) return fail(ps ?? "parents_unknown", sha);
      const pending = ps.filter((p) => !proven.has(p));
      if (pending.length === 0) {
        proven.add(sha);
        stack.pop();
        continue;
      }
      // Seen before with a parent still unproven: only a cycle does that.
      if (expanded.has(sha)) return fail("parents_unknown", sha);
      expanded.add(sha);
      stack.push(...pending);
    }
  }

  // Below our merge (every commit there is non-human by now): each must be on
  // our merge's parent chain. Breadth-first from our merge until all are found.
  const targets = new Set(below.map((c) => c.sha).filter((sha) => !freeAncestors.has(sha)));
  const queue = [mergeSha];
  const seen = new Set(queue);
  for (let q = 0; q < queue.length && targets.size > 0; q++) {
    const ps = await parentsOf(queue[q]);
    if (!Array.isArray(ps)) return fail("below_merge_unproven", queue[q]);
    for (const p of ps) {
      targets.delete(p);
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  if (targets.size > 0) return fail("below_merge_unproven", [...targets][0]);
  return { ok: true, ancestryReads: reads };
}

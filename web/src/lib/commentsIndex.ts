// Pure grouping of flat CommentDto rows into threads, keyed by verse or by
// tn/tq/twl row. No React, no fetching — see useComments.ts for the hook that
// wraps this with data. See api/migrations/0037_comments.sql for the schema
// rationale (why replies are flat and anchors are denormalized).

import type { CommentDto, CommentRowKind } from "../sync/api";

export interface CommentThread {
  root: CommentDto;
  replies: CommentDto[];
  // True when this thread was originally anchored to a tn/tq/twl row that no
  // longer exists (the row was deleted/replaced, typically by an AI
  // regeneration) and has floated down to the verse level as a fallback. See
  // issue #818: without this, a comment on a swept row becomes permanently
  // invisible — nothing renders a card for a row id nobody holds anymore.
  orphaned?: boolean;
}

export interface CommentsIndex {
  threadsByVerse: Map<number, CommentThread[]>; // verse-anchored only (rowKind === null), plus orphaned row threads
  threadsByRow: Map<string, CommentThread[]>; // key = `${rowKind}:${rowId}`
  byId: Map<number, CommentDto>;
}

export function rowKey(rowKind: CommentRowKind, rowId: string): string {
  return `${rowKind}:${rowId}`;
}

// What indexComments needs to know about the chapter's CURRENT rows to tell a
// live row-anchored comment from an orphaned one (#818). Optional: omitting it
// (e.g. existing callers/tests) disables orphan detection entirely and every
// row-anchored root indexes under its own rowId exactly as before.
export interface LiveRows {
  // `${rowKind}:${rowId}` for every tn/tq/twl row currently in the chapter.
  rowIds: Set<string>;
  // id of the chapter's current chapter-intro tn row (verse 0), if any. There
  // is exactly one per chapter, so any tn/verse=0 comment is redirected here
  // regardless of which (possibly since-deleted) intro row it was created
  // against — the intro is a "there's only ever one of these" anchor.
  introRowId: string | null;
}

export function indexComments(list: CommentDto[], liveRows?: LiveRows): CommentsIndex {
  const live = list.filter((c) => c.deletedAt == null);
  const byId = new Map<number, CommentDto>();
  for (const c of live) byId.set(c.id, c);

  // Group replies under their root; drop orphans (missing/deleted root).
  const repliesByRoot = new Map<number, CommentDto[]>();
  const roots: CommentDto[] = [];
  for (const c of live) {
    if (c.parentId == null) {
      roots.push(c);
      continue;
    }
    if (!byId.has(c.parentId)) continue; // orphan guard
    const arr = repliesByRoot.get(c.parentId);
    if (arr) arr.push(c);
    else repliesByRoot.set(c.parentId, [c]);
  }

  // createdAt is unix *seconds*, so same-second creations are common — tiebreak
  // on id for a deterministic order.
  roots.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  for (const replies of repliesByRoot.values()) {
    replies.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  const threadsByVerse = new Map<number, CommentThread[]>();
  const threadsByRow = new Map<string, CommentThread[]>();

  const pushByVerse = (verse: number, thread: CommentThread) => {
    const arr = threadsByVerse.get(verse);
    if (arr) arr.push(thread);
    else threadsByVerse.set(verse, [thread]);
  };
  const pushByRow = (key: string, thread: CommentThread) => {
    const arr = threadsByRow.get(key);
    if (arr) arr.push(thread);
    else threadsByRow.set(key, [thread]);
  };

  for (const root of roots) {
    const thread: CommentThread = {
      root,
      replies: repliesByRoot.get(root.id) ?? [],
    };
    if (root.rowKind == null) {
      pushByVerse(root.verse, thread);
      continue;
    }
    // Chapter intro: always land on whichever tn row is the CURRENT intro for
    // this chapter, not the (possibly stale) rowId the comment was created
    // against. See LiveRows.introRowId.
    if (root.rowKind === "tn" && root.verse === 0 && liveRows?.introRowId) {
      pushByRow(rowKey("tn", liveRows.introRowId), thread);
      continue;
    }
    // Ordinary row-anchored comment whose row no longer exists (or, for an
    // intro comment, no intro row exists at all right now): float it to the
    // verse it was created on, flagged, rather than let it vanish.
    if (liveRows && !liveRows.rowIds.has(rowKey(root.rowKind, root.rowId!))) {
      pushByVerse(root.verse, { ...thread, orphaned: true });
      continue;
    }
    pushByRow(rowKey(root.rowKind, root.rowId!), thread);
  }

  return { threadsByVerse, threadsByRow, byId };
}

export interface CommentCounts {
  openQuestions: number;
  notes: number;
  total: number;
}

export function countThreads(threads: CommentThread[] | undefined): CommentCounts {
  if (!threads) return { openQuestions: 0, notes: 0, total: 0 };
  let openQuestions = 0;
  let notes = 0;
  for (const { root } of threads) {
    if (root.resolvedAt != null) continue; // resolved roots (question or note) don't count
    if (root.kind === "question") openQuestions++;
    else notes++;
  }
  return { openQuestions, notes, total: openQuestions + notes };
}

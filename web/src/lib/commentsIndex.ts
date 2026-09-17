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
  // id of the chapter's current chapter-intro tn row (verse 0), if any. A
  // tn/verse=0 comment whose OWN row is gone is redirected here (the intro is a
  // "there's only ever one of these" anchor); a comment on a live verse-0 row —
  // including a second intro note — keeps its own card (#824 review).
  introRowId: string | null;
}

// Where a row-anchored comment actually lands in the index, accounting for
// orphaned rows and chapter-intro relocation (#818). Shared by indexComments
// (which bucket to FILE the thread under) and Shell's deep-link handler (which
// bucket to OPEN), so an alert on a relocated comment opens the thread
// indexComments filed rather than the stale row it was created against. A null
// rowKind in the result means "verse bucket".
export function resolveCommentLocation(
  root: Pick<CommentDto, "verse" | "rowKind" | "rowId">,
  liveRows?: LiveRows,
): { verse: number; rowKind: CommentRowKind | null; rowId: string | null } {
  if (root.rowKind == null) return { verse: root.verse, rowKind: null, rowId: null };
  // Chapter intro whose OWN row is gone: land on the current intro tn row. A
  // live verse-0 row (the current intro, or a second intro note) fails this
  // guard and keeps its own card, so live secondary intro notes don't collapse
  // onto the first one (#824 review).
  if (
    root.rowKind === "tn" &&
    root.verse === 0 &&
    liveRows?.introRowId &&
    !liveRows.rowIds.has(rowKey("tn", root.rowId!))
  ) {
    return { verse: 0, rowKind: "tn", rowId: liveRows.introRowId };
  }
  // Ordinary row-anchored comment whose row no longer exists (or an intro
  // comment with no current intro row at all): float to its verse.
  if (liveRows && !liveRows.rowIds.has(rowKey(root.rowKind, root.rowId!))) {
    return { verse: root.verse, rowKind: null, rowId: null };
  }
  return { verse: root.verse, rowKind: root.rowKind, rowId: root.rowId };
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
    const loc = resolveCommentLocation(root, liveRows);
    if (loc.rowKind == null) {
      // A verse-anchored comment is not orphaned; a row-anchored comment that
      // floated here (its row is gone) is flagged so the UI can mark it.
      pushByVerse(loc.verse, root.rowKind == null ? thread : { ...thread, orphaned: true });
    } else {
      pushByRow(rowKey(loc.rowKind, loc.rowId!), thread);
    }
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

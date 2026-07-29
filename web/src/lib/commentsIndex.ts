// Pure grouping of flat CommentDto rows into threads, keyed by verse or by
// tn/tq/twl row. No React, no fetching — see useComments.ts for the hook that
// wraps this with data. See docs/plan.md "Internal Comments & Notes".

import type { CommentDto, CommentRowKind } from "../sync/api";

export interface CommentThread {
  root: CommentDto;
  replies: CommentDto[];
}

export interface CommentsIndex {
  threadsByVerse: Map<number, CommentThread[]>; // verse-anchored only (rowKind === null)
  threadsByRow: Map<string, CommentThread[]>; // key = `${rowKind}:${rowId}`
  byId: Map<number, CommentDto>;
}

export function rowKey(rowKind: CommentRowKind, rowId: string): string {
  return `${rowKind}:${rowId}`;
}

export function indexComments(list: CommentDto[]): CommentsIndex {
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

  roots.sort((a, b) => a.createdAt - b.createdAt);
  for (const replies of repliesByRoot.values()) {
    replies.sort((a, b) => a.createdAt - b.createdAt);
  }

  const threadsByVerse = new Map<number, CommentThread[]>();
  const threadsByRow = new Map<string, CommentThread[]>();

  for (const root of roots) {
    const thread: CommentThread = {
      root,
      replies: repliesByRoot.get(root.id) ?? [],
    };
    if (root.rowKind == null) {
      const arr = threadsByVerse.get(root.verse);
      if (arr) arr.push(thread);
      else threadsByVerse.set(root.verse, [thread]);
    } else {
      const key = rowKey(root.rowKind, root.rowId!);
      const arr = threadsByRow.get(key);
      if (arr) arr.push(thread);
      else threadsByRow.set(key, [thread]);
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CommentDto, type NewCommentInput } from "../sync/api";
import { indexComments, type CommentsIndex } from "../lib/commentsIndex";

// Comments for one (book, chapter). Fetched separately from useChapter (see
// docs/plan.md "Internal Comments & Notes") — a comments failure must never
// break the chapter. `enabled` mirrors useAlerts' auth-ready gate.
export function useComments(
  book: string,
  chapter: number,
  enabled: boolean,
): {
  comments: CommentDto[];
  index: CommentsIndex;
  loading: boolean;
  addComment: (input: NewCommentInput) => Promise<CommentDto | null>;
  editComment: (id: number, body: string) => Promise<void>;
  setResolved: (id: number, resolved: boolean) => Promise<void>;
  removeComment: (id: number) => Promise<void>;
  applyWsComment: (dto: CommentDto) => void;
  reload: () => void;
} {
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [loading, setLoading] = useState(false);
  // Bumping this re-runs the fetch effect (manual reload()).
  const [reloadTick, setReloadTick] = useState(0);

  // Upsert by id, sorted by (createdAt, id) so indexComments' output is
  // stable. A dto with deletedAt set drops itself and any of its replies.
  const upsert = useCallback((dto: CommentDto) => {
    setComments((prev) => {
      let next: CommentDto[];
      if (dto.deletedAt != null) {
        next = prev.filter((c) => c.id !== dto.id && c.parentId !== dto.id);
      } else {
        const idx = prev.findIndex((c) => c.id === dto.id);
        next = idx >= 0 ? prev.map((c, i) => (i === idx ? dto : c)) : [...prev, dto];
      }
      next.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await api.getComments(book, chapter);
        if (cancelled) return;
        const sorted = [...res.comments].sort(
          (a, b) => a.createdAt - b.createdAt || a.id - b.id,
        );
        setComments(sorted);
      } catch (err) {
        // Comments are non-critical — swallow rather than blocking the chapter.
        console.warn("useComments: failed to load comments", err);
        if (!cancelled) setComments([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book, chapter, enabled, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const addComment = useCallback(
    async (input: NewCommentInput): Promise<CommentDto | null> => {
      try {
        const dto = await api.createComment(input);
        upsert(dto);
        return dto;
      } catch (err) {
        console.warn("useComments: failed to create comment", err);
        return null;
      }
    },
    [upsert],
  );

  const editComment = useCallback(
    async (id: number, body: string): Promise<void> => {
      try {
        const dto = await api.updateComment(id, body);
        upsert(dto);
      } catch (err) {
        console.warn("useComments: failed to edit comment", err);
      }
    },
    [upsert],
  );

  const setResolved = useCallback(
    async (id: number, resolved: boolean): Promise<void> => {
      try {
        const dto = await api.resolveComment(id, resolved);
        upsert(dto);
      } catch (err) {
        console.warn("useComments: failed to resolve comment", err);
      }
    },
    [upsert],
  );

  const removeComment = useCallback(async (id: number): Promise<void> => {
    try {
      await api.deleteComment(id);
      setComments((prev) => prev.filter((c) => c.id !== id && c.parentId !== id));
    } catch (err) {
      console.warn("useComments: failed to delete comment", err);
    }
  }, []);

  const index = useMemo(() => indexComments(comments), [comments]);

  return {
    comments,
    index,
    loading,
    addComment,
    editComment,
    setResolved,
    removeComment,
    applyWsComment: upsert,
    reload,
  };
}

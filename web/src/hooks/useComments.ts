import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CommentDto, type NewCommentInput } from "../sync/api";
import { indexComments, type CommentsIndex } from "../lib/commentsIndex";

// Stable empty array so the derived `comments` identity doesn't change on every
// render while a chapter's fetch is still in flight (keeps useMemo honest).
const EMPTY: CommentDto[] = [];

// Comments for one (book, chapter). Fetched separately from useChapter (see
// api/migrations/0037_comments.sql for the schema rationale) — a comments
// failure must never break the chapter. `enabled` mirrors useAlerts' auth-ready gate.
export function useComments(
  book: string,
  chapter: number,
  enabled: boolean,
): {
  comments: CommentDto[];
  index: CommentsIndex;
  loading: boolean;
  loadedKey: string;
  error: boolean;
  addComment: (input: NewCommentInput) => Promise<CommentDto>;
  editComment: (id: number, body: string) => Promise<void>;
  setResolved: (id: number, resolved: boolean) => Promise<void>;
  removeComment: (id: number) => Promise<void>;
  applyWsComment: (dto: CommentDto) => void;
  reload: () => void;
} {
  // The loaded set is stored WITH the (book, chapter) it belongs to, and the
  // getter below only hands it back when that key still matches. Clearing in an
  // effect instead would leave one paint where the previous chapter's threads
  // render against this chapter's verses — a question about DAN 2:28 showing up
  // on DAN 3:28 is precisely the wrong thing to put in front of a proofreader.
  const [loaded, setLoaded] = useState<{ key: string; comments: CommentDto[] }>({
    key: "",
    comments: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Bumping this re-runs the fetch effect (manual reload()).
  const [reloadTick, setReloadTick] = useState(0);

  const key = `${book}/${chapter}`;
  const comments = loaded.key === key ? loaded.comments : EMPTY;

  // Upsert by id, sorted by (createdAt, id) so indexComments' output is
  // stable. A dto with deletedAt set drops itself and any of its replies.
  // Ignores anything for a chapter we're no longer showing (a WS event can
  // land just after navigating away).
  const upsert = useCallback(
    (dto: CommentDto) => {
      setLoaded((prev) => {
        if (prev.key !== key) return prev;
        let next: CommentDto[];
        if (dto.deletedAt != null) {
          next = prev.comments.filter((c) => c.id !== dto.id && c.parentId !== dto.id);
        } else {
          const idx = prev.comments.findIndex((c) => c.id === dto.id);
          next =
            idx >= 0
              ? prev.comments.map((c, i) => (i === idx ? dto : c))
              : [...prev.comments, dto];
        }
        next.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
        return { key: prev.key, comments: next };
      });
    },
    [key],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(false);
    setLoading(true);
    (async () => {
      try {
        const res = await api.getComments(book, chapter);
        if (cancelled) return;
        const sorted = [...res.comments].sort(
          (a, b) => a.createdAt - b.createdAt || a.id - b.id,
        );
        setLoaded({ key, comments: sorted });
        setError(false);
      } catch (err) {
        // Comments are non-critical — swallow rather than blocking the chapter,
        // but flag `error` so the caller can tell "unavailable" from "empty".
        console.warn("useComments: failed to load comments", err);
        if (!cancelled) {
          setLoaded({ key, comments: [] });
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book, chapter, key, enabled, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  // Mutations propagate their error to the caller (rather than swallowing it
  // like the fetch path) — a discarded 403/400/network failure here is
  // indistinguishable from success, and worse, the server write can have
  // landed while the client reports failure, inviting a duplicate retry.
  const addComment = useCallback(
    async (input: NewCommentInput): Promise<CommentDto> => {
      const dto = await api.createComment(input);
      upsert(dto);
      return dto;
    },
    [upsert],
  );

  const editComment = useCallback(
    async (id: number, body: string): Promise<void> => {
      const dto = await api.updateComment(id, body);
      upsert(dto);
    },
    [upsert],
  );

  const setResolved = useCallback(
    async (id: number, resolved: boolean): Promise<void> => {
      const dto = await api.resolveComment(id, resolved);
      upsert(dto);
    },
    [upsert],
  );

  const removeComment = useCallback(
    async (id: number): Promise<void> => {
      await api.deleteComment(id);
      setLoaded((prev) =>
        prev.key === key
          ? { key: prev.key, comments: prev.comments.filter((c) => c.id !== id && c.parentId !== id) }
          : prev,
      );
    },
    [key],
  );

  const index = useMemo(() => indexComments(comments), [comments]);

  return {
    comments,
    index,
    loading,
    // The (book, chapter) this loaded set belongs to, so a caller can tell
    // "this chapter's fetch has settled and really has no comments" from
    // "we haven't fetched this chapter yet". `loading` alone can't: it stays
    // false from the previous chapter until this chapter's effect runs, while
    // `comments` is already empty — a window in which an absent comment looks
    // deleted rather than not-yet-loaded.
    loadedKey: loaded.key,
    error,
    addComment,
    editComment,
    setResolved,
    removeComment,
    applyWsComment: upsert,
    reload,
  };
}

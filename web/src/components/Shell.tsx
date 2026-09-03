import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
  Tooltip,
  Snackbar,
  IconButton,
} from "@mui/material";
import GridViewIcon from "@mui/icons-material/GridView";
import LockIcon from "@mui/icons-material/Lock";
import { useChapter } from "../hooks/useChapter";
import { useChapterRoom } from "../hooks/useChapterRoom";
import type { UseBookReturn } from "../hooks/useBook";
import { useBookLint } from "../hooks/useBookLint";
import { useBookLocks } from "../hooks/useBookLocks";
import { useAlignmentAttention } from "../hooks/useAlignmentAttention";
import { useLexicon } from "../hooks/useLexicon";
import { useAiDrafts } from "../hooks/useAiDrafts";
import { useTwlFilters } from "../hooks/useTwlFilters";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { outbox } from "../sync/outbox";
import { api, ApiError, CHECK_LANES, setReadOnlyReason } from "../sync/api";
import type { BookLintIssue, ChapterPayload, CheckLane, TnRow, TqRow, TwlRow, VerseDto, TwlSuggestion, CommentRowKind, MentionUser } from "../sync/api";
import { useComments } from "../hooks/useComments";
import { countThreads, rowKey, type CommentThread } from "../lib/commentsIndex";
import { CommentsPopover } from "./CommentsPopover";
import type { CommentTarget, NewCommentDraft, OpenCommentsFn } from "./commentsTarget";
import { targetKey, targetsMatch } from "./commentsTarget";
import {
  indexLaneChecks,
  laneKey,
  laneApplicable,
  laneAttribution,
  shadeFromCheckers,
  LANE_LABELS,
  type LaneShade,
  type TextLaneCheck,
} from "../lib/laneChecks";
import { ChapterBoard } from "./ChapterBoard";
import { BookLocksDialog } from "./BookLocksDialog";
import { drafts, verseKey, pinVerseBase, unpinVerseBaseIfIdle, registerVerseVersionReader } from "../sync/drafts";
import { generationForSavedPlain } from "../sync/draftSaveState";
import { smartEditVerse } from "../lib/replace";
import { extractEditableText, extractPlainText, normalizeEditable, isHeaderLabelNode, SECTION_HEADER_TAGS } from "../lib/usfm";
import { chapterOpensWithoutMarker, introEditBase } from "../lib/verseIntro";
import { verseHasUnalignedWork, countUnalignedTargetWords } from "../lib/alignment";
import {
  analyzeAlignmentDelta,
  guardBlocksSave,
  type AlignmentIntent,
} from "../lib/alignmentDelta";
import { buildVerseIndex, concatSourceRange, formatVerseLabel, noteCoveredVerses } from "../lib/verseRange";
import { runSaveChain } from "../lib/saveChain";
import { buildTnQuickRequest } from "../lib/tnQuickRequest";
import { findSourceForTargetText, extractTargetSelectionText, type HighlightKey, type ReorderHighlight } from "../lib/highlight";
import { buildQuoteFromSelection, selectionFromQuote } from "../lib/quoteBuilder";
import { resolveSpanToSource } from "../lib/twlResolve";
import { canonicalTwlOrder, manualTwlOrder } from "../lib/twlCanonicalOrder";
import { useCatalogs } from "../hooks/useCatalogs";
import { nfc } from "../lib/hebrew";
import { TimelineRail, type VerseTile, type VerseTileLane } from "./TimelineRail";
import { ScriptureColumn, type ScriptureMode } from "./ScriptureColumn";
import { ResourceColumn, type AlignmentTabProps, type PanelMode, type ReorderPreview, type ResourceCheckoff, type ResourceLane } from "./ResourceColumn";
import type { AlignmentPanelHandle } from "./AlignmentPanel";
import {
  SideBySideAligner,
  type PanelSlot,
  type ReadingLineHandle,
} from "./SideBySideAligner";
import { TopBar } from "./TopBar";
import { ExportUsfmButton } from "./ExportUsfmButton";
import { BookLintIndicator } from "./BookLintIndicator";
import { AlignAttentionIndicator } from "./AlignAttentionIndicator";
import { BookNotesIndicator } from "./BookNotesIndicator";
import { LogosSyncToggle } from "./LogosSyncToggle";
import { PipelineMenu } from "./PipelineMenu";
import { PipelineStatusBar } from "./PipelineStatusBar";
import { pipelineStore, type PipelineJob } from "../sync/pipelineStore";
import { onOutboxResult } from "../sync/outbox";
import { AiCompletionToasts } from "./AiCompletionToasts";
import { UnsavedToasts } from "./UnsavedToasts";
import { QuoteBuilderPopper } from "./QuoteBuilderPopper";
import { collectStrongs } from "./HebrewLine";

interface AlignerTarget {
  chapter: number;
  verse: number;
  bibleVersion: string;
}

// Per-version slice of the alignment props: target verse, the source for the
// verses that target covers (concatenated across a multi-verse range), and the
// TWL rows for that span. Used by both the single-panel aligner and the
// side-by-side popup. Resolves through buildVerseIndex so a verse INSIDE a
// range row (e.g. v7 of a UST 6-9 block) finds its covering row — the wire
// map is keyed by verse_start only.
function buildAlignerSlice(sourceData: ChapterPayload, verse: number, bibleVersion: string) {
  const sourceLabel = sourceData.verses["UHB"] ? "UHB" : "UGNT";
  const targetVerse = buildVerseIndex(sourceData.verses[bibleVersion])[verse] ?? null;
  const rangeEnd = targetVerse?.verse_end ?? targetVerse?.verse ?? verse;
  const rangeStart = targetVerse?.verse ?? verse;
  const sourceVerse =
    rangeEnd > rangeStart
      ? concatSourceRange(sourceData.verses[sourceLabel] ?? {}, rangeStart, rangeEnd)
      : sourceData.verses[sourceLabel]?.[rangeStart] ?? null;
  const twlForVerse = sourceData.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
  return { sourceLabel, targetVerse, sourceVerse, twlForVerse, rangeStart, rangeEnd };
}

// Word-token count of one source verse row — text/punctuation nodes excluded,
// matching the position enumeration in UhbStrip/buildSourceIndexMap. Used to
// compute each dual panel's posOffset within the union span.
function countSourceWords(row: VerseDto | undefined): number {
  const verseObjects = (row?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  let n = 0;
  const walk = (nodes: unknown[]) => {
    for (const x of nodes ?? []) {
      const o = x as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") n++;
      // \d (Psalm superscription) is `type:"section"` but its content IS
      // alignable Hebrew verse body — descend it like a milestone, mirroring
      // collectMilestoneRuns in highlight.ts. Half of a cross-PR \d fix; the
      // other source-word walkers (highlight/quoteBuilder/alignment/
      // AlignmentPanel/UhbStrip) gain the same descent so posOffsets stay aligned.
      else if (
        o["type"] === "milestone" ||
        (o["type"] === "section" && o["tag"] === "d")
      )
        walk((o["children"] as unknown[] | undefined) ?? []);
    }
  };
  walk(verseObjects ?? []);
  return n;
}

const SCRIPTURE_MODE_KEY = "be:scriptureMode";
const ENABLED_VERSIONS_KEY = "be:enabledVersions";
const RAIL_COLLAPSED_KEY = "be:railCollapsed";
const ENABLED_LANES_KEY = "be:enabledLanes";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// Cross-chapter row-focus jump carry. A find-overlay TN match, or a book-wide
// lint "go to issue" for a tq/twl finding, can target a chapter other than the
// one currently loaded; navigating there goes through the hash, which can't
// encode a row id, and Shell is keyed on book/chapter/verse so it fully
// remounts on arrival. Stash the target here just before navigating; the
// freshly-mounted Shell consumes it once its chapter payload (with that row)
// has loaded, then activates + scrolls to the right resource tab. `kind`
// picks which of tn/tq/twl the row belongs to, and so which active*Id state
// (and resource tab) the consuming effect sets. Module-level so it survives
// the remount; cleared on consume so a later same-location mount doesn't
// re-grab a stale row.
let pendingRowJump: {
  book: string;
  chapter: number;
  kind: "tn" | "tq" | "twl";
  rowId: string;
  // Only a lint "go to issue" asks the resource column to change tabs on
  // arrival (see requestJumpTab). A find-overlay TN match leaves the tab
  // alone, matching the pre-#669 behaviour.
  switchTab?: boolean;
} | null = null;

// Which resource tab owns each row kind — used by the lint go-to's explicit
// tab request.
const TAB_FOR_ROW_KIND = {
  tn: "notes",
  tq: "questions",
  twl: "words",
} as const;

// Stable empty list so the popover's `threads` prop doesn't churn identity while
// a target has no threads yet.
const EMPTY_COMMENT_THREADS: CommentThread[] = [];

interface Props {
  book: string;
  chapter: number;
  initialVerse?: number;
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
  bookHook?: UseBookReturn;
  onLogout?: () => void;
  // Current signed-in user id, for the checkoff lane shading (you vs others).
  meUserId?: number | null;
  // True when the signed-in user's role is 'viewer' (global read-only).
  // Passed down instead of read from isReadOnly() so comments-gating isn't
  // re-derived from a module-level global (see commentsEnabled below) — App
  // already computes this from auth.role for its own banner.
  isViewer?: boolean;
  // Comment id from a `?c=<id>` deep link (e.g. a mention alert). Consumed once
  // that chapter's comments have loaded — see the consumer effect below.
  initialCommentId?: number;
  // Called once Shell has acted on `initialCommentId`. App owns the URL, so it
  // clears both the `?c=` param and its own location state — Shell rewriting
  // the hash itself fired no hashchange, leaving App's state stale.
  onCommentConsumed?: () => void;
  // True once auth is confirmed ready (App's auth gate has minted/refreshed
  // the token). Gates the book-locks fetch — see useBookLocks.
  authReady?: boolean;
  // Top-right notifications bell (comment mentions/replies). Owned by App
  // (which holds the alerts) and rendered here inside the TopBar.
  notificationsMenu?: ReactNode;
  // Collapsed "sync warnings" badge (door43/export state alerts). Also owned
  // by App and rendered in the TopBar next to the other indicators — replaces
  // the old full-width banner so these warnings never block navigation (#458).
  syncWarnings?: ReactNode;
}

export function Shell({ book, chapter, initialVerse = 1, onNavigate, bookHook, onLogout, meUserId = null, isViewer = false, initialCommentId, onCommentConsumed, authReady = false, notificationsMenu, syncWarnings }: Props) {
  // tw_link → article title, for canonical (headword-anchored) TWL ordering.
  // handleAddTwlSuggestion below places a NEW link at its canonical slot and
  // persists a matching sort_order, so it must order with the SAME inputs the
  // display and the nightly export use — without the titles it would compute
  // the slot from the tier-2/3 fallback and write a sort_order around the
  // wrong neighbour.
  const { twTitles } = useCatalogs();
  const {
    status,
    data,
    error,
    retryAttempts,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
    applyLocalVerse,
    applyLocalVerseBridge,
    applyLocalVerseSplit,
    applyLocalVerseStatus,
    applyLocalLaneCheck,
    applyLaneCheckers,
    replaceLaneChecksForLane,
    applyLocalTwlOrderLock,
  } = useChapter(book, chapter);

  // Verses whose TW link order a human has taken over. A locked verse is ordered
  // by its stored sort_order everywhere — display, export, reimport — instead of
  // from the ULT alignment. Everything downstream asks this Set, so there is
  // exactly one place that decides "is this verse manual or automatic".
  const twlOrderLocks = data?.twlOrderLocks;
  const lockedTwlVerses = useMemo(
    () => new Set((twlOrderLocks ?? []).map((l) => l.verse)),
    [twlOrderLocks],
  );
  // Surfaced when taking a verse manual fails, so an aborted reorder is visible
  // rather than the drag just appearing to do nothing.
  const [twlOrderToast, setTwlOrderToast] = useState<string | null>(null);
  // Surfaced when a verse-bridge create/break fails (409 conflict, no adjacent
  // verse, not a bridge) so the button click doesn't just silently do nothing.
  const [bridgeToast, setBridgeToast] = useState<string | null>(null);

  // "Use automatic": hand the verse back. The server also re-sequences that
  // verse's sort_order on the way out, which bumps each row's version — so
  // refetch rather than patching locally, or the next edit to one of those rows
  // would go out with a stale version and take a needless 409.
  const handleTwlOrderUnlock = useCallback(
    async (verse: number) => {
      try {
        await api.unlockTwlOrder(book, chapter, verse);
        applyLocalTwlOrderLock(verse, null);
        await refetch();
      } catch (e) {
        console.error("twl order unlock failed", e);
        setTwlOrderToast("Couldn't switch this verse back to automatic word order.");
      }
    },
    [book, chapter, applyLocalTwlOrderLock, refetch],
  );

  // "Keep mine": remember the automatic order we just declined so the hint stays
  // quiet until automatic ordering proposes something genuinely different.
  const handleTwlOrderDismiss = useCallback(
    async (verse: number, dismissedOrder: string) => {
      try {
        const lock = await api.dismissTwlOrderSuggestion(book, chapter, verse, dismissedOrder);
        applyLocalTwlOrderLock(verse, lock);
      } catch (e) {
        console.error("twl order dismiss failed", e);
      }
    },
    [book, chapter, applyLocalTwlOrderLock],
  );

  // ── Internal comments ──
  // Gated on the viewer role only: the whole comments module is requireEditor
  // server-side, so a viewer would take a 403 on every chapter change. Viewers
  // therefore see no comment badges at all, which is the intended behaviour.
  // Deliberately NOT isReadOnly() — comments stay open on a locked book (see
  // docs/book-locks.md and api/src/bookLockGuard.ts), and isReadOnly() would
  // also fold in bookLocked and hide them. Reads the `isViewer` prop (a React
  // value threaded from App's auth state) rather than isReadOnly()'s module
  // global, which is set in an effect and was stale on first render.
  // Declared above useChapterRoom because that hook's handler object wires
  // applyWsComment straight through.
  const commentsEnabled = !isViewer;
  const {
    index: commentsIndex,
    loading: commentsLoading,
    loadedKey: commentsLoadedKey,
    error: commentsError,
    addComment,
    editComment,
    setResolved: setCommentResolved,
    removeComment,
    applyWsComment,
    reload: reloadComments,
  } = useComments(book, chapter, commentsEnabled);

  // Live cross-tab updates. The server broadcasts row writes via the
  // ChapterRoom DO; we dedupe by version so the originating user's tab
  // (whose state was already updated by the PATCH response) is a no-op.
  // NoteCard's session guard already shields an in-progress edit from
  // being clobbered when the underlying row prop changes — so we can
  // apply unconditionally here.
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  // DEV-only wiring for the #605 extension of window.__bePinDebug (see
  // drafts.ts) — lets tests/concurrency/s9-verse-pin-release.spec.ts poll
  // this tab's chapter cache for the version it has actually observed (e.g.
  // over the WebSocket) instead of guessing a fixed delay. Re-registered
  // whenever `book`/`chapter` change so the reader always answers for the
  // currently-open chapter's dataRef, not a stale closure over an earlier one.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    registerVerseVersionReader((readBook, readChapter, readVerse, bibleVersion) => {
      if (readBook !== book || readChapter !== chapter) return undefined;
      return dataRef.current?.verses[bibleVersion]?.[readVerse]?.version;
    });
  }, [book, chapter]);
  // The "save & refresh" prompt helper is defined further down (it depends on
  // toast state declared after this hook), so the WS handler reaches it through
  // a ref, mirroring dataRef above.
  const promptRefreshRef = useRef<(pipelineType: string) => void>(() => {});
  useChapterRoom(book, chapter, {
    onUpsert: (kind, row) => {
      const list = dataRef.current?.[kind] as Array<TnRow | TqRow | TwlRow> | undefined;
      const existing = list?.find((r) => r.id === row.id);
      if (!existing) {
        applyLocalRowInsert(kind, row);
      } else if (row.version > existing.version) {
        applyLocalRowReplacement(kind, row);
      } else if (
        // Preserve/hint/trash toggles on TN rows don't bump version (they're
        // state flips, not content — see api/src/rows.ts setTnBit /
        // setTnTrashed). The version > existing.version guard above would drop
        // these broadcasts, leaving other tabs stale until refetch. Same-
        // version replace when an intent bit or the trash state differs.
        kind === "tn" &&
        row.version === existing.version &&
        ((row as TnRow).preserve !== (existing as TnRow).preserve ||
          (row as TnRow).hint !== (existing as TnRow).hint ||
          (row as TnRow).trashed_at !== (existing as TnRow).trashed_at)
      ) {
        applyLocalRowReplacement(kind, row);
      }
      // This room is scoped to the currently open {book, chapter}, so any
      // row.upserted event here is for this book — regardless of whether the
      // dedupe guard above applied it, the server may have flipped
      // lint-relevant state (e.g. a no-op review-flag clear, which doesn't
      // touch row content or version — see api/src/rows.ts). The lint chip is
      // drawn from a separate fetch (useBookLint), so nudge it via the same
      // debounced refetch the outbox listener below uses.
      scheduleLintRefetch();
    },
    onDelete: (kind, id) => applyLocalRowDelete(kind, id),
    onVerseUpdate: (verse) => {
      const existing = dataRef.current?.verses[verse.bible_version]?.[verse.verse];
      if (!existing || verse.version > existing.version) {
        applyLocalVerse(verse);
      }
    },
    onVerseBridged: (verse, removedVerse, absorbedVerses) => {
      // Newer-version-wins, same guard as onVerseUpdate — a lagging broadcast
      // must not clobber a fresher local bridge row.
      const existing = dataRef.current?.verses[verse.bible_version]?.[verse.verse];
      if (!existing || verse.version > existing.version) {
        applyLocalVerseBridge(verse, removedVerse, absorbedVerses);
      }
    },
    onVerseSplit: (verse, newVerses) => {
      const existing = dataRef.current?.verses[verse.bible_version]?.[verse.verse];
      if (!existing || verse.version > existing.version) {
        applyLocalVerseSplit(verse, newVerses);
      }
    },
    onVerseStatusUpdate: (status) => {
      applyLocalVerseStatus(status.verse, status.done === 1);
    },
    onLaneCheckUpdate: (check) => {
      applyLaneCheckers(check.verse, check.lane, check.checkers);
    },
    onLaneCheckBulkUpdate: (lane, checks) => {
      replaceLaneChecksForLane(lane, checks);
    },
    onTwlOrderLockUpdate: (verse, lock) => {
      applyLocalTwlOrderLock(verse, lock);
    },
    // applyWsComment is a stable useCallback, so passing it straight through is
    // safe even though this handlers object isn't memoized.
    onCommentUpdate: applyWsComment,
    onPipelineApplied: (_book, _chapter, pipelineType) => {
      // This socket only carries events for the chapter in view, so any hint
      // that arrives is for the open chapter — offer a refresh. Covers
      // collaborators too (their tab gets no pipeline-completion event).
      promptRefreshRef.current(pipelineType);
    },
  });
  // Which verse / row the popover is showing, and the element it hangs off.
  // One object: the popover's anchor element and what it's anchored to always
  // change together, and splitting them meant one updater had to set the other.
  const [commentPanel, setCommentPanel] = useState<{
    anchor: HTMLElement | null;
    target: CommentTarget | null;
  }>({ anchor: null, target: null });
  const commentTarget = commentPanel.target;
  const commentAnchor = commentPanel.anchor;
  const [highlightCommentId, setHighlightCommentId] = useState<number | null>(null);
  // A deep-linked comment arrives with no clicked element to hang off, and a
  // Popper with a null anchorEl renders in the top-left corner. This zero-size
  // fixed element (always mounted, below) is the fallback anchor, so the panel
  // lands centred-right instead.
  const [commentFallbackAnchor, setCommentFallbackAnchor] = useState<HTMLElement | null>(null);

  // Toggle-close when the incoming click targets the same anchor that's
  // already open (a second click on the same badge), otherwise re-anchor to
  // the new target. This — combined with CommentsPopover's click-away
  // ignoring clicks on badge buttons — is what lets clicking a DIFFERENT
  // badge move the popover there in a single click instead of just closing it.
  // Anchor and target move together, so they live in one state object: setting
  // one from inside the other's updater made the updater impure, and React is
  // free to run an updater twice (StrictMode, a discarded concurrent render).
  const openComments: OpenCommentsFn = useCallback((anchorEl, target) => {
    setCommentPanel((prev) =>
      // Only toggle-close when the existing panel already has a real anchor
      // AND targets match. A deep-link arrival opens with anchor: null (the
      // centred fallback) — without the anchor check, clicking that same
      // verse's badge afterward read as "close" instead of re-anchoring the
      // panel to the badge, since targetsMatch alone was already true.
      prev.target && prev.anchor && targetsMatch(prev.target, target)
        ? { anchor: null, target: null } // clicking the same badge toggles closed
        : { anchor: anchorEl, target },
    );
  }, []);

  const closeComments = useCallback(() => {
    setCommentPanel({ anchor: null, target: null });
    setHighlightCommentId(null);
  }, []);

  // Unposted composer text survives the popover closing. Shell rerenders
  // `{commentTarget && <CommentsPopover key={targetKey(...)} …>}`, so closing
  // UNMOUNTS the popover and every composer's local `body` state with it — an
  // editor who types a few sentences then clicks the verse text to re-read it
  // would otherwise lose the draft outright. A ref (not state): it must
  // survive the popover unmounting on close, but doesn't need to survive a
  // page reload. Keyed by book/chapter/target so drafts for different verses
  // or rows never bleed into each other.
  const composerDraftsRef = useRef<Map<string, string>>(new Map());
  const commentDraftKey = commentTarget ? `${book}/${chapter}/${targetKey(commentTarget)}` : null;
  const handleComposerBodyChange = useCallback((body: string) => {
    if (!commentDraftKey) return;
    if (body) composerDraftsRef.current.set(commentDraftKey, body);
    else composerDraftsRef.current.delete(commentDraftKey);
  }, [commentDraftKey]);
  const handleReplyBodyChange = useCallback(
    (parentId: number, body: string) => {
      if (!commentDraftKey) return;
      const key = `${commentDraftKey}/reply/${parentId}`;
      if (body) composerDraftsRef.current.set(key, body);
      else composerDraftsRef.current.delete(key);
    },
    [commentDraftKey],
  );
  const getReplyDraft = useCallback(
    (parentId: number) => {
      if (!commentDraftKey) return "";
      return composerDraftsRef.current.get(`${commentDraftKey}/reply/${parentId}`) ?? "";
    },
    [commentDraftKey],
  );

  // Mention list, fetched lazily the FIRST time a popover opens (not per
  // chapter load) and then cached for the session. A failure degrades to an
  // empty list: the popover simply offers no mention picker.
  const [mentionUsers, setMentionUsers] = useState<MentionUser[]>([]);
  const mentionUsersRequested = useRef(false);
  useEffect(() => {
    if (!commentTarget || mentionUsersRequested.current || !commentsEnabled) return;
    mentionUsersRequested.current = true;
    void api
      .getMentionUsers()
      .then((res) => setMentionUsers(res.users))
      .catch((e) => {
        console.warn("mention users unavailable", e);
        // Reset so a later popover open retries. Without this, one transient
        // failure permanently disabled the @ picker for the whole session —
        // and worse, left mentionUsers empty, which made splitMentions render
        // every existing @mention in every comment as plain text.
        mentionUsersRequested.current = false;
      });
  }, [commentTarget, commentsEnabled]);

  // Threads for whatever the popover is currently pointed at.
  const commentThreads = useMemo(() => {
    if (!commentTarget) return EMPTY_COMMENT_THREADS;
    const list =
      commentTarget.rowKind == null
        ? commentsIndex.threadsByVerse.get(commentTarget.verse)
        : commentsIndex.threadsByRow.get(rowKey(commentTarget.rowKind, commentTarget.rowId));
    return list ?? EMPTY_COMMENT_THREADS;
  }, [commentTarget, commentsIndex]);

  // Memoized on the index so ScriptureColumn's comparator sees a NEW identity
  // exactly when comments changed (and a stable one otherwise — a fresh arrow
  // each render would defeat that memo entirely).
  const verseCommentCounts = useMemo(
    () =>
      commentsEnabled
        ? (verse: number) => countThreads(commentsIndex.threadsByVerse.get(verse))
        : undefined,
    [commentsIndex, commentsEnabled],
  );
  const commentCountsForRow = useMemo(
    () =>
      commentsEnabled
        ? (kind: CommentRowKind, rowId: string) =>
            countThreads(commentsIndex.threadsByRow.get(rowKey(kind, rowId)))
        : undefined,
    [commentsIndex, commentsEnabled],
  );

  const onOpenVerseComments = useMemo(
    () =>
      commentsEnabled
        ? (anchorEl: HTMLElement, verse: number) => openComments(anchorEl, { verse })
        : undefined,
    [commentsEnabled, openComments],
  );
  const onOpenRowComments = useMemo(
    () =>
      commentsEnabled
        ? (anchorEl: HTMLElement, rowKind: CommentRowKind, rowId: string, verse: number) =>
            openComments(anchorEl, { verse, rowKind, rowId })
        : undefined,
    [commentsEnabled, openComments],
  );

  // Rejections propagate to the popover, which renders them — deliberately no
  // try/catch here, since a swallowed failure is indistinguishable from success.
  const handleCreateComment = useCallback(
    async (draft: NewCommentDraft) => {
      if (!commentTarget) return;
      await addComment({
        book,
        chapter,
        verse: commentTarget.verse,
        rowKind: commentTarget.rowKind,
        rowId: commentTarget.rowId,
        ...draft,
      });
    },
    [addComment, book, chapter, commentTarget],
  );

  // Book-level DCS-validation summary for the topbar "issues to clean up"
  // indicator. Keyed on book, so it fetches once per book change — never on
  // chapter/verse navigation within a book.
  const bookLint = useBookLint(book, true);
  // Sticky "alignment needs attention" badge — the nightly export's evidence
  // of ULT/UST verses that lost word alignment, surviving banner dismissal
  // and reload. Book-level, fetched once per book change.
  const alignAttention = useAlignmentAttention(book, true);
  // TWL suggestion deny-lists (unlinked word+article pairs + this book's deleted
  // reference+quotes). Keyed on book, fetched once per book change. Drives the
  // deleted-here exclusion + unlinked article-pruning for per-verse suggestions.
  const twlFilters = useTwlFilters(book);
  // The lint report is otherwise fetched once per book, so a translator who
  // fixes a flagged note (e.g. unbalanced brackets around an Alternate
  // translation) would keep seeing the stale count until a reload. Refetch when
  // a TN-row or verse write for THIS book lands successfully — those are the
  // only edits the lint covers (TN flags + ULT/UST footnote integrity) —
  // debounced so a burst of saves coalesces into one request.
  const bookLintRefetch = bookLint.refetch;
  const lintRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounced lint refetch — coalesces a burst of edits into one request.
  // Used by the outbox listener below AND by the trash/restore handlers, which
  // bypass the outbox (direct API calls) yet change the lint set: the lint
  // endpoint filters `trashed_at IS NULL`, so trashing a flagged note drops the
  // count and restoring one adds it back.
  const scheduleLintRefetch = useCallback(() => {
    if (lintRefetchTimer.current) clearTimeout(lintRefetchTimer.current);
    lintRefetchTimer.current = setTimeout(() => {
      lintRefetchTimer.current = null;
      bookLintRefetch();
    }, 1000);
  }, [bookLintRefetch]);
  useEffect(() => {
    const unsub = onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      const t = op.target;
      const touchesLint =
        (t.kind === "row" && t.rowKind === "tn" && t.book === book) ||
        (t.kind === "verse" && t.book === book);
      if (touchesLint) scheduleLintRefetch();
    });
    return () => {
      unsub();
      if (lintRefetchTimer.current) {
        clearTimeout(lintRefetchTimer.current);
        lintRefetchTimer.current = null;
      }
    };
  }, [book, scheduleLintRefetch]);
  // Self-heal a stale "issues to clean up" chip: when the tab regains focus or
  // becomes visible, re-pull the lint. A tab left open while edits land (here,
  // in another tab, on another device, or via an out-of-band fix) otherwise
  // shows a frozen count until a manual reload — the symptom that flagged-note
  // saves "weren't clearing." Reuses the debounced refetch, so a quick blur/
  // focus flurry coalesces into one request.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") scheduleLintRefetch();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scheduleLintRefetch]);
  const [activeVerse, setActiveVerse] = useState(initialVerse);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeWordId, setActiveWordId] = useState<string | null>(null);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);

  // Close the comments panel when its target stops being valid, so it doesn't
  // stay open floating at its last position (still accepting new comments
  // against a possibly-gone anchor). Two ways a target goes stale: the active
  // verse moves off the verse it's anchored to (its badge may not even render
  // for an inactive zero-thread verse), or — for a row-anchored target — the
  // row itself is no longer in the loaded rows (e.g. the tn row was deleted).
  useEffect(() => {
    if (!commentTarget) return;
    if (commentTarget.verse !== activeVerse) {
      closeComments();
      return;
    }
    if (commentTarget.rowKind != null && commentTarget.rowId != null) {
      const rows = data?.[commentTarget.rowKind] as Array<{ id: string }> | undefined;
      if (!rows?.some((r) => r.id === commentTarget.rowId)) closeComments();
    }
  }, [activeVerse, commentTarget, data, closeComments]);
  const [mode, setMode] = useState<ScriptureMode>(() =>
    loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"),
  );
  const [enabledVersions, setEnabledVersions] = useState<string[]>(() =>
    loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]),
  );
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() =>
    loadFromStorage<boolean>(RAIL_COLLAPSED_KEY, false),
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      saveToStorage(RAIL_COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  // Which checkoff lanes show as columns in the timeline rail. Defaults to all
  // four; users hide lanes they don't track (rail then narrows) and re-enable
  // them from the Board dialog. Persisted; normalized to canonical order so a
  // stale/corrupt value can't reorder or smuggle in unknown lane keys. An empty
  // array (all lanes hidden) is a valid, intentional state.
  const [enabledLanes, setEnabledLanes] = useState<CheckLane[]>(() => {
    const saved = loadFromStorage<CheckLane[]>(ENABLED_LANES_KEY, [...CHECK_LANES]);
    return CHECK_LANES.filter((l) => saved.includes(l));
  });
  const toggleLaneVisible = useCallback((lane: CheckLane) => {
    setEnabledLanes((prev) => {
      const next = prev.includes(lane)
        ? prev.filter((l) => l !== lane)
        : CHECK_LANES.filter((l) => l === lane || prev.includes(l));
      saveToStorage(ENABLED_LANES_KEY, next);
      return next;
    });
  }, []);
  // Rail width tracks the visible lane count (verse column + ~25px per lane),
  // floored so the "Board" button label stays readable. 0 when collapsed.
  const railWidth = railCollapsed ? 0 : Math.max(96, 48 + enabledLanes.length * 25);
  const [alignerTarget, setAlignerTarget] = useState<AlignerTarget | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("resources");
  const [alignmentDirty, setAlignmentDirty] = useState(false);
  const alignmentPanelRef = useRef<AlignmentPanelHandle | null>(null);
  // Queued action that should run after the user resolves the dirty-confirm
  // popup. Verse / version changes attempted while the alignment panel has
  // unsaved drags stash their apply() here; the dialog decides which branch
  // to invoke.
  const [pendingNav, setPendingNav] = useState<{ run: () => void } | null>(null);
  // Side-by-side aligner popup: which verse it targets (ULT + UST at once),
  // per-panel handles for the save/discard gate, and per-panel dirty flags.
  const [dualTarget, setDualTarget] = useState<{ chapter: number; verse: number } | null>(null);
  const dualLeftRef = useRef<AlignmentPanelHandle | null>(null);
  const dualRightRef = useRef<AlignmentPanelHandle | null>(null);
  const [dualLeftDirty, setDualLeftDirty] = useState(false);
  const [dualRightDirty, setDualRightDirty] = useState(false);
  // Same machinery for the editable reading lines, so the gate prompts before a
  // close/nav drops an unsaved reading-text edit.
  const dualLeftReadingRef = useRef<ReadingLineHandle | null>(null);
  const dualRightReadingRef = useRef<ReadingLineHandle | null>(null);
  const [dualLeftReadingDirty, setDualLeftReadingDirty] = useState(false);
  const [dualRightReadingDirty, setDualRightReadingDirty] = useState(false);
  // Queued action (close / verse-nav) awaiting the user's save-or-discard
  // choice when a dual panel has unsaved drags.
  const [pendingDualAction, setPendingDualAction] = useState<{ run: () => void } | null>(null);
  // Confirm gate for an aligner save that would leave a previously-aligned word
  // bare. alignment_edit is exempt from the collateral-loss save guard, so this
  // is the "out loud" surface for an accidental unlink (the JER 30:1 incident):
  // commit runs only if the user proceeds.
  const [pendingAlignmentLoss, setPendingAlignmentLoss] = useState<
    { ref: string; lostWords: string[]; commit: () => void } | null
  >(null);
  // Shared by the scripture + resource columns so a single "go to active"
  // click re-centers both. Bumped via requestScrollToActive (and elsewhere
  // when the active selection changes through other paths).
  const [scrollNonce, setScrollNonce] = useState(0);
  const requestScrollToActive = useCallback(() => setScrollNonce((n) => n + 1), []);

  // Explicit "switch the resource column to this tab" signal. Deliberately a
  // channel of its own rather than something the resource column infers from a
  // scrollNonce bump: the toolbar "go to active" button and the unsaved-changes
  // toasts bump scrollNonce with no intent to change tabs, and inferring a tab
  // from whichever active*Id happened to be set yanked the panel back (e.g.
  // click a note, switch to Words, press "go to active" → back to Notes).
  // Only the lint go-to below sets this. `n` makes each request distinct so a
  // consumed one can't re-fire on an unrelated re-render.
  const [jumpTab, setJumpTab] = useState<{ tab: "notes" | "questions" | "words"; n: number } | null>(
    null,
  );
  const requestJumpTab = useCallback(
    (tab: "notes" | "questions" | "words") => setJumpTab((prev) => ({ tab, n: (prev?.n ?? 0) + 1 })),
    [],
  );

  const [splitRatio, setSplitRatio] = useState<number | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  // Toast state shared between the pipeline trigger menu and the status bar.
  // Cleared on dismiss or after a short auto-timeout.
  const [pipelineToast, setPipelineToast] = useState<
    { id: number; text: string; kind: "success" | "error" | "info"; action?: { label: string; onClick: () => void } } | null
  >(null);
  const pipelineToastIdRef = useRef(0);
  const pushPipelineToast = useCallback(
    (text: string, kind: "success" | "error" | "info" = "info", action?: { label: string; onClick: () => void }) => {
      pipelineToastIdRef.current += 1;
      setPipelineToast({ id: pipelineToastIdRef.current, text, kind, action });
    },
    [],
  );
  useEffect(() => {
    if (!pipelineToast) return;
    // Actionable toasts (e.g. "save & refresh") stay put until the user acts or
    // dismisses — auto-expiring them would hide the affordance mid-decision.
    if (pipelineToast.action) return;
    const id = pipelineToast.id;
    const t = setTimeout(() => {
      setPipelineToast((cur) => (cur && cur.id === id ? null : cur));
    }, 8000);
    return () => clearTimeout(t);
  }, [pipelineToast]);

  // A pipeline just wrote new rows into the chapter the user is looking at. The
  // rows landed out of band (no per-row broadcast), so offer an explicit refresh
  // rather than refetching silently — the copy tells them to save first so an
  // in-progress edit is never lost. Shared by the requester's completion event
  // and the WS hint (which also reaches collaborators with the chapter open).
  const promptChapterRefresh = useCallback(
    (pipelineType: string) => {
      pushPipelineToast(
        `New AI ${pipelineType} are ready for this chapter. Save your work, then refresh.`,
        "info",
        { label: "Refresh", onClick: () => void refetch() },
      );
    },
    [pushPipelineToast, refetch],
  );
  useEffect(() => {
    promptRefreshRef.current = promptChapterRefresh;
  }, [promptChapterRefresh]);

  useEffect(
    () =>
      pipelineStore.onComplete((job, prev) => {
        const where = `${job.book} ${job.start_chapter}`;
        if (job.state === "done") {
          // Viewing the chapter this job wrote? Offer refresh instead of a plain
          // "applied" toast, since its new rows aren't in the open list yet.
          const inView = job.book === book && chapter >= job.start_chapter && chapter <= job.end_chapter;
          if (inView) promptChapterRefresh(job.pipeline_type);
          else pushPipelineToast(`AI ${job.pipeline_type} applied to ${where}.`, "success");
        } else if (job.state === "failed" && prev !== "failed") {
          pushPipelineToast(`AI ${job.pipeline_type} failed for ${where}: ${job.error_kind ?? "error"}`, "error");
        }
      }),
    [pushPipelineToast, promptChapterRefresh, book, chapter],
  );

  // Surface a toast when the outbox drops an op because the chapter was
  // locked. The user's edit was rejected by the server (409 chapter_locked)
  // and discarded — retrying would race the auto-apply step.
  useEffect(
    () =>
      onOutboxResult((_op, result) => {
        if (result.kind === "locked") {
          pushPipelineToast(
            "Edit dropped — the AI run for this chapter is mid-flight. Try again after it finishes.",
            "error",
          );
        }
      }),
    [pushPipelineToast],
  );

  // Derive the chapter lock from active pipeline jobs. A run only locks the
  // resources it will overwrite when it lands, and the server says which those
  // are (`locks_resources` — its own type plus any pending chain steps). We
  // don't re-derive the mapping here: api/src/chapterLock.ts owns it, so the
  // lanes the UI greys out can't drift from the ones the API rejects.
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);
  const chapterLocks = useMemo(() => {
    const running = activeJobs.filter(
      (j) =>
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        (j.state === "running" ||
          j.state === "paused_for_outage" ||
          j.state === "paused_for_usage_limit" ||
          j.state === "dispatching"),
    );
    const lockFor = (resource: "verse" | "tn" | "tq") => {
      const found = running.find((j) => j.locks_resources?.includes(resource));
      if (!found) return null;
      return {
        jobId: found.job_id,
        pipelineType: found.pipeline_type,
        startedAt: found.created_at,
      };
    };
    return { verse: lockFor("verse"), tn: lockFor("tn"), tq: lockFor("tq") };
  }, [activeJobs, book, chapter]);
  // One banner line per active run, so a run's type and start time are never
  // attributed to another run's locked lanes.
  const lockBanners = useMemo(() => {
    const byJob = new Map<string, { pipelineType: string; startedAt: number; resources: string[] }>();
    for (const [resource, label] of [
      ["verse", "scripture"],
      ["tn", "notes"],
      ["tq", "questions"],
    ] as const) {
      const lock = chapterLocks[resource];
      if (!lock) continue;
      const entry = byJob.get(lock.jobId);
      if (entry) entry.resources.push(label);
      else
        byJob.set(lock.jobId, {
          pipelineType: lock.pipelineType,
          startedAt: lock.startedAt,
          resources: [label],
        });
    }
    return Array.from(byJob, ([jobId, v]) => ({ jobId, ...v }));
  }, [chapterLocks]);

  const handleSetNotePreserve = useCallback(
    async (id: string, value: boolean) => {
      try {
        const updated = await api.setPreserveNote(id, book, value);
        // Mirror server state locally so the card's chip + checkbox flip on
        // the next render without waiting for a chapter refetch.
        applyLocalRowPatch("tn", id, {
          preserve: updated.preserve,
          updated_at: updated.updated_at,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        pushPipelineToast(`Couldn't update Preserve: ${msg}`, "error");
      }
    },
    [applyLocalRowPatch, pushPipelineToast],
  );

  const handleSetNoteHint = useCallback(
    async (id: string, value: boolean) => {
      try {
        const updated = await api.setHintNote(id, book, value);
        applyLocalRowPatch("tn", id, {
          hint: updated.hint,
          updated_at: updated.updated_at,
        });
      } catch (e) {
        // Prefer the server's human-readable message (e.g. the note_required
        // 400) over the bare "HTTP 400" the ApiError carries as its message.
        const serverMsg = (e as { body?: { message?: string } } | null)?.body?.message;
        const msg = (typeof serverMsg === "string" && serverMsg) || (e instanceof Error ? e.message : "unknown error");
        pushPipelineToast(`Couldn't update Hint: ${msg}`, "error");
      }
    },
    [applyLocalRowPatch, pushPipelineToast],
  );

  // The note delete button. Trash is a reversible, visible soft-delete (the
  // card grays out, drops to the bottom of the verse, gains a Restore button)
  // — the safety net that stands in for a confirmation dialog. Optimistic flip
  // so the card grays instantly; reconcile from the server row; revert on
  // error. Clearing the active note (functional update, no dep on activeNoteId)
  // drops the active highlight off the now-trashed card.
  const handleTrashNote = useCallback(
    async (id: string, opts?: { blankStub?: boolean }) => {
      applyLocalRowPatch("tn", id, { trashed_at: Math.floor(Date.now() / 1000) });
      setActiveNoteId((cur) => (cur === id ? null : cur));
      try {
        const updated = await api.trashNote(id, book, { onlyIfBlankStub: opts?.blankStub });
        applyLocalRowReplacement("tn", updated);
        // Trash bypasses the outbox, so refresh the lint chip directly — a
        // trashed note leaves the lint set (trashed_at IS NULL filter).
        scheduleLintRefetch();
      } catch (e) {
        applyLocalRowPatch("tn", id, { trashed_at: null });
        // The blank-stub auto-discard losing its race is the guard doing its
        // job, not a failure: the row gained content between our decision and
        // the request, so the server refused and we roll the local trash back.
        // The user never asked for this delete, so don't toast at them.
        if (opts?.blankStub && e instanceof ApiError && e.status === 409) return;
        const msg = e instanceof Error ? e.message : "unknown error";
        pushPipelineToast(`Couldn't delete note: ${msg}`, "error");
      }
    },
    [book, applyLocalRowPatch, applyLocalRowReplacement, pushPipelineToast, scheduleLintRefetch],
  );

  const handleRestoreNote = useCallback(
    async (id: string) => {
      applyLocalRowPatch("tn", id, { trashed_at: null });
      try {
        const updated = await api.restoreNote(id, book);
        applyLocalRowReplacement("tn", updated);
        // Restore re-adds the note to the lint set — refresh the chip (the
        // outbox listener won't fire for this direct API call).
        scheduleLintRefetch();
      } catch (e) {
        applyLocalRowPatch("tn", id, { trashed_at: Math.floor(Date.now() / 1000) });
        const msg = e instanceof Error ? e.message : "unknown error";
        pushPipelineToast(`Couldn't restore note: ${msg}`, "error");
      }
    },
    [book, applyLocalRowPatch, applyLocalRowReplacement, pushPipelineToast, scheduleLintRefetch],
  );

  // Async AI-draft lifecycle. State outlives any single NoteCard so the
  // user can scroll away / edit a different note while one is in flight.
  // visibleRowIdsRef tracks which TN cards are currently in viewport so
  // we can route arriving results to either the in-place pulse (visible)
  // or the persistent toast stack (off-screen).
  const aiDrafts = useAiDrafts();
  const visibleRowIdsRef = useRef<Set<string>>(new Set());
  const handleNoteVisibilityChange = useCallback((rowId: string, isVisible: boolean) => {
    if (isVisible) visibleRowIdsRef.current.add(rowId);
    else visibleRowIdsRef.current.delete(rowId);
  }, []);

  // Whether ANY resource row sits on verse 0 (the intro tile). The cheap
  // `.some` re-runs on every edit, but it yields a *stable boolean* so the
  // expensive tileSet below doesn't re-run when a row's text changes.
  const introHasResource = useMemo(
    () =>
      !!data &&
      (data.tn.some((r) => r.verse === 0) ||
        data.tq.some((r) => r.verse === 0) ||
        data.twl.some((r) => r.verse === 0)),
    [data],
  );
  // Does the intro tile actually have Words (TWL) rows? The tw lane is otherwise
  // "always applicable", but verse 0 outside the Psalms usually has none, so the
  // rail should show a "nothing to check" dash there rather than a checkbox.
  const introHasTwl = useMemo(() => !!data && data.twl.some((r) => r.verse === 0), [data]);

  // tileSet runs verseHasUnalignedWork (a full alignment parse) for EVERY
  // verse, so it must not recompute when only a TN/TQ/TWL row changed. Keying
  // it on the verse map + statuses + the intro flag means a note keystroke or
  // save — which leaves data.verses untouched — skips the rescan entirely (and
  // keeps verseNumbers referentially stable, so ScriptureColumn can memo-skip).
  const versesForTiles = data?.verses;
  const verseLaneChecksForTiles = data?.verseLaneChecks;
  const tnRowsForTiles = data?.tn;
  const tqRowsForTiles = data?.tq;
  // verse:lane -> checker user ids, for shading the lane cells.
  const laneIndex = useMemo(
    () => indexLaneChecks(verseLaneChecksForTiles ?? []),
    [verseLaneChecksForTiles],
  );
  // Which verses actually have notes / questions — drives "nothing to check"
  // (N/A) vs an unchecked lane.
  // Add every verse a row covers, not just its leading verse, so a bridged note
  // ("1:2-3") makes the Notes/Questions checkoff lane applicable on each verse
  // it renders under — matching noteOverlapsRange in ResourceColumn. Singletons
  // contribute one verse, the common case.
  const versesWithTn = useMemo(() => {
    const s = new Set<number>();
    for (const r of tnRowsForTiles ?? []) for (const v of noteCoveredVerses(r)) s.add(v);
    return s;
  }, [tnRowsForTiles]);
  const versesWithTq = useMemo(() => {
    const s = new Set<number>();
    for (const r of tqRowsForTiles ?? []) for (const v of noteCoveredVerses(r)) s.add(v);
    return s;
  }, [tqRowsForTiles]);
  const tileSet = useMemo<VerseTile[]>(() => {
    if (!versesForTiles) return [];
    const versesWithSomething = new Set<number>();
    Object.values(versesForTiles).forEach((byVerse) => {
      Object.keys(byVerse).forEach((v) => versesWithSomething.add(parseInt(v, 10)));
    });
    const sourceByVerse = versesForTiles.UHB ?? versesForTiles.UGNT ?? {};
    const ult = versesForTiles.ULT ?? {};
    const ust = versesForTiles.UST ?? {};
    const getVO = (dto: VerseDto | undefined) => {
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    const hasUnalignedFor = (verse: number) => {
      if (verse === 0) return false;
      const sourceVO = getVO(sourceByVerse[verse]);
      const ultVO = getVO(ult[verse]);
      if (ultVO && verseHasUnalignedWork(ultVO, sourceVO)) return true;
      const ustVO = getVO(ust[verse]);
      if (ustVO && verseHasUnalignedWork(ustVO, sourceVO)) return true;
      return false;
    };
    const introHasScripture = versesWithSomething.has(0);
    const buildLanes = (verse: number): VerseTileLane[] =>
      CHECK_LANES.map((lane) => {
        // text/tw are "always applicable" for real verses, but the intro tile
        // (verse 0) only has them when intro scripture / TWL rows actually exist.
        const applicable =
          verse === 0
            ? lane === "text"
              ? introHasScripture
              : lane === "tw"
                ? introHasTwl
                : laneApplicable(lane, versesWithTn.has(0), versesWithTq.has(0))
            : laneApplicable(lane, versesWithTn.has(verse), versesWithTq.has(verse));
        const checkers = laneIndex.get(laneKey(verse, lane));
        const shade: LaneShade = applicable ? shadeFromCheckers(checkers, meUserId) : "open";
        const title = `${LANE_LABELS[lane]} — ${applicable ? laneAttribution(checkers, meUserId) : "nothing to check"}`;
        return { lane, shade, applicable, title };
      });
    // Chapter-front USFM content (Psalm \d superscriptions, leading \p before \v 1)
    // is stored as verse 0 in the verses table. Surface the intro tile when any of
    // those exist even if no TN/TQ/TWL row is attached to verse 0.
    //
    // ...and ALSO when the chapter opens with no paragraph / poetry marker at all
    // (#378). That case has, by definition, no verse-0 row to detect — and if
    // neither translation has one and no note sits on the intro, none of the
    // conditions above fire, so there would be no intro tile, no editable intro
    // cell, and therefore no way to add the marker the lint is flagging. The flag
    // would be permanently unresolvable in the app. Offering the slot exactly when
    // something needs fixing keeps this from adding a tile to every chapter.
    const introMarkerMissing = (["ULT", "UST"] as const).some((bv) => {
      const byVerse = versesForTiles[bv];
      if (!byVerse) return false;
      return chapterOpensWithoutMarker(getVO(byVerse[0]), getVO(byVerse[1]));
    });
    const tiles: VerseTile[] = [];
    if (introHasResource || introHasScripture || introMarkerMissing) {
      tiles.push({ verse: 0, has: false, lanes: buildLanes(0) });
    }
    const verseNums = [...versesWithSomething].filter((v) => v > 0).sort((a, b) => a - b);
    for (const v of verseNums) tiles.push({ verse: v, has: hasUnalignedFor(v), lanes: buildLanes(v) });
    return tiles;
  }, [versesForTiles, laneIndex, versesWithTn, versesWithTq, meUserId, introHasResource, introHasTwl]);

  // Which alignment-attention refs (from the last nightly export) are already
  // fixed in the currently loaded chapter — re-parsed against live verse
  // content so the topbar badge stops nagging about verses the translator
  // has since re-aligned. Only evaluates refs for the loaded chapter; refs in
  // other chapters of the book stay in the badge until that chapter loads.
  // Keyed on versesForTiles (not `data`) for the same reason as tileSet above:
  // a note/TQ/TWL edit must not re-trigger this alignment parse.
  const alignAttentionResolvedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!versesForTiles || data?.chapter == null) return keys;
    const getVO = (dto: VerseDto | undefined) => {
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    const sourceByVerse = versesForTiles.UHB ?? versesForTiles.UGNT ?? {};
    const targetsByResource: Record<"ult" | "ust", Record<number, VerseDto>> = {
      ult: versesForTiles.ULT ?? {},
      ust: versesForTiles.UST ?? {},
    };
    for (const ref of alignAttention.refs) {
      if (ref.chapter !== data.chapter) continue;
      const targetVO = getVO(targetsByResource[ref.resource]?.[ref.verse]);
      if (!targetVO) continue;
      const sourceVO = getVO(sourceByVerse[ref.verse]);
      if (!verseHasUnalignedWork(targetVO, sourceVO)) {
        keys.add(`${ref.resource}:${ref.ref}`);
      }
    }
    return keys;
  }, [versesForTiles, data?.chapter, alignAttention.refs]);

  // Book locks: fetched once here (not per-chapter) so the read-only switch
  // below and the admin dialog both see the same list. Declared ahead of
  // toggleLane/confirmBulk below (both close over `bookLocked`), and ahead of
  // the JSX render further down (both scripture/resource columns need it).
  const bookLocks = useBookLocks(authReady);
  const [bookLocksDialogOpen, setBookLocksDialogOpen] = useState(false);
  const currentBookLock = bookLocks.books.find((b) => b.book === book) ?? null;

  // Module-level flag that blocks the actual write (api.ts throws on
  // request(), so every outbox.enqueue* short-circuits). That alone doesn't
  // remove the editing AFFORDANCE — a translator could still type, watch it
  // render, and have it silently discarded. `bookLocked` below is threaded
  // into every prop that already disables editing (ScriptureColumn,
  // ResourceColumn → NoteCard/QuestionsTable/WordsTable, find/replace, the
  // lane toggles) so the UI matches what the server will actually accept.
  // Cleared on unmount so leaving Shell (e.g. during sign-out) doesn't
  // strand the app read-only.
  const bookLocked = bookLocks.lockedSet.has(book);
  useEffect(() => {
    setReadOnlyReason("bookLocked", bookLocked);
    return () => setReadOnlyReason("bookLocked", false);
  }, [bookLocked]);

  // Toggle MY checkoff stamp on a (verse, lane): optimistic + outbox (offline-safe).
  const toggleLane = useCallback(
    (verse: number, lane: CheckLane) => {
      if (meUserId == null) return;
      // The server rejects this write on a locked book (bookLocked also
      // blocks it at the outbox layer via setReadOnlyReason above), so
      // bail before the optimistic apply — otherwise the checkbox flips
      // and then silently reverts once the write is dropped.
      if (bookLocked) return;
      const checkers = laneIndex.get(laneKey(verse, lane));
      const next = !(checkers?.includes(meUserId));
      applyLocalLaneCheck(verse, lane, meUserId, next);
      void outbox.enqueueLaneCheck(book, chapter, verse, lane, next);
    },
    [book, chapter, meUserId, laneIndex, applyLocalLaneCheck, bookLocked],
  );

  // Bulk "all this chapter" for a lane. A fat-finger guard: clicking "all" only
  // REQUESTS the action (opens a confirm); nothing is written until confirmed.
  // Direction: check every applicable verse unless I've already checked them
  // all, in which case clear mine.
  const [pendingBulk, setPendingBulk] = useState<{ lane: CheckLane; checked: boolean; verses: number[] } | null>(null);
  const bulkLaneToggle = useCallback(
    (lane: CheckLane) => {
      if (meUserId == null) return;
      const verses = tileSet
        .filter((t) => t.lanes.find((l) => l.lane === lane)?.applicable)
        .map((t) => t.verse);
      if (verses.length === 0) return;
      const allMine = verses.every((v) => laneIndex.get(laneKey(v, lane))?.includes(meUserId));
      setPendingBulk({ lane, checked: !allMine, verses });
    },
    [meUserId, tileSet, laneIndex],
  );
  // Run the confirmed bulk: optimistic apply + one direct PATCH (deliberate,
  // online action), reconciled from the server response.
  const confirmBulk = useCallback(() => {
    const p = pendingBulk;
    setPendingBulk(null);
    if (!p || meUserId == null) return;
    // Same reasoning as toggleLane: the bulk PATCH will 423 on a locked
    // book, so skip the optimistic apply rather than flip every checkbox
    // in the chapter and then silently revert them.
    if (bookLocked) return;
    for (const v of p.verses) applyLocalLaneCheck(v, p.lane, meUserId, p.checked);
    void api
      .setLaneCheckBulk(book, chapter, p.lane, p.checked, p.verses)
      .then((res) => replaceLaneChecksForLane(p.lane, res.checks))
      .catch(() => {
        /* leave optimistic state; a later load reconciles */
      });
  }, [pendingBulk, book, chapter, meUserId, applyLocalLaneCheck, replaceLaneChecksForLane, bookLocked]);

  // In-context checkoff for the resource panels, scoped to the active verse.
  const resourceCheckoff = useMemo<ResourceCheckoff>(() => {
    const applic = (lane: ResourceLane) =>
      laneApplicable(lane, versesWithTn.has(activeVerse), versesWithTq.has(activeVerse));
    const checkersOf = (lane: ResourceLane) => laneIndex.get(laneKey(activeVerse, lane));
    return {
      // A locked book freezes QA checkoff too. Gating `canCheck` here rather
      // than in each consumer is what actually removes the affordance: the
      // resource panel's `done` and `all` controls render off this flag alone,
      // so disabling only TimelineRail/ChapterBoard left a third live surface
      // whose clicks hit the handler's early return and silently did nothing.
      canCheck: meUserId != null && !bookLocked,
      applicable: applic,
      shade: (lane) => (applic(lane) ? shadeFromCheckers(checkersOf(lane), meUserId) : "open"),
      attribution: (lane) => laneAttribution(checkersOf(lane), meUserId),
      onToggle: (lane) => toggleLane(activeVerse, lane),
      onBulkToggle: (lane) => bulkLaneToggle(lane),
    };
  }, [activeVerse, laneIndex, versesWithTn, versesWithTq, meUserId, bookLocked, toggleLane, bulkLaneToggle]);

  // Text-lane checkoff for the column/book scripture views (per verse). Text is
  // always applicable. Memoized so BookView's memoized verse subtree is stable.
  const textLaneCheck = useMemo<TextLaneCheck>(
    () => ({
      // Same reasoning as resourceCheckoff above — a locked book must not
      // offer the Text-lane checkbox either.
      canCheck: meUserId != null && !bookLocked,
      shade: (verse) => shadeFromCheckers(laneIndex.get(laneKey(verse, "text")), meUserId),
      attribution: (verse) => laneAttribution(laneIndex.get(laneKey(verse, "text")), meUserId),
      onToggle: (verse) => toggleLane(verse, "text"),
    }),
    [laneIndex, meUserId, bookLocked, toggleLane],
  );

  // Chapter board (verses × lanes overview) dialog.
  const [boardOpen, setBoardOpen] = useState(false);

  const verseNumbers = useMemo(
    () => tileSet.map((t) => t.verse),
    [tileSet],
  );

  const availableVersions = useMemo(() => {
    const set = new Set<string>(versesForTiles ? Object.keys(versesForTiles) : []);
    // Book mode spans the whole book, so the version set must not collapse when
    // the active chapter is a front-matter chapter (chapter 0) that carries
    // notes but no scripture verses — Find can navigate there (the book-intro
    // note sorts first). Without the union, availableVersions is [] →
    // displayedVersions is [] → BookView renders no columns and every chapter's
    // verseNums is empty: a blank book view that looks like the app crashed.
    if (mode === "book" && bookHook) {
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind !== "ready") continue;
        for (const v of Object.keys(cs.data.verses)) set.add(v);
      }
    }
    return [...set];
  }, [versesForTiles, mode, bookHook?.chapters]);

  // Range-aware lookup: ChapterPayload.verses is keyed by verse_start, so a
  // row anchored mid-bridge (e.g. verse 9 of a `\v 8-9` row) misses a direct
  // verses[bv][row.verse] read. Built once per verses change and shared by
  // the quote-builder / note-anchoring lookups below.
  const verseIndexByVersion = useMemo(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    if (versesForTiles) {
      for (const bv of Object.keys(versesForTiles)) {
        out[bv] = buildVerseIndex(versesForTiles[bv]);
      }
    }
    return out;
  }, [versesForTiles]);

  // ULT verse objects for a verse in the current chapter — feeds ResourceColumn's
  // canonical TWL ordering (by Hebrew/Greek word position in the aligned ULT).
  // Stable identity (only changes when the verse index does) so the twl memos
  // recompute the ULT walk once per alignment change, not on every render.
  const ultVerseObjectsFor = useCallback(
    (verse: number): unknown[] | null => {
      const vo = (verseIndexByVersion["ULT"]?.[verse]?.content as { verseObjects?: unknown[] } | null)
        ?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    },
    [verseIndexByVersion],
  );

  // The widest range row across all versions that covers activeVerse. Used to
  // scope TN/TQ/TWL filtering in ResourceColumn — if UST 6-9 covers the active
  // verse, the user sees notes for verses 6-9, not just the navigated one.
  // For singletons (the common case) this reduces to [activeVerse, activeVerse].
  const displayVerseRange = useMemo<readonly [number, number]>(() => {
    if (!versesForTiles || activeVerse === 0) return [activeVerse, activeVerse] as const;
    let start = activeVerse;
    let end = activeVerse;
    for (const byVerse of Object.values(versesForTiles)) {
      for (const k of Object.keys(byVerse)) {
        const dto = byVerse[Number(k)];
        if (!dto) continue;
        const rEnd = dto.verse_end ?? dto.verse;
        if (dto.verse <= activeVerse && activeVerse <= rEnd) {
          if (dto.verse < start) start = dto.verse;
          if (rEnd > end) end = rEnd;
        }
      }
    }
    return [start, end] as const;
  }, [versesForTiles, activeVerse]);

  const visibleVersions = useMemo(
    () => enabledVersions.filter((v) => availableVersions.includes(v)),
    [enabledVersions, availableVersions],
  );

  // The version set actually shown (falls back to the first available when the
  // user has none enabled). Memoized so its identity is stable across row
  // edits — it's the `enabledVersions` prop ScriptureColumn's memo compares.
  const displayedVersions = useMemo(
    () => (visibleVersions.length > 0 ? visibleVersions : availableVersions.slice(0, 1)),
    [visibleVersions, availableVersions],
  );

  const colsVisible = displayedVersions.length;
  const autoSplit = mode === "columns" ? Math.min(0.75, 0.55 + (colsVisible - 1) * 0.05) : 0.5;
  const effectiveSplit = splitRatio ?? autoSplit;

  // Book-mode chapter list, memoized so ScriptureColumn isn't handed a fresh
  // array on every render (stacked / columns pass undefined — already stable).
  const bookChapterList = useMemo(
    () =>
      bookHook && mode === "book"
        ? (bookHook.summary?.chapters ?? []).map((c) => c.chapter)
        : undefined,
    [bookHook, mode, bookHook?.summary],
  );
  useEffect(() => { setSplitRatio(null); }, [colsVisible, mode]);
  useEffect(() => () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; }, []);
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const available = rect.width - railWidth;
      const offset = ev.clientX - rect.left - railWidth;
      setSplitRatio(Math.min(0.8, Math.max(0.2, offset / available)));
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [railWidth]);

  // Pre-load lexicon entries for every UHB Strong's in the loaded chapter
  // AND every loaded chapter in book mode, so the per-word tooltips in the
  // scripture column don't have to fetch on first hover. useLexicon
  // dedupes at module level, so passing this repeatedly is cheap.
  const uhbStrongs = useMemo(() => {
    const set = new Set<string>();
    const collect = (verses: Record<number, VerseDto> | undefined) => {
      if (!verses) return;
      for (const v of Object.values(verses)) {
        const objs = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
        if (Array.isArray(objs)) for (const s of collectStrongs(objs)) set.add(s);
      }
    };
    collect(data?.verses?.UHB);
    if (bookHook) {
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind !== "ready") continue;
        collect(cs.data.verses?.UHB);
      }
    }
    return [...set];
  }, [data?.verses, bookHook?.chapters]);
  const lexiconMapRaw = useLexicon(uhbStrongs);
  // useLexicon hands back a fresh Map every render; stabilize its identity so
  // ScriptureColumn's memo can compare it. The map's CONTENT only changes when
  // a Strong's entry resolves, which bumps lexiconLoadedCount and rebases it.
  const lexiconLoadedCount = useMemo(() => {
    let c = 0;
    for (const v of lexiconMapRaw.values()) if (v) c++;
    return c;
  }, [lexiconMapRaw]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lexiconMap = useMemo(() => lexiconMapRaw, [uhbStrongs, lexiconLoadedCount]);

  // When a tn note OR a twl word row is "active", treat its quote as the
  // highlight source. Notes and words are mutually exclusive; clicking one
  // clears the other. Words use `orig_words` (Hebrew source words) which the
  // same matcher handles directly for UHB and via \zaln-s for ULT/UST.
  const { activeQuote, activeOccurrence } = useMemo(() => {
    if (!data) return { activeQuote: null, activeOccurrence: null };
    if (activeNoteId) {
      const r = data.tn.find((r) => r.id === activeNoteId);
      return { activeQuote: r?.quote ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    if (activeWordId) {
      const r = data.twl.find((r) => r.id === activeWordId);
      return { activeQuote: r?.orig_words ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    return { activeQuote: null, activeOccurrence: null };
  }, [activeNoteId, activeWordId, data]);

  // Reorder "stoplight": while a note is dragged (or for ~3s after an arrow
  // move) ResourceColumn reports the moved note's candidate neighbours; we
  // resolve their quotes and hand them to the scripture column so the active
  // verse lights prev (green underline) / next (red overline) alongside the
  // moved note's existing yellow fill.
  const [reorderPreview, setReorderPreview] = useState<ReorderPreview | null>(null);
  const reorderPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reorderStickyRef = useRef(false);
  const handleReorderPreview = useCallback((preview: ReorderPreview | null, sticky?: boolean) => {
    // A live (non-sticky) clear — drag end or hover-leave — must not wipe a
    // sticky arrow-move preview that's still counting down.
    if (preview === null && !sticky && reorderStickyRef.current) return;
    if (reorderPreviewTimer.current) {
      clearTimeout(reorderPreviewTimer.current);
      reorderPreviewTimer.current = null;
    }
    reorderStickyRef.current = !!(preview && sticky);
    setReorderPreview(preview);
    // Live previews (drag held / grip-or-arrow hover) pass sticky=false and are
    // cleared on release/leave; arrow moves are momentary, so they linger 5s.
    if (preview && sticky) {
      reorderPreviewTimer.current = setTimeout(() => {
        setReorderPreview(null);
        reorderStickyRef.current = false;
        reorderPreviewTimer.current = null;
      }, 5000);
    }
  }, []);
  useEffect(
    () => () => {
      if (reorderPreviewTimer.current) clearTimeout(reorderPreviewTimer.current);
    },
    [],
  );
  const reorderHighlight = useMemo<ReorderHighlight | null>(() => {
    if (!data || !reorderPreview) return null;
    // Notes AND word links: the ids in a preview come from whichever table the
    // user is reordering. A TWL row's source quote lives in `orig_words` rather
    // than `quote`, but it is the same kind of value — an original-language
    // quote the highlight path resolves against the source and maps through the
    // alignment — so one lookup serves both. Ids are unique per book across
    // kinds, so checking tn first and falling through to twl can't collide.
    const find = (id: string | null): { quote: string | null; occurrence: number | null } | null => {
      if (!id) return null;
      const note = data.tn.find((r) => r.id === id);
      if (note) return { quote: note.quote, occurrence: note.occurrence };
      const word = data.twl.find((r) => r.id === id);
      if (word) return { quote: word.orig_words, occurrence: word.occurrence };
      return null;
    };
    const moved = find(reorderPreview.movedId);
    const prev = find(reorderPreview.prevId);
    const next = find(reorderPreview.nextId);
    if (!moved && !prev && !next) return null;
    return {
      movedQuote: moved?.quote ?? null,
      movedOccurrence: moved?.occurrence ?? null,
      prevQuote: prev?.quote ?? null,
      prevOccurrence: prev?.occurrence ?? null,
      nextQuote: next?.quote ?? null,
      nextOccurrence: next?.occurrence ?? null,
    };
  }, [data, reorderPreview]);

  // Quote-builder session: when active, clicking Hebrew words in the UHB
  // row of the active verse toggles them into selectedKeys; "Use selection"
  // converts the set into the row's source quote + occurrence. The target is
  // either a TN note (writes quote/occurrence) or a TWL link (writes
  // orig_words/occurrence). Tied to a specific row so switching selection
  // cancels the session.
  const [quoteBuildTarget, setQuoteBuildTarget] = useState<
    { kind: "tn" | "twl"; id: string } | null
  >(null);
  const [quoteBuildSelectedKeys, setQuoteBuildSelectedKeys] = useState<Set<HighlightKey>>(
    () => new Set(),
  );
  // Commit signal handed to the note card. The card is still active when the
  // picker commits, so its row→quote sync effect is gated by the open session
  // guard; bumping this nonce after the optimistic row patch tells that card
  // to pull the built quote into its local state. nonce increments per commit
  // so re-building the same note twice still fires the effect. (TWL word rows
  // re-seed via their own row→state effect on the optimistic patch, so they
  // don't need this signal.)
  const [quoteBuildAppliedTo, setQuoteBuildAppliedTo] = useState<
    { noteId: string; nonce: number } | null
  >(null);
  useEffect(() => {
    if (!quoteBuildTarget) return;
    const stillActive =
      quoteBuildTarget.kind === "tn"
        ? activeNoteId === quoteBuildTarget.id
        : activeWordId === quoteBuildTarget.id;
    if (!stillActive) {
      setQuoteBuildTarget(null);
      setQuoteBuildSelectedKeys(new Set());
    }
  }, [activeNoteId, activeWordId, quoteBuildTarget]);
  const toggleQuoteBuildWord = useCallback(
    (key: HighlightKey) => {
      setQuoteBuildSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [],
  );
  // Additive multi-select for shift-click range selection in the picker —
  // adds every key in the dragged range without toggling any already-selected
  // word back off (range select is "extend the selection," not "toggle each").
  const selectQuoteBuildWords = useCallback((keys: HighlightKey[]) => {
    setQuoteBuildSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);
  const startQuoteBuild = useCallback(
    (target: { kind: "tn" | "twl"; id: string }) => {
      setQuoteBuildTarget(target);
      // Pre-seed the selection from the row's existing quote so the translator
      // can ADD to it instead of starting over. Resolves the stored quote +
      // occurrence against the UHB/UGNT verse; an unresolvable quote (e.g.
      // hand-typed English) yields an empty set and the picker starts fresh.
      const row =
        target.kind === "tn"
          ? data?.tn.find((r) => r.id === target.id)
          : data?.twl.find((r) => r.id === target.id);
      const uhb = row
        ? verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse]
        : undefined;
      const verseObjects = (uhb?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      // TN stores its source quote in `quote`; TWL stores it in `orig_words`.
      const existingQuote =
        target.kind === "tn" ? (row as TnRow | undefined)?.quote : (row as TwlRow | undefined)?.orig_words;
      setQuoteBuildSelectedKeys(
        row ? selectionFromQuote(verseObjects, existingQuote, row.occurrence) : new Set(),
      );
    },
    [data, verseIndexByVersion],
  );
  const cancelQuoteBuild = useCallback(() => {
    setQuoteBuildTarget(null);
    setQuoteBuildSelectedKeys(new Set());
  }, []);

  // Anchor element for the picker popup. Resolves via the data-note-id
  // attribute set on each NoteCard's Paper — the picker mounts at Shell
  // level so it isn't clipped by the resource column overflow.
  const [quoteBuildAnchor, setQuoteBuildAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!quoteBuildTarget) {
      setQuoteBuildAnchor(null);
      return;
    }
    const selector =
      quoteBuildTarget.kind === "tn"
        ? `[data-note-id="${quoteBuildTarget.id}"]`
        : `[data-word-id="${quoteBuildTarget.id}"]`;
    setQuoteBuildAnchor(document.querySelector<HTMLElement>(selector));
  }, [quoteBuildTarget]);

  // Verse objects bundled for the picker — UHB always; ULT/UST may be
  // absent for OT-only or NT-only deployments, so default to null and
  // let the picker show an empty-state hint.
  const quoteBuildContext = useMemo(() => {
    if (!quoteBuildTarget || !data) return null;
    const row =
      quoteBuildTarget.kind === "tn"
        ? data.tn.find((r) => r.id === quoteBuildTarget.id)
        : data.twl.find((r) => r.id === quoteBuildTarget.id);
    if (!row) return null;
    const grab = (bv: string): unknown[] | null => {
      const dto = verseIndexByVersion[bv]?.[row.verse];
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    return {
      verse: row.verse,
      uhb: grab("UHB") ?? grab("UGNT"),
      ult: grab("ULT"),
      ust: grab("UST"),
    };
  }, [quoteBuildTarget, data, verseIndexByVersion]);

  // Materialize the in-flight quote-build selection into a row patch and
  // fire the existing note save pipe. Pulls UHB verseObjects for the
  // current verse — the buildQuoteFromSelection helper does the grouping
  // and " & " join + occurrence calculation.
  const commitQuoteBuild = useCallback(() => {
    if (!quoteBuildTarget || !data) return;
    const row =
      quoteBuildTarget.kind === "tn"
        ? data.tn.find((r) => r.id === quoteBuildTarget.id)
        : data.twl.find((r) => r.id === quoteBuildTarget.id);
    if (!row) return;
    const uhb = verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse];
    const verseObjects =
      (uhb?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return;
    const built = buildQuoteFromSelection(verseObjects, quoteBuildSelectedKeys);
    if (!built) return;
    // Only enqueue a save when the build actually changes the stored quote +
    // occurrence — re-running "build from source" over an unchanged selection
    // (or a quote that was itself built this way) must not bump the row version.
    // Compare quotes NFC-normalized: the builder emits raw UHB legacy
    // combining-mark order, while a stored quote may be NFC (typed / AI), so a
    // raw compare would false-positive on visually-identical text — same nfc()
    // rule the highlighter uses. A null stored occurrence means "first", == 1.
    if (quoteBuildTarget.kind === "tn") {
      const note = row as TnRow;
      const changed =
        nfc(built.quote) !== nfc(note.quote ?? "") || built.occurrence !== (note.occurrence ?? 1);
      if (changed) {
        // Optimistic row patch first so row.quote is current for the box-sync below.
        enqueueRow("tn", note, { quote: built.quote, occurrence: built.occurrence });
      }
      // Always signal the card (which stays active) to force the box to the
      // committed quote and rebaseline the session snapshot — the row→box sync
      // effect is otherwise gated by the open session. Idempotent on a true
      // no-op, and on a no-op over unsaved box edits it still lands the quote the
      // user just committed (don't gate this on `changed`).
      setQuoteBuildAppliedTo((prev) => ({ noteId: note.id, nonce: (prev?.nonce ?? 0) + 1 }));
    } else {
      // TWL: the source quote lives in orig_words. The WordRow re-seeds from the
      // optimistic patch (its row→state effect isn't session-gated), so no
      // applied-nonce signal is needed.
      const word = row as TwlRow;
      const changed =
        nfc(built.quote) !== nfc(word.orig_words ?? "") || built.occurrence !== (word.occurrence ?? 1);
      if (changed) {
        enqueueRow("twl", word, { orig_words: built.quote, occurrence: built.occurrence });
      }
    }
    setQuoteBuildTarget(null);
    setQuoteBuildSelectedKeys(new Set());
  }, [quoteBuildTarget, quoteBuildSelectedKeys, data, verseIndexByVersion]);

  // Promote a per-verse TWL suggestion to a real link. Resolve its matched ULT
  // English span to an OL quote + occurrence against the verse alignment
  // (best-effort), create the twl row, and — when the resolution is unsure or
  // empty — open the quote-builder on the new row so the editor confirms. Always
  // goes through createRow("twl") so chapter locks / concurrency are respected.
  const handleAddTwlSuggestion = useCallback(
    async (s: TwlSuggestion, chosenArticleId: string) => {
      if (!data) return;
      const verse = activeVerse;
      const grab = (bv: string): unknown[] | undefined => {
        const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
          ?.verseObjects;
        return Array.isArray(vo) ? vo : undefined;
      };
      const ult = grab("ULT");
      const uhb = grab("UHB") ?? grab("UGNT");
      const resolved = resolveSpanToSource(ult, uhb, s.matchedText, s.glOccurrence);

      const twLink = `rc://*/tw/dict/bible/${chosenArticleId}`;
      // Tag follows the CHOSEN article's category, not the server's primary — a
      // disambiguation pick can cross categories (e.g. kt/lawofmoses vs other/law),
      // and the TWL Tags column must match the link actually written.
      const chosenCategory = chosenArticleId.split("/")[0];
      const tag =
        chosenCategory === "kt" ? "keyterm" : chosenCategory === "names" ? "name" : "";
      // Drop the new link into its CANONICAL slot (by Hebrew word position in the
      // aligned ULT), not at the end. Display is already canonical, but assigning
      // a matching sort_order keeps D1 consistent with what export/reimport
      // compute — no churn. Place the stub among the verse's rows via the shared
      // canonical order, then pick a sort_order relative to its canonical
      // neighbour. Falls back to append-at-end when nothing resolves / no ULT.
      const list = sortedForVerse(data.twl, verse);
      const STUB = "__new_twl__";
      const newOrigWords = resolved?.orig_words ?? "";
      const newOccurrence = resolved?.occurrence ?? 1;
      // tw_link must ride along (and the stub carries the article being added):
      // the anchor tier that matches the TW headword is looked up BY link, so
      // dropping it would silently demote every row to the function-word
      // fallback and place the new link next to the wrong neighbour.
      const withNew = canonicalTwlOrder(
        [
          ...list.map((r) => ({
            id: r.id,
            orig_words: r.orig_words,
            occurrence: r.occurrence,
            sort_order: r.sort_order,
            tw_link: r.tw_link,
          })),
          {
            id: STUB,
            orig_words: newOrigWords,
            occurrence: newOccurrence,
            sort_order: null,
            tw_link: twLink,
          },
        ],
        ult ?? null,
        twTitles,
      );
      const at = withNew.findIndex((r) => r.id === STUB);
      const prev = at > 0 ? withNew[at - 1] : null;
      const next = at >= 0 && at < withNew.length - 1 ? withNew[at + 1] : null;
      // Which list the midpoint is measured against. Automatic verse: the
      // canonical order, so the stored sort_order matches what export/reimport
      // compute. MANUAL verse: the human's order — we still use canonical
      // ordering to pick WHICH neighbour the new link belongs beside (that's
      // the useful judgement), but we slot it into the order the human built
      // rather than re-deriving one they've already overridden.
      const slotList = lockedTwlVerses.has(verse)
        ? manualTwlOrder(list)
        : canonicalTwlOrder(list, ult ?? null, twTitles);
      const sort_order =
        list.length === 0
          ? 100
          : prev
            ? pickSortOrder(slotList, prev.id, "after")
            : next
              ? pickSortOrder(slotList, next.id, "before")
              : pickSortOrder(list, null, "after");
      const created = await api.createRow<TwlRow>("twl", {
        book,
        chapter,
        verse,
        ref_raw:
          chapter === 0 ? "front:intro" : verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`,
        orig_words: resolved?.orig_words ?? "",
        occurrence: resolved?.occurrence ?? 1,
        tw_link: twLink,
        ...(tag ? { tags: tag } : {}),
        sort_order,
      });
      applyLocalRowInsert("twl", created);
      setActiveWordId(created.id);
      setActiveNoteId(null);
      setActiveQuestionId(null);
      // Low-confidence (or nothing resolved) → open the picker on the new row so
      // the editor verifies/completes the quote. Seed the selection directly from
      // what DID resolve, NOT by re-finding the row via startQuoteBuild — the
      // just-inserted row isn't in `data` yet (applyLocalRowInsert's setState
      // hasn't flushed), so a row lookup would pre-seed empty. quoteBuildContext +
      // the anchor effect pick the row up on the next render.
      if (!resolved || !resolved.confident || !resolved.orig_words) {
        setQuoteBuildTarget({ kind: "twl", id: created.id });
        setQuoteBuildSelectedKeys(
          selectionFromQuote(uhb, resolved?.orig_words, resolved?.occurrence),
        );
      }
    },
    [data, activeVerse, verseIndexByVersion, book, chapter, twTitles, lockedTwlVerses],
  );

  // Whether a per-verse suggestion is already covered on the active verse. Done
  // client-side (not on the suggest route) because the match is by RESOLVED
  // original-language identity, which the server can't derive from the English
  // text without the alignment. The tw_link is intentionally ignored: once a word
  // carries any TWL we don't suggest a second article for it. Single words match
  // by source key (occurrence-anchored, tolerant of aligner-folded particles), so
  // occurrence 2 still gets suggested when only occurrence 1 is linked; multi-word
  // phrases are kept unless the identical phrase quote is already linked.
  const isTwlSuggestionExcluded = useCallback(
    (s: TwlSuggestion): boolean => {
      if (!data) return false;
      const verse = activeVerse;
      const grab = (bv: string): unknown[] | undefined => {
        const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
          ?.verseObjects;
        return Array.isArray(vo) ? vo : undefined;
      };
      const uhb = grab("UHB") ?? grab("UGNT");
      const resolved = resolveSpanToSource(grab("ULT"), uhb, s.matchedText, s.glOccurrence);
      // Deleted deny-list: this reference + quote was deleted upstream (any
      // article — the table is article-agnostic). Applies regardless of whether
      // the verse currently carries any links, so it runs before the rows check.
      if (resolved && twlFilters.isDeletedHere(`${chapter}:${verse}`, resolved.orig_words)) {
        return true;
      }
      const rows = data.twl.filter((r) => r.verse === verse && r.deleted_at == null);
      if (rows.length === 0) return false;
      // Couldn't resolve to OL — conservatively drop only an exact tw_link repeat.
      if (!resolved) return rows.some((r) => r.tw_link === s.twLink);
      // A multi-word phrase (e.g. "Yahweh of Armies") is its own lexical unit:
      // suggest it even when a component word is already tagged. Only drop it when
      // the identical phrase quote is already linked.
      if (/\s/.test(s.matchedText.trim())) {
        const key = `${nfc(resolved.orig_words)}|${resolved.occurrence}`;
        return rows.some((r) => `${nfc(r.orig_words ?? "")}|${r.occurrence ?? 1}` === key);
      }
      // Single word: once THIS occurrence of the word carries any TWL we don't
      // suggest a second article for it (regardless of article). Compare by source
      // KEY (position/occurrence-anchored) rather than the quote string: the key
      // survives a particle the aligner folds into the quote ("אֶת־יִשְׂרָאֵל" vs the
      // stored "יִשְׂרָאֵל"), while still distinguishing occurrence 2 from occurrence 1.
      const sugKeys = selectionFromQuote(uhb, resolved.orig_words, resolved.occurrence);
      if (sugKeys.size === 0) return false;
      return rows.some((r) => {
        for (const k of selectionFromQuote(uhb, r.orig_words, r.occurrence ?? 1)) {
          if (sugKeys.has(k)) return true;
        }
        return false;
      });
    },
    [data, activeVerse, verseIndexByVersion, chapter, twlFilters],
  );

  // Raw per-verse TWL suggestions for the active verse, reported up from the
  // Suggestions panel (before its exclusion filter). Used to merge the matcher's
  // candidate articles back onto committed rows — see twlRowAlternatives.
  const [verseTwlSuggestions, setVerseTwlSuggestions] = useState<TwlSuggestion[]>([]);

  // Extra TW articles the per-verse matcher would propose for a committed row's
  // source word(s), keyed by row id. The committed-row disambiguation badge
  // otherwise only offers heading-synonym siblings of the current link (built
  // from article titles, variant-blind), so a wrong link like kt/love on
  // "lovers" can't reach the morphologically-correct other/lover. Matching the
  // matcher's suggestions back onto the row by source-key surfaces it. Values are
  // short article ids (e.g. "other/lover").
  const twlRowAlternatives = useMemo<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>();
    if (!data || verseTwlSuggestions.length === 0) return map;
    const verse = activeVerse;
    const grab = (bv: string): unknown[] | undefined => {
      const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
        ?.verseObjects;
      return Array.isArray(vo) ? vo : undefined;
    };
    const ult = grab("ULT");
    const uhb = grab("UHB") ?? grab("UGNT");
    const rows = data.twl.filter((r) => r.verse === verse && r.deleted_at == null);
    if (rows.length === 0) return map;
    // Resolve each suggestion once to its source-key set + candidate ids, and
    // reapply the same deny-lists the Suggestions panel uses — otherwise a word
    // deleted-here, or a (word, article) pair a translator specifically
    // unlinked, would resurface as a "suggested" alternative on the row.
    const sugs = verseTwlSuggestions
      .map((s) => {
        const resolved = resolveSpanToSource(ult, uhb, s.matchedText, s.glOccurrence);
        if (!resolved) return null;
        if (twlFilters.isDeletedHere(`${chapter}:${verse}`, resolved.orig_words)) return null;
        const keys = selectionFromQuote(uhb, resolved.orig_words, resolved.occurrence);
        if (keys.size === 0) return null;
        const ids = s.disambiguation.filter(
          (id) => !twlFilters.isUnlinked(resolved.orig_words, `rc://*/tw/dict/bible/${id}`),
        );
        return ids.length > 0 ? { keys, ids } : null;
      })
      .filter((x): x is { keys: Set<string>; ids: string[] } => x != null);
    for (const r of rows) {
      const rowKeys = selectionFromQuote(uhb, r.orig_words, r.occurrence ?? 1);
      if (rowKeys.size === 0) continue;
      const ids = new Set<string>();
      for (const s of sugs) {
        let overlap = false;
        for (const k of s.keys) {
          if (rowKeys.has(k)) {
            overlap = true;
            break;
          }
        }
        if (overlap) for (const id of s.ids) ids.add(id);
      }
      if (ids.size > 0) map.set(r.id, [...ids]);
    }
    return map;
  }, [data, activeVerse, verseIndexByVersion, verseTwlSuggestions, twlFilters, chapter]);

  // Which of a suggestion's candidate articles the unlinked deny-list blocks for
  // its resolved OL quote. Returned to TwlSuggestions, which prunes them from the
  // picker (and drops the suggestion when all are blocked). The deny-list is
  // (word, article), so only the matching article is removed — e.g. kt/sonofgod
  // for a Hebrew "son" word, while kt/son survives. Unresolvable → block nothing.
  const twlBlockedArticleIds = useCallback(
    (s: TwlSuggestion, candidateIds?: string[]): Set<string> => {
      const blocked = new Set<string>();
      if (!data) return blocked;
      const verse = activeVerse;
      const grab = (bv: string): unknown[] | undefined => {
        const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
          ?.verseObjects;
        return Array.isArray(vo) ? vo : undefined;
      };
      const resolved = resolveSpanToSource(
        grab("ULT"),
        grab("UHB") ?? grab("UGNT"),
        s.matchedText,
        s.glOccurrence,
      );
      if (!resolved) return blocked;
      // Check the full candidate set the picker will show (server disambiguation
      // plus any global-family siblings the UI merged in), not just
      // s.disambiguation — otherwise a family sibling on the unlinked deny-list
      // would slip past the block and be addable.
      for (const id of candidateIds ?? s.disambiguation) {
        if (twlFilters.isUnlinked(resolved.orig_words, `rc://*/tw/dict/bible/${id}`)) blocked.add(id);
      }
      return blocked;
    },
    [data, activeVerse, verseIndexByVersion, twlFilters],
  );

  // Routes any verse / version / aligner-target change through the dirty
  // gate when the alignment panel has unsaved drags. Plain wrapper around
  // setState if the gate is clear; otherwise queues for the popup.
  //
  // The gate reads panelMode / alignmentDirty through refs, NOT the state
  // values, so its identity is stable. Memoized children (ScriptureColumn,
  // InactiveVerseRow) deliberately skip comparing callback props, so a
  // callback that closed over the state would go stale inside them and let
  // navigation bypass the gate — silently dropping unsaved alignment drags.
  // Layout effect (not passive) so the refs are current before any
  // subsequent click can read them. Browser back/forward remounts the Shell
  // entirely, so that navigation path stays ungated here.
  const panelModeRef = useRef(panelMode);
  const alignmentDirtyRef = useRef(alignmentDirty);
  useLayoutEffect(() => {
    panelModeRef.current = panelMode;
    alignmentDirtyRef.current = alignmentDirty;
  }, [panelMode, alignmentDirty]);
  const runWithDirtyGate = useCallback((apply: () => void) => {
    if (panelModeRef.current === "alignment" && alignmentDirtyRef.current) {
      setPendingNav({ run: apply });
    } else {
      apply();
    }
  }, []);

  const requestSelectVerse = useCallback(
    (v: number) => {
      runWithDirtyGate(() => {
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
        setActiveQuestionId(null);
      });
    },
    [runWithDirtyGate],
  );

  // Notes the find overlay's TN scope searches. Single chapter in stacked /
  // columns mode; every loaded chapter in book mode. Reads dataRef so the
  // getter sees live notes (post-keystroke) without forcing the memoized
  // ScriptureColumn to re-render on every edit. Identity only churns on
  // mode / book-cache changes, both of which ScriptureColumn already re-renders
  // for, so the overlay always receives a current getter.
  // Find-in-notes highlight state, lifted from the overlay (which lives inside
  // ScriptureColumn) so the sibling ResourceColumn's note cards can paint
  // matches. `findNoteQuery` marks every match; `activeNoteMatch` emphasizes
  // the one the user is navigating to.
  const [findNoteQuery, setFindNoteQuery] = useState<
    { find: string; regex: boolean; caseSensitive: boolean } | null
  >(null);
  const [activeNoteMatch, setActiveNoteMatch] = useState<
    { noteId: string; occurrence: number } | null
  >(null);

  const getSearchNotes = useCallback((): TnRow[] => {
    if (mode === "book" && bookHook) {
      const out: TnRow[] = [];
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind === "ready") out.push(...cs.data.tn);
      }
      return out;
    }
    return dataRef.current?.tn ?? [];
  }, [mode, bookHook]);

  // Navigate to + activate a TN match from the find overlay. Cross-chapter
  // (book mode) routes through the URL so the chapter payload reloads; the
  // common same-chapter case just focuses the verse + note, and the bumped
  // scrollNonce makes the resource column scroll it into view.
  // `switchTab` is opt-in and only the lint go-to passes it — the find overlay
  // must not move the user off the tab they're on.
  const focusNoteMatch = useCallback(
    (ch: number, v: number, noteId: string, switchTab = false) => {
      runWithDirtyGate(() => {
        if (ch !== chapter) {
          // The hash carries only book/chapter/verse; stash the note id so the
          // remounted Shell can activate + scroll to it once its payload loads.
          pendingRowJump = { book, chapter: ch, kind: "tn", rowId: noteId, switchTab };
          onNavigate?.(book, ch, v);
          return;
        }
        setActiveVerse(v);
        setActiveWordId(null);
        setActiveQuestionId(null);
        setActiveNoteId(noteId);
        if (switchTab) requestJumpTab("notes");
        setScrollNonce((n) => n + 1);
      });
    },
    [runWithDirtyGate, chapter, book, onNavigate, requestJumpTab],
  );

  // tq/twl equivalents of focusNoteMatch above — same cross-chapter stash /
  // same-chapter focus split, targeting activeQuestionId / activeWordId
  // instead of activeNoteId. Used by goToLintIssue below (a tq/twl lint
  // finding always carries a rowId — see api/src/lint.ts's lintTqRows /
  // lintTwlRows).
  const focusQuestionMatch = useCallback(
    (ch: number, v: number, questionId: string, switchTab = false) => {
      runWithDirtyGate(() => {
        if (ch !== chapter) {
          pendingRowJump = { book, chapter: ch, kind: "tq", rowId: questionId, switchTab };
          onNavigate?.(book, ch, v);
          return;
        }
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
        setActiveQuestionId(questionId);
        if (switchTab) requestJumpTab("questions");
        setScrollNonce((n) => n + 1);
      });
    },
    [runWithDirtyGate, chapter, book, onNavigate, requestJumpTab],
  );

  const focusWordMatch = useCallback(
    (ch: number, v: number, wordId: string, switchTab = false) => {
      runWithDirtyGate(() => {
        if (ch !== chapter) {
          pendingRowJump = { book, chapter: ch, kind: "twl", rowId: wordId, switchTab };
          onNavigate?.(book, ch, v);
          return;
        }
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveQuestionId(null);
        setActiveWordId(wordId);
        if (switchTab) requestJumpTab("words");
        setScrollNonce((n) => n + 1);
      });
    },
    [runWithDirtyGate, chapter, book, onNavigate, requestJumpTab],
  );

  // Jump to a lint issue from the topbar indicator. `ref` is "chapter:verse"
  // (or bare "chapter"). TN/tq/twl findings carry a rowId, so reuse the
  // focus*Match helpers above — the same row-jump mechanism the find overlay
  // uses for TN (same-chapter focuses the row; cross-chapter stashes
  // pendingRowJump and navigates). ULT/UST findings have no row, so just
  // navigate to the verse through the dirty gate.
  const goToLintIssue = useCallback(
    (issue: BookLintIssue) => {
      const [chStr, vStr] = issue.ref.split(":");
      const ch = parseInt(chStr, 10);
      if (Number.isNaN(ch)) return;
      const v = vStr ? parseInt(vStr, 10) : 1;
      const verse = Number.isNaN(v) ? 1 : v;
      if (issue.rowId) {
        // switchTab: a lint finding almost always arrives while a different
        // tab is showing, so this is the one path that may move the panel.
        if (issue.resource === "tn") {
          focusNoteMatch(ch, verse, issue.rowId, true);
          return;
        }
        if (issue.resource === "tq") {
          focusQuestionMatch(ch, verse, issue.rowId, true);
          return;
        }
        if (issue.resource === "twl") {
          focusWordMatch(ch, verse, issue.rowId, true);
          return;
        }
      }
      runWithDirtyGate(() => {
        setActiveVerse(verse);
        setActiveNoteId(null);
        setActiveWordId(null);
        setActiveQuestionId(null);
        onNavigate?.(book, ch, verse);
      });
    },
    [focusNoteMatch, focusQuestionMatch, focusWordMatch, runWithDirtyGate, book, onNavigate],
  );

  // App keys Shell on book only, so a cross-chapter navigation (URL /
  // back-forward / TopBar / cross-chapter find) changes the chapter +
  // initialVerse props WITHOUT remounting — useChapter keeps the prior
  // chapter's data visible while the new payload loads, so there's no loading
  // flash and find/book-view state survive. This effect does what the old
  // remount used to: reset the per-chapter transient state. Keyed on
  // [chapter, initialVerse] — internal same-chapter verse selection sets
  // activeVerse directly without an URL push, so initialVerse doesn't change
  // and this won't clobber it. Skips the initial mount.
  const chapterResetMounted = useRef(false);
  useEffect(() => {
    if (!chapterResetMounted.current) {
      chapterResetMounted.current = true;
      return;
    }
    setActiveVerse(initialVerse);
    setActiveNoteId(null);
    setActiveWordId(null);
    setActiveQuestionId(null);
    setAlignerTarget(null);
    setDualTarget(null);
    setPanelMode("resources");
    setAlignmentDirty(false);
    setDualLeftDirty(false);
    setDualRightDirty(false);
    setDualLeftReadingDirty(false);
    setDualRightReadingDirty(false);
    setPendingNav(null);
    setPendingDualAction(null);
    // A popover left open across a chapter change would be pointed at the old
    // chapter's verse (and hanging off an element that just unmounted). The
    // comment-deep-link consumer below runs after this effect, so it can still
    // open a popover on the chapter we're arriving at.
    closeComments();
  }, [chapter, initialVerse, closeComments]);

  // A front-matter / intro chapter (chapter 0) has only the intro tile (verse 0)
  // and no real verses. Navigation defaults activeVerse to 1, which doesn't
  // exist there, so the intro note stayed hidden until the user clicked "i" on
  // the rail. Once this chapter's tiles are known, snap to verse 0 so the intro
  // note — the only thing in the chapter — shows on arrival.
  useEffect(() => {
    // Gate on data.chapter === chapter: useChapter keeps the *prior* chapter's
    // payload visible while the new one loads, so acting on stale tiles would
    // wrongly snap to 0 when navigating from an intro chapter into a real one.
    if (!data || data.chapter !== chapter || activeVerse === 0) return;
    if (verseNumbers.length > 0 && verseNumbers.every((v) => v === 0)) {
      setActiveVerse(0);
    }
  }, [data, chapter, verseNumbers, activeVerse]);

  // Consume a cross-chapter row-focus jump stashed before navigation (TN-find,
  // or a tq/twl lint "go to issue" — see focusNoteMatch / focusQuestionMatch /
  // focusWordMatch above). Waits for this chapter's payload (and the target
  // row) to load, then activates + scrolls to it. Cleared on consume; ignored
  // if the stash targets a different book/chapter (e.g. the user navigated
  // elsewhere in the meantime).
  useEffect(() => {
    const jump = pendingRowJump;
    if (!jump) return;
    if (jump.book !== book || jump.chapter !== chapter) return;
    if (!data) return;
    // Wait for THIS chapter's payload: useChapter keeps the previous chapter's
    // rows visible while the new ones load, so a miss against stale data would
    // wrongly look like a deleted row.
    if (data.chapter !== chapter) return;
    const rows = jump.kind === "tn" ? data.tn : jump.kind === "tq" ? data.tq : data.twl;
    if (!rows.some((r) => r.id === jump.rowId)) {
      // The chapter loaded and the row isn't in it — a stale lint report, or the
      // row was deleted. Drop the stash instead of leaving it to fire on some
      // unrelated later visit to this chapter.
      pendingRowJump = null;
      return;
    }
    const { switchTab, kind } = jump;
    pendingRowJump = null;
    setActiveNoteId(kind === "tn" ? jump.rowId : null);
    setActiveQuestionId(kind === "tq" ? jump.rowId : null);
    setActiveWordId(kind === "twl" ? jump.rowId : null);
    if (switchTab) requestJumpTab(TAB_FOR_ROW_KIND[kind]);
    setScrollNonce((n) => n + 1);
  }, [data, book, chapter, requestJumpTab]);

  // Consume a comment deep link — `?c=<id>` in the hash (initialCommentId).
  // Waits for this chapter's comments to load and for that id to actually be
  // present, then selects the comment's verse, opens the popover on its
  // anchor and highlights it. Runs AFTER the per-chapter reset effect above in
  // source order, so the reset's setActiveVerse(initialVerse) can't clobber
  // the jump on the same navigation. The consumed key is remembered (keyed by
  // book/chapter, not just id) so dismissing the popover doesn't re-open it.
  const consumedCommentKeyRef = useRef<string | null>(null);

  // Clearing the marker when the URL stops carrying `?c=` is what lets the SAME
  // alert link be clicked twice. Keying the marker alone isn't enough: leaving
  // the chapter and coming back rebuilds the identical key, so the second
  // arrival was silently dropped and `?c=` was left stranded in the URL
  // (verified). Since we strip the param immediately after consuming, its
  // absence is exactly the signal that the previous jump is finished; the
  // marker still guards the window before the hash actually updates, where a
  // commentsIndex change could otherwise re-run the effect.
  useEffect(() => {
    if (initialCommentId == null) consumedCommentKeyRef.current = null;
  }, [initialCommentId]);

  useEffect(() => {
    if (initialCommentId == null) return;
    const key = `${book}/${chapter}/${initialCommentId}`;
    if (consumedCommentKeyRef.current === key) return;
    const comment = commentsIndex.byId.get(initialCommentId);
    if (!comment) {
      // Not found YET could mean three different things, and only one of them
      // justifies telling the user the comment is gone:
      //   1. this chapter's comments haven't been fetched yet — say nothing;
      //   2. the fetch failed — say nothing, the errorText banner covers it and
      //      a later load may succeed (claiming "deleted" here would be a lie);
      //   3. the fetch settled for THIS chapter and the id genuinely isn't in
      //      it — consume the link so `?c=` stops stranding, and say so.
      // `commentsLoading` alone cannot distinguish (1): on a chapter change it
      // is still false from the previous chapter while the index is already
      // empty, so a perfectly valid cross-chapter deep link was being reported
      // as deleted. Gate on the loaded set actually belonging to this chapter.
      const settledForThisChapter = commentsLoadedKey === `${book}/${chapter}`;
      if (commentsLoading || !settledForThisChapter || commentsError) return;
      consumedCommentKeyRef.current = key;
      onCommentConsumed?.();
      pushPipelineToast("That comment is no longer available.", "info");
      return;
    }
    consumedCommentKeyRef.current = key;
    setActiveVerse(comment.verse);
    // Set the focus id matching the comment's row kind and clear the other two
    // — the trio must stay consistent (same rule goToLintIssue follows), or a
    // stale question/word highlight lingers from wherever focus was before.
    setActiveNoteId(comment.rowKind === "tn" ? comment.rowId : null);
    setActiveQuestionId(comment.rowKind === "tq" ? comment.rowId : null);
    setActiveWordId(comment.rowKind === "twl" ? comment.rowId : null);
    // No clicked element on a deep-link arrival, so anchor stays null and the
    // popover falls back to the centred anchor.
    setCommentPanel({
      anchor: null,
      target:
        comment.rowKind != null && comment.rowId != null
          ? { verse: comment.verse, rowKind: comment.rowKind, rowId: comment.rowId }
          : { verse: comment.verse },
    });
    setHighlightCommentId(comment.id);
    setScrollNonce((n) => n + 1);
    // Hand the consumption back to App, which drops the `?c=` from both the URL
    // and its location state. Doing the rewrite here used replaceState, which
    // fires no hashchange, so App never learned the param was gone: the prop
    // stayed set, this effect's deps never changed, and clicking the SAME alert
    // again was silently ignored (verified).
    onCommentConsumed?.();
  }, [commentsIndex, commentsLoading, commentsLoadedKey, commentsError, book, chapter, initialCommentId, onCommentConsumed, pushPipelineToast]);

  // Keep the alignment target's verse in step with the active verse while
  // we're in alignment mode. Bible version is sticky — only LinkIcon clicks
  // change it. Effect, not direct setter, so it survives both rail clicks
  // and book-mode chapter swaps.
  useEffect(() => {
    if (panelMode !== "alignment") return;
    if (!alignerTarget) return;
    if (alignerTarget.verse === activeVerse && alignerTarget.chapter === chapter) return;
    setAlignerTarget({ ...alignerTarget, chapter, verse: activeVerse });
  }, [activeVerse, chapter, panelMode, alignerTarget]);

  const openAligner = useCallback(
    (chapterNum: number, v: number, bv: string) => {
      // A locked book must not let a translator into the aligner at all —
      // HTML5 drag-and-drop there is invisible to any contenteditable/input
      // read-only check, so a drag+save would silently discard the work (the
      // draft is dropped while the outbox returns a synthetic no-op). Block
      // entry rather than trying to make the aligner itself partially
      // read-only.
      if (bookLocked) return;
      runWithDirtyGate(() => {
        setAlignerTarget({ chapter: chapterNum, verse: v, bibleVersion: bv });
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
        setActiveQuestionId(null);
        setPanelMode("alignment");
      });
    },
    [runWithDirtyGate, bookLocked],
  );

  // Open the side-by-side ULT/UST aligner on a verse. Layered over the UI as a
  // Dialog (orthogonal to panelMode), so it gates only on the single panel's
  // unsaved drags before opening.
  const openDualAligner = useCallback(
    (chapterNum: number, v: number) => {
      // See the matching guard in openAligner above: a locked book must not
      // allow entry to any aligner, dual or single.
      if (bookLocked) return;
      runWithDirtyGate(() => {
        setActiveVerse(v);
        setDualTarget({ chapter: chapterNum, verse: v });
      });
    },
    [runWithDirtyGate, bookLocked],
  );
  // Any action that leaves or re-targets the dual aligner gates on unsaved work
  // — alignment drags OR reading-text edits in either panel (save/discard
  // prompt) — shared by close + verse nav.
  const dualDirty =
    dualLeftDirty || dualRightDirty || dualLeftReadingDirty || dualRightReadingDirty;
  // Guard full-page unloads (reload / tab close / external nav) against losing
  // unsaved work — the paths that bypass the in-app dirty gate below. Covers
  // in-memory alignment + reading dirtiness here plus unsaved drafts internally.
  useUnsavedGuard(alignmentDirty || dualDirty);

  // Save-aware reload for the "App update available" chip. A bare reload would
  // drop unsaved in-memory alignment drags (they only reach the durable outbox
  // on save). If the single alignment panel is dirty, save first, then wait for
  // the enqueue to commit to IndexedDB — outbox.list() opens a readonly tx that
  // IndexedDB serializes AFTER the save's write, so its resolution means the op
  // is durably queued (it survives the reload and drains after) — before
  // tearing the page down. Text/note/row drafts already persist across reload;
  // the beforeunload guard covers the other unload paths.
  const reloadForUpdate = useCallback(() => {
    const reload = () => window.location.reload();
    if (panelMode === "alignment" && alignmentDirty && alignmentPanelRef.current) {
      alignmentPanelRef.current.save(() => {
        void outbox.list().then(reload);
      });
    } else {
      reload();
    }
  }, [panelMode, alignmentDirty]);
  const requestDualAction = useCallback(
    (run: () => void) => {
      if (dualDirty) setPendingDualAction({ run });
      else run();
    },
    [dualDirty],
  );
  const requestCloseDual = useCallback(
    () => requestDualAction(() => setDualTarget(null)),
    [requestDualAction],
  );
  const dualNavTo = useCallback(
    (v: number) =>
      requestDualAction(() => {
        setActiveVerse(v);
        setDualTarget((t) => (t ? { ...t, verse: v } : t));
      }),
    [requestDualAction],
  );
  const resolveDualAction = useCallback(
    (choice: "save" | "discard") => {
      const action = pendingDualAction;
      setPendingDualAction(null);
      // Only touch the dirty panel(s): save() serializes + enqueues a PATCH
      // unconditionally, so calling it on the clean side would bump that
      // version row for nothing (and could 409 against a concurrent editor).
      if (choice === "discard") {
        if (dualLeftDirty) dualLeftRef.current?.discard();
        if (dualRightDirty) dualRightRef.current?.discard();
        if (dualLeftReadingDirty) dualLeftReadingRef.current?.discard();
        if (dualRightReadingDirty) dualRightReadingRef.current?.discard();
        action?.run();
        return;
      }
      // Save. A reading-line edit is NOT unconditionally synchronous — it can
      // trip the collateral-loss guard (Shell's guardBlocksSave, via
      // saveVerseDraft → enqueueVerseSafely) and defer behind the "Words will
      // be unaligned" confirm exactly like an alignment panel's unalign
      // confirm. So CHAIN every dirty side (both reading lines, then both
      // alignment panels): run the close/nav only once each has actually
      // committed. Chaining (vs. firing them all up front) also guarantees at
      // most one confirm is open at a time — each step's confirm opens only
      // after the previous step resolves — so a later setPendingAlignmentLoss
      // can't clobber an earlier pending commit. A Cancel anywhere in the
      // chain stalls it — `finish` (and thus the close) never runs — which is
      // the fix for #490 (the dialog used to close, unmounting the reading
      // line, while its confirm was still pending).
      runSaveChain(
        [
          {
            dirty: dualLeftReadingDirty,
            save: (afterCommit) => {
              const ref = dualLeftReadingRef.current;
              if (ref) ref.save(afterCommit);
              else afterCommit();
            },
          },
          {
            dirty: dualRightReadingDirty,
            save: (afterCommit) => {
              const ref = dualRightReadingRef.current;
              if (ref) ref.save(afterCommit);
              else afterCommit();
            },
          },
          {
            dirty: dualLeftDirty,
            save: (afterCommit) => {
              const ref = dualLeftRef.current;
              if (ref) ref.save(afterCommit);
              else afterCommit();
            },
          },
          {
            dirty: dualRightDirty,
            save: (afterCommit) => {
              const ref = dualRightRef.current;
              if (ref) ref.save(afterCommit);
              else afterCommit();
            },
          },
        ],
        () => action?.run(),
      );
    },
    [pendingDualAction, dualLeftDirty, dualRightDirty, dualLeftReadingDirty, dualRightReadingDirty],
  );

  const handleSetPanelMode = useCallback(
    (mode: PanelMode) => {
      // Route through the dirty gate so leaving alignment mode with unsaved
      // drags (to Search or any sibling tab) prompts save/discard instead of
      // silently unmounting AlignmentPanel and dropping the edits. The gate is
      // a no-op unless we're currently in dirty alignment, so entering
      // alignment and all clean switches still apply immediately.
      // See the matching guard in openAligner above: a locked book must not
      // allow entry to the aligner via the Alignment tab either.
      if (mode === "alignment" && bookLocked) return;
      runWithDirtyGate(() => {
        if (mode === "alignment" && !alignerTarget) {
          setAlignerTarget({ chapter, verse: activeVerse, bibleVersion: "ULT" });
        }
        setPanelMode(mode);
      });
    },
    [runWithDirtyGate, alignerTarget, chapter, activeVerse, bookLocked],
  );

  const dismissPendingNav = useCallback(() => setPendingNav(null), []);
  const resolvePendingNav = useCallback(
    (choice: "save" | "discard") => {
      const nav = pendingNav;
      setPendingNav(null);
      if (!nav) return;
      if (choice === "discard") {
        alignmentPanelRef.current?.discard();
        nav.run();
        return;
      }
      // Save: the panel may defer behind the unalign confirm, so DON'T navigate
      // up front. Pass nav.run as the afterCommit — save() runs it once the save
      // actually lands (immediately on a clean save, or after "Save anyway"), and
      // never if the user cancels the confirm. Without a panel, just navigate.
      const ref = alignmentPanelRef.current;
      if (ref) ref.save(nav.run);
      else nav.run();
    },
    [pendingNav],
  );

  const enqueueVerseSafely = useCallback((
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    base: VerseDto,
    content: unknown,
    plainText: string,
    intent: AlignmentIntent,
    expectedVersion = base.version,
    // Local-cache apply to run AFTER the save is committed. For the synchronous
    // success path the caller still applies it itself; this is invoked by the
    // confirm-commit below (text_edit) so a deferred "Save anyway" updates the
    // cache too.
    onConfirmedApply?: () => void,
    draftGeneration?: string,
    // See outbox.ts's OutboxOp.alignmentDraftGeneration — only ever set by
    // an alignment_edit save (AlignmentPanel), threaded through so the
    // eventual PATCH success can generation-gate its crash-draft cleanup.
    alignmentDraftGeneration?: string,
  ): boolean => {
    const delta = analyzeAlignmentDelta(base.content, content);
    // Block any save that collaterally de-aligns untouched words. The enforced
    // predicate lives in guardBlocksSave — DO NOT inline a narrowing such as
    // `delta.wordSequenceUnchanged` here. That narrowing (commit 6980fd72) is
    // exactly what let 1CH 4:21 / NUM 24 ship: a one-word spelling edit flips
    // wordSequenceUnchanged to false, so the narrowed guard never fired and the
    // collateral loss reached master. See guardBlocksSave for the full rationale.
    if (guardBlocksSave(delta, intent)) {
      const lost = delta.unexpectedLosses.map((loss) => loss.text);
      // text_edit: a reword/reorder the edit engine can't keep aligned (e.g.
      // relocating an aligned phrase across \q lines, or a verse whose UNCHANGED
      // region holds a split-unit word like "Yahweh's" that disqualifies the
      // occurrence-keyed reassembly tier — ZEC 9:1). Rather than DISCARD the
      // translator's keystroke draft, surface the same confirm the aligner uses;
      // on "Save anyway" re-enqueue with the confirmed_text_edit intent — a
      // guard-exempt intent (issue #575) mirrored in the API (verses.ts), so
      // the PATCH MUST climb as confirmed_text_edit or it is rejected there
      // too. Distinct from "alignment_edit" (a real aligner-panel save) even
      // though both are equally guard-exempt: this save's intent is still a
      // text edit, not a deliberate re-alignment. The affected words land
      // unaligned for the translator to re-align in the Alignment panel.
      if (intent === "text_edit") {
        setPendingAlignmentLoss({
          ref: `${book} ${chapterNum}:${verseNum} ${bibleVersion}`,
          lostWords: lost,
          commit: () => {
            void outbox.enqueueVerse(
              book,
              chapterNum,
              verseNum,
              bibleVersion,
              expectedVersion,
              { content, plain_text: plainText, alignment_intent: "confirmed_text_edit" },
              { draftGeneration, alignmentDraftGeneration },
            );
            onConfirmedApply?.();
          },
        });
        return false;
      }
      // find_replace / section_edit: keep the hard block + toast. There is no
      // keystroke draft to preserve, and find/replace-all can touch many verses
      // at once — a single shared confirm dialog would clobber across them.
      const sample = lost.slice(0, 3).join(", ");
      pushPipelineToast(
        `This edit can't preserve word alignment on words you didn't change, so it wasn't saved (${book} ${chapterNum}:${verseNum} ${bibleVersion}${sample ? `; affected: ${sample}` : ""}). Please note this verse (${book} ${chapterNum}:${verseNum}) for your admin to file a bug-fix review, or re-align in the alignment panel.`,
        "error",
      );
      return false;
    }
    void outbox.enqueueVerse(
      book,
      chapterNum,
      verseNum,
      bibleVersion,
      expectedVersion,
      { content, plain_text: plainText, alignment_intent: intent },
      { draftGeneration, alignmentDraftGeneration },
    );
    return true;
  }, [book, pushPipelineToast]);

  // Compute the alignment panel's props from the current chapter cache.
  // Memoized so identity stays stable when the chapter hasn't changed under
  // it; the panel uses verse identity to re-init its internal state.
  const alignmentTabProps = useMemo<AlignmentTabProps | undefined>(() => {
    if (!alignerTarget) return undefined;
    if (!data) return undefined;
    const sameChapter = alignerTarget.chapter === chapter;
    const bookData =
      !sameChapter && bookHook
        ? (() => {
            const cs = bookHook.chapters.get(alignerTarget.chapter);
            return cs?.kind === "ready" ? cs.data : null;
          })()
        : null;
    const sourceData = sameChapter ? data : bookData;
    if (!sourceData) return undefined;
    // Multi-verse target (e.g. UST 6-9): buildAlignerSlice expands the source
    // side by concatenating per-verse UHB/UGNT rows across the span and widens
    // the TWL list to every verse the range covers.
    const { sourceLabel, targetVerse, sourceVerse, twlForVerse } = buildAlignerSlice(
      sourceData,
      alignerTarget.verse,
      alignerTarget.bibleVersion,
    );
    return {
      book,
      chapter: alignerTarget.chapter,
      verseNum: alignerTarget.verse,
      bibleVersion: alignerTarget.bibleVersion,
      verse: targetVerse,
      sourceVerse,
      sourceLabel,
      twlForVerse,
      onSave: (content, plain, _expectedVersion, draftGeneration) => {
        // Key the PATCH by the resolved row's verse_start — alignerTarget.verse
        // may sit INSIDE a range row (v7 of a UST 6-9 block) now that the
        // slice resolves through buildVerseIndex.
        if (targetVerse) {
          enqueueVerseSafely(
            alignerTarget.chapter,
            targetVerse.verse,
            alignerTarget.bibleVersion,
            targetVerse,
            content,
            plain,
            "alignment_edit",
            _expectedVersion,
            undefined,
            undefined,
            draftGeneration,
          );
        }
        // Optimistically fold the new alignment into the local chapter cache so
        // content-derived UI (the broken-alignment link, OL-anchored note
        // highlights) updates immediately instead of waiting for a refetch.
        // Mirrors the verse-text / section save paths; the outbox 200 handler
        // bumps the version, so we keep targetVerse's version here.
        if (targetVerse) {
          const newDto = { ...targetVerse, content, plain_text: plain } as VerseDto;
          bookHook?.applyLocalVerse(newDto);
          if (alignerTarget.chapter === chapter) applyLocalVerse(newDto);
        }
      },
      onConfirmUnalign: (lostWords, commit) =>
        setPendingAlignmentLoss({
          ref: `${book} ${alignerTarget.chapter}:${targetVerse?.verse ?? alignerTarget.verse} ${alignerTarget.bibleVersion}`,
          lostWords,
          commit,
        }),
      onCancel: () => {
        setPanelMode("resources");
      },
      onDirtyChange: setAlignmentDirty,
      panelRef: alignmentPanelRef,
      onOpenDual: () => openDualAligner(alignerTarget.chapter, alignerTarget.verse),
      onRestoreVersion: targetVerse
        ? (content, plainText) =>
            restoreVerse(
              alignerTarget.chapter,
              targetVerse.verse,
              alignerTarget.bibleVersion,
              content,
              plainText,
              targetVerse,
            )
        : undefined,
    };
  }, [alignerTarget, data, chapter, bookHook, book, openDualAligner, applyLocalVerse, enqueueVerseSafely]);

  // Props for the side-by-side popup: ULT + UST slices against one shared
  // source. Undefined (popup closed) unless a dualTarget is set and at least
  // one of the two versions exists for the verse.
  const dualAlignerProps = useMemo(() => {
    if (!dualTarget || !data) return undefined;
    const sameChapter = dualTarget.chapter === chapter;
    const bookData =
      !sameChapter && bookHook
        ? (() => {
            const cs = bookHook.chapters.get(dualTarget.chapter);
            return cs?.kind === "ready" ? cs.data : null;
          })()
        : null;
    const sourceData = sameChapter ? data : bookData;
    if (!sourceData) return undefined;
    const ult = buildAlignerSlice(sourceData, dualTarget.verse, "ULT");
    const ust = buildAlignerSlice(sourceData, dualTarget.verse, "UST");
    if (!ult.targetVerse && !ust.targetVerse) return undefined;
    const sourceLabel = ult.sourceLabel; // identical across versions
    // The shared strip shows the UNION span so a multi-verse UST and a
    // per-verse ULT both see the Hebrew they reference. Each PANEL keeps its
    // own slice's source (only the verses its target covers) — aligning to it
    // is what gets serialized into zaln milestones, and the union would let a
    // single-verse panel reference Hebrew outside its verse. posOffset bridges
    // panel positions into the union for the lifted hover.
    const rangeStart = Math.min(ult.rangeStart, ust.rangeStart);
    const rangeEnd = Math.max(ult.rangeEnd, ust.rangeEnd);
    const byStart = sourceData.verses[sourceLabel] ?? {};
    const sourceVerse =
      rangeEnd > rangeStart
        ? concatSourceRange(byStart, rangeStart, rangeEnd)
        : byStart[rangeStart] ?? null;
    const offsetFor = (ownStart: number) => {
      let off = 0;
      for (let v = rangeStart; v < ownStart; v++) off += countSourceWords(byStart[v]);
      return off;
    };
    const twlForVerse = sourceData.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
    const labelVerse = ult.targetVerse ?? ust.targetVerse;
    const vref = `${book} ${dualTarget.chapter}:${
      labelVerse ? formatVerseLabel(labelVerse) : dualTarget.verse
    }`;
    // PATCH key is the resolved row's verse_start — dualTarget.verse may sit
    // inside a range row now that slices resolve through buildVerseIndex.
    const enqueue = (bibleVersion: string, row: VerseDto | null) =>
      (content: unknown, plain: string, _expectedVersion: number, draftGeneration?: string) => {
        if (!row) return;
        enqueueVerseSafely(
          dualTarget.chapter,
          row.verse,
          bibleVersion,
          row,
          content,
          plain,
          "alignment_edit",
          _expectedVersion,
          undefined,
          undefined,
          draftGeneration,
        );
        // Optimistic local update so content-derived UI (the broken-alignment
        // link) refreshes immediately — same as the single-panel aligner.
        const newDto = { ...row, content, plain_text: plain } as VerseDto;
        bookHook?.applyLocalVerse(newDto);
        if (dualTarget.chapter === chapter) applyLocalVerse(newDto);
      };
    const confirmUnalign = (bibleVersion: string, row: VerseDto | null) =>
      (lostWords: string[], commit: () => void) =>
        setPendingAlignmentLoss({
          ref: `${book} ${dualTarget.chapter}:${row?.verse ?? dualTarget.verse} ${bibleVersion}`,
          lostWords,
          commit,
        });
    const left: PanelSlot = {
      bibleVersion: "ULT",
      verse: ult.targetVerse,
      sourceVerse: ult.sourceVerse,
      twlForVerse: ult.twlForVerse,
      posOffset: offsetFor(ult.rangeStart),
      onSave: enqueue("ULT", ult.targetVerse),
      onConfirmUnalign: confirmUnalign("ULT", ult.targetVerse),
      onDirtyChange: setDualLeftDirty,
      panelRef: dualLeftRef,
      onReadingDirtyChange: setDualLeftReadingDirty,
      readingRef: dualLeftReadingRef,
    };
    const right: PanelSlot = {
      bibleVersion: "UST",
      verse: ust.targetVerse,
      sourceVerse: ust.sourceVerse,
      twlForVerse: ust.twlForVerse,
      posOffset: offsetFor(ust.rangeStart),
      onSave: enqueue("UST", ust.targetVerse),
      onConfirmUnalign: confirmUnalign("UST", ust.targetVerse),
      onDirtyChange: setDualRightDirty,
      panelRef: dualRightRef,
      onReadingDirtyChange: setDualRightReadingDirty,
      readingRef: dualRightReadingRef,
    };
    return {
      book,
      chapter: dualTarget.chapter,
      verseNum: dualTarget.verse,
      vref,
      sourceLabel,
      sourceVerse,
      twlForVerse,
      left,
      right,
    };
  }, [dualTarget, data, chapter, bookHook, book, applyLocalVerse, enqueueVerseSafely]);

  // Prev/next verse for the dual aligner's titlebar arrows, within the current
  // chapter's verse list (excluding the intro tile). Null at the ends.
  const dualNav = useMemo(() => {
    if (!dualAlignerProps || dualAlignerProps.chapter !== chapter) {
      return { prev: null as number | null, next: null as number | null };
    }
    const nums = verseNumbers.filter((v) => v > 0);
    const idx = nums.indexOf(dualAlignerProps.verseNum);
    if (idx === -1) return { prev: null, next: null };
    return { prev: nums[idx - 1] ?? null, next: nums[idx + 1] ?? null };
  }, [dualAlignerProps, chapter, verseNumbers]);

  const alignmentBadge = alignerTarget
    ? `${alignerTarget.chapter}:${
        alignerTarget.verse === 0
          ? "i"
          : alignmentTabProps?.verse
            ? formatVerseLabel(alignmentTabProps.verse)
            : alignerTarget.verse
      }`
    : undefined;

  // Initial load (or retry from scratch) — no data to show yet. Render the
  // TopBar anyway (it fetches its own book list, and includes SyncStatusBar)
  // so a bad deep link / 404 chapter still leaves the user a way to navigate
  // out and an offline user sees their connection state. Navigation here is
  // deliberately ungated — the alignment panel and the dirty-confirm dialog
  // only mount in the data branch, so runWithDirtyGate would soft-lock.
  if (!data) {
    return (
      // height:100% (not 100vh) so an in-flow app banner above this Shell can
      // reserve space and push it down instead of being overlaid (issue #458).
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <TopBar
          book={book}
          chapter={chapter}
          onNavigate={(b, c, v) => {
            setActiveVerse(v ?? 1);
            setActiveNoteId(null);
            setActiveWordId(null);
            setActiveQuestionId(null);
            onNavigate?.(b, c, v);
          }}
          onLogout={onLogout}
          notificationsMenu={notificationsMenu}
          syncWarnings={syncWarnings}
        />
        <Box sx={{ p: 4, display: "flex", alignItems: "center", gap: 2 }}>
          {status === "error" ? (
            <Alert severity="error">failed to load {book} {chapter}: {error}</Alert>
          ) : (
            <>
              <CircularProgress size={20} />
              <Typography variant="body2">
                {status === "retrying" ? `reconnecting… (attempt ${retryAttempts})` : `loading ${book} ${chapter}…`}
              </Typography>
            </>
          )}
        </Box>
      </Box>
    );
  }

  const enqueueRow = <T extends TnRow | TqRow | TwlRow>(
    kind: "tn" | "tq" | "twl",
    row: T,
    patch: Partial<T>,
    opts?: { restoredFromVersion?: number },
  ) => {
    // Optimistic local apply mirrors what the server will do: any non-revert
    // patch clears the restored_from_version marker so the chip immediately
    // drops the v{N} override instead of waiting for the round-trip.
    const localPatch = {
      ...patch,
      restored_from_version:
        opts?.restoredFromVersion !== undefined ? opts.restoredFromVersion : null,
    } as Partial<TnRow & TqRow & TwlRow>;
    // Capture the pre-edit baseline (the row's current value for each patched
    // field) BEFORE the optimistic apply, so a later 409 can distinguish a
    // spurious conflict (server changed a different field / already has our
    // value) from a genuine one and auto-heal the former (see
    // classifyRowPatchConflict). Read from `row`, which still holds the version
    // we branched from — applyLocalRowPatch produces a new cached object.
    const rowRecord = row as unknown as Record<string, unknown>;
    const baseline: Record<string, unknown> = {};
    for (const field of Object.keys(patch)) baseline[field] = rowRecord[field];
    applyLocalRowPatch(kind, row.id, localPatch);
    void outbox.enqueueRow(kind, row.id, row.version, patch as Record<string, unknown>, { ...opts, book: row.book, baseline });
  };

  // Draft-write path. Every keystroke in a verse-text cell calls this; it
  // stashes the plain text in IndexedDB so unsaved typing survives tab
  // close / chapter navigation. No PATCH fires here — only on saveVerseDraft.
  const stashVerseDraft = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    plain: string,
    base: VerseDto,
  ) => {
    const key = verseKey(book, chapterNum, verseNum, bibleVersion);
    // Pin the diff/save baseline to whatever `base` this edit session's FIRST
    // keystroke saw. A version bump that lands mid-edit (WS verse.updated,
    // nightly reconcile) must not rebase later keystrokes onto content the
    // user never saw — see pinVerseBase's comment and issue #474.
    const pinned = pinVerseBase(key, base);
    void drafts.set(
      key,
      { plainText: plain },
      pinned.version,
      { kind: "verse", book, chapter: chapterNum, verse: verseNum, bibleVersion },
    );
  };

  // User clicked Save on a verse cell. Runs smartEditVerse so unchanged
  // regions keep their `\zaln-s` milestones, applies the new content
  // locally so highlights re-render, then enqueues. Outbox-result listener
  // (installed in main.ts) clears the draft on 200.
  //
  // `plain` is the editable representation (paragraph / poetry markers
  // surfaced as inline "\p" / "\q1" tokens) — extractEditableText on the
  // base content produces the matching baseline for the diff. The DB
  // `plain_text` column stays marker-free, so we recompute it from the
  // resulting tree via extractPlainText.
  //
  // `afterCommit` mirrors AlignmentPanelHandle.save (#490): this save is NOT
  // unconditionally synchronous — enqueueVerseSafely can trip the
  // collateral-loss guard and defer behind the "Words will be unaligned"
  // confirm. `afterCommit` runs once the save actually lands — immediately
  // on the no-op / clean-save paths below, or after "Save anyway" — and
  // never if the user cancels the confirm. A caller that closes/unmounts the
  // editor after saving (e.g. the dual aligner's reading line) MUST pass its
  // continuation here rather than proceeding right after calling this.
  const saveVerseDraft = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    plain: string,
    base: VerseDto,
    afterCommit?: () => void,
  ) => {
    const key = verseKey(book, chapterNum, verseNum, bibleVersion);
    // Diff and save against the SAME baseline this edit session's first
    // keystroke pinned — never the live `base` this call happened to receive.
    // `base` is recomputed from the chapter cache on every render, so a WS
    // verse.updated (another tab's edit, or the nightly reconcile) that lands
    // mid-edit would otherwise rebase the diff onto content the user never
    // saw: their still-in-DOM stale text would read as "added back" against
    // the new baseline, and get saved under ITS (valid) version — a
    // stale-content/fresh-version save that can silently resurrect deleted
    // text. Pinning both content and version together, and sending the
    // pinned version as expected_version, means a real intervening change
    // now surfaces as an ordinary 409 merge conflict instead. See #474.
    const pinned = pinVerseBase(key, base);
    const effectiveBase = { ...base, version: pinned.version, content: pinned.content } as VerseDto;
    const oldEditable = extractEditableText(effectiveBase.content);
    // No-op guard: a focus/blur (or any save) with no actual text change must
    // not enqueue a PATCH — it would bump the verse version server-side for
    // nothing, adding noisy history and leaving a stale expected_version that a
    // later alignment save on the same row can 409 against.
    //
    // `oldEditable` is already normalizeEditable-collapsed, but `plain` is raw
    // DOM textContent (may carry trailing \n / ZWSP / nbsp the editor emits),
    // so normalize both sides — otherwise type-a-char-then-revert never matches
    // and a version-bumping no-op PATCH fires. On a real no-op we must also
    // CLEAR the stranded keystroke draft: drafts are written on every keystroke
    // and only cleared by the outbox-200 listener, so returning without clearing
    // leaves an orphaned draft (dirty border + SyncStatusBar entry + "unsaved
    // edits" toast whose Save button re-hits this guard and never resolves).
    if (oldEditable === normalizeEditable(plain)) {
      void drafts
        .get(key)
        .then((draft) => {
          const generation = generationForSavedPlain(draft, plain);
          if (generation) void drafts.clearGeneration(key, generation);
          // Draftless no-op (dual-aligner reading line, which never stashes
          // keystrokes): the pinVerseBase above still pinned a baseline, and
          // with no draft record no clear will ever release it — the leaked
          // pin then poisons every later save of this verse (#563). IfIdle:
          // a keystroke landing while this get() was in flight re-pins the
          // session synchronously, and that pin must survive.
          else if (!draft) unpinVerseBaseIfIdle(key);
        })
        .catch(() => {
          /* conservative: leave an unreadable draft in place */
        });
      afterCommit?.();
      return;
    }
    // `plain` is raw DOM textContent, so the dropped-marker-chip guard applies
    // here and only here — see smartEditVerse's `capturedFromDom` (#606).
    const result = smartEditVerse(effectiveBase.content, oldEditable, plain, {
      capturedFromDom: true,
    });
    // Heads-up when this save drops alignment. Editing a word's text or order
    // unaligns that word by design — the engine preserves only the words it
    // didn't have to touch — and the loss is otherwise easy to miss: the editor
    // shows plain text, so a translator who reworded a phrase and saved gets no
    // in-place signal that they now have words to re-align (the prompt that led
    // here: a verse reworded + repunctuated in one save came back with several
    // words unaligned, read as "changing the period unaligned them"). Compare
    // the unaligned-word count before vs after and notify only when it actually
    // INCREASED, so a pure punctuation / spacing edit — which keeps every \zaln —
    // stays silent.
    const beforeUnaligned = countUnalignedTargetWords(
      (effectiveBase.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const afterUnaligned = countUnalignedTargetWords(
      (result.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const newlyUnaligned = afterUnaligned - beforeUnaligned;
    if (newlyUnaligned > 0) {
      pushPipelineToast(
        `This edit left ${newlyUnaligned} word${newlyUnaligned > 1 ? "s" : ""} unaligned in ${book} ${chapterNum}:${verseNum} ${bibleVersion} — re-align in the Alignment panel.`,
        "info",
      );
    }
    // The editor handed back text with none of its paragraph/poetry marks and
    // no word changed, so the engine restored them rather than wipe the verse's
    // lineation (#606). That is the right call for a dropped-chip capture, but
    // it also overrides a translator who genuinely meant to remove every mark in
    // the same save — so say so, and name the way to do it.
    if (result.markerCaptureGuarded) {
      pushPipelineToast(
        `Paragraph and poetry marks were restored in ${book} ${chapterNum}:${verseNum} ${bibleVersion} — the editor lost them during this edit. To remove them on purpose, delete the marks in a save of their own.`,
        "info",
      );
    }
    const newPlainText = extractPlainText(result.content);
    const newDto = {
      ...effectiveBase,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content: result.content,
    } as VerseDto;
    const applyLocal = () => {
      bookHook?.applyLocalVerse(newDto);
      if (chapterNum === chapter) applyLocalVerse(newDto);
    };
    // Resolve the durable draft before queueing so the outbox records the exact
    // generation represented by `plain`. If the user typed again after clicking
    // Save, generationForSavedPlain refuses to associate that newer draft with
    // this older payload, so the eventual 200 cannot clear the new work.
    const enqueueCapturedSave = (draftGeneration?: string) => {
      // onConfirmedApply (5th positional) fires from the collateral-loss
      // confirm's "Save anyway" when the guard defers this save — it must
      // also run afterCommit, since that path never reaches the `applyLocal();
      // afterCommit?.();` below.
      const onConfirmedApply = () => {
        applyLocal();
        afterCommit?.();
      };
      if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, effectiveBase, result.content, newPlainText, "text_edit", effectiveBase.version, onConfirmedApply, draftGeneration)) {
        return;
      }
      applyLocal();
      afterCommit?.();
    };
    void drafts
      .get(key)
      .then((draft) => enqueueCapturedSave(generationForSavedPlain(draft, plain)))
      // Draft lookup is cleanup metadata, not a prerequisite for durability.
      // If IndexedDB is temporarily unreadable, still queue the user's save;
      // the draft simply remains available for a conservative manual cleanup.
      .catch(() => enqueueCapturedSave());
  };

  // The verses map for a chapter, from the active useChapter cache when it's the
  // open chapter, else the book-mode cache. Bridge create/break read both rows'
  // versions from here to CAS the structural change.
  const versesForChapterMap = (ch: number): Record<string, Record<number, VerseDto>> | undefined => {
    if (ch === chapter) return dataRef.current?.verses;
    const cs = bookHook?.chapters.get(ch);
    return cs?.kind === "ready" ? cs.data.verses : undefined;
  };

  const bridgeErrorMessage = (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 409) return "This verse changed elsewhere — reopen it and try again.";
      if (e.status === 422) return "There is no following verse to merge with.";
      if (e.status === 400) return "That verse isn't a bridge.";
      if (e.status === 403) return "This column is read-only.";
    }
    return "Could not update the verse bridge. Try again.";
  };

  // Whether a verse has an unsaved keystroke draft in the outbox (a record with
  // a plainText payload). Bridge/split operate on SERVER content and bump the
  // row version, so an unsaved draft on an affected verse would be stranded —
  // its row is deleted (merge) or re-versioned (split) out from under the draft,
  // whose later save then 404s/409s. Refuse until the user saves.
  const verseHasPendingDraft = async (chapterNum: number, verse: number, bibleVersion: string): Promise<boolean> => {
    try {
      const rec = await drafts.get(verseKey(book, chapterNum, verse, bibleVersion));
      return typeof (rec?.payload as { plainText?: string } | undefined)?.plainText === "string";
    } catch {
      return false; // draft store unreadable → don't block the structural op
    }
  };

  // Create a verse bridge: combine `verse` with the following verse (5:1 + 5:2 →
  // 5:1-2). A deliberate POST the user awaits — not an outbox op. Applied locally
  // only on the server's 200 so a 409 never leaves a half-formed bridge.
  const mergeVerseWithNext = async (chapterNum: number, verse: number, bibleVersion: string) => {
    const byVersion = versesForChapterMap(chapterNum)?.[bibleVersion];
    const start = byVersion?.[verse];
    if (!start) return;
    const nextStart = (start.verse_end ?? start.verse) + 1;
    const next = byVersion?.[nextStart];
    if (!next) {
      setBridgeToast("There is no following verse to merge with.");
      return;
    }
    // Both verses' content is about to change server-side (start absorbs next,
    // next is deleted) — an unsaved edit on either would be lost. Guard first.
    if ((await verseHasPendingDraft(chapterNum, verse, bibleVersion)) || (await verseHasPendingDraft(chapterNum, nextStart, bibleVersion))) {
      setBridgeToast("Save your edits to these verses before bridging them.");
      return;
    }
    try {
      const res = await api.mergeVerseBridge(book, chapterNum, verse, bibleVersion, start.version, next.version);
      if (chapterNum === chapter) applyLocalVerseBridge(res.verse, res.removed_verse, res.absorbed_verses);
      bookHook?.applyLocalVerseBridge(res.verse, res.removed_verse, res.absorbed_verses);
    } catch (e) {
      setBridgeToast(bridgeErrorMessage(e));
    }
  };

  // Break a verse bridge: split `verse` (a `\v a-b` row) back into separate
  // verses. All text stays in the first; the later verses become empty rows the
  // translator fills in. Confirmed first because it moves text around.
  const splitVerseBridge = async (chapterNum: number, verse: number, bibleVersion: string) => {
    const byVersion = versesForChapterMap(chapterNum)?.[bibleVersion];
    const bridge = byVersion?.[verse];
    if (!bridge || bridge.verse_end == null || bridge.verse_end <= bridge.verse) return;
    // Split bumps the bridge row's version; an unsaved draft on it would 409 its
    // later save. Guard first (the newly-created verses don't exist yet, so only
    // the bridge start can carry a draft).
    if (await verseHasPendingDraft(chapterNum, verse, bibleVersion)) {
      setBridgeToast("Save your edits to this verse before breaking the bridge.");
      return;
    }
    const later = Array.from({ length: bridge.verse_end - bridge.verse }, (_i, k) => bridge.verse + 1 + k).join(", ");
    if (
      !window.confirm(
        `Break bridge ${chapterNum}:${bridge.verse}-${bridge.verse_end}?\n\nAll the text stays in verse ${bridge.verse}; verse${later.includes(",") ? "s" : ""} ${later} will become empty for you to fill in.`,
      )
    ) {
      return;
    }
    try {
      const res = await api.splitVerseBridge(book, chapterNum, verse, bibleVersion, bridge.version);
      if (chapterNum === chapter) applyLocalVerseSplit(res.verse, res.new_verses);
      bookHook?.applyLocalVerseSplit(res.verse, res.new_verses);
    } catch (e) {
      setBridgeToast(bridgeErrorMessage(e));
    }
  };

  // Restore a previously-saved verse version (from the history dialog). Unlike
  // saveVerseDraft, there is no smartEditVerse pass — we re-save the exact
  // stored content tree verbatim (alignment milestones included). It routes
  // through the same pipe with the alignment_edit intent: a deliberate
  // full-tree replacement legitimately changes alignment, and that intent
  // (alongside confirmed_text_edit, issue #575) is exempt from the
  // collateral-loss guard (guardBlocksSave). The version
  // climbs normally, so the new entry's content matches the restored one — no
  // restored_from_version bookkeeping needed (unlike notes).
  const restoreVerse = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    content: unknown,
    plainText: string | null,
    base: VerseDto,
  ) => {
    const newPlainText = plainText ?? extractPlainText(content);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, content, newPlainText, "alignment_edit")) {
      return;
    }
    // Drop any stranded keystroke draft so the dirty border / "unsaved edits"
    // toast don't linger over content the restore just replaced.
    void drafts.clear(verseKey(book, chapterNum, verseNum, bibleVersion));
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  // Section header (\s1/\s2/\s3) edit / delete. `change.index` is the
  // i'th section header inside this verse's content per
  // splitSectionHeaders. tag === null deletes the band. The verseObjects
  // tree is mutated structurally (no smartEditVerse — there's no text
  // diff, just a structural node swap) and saved via the same outbox.
  const saveSectionEdit = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => {
    const verseObjects = (base.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return;
    // Walk verseObjects in order; the index counter advances each time
    // we hit a section heading. On match: swap (tag/text) or splice out.
    const next: unknown[] = [];
    let sectionIdx = 0;
    for (const node of verseObjects) {
      const o = node as Record<string, unknown> | null;
      if (o && isHeaderLabelNode(o)) {
        if (sectionIdx === change.index) {
          if (change.tag !== null) {
            // usfm-js stores \s* heading text (and `\sr`/`\r`/`\cl` label
            // text) in `content` (with a trailing \n that the renderer/
            // exporter expects); only `\sp` parks it on `text` instead —
            // splitSectionHeaders/isHeaderLabelNode read either, but always
            // WRITE `content` here so every tag round-trips the same way
            // (usfm-js's toUSFM accepts `content` for all of them — #710).
            // The edit dropdown only ever offers s1/s2/s3, so a `\sp`/`\sr`/
            // `\r`/`\cl` label retagged through it becomes a section heading
            // and must gain `type:"section"` — carrying the OLD node's
            // (absent) type forward would make isHeaderLabelNode stop
            // recognizing the result on the next render (it's typeless and
            // "s1" isn't in HEADER_LABEL_TAGS), silently orphaning it from
            // the header band even though the data itself stays intact.
            const { text: _drop, type: _dropType, ...rest } = o;
            const type = SECTION_HEADER_TAGS.has(change.tag) ? "section" : undefined;
            next.push({ ...rest, ...(type ? { type } : {}), tag: change.tag, content: `${change.text}\n` });
          }
          // null tag → drop the node entirely.
          sectionIdx++;
          continue;
        }
        sectionIdx++;
      }
      next.push(node);
    }
    const newContent = { ...(base.content as Record<string, unknown> | null), verseObjects: next };
    const newPlainText = extractPlainText(newContent);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content: newContent,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, newContent, newPlainText, "section_edit")) {
      return;
    }
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <TopBar
        book={book}
        chapter={chapter}
        onNavigate={(b, c, v) => {
          runWithDirtyGate(() => {
            setActiveVerse(v ?? 1);
            setActiveNoteId(null);
            setActiveWordId(null);
            setActiveQuestionId(null);
            onNavigate?.(b, c, v);
          });
        }}
        onRequestReload={reloadForUpdate}
        pipelineMenu={
          <PipelineMenu
            book={book}
            chapter={chapter}
            onMessage={(msg) => pushPipelineToast(msg, "info")}
            onImported={() => void refetch()}
          />
        }
        pipelineStatus={
          <PipelineStatusBar
            toast={pipelineToast}
            onToastClear={() => setPipelineToast(null)}
          />
        }
        logosSyncToggle={
          <LogosSyncToggle book={book} chapter={chapter} verse={activeVerse} />
        }
        lintIndicator={
          <BookLintIndicator
            book={book}
            flagIssues={bookLint.flagIssues}
            flagCount={bookLint.flagCount}
            escalateCount={bookLint.escalateCount}
            onGoToIssue={goToLintIssue}
            onDismissed={bookLint.refetch}
          />
        }
        alignIndicator={
          <AlignAttentionIndicator
            book={book}
            refs={alignAttention.refs}
            resolvedKeys={alignAttentionResolvedKeys}
            onNavigate={(b, c, v) => {
              runWithDirtyGate(() => {
                setActiveVerse(v ?? 1);
                setActiveNoteId(null);
                setActiveWordId(null);
                setActiveQuestionId(null);
                onNavigate?.(b, c, v);
              });
            }}
          />
        }
        notesIndicator={
          <BookNotesIndicator
            book={book}
            onNavigate={(b, c, v) => {
              runWithDirtyGate(() => {
                setActiveVerse(v ?? 1);
                setActiveNoteId(null);
                setActiveWordId(null);
                setActiveQuestionId(null);
                onNavigate?.(b, c, v);
              });
            }}
          />
        }
        notificationsMenu={notificationsMenu}
        syncWarnings={syncWarnings}
        exportMenu={
          <ExportUsfmButton
            book={book}
            chapter={chapter}
            enabledVersions={displayedVersions}
            chapterVersesFor={(version) =>
              data ? Object.values(data.verses[version] ?? {}) : []
            }
          />
        }
        bookLocksButton={
          <Tooltip title="Book locks">
            <IconButton
              size="small"
              onClick={() => setBookLocksDialogOpen(true)}
              aria-label="book locks"
            >
              <LockIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        }
        railCollapsed={railCollapsed}
        onToggleRail={toggleRail}
        onLogout={onLogout}
      />
      <BookLocksDialog
        open={bookLocksDialogOpen}
        onClose={() => setBookLocksDialogOpen(false)}
        onChanged={bookLocks.refresh}
        books={bookLocks.books}
        canManageLocks={bookLocks.canManageLocks}
        refresh={bookLocks.refresh}
      />
      {currentBookLock?.locked && (
        <Alert
          severity="warning"
          sx={{
            borderRadius: 0,
            borderBottom: "1px solid",
            borderColor: "divider",
            py: 0.5,
          }}
        >
          {book} is locked
          {currentBookLock.lockSource === "published"
            ? " because it has been published"
            : currentBookLock.lockReason
              ? ` (${currentBookLock.lockReason})`
              : " by hand"}
          . Edits and Door43 exports are frozen until it's unlocked. Benjamin,
          Rich, or Perry can unlock it.
        </Alert>
      )}
      {lockBanners.map((b) => (
        <Alert
          key={b.jobId}
          severity="info"
          icon={false}
          sx={{
            borderRadius: 0,
            borderBottom: "1px solid",
            borderColor: "divider",
            py: 0.5,
            "& .MuiAlert-message": { width: "100%" },
          }}
        >
          AI {b.pipelineType} run in progress for {book} {chapter} — started{" "}
          {formatRelative(b.startedAt)}. Editing is locked for{" "}
          {b.resources.join(", ")} in this chapter; everything else stays
          editable.
          {b.resources.includes("notes")
            ? " You can still mark notes to keep before the new set lands."
            : ""}
        </Alert>
      ))}
      <Box ref={splitContainerRef} sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {!railCollapsed && (
          <Box sx={{ width: railWidth, flexShrink: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <Tooltip title="Chapter checkoff board" placement="right">
              <Button
                size="small"
                startIcon={<GridViewIcon sx={{ fontSize: 16 }} />}
                onClick={() => setBoardOpen(true)}
                sx={{
                  flexShrink: 0,
                  m: 0.5,
                  minWidth: 0,
                  fontSize: 12,
                  justifyContent: "flex-start",
                  bgcolor: "grey.50",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  borderRadius: 0.5,
                  color: "text.secondary",
                }}
              >
                Board
              </Button>
            </Tooltip>
            <TimelineRail
              book={book}
              chapter={chapter}
              tiles={tileSet}
              activeVerse={activeVerse}
              showChapter={mode === "book"}
              enabledLanes={enabledLanes}
              onSelect={requestSelectVerse}
              onToggleLane={toggleLane}
              onHideLane={toggleLaneVisible}
              bookLocked={bookLocked}
            />
          </Box>
        )}
        <Box
          sx={{
            width: `${effectiveSplit * 100}%`,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
        <ScriptureColumn
          book={book}
          chapter={chapter}
          textCheck={textLaneCheck}
          verseCommentCounts={verseCommentCounts}
          onOpenVerseComments={onOpenVerseComments}
          versesByVersion={data.verses}
          verseNumbers={verseNumbers}
          activeVerse={activeVerse}
          activeNoteQuote={activeQuote}
          activeNoteOccurrence={activeOccurrence}
          reorderHighlight={reorderHighlight}
          mode={mode}
          enabledVersions={displayedVersions}
          availableVersions={availableVersions}
          bookChapterList={bookChapterList}
          bookChapters={bookHook && mode === "book" ? bookHook.chapters : undefined}
          onLoadBookChapter={bookHook ? bookHook.loadChapter : undefined}
          onSelectBookVerse={(ch, v) => {
            // Verse click in book mode navigates via URL so the chapter
            // payload + resources reload through the existing useChapter
            // flow. App.tsx lifts the useBook cache so this round-trip is
            // cheap.
            runWithDirtyGate(() => {
              if (ch !== chapter) {
                onNavigate?.(book, ch, v);
              } else {
                setActiveVerse(v);
                setActiveNoteId(null);
                setActiveWordId(null);
                setActiveQuestionId(null);
              }
            });
          }}
          onEditBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            stashVerseDraft(ch, verseNum, bibleVersion, plain, base);
          }}
          onSaveBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            saveVerseDraft(ch, verseNum, bibleVersion, plain, base);
          }}
          onOpenBookAligner={(ch, v, bv) => openAligner(ch, v, bv)}
          onReplaceVerse={(ch, verseNum, bibleVersion, newContent, newPlainText, base) => {
            // Find/replace ships pre-built content from smartReplaceVerse —
            // alignment is preserved when word counts match, fully
            // re-tokenized otherwise. Dual-apply to useChapter so opening
            // ⌭ right after a replace shows the new content instead of the
            // pre-replace cache.
            const newDto = {
              ...base,
              chapter: ch,
              verse: verseNum,
              bible_version: bibleVersion,
              plain_text: newPlainText,
              content: newContent,
            } as VerseDto;
            if (!enqueueVerseSafely(ch, verseNum, bibleVersion, base, newContent, newPlainText, "find_replace")) {
              return;
            }
            bookHook?.applyLocalVerse(newDto);
            if (ch === chapter) applyLocalVerse(newDto);
          }}
          onReplaceNote={(row, newNote) => {
            // Find/replace on a translation note rewrites the BODY only (id is
            // the PK, support_reference is a structured rc:// link — both stay
            // put; the overlay enforces this). Reuse the standard note save
            // path so it gets the same outbox If-Match (on row.version),
            // restored_from_version clear, and 409 merge handling as a manual
            // edit. Also patch the book-mode cache so a cross-chapter note in
            // book view updates immediately (enqueueRow's local apply only
            // touches the active chapter's useChapter data).
            enqueueRow("tn", row, { note: newNote });
            bookHook?.applyLocalRowPatch("tn", row.chapter, row.id, {
              note: newNote,
              restored_from_version: null,
            });
          }}
          onSelectVerse={(v) => requestSelectVerse(v)}
          onModeChange={(m) => {
            setMode(m);
            saveToStorage(SCRIPTURE_MODE_KEY, m);
          }}
          onEnabledVersionsChange={(versions) => {
            setEnabledVersions(versions);
            saveToStorage(ENABLED_VERSIONS_KEY, versions);
          }}
          onEditVerse={(verseNum, bibleVersion, plain, base) => {
            stashVerseDraft(chapter, verseNum, bibleVersion, plain, base);
          }}
          onSaveVerse={(verseNum, bibleVersion, plain, base) => {
            saveVerseDraft(chapter, verseNum, bibleVersion, plain, base);
          }}
          onRestoreVerse={(verseNum, bibleVersion, content, plainText, base) => {
            restoreVerse(chapter, verseNum, bibleVersion, content, plainText, base);
          }}
          onEditSection={(verseNum, bibleVersion, change, base) => {
            saveSectionEdit(chapter, verseNum, bibleVersion, change, base);
          }}
          onEditBookSection={(ch, verseNum, bibleVersion, change, base) => {
            saveSectionEdit(ch, verseNum, bibleVersion, change, base);
          }}
          onOpenAligner={(v, bv) => openAligner(chapter, v, bv)}
          onMergeVerseBridge={(ch, v, bv) => mergeVerseWithNext(ch, v, bv)}
          onSplitVerseBridge={(ch, v, bv) => splitVerseBridge(ch, v, bv)}
          scrollNonce={scrollNonce}
          onRequestScrollToActive={requestScrollToActive}
          searchNotes={getSearchNotes}
          onScrollToNoteMatch={focusNoteMatch}
          onNoteQueryChange={setFindNoteQuery}
          onActiveNoteMatchChange={setActiveNoteMatch}
          lexiconMap={lexiconMap}
          twl={data.twl}
          locked={Boolean(chapterLocks.verse)}
          bookLocked={bookLocked}
        />
        </Box>
        <Box
          onMouseDown={handleDividerMouseDown}
          sx={{
            width: "8px",
            flexShrink: 0,
            cursor: "ew-resize",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              left: "50%",
              top: 0,
              bottom: 0,
              width: "1px",
              bgcolor: "divider",
              transform: "translateX(-50%)",
              transition: "background-color 0.15s",
            },
            "&:hover::after": { bgcolor: "primary.main" },
          }}
        />
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
        <ResourceColumn
          book={book}
          chapter={chapter}
          activeVerse={activeVerse}
          checkoff={resourceCheckoff}
          displayVerseRange={displayVerseRange}
          tn={data.tn}
          tq={data.tq}
          twl={data.twl}
          ultVerseObjectsFor={ultVerseObjectsFor}
          commentCountsForRow={commentCountsForRow}
          onOpenRowComments={onOpenRowComments}
          activeNoteId={activeNoteId}
          activeWordId={activeWordId}
          activeQuestionId={activeQuestionId}
          findNoteQuery={findNoteQuery}
          activeNoteMatch={activeNoteMatch}
          scrollNonce={scrollNonce}
          jumpTab={jumpTab}
          onNoteChange={(id, patch) => {
            applyLocalRowPatch("tn", id, patch);
          }}
          onNoteSave={(id, patch, opts) => {
            const row = data.tn.find((r) => r.id === id);
            if (row) enqueueRow("tn", row, patch, opts);
          }}
          onNoteFocus={(row) => {
            setActiveNoteId(row.id);
            setActiveWordId(null);
            setActiveQuestionId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteStartAi={(row, live) => {
            // Build from the live (unsaved) note fields so SUGGEST works
            // before an explicit save — the cached data.tn row can lag the
            // box (quote propagates on a debounce; a freshly-built note may
            // not be flushed at all), which is what produced the bogus "AI
            // prerequisites missing." id/version/book/verse stay from the
            // cached row so the outbox If-Match and toast targeting hold.
            const aiRow: TnRow = {
              ...row,
              quote: live.quote,
              note: live.note,
              support_reference: live.support_reference,
            };
            const built = buildTnQuickRequest(aiRow, data);
            if (!built.ok) {
              // NoteCard gates on quote + support_reference. The remaining
              // reasons (missing ULT/UST or unalignable English) need a
              // user-actionable message.
              const message =
                built.error.reason === "missing_ult_verse"
                  ? "ULT verse text unavailable for this verse."
                  : built.error.reason === "missing_ust_verse"
                    ? "UST verse text unavailable for this verse."
                    : built.error.reason === "hebrew_not_found"
                      ? "Couldn't match this English to the ULT alignment — copy the support phrase exactly from ULT."
                      : "AI prerequisites missing.";
              aiDrafts.pushError(aiRow, message);
              return;
            }
            aiDrafts.start(aiRow, built.request, {
              getIsVisible: (id) => visibleRowIdsRef.current.has(id),
              onSuccess: (r, res) => {
                // Carry the support_reference the request was built from
                // along with this save. It may still be unsaved on the
                // server (e.g. picked on a brand-new note right before
                // hitting Suggest) — without this, this PATCH's own version
                // bump can make NoteCard's resync effect stamp the pending
                // pick back to the server's stale/null value before the
                // user gets a chance to save it themselves.
                const patch = { quote: res.quote, note: res.note, support_reference: r.support_reference };
                // Re-running the suggestion on an already-drafted note can
                // return a quote+note identical to what's stored; skip the
                // save so we don't bump the row version with a no-op (mirror
                // of the commitQuoteBuild guard). res.quote may be
                // source-derived Hebrew in a different combining-mark order
                // than the stored value, so NFC-normalize the quote compare;
                // the note is plain TSV text stored verbatim, so compare raw.
                const changed =
                  nfc(res.quote) !== nfc(r.quote ?? "") || res.note !== (r.note ?? "");
                if (!changed) return;
                applyLocalRowPatch("tn", r.id, patch);
                void outbox.enqueueRow("tn", r.id, r.version, patch, { book: r.book });
              },
            });
          }}
          isNoteAiPending={aiDrafts.isPending}
          noteAiRecentlyCompletedAt={aiDrafts.recentlyCompletedAt}
          onNoteVisibilityChange={handleNoteVisibilityChange}
          onNoteTranslateQuote={(row, english) => {
            const vo = (
              verseIndexByVersion["ULT"]?.[row.verse]?.content as
                | { verseObjects?: unknown[] }
                | null
                | undefined
            )?.verseObjects;
            if (!Array.isArray(vo)) return null;
            return findSourceForTargetText(vo, english) || null;
          }}
          onWordTranslateQuote={(row, english) => {
            const vo = (
              verseIndexByVersion["ULT"]?.[row.verse]?.content as
                | { verseObjects?: unknown[] }
                | null
                | undefined
            )?.verseObjects;
            if (!Array.isArray(vo)) return null;
            return findSourceForTargetText(vo, english) || null;
          }}
          onWordGloss={(row) => {
            // English (ULT) words aligned to this row's saved orig_words.
            // OL-anchored via the UHB/UGNT verse, mirroring the highlighter.
            if (!row.orig_words) return "";
            const ult = (
              verseIndexByVersion["ULT"]?.[row.verse]?.content as
                | { verseObjects?: unknown[] }
                | null
                | undefined
            )?.verseObjects;
            if (!Array.isArray(ult)) return "";
            const src = (
              (verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse])
                ?.content as { verseObjects?: unknown[] } | null | undefined
            )?.verseObjects;
            return extractTargetSelectionText(
              ult,
              row.orig_words,
              row.occurrence ?? 1,
              Array.isArray(src) ? src : undefined,
              // Show the gap: one source word can align to non-contiguous ULT
              // words (ISA 60:6 "and … the praises of"), and hiding that reads
              // as a phrase the ULT never says.
              { gapMarker: "…" },
            );
          }}
          onWordFocus={(row) => {
            setActiveWordId(row.id);
            setActiveNoteId(null);
            setActiveQuestionId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteCreate={async () => {
            const list = sortedForVerse(data.tn, activeVerse);
            const sort_order = pickSortOrder(list, null, "after");
            const created = (await api.createRow<TnRow>("tn", {
              book,
              chapter,
              verse: chapter === 0 ? 0 : activeVerse,
              ref_raw:
                chapter === 0
                  ? "front:intro"
                  : activeVerse === 0
                    ? `${chapter}:intro`
                    : `${chapter}:${activeVerse}`,
              note: "",
              sort_order,
            }));
            applyLocalRowInsert("tn", created);
            setActiveNoteId(created.id);
            setActiveWordId(null);
            setActiveQuestionId(null);
          }}
          onNoteInsertAfter={async (refId) => {
            const ref = data.tn.find((r) => r.id === refId);
            if (!ref) return;
            const list = sortedForVerse(data.tn, ref.verse);
            const sort_order = pickSortOrder(list, refId, "after");
            // No inherited support_reference — fresh notes get an empty
            // chip so the user can typeahead in immediately.
            const created = (await api.createRow<TnRow>("tn", {
              book,
              chapter,
              verse: chapter === 0 ? 0 : ref.verse,
              ref_raw: chapter === 0 ? "front:intro" : ref.ref_raw,
              note: "",
              sort_order,
            }));
            applyLocalRowInsert("tn", created, { afterId: refId });
            setActiveNoteId(created.id);
            setActiveWordId(null);
            setActiveQuestionId(null);
          }}
          onNoteReorder={(draggedId, refId, position) => {
            // Read the live (ref) row list, not the render-scoped `data`
            // closure: a rapid burst of arrow clicks fires several handlers
            // before React re-renders, and a stale closure would renumber from
            // an outdated order and enqueue ops carrying a stale version.
            const tn = dataRef.current?.tn ?? [];
            const dragged = tn.find((r) => r.id === draggedId);
            if (!dragged) return;
            const sorted = sortedForVerse(tn, dragged.verse);
            const changes = reorderSequential(sorted, draggedId, refId, position);
            for (const { row, sort_order } of changes) {
              enqueueRow("tn", row, { sort_order });
            }
          }}
          verseOptions={verseNumbers}
          onNoteChangeVerse={(id, verse, verseEnd) => {
            // Retarget a note to another verse in this chapter, or extend it to
            // span a range (verseEnd > verse => ref_raw "chapter:start-end").
            // Read the live row (dataRef, not the render closure) so a rapid
            // move carries the current version. Recompute ref_raw + a fresh
            // sort_order (end of the leading verse) so the note lands in order
            // there; enqueueRow applies it optimistically and PATCHes. `verse`
            // is sent explicitly, which rows.ts treats as authoritative — so a
            // range ref_raw keeps this leading verse for grouping.
            const tn = dataRef.current?.tn ?? [];
            const row = tn.find((r) => r.id === id);
            if (!row) return;
            const isRange = verseEnd != null && verseEnd > verse;
            const ref_raw =
              chapter === 0
                ? "front:intro"
                : verse === 0
                  ? `${chapter}:intro`
                  : isRange
                    ? `${chapter}:${verse}-${verseEnd}`
                    : `${chapter}:${verse}`;
            const effectiveVerse = chapter === 0 ? 0 : verse;
            if (row.verse === effectiveVerse && row.ref_raw === ref_raw) return;
            const sort_order = pickSortOrder(sortedForVerse(tn, effectiveVerse), null, "after");
            enqueueRow("tn", row, { verse: effectiveVerse, ref_raw, sort_order });
            // Follow the note to its new verse: the resource column only renders
            // notes in displayVerseRange, so without this the moved card vanishes
            // from view. Navigating there confirms the move landed. Must match
            // the stored verse (effectiveVerse), not the raw `verse` — at
            // chapter 0 the note is stored at verse 0, so navigating to the raw
            // verse would jump to a verse where it never renders.
            setActiveVerse(effectiveVerse);
            setActiveNoteId(id);
            setActiveWordId(null);
            setActiveQuestionId(null);
          }}
          onReorderPreview={handleReorderPreview}
          twlOrderLocks={twlOrderLocks ?? []}
          onTwlOrderUnlock={handleTwlOrderUnlock}
          onTwlOrderDismiss={handleTwlOrderDismiss}
          onWordCreate={async () => {
            const list = sortedForVerse(data.twl, activeVerse);
            const sort_order = pickSortOrder(list, null, "after");
            const created = (await api.createRow<TwlRow>("twl", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw:
                chapter === 0
                  ? "front:intro"
                  : activeVerse === 0
                    ? `${chapter}:intro`
                    : `${chapter}:${activeVerse}`,
              orig_words: "",
              tw_link: "",
              sort_order,
            }));
            applyLocalRowInsert("twl", created);
            setActiveWordId(created.id);
            setActiveNoteId(null);
            setActiveQuestionId(null);
          }}
          onWordReorder={async (draggedId, refId, position) => {
            // See onNoteReorder: live ref list, not the stale render closure.
            const twl = dataRef.current?.twl ?? [];
            const dragged = twl.find((r) => r.id === draggedId);
            if (!dragged) return;
            const verse = dragged.verse;
            const wasLocked = lockedTwlVerses.has(verse);

            // TAKE THE VERSE MANUAL FIRST, and only move once the server agrees.
            // Without the lock, automatic ordering recomputes this verse on the
            // next export or reimport and the move is silently reverted — and
            // because a reorder writes no edit_log, it would be unrecoverable
            // (STATE.md: the HOS revert, where a translator's ordering was lost
            // outright). So a failed lock must abort the move, not proceed with
            // an order we know won't survive the night.
            if (!wasLocked) {
              try {
                const lock = await api.lockTwlOrder(book, chapter, verse);
                applyLocalTwlOrderLock(verse, lock);
              } catch (e) {
                console.error("twl order lock failed; reorder aborted", e);
                setTwlOrderToast(
                  "Couldn't switch this verse to manual word order — nothing was moved. Try again.",
                );
                return;
              }
            }

            // Renumber from the order the user is LOOKING AT. Until this verse
            // was locked it was displayed in automatic order, which is not what
            // sort_order says — so seeding from sort_order would make the first
            // move jump somewhere unrelated. Once locked, display IS sort_order
            // and the two agree. reorderSequential renumbers the whole verse
            // 100/200/300…, which also materializes the automatic order into
            // sort_order on the way through — exactly what a locked verse needs.
            const rowsForVerse = twl.filter((r) => r.verse === verse);
            // Seed from the SAME function the Words list renders with — not
            // sortedForVerse, which breaks sort_order ties on id while
            // manualTwlOrder breaks them on position. On a verse whose rows were
            // never renumbered (null or duplicate sort_order) those two disagree,
            // and the list being renumbered would not be the list on screen.
            const sorted = wasLocked
              ? manualTwlOrder(rowsForVerse)
              : canonicalTwlOrder(rowsForVerse, ultVerseObjectsFor(verse), twTitles);
            const changes = reorderSequential(sorted, draggedId, refId, position);
            for (const { row, sort_order } of changes) {
              enqueueRow("twl", row, { sort_order });
            }
          }}
          onQuestionCreate={async () => {
            const created = (await api.createRow<TqRow>("tq", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw:
                chapter === 0
                  ? "front:intro"
                  : activeVerse === 0
                    ? `${chapter}:intro`
                    : `${chapter}:${activeVerse}`,
              question: "",
              response: "",
            }));
            applyLocalRowInsert("tq", created);
            setActiveQuestionId(created.id);
            setActiveNoteId(null);
            setActiveWordId(null);
          }}
          onQuestionFocus={(row) => {
            setActiveQuestionId(row.id);
            setActiveNoteId(null);
            setActiveWordId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteDelete={handleTrashNote}
          onNoteRestore={handleRestoreNote}
          onWordSave={(id, patch) => {
            const row = data.twl.find((r) => r.id === id);
            if (row) enqueueRow("twl", row, patch);
          }}
          onWordDelete={(id) => {
            const row = data.twl.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("twl", id);
            if (activeWordId === id) setActiveWordId(null);
            void outbox.enqueueDeleteRow("twl", id, row.version, row.book);
          }}
          onQuestionSave={(id, patch, opts) => {
            const row = data.tq.find((r) => r.id === id);
            if (row) enqueueRow("tq", row, patch, opts);
          }}
          onQuestionDelete={(id) => {
            const row = data.tq.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("tq", id);
            if (activeQuestionId === id) setActiveQuestionId(null);
            void outbox.enqueueDeleteRow("tq", id, row.version, row.book);
          }}
          lockedTn={Boolean(chapterLocks.tn)}
          lockedTq={Boolean(chapterLocks.tq)}
          bookLocked={bookLocked}
          onSetNotePreserve={handleSetNotePreserve}
          onSetNoteHint={handleSetNoteHint}
          quoteBuildActiveNoteId={quoteBuildTarget?.kind === "tn" ? quoteBuildTarget.id : null}
          quoteBuildActiveWordId={quoteBuildTarget?.kind === "twl" ? quoteBuildTarget.id : null}
          quoteBuildSelectionCount={quoteBuildSelectedKeys.size}
          quoteBuildAppliedTo={quoteBuildAppliedTo}
          onStartQuoteBuild={(noteId) => startQuoteBuild({ kind: "tn", id: noteId })}
          onStartWordQuoteBuild={(wordId) => startQuoteBuild({ kind: "twl", id: wordId })}
          onAddTwlSuggestion={handleAddTwlSuggestion}
          isTwlSuggestionExcluded={isTwlSuggestionExcluded}
          onTwlSuggestions={setVerseTwlSuggestions}
          twlRowAlternatives={twlRowAlternatives}
          twlBlockedArticleIds={twlBlockedArticleIds}
          twlFiltersReady={twlFilters.settled}
          panelMode={panelMode}
          onSetPanelMode={handleSetPanelMode}
          alignmentProps={alignmentTabProps}
          alignmentBadge={alignmentBadge}
        />
        </Box>
      </Box>
      <ChapterBoard
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        enabledLanes={enabledLanes}
        onToggleLaneVisible={toggleLaneVisible}
        book={book}
        chapter={chapter}
        tiles={tileSet}
        canCheck={meUserId != null}
        onToggle={toggleLane}
        onBulkToggle={bulkLaneToggle}
        bookLocked={bookLocked}
      />
      <Dialog open={!!pendingBulk} onClose={() => setPendingBulk(null)}>
        <DialogTitle>
          {pendingBulk?.checked ? "Check" : "Clear"} all {pendingBulk ? LANE_LABELS[pendingBulk.lane] : ""} for this chapter?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingBulk?.checked
              ? `This marks ${pendingBulk ? LANE_LABELS[pendingBulk.lane] : ""} as checked by you for all ${pendingBulk?.verses.length ?? 0} applicable verses in ${book} ${chapter}.`
              : `This removes your ${pendingBulk ? LANE_LABELS[pendingBulk.lane] : ""} checks from all ${pendingBulk?.verses.length ?? 0} applicable verses in ${book} ${chapter}.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingBulk(null)}>Cancel</Button>
          <Button variant="contained" color={pendingBulk?.checked ? "primary" : "error"} onClick={confirmBulk}>
            {pendingBulk?.checked ? "Check all" : "Clear all"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!pendingNav} onClose={dismissPendingNav}>
        <DialogTitle>Unsaved alignment changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have unsaved changes in the alignment editor. Save them before switching
            verses, discard them, or cancel to stay here.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={dismissPendingNav}>Cancel</Button>
          <Button color="error" onClick={() => resolvePendingNav("discard")}>
            Discard
          </Button>
          <Button variant="contained" onClick={() => resolvePendingNav("save")}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
      {dualAlignerProps && (
        <SideBySideAligner
          open
          onClose={requestCloseDual}
          book={dualAlignerProps.book}
          chapter={dualAlignerProps.chapter}
          verseNum={dualAlignerProps.verseNum}
          vref={dualAlignerProps.vref}
          sourceLabel={dualAlignerProps.sourceLabel}
          sourceVerse={dualAlignerProps.sourceVerse}
          twlForVerse={dualAlignerProps.twlForVerse}
          lexiconMap={lexiconMap}
          left={dualAlignerProps.left}
          right={dualAlignerProps.right}
          onPrevVerse={dualNav.prev != null ? () => dualNavTo(dualNav.prev!) : undefined}
          onNextVerse={dualNav.next != null ? () => dualNavTo(dualNav.next!) : undefined}
          // Lane checks live on the loaded chapter's useChapter state; only
          // wire when the dual popup is on that same chapter (verse arrows
          // already no-op across chapters for the same reason).
          textCheck={
            dualAlignerProps.chapter === chapter ? textLaneCheck : undefined
          }
          onSaveReading={(bv, plain, base, afterCommit) =>
            // base.verse, not verseNum — each side's row may start at a
            // different verse (ULT v7 singleton vs UST 6-9 range row).
            // afterCommit threads through so ReadingLineHandle.save (and thus
            // the resolveDualAction save chain, #490) only proceeds once this
            // actually lands — synchronously, or after the collateral-loss
            // confirm's "Save anyway".
            saveVerseDraft(dualAlignerProps.chapter, base.verse, bv, plain, base, afterCommit)
          }
        />
      )}
      <Dialog open={!!pendingAlignmentLoss} onClose={() => setPendingAlignmentLoss(null)}>
        <DialogTitle>
          {pendingAlignmentLoss && pendingAlignmentLoss.lostWords.length === 1
            ? "A word will be unaligned"
            : "Words will be unaligned"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Saving will leave{" "}
            {pendingAlignmentLoss?.lostWords.length === 1 ? "this word" : "these words"} with no
            source link in {pendingAlignmentLoss?.ref}:{" "}
            <Box component="span" sx={{ fontWeight: 700 }}>
              {pendingAlignmentLoss?.lostWords.slice(0, 8).join(", ")}
              {pendingAlignmentLoss && pendingAlignmentLoss.lostWords.length > 8
                ? ` (+${pendingAlignmentLoss.lostWords.length - 8} more)`
                : ""}
            </Box>
            . That's fine if you meant to re-align — but if it's accidental it will block the
            nightly export to master until the {pendingAlignmentLoss?.lostWords.length === 1 ? "word is" : "words are"}{" "}
            aligned again. Save anyway, or cancel to keep editing.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingAlignmentLoss(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              // Clear BEFORE running commit: commit may chain into the next
              // panel's save and open a fresh confirm (the dual aligner), and a
              // trailing setPendingAlignmentLoss(null) would clobber it.
              const commit = pendingAlignmentLoss?.commit;
              setPendingAlignmentLoss(null);
              commit?.();
            }}
          >
            Save anyway
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!pendingDualAction} onClose={() => setPendingDualAction(null)}>
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have unsaved changes in the side-by-side aligner (alignment edits or reading text).
            Save them, discard them, or cancel to keep editing.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDualAction(null)}>Cancel</Button>
          <Button color="error" onClick={() => resolveDualAction("discard")}>
            Discard
          </Button>
          <Button variant="contained" onClick={() => resolveDualAction("save")}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={!!twlOrderToast}
        autoHideDuration={6000}
        onClose={() => setTwlOrderToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setTwlOrderToast(null)} variant="filled">
          {twlOrderToast}
        </Alert>
      </Snackbar>
      <Snackbar
        open={!!bridgeToast}
        autoHideDuration={6000}
        onClose={() => setBridgeToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setBridgeToast(null)} variant="filled">
          {bridgeToast}
        </Alert>
      </Snackbar>
      <AiCompletionToasts
        notifications={aiDrafts.notifications}
        onDismiss={aiDrafts.dismiss}
        onView={(rowId, verse) => {
          runWithDirtyGate(() => {
            setActiveVerse(verse);
            setActiveNoteId(rowId);
            setActiveWordId(null);
            setActiveQuestionId(null);
            requestScrollToActive();
          });
        }}
      />
      <UnsavedToasts
        book={book}
        onSaveVerseDraft={(b, ch, v, bv) => {
          if (b !== book) return;
          // Look up the latest plain from the draft (avoids racing with
          // a still-pending typing flurry) and the base from whichever
          // cache holds the chapter — current chapter via data.verses,
          // book mode via bookHook.chapters.
          void drafts.get(verseKey(b, ch, v, bv)).then((rec) => {
            const payload = rec?.payload as { plainText?: string } | undefined;
            const plain = payload?.plainText;
            if (typeof plain !== "string") return;
            const cached =
              ch === chapter
                ? data?.verses[bv]?.[v]
                : bookHook?.chapters.get(ch)?.kind === "ready"
                  ? (bookHook.chapters.get(ch) as { kind: "ready"; data: { verses: Record<string, Record<number, VerseDto>> } }).data.verses[bv]?.[v]
                  : undefined;
            // A chapter-intro draft can exist before its row does (#379). Falling
            // back to the create-on-save base matters here specifically: without
            // it this handler returned early, so the "unsaved edits" toast offered
            // a Save button that silently did nothing and left the draft stranded
            // — the dirty border and SyncStatusBar entry that saveVerseDraft's own
            // no-op guard goes out of its way to avoid.
            const base = introEditBase(cached, b, ch, v, bv);
            if (!base) return;
            saveVerseDraft(ch, v, bv, plain, base);
          });
        }}
        onJumpTo={(b, ch, v) => {
          if (b !== book) return;
          runWithDirtyGate(() => {
            if (ch !== chapter) onNavigate?.(b, ch, v);
            else {
              setActiveVerse(v);
              requestScrollToActive();
            }
          });
        }}
      />
      {quoteBuildContext && (
        <QuoteBuilderPopper
          open={!!quoteBuildAnchor}
          anchorEl={quoteBuildAnchor}
          book={book}
          chapter={chapter}
          verse={quoteBuildContext.verse}
          uhbVerseObjects={quoteBuildContext.uhb}
          ultVerseObjects={quoteBuildContext.ult}
          ustVerseObjects={quoteBuildContext.ust}
          lexiconMap={lexiconMap}
          selectedKeys={quoteBuildSelectedKeys}
          onToggleKey={toggleQuoteBuildWord}
          onSelectKeys={selectQuoteBuildWords}
          onCancel={cancelQuoteBuild}
          onCommit={commitQuoteBuild}
        />
      )}
      {/* Fallback popover anchor for deep links, where there is no clicked
          element. Zero-size and fixed at the centre-right of the viewport, so
          the (left-start placed) panel lands centred rather than in the corner. */}
      <Box
        ref={setCommentFallbackAnchor}
        sx={{ position: "fixed", top: "50%", left: "70%", width: 0, height: 0, pointerEvents: "none" }}
      />
      {commentTarget && (
        <CommentsPopover
          key={targetKey(commentTarget)}
          open
          anchorEl={commentAnchor ?? commentFallbackAnchor}
          target={commentTarget}
          threads={commentThreads}
          mentionUsers={mentionUsers}
          meUserId={meUserId}
          canWrite={commentsEnabled}
          highlightCommentId={highlightCommentId}
          loading={commentsLoading}
          errorText={
            commentsError ? "Comments unavailable — could not load them for this chapter." : null
          }
          onRetryLoad={reloadComments}
          initialBody={commentDraftKey ? (composerDraftsRef.current.get(commentDraftKey) ?? "") : ""}
          onBodyChange={handleComposerBodyChange}
          replyInitialBody={getReplyDraft}
          onReplyBodyChange={handleReplyBodyChange}
          onClose={closeComments}
          onCreate={handleCreateComment}
          onEdit={editComment}
          onResolve={setCommentResolved}
          onDelete={removeComment}
        />
      )}
    </Box>
  );
}

// ---------- sort_order helpers ----------

type Sortable = { id: string; verse: number; sort_order: number | null };

function formatRelative(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function sortedForVerse<T extends Sortable>(rows: T[], verse: number): T[] {
  return rows
    .filter((r) => r.verse === verse)
    .sort(
      (a, b) =>
        (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
}

// Pick a sort_order so the new/moved row lands at the requested slot. Falls
// back to step-of-100 gaps when neighbors lack a sort_order yet. `excludeId`
// is set when reordering an existing row — we don't want it in the list when
// computing midpoints, otherwise drop-after-self collapses to a no-op midpoint
// inside its own slot.
function pickSortOrder<T extends Sortable>(
  rows: T[],
  refId: string | null,
  position: "before" | "after",
  excludeId?: string,
): number {
  const list = excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
  if (list.length === 0) return 100;
  if (!refId) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const idx = list.findIndex((r) => r.id === refId);
  if (idx < 0) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const target = list[idx];
  const targetSort = target.sort_order ?? (idx + 1) * 100;
  if (position === "before") {
    const prev = list[idx - 1];
    const prevSort = prev?.sort_order ?? targetSort - 200;
    return (prevSort + targetSort) / 2;
  }
  const next = list[idx + 1];
  const nextSort = next?.sort_order ?? targetSort + 200;
  return (targetSort + nextSort) / 2;
}

// Reorder by full sequential renumbering (step 100) rather than a single
// midpoint. Moving `draggedId` to the slot at (refId, position) and assigning
// every row a fresh 100,200,300,… value. Returns only the rows whose value
// changed, each paired with its new sort_order.
//
// Why renumber instead of pickSortOrder: imported rows all have sort_order =
// null, and the sort collapses every null to one key (ordered by id). A lone
// midpoint value can't be slotted *between* two nulls — it sorts before or
// after the entire null group — so a moved row jumps to an end instead of
// advancing one slot. Renumbering gives the whole verse real, ordered values
// in one pass; subsequent moves only touch the rows that actually shifted.
function reorderSequential<T extends Sortable>(
  sorted: T[],
  draggedId: string,
  refId: string | null,
  position: "before" | "after",
): Array<{ row: T; sort_order: number }> {
  const dragged = sorted.find((r) => r.id === draggedId);
  if (!dragged) return [];
  const without = sorted.filter((r) => r.id !== draggedId);
  let insertIdx: number;
  if (refId == null) {
    insertIdx = position === "before" ? 0 : without.length;
  } else {
    const refIdx = without.findIndex((r) => r.id === refId);
    insertIdx = refIdx < 0 ? without.length : position === "before" ? refIdx : refIdx + 1;
  }
  const next = [...without.slice(0, insertIdx), dragged, ...without.slice(insertIdx)];
  const changes: Array<{ row: T; sort_order: number }> = [];
  next.forEach((row, i) => {
    const sort_order = (i + 1) * 100;
    if (row.sort_order !== sort_order) changes.push({ row, sort_order });
  });
  return changes;
}

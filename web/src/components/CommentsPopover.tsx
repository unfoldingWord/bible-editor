// Popover for reading/writing internal comment threads on a verse or a
// tn/tq/twl row. Follows the QuoteBuilderPopper Popper idiom (Popper +
// ClickAwayListener + Paper elevation={8}); mention-run rendering follows
// NoteBodyReadView's inline-highlight idiom in NoteCard.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Popper,
  Paper,
  Stack,
  Box,
  Chip,
  Button,
  IconButton,
  Typography,
  Divider,
  ClickAwayListener,
  TextField,
  ToggleButtonGroup,
  ToggleButton,
  Alert,
  List,
  ListItemButton,
  ListItemText,
  CircularProgress,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { CommentTarget, NewCommentDraft } from "./commentsTarget";
import type { CommentThread } from "../lib/commentsIndex";
import type { CommentDto, CommentKind, MentionUser } from "../sync/api";
import { splitMentions } from "../lib/mentions";
import { relativeTime } from "../lib/relativeTime";

export interface CommentsPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  target: CommentTarget;
  threads: CommentThread[];
  mentionUsers: MentionUser[];
  meUserId: number | null;
  canWrite: boolean;
  highlightCommentId: number | null;
  loading?: boolean;
  errorText?: string | null;
  // Retry the chapter's comments load. Offered in the error banner, because
  // while the load is broken we also block posting — so the user needs a way
  // out that isn't "reload the whole app".
  onRetryLoad?: () => void;
  // Seeds the new-comment composer's body on mount, and reports back as the
  // user types — lets Shell stash unposted text across a close/reopen of this
  // (unmounting) popover, keyed by target. See the composer-persistence note
  // in Shell.tsx.
  initialBody?: string;
  onBodyChange?: (body: string) => void;
  // Same idea for a reply composer, keyed by which thread it's replying to.
  replyInitialBody?: (parentId: number) => string;
  onReplyBodyChange?: (parentId: number, body: string) => void;
  onClose: () => void;
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onEdit: (id: number, body: string) => Promise<void>;
  onResolve: (id: number, resolved: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

const ROW_KIND_LABEL: Record<string, string> = {
  tn: "Note row",
  tq: "Question row",
  twl: "Word row",
};

export function CommentsPopover({
  open,
  anchorEl,
  target,
  threads,
  mentionUsers,
  meUserId,
  canWrite,
  highlightCommentId,
  loading = false,
  errorText = null,
  onRetryLoad,
  initialBody,
  onBodyChange,
  replyInitialBody,
  onReplyBodyChange,
  onClose,
  onCreate,
  onEdit,
  onResolve,
  onDelete,
}: CommentsPopoverProps) {
  const [actionError, setActionError] = useState<string | null>(null);

  const title =
    target.rowKind == null
      ? `Verse ${target.verse}`
      : (ROW_KIND_LABEL[target.rowKind] ?? "Row");

  // Reset the local error banner whenever the popover re-targets, so a stale
  // failure from a different thread doesn't linger.
  useEffect(() => {
    setActionError(null);
  }, [target.verse, target.rowKind, target.rowId]);

  // Escape closes, at the document level rather than only via the Paper's own
  // onKeyDown. We deliberately don't trap focus, so focus is usually NOT inside
  // the panel — on a deep-link arrival it's wherever the user left it — and a
  // Paper-only handler would never see the key. The mention picker's own
  // Escape handler stopPropagation()s, so it still gets first refusal and
  // closes the picker before this ever closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't steal an Escape that another overlay already acted on. The find
      // bar, the section-header editor and the top bar all handle Escape with
      // preventDefault (without stopping propagation), so dismissing one of
      // those would otherwise close this panel too and silently drop an
      // unposted draft.
      if (e.defaultPrevented) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement="left-start"
      modifiers={[
        { name: "offset", options: { offset: [0, 8] } },
        { name: "preventOverflow", options: { padding: 8 } },
      ]}
      popperOptions={{ strategy: "fixed" }}
      sx={{ zIndex: (t) => t.zIndex.modal }}
    >
      <ClickAwayListener
        onClickAway={(event) => {
          // A badge click for a DIFFERENT anchor lands outside this Paper's
          // React tree, so without this guard onClickAway fires alongside the
          // badge's own onOpen and React 18 batches them into a net "closed"
          // — the user would have to click twice to move the popover. Badge
          // buttons carry data-comments-badge so their clicks are excluded
          // here; Shell's openComments handles same-anchor toggle-close.
          const target = event.target;
          if (target instanceof Element && target.closest("[data-comments-badge]")) return;
          onClose();
        }}
      >
        <Paper
          elevation={8}
          role="dialog"
          aria-label={title}
          sx={{
            width: 440,
            maxHeight: "70vh",
            overflow: "auto",
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          <Stack
            direction="row"
            alignItems="center"
            sx={{
              px: 1.5,
              py: 0.75,
              borderBottom: "1px solid",
              borderColor: "divider",
              bgcolor: "primary.50",
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700 }}
            >
              {title}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <IconButton size="small" onClick={onClose} aria-label="close" sx={{ p: 0.25 }}>
              <CloseIcon fontSize="inherit" />
            </IconButton>
          </Stack>

          {errorText && (
            <Alert
              severity="warning"
              sx={{ m: 1.5 }}
              action={
                onRetryLoad ? (
                  <Button size="small" color="inherit" onClick={onRetryLoad}>
                    Retry
                  </Button>
                ) : undefined
              }
            >
              {errorText}
            </Alert>
          )}
          {actionError && (
            <Alert severity="error" sx={{ m: 1.5 }} onClose={() => setActionError(null)}>
              {actionError}
            </Alert>
          )}

          <Box sx={{ px: 1.5, py: 1 }}>
            {threads.length === 0 ? (
              // Only claim "none" when we actually know there are none. If the
              // load failed, errorText is already saying so and asserting
              // emptiness next to it is the exact confusion we're avoiding.
              // Same reasoning for a fetch still in flight: don't assert
              // emptiness while we don't yet know.
              errorText ? null : loading ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <CircularProgress size={16} />
                  <Typography variant="caption" color="text.secondary">
                    Loading…
                  </Typography>
                </Stack>
              ) : (
                <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>
                  No comments yet.
                </Typography>
              )
            ) : (
              threads.map((thread) => (
                <ThreadView
                  key={thread.root.id}
                  thread={thread}
                  blockedReason={
                    errorText ? "Comments couldn't be loaded for this chapter — retry above before posting." : null
                  }
                  mentionUsers={mentionUsers}
                  meUserId={meUserId}
                  canWrite={canWrite}
                  highlightCommentId={highlightCommentId}
                  onEdit={onEdit}
                  onResolve={onResolve}
                  onDelete={onDelete}
                  onCreate={onCreate}
                  onError={setActionError}
                  replyInitialBody={replyInitialBody}
                  onReplyBodyChange={onReplyBodyChange}
                />
              ))
            )}
          </Box>

          {canWrite && (
            <>
              <Divider />
              <NewCommentComposer
                mentionUsers={mentionUsers}
                blockedReason={
                  errorText ? "Comments couldn't be loaded for this chapter — retry above before posting." : null
                }
                onCreate={onCreate}
                onError={setActionError}
                initialBody={initialBody}
                onBodyChange={onBodyChange}
              />
            </>
          )}
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}

// ── Thread ──────────────────────────────────────────────────────────────

function ThreadView({
  thread,
  blockedReason,
  mentionUsers,
  meUserId,
  canWrite,
  highlightCommentId,
  onEdit,
  onResolve,
  onDelete,
  onCreate,
  onError,
  replyInitialBody,
  onReplyBodyChange,
}: {
  thread: CommentThread;
  blockedReason: string | null;
  mentionUsers: MentionUser[];
  meUserId: number | null;
  canWrite: boolean;
  highlightCommentId: number | null;
  onEdit: (id: number, body: string) => Promise<void>;
  onResolve: (id: number, resolved: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onError: (msg: string | null) => void;
  replyInitialBody?: (parentId: number) => string;
  onReplyBodyChange?: (parentId: number, body: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const { root, replies } = thread;
  const resolved = root.resolvedAt != null;

  return (
    <Box sx={{ mb: 1.5 }}>
      <CommentCard
        comment={root}
        kind={root.kind}
        resolved={resolved}
        mentionUsers={mentionUsers}
        meUserId={meUserId}
        canWrite={canWrite}
        highlightCommentId={highlightCommentId}
        onEdit={onEdit}
        onResolve={onResolve}
        onDelete={onDelete}
        onError={onError}
        extraActions={
          canWrite && !resolved ? (
            <Button size="small" onClick={() => setReplying((v) => !v)}>
              Reply
            </Button>
          ) : null
        }
      />
      {replies.map((reply) => (
        <Box key={reply.id} sx={{ pl: 2, borderLeft: "1px solid", borderColor: "divider", mt: 0.5 }}>
          <CommentCard
            comment={reply}
            kind={null}
            resolved={false}
            mentionUsers={mentionUsers}
            meUserId={meUserId}
            canWrite={canWrite}
            highlightCommentId={highlightCommentId}
            onEdit={onEdit}
            onResolve={onResolve}
            onDelete={onDelete}
            onError={onError}
          />
        </Box>
      ))}
      {replying && (
        <Box sx={{ pl: 2, mt: 0.5 }}>
          <ReplyComposer
            parentId={root.id}
            mentionUsers={mentionUsers}
            onCreate={onCreate}
            onError={onError}
            onDone={() => setReplying(false)}
            blockedReason={blockedReason}
            initialBody={replyInitialBody?.(root.id) ?? ""}
            onBodyChange={(body) => onReplyBodyChange?.(root.id, body)}
          />
        </Box>
      )}
    </Box>
  );
}

// ── Single comment card (root or reply) ────────────────────────────────

function CommentCard({
  comment,
  kind,
  resolved,
  mentionUsers,
  meUserId,
  canWrite,
  highlightCommentId,
  onEdit,
  onResolve,
  onDelete,
  onError,
  extraActions,
}: {
  comment: CommentDto;
  kind: CommentKind | null; // null => reply, don't show a kind chip
  resolved: boolean;
  mentionUsers: MentionUser[];
  meUserId: number | null;
  canWrite: boolean;
  highlightCommentId: number | null;
  onEdit: (id: number, body: string) => Promise<void>;
  onResolve: (id: number, resolved: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onError: (msg: string | null) => void;
  extraActions?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Local in-flight guard for this card's own mutations (save/resolve/delete).
  // Local rather than a prop threaded from Shell so it can't get out of sync.
  // The REF is what actually blocks a double-click: clicks landing in one tick
  // all read the pre-render value of `pending`, so a state-only guard lets them
  // all through. `pending` just drives the disabled styling.
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const isHighlighted = comment.id === highlightCommentId;
  const isMine = comment.authorId === meUserId;
  const knownUsernames = useMemo(() => mentionUsers.map((u) => u.username), [mentionUsers]);
  const segments = useMemo(
    () => splitMentions(comment.body, knownUsernames),
    [comment.body, knownUsernames],
  );

  useEffect(() => {
    if (isHighlighted) {
      cardRef.current?.scrollIntoView({ block: "nearest" });
    }
    // Only re-run when the highlighted id changes/arrives, matching
    // NoteBodyReadView's scroll-once-on-arrival behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightCommentId]);

  // Resync the draft when the comment's body changes out from under us (e.g. a
  // comment.updated WS event) — but only while not actively editing, so we
  // never clobber text the user is mid-typing. Without this, editing after
  // such an update would silently revert the newer body on save.
  useEffect(() => {
    if (!editing) setDraft(comment.body);
  }, [comment.body, editing]);

  async function handleSave() {
    if (inFlight.current) return;
    const body = draft.trim();
    if (!body) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onEdit(comment.id, body);
      setEditing(false);
      onError(null);
    } catch {
      onError("Failed to save the edit. Your text is still here — try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function handleResolveToggle() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onResolve(comment.id, !resolved);
      onError(null);
    } catch {
      onError(`Failed to ${resolved ? "reopen" : "resolve"} the thread.`);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function handleDelete() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onDelete(comment.id);
      onError(null);
    } catch {
      onError("Failed to delete the comment.");
      setConfirmingDelete(false);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Box
      ref={cardRef}
      data-comment-id={comment.id}
      sx={{
        p: 1,
        borderRadius: 1,
        opacity: resolved ? 0.6 : 1,
        ...(isHighlighted
          ? { outline: "2px solid", outlineColor: "primary.main" }
          : {}),
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.25 }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          {comment.authorName}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {relativeTime(comment.createdAt)}
        </Typography>
        {kind === "question" && (
          <Chip
            label="Question"
            size="small"
            variant="outlined"
            sx={{ height: 22, fontSize: 11, color: "warning.main", borderColor: "warning.main" }}
          />
        )}
        {kind === "note" && (
          <Chip
            label="Note"
            size="small"
            variant="outlined"
            sx={{ height: 22, fontSize: 11, color: "text.secondary" }}
          />
        )}
      </Stack>

      {resolved && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          Resolved by {comment.resolvedByName ?? "someone"}
        </Typography>
      )}

      {editing ? (
        <Stack spacing={0.5}>
          <MentionTextField
            value={draft}
            onChange={setDraft}
            mentionUsers={mentionUsers}
            multiline
            size="small"
            autoFocus
          />
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={handleSave} disabled={!draft.trim() || pending}>
              Save
            </Button>
            <Button
              size="small"
              onClick={() => {
                setDraft(comment.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      ) : (
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
          {segments.map((seg, i) =>
            seg.isMention ? (
              <Box
                component="span"
                key={i}
                sx={{ color: "primary.main", fontWeight: 600 }}
              >
                {seg.text}
              </Box>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </Typography>
      )}

      {!editing && (
        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
          {canWrite && kind !== null && (
            <Button size="small" onClick={handleResolveToggle} disabled={pending}>
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
          {extraActions}
          {isMine && canWrite && (
            <>
              <Button size="small" onClick={() => setEditing(true)} disabled={pending}>
                Edit
              </Button>
              {confirmingDelete ? (
                <>
                  <Typography variant="caption" sx={{ alignSelf: "center" }}>
                    Delete?
                  </Typography>
                  <Button size="small" color="error" onClick={handleDelete} disabled={pending}>
                    Yes
                  </Button>
                  <Button size="small" onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="small" onClick={() => setConfirmingDelete(true)} disabled={pending}>
                  Delete
                </Button>
              )}
            </>
          )}
        </Stack>
      )}
    </Box>
  );
}

// ── Reply composer ─────────────────────────────────────────────────────

function ReplyComposer({
  parentId,
  mentionUsers,
  onCreate,
  onError,
  onDone,
  blockedReason,
  initialBody = "",
  onBodyChange,
}: {
  parentId: number;
  blockedReason: string | null;
  mentionUsers: MentionUser[];
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onError: (msg: string | null) => void;
  onDone: () => void;
  initialBody?: string;
  onBodyChange?: (body: string) => void;
}) {
  const [body, setBody] = useState(initialBody);
  // Local in-flight guard — see the identical comment on CommentCard.
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  function updateBody(next: string) {
    setBody(next);
    onBodyChange?.(next);
  }

  async function handleSend() {
    if (inFlight.current) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    inFlight.current = true;
    setPending(true);
    try {
      // kind is ignored server-side for replies (inherits the root's kind).
      await onCreate({ kind: "note", body: trimmed, parentId });
      onError(null);
      setBody("");
      onBodyChange?.("");
      onDone();
    } catch {
      onError("Failed to post the reply. Your text is still here — try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Stack spacing={0.5}>
      <MentionTextField
        value={body}
        onChange={updateBody}
        mentionUsers={mentionUsers}
        multiline
        size="small"
        autoFocus
        placeholder="Write a reply…"
      />
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="contained"
          onClick={handleSend}
          disabled={!body.trim() || pending || blockedReason != null}
          title={blockedReason ?? undefined}
        >
          Send
        </Button>
        <Button size="small" onClick={onDone}>
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
}

// ── New top-level comment composer ─────────────────────────────────────

function NewCommentComposer({
  mentionUsers,
  onCreate,
  onError,
  blockedReason,
  initialBody = "",
  onBodyChange,
}: {
  mentionUsers: MentionUser[];
  blockedReason: string | null;
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onError: (msg: string | null) => void;
  initialBody?: string;
  onBodyChange?: (body: string) => void;
}) {
  const [kind, setKind] = useState<CommentKind>("question");
  const [body, setBody] = useState(initialBody);
  // Local in-flight guard — see the identical comment on CommentCard.
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  function updateBody(next: string) {
    setBody(next);
    onBodyChange?.(next);
  }

  async function handlePost() {
    // The ref, not the state, is what actually prevents a double post: several
    // clicks in one tick all observe the pre-render value of `pending`, so
    // guarding on state lets every one of them through and posts duplicates
    // (verified — three fast clicks created three comments). The state exists
    // only to disable the button visually once React re-renders.
    if (inFlight.current) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onCreate({ kind, body: trimmed });
      onError(null);
      setBody("");
      onBodyChange?.("");
    } catch {
      onError("Failed to post the comment. Your text is still here — try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Stack spacing={1} sx={{ p: 1.5 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={kind}
        onChange={(_, v) => v && setKind(v)}
      >
        <ToggleButton value="question">Question</ToggleButton>
        <ToggleButton value="note">Note</ToggleButton>
      </ToggleButtonGroup>
      <MentionTextField
        value={body}
        onChange={updateBody}
        mentionUsers={mentionUsers}
        multiline
        size="small"
        placeholder="Ask a question or leave a note for the team…"
      />
      {/* Blocked while the chapter's comments couldn't be loaded: the panel was
          otherwise happy to take a post that then failed, so the user saw an
          "unavailable" banner and a "failed to post" error side by side and had
          no idea which to believe. Their text is kept either way; the banner's
          Retry is the way forward. */}
      <Button
        size="small"
        variant="contained"
        onClick={handlePost}
        disabled={!body.trim() || pending || blockedReason != null}
        title={blockedReason ?? undefined}
        sx={{ alignSelf: "flex-start" }}
      >
        Post
      </Button>
    </Stack>
  );
}

// ── Shared mention-aware text field ────────────────────────────────────
// Typing "@" plus at least one character opens a small filtered picker
// anchored to the field. ArrowUp/ArrowDown move the highlight; Enter, Tab or a
// click accept it, replacing the typed "@token" with "@username "; Escape
// closes the list without touching the text.

function MentionTextField({
  value,
  onChange,
  mentionUsers,
  multiline,
  size,
  autoFocus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mentionUsers: MentionUser[];
  multiline?: boolean;
  size?: "small" | "medium";
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  // Which suggestion Enter/Tab will accept. Reset whenever the query changes,
  // so the highlight never points past the end of a freshly filtered list.
  const [activeIndex, setActiveIndex] = useState(0);
  // Set while a pointer is down on a suggestion, so a stray blur mid-tap
  // can't close the picker before the tap is delivered (see handleBlur).
  const pickerPointerDownRef = useRef(false);

  const filtered = useMemo(() => {
    const q = pickerQuery.toLowerCase();
    return mentionUsers
      .filter(
        (u) =>
          u.username.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [mentionUsers, pickerQuery]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    onChange(next);

    // Look backwards from the caret for an unterminated "@token". The `@`
    // must sit at the start of the value or be preceded by whitespace —
    // matches the server's rule (api/src/mentions.ts: `@` not preceded by a
    // word char) so typing "foo@bar" doesn't pop the picker for a mention the
    // server would never resolve anyway.
    const upToCaret = next.slice(0, caret);
    // At least one character after the "@": a bare "@" would otherwise match
    // every user (`includes("")` is always true) and open a full list, so Enter
    // would insert a name instead of a newline and Tab could not leave the
    // field — after typing something as ordinary as "compare with 1:3 @".
    const match = /(?:^|\s)@([A-Za-z0-9._-]+)$/.exec(upToCaret);
    if (match) {
      // match[0] may include a leading whitespace char (the `(?:^|\s)`
      // branch) — measure back from the "@" itself (1 char) plus the
      // captured username query, not match[0].length, or mentionStart would
      // land one character early (on the whitespace) whenever the mention
      // isn't at the very start of the field.
      setMentionStart(caret - match[1].length - 1);
      setPickerQuery(match[1]);
      setPickerOpen(true);
      setActiveIndex(0);
    } else {
      setPickerOpen(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!pickerOpen) return;
    // Escape is handled whenever the picker is OPEN, even with no matches to
    // show. Gating it on `filtered.length` let Escape bubble to the panel's
    // document listener and close the whole panel — which silently discarded
    // an in-progress comment edit, whose draft (unlike the composers') isn't
    // cached anywhere.
    if (e.key === "Escape") {
      setPickerOpen(false);
      e.stopPropagation();
      return;
    }
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    // Enter and Tab both accept the highlighted suggestion. preventDefault so
    // Enter doesn't insert a newline in the multiline field and Tab doesn't
    // move focus out of the composer; stopPropagation so the panel's own
    // handlers don't also react.
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      selectUser(filtered[activeIndex] ?? filtered[0]);
    }
  }

  function handleBlur() {
    // Close when focus genuinely leaves. A mouse click on a suggestion does not
    // reach here (the items preventDefault on mousedown, so the field never
    // blurs), but touch environments don't all behave that way — and if a blur
    // does slip through mid-tap, closing synchronously would unmount the item
    // and swallow the tap, which is exactly the bug this PR fixes. The pointer
    // flag keeps that from regressing without reintroducing the
    // requestAnimationFrame that lost the click in the first place.
    if (pickerPointerDownRef.current) return;
    setPickerOpen(false);
  }

  function selectUser(user: MentionUser) {
    if (mentionStart == null) return;
    // Replace exactly the "@query" token we opened the picker on — do NOT use
    // the live caret as the end of the replaced range. The caret can move
    // without any input event (ArrowLeft/Right, Home/End, Ctrl+Arrow), which
    // left `mentionStart` pointing at the token while the caret pointed
    // somewhere else, so accepting a suggestion spliced across unrelated text:
    // "hello @chri" + ArrowLeft ArrowLeft + Enter produced
    // "hello @christina ri", and Home duplicated the whole body.
    const token = `@${pickerQuery}`;
    if (value.slice(mentionStart, mentionStart + token.length) !== token) {
      // The text moved under us — bail rather than corrupt it.
      setPickerOpen(false);
      return;
    }
    const before = value.slice(0, mentionStart);
    const after = value.slice(mentionStart + token.length);
    const next = `${before}@${user.username} ${after}`;
    onChange(next);
    setPickerOpen(false);
    // Restore focus + caret after the inserted mention.
    requestAnimationFrame(() => {
      const pos = before.length + user.username.length + 2;
      fieldRef.current?.focus();
      fieldRef.current?.setSelectionRange(pos, pos);
    });
  }

  return (
    <Box sx={{ position: "relative" }}>
      <TextField
        inputRef={fieldRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        multiline={multiline}
        size={size}
        autoFocus={autoFocus}
        placeholder={placeholder}
        fullWidth
        minRows={multiline ? 2 : undefined}
      />
      {pickerOpen && filtered.length > 0 && (
        <Popper
          open
          anchorEl={fieldRef.current}
          placement="bottom-start"
          sx={{ zIndex: (t) => t.zIndex.modal + 1, width: 240 }}
        >
          <ClickAwayListener onClickAway={() => setPickerOpen(false)}>
            <Paper elevation={4}>
              <List dense disablePadding role="listbox">
                {filtered.map((u, i) => (
                  <ListItemButton
                    key={u.id}
                    selected={i === activeIndex}
                    role="option"
                    aria-selected={i === activeIndex}
                    // Keep focus (and therefore the caret) in the field: without
                    // this the mousedown blurs it, which closes the picker and
                    // unmounts this item before the click lands.
                    onMouseDown={(e) => {
                      pickerPointerDownRef.current = true;
                      e.preventDefault();
                    }}
                    onTouchStart={() => {
                      pickerPointerDownRef.current = true;
                    }}
                    onClick={() => {
                      pickerPointerDownRef.current = false;
                      selectUser(u);
                    }}
                  >
                    <ListItemText primary={u.fullName} secondary={`@${u.username}`} />
                  </ListItemButton>
                ))}
              </List>
            </Paper>
          </ClickAwayListener>
        </Popper>
      )}
    </Box>
  );
}

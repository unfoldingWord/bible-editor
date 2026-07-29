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
  busy?: boolean;
  errorText?: string | null;
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
  busy = false,
  errorText = null,
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

  if (!open) return null;

  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement="left-start"
      modifiers={[
        { name: "offset", options: { offset: [0, 8] } },
        { name: "preventOverflow", options: { padding: 8 } },
      ]}
      sx={{ zIndex: (t) => t.zIndex.modal }}
    >
      <ClickAwayListener onClickAway={onClose}>
        <Paper
          elevation={8}
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
            <Alert severity="warning" sx={{ m: 1.5 }}>
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
              errorText ? null : (
                <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>
                  No comments yet.
                </Typography>
              )
            ) : (
              threads.map((thread) => (
                <ThreadView
                  key={thread.root.id}
                  thread={thread}
                  mentionUsers={mentionUsers}
                  meUserId={meUserId}
                  canWrite={canWrite}
                  highlightCommentId={highlightCommentId}
                  busy={busy}
                  onEdit={onEdit}
                  onResolve={onResolve}
                  onDelete={onDelete}
                  onCreate={onCreate}
                  onError={setActionError}
                />
              ))
            )}
          </Box>

          {canWrite && (
            <>
              <Divider />
              <NewCommentComposer
                mentionUsers={mentionUsers}
                busy={busy}
                onCreate={onCreate}
                onError={setActionError}
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
  mentionUsers,
  meUserId,
  canWrite,
  highlightCommentId,
  busy,
  onEdit,
  onResolve,
  onDelete,
  onCreate,
  onError,
}: {
  thread: CommentThread;
  mentionUsers: MentionUser[];
  meUserId: number | null;
  canWrite: boolean;
  highlightCommentId: number | null;
  busy: boolean;
  onEdit: (id: number, body: string) => Promise<void>;
  onResolve: (id: number, resolved: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onError: (msg: string | null) => void;
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
        busy={busy}
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
            busy={busy}
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
            busy={busy}
            onCreate={onCreate}
            onError={onError}
            onDone={() => setReplying(false)}
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
  busy,
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
  busy: boolean;
  onEdit: (id: number, body: string) => Promise<void>;
  onResolve: (id: number, resolved: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onError: (msg: string | null) => void;
  extraActions?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  async function handleSave() {
    const body = draft.trim();
    if (!body) return;
    try {
      await onEdit(comment.id, body);
      setEditing(false);
      onError(null);
    } catch {
      onError("Failed to save the edit. Your text is still here — try again.");
    }
  }

  async function handleResolveToggle() {
    try {
      await onResolve(comment.id, !resolved);
      onError(null);
    } catch {
      onError(`Failed to ${resolved ? "reopen" : "resolve"} the thread.`);
    }
  }

  async function handleDelete() {
    try {
      await onDelete(comment.id);
      onError(null);
    } catch {
      onError("Failed to delete the comment.");
      setConfirmingDelete(false);
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
            <Button size="small" onClick={handleSave} disabled={!draft.trim() || busy}>
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
            <Button size="small" onClick={handleResolveToggle} disabled={busy}>
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
          {extraActions}
          {isMine && canWrite && (
            <>
              <Button size="small" onClick={() => setEditing(true)} disabled={busy}>
                Edit
              </Button>
              {confirmingDelete ? (
                <>
                  <Typography variant="caption" sx={{ alignSelf: "center" }}>
                    Delete?
                  </Typography>
                  <Button size="small" color="error" onClick={handleDelete} disabled={busy}>
                    Yes
                  </Button>
                  <Button size="small" onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="small" onClick={() => setConfirmingDelete(true)} disabled={busy}>
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
  busy,
  onCreate,
  onError,
  onDone,
}: {
  parentId: number;
  mentionUsers: MentionUser[];
  busy: boolean;
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onError: (msg: string | null) => void;
  onDone: () => void;
}) {
  const [body, setBody] = useState("");

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      // kind is ignored server-side for replies (inherits the root's kind).
      await onCreate({ kind: "note", body: trimmed, parentId });
      onError(null);
      setBody("");
      onDone();
    } catch {
      onError("Failed to post the reply. Your text is still here — try again.");
    }
  }

  return (
    <Stack spacing={0.5}>
      <MentionTextField
        value={body}
        onChange={setBody}
        mentionUsers={mentionUsers}
        multiline
        size="small"
        autoFocus
        placeholder="Write a reply…"
      />
      <Stack direction="row" spacing={1}>
        <Button size="small" variant="contained" onClick={handleSend} disabled={!body.trim() || busy}>
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
  busy,
  onCreate,
  onError,
}: {
  mentionUsers: MentionUser[];
  busy: boolean;
  onCreate: (draft: NewCommentDraft) => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [kind, setKind] = useState<CommentKind>("question");
  const [body, setBody] = useState("");

  async function handlePost() {
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      await onCreate({ kind, body: trimmed });
      onError(null);
      setBody("");
    } catch {
      onError("Failed to post the comment. Your text is still here — try again.");
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
        onChange={setBody}
        mentionUsers={mentionUsers}
        multiline
        size="small"
        placeholder="Ask a question or leave a note for the team…"
      />
      <Button
        size="small"
        variant="contained"
        onClick={handlePost}
        disabled={!body.trim() || busy}
        sx={{ alignSelf: "flex-start" }}
      >
        Post
      </Button>
    </Stack>
  );
}

// ── Shared mention-aware text field ────────────────────────────────────
// Typing "@" opens a small filtered picker anchored to the field; selecting
// a user inserts "@username " at the caret and closes the list. Escape
// closes it too. Deliberately simple — no arrow-key navigation, per spec.

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

    // Look backwards from the caret for an unterminated "@token".
    const upToCaret = next.slice(0, caret);
    const match = /@([A-Za-z0-9._-]*)$/.exec(upToCaret);
    if (match) {
      setMentionStart(caret - match[0].length);
      setPickerQuery(match[1]);
      setPickerOpen(true);
    } else {
      setPickerOpen(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && pickerOpen) {
      setPickerOpen(false);
      e.stopPropagation();
    }
  }

  function selectUser(user: MentionUser) {
    if (mentionStart == null || !fieldRef.current) return;
    const caret = fieldRef.current.selectionStart ?? value.length;
    const before = value.slice(0, mentionStart);
    const after = value.slice(caret);
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
              <List dense disablePadding>
                {filtered.map((u) => (
                  <ListItemButton key={u.id} onClick={() => selectUser(u)}>
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

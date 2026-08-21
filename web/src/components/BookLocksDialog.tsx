// Lists all 66 books with their lock state and lets a lock admin
// (Benjamin, Rich, or Perry) toggle locks. A locked book is read-only in
// the app and frozen out of the nightly Door43 export; published books are
// locked automatically by the server (lockSource: "published") and can
// still be unlocked by hand if needed.

import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { ApiError, REVIEW_BRANCH, api, type BookListEntry, type PushLockedBookResponse } from "../sync/api";
import { BOOKS, bookName } from "../lib/bookNames";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
  // Book list + admin flag now come from Shell's single `useBookLocks`
  // instance instead of a second one here — two live instances each
  // refetching on window focus meant every focus fired GET /api/books
  // twice. `refresh` still re-pulls after a lock/unlock mutation.
  books: BookListEntry[];
  canManageLocks: boolean;
  refresh: () => void;
}

const NOT_ADMIN_MESSAGE = "Only Benjamin, Rich, or Perry can change book locks.";

export function BookLocksDialog({ open, onClose, onChanged, books, canManageLocks, refresh }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow-up prompt after a book is *locked* (not unlocked) — a re-lock
  // typically means an editor's fix just landed in D1 while the book was
  // briefly open, and that fix otherwise sits unpushed until the next
  // nightly export. Holds the just-locked book code; null when no prompt is
  // showing. `pushState` tracks the push-now action itself.
  const [pushPrompt, setPushPrompt] = useState<string | null>(null);
  // Defaults to staging: the safe intent should be the one you get by not
  // thinking about it, since the unsafe one rewrites a released book.
  const [stageForReview, setStageForReview] = useState(true);
  const [pushState, setPushState] = useState<"idle" | "pushing" | "done" | "error">("idle");
  const [pushResult, setPushResult] = useState<PushLockedBookResponse | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  // Reset transient error state each time the dialog opens, and pick up
  // whatever lock state changed while it was closed.
  useEffect(() => {
    if (open) {
      setError(null);
      setPending(null);
      refresh();
    }
  }, [open, refresh]);

  const byCode = new Map(books.map((b) => [b.book, b]));

  const toggle = async (code: string, locked: boolean) => {
    setPending(code);
    setError(null);
    try {
      if (locked) {
        await api.unlockBook(code);
      } else {
        await api.lockBook(code);
        // Just locked it (was unlocked a moment ago) — offer to push now
        // rather than leaving the fix stranded until the nightly export.
        // Only takes the slot if no prompt is already showing (or pushing)
        // for a DIFFERENT book — e.g. lock A, then lock B before A's request
        // resolves; A's completion must not yank away B's still-open prompt.
        // The functional form reads live state, not this closure's possibly
        // stale `pushPrompt`. pushState/pushResult/pushError need no reset
        // here: they only move off idle/null while pushPrompt is non-null
        // (see doPushNow), and closePushPrompt always resets all four
        // together — so whenever pushPrompt is null, the other three
        // already are too.
        setPushPrompt((prev) => prev ?? code);
      }
      refresh();
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        const body = e.body as { reason?: string } | undefined;
        setError(body?.reason === "not_a_lock_admin" ? NOT_ADMIN_MESSAGE : "You don't have permission to change locks.");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`Couldn't update the lock for ${code}: ${msg}`);
      }
    } finally {
      setPending(null);
    }
  };

  const closePushPrompt = () => {
    setPushPrompt(null);
    setPushState("idle");
    setPushResult(null);
    setPushError(null);
    // Reset the intent too, and specifically so that "publish unreviewed" cannot
    // be inherited. Unticking it for one book and then locking another would
    // otherwise present the next prompt already set to publish straight to
    // master, for a book nobody made that decision about. The safe default has
    // to be re-chosen each time, per book.
    setStageForReview(true);
  };

  const doPushNow = async () => {
    if (!pushPrompt) return;
    setPushState("pushing");
    setPushError(null);
    try {
      const res = await api.pushLockedBookToDoor43(pushPrompt, stageForReview ? REVIEW_BRANCH : undefined);
      setPushResult(res);
      setPushState("done");
    } catch (e) {
      // Mirror toggle()'s pattern: surface the server's specific reason
      // (e.g. someone else unlocked the book in the meantime) instead of a
      // bare "HTTP 400".
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; reason?: string } | undefined;
        const msg =
          body?.reason === "not_a_lock_admin"
            ? NOT_ADMIN_MESSAGE
            : body?.error === "book_not_locked"
              ? "This book isn't locked anymore — someone may have unlocked it."
              : body?.error === "book_not_imported"
                ? "This book has never been imported, so there's nothing to push."
                : e.message;
        setPushError(msg);
      } else {
        setPushError(e instanceof Error ? e.message : String(e));
      }
      setPushState("error");
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Book locks</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            A locked book cannot be edited and is frozen out of the nightly
            Door43 export. Published books are locked automatically.
          </Typography>
          {error && (
            <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {!canManageLocks && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              {NOT_ADMIN_MESSAGE}
            </Alert>
          )}
          <List dense sx={{ maxHeight: 420, overflowY: "auto" }}>
            {BOOKS.map(({ code, name }) => {
              const entry = byCode.get(code);
              // GET /api/books only lists IMPORTED books (see bookImport.ts),
              // so a book with no `entry` has never been imported. The server
              // still enforces a lock on it if it's on the published list
              // (bookLock.ts checks isPublishedBook regardless of import
              // status), but that published-books list is server-side only —
              // duplicating it here would risk drifting out of sync. Rather
              // than guess "unlocked" (false — a published-but-unimported book
              // would show an open padlock while the server 423s it) or guess
              // "locked" (also potentially false, for an unpublished book),
              // render "not imported" as its own state: honest about what we
              // don't know, and the toggle is disabled so nobody can write a
              // redundant explicit lock row on unverified information.
              const notImported = !entry;
              const locked = entry?.locked ?? false;
              const disabled = notImported || !canManageLocks || pending === code;
              const control = (
                <IconButton
                  edge="end"
                  size="small"
                  disabled={disabled}
                  onClick={() => toggle(code, locked)}
                  aria-label={locked ? `unlock ${name}` : `lock ${name}`}
                >
                  {notImported ? (
                    <HelpOutlineIcon fontSize="small" />
                  ) : locked ? (
                    <LockIcon fontSize="small" />
                  ) : (
                    <LockOpenIcon fontSize="small" />
                  )}
                </IconButton>
              );
              const tooltipTitle = notImported
                ? "Not imported yet — lock state unknown here"
                : NOT_ADMIN_MESSAGE;
              return (
                <ListItem
                  key={code}
                  secondaryAction={
                    canManageLocks && !notImported ? (
                      control
                    ) : (
                      <Tooltip title={tooltipTitle}>
                        <span>{control}</span>
                      </Tooltip>
                    )
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <Typography
                          variant="body2"
                          color={notImported ? "text.disabled" : "text.primary"}
                        >
                          {name}
                        </Typography>
                        {notImported ? (
                          <Chip size="small" label="not imported" variant="outlined" />
                        ) : (
                          locked && (
                            <Chip
                              size="small"
                              label={entry?.lockSource === "published" ? "published" : "locked"}
                              color={entry?.lockSource === "published" ? "primary" : "default"}
                              variant="outlined"
                            />
                          )
                        )}
                      </Box>
                    }
                    secondary={notImported ? undefined : locked ? entry?.lockReason ?? undefined : undefined}
                  />
                </ListItem>
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={pushPrompt !== null}
        // While the push request is in flight, ignore Escape/backdrop
        // dismissal — closing here only hides the dialog, it doesn't cancel
        // the request, so dismissing early would silently drop the
        // queued/error result onto a dialog nobody can see anymore.
        onClose={pushState === "pushing" ? undefined : closePushPrompt}
        disableEscapeKeyDown={pushState === "pushing"}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Push to Door43?</DialogTitle>
        <DialogContent>
          {pushState === "idle" && pushPrompt && (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                {bookName(pushPrompt)} is now locked. Push it to Door43 now instead of waiting for the
                nightly export? This sends every resource (ULT, UST, tN, tQ, tWL), bypassing the lock
                just for this push.
              </Typography>
              {/* Two genuinely different intents, and the dialog used to offer only
                  the riskier one. "Publish now" is right when you own the change and
                  want it live. Staging is right for a PUBLISHED book, where merging
                  means re-cutting a release — that call belongs to a maintainer, not
                  to whoever happened to fix a typo. */}
              <FormControlLabel
                control={
                  <Checkbox
                    checked={stageForReview}
                    onChange={(e) => setStageForReview(e.target.checked)}
                  />
                }
                label="Stage for maintainer review instead of publishing"
              />
              <Alert severity={stageForReview ? "info" : "warning"}>
                {stageForReview
                  ? `Lands on the “${REVIEW_BRANCH}” branch and opens a pull request. Nothing merges by itself — a maintainer reviews it and re-releases.`
                  : "Merges directly to master. Door43 publishes it without review, which for a released book rewrites what people have already downloaded."}
              </Alert>
            </Stack>
          )}
          {pushState === "pushing" && <Typography variant="body2">Pushing…</Typography>}
          {pushState === "done" && pushResult && (
            <Stack spacing={0.5}>
              {pushResult.pushed.map((p) =>
                "instanceId" in p ? (
                  <Typography key={p.resource} variant="body2">
                    {p.resource.toUpperCase()}: queued
                  </Typography>
                ) : (
                  <Typography key={p.resource} variant="body2" color="error">
                    {p.resource.toUpperCase()}: {p.error}
                  </Typography>
                ),
              )}
            </Stack>
          )}
          {pushState === "error" && (
            <Alert severity="error">
              Couldn't push {bookName(pushPrompt ?? "")}: {pushError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          {pushState === "idle" && (
            <>
              <Button onClick={closePushPrompt}>Not now</Button>
              <Button onClick={doPushNow} variant="contained">
                Push now
              </Button>
            </>
          )}
          {pushState !== "idle" && pushState !== "pushing" && (
            <Button onClick={closePushPrompt}>Close</Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}

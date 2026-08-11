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
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { ApiError, api, type BookListEntry } from "../sync/api";
import { BOOKS } from "../lib/bookNames";

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

  return (
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
  );
}

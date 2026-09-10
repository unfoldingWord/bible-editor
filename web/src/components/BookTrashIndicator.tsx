// Topbar "trash" indicator (issue #755). A trashed tn row is otherwise only
// reachable by navigating to its own verse, and the nightly finalize promotes
// every trashed_at to a permanent deleted_at with no warning — a note trashed
// in a chapter nobody revisits that day is silently gone the next morning.
// This rolls up every trashed-but-not-finalized tn row across the current
// book into one small affordance with an inline Restore, so a mistaken trash
// is recoverable without first finding the right verse. Hidden when the book
// has nothing trashed, matching the notes/lint/align indicators beside it.

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { api, type BookTrashRow } from "../sync/api";

interface Props {
  book: string;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
  // Bumped by Shell whenever handleTrashNote/handleRestoreNote succeeds
  // (anywhere in the book, not just the currently open chapter) — the only
  // signal this indicator has that the list needs refetching. Without it, a
  // book with nothing trashed at mount renders nothing (see the total === 0
  // early return below) and never gets another chance to notice a note
  // trashed afterward, since opening the menu is the *other* refresh trigger
  // and there'd be no icon left to click.
  refreshSignal: number;
  // Routes through Shell's handleRestoreNote so a restore here gets the same
  // optimistic local patch, lint-chip refresh, and failure toast (including a
  // viewer's read_only 403, which api.ts throws client-side) as the note
  // card's own Restore button — rather than a second, thinner copy of that
  // logic that silently swallows errors.
  onRestore: (id: string) => void | Promise<void>;
}

function refLabel(row: BookTrashRow): string {
  return row.chapter === 0 && row.verse === 0 ? "intro" : `${row.chapter}:${row.verse}`;
}

export function BookTrashIndicator({ book, onNavigate, refreshSignal, onRestore }: Props) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BookTrashRow[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = () => {
    api
      .getBookTrash(book)
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  };

  // Refetch on book change and on every trash/restore anywhere in the book
  // (refreshSignal), and again each time the menu opens so a note trashed by
  // someone else this session shows up without a reload.
  useEffect(() => {
    setRows([]);
    let cancelled = false;
    api
      .getBookTrash(book)
      .then((r) => !cancelled && setRows(r.rows))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [book, refreshSignal]);

  const total = rows.length;
  if (total === 0) return null;

  const tooltip = `${total} trashed note${total === 1 ? "" : "s"} in ${book}`;

  // No optimistic removal here: onRestore swallows its own errors (it toasts
  // instead of rethrowing, matching the note card's own Restore button), so
  // this can't tell success from failure. The refreshSignal bump on success
  // reconciles the list for both; a failure just leaves the row listed.
  const restore = async (row: BookTrashRow) => {
    setRestoringId(row.id);
    try {
      await onRestore(row.id);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <Box component="span" sx={{ display: "inline-flex" }}>
      <Tooltip title={tooltip}>
        <IconButton
          ref={anchorRef}
          size="small"
          onClick={() => {
            load();
            setOpen(true);
          }}
          aria-label={tooltip}
        >
          <Badge badgeContent={total} color="default">
            <DeleteOutlineIcon fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 400, minWidth: 280, maxHeight: 480 } } }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">{book} — trash</Typography>
          <Typography variant="caption" color="text.secondary">
            Finalized permanently by the nightly export if not restored first.
          </Typography>
        </Box>
        <Divider />
        {rows.map((row) => (
          <MenuItem
            key={row.id}
            onClick={() => {
              setOpen(false);
              onNavigate(book, row.chapter, row.verse);
            }}
            sx={{ py: 0.75, gap: 1 }}
          >
            <ListItemText
              primary={
                <Typography
                  variant="body2"
                  sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  {refLabel(row)}
                </Typography>
              }
              secondary={
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.note_preview || "(empty note)"}
                </Typography>
              }
            />
            <Button
              size="small"
              disabled={restoringId === row.id}
              onClick={(e) => {
                e.stopPropagation();
                void restore(row);
              }}
              sx={{ textTransform: "none", flexShrink: 0 }}
            >
              Restore
            </Button>
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

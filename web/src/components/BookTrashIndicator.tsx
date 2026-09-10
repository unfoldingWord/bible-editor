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
}

function refLabel(row: BookTrashRow): string {
  return row.chapter === 0 && row.verse === 0 ? "intro" : `${row.chapter}:${row.verse}`;
}

export function BookTrashIndicator({ book, onNavigate }: Props) {
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

  // Refetch on book change, and again each time the menu opens so a note
  // trashed in another chapter this session shows up without a reload.
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
  }, [book]);

  const total = rows.length;
  if (total === 0) return null;

  const tooltip = `${total} trashed note${total === 1 ? "" : "s"} in ${book}`;

  const restore = async (row: BookTrashRow) => {
    setRestoringId(row.id);
    try {
      await api.restoreNote(row.id, book);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch {
      // Leave the row listed — the server is the source of truth, and a
      // failed restore (e.g. the row was finalized between the list load and
      // the click) surfaces the next time the menu opens.
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

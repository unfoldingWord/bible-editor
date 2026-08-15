// Topbar "notes in this book" indicator (issue #441). Rolls up every open
// (unresolved) internal comment thread across the current book into one small,
// unobtrusive affordance so editors can find and review notes/questions
// without opening each chapter — the point being to leave notes on published/
// locked books and review them all at once later. Clicking lists each location
// with a "go to" that navigates straight there. Hidden when the book has no
// open threads — a finder, not a permanent fixture, matching the lint/align
// indicators beside it.

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import { api, type BookCommentSummary, type BookCommentLocation } from "../sync/api";

interface Props {
  book: string;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
}

function locationLabel(loc: BookCommentLocation): string {
  const ref = `${loc.chapter}:${loc.verse}`;
  return loc.rowKind ? `${ref} · ${loc.rowKind.toUpperCase()}` : ref;
}

export function BookNotesIndicator({ book, onNavigate }: Props) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<BookCommentSummary | null>(null);

  const load = () => {
    api
      .getBookCommentSummary(book)
      .then(setSummary)
      .catch(() => setSummary(null));
  };

  // Refetch on book change, and again each time the menu opens so a note added
  // in another chapter this session shows up without a reload.
  useEffect(() => {
    setSummary(null);
    let cancelled = false;
    api
      .getBookCommentSummary(book)
      .then((s) => !cancelled && setSummary(s))
      .catch(() => !cancelled && setSummary(null));
    return () => {
      cancelled = true;
    };
  }, [book]);

  const total = summary?.total ?? 0;
  if (total === 0) return null;

  const tooltip = `${total} open note${total === 1 ? "" : "s"}/question${
    total === 1 ? "" : "s"
  } in ${book}`;

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
          <Badge badgeContent={total} color="success">
            <ChatBubbleOutlineIcon fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 360, minWidth: 260, maxHeight: 480 } } }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">{book} — notes &amp; questions</Typography>
          <Typography variant="caption" color="text.secondary">
            {summary?.notes ?? 0} note{(summary?.notes ?? 0) === 1 ? "" : "s"} ·{" "}
            {summary?.questions ?? 0} open question
            {(summary?.questions ?? 0) === 1 ? "" : "s"}
          </Typography>
        </Box>
        <Divider />
        {(summary?.locations ?? []).map((loc, i) => (
          <MenuItem
            key={`${loc.chapter}-${loc.verse}-${loc.rowKind ?? "v"}-${loc.kind}-${i}`}
            onClick={() => {
              setOpen(false);
              onNavigate(book, loc.chapter, loc.verse);
            }}
            sx={{ py: 0.75 }}
          >
            <ListItemText
              primary={
                <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                  >
                    {locationLabel(loc)}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      textTransform: "uppercase",
                      color: loc.kind === "question" ? "warning.main" : "success.main",
                    }}
                  >
                    {loc.kind}
                    {loc.count > 1 ? ` ×${loc.count}` : ""}
                  </Typography>
                </Box>
              }
            />
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

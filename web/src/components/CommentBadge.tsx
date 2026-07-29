// Small icon-button affordance that opens CommentsPopover. Mirrors the
// small-Chip count idiom used elsewhere (BookLintIndicator.tsx) but renders
// the count as plain monospace Typography next to the icon instead of a
// Chip-in-a-button, per spec — there is no MUI <Badge> anywhere in this repo
// and this component doesn't introduce one either.

import { IconButton, Tooltip, Typography } from "@mui/material";
import ChatBubbleIcon from "@mui/icons-material/ChatBubble";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import type { CommentCounts } from "../lib/commentsIndex";

export interface CommentBadgeProps {
  counts: CommentCounts;
  onOpen: (anchorEl: HTMLElement) => void;
  titleWhenEmpty?: string;
}

export function CommentBadge({
  counts,
  onOpen,
  titleWhenEmpty = "Add an internal comment",
}: CommentBadgeProps) {
  const { openQuestions, notes } = counts;

  let icon: React.ReactNode;
  let color: string;
  let tooltip: string;
  let opacity = 1;

  if (openQuestions > 0) {
    icon = <ChatBubbleIcon fontSize="inherit" />;
    color = "warning.main";
    tooltip = `${openQuestions} open question${openQuestions === 1 ? "" : "s"}`;
  } else if (notes > 0) {
    icon = <ChatBubbleOutlineIcon fontSize="inherit" />;
    color = "text.secondary";
    tooltip = `${notes} note${notes === 1 ? "" : "s"}`;
  } else {
    icon = <ChatBubbleOutlineIcon fontSize="inherit" />;
    color = "text.secondary";
    tooltip = titleWhenEmpty;
    opacity = 0.35;
  }

  const button = (
    <IconButton
      size="small"
      onClick={(e) => onOpen(e.currentTarget)}
      data-comments-badge="1"
      aria-label={tooltip}
      sx={{ p: 0.25, color, opacity, gap: 0.25 }}
    >
      {icon}
      {counts.total > 0 && (
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", fontSize: 11, color, lineHeight: 1 }}
        >
          {counts.total}
        </Typography>
      )}
    </IconButton>
  );

  return <Tooltip title={tooltip}>{button}</Tooltip>;
}

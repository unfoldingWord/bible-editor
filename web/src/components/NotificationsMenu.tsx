// Small top-right notifications bell for comment mentions and replies. Replaces
// the old full-width blue banner, which was too intrusive for a per-user "you
// were tagged" nudge (issues #385/#441). Export-failure alerts still use the
// banner (see App.tsx) — this menu only shows the comment_* sources routed to
// it.
//
// Clicking a notification follows its `?c=<id>` deep link (the same mechanism
// the banner used) and dismisses it; the trailing × dismisses without
// navigating. Mirrors AlignAttentionIndicator's Menu idiom.

import { useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import NotificationsIcon from "@mui/icons-material/Notifications";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import CloseIcon from "@mui/icons-material/Close";
import type { SystemAlert } from "../sync/api";
import { relativeTime } from "../lib/relativeTime";

interface Props {
  alerts: SystemAlert[];
  onDismiss: (id: number) => void | Promise<void>;
}

export function NotificationsMenu({ alerts, onDismiss }: Props) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const count = alerts.length;
  const tooltip = count === 0 ? "No new notifications" : `${count} notification${count === 1 ? "" : "s"}`;

  const goTo = (a: SystemAlert) => {
    setOpen(false);
    if (a.linkUrl && a.linkUrl.startsWith("/#/")) {
      location.hash = a.linkUrl.slice(2);
    }
    void onDismiss(a.id);
  };

  return (
    <Box component="span" sx={{ display: "inline-flex" }}>
      <Tooltip title={tooltip}>
        <IconButton
          ref={anchorRef}
          size="small"
          onClick={() => setOpen(true)}
          aria-label={tooltip}
        >
          <Badge badgeContent={count} color="primary">
            {count > 0 ? (
              <NotificationsIcon fontSize="small" />
            ) : (
              <NotificationsNoneIcon fontSize="small" sx={{ color: "text.disabled" }} />
            )}
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 380, minWidth: 300, maxHeight: 480 } } }}
      >
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ px: 2, py: 1 }}
        >
          <Typography variant="subtitle2">Notifications</Typography>
          {count > 0 && (
            <Button
              size="small"
              sx={{ textTransform: "none", minWidth: 0 }}
              onClick={() => {
                for (const a of alerts) void onDismiss(a.id);
                setOpen(false);
              }}
            >
              Clear all
            </Button>
          )}
        </Stack>
        <Divider />
        {count === 0 ? (
          <Box sx={{ px: 2, py: 2 }}>
            <Typography variant="caption" color="text.secondary">
              You're all caught up.
            </Typography>
          </Box>
        ) : (
          alerts.map((a) => (
            <MenuItem
              key={a.id}
              onClick={() => goTo(a)}
              sx={{ alignItems: "flex-start", whiteSpace: "normal", py: 1, pr: 1 }}
            >
              <ListItemText
                primary={
                  <Typography variant="body2" sx={{ pr: 1 }}>
                    {a.message}
                  </Typography>
                }
                secondary={
                  <Typography variant="caption" color="text.secondary">
                    {relativeTime(a.createdAt)}
                  </Typography>
                }
              />
              <Tooltip title="Dismiss">
                <IconButton
                  size="small"
                  edge="end"
                  aria-label="dismiss notification"
                  onClick={(e) => {
                    // Don't let the MenuItem's onClick navigate — just dismiss.
                    e.stopPropagation();
                    void onDismiss(a.id);
                  }}
                  sx={{ mt: -0.25 }}
                >
                  <CloseIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            </MenuItem>
          ))
        )}
      </Menu>
    </Box>
  );
}

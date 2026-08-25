// Topbar "sync warnings" badge. Collapsed home for the door43/export state
// alerts that used to render as a full-width banner across the top of the app
// (issue #458). That banner floated over the TopBar navigation and — for a
// "Door43's sync overwrote your edits" message an editor couldn't resolve on
// their own — read as an un-dismissable barrier. These are warnings, not
// blockers, so they belong in the same quiet indicator idiom as the lint /
// alignment / notes badges: a small count that opens a panel, out of the way
// of navigation, with an obvious per-item (and bulk) dismiss.
//
// Data is the current user's undismissed system_alerts (App.tsx passes every
// non-"comment" alert here); dismissing calls the same POST /api/alerts/:id
// path the banner used. Hidden entirely when there is nothing to show.

import { useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  Link,
  Menu,
  Tooltip,
  Typography,
} from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { relativeTime } from "../lib/relativeTime";
import type { SystemAlert } from "../sync/api";

interface Props {
  alerts: SystemAlert[];
  onDismiss: (id: number) => void;
}

export function SyncWarningsIndicator({ alerts, onDismiss }: Props) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  // Nothing to report — stay out of the way (matches the sibling indicators).
  if (alerts.length === 0) return null;

  const count = alerts.length;
  // Amber by default so it reads as "a warning like the other warnings"; only
  // escalate the badge/icon to red when at least one alert is a genuine error.
  const color: "warning" | "error" = alerts.some((a) => a.severity === "error")
    ? "error"
    : "warning";
  const tooltip = `${count} sync warning${count === 1 ? "" : "s"} — click to review`;

  const goToLink = (a: SystemAlert) => {
    setOpen(false);
    // Internal deep links are stored as "/#/BOOK/CH/V"; navigate via the hash
    // (App owns hash routing). External links (e.g. a pipeline run) open in a
    // new tab and are handled by the anchor's href/target below.
    if (a.linkUrl?.startsWith("/#/")) {
      location.hash = a.linkUrl.slice(2);
    }
  };

  return (
    <Box component="span" sx={{ display: "inline-flex" }}>
      <Tooltip title={tooltip}>
        <IconButton ref={anchorRef} size="small" onClick={() => setOpen(true)} aria-label={tooltip}>
          <Badge badgeContent={count} color={color}>
            <WarningAmberIcon fontSize="small" sx={{ color: `${color}.main` }} />
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        // Height cap + scroll: a nightly sync can raise many alerts at once; an
        // uncapped Menu grows past the viewport and the tail becomes unreachable.
        slotProps={{ paper: { sx: { maxWidth: 460, maxHeight: 520 } } }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">Sync warnings</Typography>
          <Typography variant="caption" color="text.secondary">
            {count} need{count === 1 ? "s" : ""} attention · from the daily Door43 sync
          </Typography>
        </Box>
        <Divider />
        {/* Plain rows, not MenuItems: each carries its own Dismiss / link
            buttons, and a button nested inside a button (MenuItem) is invalid. */}
        {alerts.map((a) => (
          <Box key={a.id} sx={{ px: 2, py: 1.25 }}>
            <Typography variant="body2" sx={{ whiteSpace: "normal" }}>
              {a.message}
            </Typography>
            {/* Every warning carries its own date. These messages describe what a
                nightly run decided, and an undated one is unreadable: a warning
                raised last night and one that has sat unresolved for a week look
                identical, so there is no way to tell a new problem from a stale
                one. Same idiom (and same helper) as NotificationsMenu's comment
                rows, with the exact stamp on hover.
                CAVEAT: this is system_alerts.created_at, i.e. when this exact
                WORDING first appeared — verseMergeConflicts.ts rewrites the row
                (delete+insert) whenever the verse list changes, so adding or
                resolving one verse resets it for the whole book+resource. The
                per-verse "first flagged" date that is deliberately never reset is
                verse_merge_conflicts.detected_at, which GET
                /api/verse-merge-conflicts/:book does not yet select. */}
            <Typography
              variant="caption"
              color="text.secondary"
              title={new Date(a.createdAt * 1000).toLocaleString()}
              sx={{ display: "block", mt: 0.25 }}
            >
              flagged {relativeTime(a.createdAt)}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.75 }}>
              {a.linkUrl &&
                (a.linkUrl.startsWith("/#/") ? (
                  <Link
                    component="button"
                    type="button"
                    variant="caption"
                    underline="always"
                    onClick={() => goToLink(a)}
                  >
                    go to verse
                  </Link>
                ) : (
                  <Link
                    href={a.linkUrl}
                    target="_blank"
                    rel="noopener"
                    variant="caption"
                    underline="always"
                  >
                    view run
                  </Link>
                ))}
              <Box sx={{ flex: 1 }} />
              <Button size="small" color="inherit" onClick={() => onDismiss(a.id)}>
                Dismiss
              </Button>
            </Box>
            <Divider sx={{ mt: 1.25 }} />
          </Box>
        ))}
        <Box sx={{ px: 2, py: 1, display: "flex", justifyContent: "flex-end" }}>
          <Button
            size="small"
            onClick={() => {
              // Snapshot ids first: dismissing mutates the parent list, which
              // would otherwise reindex mid-iteration.
              for (const id of alerts.map((a) => a.id)) onDismiss(id);
              setOpen(false);
            }}
          >
            Dismiss all
          </Button>
        </Box>
      </Menu>
    </Box>
  );
}

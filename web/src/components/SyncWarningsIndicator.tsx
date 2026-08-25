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

// Absolute stamp for the row tooltip. `timeZoneName` is deliberately included:
// the nightly sync fires at 05:30 UTC and every other artifact a reader would
// cross-reference (wrangler tail, workflow logs, Door43 commits) is UTC too, so
// a bare local time silently forces them to guess an offset.
function absoluteStamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { timeZoneName: "short" });
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
                raised last night and one that has sat unresolved for eleven days
                look identical, so there is no way to tell a new problem from a
                stale one.
                "last reported", NOT "flagged": this is system_alerts.created_at,
                which is when the CURRENT message was written — never when the
                problem was first seen. Every writer REPLACES its row instead of
                updating it: postExport.ts's recordFailureAlert deletes and
                reinserts on every consecutive failure (so a ten-night-old
                validator failure always stamps as last night), and
                verseMergeEditorAlerts.ts's planSystemAlertWrites rewrites
                whenever the wording changes (so resolving one verse out of twelve
                resets the stamp for the whole book+resource). A caption reading
                "flagged" would assert a freshness this column cannot support —
                worse than no date, because it is confidently wrong.
                The durable per-verse first-seen date is
                verse_merge_conflicts.detected_at, deliberately never reset, which
                no endpoint selects for display yet — issue #624.
                Tooltip + <time dateTime>, not a bare `title`: `title` on static
                text is unreachable by keyboard and touch and is announced
                inconsistently by screen readers, and the absolute stamp is
                precisely what a reader needs in order to line an alert up against
                a UTC cron run. */}
            <Tooltip title={absoluteStamp(a.createdAt)}>
              <Typography
                variant="caption"
                color="text.secondary"
                component="time"
                dateTime={new Date(a.createdAt * 1000).toISOString()}
                sx={{ display: "block", mt: 0.25, width: "fit-content" }}
              >
                last reported {relativeTime(a.createdAt)}
              </Typography>
            </Tooltip>
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

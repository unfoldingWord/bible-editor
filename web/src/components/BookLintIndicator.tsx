// Topbar "issues to clean up" indicator. When the current book has DCS-
// validation findings that need a human decision (the lint "flag" bucket),
// a quiet warning chip shows the count; clicking it opens a menu of each
// issue with a "go to" affordance that navigates straight to the ref (and,
// for TN findings, activates the offending note). Hidden entirely when the
// book is clean — it's a nudge, not a permanent fixture.

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
  Typography,
} from "@mui/material";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { api, type BookLintIssue } from "../sync/api";
import {
  diffDoor43Fields,
  dismissibleKind,
  groupLintIssues,
  isGroupFullyDismissible,
} from "./bookLintGrouping";

// Kindle warning accent (#E59D33 from CLAUDE.md brand palette), matching the
// other "needs attention" chips (VersionIndicator's update nudge, the
// SyncStatusBar transient chips).
const flagAccentSx = {
  color: "#E59D33",
  borderColor: "#E59D33",
  "& .MuiChip-icon": { color: "#E59D33" },
} as const;

const clampSx = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
} as const;

interface Props {
  book: string;
  flagIssues: BookLintIssue[];
  flagCount: number;
  escalateCount: number;
  /** Navigate to (and, for TN issues, activate) the offending row. */
  onGoToIssue: (issue: BookLintIssue) => void;
  /** Called after a dismiss (single or group) succeeds, so the caller can refetch the lint report. */
  onDismissed?: () => void;
}

function issueKey(issue: BookLintIssue): string {
  return `${issue.resource}|${issue.rowId ?? ""}`;
}

// Compact Door43-vs-here detail for a dismissible issue. Module-level (not
// defined inside BookLintIndicator's render) so it isn't redefined every
// render. Renders nothing when the issue isn't dismissible or carries no
// door43 snapshot.
function DoorDiff({ issue }: { issue: BookLintIssue }) {
  if (!issue.dismissible || !issue.door43) return null;
  const diffs = diffDoor43Fields(issue.door43, issue.ours);
  if (diffs.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        Door43 and this row currently match.
      </Typography>
    );
  }
  return (
    <Box sx={{ mt: 0.5 }}>
      {diffs.map((d) => (
        <Box key={d.field} sx={{ mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", fontWeight: 600 }}>
            {d.field}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ ...clampSx, fontFamily: "monospace" }}>
            Door43: {d.door43 || "(empty)"}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ ...clampSx, fontFamily: "monospace" }}>
            Here: {d.ours || "(empty)"}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function BookLintIndicator({
  book,
  flagIssues,
  flagCount,
  escalateCount,
  onGoToIssue,
  onDismissed,
}: Props) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Which duplicate-issue groups (keyed by check+message) are expanded to show
  // their individual refs. Starts empty — a run of duplicates opens collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Optimistically-cleared issues (issue #653 direction 2 "Mark reviewed").
  // Filtered out of the local list immediately; the parent's refetch (via
  // onDismissed) eventually replaces flagIssues wholesale and this resets.
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  // rowId set currently mid-flight for a group "Dismiss all" run.
  const [dismissingGroup, setDismissingGroup] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);

  // Local dismiss/expand state is keyed to THIS book's issue set — reset on
  // book change so a stale entry can't coincidentally match a same-rowId
  // issue in the next book navigated to.
  useEffect(() => {
    setDismissedKeys(new Set());
    setExpanded(new Set());
  }, [book]);

  // Nothing to clean up — stay out of the way.
  if (flagCount <= 0) return null;

  const visibleIssues = flagIssues.filter((i) => !dismissedKeys.has(issueKey(i)));
  const groups = groupLintIssues(visibleIssues);
  // The server's flagCount is the source of truth once a refetch lands, but
  // between an optimistic dismiss and that refetch it would otherwise read
  // stale (higher than what the menu now shows) — subtract what we've
  // already cleared locally so the chip/header agree with the list.
  const dismissedFlagCount = flagIssues.length - visibleIssues.length;
  const displayFlagCount = Math.max(flagCount - dismissedFlagCount, 0);

  const tooltip = `${displayFlagCount} issue${displayFlagCount === 1 ? "" : "s"} to clean up in ${book}${
    escalateCount > 0 ? ` (+${escalateCount} integrity)` : ""
  } — click to review`;

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const dismissOne = async (issue: BookLintIssue) => {
    const kind = dismissibleKind(issue.resource);
    if (!issue.rowId || !kind) return;
    try {
      await api.dismissReviewFlag(kind, book, issue.rowId);
      setDismissedKeys((prev) => new Set(prev).add(issueKey(issue)));
      onDismissed?.();
    } catch {
      setDismissError("Could not mark reviewed — try again.");
    }
  };

  const dismissGroup = async (group: { key: string; issues: BookLintIssue[] }) => {
    setDismissingGroup(group.key);
    let failed = 0;
    for (const issue of group.issues) {
      const kind = dismissibleKind(issue.resource);
      if (!issue.rowId || !kind) continue;
      try {
        await api.dismissReviewFlag(kind, book, issue.rowId);
        setDismissedKeys((prev) => new Set(prev).add(issueKey(issue)));
      } catch {
        failed++;
      }
    }
    setDismissingGroup(null);
    if (failed > 0) {
      setDismissError(`${failed} of ${group.issues.length} failed to clear — try again.`);
    }
    onDismissed?.();
  };

  return (
    <Box ref={anchorRef} component="span" sx={{ display: "inline-flex" }}>
      <Tooltip title={tooltip}>
        <Chip
          icon={<ReportProblemOutlinedIcon />}
          label={displayFlagCount}
          size="small"
          variant="outlined"
          clickable
          onClick={() => setOpen(true)}
          sx={flagAccentSx}
        />
      </Tooltip>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 420 } } }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">{book} — issues to clean up</Typography>
          <Typography variant="caption" color="text.secondary">
            {displayFlagCount} need{displayFlagCount === 1 ? "s" : ""} a decision
            {escalateCount > 0 ? ` · ${escalateCount} integrity` : ""}
          </Typography>
        </Box>
        <Divider />
        {groups.flatMap((group) => {
          if (group.issues.length === 1) {
            const issue = group.issues[0];
            return [
              <MenuItem
                key={group.key}
                onClick={() => {
                  setOpen(false);
                  onGoToIssue(issue);
                }}
                sx={{ alignItems: "flex-start", whiteSpace: "normal", py: 1 }}
              >
                <ListItemText
                  primary={
                    <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        {issue.ref}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ textTransform: "uppercase" }}
                      >
                        {issue.resource}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {issue.check}
                      </Typography>
                    </Box>
                  }
                  secondary={
                    <>
                      <Typography variant="caption" color="text.secondary" sx={clampSx}>
                        {issue.message}
                      </Typography>
                      <DoorDiff issue={issue} />
                    </>
                  }
                />
                {issue.dismissible && issue.rowId && dismissibleKind(issue.resource) && (
                  <Tooltip title="Mark reviewed — clears this flag without changing the row">
                    <IconButton
                      size="small"
                      sx={{ ml: 0.5, mt: 0.25 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismissOne(issue);
                      }}
                    >
                      <CheckCircleOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </MenuItem>,
            ];
          }

          // A run of identical (check, message) entries — issue #653: 63
          // identical "Unmerged Door43 edit — verify" TN rows gave a
          // proofreader nothing to act on. Collapse them into one header with
          // a count; expanding lists each ref so a specific one can still be
          // jumped to. Returned as a flat array (not a Fragment) so MUI's
          // MenuList sees each item as a direct child for keyboard nav.
          const isExpanded = expanded.has(group.key);
          const fullyDismissible = isGroupFullyDismissible(group.issues);
          const groupBusy = dismissingGroup === group.key;
          const items = [
            <MenuItem
              key={group.key}
              onClick={() => toggleExpanded(group.key)}
              sx={{ alignItems: "flex-start", whiteSpace: "normal", py: 1 }}
            >
              <ListItemText
                primary={
                  <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {group.issues.length}× {group.check}
                    </Typography>
                  </Box>
                }
                secondary={
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={isExpanded ? undefined : clampSx}
                  >
                    {group.message}
                  </Typography>
                }
              />
              {fullyDismissible && (
                <Tooltip title={`Mark all ${group.issues.length} reviewed — clears these flags without changing the rows`}>
                  <span>
                    <IconButton
                      size="small"
                      disabled={groupBusy}
                      sx={{ ml: 0.5, mt: 0.25 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismissGroup(group);
                      }}
                    >
                      {groupBusy ? (
                        <CircularProgress size={16} />
                      ) : (
                        <CheckCircleOutlineIcon fontSize="small" />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              {isExpanded ? (
                <ExpandLessIcon fontSize="small" sx={{ color: "text.secondary", mt: 0.5 }} />
              ) : (
                <ExpandMoreIcon fontSize="small" sx={{ color: "text.secondary", mt: 0.5 }} />
              )}
            </MenuItem>,
          ];
          if (isExpanded) {
            items.push(
              ...group.issues.map((issue, i) => (
                <MenuItem
                  key={`${group.key}-${issue.resource}-${issue.ref}-${issue.rowId ?? ""}-${i}`}
                  onClick={() => {
                    setOpen(false);
                    onGoToIssue(issue);
                  }}
                  sx={{ pl: 4, py: 0.5, alignItems: "flex-start" }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box>
                      <Typography
                        variant="body2"
                        component="span"
                        sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        {issue.ref}
                      </Typography>
                      <Typography
                        variant="caption"
                        component="span"
                        color="text.secondary"
                        sx={{ textTransform: "uppercase", ml: 1 }}
                      >
                        {issue.resource}
                      </Typography>
                    </Box>
                    <DoorDiff issue={issue} />
                  </Box>
                  {issue.dismissible && issue.rowId && dismissibleKind(issue.resource) && (
                    <Tooltip title="Mark reviewed — clears this flag without changing the row">
                      <IconButton
                        size="small"
                        sx={{ ml: 0.5 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void dismissOne(issue);
                        }}
                      >
                        <CheckCircleOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </MenuItem>
              )),
            );
          }
          return items;
        })}
      </Menu>
      <Snackbar
        open={dismissError !== null}
        autoHideDuration={6000}
        onClose={() => setDismissError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setDismissError(null)}>
          {dismissError}
        </Alert>
      </Snackbar>
    </Box>
  );
}

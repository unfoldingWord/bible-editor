// Topbar "issues to clean up" indicator. When the current book has DCS-
// validation findings that need a human decision (the lint "flag" bucket),
// a quiet warning chip shows the count; clicking it opens a menu of each
// issue with a "go to" affordance that navigates straight to the ref (and,
// for TN findings, activates the offending note). Hidden entirely when the
// book is clean — it's a nudge, not a permanent fixture.

import { useRef, useState } from "react";
import {
  Box,
  Chip,
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { BookLintIssue } from "../sync/api";
import { groupLintIssues } from "./bookLintGrouping";

// Kindle warning accent (#E59D33 from CLAUDE.md brand palette), matching the
// other "needs attention" chips (VersionIndicator's update nudge, the
// SyncStatusBar transient chips).
const flagAccentSx = {
  color: "#E59D33",
  borderColor: "#E59D33",
  "& .MuiChip-icon": { color: "#E59D33" },
} as const;

interface Props {
  book: string;
  flagIssues: BookLintIssue[];
  flagCount: number;
  escalateCount: number;
  /** Navigate to (and, for TN issues, activate) the offending row. */
  onGoToIssue: (issue: BookLintIssue) => void;
}

export function BookLintIndicator({
  book,
  flagIssues,
  flagCount,
  escalateCount,
  onGoToIssue,
}: Props) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Which duplicate-issue groups (keyed by check+message) are expanded to show
  // their individual refs. Starts empty — a run of duplicates opens collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Nothing to clean up — stay out of the way.
  if (flagCount <= 0) return null;

  const tooltip = `${flagCount} issue${flagCount === 1 ? "" : "s"} to clean up in ${book}${
    escalateCount > 0 ? ` (+${escalateCount} integrity)` : ""
  } — click to review`;

  const groups = groupLintIssues(flagIssues);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Box ref={anchorRef} component="span" sx={{ display: "inline-flex" }}>
      <Tooltip title={tooltip}>
        <Chip
          icon={<ReportProblemOutlinedIcon />}
          label={flagCount}
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
            {flagCount} need{flagCount === 1 ? "s" : ""} a decision
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
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {issue.message}
                    </Typography>
                  }
                />
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
                    sx={
                      isExpanded
                        ? undefined
                        : {
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }
                    }
                  >
                    {group.message}
                  </Typography>
                }
              />
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
                  sx={{ pl: 4, py: 0.5 }}
                >
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                  >
                    {issue.ref}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ textTransform: "uppercase", ml: 1 }}
                  >
                    {issue.resource}
                  </Typography>
                </MenuItem>
              )),
            );
          }
          return items;
        })}
      </Menu>
    </Box>
  );
}

// Topbar "issues to clean up" indicator. When the current book has DCS-
// validation findings that need a human decision (the lint "flag" bucket),
// a quiet warning chip shows the count; clicking it opens a menu of each
// issue with a "go to" affordance that navigates straight to the ref (and,
// for tn/tq/twl findings, activates + scrolls to the offending row). Hidden
// entirely when the book is clean — it's a nudge, not a permanent fixture.

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
  Portal,
  Snackbar,
  ToggleButton,
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
  sortLintIssues,
  type LintGroupMode,
  type LintSortMode,
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
  /** Navigate to (and, for tn/tq/twl issues, activate) the offending row. */
  onGoToIssue: (issue: BookLintIssue) => void;
  /**
   * Called after a dismiss (single or group) succeeds, so the caller can
   * refetch the lint report. Its returned promise (if any) is awaited so a
   * dismiss flow can bound its own optimistic key to "my own POST, then my
   * own refetch" rather than to a shared, cross-talk-prone reset.
   */
  onDismissed?: () => Promise<void> | void;
}

// A row can carry SEVERAL independent lint findings with the same rowId
// (e.g. the dismissible review flag plus unrelated content checks like
// "13. Paired Square Bracket" or "Empty note") — keying on resource+rowId
// alone made dismissing one hide the row's other live findings. `check` is
// included so only the specific finding just dismissed is filtered.
function issueKey(issue: BookLintIssue): string {
  return `${issue.resource}|${issue.rowId ?? ""}|${issue.check}`;
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
  // Which issue groups (keyed per groupLintIssues — see bookLintGrouping.ts)
  // are expanded to show their individual refs. Starts empty — a run of
  // duplicates opens collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Optimistically-cleared issues (issue #653 direction 2 "Mark reviewed").
  // Filtered out of the local list immediately, BEFORE the server confirms.
  // Each key's lifetime is bounded to its OWN dismiss request cycle, not to
  // the component's lifetime or to any shared reset: dismissOne/dismissGroup
  // add a key right before awaiting their POST, then await their OWN
  // refetch, then remove that same key in a `finally` — win or lose. A key
  // can therefore never outlive the request that added it, so two
  // concurrent dismissals (or a dismiss racing an unrelated refetch) can't
  // leave a key stranded: each flow owns and clears only its own keys. This
  // replaces an earlier design (a single effect resetting the whole Set
  // whenever a fresh report landed, guarded by a "no dismissal in flight"
  // ref) that had irreducible cross-talk between concurrent dismissals — a
  // second dismiss's failure could clear the busy guard before the first
  // dismiss's own refetch had landed, permanently stranding its key.
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  // A single flag disables every dismiss control (per-issue and group)
  // while ANY dismissal is in flight — simplest way to avoid a double-click
  // firing a duplicate POST. Purely a UI affordance now; it plays no part in
  // dismissedKeys' lifetime (see above). `busyKey` is cosmetic only (which
  // control shows the spinner).
  const [dismissBusy, setDismissBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  // Issue #700: how to group and order the menu's issue list. "duplicate"
  // (default) collapses only genuine repeats; "type" groups every issue of
  // one check together regardless of wording. "default" sort keeps
  // first-seen/fetch order; "verse" orders by chapter:verse.
  const [groupMode, setGroupMode] = useState<LintGroupMode>("duplicate");
  const [sortMode, setSortMode] = useState<LintSortMode>("default");

  // Local expand state is keyed to THIS book's issue set. In practice
  // App.tsx keys <Shell> on `book`, so this component remounts (fresh
  // state) on book change rather than receiving a `book` prop update — this
  // effect is currently dead but harmless, kept as a defensive backstop
  // against stale expansion surviving a future change to that remount
  // behavior.
  useEffect(() => {
    setExpanded(new Set());
  }, [book]);

  const visibleIssues = flagIssues.filter((i) => !dismissedKeys.has(issueKey(i)));
  // The server's flagCount is the source of truth once a refetch lands, but
  // between an optimistic dismiss and that refetch it would otherwise read
  // stale (higher than what the menu now shows) — subtract what we've
  // already cleared locally so the chip/header/early-return all agree with
  // the list, including not lingering at "0" with an open empty menu.
  const dismissedFlagCount = flagIssues.length - visibleIssues.length;
  const displayFlagCount = Math.max(flagCount - dismissedFlagCount, 0);

  // Nothing left to clean up — stay out of the way.
  if (displayFlagCount <= 0) return null;

  const groups = groupLintIssues(sortLintIssues(visibleIssues, sortMode), groupMode);

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
    if (!issue.rowId || !kind || dismissBusy) return;
    const key = issueKey(issue);
    setDismissBusy(true);
    setBusyKey(key);
    // Add BEFORE awaiting the POST (optimistic hide); remove in `finally` —
    // on success once our own refetch has landed (server is truth then), on
    // failure immediately (nothing actually changed, so un-hiding matches
    // reality). Either way this key never outlives this one request cycle.
    setDismissedKeys((prev) => new Set(prev).add(key));
    try {
      await api.dismissReviewFlag(kind, book, issue.rowId, issue.reviewKind, issue.reviewReason);
      await onDismissed?.();
    } catch {
      setDismissError("Could not mark reviewed — try again.");
    } finally {
      setDismissedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setDismissBusy(false);
      setBusyKey(null);
    }
  };

  const dismissGroup = async (group: { key: string; issues: BookLintIssue[] }) => {
    if (dismissBusy) return;
    setDismissBusy(true);
    setBusyKey(group.key);
    // Keys this run added — each is added only once its OWN POST succeeds,
    // and all of them are removed together (in `finally`, below) once the
    // single trailing refetch for the whole group has settled.
    const ownKeys: string[] = [];
    let failed = 0;
    try {
      for (const issue of group.issues) {
        const kind = dismissibleKind(issue.resource);
        if (!issue.rowId || !kind) continue;
        try {
          await api.dismissReviewFlag(kind, book, issue.rowId, issue.reviewKind, issue.reviewReason);
          const key = issueKey(issue);
          ownKeys.push(key);
          setDismissedKeys((prev) => new Set(prev).add(key));
        } catch {
          failed++;
        }
      }
      if (failed > 0) {
        setDismissError(`${failed} of ${group.issues.length} failed to clear — try again.`);
      }
      await onDismissed?.();
    } finally {
      setDismissedKeys((prev) => {
        const next = new Set(prev);
        for (const key of ownKeys) next.delete(key);
        return next;
      });
      setDismissBusy(false);
      setBusyKey(null);
    }
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
        {visibleIssues.length > 1 && (
          <Box sx={{ px: 2, pb: 1, display: "flex", gap: 2, flexWrap: "wrap" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Group:
              </Typography>
              <Tooltip title="Collapse only genuine repeats">
                <ToggleButton
                  value="duplicate"
                  size="small"
                  selected={groupMode === "duplicate"}
                  onChange={() => setGroupMode("duplicate")}
                  sx={{ px: 1, py: 0.25, fontSize: 11, textTransform: "none" }}
                >
                  Duplicates
                </ToggleButton>
              </Tooltip>
              <Tooltip title="Group every issue of the same kind together, e.g. all 'Doubled space' findings">
                <ToggleButton
                  value="type"
                  size="small"
                  selected={groupMode === "type"}
                  onChange={() => setGroupMode("type")}
                  sx={{ px: 1, py: 0.25, fontSize: 11, textTransform: "none" }}
                >
                  Type
                </ToggleButton>
              </Tooltip>
            </Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Sort:
              </Typography>
              <Tooltip title="First-seen order">
                <ToggleButton
                  value="default"
                  size="small"
                  selected={sortMode === "default"}
                  onChange={() => setSortMode("default")}
                  sx={{ px: 1, py: 0.25, fontSize: 11, textTransform: "none" }}
                >
                  Default
                </ToggleButton>
              </Tooltip>
              <Tooltip title="Order by chapter:verse">
                <ToggleButton
                  value="verse"
                  size="small"
                  selected={sortMode === "verse"}
                  onChange={() => setSortMode("verse")}
                  sx={{ px: 1, py: 0.25, fontSize: 11, textTransform: "none" }}
                >
                  Verse
                </ToggleButton>
              </Tooltip>
            </Box>
          </Box>
        )}
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
                  secondaryTypographyProps={{ component: "div" }}
                />
                {issue.dismissible && issue.rowId && dismissibleKind(issue.resource) && (
                  <Tooltip title="Mark reviewed — clears this flag without changing the row">
                    <span>
                      <IconButton
                        size="small"
                        disabled={dismissBusy}
                        sx={{ ml: 0.5, mt: 0.25 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void dismissOne(issue);
                        }}
                      >
                        {busyKey === issueKey(issue) ? (
                          <CircularProgress size={16} />
                        ) : (
                          <CheckCircleOutlineIcon fontSize="small" />
                        )}
                      </IconButton>
                    </span>
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
          const groupSpinning = dismissBusy && busyKey === group.key;
          // Grouping by reviewKind or by type can collapse issues whose exact
          // message text differs — showing just group.message (the first
          // issue's) would misrepresent the rest. Fall back to a neutral
          // summary when the group isn't message-uniform; each issue's own
          // message is still shown once expanded, below.
          const messagesVary = group.issues.some((i) => i.message !== group.message);
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
                    {messagesVary ? "Tap to see each — details vary by row." : group.message}
                  </Typography>
                }
              />
              {fullyDismissible && (
                <Tooltip title={`Mark all ${group.issues.length} reviewed — clears these flags without changing the rows`}>
                  <span>
                    <IconButton
                      size="small"
                      disabled={dismissBusy}
                      sx={{ ml: 0.5, mt: 0.25 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismissGroup(group);
                      }}
                    >
                      {groupSpinning ? (
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
                    {messagesVary && (
                      <Typography variant="caption" color="text.secondary" sx={clampSx}>
                        {issue.message}
                      </Typography>
                    )}
                    <DoorDiff issue={issue} />
                  </Box>
                  {issue.dismissible && issue.rowId && dismissibleKind(issue.resource) && (
                    <Tooltip title="Mark reviewed — clears this flag without changing the row">
                      <span>
                        <IconButton
                          size="small"
                          disabled={dismissBusy}
                          sx={{ ml: 0.5 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            void dismissOne(issue);
                          }}
                        >
                          {busyKey === issueKey(issue) ? (
                            <CircularProgress size={16} />
                          ) : (
                            <CheckCircleOutlineIcon fontSize="small" />
                          )}
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </MenuItem>
              )),
            );
          }
          return items;
        })}
      </Menu>
      {/* MUI's Snackbar isn't itself portaled — rendered inline it would nest
          a <div> inside this component's root <span>. Portal moves it out to
          document.body so it stays valid markup regardless of where this
          indicator is mounted. */}
      <Portal>
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
      </Portal>
    </Box>
  );
}

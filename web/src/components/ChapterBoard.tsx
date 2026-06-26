import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckIcon from "@mui/icons-material/Check";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { CHECK_LANES, type CheckLane } from "../sync/api";
import { LANE_FILL, LANE_LABELS, type LaneShade } from "../lib/laneChecks";
import type { VerseTile, VerseTileLane } from "./TimelineRail";

export interface ChapterBoardProps {
  open: boolean;
  onClose: () => void;
  book: string;
  chapter: number;
  tiles: VerseTile[]; // one per verse (verse may be 0 = intro)
  canCheck: boolean;
  onToggle: (verse: number, lane: CheckLane) => void; // per cell
  onBulkToggle: (lane: CheckLane) => void; // column "all" (already confirm-gated upstream — just call it)
  // Lanes currently shown in the timeline rail; the board always lists every
  // lane so a hidden one can be turned back on here.
  enabledLanes: CheckLane[];
  onToggleLaneVisible: (lane: CheckLane) => void;
}

// Column layout shared by header / body / footer so the grid stays aligned.
const GRID_TEMPLATE = `72px repeat(${CHECK_LANES.length}, minmax(96px, 1fr))`;

function BoardCell({
  lane,
  canCheck,
  onToggle,
}: {
  lane: VerseTileLane;
  canCheck: boolean;
  onToggle: () => void;
}) {
  if (!lane.applicable) {
    return (
      <Tooltip title={lane.title}>
        <Box
          sx={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "text.disabled",
            fontSize: 15,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          –
        </Box>
      </Tooltip>
    );
  }
  const filled = lane.shade !== "open";
  const fill = filled ? LANE_FILL[lane.shade as Exclude<LaneShade, "open">] : null;
  return (
    <Tooltip title={lane.title}>
      <Box
        role="checkbox"
        aria-checked={filled}
        aria-label={lane.title}
        aria-disabled={!canCheck}
        onClick={canCheck ? onToggle : undefined}
        sx={{
          width: 24,
          height: 24,
          borderRadius: "5px",
          cursor: canCheck ? "pointer" : "not-allowed",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: fill ? fill.bg : "transparent",
          color: fill ? fill.fg : "transparent",
          border: fill ? "none" : "1.5px solid",
          borderColor: fill ? "transparent" : "divider",
          transition: "background-color 120ms",
          "&:hover": canCheck ? { borderColor: fill ? "transparent" : "text.secondary" } : {},
        }}
      >
        {filled && <CheckIcon sx={{ fontSize: 17 }} />}
      </Box>
    </Tooltip>
  );
}

export function ChapterBoard({
  open,
  onClose,
  book,
  chapter,
  tiles,
  canCheck,
  onToggle,
  onBulkToggle,
  enabledLanes,
  onToggleLaneVisible,
}: ChapterBoardProps) {
  // Per-lane tally: applicable = cells where the lane applies; done = those with
  // a non-"open" shade (checked by me / others / both). Percent rounds done/applicable.
  const tallies = CHECK_LANES.map((laneKind) => {
    let applicable = 0;
    let done = 0;
    for (const tile of tiles) {
      const lane = tile.lanes.find((l) => l.lane === laneKind);
      if (!lane || !lane.applicable) continue;
      applicable += 1;
      if (lane.shade !== "open") done += 1;
    }
    const percent = applicable === 0 ? 0 : Math.round((done / applicable) * 100);
    return { lane: laneKind, applicable, done, percent };
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1.5 }}
      >
        <Typography component="span" sx={{ fontSize: 18, fontWeight: 600 }}>
          Chapter board — {book} {chapter}
        </Typography>
        <IconButton onClick={onClose} aria-label="close" size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ fontSize: 15 }}>
        <Box sx={{ display: "table", width: "100%", borderCollapse: "collapse" }}>
          {/* Header row */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: GRID_TEMPLATE,
              alignItems: "end",
              columnGap: 1,
              pb: 1,
              borderBottom: "1px solid",
              borderColor: "divider",
              position: "sticky",
              top: 0,
              bgcolor: "background.paper",
              zIndex: 1,
            }}
          >
            <Box sx={{ fontSize: 14, fontWeight: 600, color: "text.secondary", pl: 0.5 }}>#</Box>
            {CHECK_LANES.map((laneKind) => {
              const shown = enabledLanes.includes(laneKind);
              return (
              <Box
                key={laneKind}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.25,
                }}
              >
                <Typography
                  sx={{ fontSize: 15, fontWeight: 600, color: shown ? "text.primary" : "text.disabled" }}
                >
                  {LANE_LABELS[laneKind]}
                </Typography>
                <Tooltip title={shown ? "Hide this lane in the sidebar" : "Show this lane in the sidebar"}>
                  <Box
                    role="button"
                    aria-label={`${shown ? "Hide" : "Show"} ${LANE_LABELS[laneKind]} in sidebar`}
                    aria-pressed={shown}
                    onClick={() => onToggleLaneVisible(laneKind)}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.25,
                      cursor: "pointer",
                      color: shown ? "primary.main" : "text.disabled",
                      fontSize: 12,
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    {shown ? (
                      <VisibilityIcon sx={{ fontSize: 14 }} />
                    ) : (
                      <VisibilityOffIcon sx={{ fontSize: 14 }} />
                    )}
                    {shown ? "shown" : "hidden"}
                  </Box>
                </Tooltip>
                {canCheck && (
                  <Box
                    role="button"
                    aria-label={`Check all ${LANE_LABELS[laneKind]}`}
                    onClick={() => onBulkToggle(laneKind)}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.25,
                      cursor: "pointer",
                      color: "primary.main",
                      fontSize: 13,
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    <DoneAllIcon sx={{ fontSize: 14 }} />
                    all
                  </Box>
                )}
              </Box>
              );
            })}
          </Box>

          {/* Body rows */}
          {tiles.map((tile) => {
            const byLane = new Map(tile.lanes.map((l) => [l.lane, l]));
            return (
              <Box
                key={tile.verse}
                sx={{
                  display: "grid",
                  gridTemplateColumns: GRID_TEMPLATE,
                  alignItems: "center",
                  columnGap: 1,
                  py: 0.75,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Box
                  sx={{
                    fontFamily: "monospace",
                    fontSize: 14,
                    color: "text.secondary",
                    pl: 0.5,
                    whiteSpace: "nowrap",
                  }}
                >
                  {tile.verse === 0 ? "intro" : tile.verse}
                </Box>
                {CHECK_LANES.map((laneKind) => {
                  const lane = byLane.get(laneKind);
                  return (
                    <Box
                      key={laneKind}
                      sx={{ display: "flex", justifyContent: "center", alignItems: "center" }}
                    >
                      {lane ? (
                        <BoardCell
                          lane={lane}
                          canCheck={canCheck}
                          onToggle={() => onToggle(tile.verse, laneKind)}
                        />
                      ) : (
                        <Box sx={{ color: "text.disabled", fontSize: 15 }}>–</Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            );
          })}

          {/* Footer tally row */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: GRID_TEMPLATE,
              alignItems: "center",
              columnGap: 1,
              pt: 1,
            }}
          >
            <Box sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary", pl: 0.5 }}>
              done
            </Box>
            {tallies.map((t) => (
              <Box
                key={t.lane}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.5,
                  px: 0.5,
                }}
              >
                <Typography sx={{ fontSize: 13, color: "text.secondary", whiteSpace: "nowrap" }}>
                  {t.done}/{t.applicable}
                </Typography>
                <Box
                  aria-label={`${LANE_LABELS[t.lane]} ${t.percent}% complete`}
                  sx={{
                    width: "100%",
                    height: 6,
                    borderRadius: 3,
                    bgcolor: "action.hover",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    sx={{
                      width: `${t.percent}%`,
                      height: "100%",
                      bgcolor: "#70C9CC",
                      transition: "width 160ms",
                    }}
                  />
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
}

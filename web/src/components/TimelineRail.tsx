import { Box, Tooltip } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import type { CheckLane } from "../sync/api";
import { LANE_FILL, LANE_LABELS, type LaneShade } from "../lib/laneChecks";

export interface VerseTileLane {
  lane: CheckLane;
  shade: LaneShade;
  applicable: boolean;
  title: string;
}

export interface VerseTile {
  verse: number;
  has: boolean;
  warn?: boolean;
  // One entry per lane, in display order (text, tn, tw, tq).
  lanes: VerseTileLane[];
}

// Single-letter lane glyphs for the rail header.
const LANE_GLYPH: Record<CheckLane, string> = { text: "T", tn: "N", tw: "W", tq: "Q" };

function LaneCell({
  lane,
  onToggle,
}: {
  lane: VerseTileLane;
  onToggle: () => void;
}) {
  if (!lane.applicable) {
    // N/A: nothing to check — no tooltip, just the muted dash.
    return (
      <Box
        sx={{
          width: 18,
          height: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.disabled",
          fontSize: 12,
          lineHeight: 1,
          userSelect: "none",
        }}
      >
        –
      </Box>
    );
  }
  const filled = lane.shade !== "open";
  const fill = filled ? LANE_FILL[lane.shade as Exclude<LaneShade, "open">] : null;
  const box = (
    <Box
      role="checkbox"
      aria-checked={filled}
      aria-label={lane.title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      sx={{
        width: 18,
        height: 18,
        borderRadius: "4px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: fill ? fill.bg : "transparent",
        color: fill ? fill.fg : "transparent",
        border: fill ? "none" : "1.5px solid",
        borderColor: fill ? "transparent" : "action.disabled",
        transition: "background-color 120ms",
        "&:hover": { borderColor: fill ? "transparent" : "text.secondary" },
      }}
    >
      {filled && <CheckIcon sx={{ fontSize: 13 }} />}
    </Box>
  );
  // Tooltip only on a CHECKED cell — the attribution of who checked it. Unchecked
  // cells show no tooltip. Slow to appear (>1s), instant to dismiss.
  if (!filled) return box;
  return (
    <Tooltip
      title={lane.title}
      placement="top"
      enterDelay={1200}
      enterNextDelay={1200}
      leaveDelay={0}
      // Gentle fade in, but vanish instantly on mouse-out (no lingering exit fade).
      TransitionProps={{ timeout: { appear: 0, enter: 150, exit: 0 } }}
    >
      {box}
    </Tooltip>
  );
}

interface Props {
  book: string;
  chapter: number;
  tiles: VerseTile[];
  activeVerse: number;
  // In book mode the rail covers one chapter inside a whole-book scroll, so
  // label tiles with chapter:verse (e.g. "2:3") instead of a bare verse number.
  showChapter?: boolean;
  // Lanes to show as columns, in canonical order. Hiding lanes narrows the rail.
  enabledLanes: CheckLane[];
  onSelect: (verse: number) => void;
  onToggleLane: (verse: number, lane: CheckLane) => void;
  // Click a lane header to hide that lane (re-enable from the Board dialog).
  onHideLane: (lane: CheckLane) => void;
}

export function TimelineRail({ book, chapter, tiles, activeVerse, showChapter = false, enabledLanes, onSelect, onToggleLane, onHideLane }: Props) {
  const laneOrder = enabledLanes;
  const gridTemplate = `30px repeat(${laneOrder.length}, 1fr)`;
  return (
    <Box
      sx={{
        width: "100%",
        flexGrow: 1,
        minHeight: 0,
        bgcolor: "grey.50",
        borderRight: "1px solid",
        borderColor: "divider",
        overflowY: "auto",
        overflowX: "hidden",
        py: 0.5,
      }}
    >
      {/* Lane-letter header — each glyph is a link that hides its lane. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: gridTemplate,
          alignItems: "center",
          px: 0.75,
          pb: 0.5,
          position: "sticky",
          top: -4,
          bgcolor: "grey.50",
          zIndex: 1,
        }}
      >
        <span />
        {laneOrder.map((l) => (
          <Tooltip key={l} title={`Hide ${LANE_LABELS[l]} — re-enable from Board`} placement="top">
            <Box
              role="button"
              aria-label={`Hide ${LANE_LABELS[l]} lane`}
              onClick={() => onHideLane(l)}
              sx={{
                textAlign: "center",
                cursor: "pointer",
                userSelect: "none",
                "&:hover .lane-glyph": { color: "primary.main", borderColor: "primary.main" },
              }}
            >
              <Box
                component="span"
                className="lane-glyph"
                sx={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "text.secondary",
                  borderBottom: "1px dotted",
                  borderColor: "text.disabled",
                  pb: "1px",
                }}
              >
                {LANE_GLYPH[l]}
              </Box>
            </Box>
          </Tooltip>
        ))}
      </Box>

      {tiles.map((t) => {
        const active = t.verse === activeVerse;
        const byLane = new Map(t.lanes.map((l) => [l.lane, l]));
        return (
          <Box
            key={t.verse}
            sx={{
              display: "grid",
              gridTemplateColumns: gridTemplate,
              alignItems: "center",
              mx: 0.5,
              mb: 0.25,
              borderRadius: 0.5,
              bgcolor: active ? "primary.main" : "transparent",
              color: active ? "primary.contrastText" : t.has ? "text.primary" : "text.disabled",
              "&:hover": active ? {} : { bgcolor: "action.hover" },
            }}
          >
            <Tooltip
              title={t.verse === 0 ? `${book} ${chapter} introduction` : `${book} ${chapter}:${t.verse}`}
              placement="right"
            >
              <Box
                onClick={() => onSelect(t.verse)}
                sx={{
                  fontFamily: "monospace",
                  fontSize: showChapter ? 11 : 12,
                  fontWeight: active ? 700 : 400,
                  textAlign: "center",
                  whiteSpace: "nowrap",
                  py: 0.5,
                  cursor: "pointer",
                  position: "relative",
                }}
              >
                {t.verse === 0 ? "i" : showChapter ? `${chapter}:${t.verse}` : t.verse}
                {t.has && !active && (
                  <Box
                    aria-label="unaligned words remain"
                    title="unaligned words remain"
                    sx={{
                      position: "absolute",
                      right: -2,
                      top: 2,
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      bgcolor: "warning.light",
                      border: "1px solid",
                      borderColor: "warning.dark",
                    }}
                  />
                )}
                {t.warn && (
                  <Box sx={{ position: "absolute", left: -2, top: 2, fontSize: 9, color: "error.main" }}>⚠</Box>
                )}
              </Box>
            </Tooltip>
            {laneOrder.map((laneKind) => {
              const lane = byLane.get(laneKind);
              return (
                <Box key={laneKind} sx={{ display: "flex", justifyContent: "center" }}>
                  {lane ? (
                    <LaneCell lane={lane} onToggle={() => onToggleLane(t.verse, laneKind)} />
                  ) : (
                    <span />
                  )}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

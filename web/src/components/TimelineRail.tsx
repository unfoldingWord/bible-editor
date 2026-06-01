import { Box, Tooltip, Checkbox } from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";

export interface VerseTile {
  verse: number;
  has: boolean;
  warn?: boolean;
  done?: boolean;
}

interface Props {
  book: string;
  chapter: number;
  tiles: VerseTile[];
  activeVerse: number;
  onSelect: (verse: number) => void;
  onToggleDone: (verse: number, done: boolean) => void;
}

export function TimelineRail({ book, chapter, tiles, activeVerse, onSelect, onToggleDone }: Props) {
  return (
    <Box
      sx={{
        width: 64,
        // flex-column child of the rail wrapper: must be able to shrink below
        // its content height so overflowY:auto actually scrolls. flexShrink:0
        // here pinned it to full content height, which both broke scrolling and
        // overflowed the wrapper into the split container (scrolling the fixed
        // headers off-screen via scrollIntoView).
        flexGrow: 1,
        minHeight: 0,
        bgcolor: "grey.50",
        borderRight: "1px solid",
        borderColor: "divider",
        overflowY: "auto",
        py: 0.5,
      }}
    >
      {tiles.map((t) => {
        const active = t.verse === activeVerse;
        return (
          <Box
            key={t.verse}
            sx={{
              display: "flex",
              alignItems: "center",
              mx: 0.5,
              mb: 0.25,
              borderRadius: 0.5,
              bgcolor: active ? "primary.main" : "transparent",
              color: active ? "primary.contrastText" : t.has ? "text.primary" : "text.disabled",
              "&:hover": active ? {} : { bgcolor: "action.hover" },
            }}
          >
            <Tooltip title={t.done ? "mark not done" : "mark done"} placement="right">
              <Checkbox
                size="small"
                checked={!!t.done}
                onChange={(_e, v) => onToggleDone(t.verse, v)}
                icon={<RadioButtonUncheckedIcon sx={{ fontSize: 16 }} />}
                checkedIcon={<CheckCircleIcon sx={{ fontSize: 16, color: "success.main" }} />}
                sx={{ p: 0.25 }}
              />
            </Tooltip>
            <Tooltip
              title={t.verse === 0 ? `${book} ${chapter} introduction` : `${book} ${chapter}:${t.verse}`}
              placement="right"
            >
              <Box
                onClick={() => onSelect(t.verse)}
                sx={{
                  flex: 1,
                  fontFamily: "monospace",
                  fontSize: 11,
                  fontWeight: active ? 700 : 400,
                  textAlign: "center",
                  py: 0.5,
                  cursor: "pointer",
                  position: "relative",
                  textDecoration: t.done && !active ? "line-through" : "none",
                }}
              >
                {t.verse === 0 ? "i" : t.verse}
                {t.has && !active && (
                  <Box
                    aria-label="unaligned words remain"
                    title="unaligned words remain"
                    sx={{
                      position: "absolute",
                      right: 4,
                      top: "50%",
                      transform: "translateY(-50%)",
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
                  <Box
                    sx={{
                      position: "absolute",
                      left: 2,
                      top: "50%",
                      transform: "translateY(-50%)",
                      fontSize: 9,
                      color: "error.main",
                    }}
                  >
                    ⚠
                  </Box>
                )}
              </Box>
            </Tooltip>
          </Box>
        );
      })}
    </Box>
  );
}

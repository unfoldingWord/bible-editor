import { Box, Tooltip } from "@mui/material";

interface VerseTile {
  verse: number;
  has: boolean;
  warn?: boolean;
}

interface Props {
  book: string;
  chapter: number;
  tiles: VerseTile[];
  activeVerse: number;
  onSelect: (verse: number) => void;
}

export function TimelineRail({ book, chapter, tiles, activeVerse, onSelect }: Props) {
  return (
    <Box
      sx={{
        width: 60,
        flexShrink: 0,
        bgcolor: "grey.50",
        borderRight: "1px solid",
        borderColor: "divider",
        overflowY: "auto",
        py: 0.5,
      }}
    >
      <Box
        sx={{
          fontFamily: "monospace",
          fontSize: 10,
          color: "text.secondary",
          textAlign: "center",
          pb: 0.5,
          mb: 0.5,
          borderBottom: "1px dashed",
          borderColor: "divider",
        }}
      >
        {book}
        <br />
        {chapter}
      </Box>
      {tiles.map((t) => {
        const active = t.verse === activeVerse;
        return (
          <Tooltip key={t.verse} title={`${book} ${chapter}:${t.verse}`} placement="right">
            <Box
              onClick={() => onSelect(t.verse)}
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: active ? 700 : 400,
                textAlign: "center",
                py: 0.5,
                mx: 0.5,
                mb: 0.25,
                borderRadius: 0.5,
                cursor: "pointer",
                color: active ? "primary.contrastText" : t.has ? "text.primary" : "text.disabled",
                bgcolor: active ? "primary.main" : "transparent",
                position: "relative",
                "&:hover": active ? {} : { bgcolor: "action.hover" },
              }}
            >
              {t.verse === 0 ? "intro" : t.verse}
              {t.has && !active && (
                <Box
                  sx={{
                    position: "absolute",
                    right: 6,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 6,
                    height: 6,
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
                    left: 4,
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
        );
      })}
    </Box>
  );
}

import { Box, Stack, Tooltip } from "@mui/material";

// The "lookback" band: faded, dashed-outline chips for the paragraph / poetry
// markers that live at the END of the previous verse but visually introduce THIS
// one (USFM writes `\q1` before `\v N`, so usfm-js attaches it to verse N-1).
// They are deliberately read-only — the data lives on the previous verse, and the
// tooltip says so. A `\ts\*` chunk divider never appears here: it marks a boundary
// at its own position and is rendered in the verse that owns it, not ghosted
// forward (see isDriftableMarker in lib/usfm.ts).
//
// Shared by all three scripture modes — rows (ScriptureColumn), columns
// (DocColumn) and book (BookView) — so the affordance can't drift out of sync
// between them again; it originally existed only in the rows view.
// `inline` renders the chips in the text flow instead of as stacked blocks — the
// columns view is one continuous prose column, where a block band would tear the
// paragraph apart. Rows and book mode lay verses out as blocks and use the default.
export function DriftedMarkerBand({
  markers,
  inline = false,
}: {
  markers: Array<{ tag: string }>;
  inline?: boolean;
}) {
  if (markers.length === 0) return null;
  if (inline) {
    return (
      <>
        {markers.map((m, i) => (
          <Tooltip key={`drift-${i}`} title="from previous verse — edit there" placement="top">
            <Box
              component="span"
              sx={{
                display: "inline-block",
                px: 0.5,
                mr: 0.5,
                fontSize: 11,
                opacity: 0.55,
                fontFamily: "Consolas, Menlo, monospace",
                color: "primary.main",
                border: "1px dashed",
                borderColor: "primary.main",
                borderRadius: 0.5,
                bgcolor: "rgba(49, 173, 227, 0.06)",
                verticalAlign: "1px",
              }}
            >
              {`\\${m.tag}`}
            </Box>
          </Tooltip>
        ))}
      </>
    );
  }
  return (
    <Stack spacing={0} sx={{ mb: 0.25 }}>
      {markers.map((m, i) => (
        <Tooltip key={`drift-${i}`} title="from previous verse — edit there" placement="left">
          <Box
            sx={{
              display: "block",
              pl:
                m.tag === "q2"
                  ? "2.5em"
                  : m.tag === "q3"
                    ? "3.75em"
                    : m.tag === "q4"
                      ? "5em"
                      : m.tag.startsWith("q")
                        ? "1.25em"
                        : 0,
              fontSize: 11,
              opacity: 0.55,
              fontFamily: "Consolas, Menlo, monospace",
              color: "primary.main",
            }}
          >
            <Box
              component="span"
              sx={{
                display: "inline-block",
                px: 0.5,
                border: "1px dashed",
                borderColor: "primary.main",
                borderRadius: 0.5,
                bgcolor: "rgba(49, 173, 227, 0.06)",
              }}
            >
              {`\\${m.tag}`}
            </Box>
          </Box>
        </Tooltip>
      ))}
    </Stack>
  );
}

// Map drifted verseObject nodes to the band's `{tag}` shape. Kept next to the
// component so every mode derives the prop identically.
export function driftedMarkerTags(nodes: unknown[]): Array<{ tag: string }> {
  return nodes.map((n) => ({ tag: String((n as Record<string, unknown>)["tag"] ?? "") }));
}

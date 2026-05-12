import { useEffect, useRef, useState } from "react";
import { Paper, Stack, Chip, IconButton, Typography, Box, TextField } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import type { TnRow } from "../sync/api";

interface Props {
  row: TnRow;
  active: boolean;
  onChange: (patch: Partial<TnRow>) => void;
  onDelete: () => void;
  onFocus?: () => void;
}

export function NoteCard({ row, active, onChange, onDelete, onFocus }: Props) {
  const [quote, setQuote] = useState(row.quote ?? "");
  const [note, setNote] = useState(row.note ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync when the row changes from outside (e.g. server-confirmed update).
  useEffect(() => {
    setQuote(row.quote ?? "");
  }, [row.id, row.version, row.quote]);
  useEffect(() => {
    setNote(row.note ?? "");
  }, [row.id, row.version, row.note]);

  const queue = (patch: Partial<TnRow>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange(patch);
      debounceRef.current = null;
    }, 300);
  };

  return (
    <Paper
      elevation={0}
      variant="outlined"
      onFocus={onFocus}
      sx={{
        my: 1,
        border: active ? "1.5px solid" : "1px solid",
        borderColor: active ? "primary.main" : "divider",
        bgcolor: active ? "primary.50" : "background.paper",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: "1px dashed",
          borderColor: "divider",
          bgcolor: "rgba(0,0,0,0.02)",
          flexWrap: "wrap",
        }}
      >
        <Box sx={{ cursor: "grab", color: "text.disabled", fontFamily: "monospace", fontSize: 13 }}>⋮⋮</Box>
        <Chip
          label={row.id}
          size="small"
          variant="outlined"
          sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
        />
        {row.support_reference && (
          <Chip
            label={shortSupport(row.support_reference)}
            size="small"
            color="primary"
            variant={active ? "filled" : "outlined"}
            sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
          />
        )}
        <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
          {row.ref_raw}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
          v{row.version}
        </Typography>
        <IconButton size="small" onClick={onDelete} color="error" sx={{ p: 0.25 }}>
          <DeleteOutlineIcon fontSize="inherit" />
        </IconButton>
      </Stack>
      <Box sx={{ p: 1 }}>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              minWidth: 54,
              textAlign: "right",
              pt: 1.25,
              flexShrink: 0,
            }}
          >
            Quote
          </Typography>
          <TextField
            value={quote}
            onChange={(e) => {
              setQuote(e.target.value);
              queue({ quote: e.target.value });
            }}
            multiline
            fullWidth
            size="small"
            spellCheck={false}
            inputProps={{
              dir: "rtl",
              style: { fontFamily: "monospace", fontSize: 12, textAlign: "right" },
            }}
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              minWidth: 54,
              textAlign: "right",
              pt: 1.25,
              flexShrink: 0,
            }}
          >
            Note
          </Typography>
          <TextField
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              queue({ note: e.target.value });
            }}
            multiline
            fullWidth
            minRows={2}
            size="small"
            spellCheck
            inputProps={{ style: { fontSize: 13, lineHeight: 1.45 } }}
          />
        </Stack>
      </Box>
    </Paper>
  );
}

function shortSupport(s: string): string {
  // 'rc://*/ta/man/translate/figs-explicit' -> 'figs-explicit'
  const m = s.match(/\/([^/]+)$/);
  return m ? m[1] : s;
}

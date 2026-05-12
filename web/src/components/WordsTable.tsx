import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, TextField, IconButton, Typography, Chip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import type { TwlRow } from "../sync/api";

interface Props {
  rows: TwlRow[];
  onChange: (id: string, patch: Partial<TwlRow>) => void;
  onDelete: (id: string) => void;
}

export function WordsTable({ rows, onChange, onDelete }: Props) {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        no words for this verse
      </Typography>
    );
  }
  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "60px 1fr 1.2fr 36px",
          gap: 1,
          alignItems: "center",
          px: 1,
          py: 0.5,
          bgcolor: "grey.50",
          fontFamily: "monospace",
          fontSize: 10,
          textTransform: "uppercase",
          color: "text.disabled",
          borderBottom: "1px dashed",
          borderColor: "divider",
        }}
      >
        <span>Ref</span>
        <span>Quote</span>
        <span>TW article</span>
        <span />
      </Box>
      {rows.map((r) => (
        <WordRow key={r.id} row={r} onChange={(p) => onChange(r.id, p)} onDelete={() => onDelete(r.id)} />
      ))}
    </Paper>
  );
}

function WordRow({
  row,
  onChange,
  onDelete,
}: {
  row: TwlRow;
  onChange: (patch: Partial<TwlRow>) => void;
  onDelete: () => void;
}) {
  const [ref, setRef] = useState(row.ref_raw);
  const [quote, setQuote] = useState(row.orig_words ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setRef(row.ref_raw), [row.id, row.version, row.ref_raw]);
  useEffect(() => setQuote(row.orig_words ?? ""), [row.id, row.version, row.orig_words]);

  const queue = (patch: Partial<TwlRow>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(patch), 300);
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        display: "grid",
        gridTemplateColumns: "60px 1fr 1.2fr 36px",
        alignItems: "center",
        gap: 1,
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <TextField
        value={ref}
        onChange={(e) => {
          setRef(e.target.value);
          queue({ ref_raw: e.target.value });
        }}
        size="small"
        variant="outlined"
        inputProps={{
          style: { fontFamily: "monospace", fontSize: 11, padding: "3px 6px", textAlign: "center" },
        }}
      />
      <TextField
        value={quote}
        onChange={(e) => {
          setQuote(e.target.value);
          queue({ orig_words: e.target.value });
        }}
        size="small"
        variant="outlined"
        spellCheck={false}
        inputProps={{
          dir: "rtl",
          style: { fontSize: 13, padding: "3px 6px", textAlign: "right" },
        }}
      />
      <Chip
        label={twShort(row.tw_link)}
        size="small"
        variant="outlined"
        title={row.tw_link ?? ""}
        sx={{ justifySelf: "start" }}
      />
      <IconButton size="small" onClick={onDelete} color="error" sx={{ p: 0.25 }}>
        <DeleteOutlineIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  );
}

function twShort(link: string | null): string {
  if (!link) return "—";
  // rc://*/tw/dict/bible/names/moab → names/moab
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

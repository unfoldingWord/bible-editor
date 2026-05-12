import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, TextField, IconButton, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import type { TwlRow } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { CatalogPicker } from "./CatalogPicker";

interface Props {
  rows: TwlRow[];
  activeId: string | null;
  onChange: (id: string, patch: Partial<TwlRow>) => void;
  onDelete: (id: string) => void;
  onFocus: (row: TwlRow) => void;
}

export function WordsTable({ rows, activeId, onChange, onDelete, onFocus }: Props) {
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
        <WordRow
          key={r.id}
          row={r}
          active={r.id === activeId}
          onChange={(p) => onChange(r.id, p)}
          onDelete={() => onDelete(r.id)}
          onFocus={() => onFocus(r)}
        />
      ))}
    </Paper>
  );
}

function WordRow({
  row,
  active,
  onChange,
  onDelete,
  onFocus,
}: {
  row: TwlRow;
  active: boolean;
  onChange: (patch: Partial<TwlRow>) => void;
  onDelete: () => void;
  onFocus: () => void;
}) {
  const [ref, setRef] = useState(row.ref_raw);
  const [quote, setQuote] = useState(row.orig_words ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogs = useCatalogs();

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
      onMouseDown={onFocus}
      onFocus={onFocus}
      sx={{
        display: "grid",
        gridTemplateColumns: "60px 1fr 1.2fr 36px",
        alignItems: "center",
        gap: 1,
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        bgcolor: active ? "primary.50" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--mui-palette-primary-main, #1976d2)" : "none",
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
          style: {
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
            fontSize: 19,
            padding: "3px 6px",
            textAlign: "right",
          },
        }}
      />
      <CatalogPicker
        value={row.tw_link}
        options={catalogs.twLinks}
        display={(v) => (v ? twShort(v) : "+ TW article")}
        placeholder="names/, kt/, other/, …"
        onChange={(next) => onChange({ tw_link: next })}
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

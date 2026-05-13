import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, TextField, IconButton, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import type { TqRow } from "../sync/api";

interface Props {
  rows: TqRow[];
  onChange: (id: string, patch: Partial<TqRow>) => void;
  onDelete: (id: string) => void;
  // When true, rows render read-only and the delete button is hidden. Used
  // while an AI pipeline is mid-flight for the chapter — the auto-apply step
  // will overwrite TQs anyway.
  locked?: boolean;
}

export function QuestionsTable({ rows, onChange, onDelete, locked = false }: Props) {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        no questions for this verse
      </Typography>
    );
  }
  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: GRID_COLS,
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
        <span>Question</span>
        <span>Response</span>
        <span />
      </Box>
      {rows.map((r) => (
        <Row
          key={r.id}
          row={r}
          onChange={(p) => onChange(r.id, p)}
          onDelete={() => onDelete(r.id)}
          locked={locked}
        />
      ))}
    </Paper>
  );
}

// Reference span can include ranges like "1:1-3", so give it a bit of room
// without dominating the row.
const GRID_COLS = "80px 1fr 1fr 36px";

function Row({
  row,
  onChange,
  onDelete,
  locked,
}: {
  row: TqRow;
  onChange: (patch: Partial<TqRow>) => void;
  onDelete: () => void;
  locked: boolean;
}) {
  const [refRaw, setRefRaw] = useState(row.ref_raw ?? "");
  const [question, setQuestion] = useState(row.question ?? "");
  const [response, setResponse] = useState(row.response ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<TqRow>>({});

  useEffect(() => setRefRaw(row.ref_raw ?? ""), [row.id, row.version, row.ref_raw]);
  useEffect(() => setQuestion(row.question ?? ""), [row.id, row.version, row.question]);
  useEffect(() => setResponse(row.response ?? ""), [row.id, row.version, row.response]);

  // Merge field edits per debounce window so editing ref + question together
  // collapses into a single PATCH / version bump.
  const queue = (patch: Partial<TqRow>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const merged = pendingRef.current;
      pendingRef.current = {};
      debounceRef.current = null;
      onChange(merged);
    }, 300);
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        display: "grid",
        gridTemplateColumns: GRID_COLS,
        gap: 1,
        alignItems: "center",
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <TextField
        value={refRaw}
        onChange={(e) => {
          setRefRaw(e.target.value);
          queue({ ref_raw: e.target.value });
        }}
        size="small"
        spellCheck={false}
        variant="outlined"
        placeholder="1:1"
        InputProps={{ readOnly: locked }}
        inputProps={{
          style: { fontSize: 12, padding: "3px 6px", fontFamily: "monospace" },
        }}
      />
      <TextField
        value={question}
        onChange={(e) => {
          setQuestion(e.target.value);
          queue({ question: e.target.value });
        }}
        size="small"
        multiline
        spellCheck
        variant="outlined"
        InputProps={{ readOnly: locked }}
        inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
      />
      <TextField
        value={response}
        onChange={(e) => {
          setResponse(e.target.value);
          queue({ response: e.target.value });
        }}
        size="small"
        multiline
        spellCheck
        variant="outlined"
        InputProps={{ readOnly: locked }}
        inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
      />
      {locked ? (
        <span />
      ) : (
        <IconButton size="small" onClick={onDelete} color="error" sx={{ p: 0.25 }}>
          <DeleteOutlineIcon fontSize="inherit" />
        </IconButton>
      )}
    </Stack>
  );
}

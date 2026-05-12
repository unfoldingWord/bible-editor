import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, TextField, IconButton, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import type { TqRow } from "../sync/api";

interface Props {
  rows: TqRow[];
  onChange: (id: string, patch: Partial<TqRow>) => void;
  onDelete: (id: string) => void;
}

export function QuestionsTable({ rows, onChange, onDelete }: Props) {
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
          gridTemplateColumns: "1fr 1fr 36px",
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
        <span>Question</span>
        <span>Response</span>
        <span />
      </Box>
      {rows.map((r) => (
        <Row key={r.id} row={r} onChange={(p) => onChange(r.id, p)} onDelete={() => onDelete(r.id)} />
      ))}
    </Paper>
  );
}

function Row({
  row,
  onChange,
  onDelete,
}: {
  row: TqRow;
  onChange: (patch: Partial<TqRow>) => void;
  onDelete: () => void;
}) {
  const [question, setQuestion] = useState(row.question ?? "");
  const [response, setResponse] = useState(row.response ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setQuestion(row.question ?? ""), [row.id, row.version, row.question]);
  useEffect(() => setResponse(row.response ?? ""), [row.id, row.version, row.response]);

  const queue = (patch: Partial<TqRow>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(patch), 300);
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 36px",
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
        value={question}
        onChange={(e) => {
          setQuestion(e.target.value);
          queue({ question: e.target.value });
        }}
        size="small"
        multiline
        spellCheck
        variant="outlined"
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
        inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
      />
      <IconButton size="small" onClick={onDelete} color="error" sx={{ p: 0.25 }}>
        <DeleteOutlineIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  );
}

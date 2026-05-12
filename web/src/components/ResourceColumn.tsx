import { Box, Stack, Typography, Chip, Button } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import type { TnRow, TqRow, TwlRow } from "../sync/api";
import { NoteCard } from "./NoteCard";
import { WordsTable } from "./WordsTable";
import { QuestionsTable } from "./QuestionsTable";

interface Props {
  activeVerse: number;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  activeNoteId: string | null;
  onNoteChange: (id: string, patch: Partial<TnRow>) => void;
  onNoteDelete: (id: string) => void;
  onNoteFocus: (id: string) => void;
  onWordChange: (id: string, patch: Partial<TwlRow>) => void;
  onWordDelete: (id: string) => void;
  onQuestionChange: (id: string, patch: Partial<TqRow>) => void;
  onQuestionDelete: (id: string) => void;
}

export function ResourceColumn({
  activeVerse,
  tn,
  tq,
  twl,
  activeNoteId,
  onNoteChange,
  onNoteDelete,
  onNoteFocus,
  onWordChange,
  onWordDelete,
  onQuestionChange,
  onQuestionDelete,
}: Props) {
  const tnForVerse = tn.filter((r) => r.verse === activeVerse);
  const tqForVerse = tq.filter((r) => r.verse === activeVerse);
  const twlForVerse = twl.filter((r) => r.verse === activeVerse);

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
        }}
      >
        <Typography variant="subtitle2">
          Resources · {activeVerse === 0 ? "intro" : activeVerse}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Chip label={`${tnForVerse.length} notes`} size="small" variant="outlined" />
        <Chip label={`${twlForVerse.length} words`} size="small" variant="outlined" />
        <Chip label={`${tqForVerse.length} Q`} size="small" variant="outlined" />
      </Stack>
      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 1 }}>
        <SectionHead title="Notes" count={tnForVerse.length} />
        {tnForVerse.length === 0 && (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            no notes for this verse
          </Typography>
        )}
        {tnForVerse.map((r) => (
          <NoteCard
            key={r.id}
            row={r}
            active={r.id === activeNoteId}
            onChange={(p) => onNoteChange(r.id, p)}
            onDelete={() => onNoteDelete(r.id)}
            onFocus={() => onNoteFocus(r.id)}
          />
        ))}

        <Box sx={{ height: 16 }} />
        <SectionHead title="Words" count={twlForVerse.length} />
        <WordsTable rows={twlForVerse} onChange={onWordChange} onDelete={onWordDelete} />

        <Box sx={{ height: 16 }} />
        <SectionHead title="Questions" count={tqForVerse.length} />
        <QuestionsTable rows={tqForVerse} onChange={onQuestionChange} onDelete={onQuestionDelete} />
      </Box>
    </Box>
  );
}

function SectionHead({ title, count }: { title: string; count: number }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        pb: 0.5,
        mb: 0.5,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography variant="subtitle2">{title}</Typography>
      <Chip
        label={count}
        size="small"
        variant="outlined"
        sx={{ height: 18, fontFamily: "monospace", fontSize: 10 }}
      />
      <Box sx={{ flex: 1 }} />
      <Button
        size="small"
        startIcon={<AddIcon fontSize="small" />}
        color="success"
        variant="text"
        sx={{ minWidth: 0, fontSize: 11 }}
        disabled
        title="adding new rows lands in the next iteration"
      >
        new
      </Button>
    </Stack>
  );
}

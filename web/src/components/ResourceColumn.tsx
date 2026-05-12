import { Fragment, useRef, useState } from "react";
import { Box, Stack, Typography, Chip, Button } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import type { TnRow, TqRow, TwlRow } from "../sync/api";
import { NoteCard, type DropPosition } from "./NoteCard";
import { WordsTable } from "./WordsTable";
import { QuestionsTable } from "./QuestionsTable";

interface Props {
  activeVerse: number;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  activeNoteId: string | null;
  activeWordId: string | null;
  onNoteChange: (id: string, patch: Partial<TnRow>) => void;
  onNoteDelete: (id: string) => void;
  onNoteInsertAfter: (refId: string) => void;
  onNoteReorder: (draggedId: string, refId: string, position: DropPosition) => void;
  onNoteFocus: (row: TnRow) => void;
  onNoteCreate: () => void;
  onWordChange: (id: string, patch: Partial<TwlRow>) => void;
  onWordDelete: (id: string) => void;
  onWordCreate: () => void;
  onWordFocus: (row: TwlRow) => void;
  onQuestionChange: (id: string, patch: Partial<TqRow>) => void;
  onQuestionDelete: (id: string) => void;
  onQuestionCreate: () => void;
}

export function ResourceColumn({
  activeVerse,
  tn,
  tq,
  twl,
  activeNoteId,
  activeWordId,
  onNoteChange,
  onNoteDelete,
  onNoteInsertAfter,
  onNoteReorder,
  onNoteFocus,
  onNoteCreate,
  onWordChange,
  onWordDelete,
  onWordCreate,
  onWordFocus,
  onQuestionChange,
  onQuestionDelete,
  onQuestionCreate,
}: Props) {
  const tnForVerse = tn
    .filter((r) => r.verse === activeVerse)
    .sort(
      (a, b) =>
        (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
  const tqForVerse = tq.filter((r) => r.verse === activeVerse);
  const twlForVerse = twl.filter((r) => r.verse === activeVerse);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: DropPosition } | null
  >(null);

  const notesRef = useRef<HTMLDivElement | null>(null);
  const wordsRef = useRef<HTMLDivElement | null>(null);
  const questionsRef = useRef<HTMLDivElement | null>(null);
  const scrollTo = (r: React.RefObject<HTMLDivElement | null>) =>
    r.current?.scrollIntoView({ behavior: "smooth", block: "start" });

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
        <Chip
          label={`${tnForVerse.length} notes`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => scrollTo(notesRef)}
        />
        <Chip
          label={`${twlForVerse.length} words`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => scrollTo(wordsRef)}
        />
        <Chip
          label={`${tqForVerse.length} Q`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => scrollTo(questionsRef)}
        />
      </Stack>
      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 1 }}>
        <div ref={notesRef} />
        <SectionHead title="Notes" count={tnForVerse.length} onAdd={onNoteCreate} sticky />
        {tnForVerse.length === 0 && (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            no notes for this verse
          </Typography>
        )}
        {tnForVerse.map((r) => {
          const showBefore =
            dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "before";
          const showAfter =
            dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "after";
          return (
            <Fragment key={r.id}>
              {showBefore && <DropIndicator />}
              <NoteCard
                row={r}
                active={r.id === activeNoteId}
                dragging={dragId === r.id}
                isDropTarget={dragId !== null && dragId !== r.id}
                onChange={(p) => onNoteChange(r.id, p)}
                onDelete={() => onNoteDelete(r.id)}
                onInsertAfter={() => onNoteInsertAfter(r.id)}
                onFocus={() => onNoteFocus(r)}
                onGripDragStart={() => setDragId(r.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOver(null);
                }}
                onCardDragOver={(position) => {
                  setDragOver((cur) =>
                    cur && cur.targetId === r.id && cur.position === position
                      ? cur
                      : { targetId: r.id, position },
                  );
                }}
                onCardDragLeave={() => {
                  // Don't clear on leave — the next onDragOver from the
                  // adjacent card or the same card's other half will
                  // immediately overwrite this. Clearing here causes flicker.
                }}
                onCardDrop={(position) => {
                  if (dragId && dragId !== r.id) {
                    onNoteReorder(dragId, r.id, position);
                  }
                  setDragId(null);
                  setDragOver(null);
                }}
              />
              {showAfter && <DropIndicator />}
            </Fragment>
          );
        })}

        <Box sx={{ height: 16 }} />
        <div ref={wordsRef} />
        <SectionHead title="Words" count={twlForVerse.length} onAdd={onWordCreate} />
        <WordsTable
          rows={twlForVerse}
          activeId={activeWordId}
          onChange={onWordChange}
          onDelete={onWordDelete}
          onFocus={onWordFocus}
        />

        <Box sx={{ height: 16 }} />
        <div ref={questionsRef} />
        <SectionHead title="Questions" count={tqForVerse.length} onAdd={onQuestionCreate} />
        <QuestionsTable rows={tqForVerse} onChange={onQuestionChange} onDelete={onQuestionDelete} />
      </Box>
    </Box>
  );
}

function DropIndicator() {
  return (
    <Box
      sx={{
        height: 3,
        my: 0.5,
        bgcolor: "primary.main",
        borderRadius: 1,
        boxShadow: "0 0 4px rgba(25,118,210,0.5)",
      }}
    />
  );
}

function SectionHead({ title, count, onAdd, sticky }: { title: string; count: number; onAdd: () => void; sticky?: boolean }) {
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
        ...(sticky
          ? {
              position: "sticky",
              top: 0,
              bgcolor: "background.paper",
              zIndex: 2,
              pt: 0.5,
            }
          : {}),
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
        variant="outlined"
        sx={{ minWidth: 0, fontSize: 11 }}
        onClick={onAdd}
      >
        new
      </Button>
    </Stack>
  );
}

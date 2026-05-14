import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Box, Stack, Typography, Chip, Button, IconButton, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import type { TnRow, TqRow, TwlRow } from "../sync/api";
import { NoteCard, type DropPosition } from "./NoteCard";
import { WordsTable, type WordDropPosition } from "./WordsTable";
import { QuestionsTable } from "./QuestionsTable";

interface Props {
  activeVerse: number;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  activeNoteId: string | null;
  activeWordId: string | null;
  // Bumped by Shell's "go to active" button so the resource column can
  // recentre on the active note / word / verse group alongside the
  // scripture column.
  scrollNonce: number;
  onNoteChange: (id: string, patch: Partial<TnRow>) => void;
  onNoteSave: (
    id: string,
    patch: Partial<TnRow>,
    opts?: { restoredFromVersion?: number },
  ) => void;
  onNoteDelete: (id: string) => void;
  onNoteInsertAfter: (refId: string) => void;
  onNoteReorder: (draggedId: string, refId: string, position: DropPosition) => void;
  onNoteFocus: (row: TnRow) => void;
  onNoteCreate: () => void;
  // Async AI-draft wiring. All optional — when absent, sparkles hides.
  // start fires the request (returns immediately); the result lands
  // later via the row patch pipeline. The two read-only accessors let
  // each NoteCard show its spinner / pulse independently. Visibility
  // bubbles up to Shell so it can route completions to either the
  // in-place pulse or the off-screen toast stack.
  onNoteStartAi?: (row: TnRow) => void;
  isNoteAiPending?: (rowId: string) => boolean;
  noteAiRecentlyCompletedAt?: (rowId: string) => number | null;
  onNoteVisibilityChange?: (rowId: string, isVisible: boolean) => void;
  onWordChange: (id: string, patch: Partial<TwlRow>) => void;
  onWordDelete: (id: string) => void;
  onWordCreate: () => void;
  onWordFocus: (row: TwlRow) => void;
  onWordReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  onQuestionChange: (id: string, patch: Partial<TqRow>) => void;
  onQuestionDelete: (id: string) => void;
  onQuestionCreate: () => void;
  // Chapter is locked for editing because an AI pipeline is mid-flight.
  // Hides "new" buttons, propagates read-only to children.
  locked?: boolean;
  // Called when a TN's Keep checkbox is checked. Threaded through to NoteCard.
  onKeepNote?: (id: string) => void;
  // Translate English in a note's quote field to source-language text using
  // ULT alignment. Returns null when no alignment match is found.
  onNoteTranslateQuote?: (row: TnRow, english: string) => string | null;
  // Same translate flow but for the TWL quote (orig_words) column.
  onWordTranslateQuote?: (row: TwlRow, english: string) => string | null;
}

type PinKey = "notes" | "words" | "questions";
type Pinned = Record<PinKey, boolean>;

const PINNED_KEY = "be:pinned";

function loadPinned(): Pinned {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Pinned>;
      return {
        notes: !!parsed.notes,
        words: !!parsed.words,
        questions: !!parsed.questions,
      };
    }
  } catch {
    /* ignore */
  }
  return { notes: false, words: false, questions: false };
}

function savePinned(p: Pinned) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function sortBySortOrder<T extends { sort_order: number | null; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
        (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
  );
}

function groupByVerse<T extends { verse: number }>(rows: T[]): Array<[number, T[]]> {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const bucket = map.get(r.verse) ?? [];
    bucket.push(r);
    map.set(r.verse, bucket);
  }
  return [...map.entries()].sort(([a], [b]) => a - b);
}

export function ResourceColumn({
  activeVerse,
  tn,
  tq,
  twl,
  activeNoteId,
  activeWordId,
  scrollNonce,
  onNoteChange,
  onNoteSave,
  onNoteDelete,
  onNoteInsertAfter,
  onNoteReorder,
  onNoteFocus,
  onNoteCreate,
  onNoteStartAi,
  isNoteAiPending,
  noteAiRecentlyCompletedAt,
  onNoteVisibilityChange,
  onWordChange,
  onWordDelete,
  onWordCreate,
  onWordFocus,
  onWordReorder,
  onQuestionChange,
  onQuestionDelete,
  onQuestionCreate,
  locked = false,
  onKeepNote,
  onNoteTranslateQuote,
  onWordTranslateQuote,
}: Props) {
  const [pinned, setPinned] = useState<Pinned>(() => loadPinned());
  const togglePinned = (k: PinKey) => {
    const next = { ...pinned, [k]: !pinned[k] };
    setPinned(next);
    savePinned(next);
  };

  const tnForVerse = useMemo(
    () => sortBySortOrder(tn.filter((r) => r.verse === activeVerse)),
    [tn, activeVerse],
  );
  const tqForVerse = useMemo(
    () => tq.filter((r) => r.verse === activeVerse),
    [tq, activeVerse],
  );
  const twlForVerse = useMemo(
    () => sortBySortOrder(twl.filter((r) => r.verse === activeVerse)),
    [twl, activeVerse],
  );

  // Pinned sections show the whole chapter, grouped by verse. Within each
  // verse the row order matches the unpinned view.
  const tnGroups = useMemo(
    () =>
      pinned.notes
        ? groupByVerse(tn).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TnRow[]])
        : null,
    [pinned.notes, tn],
  );
  const tqGroups = useMemo(
    () => (pinned.questions ? groupByVerse(tq) : null),
    [pinned.questions, tq],
  );
  const twlGroups = useMemo(
    () =>
      pinned.words
        ? groupByVerse(twl).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TwlRow[]])
        : null,
    [pinned.words, twl],
  );

  const totalTn = pinned.notes ? tn.length : tnForVerse.length;
  const totalTwl = pinned.words ? twl.length : twlForVerse.length;
  const totalTq = pinned.questions ? tq.length : tqForVerse.length;

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: DropPosition } | null
  >(null);

  const notesRef = useRef<HTMLDivElement | null>(null);
  const wordsRef = useRef<HTMLDivElement | null>(null);
  const questionsRef = useRef<HTMLDivElement | null>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const scrollTo = (r: React.RefObject<HTMLDivElement | null>) =>
    r.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Keep the resource column lined up with the active selection. We fire on:
  //   - scrollNonce (Shell's "go to active" button)
  //   - activeNoteId / activeWordId (focus shifts that came from elsewhere)
  //   - activeVerse (timeline click, especially relevant when a section is
  //     pinned and the user wants to jump into that verse's group)
  //   - pinned.* (pin toggles, so the user lands on the same conceptual
  //     spot they were viewing before the layout reshuffled)
  // Priority: active note > active word > active-verse group in any pinned
  // section. Without any of those, no scroll.
  const prevNonceRef = useRef(scrollNonce);
  useEffect(() => {
    const root = scrollBodyRef.current;
    if (!root) return;
    const fromButton = prevNonceRef.current !== scrollNonce;
    prevNonceRef.current = scrollNonce;
    let target: HTMLElement | null = null;
    if (activeNoteId) {
      target = root.querySelector<HTMLElement>(`[data-note-id="${activeNoteId}"]`);
    } else if (activeWordId) {
      target = root.querySelector<HTMLElement>(`[data-word-id="${activeWordId}"]`);
    }
    if (!target && (pinned.notes || pinned.words || pinned.questions)) {
      target = root.querySelector<HTMLElement>(`[data-verse-group="${activeVerse}"]`);
    }
    target?.scrollIntoView({
      behavior: "smooth",
      block: fromButton ? "center" : "nearest",
    });
  }, [
    scrollNonce,
    activeNoteId,
    activeWordId,
    activeVerse,
    pinned.notes,
    pinned.words,
    pinned.questions,
  ]);

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
          label={`${totalTn} notes${pinned.notes ? " · ch" : ""}`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => scrollTo(notesRef)}
        />
        <Chip
          label={`${totalTwl} words${pinned.words ? " · ch" : ""}`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => scrollTo(wordsRef)}
        />
        <Chip
          label={`${totalTq} Q${pinned.questions ? " · ch" : ""}`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => scrollTo(questionsRef)}
        />
      </Stack>
      <Box ref={scrollBodyRef} sx={{ flex: 1, overflowY: "auto", px: 2, py: 1 }}>
        <div ref={notesRef} />
        <SectionHead
          title="Notes"
          count={totalTn}
          pinned={pinned.notes}
          onTogglePin={() => togglePinned("notes")}
          onAdd={onNoteCreate}
          sticky
          hideAdd={locked}
        />
        {tnGroups ? (
          tnGroups.length === 0 ? (
            <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
              no notes in this chapter
            </Typography>
          ) : (
            tnGroups.map(([verse, rows]) => (
              <Fragment key={`tn-${verse}`}>
                <VerseGroupHead verse={verse} active={verse === activeVerse} />
                {rows.map((r) => renderNoteCard(r))}
              </Fragment>
            ))
          )
        ) : tnForVerse.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            no notes for this verse
          </Typography>
        ) : (
          tnForVerse.map((r) => renderNoteCard(r))
        )}

        <Box sx={{ height: 16 }} />
        <div ref={wordsRef} />
        <SectionHead
          title="Words"
          count={totalTwl}
          pinned={pinned.words}
          onTogglePin={() => togglePinned("words")}
          onAdd={onWordCreate}
          hideAdd={locked}
        />
        {twlGroups ? (
          twlGroups.length === 0 ? (
            <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
              no words in this chapter
            </Typography>
          ) : (
            twlGroups.map(([verse, rows]) => (
              <Fragment key={`twl-${verse}`}>
                <VerseGroupHead verse={verse} active={verse === activeVerse} />
                <WordsTable
                  rows={rows}
                  activeId={activeWordId}
                  onChange={onWordChange}
                  onDelete={onWordDelete}
                  onFocus={onWordFocus}
                  onReorder={onWordReorder}
                  locked={locked}
                  onTranslateQuote={onWordTranslateQuote}
                />
              </Fragment>
            ))
          )
        ) : (
          <WordsTable
            rows={twlForVerse}
            activeId={activeWordId}
            onChange={onWordChange}
            onDelete={onWordDelete}
            onFocus={onWordFocus}
            onReorder={onWordReorder}
            locked={locked}
            onTranslateQuote={onWordTranslateQuote}
          />
        )}

        <Box sx={{ height: 16 }} />
        <div ref={questionsRef} />
        <SectionHead
          title="Questions"
          count={totalTq}
          pinned={pinned.questions}
          onTogglePin={() => togglePinned("questions")}
          onAdd={onQuestionCreate}
          hideAdd={locked}
        />
        {tqGroups ? (
          tqGroups.length === 0 ? (
            <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
              no questions in this chapter
            </Typography>
          ) : (
            tqGroups.map(([verse, rows]) => (
              <Fragment key={`tq-${verse}`}>
                <VerseGroupHead verse={verse} active={verse === activeVerse} />
                <QuestionsTable rows={rows} onChange={onQuestionChange} onDelete={onQuestionDelete} locked={locked} />
              </Fragment>
            ))
          )
        ) : (
          <QuestionsTable rows={tqForVerse} onChange={onQuestionChange} onDelete={onQuestionDelete} locked={locked} />
        )}
      </Box>
    </Box>
  );

  function renderNoteCard(r: TnRow) {
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
          onSave={(p, opts) => onNoteSave(r.id, p, opts)}
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
          onStartAi={onNoteStartAi ? () => onNoteStartAi(r) : undefined}
          isAiPending={isNoteAiPending?.(r.id) ?? false}
          aiRecentlyCompletedAt={noteAiRecentlyCompletedAt?.(r.id) ?? null}
          onVisibilityChange={onNoteVisibilityChange}
          locked={locked}
          onKeep={onKeepNote ? () => onKeepNote(r.id) : undefined}
          onTranslateQuote={
            onNoteTranslateQuote ? (english) => onNoteTranslateQuote(r, english) : undefined
          }
        />
        {showAfter && <DropIndicator />}
      </Fragment>
    );
  }
}

function DropIndicator() {
  return (
    <Box
      sx={{
        height: 3,
        my: 0.5,
        bgcolor: "primary.main",
        borderRadius: 1,
        boxShadow: "0 0 4px rgba(49,173,227,0.5)",
      }}
    />
  );
}

function VerseGroupHead({ verse, active }: { verse: number; active: boolean }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-verse-group={verse}
      sx={{
        mt: 1,
        mb: 0.25,
        py: 0.25,
        px: 0.5,
        borderBottom: "1px dashed",
        borderColor: active ? "primary.main" : "divider",
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontWeight: 700,
          color: active ? "primary.main" : "text.secondary",
          letterSpacing: 0.5,
        }}
      >
        {verse === 0 ? "intro" : `v${verse}`}
      </Typography>
    </Stack>
  );
}

function SectionHead({
  title,
  count,
  pinned,
  onTogglePin,
  onAdd,
  sticky,
  hideAdd,
}: {
  title: string;
  count: number;
  pinned: boolean;
  onTogglePin: () => void;
  onAdd: () => void;
  sticky?: boolean;
  hideAdd?: boolean;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        pb: 0.25,
        mb: 0.25,
        borderBottom: "1px solid",
        borderColor: "divider",
        ...(sticky
          ? {
              position: "sticky",
              top: 0,
              bgcolor: "background.paper",
              zIndex: 2,
              pt: 0.25,
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
      <Tooltip
        title={pinned ? `unpin — show ${title.toLowerCase()} for the active verse only` : `pin — show ${title.toLowerCase()} for every verse in this chapter`}
      >
        <IconButton size="small" onClick={onTogglePin} sx={{ p: 0.25, color: pinned ? "primary.main" : "text.disabled" }}>
          {pinned ? <PushPinIcon fontSize="inherit" sx={{ fontSize: 16 }} /> : <PushPinOutlinedIcon fontSize="inherit" sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      <Box sx={{ flex: 1 }} />
      {hideAdd ? null : (
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
      )}
    </Stack>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, InputAdornment, Paper, Stack, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import TranslateIcon from "@mui/icons-material/Translate";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { TwlRow } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { CatalogPicker } from "./CatalogPicker";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";

export type WordDropPosition = "before" | "after";

// Mirrors the NoteCard quote-script detector: Hebrew (U+0590–U+05FF) is
// RTL, Greek + Latin are LTR. We only show the translate icon when the
// user has typed English (LTR) into a field that normally holds the
// source-language Hebrew/Greek.
const RTL_CHAR = /[֐-׿]/;
const LTR_CHAR = /[a-zA-ZͰ-Ͽἀ-῿]/;

type QuoteScript = "empty" | "rtl" | "ltr";

function detectQuoteScript(text: string): QuoteScript {
  if (!text.trim()) return "empty";
  if (RTL_CHAR.test(text)) return "rtl";
  if (LTR_CHAR.test(text)) return "ltr";
  return "empty";
}

interface Props {
  rows: TwlRow[];
  activeId: string | null;
  // Manual save: applies + enqueues. No autosave during typing.
  onSave: (id: string, patch: Partial<TwlRow>) => void;
  onDelete: (id: string) => void;
  onFocus: (row: TwlRow) => void;
  onReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  // Chapter has an active AI pipeline. Disables all interaction in this
  // table — TWLs aren't AI-touched, but locking the whole chapter is
  // simpler and avoids partial-edit confusion.
  locked?: boolean;
  // Translate English in the quote field to source-language text via ULT
  // alignment. Returns the derived Hebrew/Greek string, or null if no
  // alignment match was found. Mirrors the NoteCard wiring.
  onTranslateQuote?: (row: TwlRow, english: string) => string | null;
}

export function WordsTable({ rows, activeId, onSave, onDelete, onFocus, onReorder, locked = false, onTranslateQuote }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: WordDropPosition } | null
  >(null);

  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        no words for this verse
      </Typography>
    );
  }
  return (
    <Paper
      variant="outlined"
      sx={{
        overflow: "hidden",
        ...draftDirtyBorderSx(),
        ...(locked ? { pointerEvents: "none", opacity: 0.6 } : null),
      }}
    >
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "28px 1fr 1.2fr 28px 28px",
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
        <span />
        <span>Quote</span>
        <span>TW article</span>
        <span />
        <span />
      </Box>
      {rows.map((r) => {
        const showBefore =
          dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "before";
        const showAfter =
          dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "after";
        return (
          <Box key={r.id}>
            {showBefore && <RowDropIndicator />}
            <WordRow
              row={r}
              active={r.id === activeId}
              dragging={dragId === r.id}
              isDropTarget={dragId !== null && dragId !== r.id}
              onSave={(p) => onSave(r.id, p)}
              onDelete={() => onDelete(r.id)}
              onFocus={() => onFocus(r)}
              onGripDragStart={() => setDragId(r.id)}
              onDragEnd={() => {
                setDragId(null);
                setDragOver(null);
              }}
              onRowDragOver={(position) => {
                setDragOver((cur) =>
                  cur && cur.targetId === r.id && cur.position === position
                    ? cur
                    : { targetId: r.id, position },
                );
              }}
              onRowDrop={(position) => {
                if (dragId && dragId !== r.id) onReorder(dragId, r.id, position);
                setDragId(null);
                setDragOver(null);
              }}
              onTranslateQuote={
                onTranslateQuote ? (english) => onTranslateQuote(r, english) : undefined
              }
            />
            {showAfter && <RowDropIndicator />}
          </Box>
        );
      })}
    </Paper>
  );
}

function RowDropIndicator() {
  return (
    <Box
      sx={{
        height: 3,
        my: 0.25,
        bgcolor: "primary.main",
        borderRadius: 1,
        boxShadow: "0 0 4px rgba(49,173,227,0.5)",
      }}
    />
  );
}

function WordRow({
  row,
  active,
  dragging,
  isDropTarget,
  onSave,
  onDelete,
  onFocus,
  onGripDragStart,
  onDragEnd,
  onRowDragOver,
  onRowDrop,
  onTranslateQuote,
}: {
  row: TwlRow;
  active: boolean;
  dragging: boolean;
  isDropTarget: boolean;
  onSave: (patch: Partial<TwlRow>) => void;
  onDelete: () => void;
  onFocus: () => void;
  onGripDragStart: () => void;
  onDragEnd: () => void;
  onRowDragOver: (position: WordDropPosition) => void;
  onRowDrop: (position: WordDropPosition) => void;
  onTranslateQuote?: (english: string) => string | null;
}) {
  const [quote, setQuote] = useState(row.orig_words ?? "");
  const [twLink, setTwLink] = useState<string | null>(row.tw_link);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const catalogs = useCatalogs();

  useEffect(() => setQuote(row.orig_words ?? ""), [row.id, row.version, row.orig_words]);
  useEffect(() => setTwLink(row.tw_link), [row.id, row.version, row.tw_link]);

  const draftKey = useMemo(() => rowKey("twl", row.id), [row.id]);

  // Hydrate from any persisted draft on first mount so unsaved typing
  // survives navigation.
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(draftKey).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const patch = (rec?.payload as { patch?: Partial<TwlRow> } | undefined)?.patch;
      if (!patch) return;
      if (typeof patch.orig_words === "string") setQuote(patch.orig_words);
      if ("tw_link" in patch) setTwLink((patch.tw_link as string | null) ?? null);
    });
  }, [draftKey]);
  const diff = useMemo<Partial<TwlRow>>(() => {
    const out: Partial<TwlRow> = {};
    if (quote !== (row.orig_words ?? "")) out.orig_words = quote;
    if (twLink !== row.tw_link) out.tw_link = twLink;
    return out;
  }, [quote, twLink, row.orig_words, row.tw_link]);
  const isDirty = Object.keys(diff).length > 0;

  useEffect(() => {
    if (isDirty) {
      void drafts.set(draftKey, { patch: diff }, row.version, {
        kind: "row",
        rowKind: "twl",
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      void drafts.clear(draftKey);
    }
  }, [draftKey, isDirty, diff, row.version, row.id, row.book, row.chapter, row.verse]);

  const positionFromEvent = (e: React.DragEvent): WordDropPosition => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return "after";
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const quoteScript = detectQuoteScript(quote);
  const showTranslateIcon = quoteScript === "ltr" && !!onTranslateQuote;

  const handleTranslateQuote = () => {
    if (!onTranslateQuote || quoteScript !== "ltr") return;
    const result = onTranslateQuote(quote);
    if (result) {
      setQuote(result);
    }
  };

  const handleSave = () => {
    if (!isDirty) return;
    onSave(diff);
  };

  return (
    <Stack
      ref={rowRef}
      direction="row"
      spacing={1}
      data-word-id={row.id}
      onMouseDown={onFocus}
      onFocus={onFocus}
      onDragOver={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onRowDragOver(positionFromEvent(e));
      }}
      onDrop={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        onRowDrop(positionFromEvent(e));
      }}
      sx={{
        display: "grid",
        gridTemplateColumns: "28px 1fr 1.2fr 28px 28px",
        alignItems: "center",
        gap: 1,
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        bgcolor: active ? "primary.50" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--mui-palette-primary-main, #31ADE3)" : "none",
        opacity: dragging ? 0.4 : 1,
        transition: "opacity 120ms ease",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <Tooltip title="drag to reorder">
        <Box
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", row.id);
            if (rowRef.current) {
              e.dataTransfer.setDragImage(rowRef.current, 12, 12);
            }
            onGripDragStart();
          }}
          onDragEnd={onDragEnd}
          sx={{
            cursor: "grab",
            color: "text.disabled",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            "&:active": { cursor: "grabbing" },
          }}
        >
          <DragIndicatorIcon fontSize="small" />
        </Box>
      </Tooltip>
      <TextField
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
        size="small"
        variant="outlined"
        spellCheck={false}
        InputProps={{
          ...(isDirty ? { "data-dirty": "true" } : {}),
          endAdornment: showTranslateIcon ? (
            <InputAdornment position="end">
              <Tooltip title="translate to Hebrew/Greek using ULT alignment">
                <IconButton
                  size="small"
                  onClick={handleTranslateQuote}
                  sx={{ p: 0.25, color: "primary.main" }}
                >
                  <TranslateIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ) : undefined,
        }}
        inputProps={{
          dir: quoteScript === "ltr" ? "ltr" : "rtl",
          style: {
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
            fontSize: 19,
            padding: "3px 6px",
            textAlign: quoteScript === "ltr" ? "left" : "right",
          },
        }}
      />
      <CatalogPicker
        value={twLink}
        options={catalogs.twLinks}
        display={(v) => (v ? twShort(v) : "+ TW article")}
        placeholder="names/, kt/, other/, …"
        onChange={(next) => setTwLink(next)}
      />
      <Tooltip title={isDirty ? "save edits" : "no unsaved edits"}>
        <span>
          <IconButton
            size="small"
            disabled={!isDirty}
            onClick={handleSave}
            sx={{ p: 0.25, color: isDirty ? "primary.main" : "action.disabled" }}
          >
            {isDirty ? (
              <SaveIcon fontSize="inherit" />
            ) : (
              <SaveOutlinedIcon fontSize="inherit" />
            )}
          </IconButton>
        </span>
      </Tooltip>
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

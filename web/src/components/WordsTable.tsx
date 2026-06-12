import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, InputAdornment, Paper, Snackbar, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import TranslateIcon from "@mui/icons-material/Translate";
import UndoIcon from "@mui/icons-material/Undo";
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

// Container-query breakpoint: under this table width the quote + TW-article
// columns plus three action buttons get too cramped, so the layout reflows to
// keep the quote inline with the actions and drop the TW article to its own
// full-width row.
const NARROW_BP_PX = 460;

// Wide: grip, quote, TW article, and three action cells in one row. Narrow
// (container ≤ NARROW_BP_PX): the grip spans both rows on the left, the quote
// (the source words — the content that matters most) gets its own full-width
// row, and the short TW-article chip shares the second row with the action
// buttons. Keeping the quote off the button row stops the save/trash icons
// from crushing the Hebrew when the column is narrow.
const responsiveGridSx = {
  display: "grid",
  gap: 1,
  alignItems: "center",
  gridTemplateColumns: "28px 1fr 1.2fr 28px 28px 28px",
  gridTemplateAreas: '"grip quote twarticle save undo delete"',
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "28px 1fr 28px 28px 28px",
    gridTemplateAreas: [
      '"grip quote quote quote quote"',
      '"grip twarticle save undo delete"',
    ].join(" "),
    rowGap: 0.5,
  },
} as const;

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

function WordsTableInner({ rows, activeId, onSave, onDelete, onFocus, onReorder, locked = false, onTranslateQuote }: Props) {
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
        containerType: "inline-size",
        ...draftDirtyBorderSx(),
        ...(locked ? { pointerEvents: "none", opacity: 0.6 } : null),
      }}
    >
      <Box
        sx={{
          ...responsiveGridSx,
          px: 1,
          py: 0.5,
          bgcolor: "grey.50",
          fontFamily: "monospace",
          fontSize: 10,
          textTransform: "uppercase",
          color: "text.disabled",
          borderBottom: "1px dashed",
          borderColor: "divider",
          // The column labels don't map onto the stacked layout, so drop the
          // header band once the rows reflow.
          [`@container (max-width: ${NARROW_BP_PX}px)`]: { display: "none" },
        }}
      >
        <span />
        <span>Quote</span>
        <span>TW article</span>
        <span />
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

// Memoized: a change elsewhere in the resource column (e.g. editing a note)
// leaves `rows`/`activeId` referentially stable — twlForVerse is a useMemo in
// ResourceColumn — so the whole words table skips re-render. Callback props are
// recreated each parent render but are intentionally ignored.
export const WordsTable = memo(
  WordsTableInner,
  (a, b) => a.rows === b.rows && a.activeId === b.activeId && a.locked === b.locked,
);

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

const WordRow = memo(function WordRow({
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
  const [translateError, setTranslateError] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const savedRef = useRef({ quote: row.orig_words ?? "", twLink: row.tw_link });
  const catalogs = useCatalogs();

  useEffect(() => setQuote(row.orig_words ?? ""), [row.id, row.version, row.orig_words]);
  useEffect(() => setTwLink(row.tw_link), [row.id, row.version, row.tw_link]);
  useEffect(() => {
    savedRef.current = { quote: row.orig_words ?? "", twLink: row.tw_link };
  }, [row.id, row.version]);

  const draftKey = useMemo(() => rowKey("twl", row.book, row.id), [row.book, row.id]);

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
    } else {
      setTranslateError(true);
    }
  };

  const handleUndo = () => {
    setQuote(savedRef.current.quote);
    setTwLink(savedRef.current.twLink);
  };

  const handleSave = () => {
    if (!isDirty) return;
    onSave(diff);
  };

  return (
    <Box
      ref={rowRef}
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
        ...responsiveGridSx,
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
            gridArea: "grip",
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
        sx={{ gridArea: "quote" }}
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
      <Box sx={{ gridArea: "twarticle", minWidth: 0 }}>
        <CatalogPicker
          value={twLink}
          options={catalogs.twLinks}
          display={(v) => (v ? twShort(v) : "+ TW article")}
          placeholder="names/, kt/, other/, …"
          onChange={(next) => setTwLink(next)}
        />
      </Box>
      <Tooltip title={isDirty ? "save edits" : "no unsaved edits"}>
        <span style={{ gridArea: "save" }}>
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
      <Tooltip title={isDirty ? "undo edits" : ""}>
        <span style={{ gridArea: "undo" }}>
          <IconButton
            size="small"
            onClick={handleUndo}
            disabled={!isDirty}
            sx={{ p: 0.25, color: "text.secondary", opacity: isDirty ? 1 : 0, transition: "opacity 150ms" }}
          >
            <UndoIcon fontSize="inherit" />
          </IconButton>
        </span>
      </Tooltip>
      <IconButton
        size="small"
        onClick={onDelete}
        color="error"
        sx={{ p: 0.25, gridArea: "delete" }}
      >
        <DeleteOutlineIcon fontSize="inherit" />
      </IconButton>
      <Snackbar
        open={translateError}
        autoHideDuration={4000}
        onClose={() => setTranslateError(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setTranslateError(false)} sx={{ width: "100%" }}>
          No ULT alignment match for &ldquo;{quote}&rdquo; in this verse.
        </Alert>
      </Snackbar>
    </Box>
  );
}, (a, b) =>
  // Skip sibling word rows when the table re-renders (selection / add / delete).
  // row is referentially stable unless THIS word changed; callbacks ignored.
  a.row === b.row && a.active === b.active && a.dragging === b.dragging && a.isDropTarget === b.isDropTarget);

function twShort(link: string | null): string {
  if (!link) return "—";
  // rc://*/tw/dict/bible/names/moab → names/moab
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

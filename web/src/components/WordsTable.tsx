import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, InputAdornment, Paper, Snackbar, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import TranslateIcon from "@mui/icons-material/Translate";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import UndoIcon from "@mui/icons-material/Undo";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { TwlRow } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { CatalogPicker } from "./CatalogPicker";
import { TwArticleDialog } from "./TwArticleDialog";
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

// Transient ring on the arrow a word was just reordered with. Mouse clicks
// don't show a :focus-visible ring, so this is what signals "the word moved
// here, press Enter/Space to keep nudging it." Self-clears via WordsTable state.
const reorderFlashSx = {
  color: "primary.main",
  bgcolor: "primary.50",
  boxShadow: "0 0 0 2px var(--mui-palette-primary-main, #31ADE3)",
  borderRadius: "4px",
} as const;

// Wide: grip, quote, TW article, and three action cells in one row. Narrow
// (container ≤ NARROW_BP_PX): the grip spans both rows on the left, the quote
// (the source words — the content that matters most) gets its own full-width
// row, and the short TW-article chip shares the second row with the action
// buttons. Keeping the quote off the button row stops the save/trash icons
// from crushing the Hebrew when the column is narrow.
const responsiveGridSx = {
  display: "grid",
  columnGap: 1,
  rowGap: 0,
  // Controls share one single-height row; the English gloss is its own row
  // beneath (starting under the quote column) so it never stretches the row
  // and pushes the grip / action icons off-center.
  alignItems: "center",
  gridTemplateColumns: "28px 1fr 1.2fr 28px 28px 28px",
  gridTemplateAreas: [
    '"grip quote twarticle save undo delete"',
    '". gloss gloss gloss gloss gloss"',
  ].join(" "),
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "28px 1fr 28px 28px 28px",
    gridTemplateAreas: [
      '"grip quote quote quote quote"',
      '"grip twarticle save undo delete"',
      '". gloss gloss gloss gloss"',
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
  // Read-only English (ULT) gloss for a row's saved orig_words, derived from
  // alignment. "" when the quote doesn't resolve in the verse. Shell owns the
  // verse objects, so it computes the gloss (mirrors onTranslateQuote wiring).
  onWordGloss?: (row: TwlRow) => string;
  // Quote-builder ("build from source") wiring. Shell owns the picker popup +
  // selection state; the row just opens it. activeQuoteBuildId is the row whose
  // session is open (if any); the count drives that row's button label.
  activeQuoteBuildId?: string | null;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: (id: string) => void;
}

function WordsTableInner({ rows, activeId, onSave, onDelete, onFocus, onReorder, locked = false, onTranslateQuote, onWordGloss, activeQuoteBuildId = null, quoteBuildSelectionCount = 0, onStartQuoteBuild }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: WordDropPosition } | null
  >(null);
  // One TW article popup for the whole table (null = closed); lifted out of the
  // memoized rows so opening it doesn't depend on per-row state.
  const [articleId, setArticleId] = useState<string | null>(null);

  // Arrow-reorder focus + visible hint. React preserves the moved row's keyed
  // DOM node through the reorder, so focus already rides along (Enter/Space
  // repeats the move) — but a mouse click never shows a focus ring, so nobody
  // discovers it. After a reorder we re-assert focus on the moved word's arrow
  // and flash a ring on it so the user sees where the word went and that they
  // can keep nudging it from the keyboard.
  const tableRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<{ id: string; dir: "up" | "down" } | null>(null);
  const [recentMove, setRecentMove] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const root = tableRef.current;
    if (!root) return;
    const find = (d: "up" | "down") =>
      root.querySelector<HTMLButtonElement>(
        `[data-word-id="${pending.id}"] [data-reorder-arrow="${d}"]`,
      );
    // If the word landed at an edge its same-direction arrow is now disabled;
    // fall back to the opposite arrow so focus + the hint still land on the row.
    let btn = find(pending.dir);
    let dir = pending.dir;
    if (!btn || btn.disabled) {
      const alt = pending.dir === "up" ? "down" : "up";
      const b2 = find(alt);
      if (b2 && !b2.disabled) {
        btn = b2;
        dir = alt;
      }
    }
    if (!btn) return;
    btn.focus();
    setRecentMove({ id: pending.id, dir });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setRecentMove(null), 1600);
  });
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        no words for this verse
      </Typography>
    );
  }
  return (
    <Paper
      ref={tableRef}
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
        // Arrows reorder within the same verse only — onReorder maps to Shell's
        // sortedForVerse, which renumbers per-verse.
        const samePeers = rows.filter((p) => p.verse === r.verse);
        const idx = samePeers.indexOf(r);
        const prevWord = idx > 0 ? samePeers[idx - 1] : null;
        const nextWord = idx < samePeers.length - 1 ? samePeers[idx + 1] : null;
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
              onMoveUp={
                prevWord
                  ? () => {
                      pendingFocusRef.current = { id: r.id, dir: "up" };
                      onReorder(r.id, prevWord.id, "before");
                    }
                  : undefined
              }
              onMoveDown={
                nextWord
                  ? () => {
                      pendingFocusRef.current = { id: r.id, dir: "down" };
                      onReorder(r.id, nextWord.id, "after");
                    }
                  : undefined
              }
              flashArrow={recentMove?.id === r.id ? recentMove.dir : null}
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
              gloss={onWordGloss ? onWordGloss(r) : ""}
              quoteBuildMode={r.id === activeQuoteBuildId}
              quoteBuildSelectionCount={r.id === activeQuoteBuildId ? quoteBuildSelectionCount : 0}
              onStartQuoteBuild={onStartQuoteBuild ? () => onStartQuoteBuild(r.id) : undefined}
              onOpenArticle={setArticleId}
            />
            {showAfter && <RowDropIndicator />}
          </Box>
        );
      })}
      <TwArticleDialog articleId={articleId} onClose={() => setArticleId(null)} />
    </Paper>
  );
}

// Memoized: a change elsewhere in the resource column (e.g. editing a note)
// leaves `rows`/`activeId` referentially stable — twlForVerse is a useMemo in
// ResourceColumn — so the whole words table skips re-render. Callback props are
// recreated each parent render but are intentionally ignored.
export const WordsTable = memo(
  WordsTableInner,
  (a, b) =>
    a.rows === b.rows &&
    a.activeId === b.activeId &&
    a.locked === b.locked &&
    a.activeQuoteBuildId === b.activeQuoteBuildId &&
    a.quoteBuildSelectionCount === b.quoteBuildSelectionCount,
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
  onMoveUp,
  onMoveDown,
  onDragEnd,
  onRowDragOver,
  onRowDrop,
  onTranslateQuote,
  gloss,
  quoteBuildMode = false,
  quoteBuildSelectionCount = 0,
  onStartQuoteBuild,
  onOpenArticle,
  flashArrow,
}: {
  row: TwlRow;
  active: boolean;
  dragging: boolean;
  isDropTarget: boolean;
  onSave: (patch: Partial<TwlRow>) => void;
  onDelete: () => void;
  onFocus: () => void;
  onGripDragStart: () => void;
  // Reorder one slot within the verse. Undefined when already first/last.
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  // The just-reordered arrow to flash a focus ring on ("up"/"down"), or null.
  flashArrow?: "up" | "down" | null;
  onDragEnd: () => void;
  onRowDragOver: (position: WordDropPosition) => void;
  onRowDrop: (position: WordDropPosition) => void;
  onTranslateQuote?: (english: string) => string | null;
  // Read-only English (ULT) gloss of the saved orig_words; "" when unresolved.
  gloss?: string;
  // "Build from source" picker wiring (Shell owns the popup + selection state).
  quoteBuildMode?: boolean;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: () => void;
  // Open the TW article popup for this row's link (handled at the table level).
  onOpenArticle: (articleId: string) => void;
}) {
  const [quote, setQuote] = useState(row.orig_words ?? "");
  const [twLink, setTwLink] = useState<string | null>(row.tw_link);
  // Occurrence is hidden in the schema but real (round-trips to the TSV
  // Occurrence column). Display null/0 as 1 — the export coerces an OL quote's
  // null occurrence to 1, so 1 and null are equivalent on disk and must not
  // count as a dirty edit.
  const [occurrence, setOccurrence] = useState(row.occurrence ?? 1);
  const [translateError, setTranslateError] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const savedRef = useRef({ quote: row.orig_words ?? "", twLink: row.tw_link, occurrence: row.occurrence ?? 1 });
  const catalogs = useCatalogs();

  useEffect(() => setQuote(row.orig_words ?? ""), [row.id, row.version, row.orig_words]);
  useEffect(() => setTwLink(row.tw_link), [row.id, row.version, row.tw_link]);
  useEffect(() => setOccurrence(row.occurrence ?? 1), [row.id, row.version, row.occurrence]);
  useEffect(() => {
    savedRef.current = { quote: row.orig_words ?? "", twLink: row.tw_link, occurrence: row.occurrence ?? 1 };
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
      if (typeof patch.occurrence === "number") setOccurrence(patch.occurrence);
    });
  }, [draftKey]);
  const diff = useMemo<Partial<TwlRow>>(() => {
    const out: Partial<TwlRow> = {};
    if (quote !== (row.orig_words ?? "")) out.orig_words = quote;
    if (twLink !== row.tw_link) out.tw_link = twLink;
    // null/0 stored occurrence is equivalent to 1 for an OL quote (see export
    // coercion), so only a real numeric change counts as dirty.
    if (occurrence !== (row.occurrence ?? 1)) out.occurrence = occurrence;
    return out;
  }, [quote, twLink, occurrence, row.orig_words, row.tw_link, row.occurrence]);
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
    setOccurrence(savedRef.current.occurrence);
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
      <Box
        sx={{
          gridArea: "grip",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Tooltip title="move up">
          <span>
            <IconButton
              size="small"
              data-reorder-arrow="up"
              onClick={onMoveUp}
              disabled={!onMoveUp}
              sx={{ p: 0, color: "text.disabled", ...(flashArrow === "up" ? reorderFlashSx : null) }}
            >
              <ArrowUpwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
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
        <Tooltip title="move down">
          <span>
            <IconButton
              size="small"
              data-reorder-arrow="down"
              onClick={onMoveDown}
              disabled={!onMoveDown}
              sx={{ p: 0, color: "text.disabled", ...(flashArrow === "down" ? reorderFlashSx : null) }}
            >
              <ArrowDownwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box sx={{ gridArea: "quote", minWidth: 0, display: "flex", gap: 0.5, alignItems: "center" }}>
        <TextField
          value={quote}
          onChange={(e) => setQuote(e.target.value)}
          size="small"
          variant="outlined"
          spellCheck={false}
          // Shared fixed height keeps the quote box and the occurrence box the
          // same height; InputBase centers the input within it.
          sx={{ flex: 1, minWidth: 0, "& .MuiOutlinedInput-root": { height: 34 } }}
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
              padding: "0 6px",
              textAlign: quoteScript === "ltr" ? "left" : "right",
            },
          }}
        />
        <Tooltip title="occurrence — which instance of this quote in the verse (usually 1)">
          <TextField
            value={occurrence}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setOccurrence(Number.isFinite(n) && n > 0 ? n : 1);
            }}
            size="small"
            variant="outlined"
            type="number"
            sx={{ width: 52, flexShrink: 0, "& .MuiOutlinedInput-root": { height: 34 } }}
            inputProps={{
              min: 1,
              "aria-label": "occurrence",
              style: { fontSize: 13, padding: "0 4px", textAlign: "center" },
            }}
          />
        </Tooltip>
        {onStartQuoteBuild && (
          <Tooltip
            title={
              quoteBuildMode
                ? `picker open · ${quoteBuildSelectionCount} selected — click ULT/UST or Hebrew words`
                : "build the Hebrew/Greek quote by picking aligned words"
            }
          >
            <IconButton
              size="small"
              onClick={onStartQuoteBuild}
              sx={{
                p: 0.25,
                flexShrink: 0,
                color: quoteBuildMode ? "primary.main" : "text.secondary",
              }}
            >
              <AutoFixHighIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      {gloss ? (
        <Tooltip title="ULT words aligned to this quote (read-only)">
          <Typography
            variant="caption"
            sx={{
              gridArea: "gloss",
              color: "text.secondary",
              fontStyle: "italic",
              lineHeight: 1.3,
              pb: "2px",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {gloss}
          </Typography>
        </Tooltip>
      ) : null}
      <Box sx={{ gridArea: "twarticle", minWidth: 0, display: "flex", alignItems: "center", gap: 0.5 }}>
        <CatalogPicker
          value={twLink}
          options={catalogs.twLinks}
          display={(v) => (v ? twShort(v) : "+ TW article")}
          placeholder="names/, kt/, other/, …"
          onChange={(next) => setTwLink(next)}
        />
        {twLink && (
          <Tooltip title="read article">
            <IconButton
              size="small"
              onClick={() => onOpenArticle(twLink)}
              sx={{ p: 0.25, color: "text.secondary", flexShrink: 0 }}
            >
              <OpenInNewIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        )}
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
  // gloss is compared so a re-derived English gloss (e.g. after a realign) lands.
  a.row === b.row &&
  a.active === b.active &&
  a.dragging === b.dragging &&
  a.isDropTarget === b.isDropTarget &&
  !!a.onMoveUp === !!b.onMoveUp &&
  !!a.onMoveDown === !!b.onMoveDown &&
  a.gloss === b.gloss &&
  a.quoteBuildMode === b.quoteBuildMode &&
  a.quoteBuildSelectionCount === b.quoteBuildSelectionCount);

function twShort(link: string | null): string {
  if (!link) return "—";
  // rc://*/tw/dict/bible/names/moab → names/moab
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Chip, InputAdornment, ListItemText, Menu, MenuItem, Paper, Snackbar, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
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
import {
  baselineFromDraft,
  rebaseRowBaseline,
  activeSaveBasis,
  nextSaveBasis,
  resyncLocalFields,
  rowFieldDiff,
  saveGateClosed,
  type RowBaseline,
  type SaveBasis,
} from "../sync/rowEditBaseline";
import { useQueuedRowEdits } from "../hooks/useQueuedRowEdits";
import { directionForText } from "../lib/direction";

// The fields a word-link row edits, as its inputs hold them. A null/0 stored
// occurrence shows as 1: the export coerces an OL quote's null occurrence to
// 1, so 1 and null are equivalent on disk and must not count as an edit.
type TwlFields = { orig_words: string; tw_link: string | null; occurrence: number };
const twlFields = (row: TwlRow): TwlFields => ({
  orig_words: row.orig_words ?? "",
  tw_link: row.tw_link,
  occurrence: row.occurrence ?? 1,
});

export type WordDropPosition = "before" | "after";

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
  // minmax(0, …) on the flexible tracks: a bare `fr` track has a min-content
  // floor, so the TW-article chip's long unbreakable monospace label (e.g.
  // `other/generation-lifetime`) would refuse to shrink and overflow into the
  // save/undo/delete cells. minmax(0, …) lets the track collapse so the chip
  // ellipsis-truncates instead.
  gridTemplateColumns: "28px minmax(0, 1fr) minmax(0, 1.2fr) 28px 28px 28px",
  gridTemplateAreas: [
    '"grip quote twarticle save undo delete"',
    '". gloss gloss gloss gloss gloss"',
  ].join(" "),
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "28px minmax(0, 1fr) 28px 28px 28px",
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
  onSave: (id: string, patch: Partial<TwlRow>, opts?: { basis?: { version: number; fields: Record<string, unknown> } }) => void;
  onDelete: (id: string) => void;
  // Put the last saved values back into the cached row (no PATCH). Undo uses
  // it: a save the server refused left its values in the cache (#1115).
  onRevert?: (id: string, patch: Partial<TwlRow>) => void;
  onFocus: (row: TwlRow) => void;
  onReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  // Reorder stoplight, same as the notes: hovering a row's grip/arrows (or
  // dragging it, or moving it with an arrow) lights the moved link's word plus
  // the neighbours it would land between. Structurally typed rather than
  // importing ResourceColumn's ReorderPreview — ResourceColumn imports THIS
  // file, so the type import would be circular. `sticky` previews linger after
  // an arrow move; hover/drag previews clear on leave.
  onReorderPreview?: (
    preview: { verse: number; movedId: string; prevId: string | null; nextId: string | null } | null,
    sticky?: boolean,
  ) => void;
  // The table is showing a PROPOSED order (the "automatic order differs"
  // preview), so interaction is off: a drag here would renumber a sequence the
  // user is only looking at, not the one they own. Deliberately NOT the old
  // chapter-lock prop, which was removed when pipeline locks became
  // per-resource — no pipeline writes twl_rows, so an AI run never locks word
  // links (see api/src/chapterLock.ts).
  readOnly?: boolean;
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
  // Extra TW article ids the per-verse matcher proposes for a row's source word,
  // keyed by row id — merged into that row's disambiguation badge so a wrong
  // link can reach a morphologically-correct alternative (e.g. other/lover for
  // "lovers"). A stable useMemo ref from Shell, so the memo below can compare it.
  suggestionAlternatives?: Map<string, string[]>;
  // Verse-reference picker, mirroring NoteCard's "change reference" dropdown.
  // Only populated (length > 1) when the visible unit is a verse BRIDGE — the
  // verses it spans — so a link scanned/added under the leading verse can be
  // reassigned to the one it actually belongs to. Empty/absent in the ordinary
  // single-verse case, which keeps the dense word rows uncluttered. A stable
  // useMemo ref from ResourceColumn so the memo below can compare it.
  verseOptions?: number[];
  onChangeVerse?: (id: string, verse: number) => void;
}

// The manual reorder gesture (drag grip + up/down arrows) was disabled for a
// while behind an ENABLE_TWL_MANUAL_REORDER kill-switch: TWL links are ordered
// automatically from the ULT alignment (see ../lib/twlCanonicalOrder), so a
// manual move used to be recomputed away on the next export or reimport. It is
// back now that the two can coexist: reordering a verse LOCKS it, and automatic
// ordering skips locked verses on every surface. See Shell's onWordReorder for
// the lock-then-move sequence, and twlDisplayOrder for the display split.

function WordsTableInner({ rows, activeId, onSave, onDelete, onRevert, onFocus, onReorder, onReorderPreview, readOnly = false, onTranslateQuote, onWordGloss, activeQuoteBuildId = null, quoteBuildSelectionCount = 0, onStartQuoteBuild, suggestionAlternatives, verseOptions, onChangeVerse }: Props) {
  const queuedEdits = useQueuedRowEdits("twl");
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
  // Deliberately no dependency array — mirrors ResourceColumn's note-focus
  // effect: this polls pendingFocusRef, set synchronously by an arrow-key
  // handler outside any tracked dependency, and the early-return guard makes
  // every run a no-op unless that handler just fired. `[]` would only run
  // this once at mount and miss every later arrow-key move.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const btn = find(pending.dir);
    // Reached the top/bottom: the arrow we were moving with is now disabled.
    // Don't hop focus to the opposite arrow — that turns repeated Space into an
    // endless up-to-top-then-down-to-bottom loop. Drop focus instead so the run
    // simply stops at the edge.
    if (!btn || btn.disabled) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    btn.focus();
    setRecentMove({ id: pending.id, dir: pending.dir });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setRecentMove(null), 1600);
  });
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // Preview mode must be read-only to the KEYBOARD too. `pointerEvents: none`
  // (below) only stops the mouse — the rows stay in the tab order, so a
  // keyboard user could Tab into a proposed order and save, delete, or arrow-
  // reorder against a sequence they never chose, from a panel that says
  // "nothing saved". `inert` takes the whole subtree out of focus AND hit
  // testing. Set through the ref because React 18 doesn't forward `inert` as a
  // JSX prop (React 19 does); pointerEvents stays as the fallback for browsers
  // without inert support.
  useEffect(() => {
    const el = tableRef.current;
    if (el) el.inert = readOnly;
  }, [readOnly]);

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
        // Preview only: the rows shown are a proposal, so nothing here may be
        // dragged, typed into, or deleted — a write would apply to a sequence
        // the user never chose. ResourceColumn also greys the whole block.
        ...(readOnly ? { pointerEvents: "none" } : null),
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
              onSave={(p, opts) => onSave(r.id, p, opts)}
              onDelete={() => onDelete(r.id)}
              onRevert={onRevert ? (p) => onRevert(r.id, p) : undefined}
              queued={queuedEdits.ids.has(r.id)}
              outboxSeq={queuedEdits.seq}
              onFocus={() => onFocus(r)}
              onGripDragStart={() => setDragId(r.id)}
              onMoveUp={
                prevWord
                  ? () => {
                      pendingFocusRef.current = { id: r.id, dir: "up" };
                      onReorder(r.id, prevWord.id, "before");
                      // Sticky: an arrow move is momentary, so the stoplight
                      // lingers to show where the link went. The neighbours are
                      // the ones it lands BETWEEN after the move — i.e. the row
                      // above the one it displaced.
                      onReorderPreview?.(
                        {
                          verse: r.verse,
                          movedId: r.id,
                          prevId: samePeers[idx - 2]?.id ?? null,
                          nextId: prevWord.id,
                        },
                        true,
                      );
                    }
                  : undefined
              }
              onMoveDown={
                nextWord
                  ? () => {
                      pendingFocusRef.current = { id: r.id, dir: "down" };
                      onReorder(r.id, nextWord.id, "after");
                      onReorderPreview?.(
                        {
                          verse: r.verse,
                          movedId: r.id,
                          prevId: nextWord.id,
                          nextId: samePeers[idx + 2]?.id ?? null,
                        },
                        true,
                      );
                    }
                  : undefined
              }
              onReorderHover={(entering) =>
                onReorderPreview?.(
                  entering
                    ? {
                        verse: r.verse,
                        movedId: r.id,
                        prevId: prevWord?.id ?? null,
                        nextId: nextWord?.id ?? null,
                      }
                    : null,
                  false,
                )
              }
              flashArrow={recentMove?.id === r.id ? recentMove.dir : null}
              onDragEnd={() => {
                setDragId(null);
                setDragOver(null);
                onReorderPreview?.(null, false);
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
                onReorderPreview?.(null, false);
              }}
              onTranslateQuote={
                onTranslateQuote ? (english) => onTranslateQuote(r, english) : undefined
              }
              gloss={onWordGloss ? onWordGloss(r) : ""}
              quoteBuildMode={r.id === activeQuoteBuildId}
              quoteBuildSelectionCount={r.id === activeQuoteBuildId ? quoteBuildSelectionCount : 0}
              onStartQuoteBuild={onStartQuoteBuild ? () => onStartQuoteBuild(r.id) : undefined}
              onOpenArticle={setArticleId}
              suggestionAltIds={(suggestionAlternatives?.get(r.id) ?? []).join(",")}
              verseOptions={verseOptions}
              onChangeVerse={onChangeVerse ? (v) => onChangeVerse(r.id, v) : undefined}
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
    // Toggling the preview changes only this flag on an otherwise identical
    // render; without it the table would keep its interactive state.
    a.readOnly === b.readOnly &&
    a.activeQuoteBuildId === b.activeQuoteBuildId &&
    a.quoteBuildSelectionCount === b.quoteBuildSelectionCount &&
    a.suggestionAlternatives === b.suggestionAlternatives &&
    // Referentially stable from ResourceColumn (useMemo), so entering/leaving a
    // bridge — which flips the ref-picker on/off — flows through this compare.
    a.verseOptions === b.verseOptions,
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
  onRevert,
  queued,
  outboxSeq,
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
  onReorderHover,
  suggestionAltIds = "",
  verseOptions,
  onChangeVerse,
}: {
  row: TwlRow;
  active: boolean;
  dragging: boolean;
  isDropTarget: boolean;
  onSave: (patch: Partial<TwlRow>, opts?: { basis?: { version: number; fields: Record<string, unknown> } }) => void;
  onDelete: () => void;
  onRevert?: (patch: Partial<TwlRow>) => void;
  // An edit save of this row is still in the outbox; and the count of outbox
  // snapshots seen (useQueuedRowEdits), for the Save/Undo gate.
  queued: boolean;
  outboxSeq: number;
  onFocus: () => void;
  onGripDragStart?: () => void;
  // Reorder one slot within the verse. Undefined when already first/last.
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  // The just-reordered arrow to flash a focus ring on ("up"/"down"), or null.
  flashArrow?: "up" | "down" | null;
  // Entering/leaving the reorder controls (grip + both arrows) as one unit —
  // drives the scripture stoplight. Same contract as NoteCard's prop of this
  // name, so the two behave identically.
  onReorderHover?: (entering: boolean) => void;
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
  // Comma-joined short article ids the matcher proposes for this row's source
  // word, merged into the disambiguation badge. "" when none.
  suggestionAltIds?: string;
  // Verse-bridge reference picker (see the table-level prop). The verses this
  // bridge spans; the callback retargets THIS link to the chosen verse. The
  // chip only shows when there is a real choice (length > 1).
  verseOptions?: number[];
  onChangeVerse?: (verse: number) => void;
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
  // #1115: the last server-confirmed values, pinned to row.version (see
  // rowEditBaseline.ts). Shell's optimistic apply puts our saved values into
  // the cached row at the SAME version, so a save the server refuses or the
  // user discards would read as saved if we diffed against `row`. Rebased
  // during render (like NoteCard's savedRef) so the diff below reads it in
  // this same render.
  const baselineRef = useRef<RowBaseline<TwlFields> | null>(null);
  baselineRef.current = rebaseRowBaseline(baselineRef.current, twlFields(row), row.version);
  const base = baselineRef.current.fields;
  const rowVersionRef = useRef(row.version);
  rowVersionRef.current = row.version;
  const catalogs = useCatalogs();

  // Alternative articles for the current link, from two sources unioned by link:
  //  1. Heading-synonym siblings of the current link (e.g. kt/call-* ) — the
  //     variant-blind global groups built from article titles.
  //  2. The per-verse matcher's candidates for this row's source word — surfaces
  //     morphologically-correct articles the heading grouping can't reach (e.g.
  //     other/lover for "lovers" on a row wrongly linked to kt/love).
  // Drives the "this word has alternatives" badge + scoped picker.
  const disambig = useMemo(() => {
    const byLink = new Map<string, { link: string; title: string }>();
    if (twLink) {
      const idx = catalogs.disambiguationIndex?.[twLink];
      if (idx != null) {
        const group = catalogs.disambiguationGroups?.[idx];
        if (group) for (const o of group) byLink.set(o.link, o);
      }
    }
    for (const id of suggestionAltIds ? suggestionAltIds.split(",") : []) {
      if (!id) continue;
      const link = `rc://*/tw/dict/bible/${id}`;
      if (!byLink.has(link)) byLink.set(link, { link, title: "" });
    }
    // Ensure the current link is an option (shown selected) even when it only
    // came in via suggestions and has no heading group.
    if (byLink.size > 0 && twLink && !byLink.has(twLink)) {
      byLink.set(twLink, { link: twLink, title: "" });
    }
    const list = [...byLink.values()];
    return list.length > 1 ? list : null;
  }, [twLink, catalogs.disambiguationIndex, catalogs.disambiguationGroups, suggestionAltIds]);
  const [disambigAnchor, setDisambigAnchor] = useState<HTMLElement | null>(null);
  // Reference (verse) picker anchor — opened from the ref_raw chip. Only ever
  // shown in a verse bridge (verseOptions.length > 1), so a link can be moved to
  // the verse it belongs to. Unlike NoteCard there is no "span" mode: a word
  // link points at one verse's original-language occurrence, never a range.
  const [refMenuAnchor, setRefMenuAnchor] = useState<HTMLElement | null>(null);
  const showRefPicker = !!onChangeVerse && (verseOptions?.length ?? 0) > 1;

  const localFields: TwlFields = { orig_words: quote, tw_link: twLink, occurrence };
  const diff: Partial<TwlRow> = rowFieldDiff(localFields, base);
  // Set when the server changed a field this row holds unsaved typing in (see
  // SaveBasis): the next save is sent against the version the user typed
  // against, so it 409s into the outbox's conflict prompt instead of silently
  // overwriting the other edit. Dropped once no conflicting field is dirty.
  const basisRef = useRef<SaveBasis<TwlFields> | null>(null);
  basisRef.current = activeSaveBasis(basisRef.current, localFields, base);
  const isDirty = Object.keys(diff).length > 0;

  // Save/Undo gate (#1115 review): off while a save of this row is queued, in
  // flight or in conflict, so Undo cannot be overtaken by the save landing and
  // a double click cannot send two PATCHes. Reopens on a refusal or discard.
  const [clickedAtSeq, setClickedAtSeq] = useState<number | null>(null);
  const saving = saveGateClosed({ queued, clickedAtSeq, seq: outboxSeq });

  // Resync from the cached row, field by field (resyncLocalFields): a field
  // with unsaved edits keeps them through any change — a new version (a 200,
  // a WS upsert, a reimport, the row's own reorder landing) or a same-version
  // refetch — and still reads unsaved against the rebased baseline; every
  // other field follows the row (including a "build from source" quote
  // applied to the cache). `syncBaseRef` is the baseline the fields were
  // compared against before this change (the render already rebased it).
  const syncBaseRef = useRef<RowBaseline<TwlFields> | null>(null);
  useEffect(() => {
    const prev = syncBaseRef.current ?? baselineRef.current!;
    syncBaseRef.current = baselineRef.current;
    const rowFields = twlFields(row);
    if (prev.version !== row.version) {
      basisRef.current = nextSaveBasis(basisRef.current, {
        local: localFields,
        prevBase: prev.fields,
        prevVersion: prev.version,
        row: rowFields,
      });
    }
    const next = resyncLocalFields(localFields, prev.fields, rowFields);
    setQuote(next.orig_words);
    setTwLink(next.tw_link);
    setOccurrence(next.occurrence);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.version, row.orig_words, row.tw_link, row.occurrence]);

  const draftKey = useMemo(() => rowKey("twl", row.book, row.id), [row.book, row.id]);

  // Hydrate from any persisted draft on first mount so unsaved typing
  // survives navigation. The draft also carries the baseline it was diffed
  // against: a remount over a cache still holding a refused save's values
  // would otherwise take them as the saved state (#1115). `hydrated` is
  // state so the restored baseline reaches the screen even when the draft's
  // values equal what the fields already show, and so the draft-write effect
  // cannot clear the draft before it has been read (NoteCard does the same).
  const [hydrated, setHydrated] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    drafts.get(draftKey).then(
      (rec) => {
        if (hydratedFromDraftRef.current) return;
        hydratedFromDraftRef.current = true;
        const restored = baselineFromDraft<TwlFields>(rec?.payload, rec?.expectedVersion, rowVersionRef.current);
        if (restored) {
          baselineRef.current = restored;
          syncBaseRef.current = restored;
          const saved = (rec?.payload as { conflictBasis?: SaveBasis<TwlFields> } | undefined)?.conflictBasis;
          if (saved && typeof saved.version === "number" && Array.isArray(saved.conflict)) basisRef.current = saved;
        }
        const patch = (rec?.payload as { patch?: Partial<TwlRow> } | undefined)?.patch;
        if (patch) {
          if (typeof patch.orig_words === "string") setQuote(patch.orig_words);
          if ("tw_link" in patch) setTwLink((patch.tw_link as string | null) ?? null);
          if (typeof patch.occurrence === "number") setOccurrence(patch.occurrence);
        }
        setHydrated(true);
      },
      () => {
        // A failed read restores nothing; the row falls back to the cache.
        if (hydratedFromDraftRef.current) return;
        hydratedFromDraftRef.current = true;
        setHydrated(true);
      },
    );
  }, [draftKey]);

  // Keyed on the edited values, not the cached row: the optimistic apply of
  // a save must not mint a new draft generation, or the save's 200 would
  // leave the draft behind (drafts.rowSaveGeneration).
  useEffect(() => {
    if (isDirty) {
      const b = baselineRef.current!;
      void drafts.set(draftKey, { patch: diff, baseline: b.fields, ...(basisRef.current ? { conflictBasis: basisRef.current } : {}) }, b.version, {
        kind: "row",
        rowKind: "twl",
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else if (hydrated) {
      void drafts.clear(draftKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, isDirty, quote, twLink, occurrence, row.version, row.id, row.book, row.chapter, row.verse, hydrated]);

  const positionFromEvent = (e: React.DragEvent): WordDropPosition => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return "after";
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const quoteScript = directionForText(quote);
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

  // Discard unsaved edits: back to the last saved values, on screen and in
  // the cached row (a refused save left its values there), and drop the draft.
  const handleUndo = () => {
    if (saving) return;
    basisRef.current = null;
    setQuote(base.orig_words);
    setTwLink(base.tw_link);
    setOccurrence(base.occurrence);
    void drafts.clear(draftKey);
    const revert = rowFieldDiff(base, twlFields(row));
    if (Object.keys(revert).length > 0) onRevert?.(revert);
  };

  const handleSave = () => {
    if (!isDirty || saving) return;
    setClickedAtSeq(outboxSeq);
    const basis = basisRef.current;
    onSave(diff, basis ? { basis: { version: basis.version, fields: basis.fields } } : undefined);
  };

  // A field edited back to its saved value by hand: put the saved value back
  // into the cached row too, which may still hold a refused save's value, or
  // a remount would take that value as saved (#1115 review). Not while a save
  // is queued: the cache then holds what that save is sending.
  const editField = <K extends keyof TwlFields>(k: K, v: TwlFields[K], set: (v: TwlFields[K]) => void) => {
    set(v);
    if (!saving && v === base[k] && twlFields(row)[k] !== base[k]) {
      onRevert?.({ [k]: base[k] } as Partial<TwlRow>);
    }
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
        {/* Manual reorder controls. Hovering ANY of them (grip or either arrow)
            previews the move in the scripture: this link's word plus the two it
            would land between. Same gesture and same stoplight as the notes —
            NoteCard.tsx wraps its grip+arrows in an identical hover Box. The
            first use of these controls takes the verse manual (see Shell's
            onWordReorder), after which automatic ordering leaves it alone. */}
        <Box
          onMouseEnter={onReorderHover ? () => onReorderHover(true) : undefined}
          onMouseLeave={onReorderHover ? () => onReorderHover(false) : undefined}
          sx={{ display: "flex", flexDirection: "column", alignItems: "center" }}
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
                  onGripDragStart?.();
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
      </Box>
      <Box sx={{ gridArea: "quote", minWidth: 0, display: "flex", gap: 0.5, alignItems: "center" }}>
        <TextField
          value={quote}
          onChange={(e) => editField("orig_words", e.target.value, setQuote)}
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
              editField("occurrence", Number.isFinite(n) && n > 0 ? n : 1, setOccurrence);
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
      {showRefPicker || gloss ? (
        <Box
          sx={{
            gridArea: "gloss",
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            pb: "2px",
          }}
        >
          {showRefPicker && (
            <Tooltip title="change reference — which verse of this bridge the link belongs to">
              <Chip
                label={row.ref_raw}
                size="small"
                variant="outlined"
                clickable
                deleteIcon={<ArrowDropDownIcon />}
                onDelete={(e) => {
                  e.stopPropagation();
                  setRefMenuAnchor(e.currentTarget.parentElement as HTMLElement);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setRefMenuAnchor(e.currentTarget);
                }}
                sx={{ flexShrink: 0, fontFamily: "monospace", fontSize: 11, height: 24, color: "text.secondary" }}
              />
            </Tooltip>
          )}
          {gloss ? (
            <Tooltip title="ULT words aligned to this quote (read-only)">
              <Typography
                variant="caption"
                sx={{
                  minWidth: 0,
                  color: "text.secondary",
                  fontStyle: "italic",
                  lineHeight: 1.3,
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {gloss}
              </Typography>
            </Tooltip>
          ) : null}
        </Box>
      ) : null}
      <Menu
        anchorEl={refMenuAnchor}
        open={Boolean(refMenuAnchor)}
        onClose={() => setRefMenuAnchor(null)}
        slotProps={{ paper: { sx: { maxHeight: 320 } } }}
      >
        {(verseOptions ?? []).map((v) => (
          <MenuItem
            key={v}
            selected={v === row.verse}
            onClick={() => {
              setRefMenuAnchor(null);
              if (v !== row.verse) onChangeVerse?.(v);
            }}
          >
            {v === 0 ? "intro" : `v${v}`}
          </MenuItem>
        ))}
      </Menu>
      <Box sx={{ gridArea: "twarticle", minWidth: 0, display: "flex", alignItems: "center", gap: 0.5 }}>
        {/* 4-char sticky ID (DCS convention). A tiny monospace tag at the head
            of the article cell — the picker label truncates, so this shows the
            id without adding a column or growing the row. */}
        <Tooltip title="Word link ID">
          <Typography
            component="span"
            sx={{
              fontFamily: "monospace",
              fontSize: 10,
              lineHeight: 1,
              color: "text.disabled",
              flexShrink: 0,
            }}
          >
            {row.id}
          </Typography>
        </Tooltip>
        <CatalogPicker
          value={twLink}
          options={catalogs.twLinks}
          display={(v) => (v ? twShort(v) : "+ TW article")}
          placeholder="names/, kt/, other/, …"
          onChange={(next) => editField("tw_link", next, setTwLink)}
        />
        {disambig && (
          <>
            <Tooltip
              title={`This word has ${disambig.length} Translation Words articles — click to choose the right one`}
            >
              <Chip
                size="small"
                icon={<AltRouteIcon sx={{ fontSize: 13 }} />}
                label={disambig.length}
                color="warning"
                variant="outlined"
                onClick={(e) => setDisambigAnchor(e.currentTarget)}
                sx={{ height: 24, cursor: "pointer", flexShrink: 0, "& .MuiChip-label": { px: 0.5, fontSize: 11 } }}
              />
            </Tooltip>
            <Menu
              anchorEl={disambigAnchor}
              open={!!disambigAnchor}
              onClose={() => setDisambigAnchor(null)}
              MenuListProps={{ dense: true }}
            >
              {disambig.map((opt) => (
                <MenuItem
                  key={opt.link}
                  selected={opt.link === twLink}
                  onClick={() => {
                    setTwLink(opt.link);
                    setDisambigAnchor(null);
                  }}
                  sx={{ maxWidth: 360 }}
                >
                  <ListItemText
                    primary={twShort(opt.link)}
                    secondary={opt.title || undefined}
                    primaryTypographyProps={{ fontFamily: "monospace", fontSize: 12 }}
                    secondaryTypographyProps={{ fontSize: 11, sx: { whiteSpace: "normal" } }}
                  />
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
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
      <Tooltip title={saving ? "saving…" : isDirty ? "save edits" : "no unsaved edits"}>
        <span style={{ gridArea: "save" }}>
          <IconButton
            size="small"
            disabled={!isDirty || saving}
            onClick={handleSave}
            sx={{ p: 0.25, color: isDirty && !saving ? "primary.main" : "action.disabled" }}
          >
            {isDirty ? (
              <SaveIcon fontSize="inherit" />
            ) : (
              <SaveOutlinedIcon fontSize="inherit" />
            )}
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={!isDirty ? "" : saving ? "can't discard while a save is in flight — wait for it to land" : "undo edits"}>
        <span style={{ gridArea: "undo" }}>
          <IconButton
            size="small"
            onClick={handleUndo}
            disabled={!isDirty || saving}
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
  a.quoteBuildSelectionCount === b.quoteBuildSelectionCount &&
  a.suggestionAltIds === b.suggestionAltIds &&
  // Bridge entry/exit flips the ref picker on/off; ref_raw/verse changes ride
  // on `a.row` (a move bumps the row object). verseOptions is memoized upstream.
  a.verseOptions === b.verseOptions &&
  a.queued === b.queued &&
  a.outboxSeq === b.outboxSeq);

function twShort(link: string | null): string {
  if (!link) return "—";
  // rc://*/tw/dict/bible/names/moab → names/moab
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

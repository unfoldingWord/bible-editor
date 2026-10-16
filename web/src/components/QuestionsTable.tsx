import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Box, Chip, Paper, Stack, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import type { TqRow } from "../sync/api";
import { draftDirtyBorderSx } from "../sync/drafts";
import { usePinnedRowEdit, type PinnedSaveOpts } from "../hooks/usePinnedRowEdit";
import { buildFindRegex, nthMatchRange, type QuestionField } from "../lib/questionFind";
import { TQ_HISTORY_FIELDS, type RowSnapshot } from "./rowHistoryFields";

const RowHistoryDialog = lazy(() =>
  import("./RowHistoryDialog").then((m) => ({ default: m.RowHistoryDialog })),
);

interface Props {
  rows: TqRow[];
  // Apply local + enqueue. Caller is responsible for outbox.enqueueRow.
  // `opts.restoredFromVersion` marks the PATCH as a history revert so the
  // history dialog can hide the phantom entry it writes. `expectedVersion` /
  // `baseline` are the server version and values the edit was typed against
  // (#1115), not the cached row's.
  onSave: (id: string, patch: Partial<TqRow>, opts: PinnedSaveOpts) => void;
  onDelete: (id: string) => void;
  // When true, rows render read-only and the delete button is hidden. Used
  // while an AI pipeline is mid-flight for the chapter — the auto-apply step
  // will overwrite TQs anyway.
  locked?: boolean;
  // The row to highlight + carry `data-question-id` for scroll-into-view —
  // mirrors WordsTable's activeId. Set from a manual click (onFocus below) or
  // from an external jump (find/replace, a lint "go to issue", a future
  // comment deep link).
  activeId?: string | null;
  // Fired on mousedown/focus anywhere in a row, mirroring WordsTable's
  // onFocus. Optional — callers that don't track an active question (e.g. the
  // pinned-chapter groups aren't wired for this yet) can omit it.
  onFocus?: (row: TqRow) => void;
  // Find/replace highlight. The active match's row shows that field as a
  // read-only block with the Nth match marked (see QuestionFindReadView).
  findQuery?: FindQuery | null;
  activeMatch?: ActiveMatch | null;
}

type TqShown = { ref_raw: string; question: string; response: string };
const TQ_KEYS = ["ref_raw", "question", "response"] as const;
const tqShown = (raw: Record<string, unknown>): TqShown => ({
  ref_raw: (raw.ref_raw as string | null) ?? "",
  question: (raw.question as string | null) ?? "",
  response: (raw.response as string | null) ?? "",
});

type FindQuery = { find: string; regex: boolean; caseSensitive: boolean };
type ActiveMatch = { rowId: string; field: QuestionField; occurrence: number };

function QuestionsTableInner({ rows, onSave, onDelete, locked = false, activeId = null, onFocus, findQuery = null, activeMatch = null }: Props) {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        no questions for this verse
      </Typography>
    );
  }
  return (
    <Paper
      variant="outlined"
      sx={{ overflow: "hidden", containerType: "inline-size", ...draftDirtyBorderSx() }}
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
        <span>Ref</span>
        <span>Question</span>
        <span>Response</span>
        <span />
        <span />
        <span />
        <span />
      </Box>
      {rows.map((r) => (
        <Row
          key={r.id}
          row={r}
          onSave={(p, opts) => onSave(r.id, p, opts)}
          onDelete={() => onDelete(r.id)}
          locked={locked}
          active={r.id === activeId}
          onFocus={onFocus ? () => onFocus(r) : undefined}
          findQuery={activeMatch && activeMatch.rowId === r.id ? findQuery : null}
          activeMatch={activeMatch && activeMatch.rowId === r.id ? activeMatch : null}
        />
      ))}
    </Paper>
  );
}

// Memoized: a note/word edit leaves `rows` (tqForVerse, a ResourceColumn
// useMemo) referentially stable, so the questions table skips re-render.
export const QuestionsTable = memo(
  QuestionsTableInner,
  (a, b) =>
    a.rows === b.rows &&
    a.locked === b.locked &&
    a.activeId === b.activeId &&
    a.findQuery === b.findQuery &&
    a.activeMatch === b.activeMatch,
);

// Container-query breakpoint: under this table width the ref lane + two text
// columns + two action buttons can't all stay legible, so the layout reflows
// to stack the question and response on their own full-width rows.
const NARROW_BP_PX = 460;

// Wide: ref lane (ranges like "1:1-3" fit), question + response share the rest,
// then the version chip and two action cells. Narrow (container ≤
// NARROW_BP_PX): ref shares the top row with the chip and action buttons; the
// text fields drop to full-width rows beneath.
const responsiveGridSx = {
  display: "grid",
  gap: 1,
  alignItems: "center",
  gridTemplateColumns: "80px 1fr 1fr 46px 28px 28px 28px",
  gridTemplateAreas: '"ref question response ver save undo delete"',
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "1fr 46px 28px 28px 28px",
    gridTemplateAreas: [
      '"ref ver save undo delete"',
      '"question question question question question"',
      '"response response response response response"',
    ].join(" "),
    rowGap: 0.5,
  },
} as const;

const Row = memo(function Row({
  row,
  onSave,
  onDelete,
  locked,
  active = false,
  onFocus,
  findQuery = null,
  activeMatch = null,
}: {
  row: TqRow;
  onSave: (patch: Partial<TqRow>, opts: PinnedSaveOpts) => void;
  onDelete: () => void;
  locked: boolean;
  active?: boolean;
  onFocus?: () => void;
  findQuery?: FindQuery | null;
  activeMatch?: ActiveMatch | null;
}) {
  // #1115: fields compare against the server version they were typed against
  // (a refused save stays unsaved here), not the optimistic cached row.
  const edit = usePinnedRowEdit<TqRow, TqShown>({
    kind: "tq",
    row,
    keys: TQ_KEYS,
    shownOf: tqShown,
    locked,
    onSave: (patch, opts) => onSave(patch as Partial<TqRow>, opts),
  });
  const { ref_raw: refRaw, question, response } = edit.local;
  const setRefRaw = (v: string) => edit.setField("ref_raw", v);
  const setQuestion = (v: string) => edit.setField("question", v);
  const setResponse = (v: string) => edit.setField("response", v);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Find highlight: the active match's field renders as a read-only block with
  // the Nth match marked, until the user clicks into it (editingField). A new
  // find target returns to the read view so the mark shows. Never select text
  // inside the textarea instead — that would steal focus from the find input
  // and break Enter-to-advance.
  const [editingField, setEditingField] = useState<QuestionField | null>(null);
  useEffect(() => {
    setEditingField(null);
  }, [activeMatch?.field, activeMatch?.occurrence, row.id]);
  const questionInputRef = useRef<HTMLTextAreaElement | null>(null);
  const responseInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!editingField) return;
    const el = (editingField === "question" ? questionInputRef : responseInputRef).current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editingField]);
  const findRe = useMemo(() => (findQuery ? buildFindRegex(findQuery) : null), [findQuery]);
  // Not while the field holds unsaved text: the match index was computed on
  // the saved text, so the mark could land on the wrong occurrence.
  const fieldDirty = (f: QuestionField) => f in edit.diff;
  const readField: QuestionField | null =
    activeMatch && findRe && editingField !== activeMatch.field && !fieldDirty(activeMatch.field)
      ? activeMatch.field
      : null;

  const { isDirty, saving } = edit;
  const handleSave = () => edit.submit();

  const effectiveVersion = row.restored_from_version ?? row.version;

  // Restore a version picked in the history dialog: mirror it into the local
  // fields, then PATCH only what differs from the saved server state (the pin)
  // so picking the current version can't bump the version for nothing. The
  // local mirror happens even when the patch is empty. ref_raw is not in the
  // snapshot and is not sent: the server re-derives `verse` from it, so a
  // half-typed ref must stay unsaved, and the pin keeps it dirty across the
  // version bump (rowEditPin.ts).
  const handleUseVersion = (snapshot: RowSnapshot, fromVersion: number) => {
    edit.submit(
      { question: snapshot.question ?? "", response: snapshot.response ?? "" },
      { only: ["question", "response"], restoredFromVersion: fromVersion },
    );
  };

  return (
    <Box
      data-question-id={row.id}
      onMouseDown={onFocus}
      onFocus={onFocus}
      sx={{
        ...responsiveGridSx,
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        bgcolor: active ? "primary.50" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--mui-palette-primary-main, #31ADE3)" : "none",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.5}
        sx={{ minWidth: 0, gridArea: "ref" }}
      >
        {row.latest_source === "ai_pipeline" && (
          <Tooltip title="Generated by an AI pipeline. Your next edit clears this label.">
            <AutoAwesomeIcon
              sx={{ fontSize: 14, color: "secondary.main", flexShrink: 0 }}
            />
          </Tooltip>
        )}
        <TextField
          value={refRaw}
          onChange={(e) => setRefRaw(e.target.value)}
          size="small"
          spellCheck={false}
          variant="outlined"
          placeholder="1:1"
          InputProps={{
            readOnly: locked,
            // Apply dirty flag to the input root so the orange-border CSS
            // catches it on blur. Marking the TextField wrapper wouldn't —
            // :focus-within would still match while typing.
            ...(isDirty ? { "data-dirty": "true" } : {}),
          }}
          inputProps={{
            style: { fontSize: 12, padding: "5px 6px", fontFamily: "monospace" },
          }}
        />
      </Stack>
      {readField === "question" && findRe && activeMatch ? (
        <QuestionFindReadView
          text={question}
          re={findRe}
          occurrence={activeMatch.occurrence}
          gridArea="question"
          onActivate={() => setEditingField("question")}
        />
      ) : (
        <TextField
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          inputRef={questionInputRef}
          size="small"
          multiline
          spellCheck
          variant="outlined"
          sx={{ gridArea: "question" }}
          InputProps={{
            readOnly: locked,
            ...(isDirty ? { "data-dirty": "true" } : {}),
          }}
          inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
        />
      )}
      {readField === "response" && findRe && activeMatch ? (
        <QuestionFindReadView
          text={response}
          re={findRe}
          occurrence={activeMatch.occurrence}
          gridArea="response"
          onActivate={() => setEditingField("response")}
        />
      ) : (
        <TextField
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          inputRef={responseInputRef}
          size="small"
          multiline
          spellCheck
          variant="outlined"
          sx={{ gridArea: "response" }}
          InputProps={{
            readOnly: locked,
            ...(isDirty ? { "data-dirty": "true" } : {}),
          }}
          inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
        />
      )}
      <Stack sx={{ gridArea: "ver", alignItems: "center", gap: 0.25, minWidth: 0 }}>
        <Tooltip
          title={
            row.restored_from_version != null
              ? `v${row.restored_from_version} (restored)${isDirty ? " · unsaved edits" : ""} — currently at row v${row.version}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`
              : `v${row.version}${isDirty ? " · unsaved edits" : ""} — saved ${row.version - 1} time${row.version - 1 === 1 ? "" : "s"}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`
          }
        >
          <Chip
            label={`v${effectiveVersion}${isDirty ? "*" : ""}`}
            size="small"
            variant="outlined"
            clickable
            onClick={(e) => {
              e.stopPropagation();
              setHistoryOpen(true);
            }}
            sx={{
              fontFamily: "monospace",
              fontSize: 11,
              height: 24,
              color: isDirty ? "warning.main" : "text.secondary",
              borderColor: isDirty ? "warning.main" : "divider",
              fontWeight: isDirty ? 600 : 400,
              "& .MuiChip-label": { px: 0.5 },
            }}
          />
        </Tooltip>
        {/* 4-char sticky ID (DCS convention). Tucked under the version chip so
            it's visible without adding a column. At normal width the chip cell
            runs shorter than the multiline question/response, so this fills
            existing slack; on the narrow layout (question/response reflow to
            their own rows) it adds a few px to the top row, which is acceptable. */}
        <Tooltip title="Question ID">
          <Typography
            component="span"
            sx={{ fontFamily: "monospace", fontSize: 10, lineHeight: 1, color: "text.disabled" }}
          >
            {row.id}
          </Typography>
        </Tooltip>
      </Stack>
      {historyOpen && (
        <Suspense fallback={null}>
          <RowHistoryDialog
            open={historyOpen}
            kind="tq"
            rowId={row.id}
            book={row.book}
            fields={TQ_HISTORY_FIELDS}
            title="Question history"
            currentVersion={row.version}
            canRestore={!locked && !saving}
            effectiveVersion={effectiveVersion}
            onClose={() => setHistoryOpen(false)}
            onUseVersion={handleUseVersion}
          />
        </Suspense>
      )}
      {locked ? (
        <span style={{ gridArea: "save" }} />
      ) : (
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
      )}
      {locked ? (
        <span style={{ gridArea: "undo" }} />
      ) : (
        <Tooltip title={isDirty && !saving ? "undo edits (back to the saved text)" : ""}>
          <span style={{ gridArea: "undo" }}>
            <IconButton
              size="small"
              aria-label="undo edits"
              onClick={edit.undo}
              disabled={!isDirty || saving}
              sx={{ p: 0.25, color: "text.secondary", opacity: isDirty ? 1 : 0, transition: "opacity 150ms" }}
            >
              <UndoIcon fontSize="inherit" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      {locked ? (
        <span style={{ gridArea: "delete" }} />
      ) : (
        <IconButton
          size="small"
          onClick={onDelete}
          color="error"
          sx={{ p: 0.25, gridArea: "delete" }}
        >
          <DeleteOutlineIcon fontSize="inherit" />
        </IconButton>
      )}
    </Box>
  );
}, (a, b) =>
  // Skip sibling question rows when the table re-renders; row is stable unless
  // THIS question changed. Callbacks (onSave/onDelete/onFocus) intentionally
  // ignored — active is the only externally-driven flag that must repaint.
  a.row === b.row &&
  a.locked === b.locked &&
  a.active === b.active &&
  a.findQuery === b.findQuery &&
  a.activeMatch === b.activeMatch);

// Read-only render of a question / response with the active find match marked
// orange ("here I am") and scrolled into view. A real inline block (not the
// textarea), so nothing steals focus from the find input. Clicking it swaps
// back to the editable field. Mirrors NoteBodyReadView in NoteCard.tsx.
function QuestionFindReadView({
  text,
  re,
  occurrence,
  gridArea,
  onActivate,
}: {
  text: string;
  re: RegExp;
  occurrence: number;
  gridArea: string;
  onActivate: () => void;
}) {
  const markRef = useRef<HTMLElement | null>(null);
  const range = useMemo(() => nthMatchRange(text, re, occurrence), [text, re, occurrence]);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [range]);
  return (
    <Box
      onMouseDown={(e: React.MouseEvent) => {
        if (e.button !== 0) return;
        // The read block is replaced by the textarea in the same commit; stop
        // the browser's default focus handling from fighting the focus() call.
        e.preventDefault();
        onActivate();
      }}
      title="click to edit"
      tabIndex={0}
      onFocus={onActivate}
      sx={{
        gridArea,
        cursor: "text",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        minHeight: 30,
        px: "6px",
        py: "3px",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        fontSize: 13,
        lineHeight: 1.4375,
        "&:hover": { borderColor: "text.primary" },
      }}
    >
      {range ? (
        <>
          {text.slice(0, range.start)}
          <Box
            component="mark"
            ref={markRef}
            sx={{
              borderRadius: "2px",
              padding: "0 1px",
              color: "inherit",
              backgroundColor: (t: Theme) =>
                t.palette.mode === "dark" ? "rgba(251, 146, 60, 0.5)" : "#fb923c",
              outline: (t: Theme) => `2px solid ${t.palette.mode === "dark" ? "#fb923c" : "#c2410c"}`,
            }}
          >
            {text.slice(range.start, range.end)}
          </Box>
          {text.slice(range.end)}
        </>
      ) : (
        text || " "
      )}
    </Box>
  );
}

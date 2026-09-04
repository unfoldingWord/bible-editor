import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Box, Chip, Paper, Stack, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { TqRow } from "../sync/api";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";
import { TQ_HISTORY_FIELDS, type RowSnapshot } from "./rowHistoryFields";

const RowHistoryDialog = lazy(() =>
  import("./RowHistoryDialog").then((m) => ({ default: m.RowHistoryDialog })),
);

interface Props {
  rows: TqRow[];
  // Apply local + enqueue. Caller is responsible for outbox.enqueueRow.
  // `opts.restoredFromVersion` marks the PATCH as a history revert so the
  // history dialog can hide the phantom entry it writes.
  onSave: (
    id: string,
    patch: Partial<TqRow>,
    opts?: { restoredFromVersion?: number },
  ) => void;
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
}

function QuestionsTableInner({ rows, onSave, onDelete, locked = false, activeId = null, onFocus }: Props) {
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
        />
      ))}
    </Paper>
  );
}

// Memoized: a note/word edit leaves `rows` (tqForVerse, a ResourceColumn
// useMemo) referentially stable, so the questions table skips re-render.
export const QuestionsTable = memo(
  QuestionsTableInner,
  (a, b) => a.rows === b.rows && a.locked === b.locked && a.activeId === b.activeId,
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
  gridTemplateColumns: "80px 1fr 1fr 46px 28px 28px",
  gridTemplateAreas: '"ref question response ver save delete"',
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "1fr 46px 28px 28px",
    gridTemplateAreas: [
      '"ref ver save delete"',
      '"question question question question"',
      '"response response response response"',
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
}: {
  row: TqRow;
  onSave: (patch: Partial<TqRow>, opts?: { restoredFromVersion?: number }) => void;
  onDelete: () => void;
  locked: boolean;
  active?: boolean;
  onFocus?: () => void;
}) {
  const [refRaw, setRefRaw] = useState(row.ref_raw ?? "");
  const [question, setQuestion] = useState(row.question ?? "");
  const [response, setResponse] = useState(row.response ?? "");
  const [historyOpen, setHistoryOpen] = useState(false);

  // Set by a history restore that fires while the REF lane has unsaved typing.
  // The restore bumps row.version, which would otherwise make the resync below
  // overwrite the user's in-progress ref with the server value. Carrying the
  // ref in the restore PATCH instead is NOT an option: the server re-derives
  // the `verse` column from ref_raw (api/src/rows.ts), so persisting a
  // half-typed "1:" would relocate the row to verse 0.
  const pendingRefRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingRefRef.current != null) {
      setRefRaw(pendingRefRef.current);
      pendingRefRef.current = null;
      return;
    }
    setRefRaw(row.ref_raw ?? "");
  }, [row.id, row.version, row.ref_raw]);
  useEffect(() => setQuestion(row.question ?? ""), [row.id, row.version, row.question]);
  useEffect(() => setResponse(row.response ?? ""), [row.id, row.version, row.response]);

  const draftKey = useMemo(() => rowKey("tq", row.book, row.id), [row.book, row.id]);

  // Hydrate from any persisted draft on first mount so unsaved typing
  // survives navigation. Subsequent server pushes are caught by the
  // useEffects above (which only run when row.version changes).
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(draftKey).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const patch = (rec?.payload as { patch?: Partial<TqRow> } | undefined)?.patch;
      if (!patch) return;
      if (typeof patch.ref_raw === "string") setRefRaw(patch.ref_raw);
      if (typeof patch.question === "string") setQuestion(patch.question);
      if (typeof patch.response === "string") setResponse(patch.response);
    });
  }, [draftKey]);
  const diff = useMemo<Partial<TqRow>>(() => {
    const out: Partial<TqRow> = {};
    if (refRaw !== (row.ref_raw ?? "")) out.ref_raw = refRaw;
    if (question !== (row.question ?? "")) out.question = question;
    if (response !== (row.response ?? "")) out.response = response;
    return out;
  }, [refRaw, question, response, row.ref_raw, row.question, row.response]);
  const isDirty = Object.keys(diff).length > 0;

  // Sync the draft store as the source of crash-recovery truth. Cleared
  // when the user edits back to server state (so the orange border vanishes).
  useEffect(() => {
    if (locked) return;
    if (isDirty) {
      void drafts.set(draftKey, { patch: diff }, row.version, {
        kind: "row",
        rowKind: "tq",
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      void drafts.clear(draftKey);
    }
  }, [draftKey, isDirty, diff, row.version, row.id, row.book, row.chapter, row.verse, locked]);

  const handleSave = () => {
    if (!isDirty) return;
    onSave(diff);
  };

  const effectiveVersion = row.restored_from_version ?? row.version;

  // Restore a version picked in the history dialog: mirror it into the local
  // fields, then PATCH only what actually differs from saved server state so
  // picking the current version can't bump the version for nothing. The local
  // mirror happens even when the patch is empty — the user asked for this
  // version's text, which means discarding any unsaved typing on top of it.
  const handleUseVersion = (snapshot: RowSnapshot, fromVersion: number) => {
    const rawQuestion = snapshot.question ?? "";
    const rawResponse = snapshot.response ?? "";
    setQuestion(rawQuestion);
    setResponse(rawResponse);
    const patch: Partial<TqRow> = {};
    if (rawQuestion !== (row.question ?? "")) patch.question = rawQuestion;
    if (rawResponse !== (row.response ?? "")) patch.response = rawResponse;
    if (Object.keys(patch).length === 0) return;
    // ref_raw isn't part of the history snapshot, so the version bump this
    // PATCH triggers would resync it from the server and silently drop an
    // unsaved ref edit. Hold it across the bump so it stays as the user left
    // it — unsaved, still dirty — rather than being clobbered or written.
    if (refRaw !== (row.ref_raw ?? "")) pendingRefRef.current = refRaw;
    onSave(patch, { restoredFromVersion: fromVersion });
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
            style: { fontSize: 12, padding: "3px 6px", fontFamily: "monospace" },
          }}
        />
      </Stack>
      <TextField
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
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
      <TextField
        value={response}
        onChange={(e) => setResponse(e.target.value)}
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
              fontSize: 10,
              height: 20,
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
            canRestore={!locked}
            effectiveVersion={effectiveVersion}
            onClose={() => setHistoryOpen(false)}
            onUseVersion={handleUseVersion}
          />
        </Suspense>
      )}
      {locked ? (
        <span style={{ gridArea: "save" }} />
      ) : (
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
  a.row === b.row && a.locked === b.locked && a.active === b.active);

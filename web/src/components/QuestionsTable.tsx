import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Box, Chip, Paper, Stack, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import type { TqRow } from "../sync/api";
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
import { buildFindRegex, nthMatchRange, type QuestionField } from "../lib/questionFind";
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
    opts?: { restoredFromVersion?: number; basis?: { version: number; fields: Record<string, unknown> } },
  ) => void;
  onDelete: (id: string) => void;
  // Put the last saved values back into the cached row (no PATCH). Undo uses
  // it: a save the server refused left its text in the cache (#1115).
  onRevert?: (id: string, patch: Partial<TqRow>) => void;
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

// The fields a question row edits, as its inputs show them (null as "").
type TqFields = { ref_raw: string; question: string; response: string };
const tqFields = (row: TqRow): TqFields => ({
  ref_raw: row.ref_raw ?? "",
  question: row.question ?? "",
  response: row.response ?? "",
});

type FindQuery = { find: string; regex: boolean; caseSensitive: boolean };
type ActiveMatch = { rowId: string; field: QuestionField; occurrence: number };

function QuestionsTableInner({ rows, onSave, onDelete, onRevert, locked = false, activeId = null, onFocus, findQuery = null, activeMatch = null }: Props) {
  const queuedEdits = useQueuedRowEdits("tq");
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
          onRevert={onRevert ? (p) => onRevert(r.id, p) : undefined}
          queued={queuedEdits.ids.has(r.id)}
          outboxSeq={queuedEdits.seq}
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
// then the version chip and three action cells (undo, save, delete). Narrow
// (container ≤ NARROW_BP_PX): ref shares the top row with the chip and action
// buttons; the text fields drop to full-width rows beneath.
const responsiveGridSx = {
  display: "grid",
  gap: 1,
  alignItems: "center",
  gridTemplateColumns: "80px 1fr 1fr 46px 28px 28px 28px",
  gridTemplateAreas: '"ref question response ver undo save delete"',
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "1fr 46px 28px 28px 28px",
    gridTemplateAreas: [
      '"ref ver undo save delete"',
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
  onRevert,
  queued,
  outboxSeq,
  locked,
  active = false,
  onFocus,
  findQuery = null,
  activeMatch = null,
}: {
  row: TqRow;
  onSave: (patch: Partial<TqRow>, opts?: { restoredFromVersion?: number; basis?: { version: number; fields: Record<string, unknown> } }) => void;
  onDelete: () => void;
  onRevert?: (patch: Partial<TqRow>) => void;
  // An edit save of this row is still in the outbox; and the count of outbox
  // snapshots seen (useQueuedRowEdits), for the Save/Undo gate.
  queued: boolean;
  outboxSeq: number;
  locked: boolean;
  active?: boolean;
  onFocus?: () => void;
  findQuery?: FindQuery | null;
  activeMatch?: ActiveMatch | null;
}) {
  const [refRaw, setRefRaw] = useState(row.ref_raw ?? "");
  const [question, setQuestion] = useState(row.question ?? "");
  const [response, setResponse] = useState(row.response ?? "");
  const [historyOpen, setHistoryOpen] = useState(false);

  // #1115: the last server-confirmed values, pinned to row.version (see
  // rowEditBaseline.ts). Shell's optimistic apply puts our saved text into the
  // cached row at the SAME version, so a save the server refuses or the user
  // discards would read as saved if we diffed against `row`. Rebased during
  // render, like NoteCard's savedRef: the diff below reads it in this render.
  const baselineRef = useRef<RowBaseline<TqFields> | null>(null);
  baselineRef.current = rebaseRowBaseline(baselineRef.current, tqFields(row), row.version);
  const base = baselineRef.current.fields;
  const rowVersionRef = useRef(row.version);
  rowVersionRef.current = row.version;

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
  const fieldDirty = (f: QuestionField) =>
    (f === "question" ? question : response) !== base[f];
  const readField: QuestionField | null =
    activeMatch && findRe && editingField !== activeMatch.field && !fieldDirty(activeMatch.field)
      ? activeMatch.field
      : null;

  const localFields: TqFields = { ref_raw: refRaw, question, response };
  const diff: Partial<TqRow> = rowFieldDiff(localFields, base);
  // Set when the server changed a field this row holds unsaved typing in (see
  // SaveBasis): the next save is sent against the version the user typed
  // against, so it 409s into the outbox's conflict prompt instead of silently
  // overwriting the other edit. Dropped once no conflicting field is dirty.
  const basisRef = useRef<SaveBasis<TqFields> | null>(null);
  basisRef.current = activeSaveBasis(basisRef.current, localFields, base);
  const isDirty = Object.keys(diff).length > 0;

  // Save/Undo gate (#1115 review): off while a save of this row is queued, in
  // flight or in conflict, so Undo cannot be overtaken by the save landing and
  // a double click cannot send two PATCHes. Reopens on a refusal or discard.
  const [clickedAtSeq, setClickedAtSeq] = useState<number | null>(null);
  const saving = saveGateClosed({ queued, clickedAtSeq, seq: outboxSeq });

  // Resync from the cached row, field by field (resyncLocalFields): a field
  // with unsaved typing keeps it through any change — a new version (a 200,
  // a restore, a WS upsert, an AI run's apply after a refused save) or a
  // same-version refetch — and still reads unsaved against the rebased
  // baseline; every other field follows the row. This also keeps an unsaved
  // ref across a history restore's version bump: carrying it in the restore
  // PATCH is not an option, as the server re-derives `verse` from ref_raw
  // (api/src/rows.ts), so a half-typed "1:" would move the row to verse 0.
  // `syncBaseRef` is the baseline the fields were compared against before
  // this change (the render already rebased baselineRef).
  const syncBaseRef = useRef<RowBaseline<TqFields> | null>(null);
  useEffect(() => {
    const prev = syncBaseRef.current ?? baselineRef.current!;
    syncBaseRef.current = baselineRef.current;
    const rowFields = tqFields(row);
    if (prev.version !== row.version) {
      basisRef.current = nextSaveBasis(basisRef.current, {
        local: localFields,
        prevBase: prev.fields,
        prevVersion: prev.version,
        row: rowFields,
      });
    }
    const next = resyncLocalFields(localFields, prev.fields, rowFields);
    setRefRaw(next.ref_raw);
    setQuestion(next.question);
    setResponse(next.response);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.version, row.ref_raw, row.question, row.response]);

  const draftKey = useMemo(() => rowKey("tq", row.book, row.id), [row.book, row.id]);

  // Hydrate from any persisted draft on first mount so unsaved typing
  // survives navigation. The draft also carries the baseline it was diffed
  // against: a remount over a cache still holding a refused save's text
  // would otherwise take that text as the saved state (#1115). `hydrated` is
  // state so the restored baseline reaches the screen even when the typed
  // text equals what the fields already show, and so the draft-write effect
  // cannot clear the draft before it has been read (NoteCard does the same).
  const [hydrated, setHydrated] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    drafts.get(draftKey).then(
      (rec) => {
        if (hydratedFromDraftRef.current) return;
        hydratedFromDraftRef.current = true;
        const restored = baselineFromDraft<TqFields>(rec?.payload, rec?.expectedVersion, rowVersionRef.current);
        if (restored) {
          baselineRef.current = restored;
          syncBaseRef.current = restored;
          const saved = (rec?.payload as { conflictBasis?: SaveBasis<TqFields> } | undefined)?.conflictBasis;
          if (saved && typeof saved.version === "number" && Array.isArray(saved.conflict)) basisRef.current = saved;
        }
        const patch = (rec?.payload as { patch?: Partial<TqRow> } | undefined)?.patch;
        if (patch) {
          if (typeof patch.ref_raw === "string") setRefRaw(patch.ref_raw);
          if (typeof patch.question === "string") setQuestion(patch.question);
          if (typeof patch.response === "string") setResponse(patch.response);
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

  // Sync the draft store as the source of crash-recovery truth. Cleared
  // when the user edits back to server state (so the orange border vanishes).
  // Keyed on the typed values, not the cached row: the optimistic apply of a
  // save must not mint a new draft generation, or the save's 200 would leave
  // the draft behind (drafts.rowSaveGeneration).
  useEffect(() => {
    if (locked) return;
    if (isDirty) {
      const b = baselineRef.current!;
      void drafts.set(draftKey, { patch: diff, baseline: b.fields, ...(basisRef.current ? { conflictBasis: basisRef.current } : {}) }, b.version, {
        kind: "row",
        rowKind: "tq",
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else if (hydrated) {
      void drafts.clear(draftKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, isDirty, refRaw, question, response, row.version, row.id, row.book, row.chapter, row.verse, locked, hydrated]);

  const handleSave = () => {
    if (!isDirty || saving) return;
    setClickedAtSeq(outboxSeq);
    const basis = basisRef.current;
    onSave(diff, basis ? { basis: { version: basis.version, fields: basis.fields } } : undefined);
  };

  // A field typed back to its saved value by hand: put the saved value back
  // into the cached row too, which may still hold a refused save's text, or
  // a remount would take that text as saved (#1115 review). Not while a save
  // is queued: the cache then holds what that save is sending.
  const editField = <K extends keyof TqFields>(k: K, v: TqFields[K], set: (v: TqFields[K]) => void) => {
    set(v);
    if (!saving && v === base[k] && tqFields(row)[k] !== base[k]) {
      onRevert?.({ [k]: base[k] } as Partial<TqRow>);
    }
  };

  // Discard unsaved typing: back to the last saved values, on screen and in
  // the cached row (a refused save left its text there), and drop the draft.
  const handleUndo = () => {
    if (saving) return;
    basisRef.current = null;
    setRefRaw(base.ref_raw);
    setQuestion(base.question);
    setResponse(base.response);
    void drafts.clear(draftKey);
    const revert = rowFieldDiff(base, tqFields(row));
    if (Object.keys(revert).length > 0) onRevert?.(revert);
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
    if (rawQuestion !== base.question) patch.question = rawQuestion;
    if (rawResponse !== base.response) patch.response = rawResponse;
    if (Object.keys(patch).length === 0) return;
    // ref_raw isn't part of the history snapshot. An unsaved ref edit stays
    // as the user left it (unsaved) across this PATCH's version bump: the
    // resync above keeps any field with unsaved typing.
    setClickedAtSeq(outboxSeq);
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
          onChange={(e) => editField("ref_raw", e.target.value, setRefRaw)}
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
          onChange={(e) => editField("question", e.target.value, setQuestion)}
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
          onChange={(e) => editField("response", e.target.value, setResponse)}
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
            canRestore={!locked}
            effectiveVersion={effectiveVersion}
            onClose={() => setHistoryOpen(false)}
            onUseVersion={handleUseVersion}
          />
        </Suspense>
      )}
      {/* Shown whenever the row is unsaved, locked or not: it never writes to
          the server, and after a refused save it is the way to drop the
          kept typing (#1115). */}
      <Tooltip
        title={
          !isDirty
            ? ""
            : saving
              ? "can't discard while a save is in flight — wait for it to land"
              : "discard unsaved edits — go back to the last saved version"
        }
      >
        <span style={{ gridArea: "undo" }}>
          <IconButton
            size="small"
            aria-label="discard unsaved edits"
            onClick={handleUndo}
            disabled={!isDirty || saving}
            sx={{ p: 0.25, color: "warning.main", opacity: isDirty ? 1 : 0, transition: "opacity 150ms" }}
          >
            <UndoIcon fontSize="inherit" />
          </IconButton>
        </span>
      </Tooltip>
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
  a.activeMatch === b.activeMatch &&
  a.queued === b.queued &&
  a.outboxSeq === b.outboxSeq);

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

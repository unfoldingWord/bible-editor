import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Stack,
  Chip,
  IconButton,
  Paper,
  Tooltip,
} from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import CloseIcon from "@mui/icons-material/Close";
import {
  alignmentPlainText,
  clearGroup,
  moveSource,
  moveTargets,
  parseAlignment,
  serializeAlignment,
  type AlignmentState,
} from "../lib/alignment";
import type { TwlRow, VerseDto } from "../sync/api";

const WORD_IDS_MIME = "text/word-ids";
const SOURCE_ID_MIME = "text/source-id";

interface Props {
  open: boolean;
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  verse: VerseDto | null;
  contextOther: VerseDto | null; // the "other" gateway translation (UST when editing ULT, etc.)
  sourceVerse: VerseDto | null;  // UHB/UGNT verse for context
  sourceLabel: string;           // "UHB" or "UGNT"
  twlForVerse: TwlRow[];         // chapter twl rows filtered to this verse, for TW-article hints
  onClose: () => void;
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
}

export function AlignmentDialog({
  open,
  book,
  chapter,
  verseNum,
  bibleVersion,
  verse,
  contextOther,
  sourceVerse,
  sourceLabel,
  twlForVerse,
  onClose,
  onSave,
}: Props) {
  const initial = useMemo<AlignmentState | null>(() => {
    if (!verse?.content) return null;
    const verseObjects = (verse.content as { verseObjects?: unknown[] }).verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    return parseAlignment(verseObjects);
  }, [verse]);

  const [state, setState] = useState<AlignmentState | null>(initial);
  const [selectedUnaligned, setSelectedUnaligned] = useState<Set<string>>(new Set());
  // Anchor for shift-range select — the last chip the user clicked without
  // shift. Cleared with the bag's × button or after a drop.
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  useEffect(() => {
    setState(initial);
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  }, [initial]);

  const handleTargetsDrop = (dest: string, wordIds: string[]) => {
    if (!state || wordIds.length === 0) return;
    setState(moveTargets(state, wordIds, dest));
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  };

  const handleSourceDrop = (destGroupId: string, sourceId: string) => {
    if (!state) return;
    setState(moveSource(state, sourceId, destGroupId));
  };

  const handleClearGroup = (groupId: string) => {
    if (!state) return;
    setState(clearGroup(state, groupId));
  };

  const handleClearSelection = () => {
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  };

  // Click toggles a single chip (additive); shift-click extends the selection
  // from the last-clicked anchor through the chip the user just clicked.
  const handleChipClick = (id: string, shift: boolean) => {
    if (!state) return;
    if (shift && selectionAnchor) {
      const all = state.unaligned.map((w) => w.id);
      const a = all.indexOf(selectionAnchor);
      const b = all.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = all.slice(lo, hi + 1);
        setSelectedUnaligned((prev) => {
          const next = new Set(prev);
          for (const w of range) next.add(w);
          return next;
        });
        return;
      }
    }
    setSelectedUnaligned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectionAnchor(id);
  };

  // When the user starts dragging an unaligned chip that's part of the
  // current selection, ship all selected ids. Otherwise ship just that one.
  const idsForUnalignedDrag = (id: string) =>
    selectedUnaligned.has(id) && selectedUnaligned.size > 1
      ? Array.from(selectedUnaligned)
      : [id];

  const handleReset = () => {
    setState(initial);
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  };
  const handleSave = () => {
    if (!state || !verse) return;
    const newVerseObjects = serializeAlignment(state);
    const newContent = { verseObjects: newVerseObjects };
    const plain = alignmentPlainText(state);
    onSave(newContent, plain, verse.version);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <LinkIcon sx={{ color: "success.main" }} />
        <Box>
          Aligning {book} {chapter}:{verseNum} · {bibleVersion}
        </Box>
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {!state && (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              no alignment data for this verse — either the source has no `\zaln-s` markers,
              or the verse was recently edited and alignment was cleared.
            </Typography>
          </Box>
        )}
        {state && (
          <>
            <VerseStrip
              verse={verse}
              other={contextOther}
              source={sourceVerse}
              sourceLabel={sourceLabel}
              bibleVersion={bibleVersion}
              chapter={chapter}
              verseNum={verseNum}
            />
            <Box sx={{ display: "grid", gridTemplateColumns: "220px 1fr", height: 480, overflow: "hidden" }}>
              <UnalignedBag
                state={state}
                selectedIds={selectedUnaligned}
                onChipClick={handleChipClick}
                idsForDrag={idsForUnalignedDrag}
                onClearSelection={handleClearSelection}
                onDrop={(wordIds) => handleTargetsDrop("u", wordIds)}
              />
              <AlignmentGrid
                state={state}
                twlForVerse={twlForVerse}
                verseNum={verseNum}
                onTargetsDrop={handleTargetsDrop}
                onSourceDrop={handleSourceDrop}
                onClearGroup={handleClearGroup}
              />
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1, gap: 1 }}>
        <Box sx={{ flex: 1 }} />
        <Button onClick={handleReset} disabled={!state}>
          reset
        </Button>
        <Button onClick={onClose}>cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!state}>
          save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function VerseStrip({
  verse,
  other,
  source,
  sourceLabel,
  bibleVersion,
  chapter,
  verseNum,
}: {
  verse: VerseDto | null;
  other: VerseDto | null;
  source: VerseDto | null;
  sourceLabel: string;
  bibleVersion: string;
  chapter: number;
  verseNum: number;
}) {
  const otherLabel = bibleVersion === "ULT" ? "UST" : bibleVersion === "UST" ? "ULT" : "UST";
  const sourceIsHebrew = sourceLabel === "UHB";
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "54px 1fr 1fr 1fr",
        gap: 2,
        px: 3,
        py: 1.5,
        bgcolor: "primary.50",
        borderBottom: "1px dashed",
        borderColor: "divider",
        fontSize: 13.5,
        lineHeight: 1.4,
      }}
    >
      <Box sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700 }}>
        {chapter}:{verseNum}
      </Box>
      <Box>
        <Chip label={bibleVersion} size="small" sx={{ mr: 1, fontFamily: "monospace", height: 18 }} />
        {verse?.plain_text}
      </Box>
      <Box>
        <Chip label={otherLabel} size="small" sx={{ mr: 1, fontFamily: "monospace", height: 18 }} />
        {other?.plain_text}
      </Box>
      <Box>
        <Chip label={sourceLabel} size="small" sx={{ mr: 1, fontFamily: "monospace", height: 18 }} />
        <Box
          component="span"
          dir={sourceIsHebrew ? "rtl" : "ltr"}
          sx={{
            fontFamily: sourceIsHebrew
              ? '"Times New Roman","SBL Hebrew","Cardo",serif'
              : '"Times New Roman","Cardo",serif',
            fontSize: 16,
            unicodeBidi: "isolate",
          }}
        >
          {source?.plain_text}
        </Box>
      </Box>
    </Box>
  );
}

function UnalignedBag({
  state,
  selectedIds,
  onChipClick,
  idsForDrag,
  onClearSelection,
  onDrop,
}: {
  state: AlignmentState;
  selectedIds: Set<string>;
  onChipClick: (id: string, shift: boolean) => void;
  idsForDrag: (id: string) => string[];
  onClearSelection: () => void;
  onDrop: (wordIds: string[]) => void;
}) {
  const [over, setOver] = useState(false);
  const unalignedIds = new Set(state.unaligned.map((w) => w.id));
  return (
    <Box
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const ids = readWordIds(e.dataTransfer);
        // Reorder within the bag is intentionally a no-op: only ship ids
        // that aren't already in the unaligned pool back to the parent.
        const movable = ids.filter((id) => !unalignedIds.has(id));
        if (movable.length > 0) onDrop(movable);
      }}
      sx={{
        bgcolor: over ? "primary.50" : "grey.50",
        borderRight: "1px solid",
        borderColor: "divider",
        p: 1.5,
        overflowY: "auto",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: "text.disabled",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            flex: 1,
          }}
        >
          unaligned ({state.unaligned.length})
          {selectedIds.size > 0 && ` · ${selectedIds.size} sel`}
        </Typography>
        {selectedIds.size > 0 && (
          <Tooltip title="clear selection">
            <IconButton size="small" onClick={onClearSelection} sx={{ p: 0.25 }}>
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {state.unaligned.length === 0 && (
        <Typography variant="caption" color="text.disabled">
          drag a word here to detach it from its source
        </Typography>
      )}
      <Typography
        variant="caption"
        sx={{ color: "text.disabled", display: "block", mb: 0.5, fontStyle: "italic" }}
      >
        click to add to selection · shift-click for range · drag any selected
      </Typography>
      <Stack spacing={0.5}>
        {state.unaligned.map((w) => (
          <SelectableChip
            key={w.id}
            text={w.text}
            selected={selectedIds.has(w.id)}
            onClick={(shift) => onChipClick(w.id, shift)}
            idsForDrag={() => idsForDrag(w.id)}
          />
        ))}
      </Stack>
    </Box>
  );
}

function AlignmentGrid({
  state,
  twlForVerse,
  verseNum,
  onTargetsDrop,
  onSourceDrop,
  onClearGroup,
}: {
  state: AlignmentState;
  twlForVerse: TwlRow[];
  verseNum: number;
  onTargetsDrop: (dest: string, wordIds: string[]) => void;
  onSourceDrop: (destGroupId: string, sourceId: string) => void;
  onClearGroup: (groupId: string) => void;
}) {
  // Hebrew/Greek reads RTL, so order the alignment cards right-to-left to
  // match how the user reads the source verse. Card internals (the GL target
  // chips) stay LTR via `direction: ltr` on the card itself.
  return (
    <Box
      sx={{
        p: 1.5,
        overflowY: "auto",
        display: "flex",
        flexWrap: "wrap",
        gap: 1.5,
        alignContent: "flex-start",
        direction: "rtl",
      }}
    >
      {state.groups.map((g) => (
        <DropTargetBox
          key={g.id}
          groupId={g.id}
          onTargetsDrop={(wordIds) => onTargetsDrop(`g:${g.id}`, wordIds)}
          onSourceDrop={(sourceId) => onSourceDrop(g.id, sourceId)}
        >
          <Stack direction="row" alignItems="flex-start" sx={{ mb: 0.5, direction: "ltr" }}>
            <Stack direction="column" spacing={0.25} sx={{ flex: 1 }}>
              {g.source.map((s) => (
                <Tooltip
                  key={s.id}
                  title={
                    <Box sx={{ fontSize: 12 }}>
                      <div>strong: {s.strong || "—"}</div>
                      <div>lemma: {s.lemma || "—"}</div>
                      <div>morph: {s.morph || "—"}</div>
                      {twHintFor(twlForVerse, verseNum, s.content) && (
                        <div>tw: {twHintFor(twlForVerse, verseNum, s.content)}</div>
                      )}
                    </Box>
                  }
                >
                  <Paper
                    elevation={0}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SOURCE_ID_MIME, s.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    sx={{
                      bgcolor: "grey.900",
                      color: "grey.50",
                      px: 1.2,
                      py: 0.5,
                      fontFamily: '"Times New Roman", "SBL Hebrew", "Cardo", serif',
                      fontSize: 20,
                      textAlign: "center",
                      direction: "rtl",
                      borderRadius: 0.5,
                      cursor: "grab",
                      "&:active": { cursor: "grabbing" },
                    }}
                  >
                    {s.content}
                  </Paper>
                </Tooltip>
              ))}
            </Stack>
            <Tooltip title="clear alignment for this block (sends GL words back to the unaligned bag and splits compound source)">
              <IconButton
                size="small"
                onClick={() => onClearGroup(g.id)}
                sx={{ ml: 0.5, p: 0.25, color: "text.disabled", "&:hover": { color: "error.main" } }}
              >
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Stack>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" rowGap={0.5} sx={{ direction: "ltr" }}>
            {g.targets.length === 0 ? (
              <Typography
                variant="caption"
                sx={{ color: "text.disabled", fontStyle: "italic", px: 0.5 }}
              >
                drop here
              </Typography>
            ) : (
              g.targets.map((t) => (
                <SimpleDraggableChip key={t.id} wordId={t.id} text={t.text} />
              ))
            )}
          </Stack>
        </DropTargetBox>
      ))}
    </Box>
  );
}

function DropTargetBox({
  groupId,
  onTargetsDrop,
  onSourceDrop,
  children,
}: {
  groupId: string;
  onTargetsDrop: (wordIds: string[]) => void;
  onSourceDrop: (sourceId: string) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <Paper
      variant="outlined"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const wordIds = readWordIds(e.dataTransfer);
        if (wordIds.length > 0) {
          onTargetsDrop(wordIds);
          return;
        }
        const sourceId = e.dataTransfer.getData(SOURCE_ID_MIME);
        if (sourceId) onSourceDrop(sourceId);
      }}
      data-group-id={groupId}
      sx={{
        minWidth: 110,
        p: 0.75,
        bgcolor: over ? "primary.50" : "background.paper",
        borderColor: over ? "primary.main" : "divider",
        borderWidth: over ? 1.5 : 1,
        borderStyle: "solid",
        display: "flex",
        flexDirection: "column",
        direction: "ltr",
      }}
    >
      {children}
    </Paper>
  );
}

function SelectableChip({
  text,
  selected,
  onClick,
  idsForDrag,
}: {
  text: string;
  selected: boolean;
  onClick: (shift: boolean) => void;
  idsForDrag: () => string[];
}) {
  return (
    <Chip
      label={text}
      size="small"
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      draggable
      onClick={(e) => onClick(e.shiftKey)}
      onDragStart={(e) => {
        const ids = idsForDrag();
        e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify(ids));
        // Also ship the legacy single-id form so the rest of the dialog
        // still works if multi-form parsing ever flakes.
        if (ids.length === 1) e.dataTransfer.setData("text/word-id", ids[0]);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        borderLeft: "3px solid",
        borderLeftColor: "primary.main",
        userSelect: "none",
      }}
    />
  );
}

function SimpleDraggableChip({ wordId, text }: { wordId: string; text: string }) {
  return (
    <Chip
      label={text}
      size="small"
      variant="outlined"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify([wordId]));
        e.dataTransfer.setData("text/word-id", wordId);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        borderLeft: "3px solid",
        borderLeftColor: "primary.main",
        bgcolor: "background.paper",
      }}
    />
  );
}

// ---------- helpers ----------

function readWordIds(dt: DataTransfer): string[] {
  const raw = dt.getData(WORD_IDS_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }
  const single = dt.getData("text/word-id");
  return single ? [single] : [];
}

// Find a TWL tw_link whose orig_words includes this source word, so the
// tooltip can point the editor at the article path (e.g. "names/yahweh").
// No definition text is shipped from the API yet — the link is the hint.
function twHintFor(twlRows: TwlRow[], verseNum: number, content: string): string | null {
  if (!content) return null;
  for (const r of twlRows) {
    if (r.verse !== verseNum) continue;
    const ow = r.orig_words ?? "";
    if (!ow) continue;
    // The TWL orig_words may be a single word or a phrase. Match if any
    // whitespace-separated chunk equals our content.
    const chunks = ow.split(/\s+/).filter(Boolean);
    if (chunks.includes(content)) {
      return twShort(r.tw_link);
    }
  }
  return null;
}

function twShort(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

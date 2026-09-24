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
  List,
  ListItemButton,
  ListItemText,
  CircularProgress,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  FormControlLabel,
  Switch,
} from "@mui/material";
import { api, type VerseHistoryEntry } from "../sync/api";
import { diffWords } from "../lib/wordDiff";
import { renderVerseUsfm, stripAlignmentNoise } from "../lib/verseUsfmPreview";

interface Props {
  open: boolean;
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  // The live row.version — what the chip shows and what the timeline marks
  // "current".
  currentVersion: number;
  // False puts the dialog in view-only mode: history still loads and previews,
  // but the restore button is disabled. Set while the line can't be edited
  // (book locked, or chapter mid-flight for an AI pipeline), where the server
  // would reject the restore PATCH anyway. Mirrors RowHistoryDialog.
  canRestore?: boolean;
  onClose: () => void;
  // Fires the chosen version's stored content + plain text back to the card,
  // which re-saves it through the normal verse pipe (alignment_edit intent) so
  // the exact tree — alignment included — is restored.
  onUseVersion: (content: unknown, plainText: string | null) => void;
}

const fmtTime = (epochSec: number) => new Date(epochSec * 1000).toLocaleString();

const userLabel = (e: VerseHistoryEntry) => {
  if (!e.user) return "unknown";
  return e.user.full_name || e.user.username || `user #${e.user.id}`;
};

// edit_log.source → a short human label. AI sub-sources collapse to "AI".
const sourceChip = (source: string | null): string | null => {
  if (source === "ai_pipeline" || source === "hint_expansion") return "AI";
  if (source === "dcs_reimport") return "re-import";
  return null;
};

type ViewMode = "snapshot" | "diff" | "usfm";

export function VerseHistoryDialog({
  open,
  book,
  chapter,
  verseNum,
  bibleVersion,
  currentVersion,
  canRestore: restoreAllowed = true,
  onClose,
  onUseVersion,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<VerseHistoryEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("snapshot");
  // Shown only in USFM mode. Off by default: alignment attributes (Strong's,
  // morph, occurrence counts) are the noise this view exists to see past —
  // see stripAlignmentNoise. Flip on for alignment detail.
  const [showAlignment, setShowAlignment] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getVerseHistory(book, chapter, verseNum, bibleVersion)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
        // Open showing the most recent restorable version that ISN'T current —
        // i.e. "what you'd roll back to". Fall back to the newest non-current,
        // else current.
        const desc = [...res.versions].sort((a, b) => b.version - a.version);
        const target =
          desc.find((v) => !v.current && v.restorable) ??
          desc.find((v) => !v.current) ??
          desc[0];
        setSelectedVersion(target?.version ?? null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, book, chapter, verseNum, bibleVersion]);

  // Newest first for display.
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.version - a.version),
    [entries],
  );

  const selected = useMemo(
    () => entries.find((e) => e.version === selectedVersion) ?? null,
    [entries, selectedVersion],
  );
  const current = useMemo(
    () => entries.find((e) => e.current) ?? null,
    [entries],
  );

  // Rendered USFM per version, keyed by version — memoized once per history
  // load rather than recomputed on every selection change. null entries
  // (content not stored) fall back to a message in the USFM pane below.
  const usfmByVersion = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const e of entries) map.set(e.version, renderVerseUsfm(e.content, chapter, verseNum));
    return map;
  }, [entries, chapter, verseNum]);

  // A version whose plain_text matches its immediate predecessor's but whose
  // USFM render differs — a markers/alignment-only overwrite (#951's ZEC 1:17
  // case). `ordered` is newest-first, so the predecessor of entry i is i+1.
  const markersOnlyVersions = useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < ordered.length - 1; i++) {
      const e = ordered[i];
      const prev = ordered[i + 1];
      if (e.plain_text !== prev.plain_text) continue;
      const eUsfm = usfmByVersion.get(e.version);
      const prevUsfm = usfmByVersion.get(prev.version);
      if (eUsfm !== null && prevUsfm !== null && eUsfm !== prevUsfm) set.add(e.version);
    }
    return set;
  }, [ordered, usfmByVersion]);

  const isCurrent = !!selected?.current;
  const canDiff = !isCurrent && selected !== null && current !== null;
  const canRestore = restoreAllowed && !!selected && !isCurrent && selected.restorable;

  const selectedUsfm = selected ? (usfmByVersion.get(selected.version) ?? null) : null;
  const currentUsfm = current ? (usfmByVersion.get(current.version) ?? null) : null;
  const canUsfmDiff = canDiff && selectedUsfm !== null && currentUsfm !== null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            Verse history
          </Typography>
          <Chip
            label={`${bibleVersion} ${chapter}:${verseNum}`}
            size="small"
            variant="outlined"
            sx={{ fontFamily: "monospace", height: 22 }}
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            current: v{currentVersion}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {loading ? (
          <Box sx={{ p: 4, display: "flex", justifyContent: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">failed to load history: {error}</Alert>
          </Box>
        ) : (
          <Stack direction="row" sx={{ minHeight: 360 }}>
            <Box
              sx={{
                width: 260,
                borderRight: "1px solid",
                borderColor: "divider",
                overflowY: "auto",
                maxHeight: 480,
              }}
            >
              <List dense disablePadding>
                {ordered.map((e) => {
                  const src = sourceChip(e.source);
                  return (
                    <ListItemButton
                      key={e.version}
                      selected={e.version === selectedVersion}
                      onClick={() => setSelectedVersion(e.version)}
                    >
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: "monospace", fontWeight: 600 }}
                            >
                              v{e.version}
                            </Typography>
                            {e.current && (
                              <Chip label="current" size="small" color="primary" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {e.action === "imported" && (
                              <Chip label="imported" size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {e.action === "baseline" && (
                              <Chip label="pre-AI" size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {src && (
                              <Chip label={src} size="small" variant="outlined" color="secondary" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {!e.restorable && (
                              <Tooltip title="alignment wasn't stored for this version — can't restore it">
                                <Chip label="text only" size="small" variant="outlined" color="warning" sx={{ height: 18, fontSize: 10 }} />
                              </Tooltip>
                            )}
                            {markersOnlyVersions.has(e.version) && (
                              <Tooltip title="the visible text is unchanged from the previous version — only markers or alignment differ. Open the USFM view to see what changed">
                                <Chip label="markers/alignment only" size="small" variant="outlined" color="info" sx={{ height: 18, fontSize: 10 }} />
                              </Tooltip>
                            )}
                          </Stack>
                        }
                        secondary={
                          <>
                            <Typography variant="caption" component="div">
                              {fmtTime(e.created_at)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" component="div">
                              {userLabel(e)}
                            </Typography>
                          </>
                        }
                      />
                    </ListItemButton>
                  );
                })}
              </List>
            </Box>
            <Box sx={{ flex: 1, p: 2, overflowY: "auto", maxHeight: 480 }}>
              {selected ? (
                <Stack spacing={1.5}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="caption" color="text.secondary">
                      {viewMode === "diff" && canDiff
                        ? `diff: v${selected.version} → v${currentVersion}`
                        : viewMode === "usfm" && canUsfmDiff
                          ? `USFM diff: v${selected.version} → v${currentVersion}`
                          : viewMode === "usfm"
                            ? `USFM snapshot of v${selected.version}`
                            : `preview of v${selected.version}`}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    {viewMode === "usfm" && (
                      <FormControlLabel
                        sx={{ mr: 0 }}
                        control={
                          <Switch
                            size="small"
                            checked={showAlignment}
                            onChange={(_, checked) => setShowAlignment(checked)}
                          />
                        }
                        label={
                          <Typography variant="caption" color="text.secondary">
                            show alignment attributes
                          </Typography>
                        }
                      />
                    )}
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={viewMode}
                      onChange={(_, v) => {
                        if (v) setViewMode(v as ViewMode);
                      }}
                      sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1 } }}
                    >
                      <ToggleButton value="snapshot">snapshot</ToggleButton>
                      <ToggleButton value="diff" disabled={!canDiff}>
                        diff vs current
                      </ToggleButton>
                      <ToggleButton value="usfm">USFM</ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>
                  {viewMode === "usfm" ? (
                    selectedUsfm === null ? (
                      <Alert severity="info" sx={{ py: 0 }}>
                        alignment/markers weren't stored for this version — only plain text is
                        available.
                      </Alert>
                    ) : canUsfmDiff ? (
                      <TextDiff
                        from={showAlignment ? selectedUsfm : stripAlignmentNoise(selectedUsfm)}
                        to={showAlignment ? currentUsfm! : stripAlignmentNoise(currentUsfm!)}
                        mono
                      />
                    ) : (
                      <TextPreview
                        value={showAlignment ? selectedUsfm : stripAlignmentNoise(selectedUsfm)}
                        mono
                      />
                    )
                  ) : viewMode === "diff" && canDiff ? (
                    <TextDiff from={selected.plain_text} to={current!.plain_text} />
                  ) : (
                    <TextPreview value={selected.plain_text} />
                  )}
                  {!selected.restorable && !isCurrent && (
                    <Alert severity="info" sx={{ py: 0 }}>
                      This point in history kept only the verse text, not its word
                      alignment, so it can be viewed but not restored.
                    </Alert>
                  )}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  pick a version on the left to preview.
                </Typography>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: "space-between" }}>
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
          History begins at the first saved edit; the original imported text may
          not be retained.
        </Typography>
        <Box>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="contained"
            disabled={!canRestore || loading}
            onClick={() => {
              if (!canRestore || !selected) return;
              onUseVersion(selected.content, selected.plain_text);
              onClose();
            }}
          >
            {!restoreAllowed
              ? "Locked"
              : isCurrent
                ? "Already current"
                : selected
                  ? `Switch to v${selected.version}`
                  : "Switch"}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}

const PROSE_FONT = '"Source Serif Pro","Cambria","Times New Roman",serif';
const USFM_FONT = '"Source Code Pro","Consolas",monospace';

function TextPreview({ value, mono }: { value: string | null; mono?: boolean }) {
  return (
    <Box
      sx={{
        p: 1,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "grey.50",
        minHeight: 32,
        whiteSpace: "pre-wrap",
        fontFamily: mono ? USFM_FONT : PROSE_FONT,
        fontSize: mono ? 13 : 15,
        color: value ? "text.primary" : "text.disabled",
      }}
    >
      {value || "(empty)"}
    </Box>
  );
}

function TextDiff({ from, to, mono }: { from: string | null; to: string | null; mono?: boolean }) {
  const fromStr = from ?? "";
  const toStr = to ?? "";
  const ops = useMemo(() => diffWords(fromStr, toStr), [fromStr, toStr]);
  const identical = ops.every((o) => o.type === "eq");
  return (
    <Box
      sx={{
        p: 1,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "grey.50",
        minHeight: 32,
        whiteSpace: "pre-wrap",
        fontFamily: mono ? USFM_FONT : PROSE_FONT,
        fontSize: mono ? 13 : 15,
      }}
    >
      {identical && fromStr === "" && toStr === "" ? (
        <Box component="span" sx={{ color: "text.disabled" }}>
          (empty)
        </Box>
      ) : identical ? (
        <Box component="span">{fromStr}</Box>
      ) : (
        ops.map((op, idx) => {
          if (op.type === "eq") {
            return (
              <Box key={idx} component="span">
                {op.text}
              </Box>
            );
          }
          if (op.type === "del") {
            return (
              <Box
                key={idx}
                component="span"
                sx={{
                  backgroundColor: "rgba(244, 67, 54, 0.18)",
                  color: "#b71c1c",
                  textDecoration: "line-through",
                  borderRadius: 0.5,
                }}
              >
                {op.text}
              </Box>
            );
          }
          return (
            <Box
              key={idx}
              component="span"
              sx={{
                backgroundColor: "rgba(76, 175, 80, 0.22)",
                color: "#1b5e20",
                borderRadius: 0.5,
              }}
            >
              {op.text}
            </Box>
          );
        })
      )}
    </Box>
  );
}

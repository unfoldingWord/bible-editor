import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  classifyHiddenChange,
  renderVerseUsfm,
  stripAlignmentNoise,
  type HiddenChange,
  type VerseUsfm,
} from "../lib/verseUsfmPreview";

interface Props {
  open: boolean;
  book: string;
  chapter: number;
  verseNum: number;
  // Inclusive end of the live row's bridge (`\v 6-9`), for the header label
  // only. History entries don't record their own verse_end, so the USFM view
  // renders every version as `\v N` rather than borrow the live row's range.
  verseEnd?: number | null;
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
// What the USFM view diffs the selected version against. "previous" diffs the
// next-older version -> selected ("what this version changed"); "current"
// diffs selected -> current, like the plain-text diff.
type UsfmBase = "current" | "previous";

const HIDDEN_CHANGE_LABEL = {
  markers: "markers only",
  alignment: "alignment only",
  both: "markers + alignment",
} as const;
const HIDDEN_CHANGE_TIP = {
  markers:
    "the visible text is the same as the previous version; only USFM markers (\\p, \\q, \\ts, ...) changed. Select it to see the USFM diff against the previous version",
  alignment:
    "the visible text and markers are the same as the previous version; only word alignment changed. Select it to see the USFM diff with alignment attributes shown",
  both:
    "the visible text is the same as the previous version; both USFM markers (\\p, \\q, \\ts, ...) and word alignment changed. Select it to see the USFM diff with alignment attributes shown",
} as const;

export function VerseHistoryDialog({
  open,
  book,
  chapter,
  verseNum,
  verseEnd,
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
  const [usfmBase, setUsfmBase] = useState<UsfmBase>("current");
  // Off by default: Strong's / morph / occurrence attributes would swamp the
  // marker changes this view exists to show.
  const [showAlignment, setShowAlignment] = useState(false);
  // Set when a load picks the version to open on, so that pick takes the same
  // chip path a click does (effect below, once the chips are computed).
  const autoSelectedRef = useRef(false);

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
        autoSelectedRef.current = true;
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

  // USFM per version. renderVerseUsfm clones before rendering, so the
  // entries' `content` (what "Switch to vN" re-saves) is never modified.
  const usfmByVersion = useMemo(() => {
    const map = new Map<number, VerseUsfm>();
    for (const e of entries) map.set(e.version, renderVerseUsfm(e.content, chapter, verseNum));
    return map;
  }, [entries, chapter, verseNum]);

  // The next-older version of each version (`ordered` is newest first).
  const predecessorOf = useMemo(() => {
    const map = new Map<number, VerseHistoryEntry>();
    for (let i = 0; i < ordered.length - 1; i++) map.set(ordered[i].version, ordered[i + 1]);
    return map;
  }, [ordered]);

  // Versions whose plain text equals the predecessor's but whose USFM differs.
  const hiddenChangeOf = useMemo(() => {
    const map = new Map<number, HiddenChange>();
    for (const e of ordered) {
      const prev = predecessorOf.get(e.version);
      if (!prev) continue;
      const kind = classifyHiddenChange(
        prev.plain_text,
        e.plain_text,
        usfmByVersion.get(prev.version) ?? { kind: "none" },
        usfmByVersion.get(e.version) ?? { kind: "none" },
      );
      if (kind) map.set(e.version, kind);
    }
    return map;
  }, [ordered, predecessorOf, usfmByVersion]);

  // Select a version. A chip row's change is only visible in the USFM view
  // against its predecessor, so open that directly, with attributes shown
  // whenever alignment changed and hidden for a marker-only change.
  const selectVersion = (version: number) => {
    setSelectedVersion(version);
    const kind = hiddenChangeOf.get(version);
    if (kind) {
      setViewMode("usfm");
      setUsfmBase("previous");
      setShowAlignment(kind !== "markers");
    }
  };

  // The version a load opens on gets the same treatment as a click.
  useEffect(() => {
    if (!autoSelectedRef.current || selectedVersion == null) return;
    autoSelectedRef.current = false;
    selectVersion(selectedVersion);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per load, after hiddenChangeOf reflects it
  }, [hiddenChangeOf, selectedVersion]);

  const isCurrent = !!selected?.current;
  const canDiff = !isCurrent && selected !== null && current !== null;
  const canRestore = restoreAllowed && !!selected && !isCurrent && selected.restorable;

  const predecessor = selected ? predecessorOf.get(selected.version) ?? null : null;
  // Diff endpoints for the USFM view: [from, to], or null for a snapshot.
  const usfmPair: [VerseHistoryEntry, VerseHistoryEntry] | null =
    !selected
      ? null
      : usfmBase === "previous"
        ? predecessor
          ? [predecessor, selected]
          : null
        : canDiff
          ? [selected, current!]
          : null;
  const usfmOf = (e: VerseHistoryEntry): VerseUsfm => usfmByVersion.get(e.version) ?? { kind: "none" };
  const shown = (u: VerseUsfm) => (u.kind !== "usfm" ? null : showAlignment ? u.text : stripAlignmentNoise(u.text));
  const selectedUsfm = selected ? usfmOf(selected) : null;
  // The USFM view diffs only when both ends rendered; otherwise it shows the
  // selected version alone (or an alert), and the caption must say so.
  const usfmDiffShown =
    !!usfmPair && usfmOf(usfmPair[0]).kind === "usfm" && usfmOf(usfmPair[1]).kind === "usfm";

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            Verse history
          </Typography>
          <Chip
            label={`${bibleVersion} ${chapter}:${verseNum}${verseEnd != null && verseEnd > verseNum ? `-${verseEnd}` : ""}`}
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
                      onClick={() => selectVersion(e.version)}
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
                            {hiddenChangeOf.has(e.version) && (
                              <Tooltip title={HIDDEN_CHANGE_TIP[hiddenChangeOf.get(e.version)!]}>
                                <Chip
                                  label={HIDDEN_CHANGE_LABEL[hiddenChangeOf.get(e.version)!]}
                                  size="small"
                                  variant="outlined"
                                  color="info"
                                  sx={{ height: 18, fontSize: 10 }}
                                />
                              </Tooltip>
                            )}
                            {!e.restorable && (
                              <Tooltip title="alignment wasn't stored for this version — can't restore it">
                                <Chip label="text only" size="small" variant="outlined" color="warning" sx={{ height: 18, fontSize: 10 }} />
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
                      {viewMode === "usfm"
                        ? usfmDiffShown && usfmPair
                          ? `USFM diff: v${usfmPair[0].version} → v${usfmPair[1].version}`
                          : `USFM of v${selected.version}`
                        : viewMode === "diff" && canDiff
                          ? `diff: v${selected.version} → v${currentVersion}`
                          : `preview of v${selected.version}`}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
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
                  {viewMode === "usfm" && (
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Typography variant="caption" color="text.secondary">
                        compare with
                      </Typography>
                      <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={usfmBase}
                        onChange={(_, v) => {
                          if (v) setUsfmBase(v as UsfmBase);
                        }}
                        sx={{ "& .MuiToggleButton-root": { py: 0, px: 1, fontSize: 11 } }}
                      >
                        <ToggleButton value="previous" disabled={!predecessor}>
                          previous
                        </ToggleButton>
                        <ToggleButton value="current" disabled={!canDiff}>
                          current
                        </ToggleButton>
                      </ToggleButtonGroup>
                      <Box sx={{ flex: 1 }} />
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
                    </Stack>
                  )}
                  {viewMode === "usfm" && selectedUsfm ? (
                    selectedUsfm.kind !== "usfm" ? (
                      <Alert severity="info" sx={{ py: 0 }}>
                        {selectedUsfm.kind === "error"
                          ? "USFM unavailable: this version's stored tree could not be rendered."
                          : "Markers and alignment weren't stored for this version; only plain text is available."}
                      </Alert>
                    ) : usfmDiffShown && usfmPair ? (
                      <TextDiff from={shown(usfmOf(usfmPair[0]))} to={shown(usfmOf(usfmPair[1]))} mono />
                    ) : (
                      <>
                        {usfmPair && (
                          <Alert severity="info" sx={{ py: 0 }}>
                            USFM unavailable for v
                            {(usfmOf(usfmPair[0]).kind === "usfm" ? usfmPair[1] : usfmPair[0]).version}; showing v
                            {selected.version} alone.
                          </Alert>
                        )}
                        <TextPreview value={shown(selectedUsfm)} mono />
                      </>
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

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
  Divider,
  CircularProgress,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { api, type RowHistoryEntry, type RowKind } from "../sync/api";
import { diffWords } from "../lib/wordDiff";
import {
  defaultPreviousHistoryVersion,
  type HistoryFieldSpec,
  type RowSnapshot,
} from "./rowHistoryFields";

interface Props {
  open: boolean;
  kind: RowKind;
  rowId: string;
  book: string;
  fields: HistoryFieldSpec[];
  // Dialog heading, e.g. "Note history" / "Question history".
  title: string;
  // The actual row.version — monotonically increasing. Only used to label the
  // header "(restored)" when it disagrees with effectiveVersion; the dialog
  // itself never PATCHes.
  currentVersion: number;
  // False puts the dialog in view-only mode. Set while the row is locked (an
  // AI pipeline is mid-flight), where the server would reject the restore
  // PATCH with 409 chapter_locked anyway.
  canRestore?: boolean;
  // The version the chip displays — equals `restored_from_version` if the
  // latest edit was a revert, otherwise equals currentVersion. The dialog
  // surfaces this entry as "current"; the restore entry itself is also listed,
  // labelled "restored from v{N}" (issue #539 item 4).
  effectiveVersion: number;
  onClose: () => void;
  // Fires the chosen version's snapshot + the version number it came from
  // back to the card, which PATCHes through the normal save pipe. The
  // server marks that PATCH as a revert via the row's restored_from_version
  // column so this dialog can keep hiding it next time around.
  onUseVersion: (snapshot: RowSnapshot, fromVersion: number) => void;
}

const fmtTime = (epochSec: number) =>
  new Date(epochSec * 1000).toLocaleString();

const userLabel = (e: RowHistoryEntry) => {
  if (!e.user) return "unknown";
  return e.user.full_name || e.user.username || `user #${e.user.id}`;
};

const tsvToDisplay = (s: string | null) => (s ?? "").replace(/\\n/g, "\n");

const pick = (entry: RowHistoryEntry | null, fields: HistoryFieldSpec[]) => {
  if (!entry) return null;
  const out: RowSnapshot = {};
  for (const f of fields) {
    out[f.key] = (entry.snapshot[f.key] as string | null) ?? null;
  }
  return out;
};

type ViewMode = "snapshot" | "diff";

export function RowHistoryDialog({
  open,
  kind,
  rowId,
  book,
  fields,
  title,
  currentVersion,
  canRestore = true,
  effectiveVersion,
  onClose,
  onUseVersion,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<RowHistoryEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("snapshot");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getRowHistory(kind, rowId, book)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
        // See defaultPreviousHistoryVersion — exclude only the live restore
        // entry, not every historical one (issue #623).
        setSelectedVersion(
          defaultPreviousHistoryVersion(
            res.versions,
            currentVersion,
            effectiveVersion,
          ),
        );
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
  }, [open, kind, rowId, book, currentVersion, effectiveVersion]);

  // Most recent first. EVERY entry is listed, restores included (issue #539
  // item 4). This used to drop every entry with a restored_from_version, on the
  // theory that a restore is a phantom whose snapshot merely repeats the
  // version it restored. That is only true of a restore to content the row
  // already held — which the server no longer writes at all (rows.ts's no-op
  // short-circuit) — while a restore that DID change the row was being hidden
  // along with it, taking a real human version out of the recovery net: the
  // reported case was a translator's v7 vanishing from her own history.
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.version - a.version),
    [entries],
  );

  const selected = useMemo(
    () => entries.find((e) => e.version === selectedVersion) ?? null,
    [entries, selectedVersion],
  );

  const selectedSnapshot = useMemo(
    () => pick(selected, fields),
    [selected, fields],
  );

  const effectiveEntry = useMemo(
    () => entries.find((e) => e.version === effectiveVersion) ?? null,
    [entries, effectiveVersion],
  );
  const effectiveSnapshot = useMemo(
    () => pick(effectiveEntry, fields),
    [effectiveEntry, fields],
  );

  // "already what you're looking at" — true for the effective entry (whose
  // snapshot IS the current text) and for the live version itself, which after a
  // restore is a different number carrying that same text. Both would diff to
  // nothing, so neither offers the diff toggle or a restore button.
  const isCurrent =
    selected?.version === effectiveVersion || selected?.version === currentVersion;
  const canDiff = !isCurrent && selected !== null && effectiveSnapshot !== null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            {title}
          </Typography>
          <Chip
            label={rowId}
            size="small"
            variant="outlined"
            sx={{ fontFamily: "monospace", height: 22 }}
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            current: v{effectiveVersion}
            {effectiveVersion !== currentVersion ? " (restored)" : ""}
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
                  const isSelected = e.version === selectedVersion;
                  // "current" marks the row's LIVE version, not the version
                  // whose text it happens to be showing. Those are the same
                  // number except after a restore, and keying the chip on
                  // effectiveVersion there put the blue `current` chip on an
                  // OLDER entry while the newest one sat unmarked — which reads
                  // as "v8 is newer than current", i.e. not live. The live entry
                  // now carries the chip and says where its text came from
                  // ("current · restored from v3"); the header keeps telling the
                  // version-number story ("current: v3 (restored)").
                  const isLive = e.version === currentVersion;
                  const restoredFrom = e.restored_from_version;
                  return (
                    <ListItemButton
                      key={e.version}
                      selected={isSelected}
                      onClick={() => setSelectedVersion(e.version)}
                    >
                      <ListItemText
                        // Both slots hold block-level children (a Stack /
                        // Typography divs), so neither can default to <p>
                        // without tripping React's DOM-nesting warning.
                        primaryTypographyProps={{ component: "div" }}
                        secondaryTypographyProps={{ component: "div" }}
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: "monospace", fontWeight: 600 }}
                            >
                              v{e.version}
                            </Typography>
                            {isLive && (
                              <Chip
                                label={
                                  restoredFrom != null
                                    ? `current · restored from v${restoredFrom}`
                                    : "current"
                                }
                                size="small"
                                color="primary"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {!isLive && restoredFrom != null && (
                              <Chip
                                label={`restored from v${restoredFrom}`}
                                size="small"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {e.action === "create" && (
                              <Chip
                                label="created"
                                size="small"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {e.action === "imported" && (
                              <Chip
                                label="imported"
                                size="small"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {e.action === "delete" && (
                              <Chip
                                label="deleted"
                                size="small"
                                color="error"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                          </Stack>
                        }
                        secondary={
                          <>
                            <Typography variant="caption" component="div">
                              {fmtTime(e.created_at)}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              component="div"
                            >
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
              {selectedSnapshot ? (
                <Stack spacing={1.5}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="caption" color="text.secondary">
                      {viewMode === "diff" && canDiff
                        ? `diff: v${selected!.version} → v${effectiveVersion}`
                        : `preview of v${selected?.version}`}
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
                    </ToggleButtonGroup>
                  </Stack>
                  {fields.map((f) => {
                    const show = (v: string | null) =>
                      f.raw ? v : tsvToDisplay(v);
                    return (
                      <Box key={f.key}>
                        {f.dividerBefore && <Divider sx={{ mb: 1.5 }} />}
                        {viewMode === "diff" && canDiff ? (
                          <DiffPreview
                            label={f.label}
                            from={show(selectedSnapshot[f.key])}
                            to={show(effectiveSnapshot![f.key])}
                            rtl={f.rtl}
                          />
                        ) : (
                          <FieldPreview
                            label={f.label}
                            value={show(selectedSnapshot[f.key])}
                            rtl={f.rtl}
                          />
                        )}
                      </Box>
                    );
                  })}
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
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          disabled={!selected || isCurrent || loading || !canRestore}
          onClick={() => {
            if (!selected || !selectedSnapshot || !canRestore) return;
            onUseVersion(selectedSnapshot, selected.version);
            onClose();
          }}
        >
          {!canRestore
            ? "Locked"
            : isCurrent
              ? "Already current"
              : selected
                ? `Switch to v${selected.version}`
                : "Switch"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function FieldPreview({
  label,
  value,
  rtl,
}: {
  label: string;
  value: string | null;
  rtl?: boolean;
}) {
  return (
    <Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          color: "text.secondary",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          mt: 0.5,
          p: 1,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "grey.50",
          minHeight: 32,
          whiteSpace: "pre-wrap",
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          fontSize: rtl ? 20 : 13,
          direction: rtl ? "rtl" : "ltr",
          textAlign: rtl ? "right" : "left",
          color: value ? "text.primary" : "text.disabled",
        }}
      >
        {value || "(empty)"}
      </Box>
    </Box>
  );
}

function DiffPreview({
  label,
  from,
  to,
  rtl,
}: {
  label: string;
  from: string | null;
  to: string | null;
  rtl?: boolean;
}) {
  const fromStr = from ?? "";
  const toStr = to ?? "";
  const ops = useMemo(() => diffWords(fromStr, toStr), [fromStr, toStr]);
  const identical = ops.every((o) => o.type === "eq");
  return (
    <Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          color: "text.secondary",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          mt: 0.5,
          p: 1,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "grey.50",
          minHeight: 32,
          whiteSpace: "pre-wrap",
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          fontSize: rtl ? 20 : 13,
          direction: rtl ? "rtl" : "ltr",
          textAlign: rtl ? "right" : "left",
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
    </Box>
  );
}

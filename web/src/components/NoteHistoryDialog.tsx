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
import { api, type RowHistoryEntry } from "../sync/api";

interface NoteSnapshot {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

interface Props {
  open: boolean;
  noteId: string;
  // The actual row.version — monotonically increasing, used as the
  // If-Match expectation when we PATCH.
  currentVersion: number;
  // The version the chip displays — equals `restored_from_version` if the
  // latest edit was a revert, otherwise equals currentVersion. The dialog
  // surfaces this entry as "current" and hides revert phantoms from the
  // list (their snapshot is identical to the version they restored).
  effectiveVersion: number;
  onClose: () => void;
  // Fires the chosen version's snapshot + the version number it came from
  // back to the card, which PATCHes through the normal save pipe. The
  // server marks that PATCH as a revert via the row's restored_from_version
  // column so this dialog can keep hiding it next time around.
  onUseVersion: (snapshot: NoteSnapshot, fromVersion: number) => void;
}

const fmtTime = (epochSec: number) =>
  new Date(epochSec * 1000).toLocaleString();

const userLabel = (e: RowHistoryEntry) => {
  if (!e.user) return "unknown";
  return e.user.full_name || e.user.username || `user #${e.user.id}`;
};

const tsvToDisplay = (s: string | null) => (s ?? "").replace(/\\n/g, "\n");

type ViewMode = "snapshot" | "diff";

export function NoteHistoryDialog({
  open,
  noteId,
  currentVersion,
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
      .getRowHistory("tn", noteId)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
        // Default selection: most recent *visible* entry that isn't the
        // effective-current one, so the dialog opens showing "what was
        // here before this one".
        const visible = res.versions.filter(
          (v) => v.restored_from_version == null,
        );
        const previous = [...visible]
          .reverse()
          .find((v) => v.version !== effectiveVersion);
        setSelectedVersion(
          previous?.version ?? visible.at(-1)?.version ?? null,
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
  }, [open, noteId, effectiveVersion]);

  // Most recent first; phantom revert entries (same snapshot as the
  // version they restored) are filtered out — the user wanted "the other
  // 3 accessible", not the empty v(current+1) we just wrote.
  const ordered = useMemo(
    () =>
      [...entries]
        .filter((e) => e.restored_from_version == null)
        .sort((a, b) => b.version - a.version),
    [entries],
  );

  const selected = useMemo(
    () => entries.find((e) => e.version === selectedVersion) ?? null,
    [entries, selectedVersion],
  );

  const selectedSnapshot: NoteSnapshot | null = selected
    ? {
        quote: (selected.snapshot.quote as string | null) ?? null,
        note: (selected.snapshot.note as string | null) ?? null,
        support_reference:
          (selected.snapshot.support_reference as string | null) ?? null,
      }
    : null;

  const effectiveEntry = useMemo(
    () => entries.find((e) => e.version === effectiveVersion) ?? null,
    [entries, effectiveVersion],
  );
  const effectiveSnapshot: NoteSnapshot | null = effectiveEntry
    ? {
        quote: (effectiveEntry.snapshot.quote as string | null) ?? null,
        note: (effectiveEntry.snapshot.note as string | null) ?? null,
        support_reference:
          (effectiveEntry.snapshot.support_reference as string | null) ?? null,
      }
    : null;

  const isCurrent = selected?.version === effectiveVersion;
  const canDiff = !isCurrent && selected !== null && effectiveSnapshot !== null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            Note history
          </Typography>
          <Chip
            label={noteId}
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
                  const isLive = e.version === effectiveVersion;
                  return (
                    <ListItemButton
                      key={e.version}
                      selected={isSelected}
                      onClick={() => setSelectedVersion(e.version)}
                    >
                      <ListItemText
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
                                label="current"
                                size="small"
                                color="primary"
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
                  {viewMode === "diff" && canDiff ? (
                    <>
                      <DiffPreview
                        label="Support ref"
                        from={selectedSnapshot.support_reference}
                        to={effectiveSnapshot!.support_reference}
                      />
                      <DiffPreview
                        label="Quote"
                        from={tsvToDisplay(selectedSnapshot.quote)}
                        to={tsvToDisplay(effectiveSnapshot!.quote)}
                        rtl
                      />
                      <Divider />
                      <DiffPreview
                        label="Note"
                        from={tsvToDisplay(selectedSnapshot.note)}
                        to={tsvToDisplay(effectiveSnapshot!.note)}
                      />
                    </>
                  ) : (
                    <>
                      <FieldPreview
                        label="Support ref"
                        value={selectedSnapshot.support_reference}
                      />
                      <FieldPreview
                        label="Quote"
                        value={tsvToDisplay(selectedSnapshot.quote)}
                        rtl
                      />
                      <Divider />
                      <FieldPreview
                        label="Note"
                        value={tsvToDisplay(selectedSnapshot.note)}
                      />
                    </>
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
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          disabled={!selected || isCurrent || loading}
          onClick={() => {
            if (!selected || !selectedSnapshot) return;
            onUseVersion(selectedSnapshot, selected.version);
            onClose();
          }}
        >
          {isCurrent
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
          fontSize: rtl ? 19 : 13,
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

type DiffOp = { type: "eq" | "add" | "del"; text: string };

// Word-level LCS diff. Tokenizes runs of word chars vs non-word chars so
// whitespace + punctuation stay in their own tokens (a comma flipping to a
// period highlights cleanly without dragging the surrounding word along).
// Strings up to a few hundred tokens are plenty fast on a DP table.
function tokenize(s: string): string[] {
  return s.match(/\w+|\W+/g) ?? [];
}

function diffWords(a: string, b: string): DiffOp[] {
  const A = tokenize(a);
  const B = tokenize(b);
  const m = A.length;
  const n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        A[i - 1] === B[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      out.push({ type: "eq", text: A[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ type: "del", text: A[i - 1] });
      i--;
    } else {
      out.push({ type: "add", text: B[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ type: "del", text: A[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ type: "add", text: B[j - 1] });
    j--;
  }
  out.reverse();
  // Merge runs of same-type ops so the rendered output has fewer spans.
  const merged: DiffOp[] = [];
  for (const op of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
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
          fontSize: rtl ? 19 : 13,
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

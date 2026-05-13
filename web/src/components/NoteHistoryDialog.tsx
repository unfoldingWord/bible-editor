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
  currentVersion: number;
  onClose: () => void;
  // Fired when the user picks a version to switch to. Receives the snapshot
  // values to apply. The card's parent turns this into a normal PATCH —
  // which bumps to v(current+1), so every prior version stays in edit_log.
  onUseVersion: (snapshot: NoteSnapshot, fromVersion: number) => void;
}

const fmtTime = (epochSec: number) =>
  new Date(epochSec * 1000).toLocaleString();

const userLabel = (e: RowHistoryEntry) => {
  if (!e.user) return "unknown";
  return e.user.full_name || e.user.username || `user #${e.user.id}`;
};

const tsvToDisplay = (s: string | null) => (s ?? "").replace(/\\n/g, "\n");

export function NoteHistoryDialog({
  open,
  noteId,
  currentVersion,
  onClose,
  onUseVersion,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<RowHistoryEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

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
        // Default selection: the most recent entry that isn't the current
        // one, so the dialog opens showing "what was here before".
        const previous = [...res.versions]
          .reverse()
          .find((v) => v.version !== currentVersion);
        setSelectedVersion(previous?.version ?? res.versions.at(-1)?.version ?? null);
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
  }, [open, noteId, currentVersion]);

  // Most recent first.
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.version - a.version),
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

  const isCurrent = selected?.version === currentVersion;

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
                  const isSelected = e.version === selectedVersion;
                  const isLive = e.version === currentVersion;
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

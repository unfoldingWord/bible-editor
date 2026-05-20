// Translator-triggered re-import of selected resources for a chapter range
// directly from Door43. Maintenance lane (NOT the first-time bootstrap path,
// which is /api/books/:book/import — destructive). The backend pristine-only
// rule means edits already in flight are never clobbered: see
// api/src/bookReimport.ts.

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  TextField,
  Typography,
} from "@mui/material";
import { ApiError, api, type ReimportResource, type ReimportResponse } from "../sync/api";
import { parseChapterRange } from "../lib/refParser";

interface Props {
  open: boolean;
  onClose: () => void;
  book: string;
  currentChapter: number;
  onMessage?: (msg: string) => void;
  /** Called after a successful import so the parent can refetch the chapter. */
  onImported?: () => void;
}

interface ResourceState {
  ult: boolean;
  ust: boolean;
  tn: boolean;
  tq: boolean;
  twl: boolean;
}

const LS_KEY = "bible-editor.import.door43.options";
const DEFAULT_STATE: ResourceState = {
  ult: false,
  ust: false,
  tn: false,
  tq: false,
  twl: false,
};

function loadOpts(): ResourceState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ResourceState>;
    return {
      ult: !!parsed.ult,
      ust: !!parsed.ust,
      tn: !!parsed.tn,
      tq: !!parsed.tq,
      twl: !!parsed.twl,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveOpts(opts: ResourceState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(opts));
  } catch {
    /* private mode etc. */
  }
}

function summarize(res: ReimportResponse): string {
  const t = res.totals;
  const parts: string[] = [];
  if (t.updated) parts.push(`${t.updated} updated`);
  if (t.inserted) parts.push(`${t.inserted} inserted`);
  if (t.skipped_edited) parts.push(`${t.skipped_edited} skipped (already edited)`);
  if (t.skipped_locked) parts.push(`${t.skipped_locked} skipped (AI pipeline running)`);
  if (t.dcs_404) parts.push(`${t.dcs_404} resource(s) not on DCS`);
  if (parts.length === 0) return `Imported ${res.book} — no changes.`;
  return `Imported ${res.book}: ${parts.join(", ")}.`;
}

export function ImportFromDoor43Dialog({
  open,
  onClose,
  book,
  currentChapter,
  onMessage,
  onImported,
}: Props) {
  const [opts, setOpts] = useState<ResourceState>(() => loadOpts());
  const [refInput, setRefInput] = useState<string>(String(currentChapter));
  const [submitting, setSubmitting] = useState(false);

  // Reload last-used resource selection and reset chapter input each time the
  // dialog opens (chapter follows whatever the user is currently looking at).
  useEffect(() => {
    if (open) {
      setOpts(loadOpts());
      setRefInput(String(currentChapter));
    }
  }, [open, currentChapter]);

  const refParsed = useMemo(() => parseChapterRange(refInput, book), [refInput, book]);
  const nothingSelected = !opts.ult && !opts.ust && !opts.tn && !opts.tq && !opts.twl;
  const canSubmit = !submitting && refParsed.ok && !nothingSelected;

  const submit = async () => {
    if (!refParsed.ok) return;
    const resources: ReimportResource[] = [];
    if (opts.ult) resources.push("ult");
    if (opts.ust) resources.push("ust");
    if (opts.tn) resources.push("tn");
    if (opts.tq) resources.push("tq");
    if (opts.twl) resources.push("twl");
    if (resources.length === 0) return;

    const { startChapter, endChapter } = refParsed.range;
    const chapters: number[] = [];
    for (let c = startChapter; c <= endChapter; c++) chapters.push(c);

    setSubmitting(true);
    try {
      const res = await api.reimportFromDoor43(refParsed.range.book, { chapters, resources });
      saveOpts(opts);
      onMessage?.(summarize(res));
      onImported?.();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; detail?: string } | undefined;
        if (e.status === 404) {
          onMessage?.(`Cannot re-import: ${refParsed.range.book} hasn't been imported yet. Open the book once first.`);
        } else if (e.status === 409) {
          onMessage?.(`Another import is already running for ${refParsed.range.book}. Try again shortly.`);
        } else if (e.status === 401) {
          onMessage?.("Sign in to import from Door43.");
        } else if (e.status === 422) {
          onMessage?.(`Invalid request: ${body?.detail ?? body?.error ?? "check chapter/resource input"}`);
        } else {
          onMessage?.(`Import failed: ${body?.error ?? e.message}`);
        }
      } else {
        onMessage?.("Import failed. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !submitting && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>Import from Door43</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Pulls fresh ULT / UST / TN / TQ / TWL content for the selected chapters
          straight from Door43. Rows already edited by translators are skipped —
          this is a safe re-seed, not an overwrite.
        </DialogContentText>
        <Box sx={{ mt: 2, display: "flex", alignItems: "flex-start", gap: 1.5 }}>
          <Typography sx={{ pt: 1, fontWeight: 500 }}>{book}</Typography>
          <TextField
            label="Chapter or range"
            value={refInput}
            onChange={(e) => setRefInput(e.target.value.replace(/[^\d-]/g, ""))}
            disabled={submitting}
            fullWidth
            size="small"
            autoFocus
            error={!refParsed.ok}
            inputProps={{ inputMode: "numeric", pattern: "[0-9-]*" }}
            helperText={
              refParsed.ok
                ? refParsed.range.startChapter === refParsed.range.endChapter
                  ? `Imports ${refParsed.range.book} ${refParsed.range.startChapter}.`
                  : `Imports ${refParsed.range.book} ${refParsed.range.startChapter}-${refParsed.range.endChapter}.`
                : refParsed.error
            }
          />
        </Box>
        <Box sx={{ mt: 2 }}>
          <DialogContentText sx={{ mb: 1, fontSize: "0.875rem" }}>
            What to import:
          </DialogContentText>
          <FormGroup>
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.ult}
                  onChange={(_, v) => setOpts((o) => ({ ...o, ult: v }))}
                  disabled={submitting}
                />
              }
              label="ULT (literal text)"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.ust}
                  onChange={(_, v) => setOpts((o) => ({ ...o, ust: v }))}
                  disabled={submitting}
                />
              }
              label="UST (simplified text)"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.tn}
                  onChange={(_, v) => setOpts((o) => ({ ...o, tn: v }))}
                  disabled={submitting}
                />
              }
              label="Translation notes (TN)"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.tq}
                  onChange={(_, v) => setOpts((o) => ({ ...o, tq: v }))}
                  disabled={submitting}
                />
              }
              label="Translation questions (TQ)"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.twl}
                  onChange={(_, v) => setOpts((o) => ({ ...o, twl: v }))}
                  disabled={submitting}
                />
              }
              label="Translation word links (TWL)"
            />
          </FormGroup>
          {nothingSelected ? (
            <DialogContentText sx={{ mt: 1, fontSize: "0.8125rem", color: "warning.main" }}>
              Select at least one resource to import.
            </DialogContentText>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={!canSubmit}
          startIcon={submitting ? <CircularProgress size={14} /> : undefined}
        >
          Import
        </Button>
      </DialogActions>
    </Dialog>
  );
}

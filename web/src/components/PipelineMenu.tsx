// Per-chapter trigger UI for bp-assistant pipelines (see
// docs/ai-pipeline-integration.md). Three pipeline types, ~1h each, run on
// the bot; we kick off and surface status via the bottom pill.

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Menu,
  MenuItem,
  ListItemText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  CircularProgress,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Box,
  TextField,
  InputAdornment,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { ApiError } from "../sync/api";
import type {
  PipelineChainStep,
  PipelineConflictBody,
  PipelineConflictExisting,
  PipelineRequestOptions,
  PipelineType,
} from "../sync/api";
import { getSessionKey, pipelineStore, type PipelineJob } from "../sync/pipelineStore";
import { parseChapterRange } from "../lib/refParser";

interface Props {
  book: string;
  chapter: number;
  onMessage?: (msg: string) => void;
}

interface PipelineOption {
  key: string;
  type: PipelineType;
  label: string;
  description: string;
  approxDuration: string;
  /**
   * When set, fires this pipeline plus a chain of cross-type follow-ups
   * after each step completes. The chapter lock holds across the full run.
   * Currently only used by the "Generate everything" macro.
   */
  followUpChain?: PipelineChainStep[];
}

const OPTIONS: PipelineOption[] = [
  {
    key: "generate",
    type: "generate",
    label: "Generate ULT + UST",
    description: "Aligned literal + simplified text and a draft issues list for the chapter.",
    approxDuration: "~60–100 min",
  },
  {
    key: "notes",
    type: "notes",
    label: "Write translation notes",
    description: "Translation notes (tn) for every verse in the chapter.",
    approxDuration: "~30–60 min",
  },
  {
    key: "tqs",
    type: "tqs",
    label: "Write translation questions",
    description: "Translation questions (tq) aligned to the current ULT/UST.",
    approxDuration: "~30–60 min",
  },
];

// Internal 4-checkbox state for the generate dialog. Maps to the wire shape
// (contract §3) at submit time via buildGenerateOptions. The contract's align
// flags are mutually exclusive within one call, so asymmetric combos
// (e.g. ULT-aligned + UST-not-aligned) are split into a parent call plus
// a server-side follow-up — see PipelineStartRequest.followUpOptions.
interface GenUiState {
  ult: boolean;
  ust: boolean;
  ultAlignment: boolean;
  ustAlignment: boolean;
}

const GEN_OPTS_LS = "bible-editor.pipeline.generate.options";
const DEFAULT_GEN_OPTS: GenUiState = {
  ult: true,
  ust: true,
  ultAlignment: true,
  ustAlignment: true,
};

function loadGenOpts(): GenUiState {
  try {
    const raw = localStorage.getItem(GEN_OPTS_LS);
    if (!raw) return DEFAULT_GEN_OPTS;
    const parsed = JSON.parse(raw) as Partial<GenUiState>;
    return {
      ult: parsed.ult ?? true,
      ust: parsed.ust ?? true,
      ultAlignment: parsed.ultAlignment ?? true,
      ustAlignment: parsed.ustAlignment ?? true,
    };
  } catch {
    return DEFAULT_GEN_OPTS;
  }
}

function saveGenOpts(opts: GenUiState) {
  try {
    localStorage.setItem(GEN_OPTS_LS, JSON.stringify(opts));
  } catch {
    /* private mode etc. */
  }
}

// Translate the UI state to the on-the-wire shape per the contract table.
// Returns a primary `options` plus an optional `followUpOptions` — the
// latter is only set when the user requested asymmetric alignment across
// ULT and UST (which the upstream can't express in a single call).
//
// Order for asymmetric: ULT first, then UST. Translators read ULT-first in
// the editor and the chapter is locked during the entire two-call sequence,
// so the visible order matches the reading order.
interface GenerateWireShape {
  options?: PipelineRequestOptions;
  followUpOptions?: PipelineRequestOptions;
}

function singleContentOptions(
  side: "ult" | "ust",
  aligned: boolean,
): PipelineRequestOptions {
  return aligned ? { contentTypes: [side] } : { contentTypes: [side], textOnly: true };
}

function buildGenerateWire(g: GenUiState): GenerateWireShape {
  if (g.ult && g.ust) {
    if (g.ultAlignment === g.ustAlignment) {
      // Symmetric — fits one call.
      return g.ultAlignment ? {} : { options: { textOnly: true } };
    }
    // Asymmetric — split into parent + follow-up. ULT first.
    return {
      options: singleContentOptions("ult", g.ultAlignment),
      followUpOptions: singleContentOptions("ust", g.ustAlignment),
    };
  }
  if (g.ult) return { options: singleContentOptions("ult", g.ultAlignment) };
  if (g.ust) return { options: singleContentOptions("ust", g.ustAlignment) };
  return {};
}

const TYPE_LABEL: Record<PipelineType, string> = {
  generate: "Generate ULT + UST",
  notes: "Translation notes",
  tqs: "Translation questions",
};

function relativeMinutes(seconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - seconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)} min`;
}

export function PipelineMenu({ book, chapter, onMessage }: Props) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<PipelineOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
  const [genOpts, setGenOpts] = useState<GenUiState>(() => loadGenOpts());
  const [conflict, setConflict] = useState<PipelineConflictExisting | null>(null);
  const [refInput, setRefInput] = useState("");

  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);

  // Re-load from localStorage whenever the dialog opens for a generate run, so
  // a change made in a different tab is reflected.
  useEffect(() => {
    if (confirm?.type === "generate") setGenOpts(loadGenOpts());
    if (confirm) setRefInput(String(chapter));
  }, [confirm, book, chapter]);

  const genNothingSelected = !genOpts.ult && !genOpts.ust;
  const refParsed = useMemo(() => parseChapterRange(refInput, book), [refInput, book]);

  const runningType = (type: PipelineType): PipelineJob | undefined =>
    activeJobs.find(
      (j) =>
        j.pipeline_type === type &&
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        j.state !== "done",
    );

  const close = () => setAnchorEl(null);

  const start = async () => {
    if (!confirm) return;
    if (!refParsed.ok) return;
    const isMacro = Boolean(confirm.followUpChain);
    if (confirm.type === "generate" && !isMacro && genNothingSelected) return;
    const { book: rangeBook, startChapter, endChapter } = refParsed.range;
    const chapters: number[] = [];
    for (let c = startChapter; c <= endChapter; c++) chapters.push(c);
    setSubmitting(true);
    try {
      let wire: GenerateWireShape = {};
      if (confirm.type === "generate" && !isMacro) {
        wire = buildGenerateWire(genOpts);
        saveGenOpts(genOpts);
      }
      let startedCount = 0;
      for (const ch of chapters) {
        const res = await pipelineStore.start({
          pipelineType: confirm.type,
          book: rangeBook,
          startChapter: ch,
          endChapter: ch,
          sessionKey: getSessionKey(),
          ...(wire.options ? { options: wire.options } : {}),
          ...(wire.followUpOptions ? { followUpOptions: wire.followUpOptions } : {}),
          ...(confirm.followUpChain ? { followUpChain: confirm.followUpChain } : {}),
        });
        if (res.status !== "already_running") startedCount++;
      }
      const rangeLabel =
        chapters.length === 1
          ? `${rangeBook} ${startChapter}`
          : `${rangeBook} ${startChapter}-${endChapter}`;
      if (startedCount > 0) {
        const suffix =
          chapters.length > 1
            ? ` (${startedCount} runs)`
            : isMacro
              ? ` (${1 + (confirm.followUpChain?.length ?? 0)} runs)`
              : wire.followUpOptions
                ? " (2 runs)"
                : "";
        onMessage?.(`Started: ${confirm.label} for ${rangeLabel}${suffix}`);
      }
      // already_running: pipelineStore emits a focus event that opens the
      // status panel on the existing run — no toast needed.
      setConfirm(null);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as PipelineConflictBody | { error?: string; jobId?: string } | undefined;
        if (e.status === 409 && body?.error === "conflict") {
          const enriched = (body as PipelineConflictBody).existing;
          if (enriched) {
            setConflict(enriched);
            setConfirm(null);
          } else {
            // Conflict with a job started outside the editor (e.g. Zulip).
            // We have no metadata to show — fall back to the bare toast.
            onMessage?.(`Another translator already started this pipeline (job ${body.jobId ?? "unknown"}).`);
            setConfirm(null);
          }
        } else if (e.status === 401) {
          onMessage?.("Sign in to start a pipeline.");
        } else {
          onMessage?.(`Could not start: ${body?.error ?? e.message}`);
        }
      } else {
        onMessage?.("Could not start the pipeline. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<AutoAwesomeIcon fontSize="small" />}
        onClick={(e) => setAnchorEl(e.currentTarget)}
      >
        AI pipelines
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={close}>
        {OPTIONS.map((opt) => {
          const running = runningType(opt.type);
          return (
            <MenuItem
              key={opt.key}
              disabled={Boolean(running)}
              onClick={() => {
                close();
                setConfirm(opt);
              }}
            >
              <ListItemText
                primary={opt.label}
                secondary={
                  running
                    ? `Already running (${running.state})`
                    : `${opt.description} ${opt.approxDuration}`
                }
              />
            </MenuItem>
          );
        })}
      </Menu>
      <Dialog open={Boolean(confirm)} onClose={() => !submitting && setConfirm(null)}>
        <DialogTitle>Start AI pipeline</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm
              ? `Run ${confirm.label}? ${confirm.approxDuration} per chapter — you can keep working in other chapters while it runs.`
              : ""}
          </DialogContentText>
          <Box sx={{ mt: 2 }}>
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
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">{book}</InputAdornment>
                ),
              }}
              helperText={
                refParsed.ok
                  ? refParsed.range.startChapter === refParsed.range.endChapter
                    ? `Runs once for ${refParsed.range.book} ${refParsed.range.startChapter}.`
                    : `Runs ${refParsed.range.endChapter - refParsed.range.startChapter + 1} times across ${refParsed.range.book} ${refParsed.range.startChapter}-${refParsed.range.endChapter}.`
                  : refParsed.error
              }
            />
          </Box>
          {confirm?.type === "generate" && !confirm.followUpChain ? (
            <Box sx={{ mt: 2 }}>
              <DialogContentText sx={{ mb: 1, fontSize: "0.875rem" }}>
                What to generate:
              </DialogContentText>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ult}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ult: v }))}
                      disabled={submitting}
                    />
                  }
                  label="ULT (literal text)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ultAlignment}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ultAlignment: v }))}
                      disabled={submitting || !genOpts.ult}
                    />
                  }
                  label="ULT alignment"
                  sx={{ ml: 3 }}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ust}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ust: v }))}
                      disabled={submitting}
                    />
                  }
                  label="UST (simplified text)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ustAlignment}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ustAlignment: v }))}
                      disabled={submitting || !genOpts.ust}
                    />
                  }
                  label="UST alignment"
                  sx={{ ml: 3 }}
                />
              </FormGroup>
              {genOpts.ult && genOpts.ust && genOpts.ultAlignment !== genOpts.ustAlignment ? (
                <DialogContentText sx={{ mt: 1, fontSize: "0.75rem", fontStyle: "italic" }}>
                  Asymmetric alignment: runs as two pipelines back-to-back (ULT first).
                </DialogContentText>
              ) : null}
              {genNothingSelected ? (
                <DialogContentText sx={{ mt: 1, fontSize: "0.8125rem", color: "warning.main" }}>
                  Select at least one of ULT or UST.
                </DialogContentText>
              ) : null}
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={start}
            variant="contained"
            disabled={
              submitting ||
              !refParsed.ok ||
              (confirm?.type === "generate" &&
                !confirm.followUpChain &&
                genNothingSelected)
            }
            startIcon={submitting ? <CircularProgress size={14} /> : undefined}
          >
            Start
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(conflict)} onClose={() => setConflict(null)}>
        <DialogTitle>Already running</DialogTitle>
        <DialogContent>
          {conflict && (
            <>
              <DialogContentText>
                {conflict.started_by_username
                  ? `${conflict.started_by_username} started `
                  : "Someone already started "}
                <strong>{TYPE_LABEL[conflict.pipeline_type]}</strong> for{" "}
                <strong>
                  {conflict.book} {conflict.start_chapter}
                  {conflict.end_chapter !== conflict.start_chapter
                    ? `–${conflict.end_chapter}`
                    : ""}
                </strong>{" "}
                {relativeMinutes(conflict.created_at)} ago.
              </DialogContentText>
              <DialogContentText sx={{ mt: 1, fontSize: "0.875rem" }}>
                State: <strong>{conflict.state}</strong>
                {conflict.current_skill ? ` · ${conflict.current_skill}` : ""}
                {` · updated ${relativeMinutes(conflict.updated_at)} ago`}
              </DialogContentText>
              <DialogContentText sx={{ mt: 1, fontSize: "0.8125rem", fontStyle: "italic" }}>
                This chapter is locked while the pipeline runs. You can keep
                editing other chapters; the AI output will overwrite this one
                when it completes.
              </DialogContentText>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConflict(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

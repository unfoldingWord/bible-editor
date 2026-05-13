// Per-chapter trigger UI for bp-assistant pipelines (see
// docs/ai-pipeline-integration.md). Three pipeline types, ~1h each, run on
// the bot; we kick off and surface status via the bottom pill.

import { useEffect, useState } from "react";
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
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { ApiError } from "../sync/api";
import type { PipelineRequestOptions, PipelineType } from "../sync/api";
import { getSessionKey, pipelineStore, type PipelineJob } from "../sync/pipelineStore";

interface Props {
  book: string;
  chapter: number;
  onMessage?: (msg: string) => void;
}

interface PipelineOption {
  type: PipelineType;
  label: string;
  description: string;
  approxDuration: string;
}

const OPTIONS: PipelineOption[] = [
  {
    type: "generate",
    label: "Generate ULT + UST",
    description: "Aligned literal + simplified text and a draft issues list for the chapter.",
    approxDuration: "~60–100 min",
  },
  {
    type: "notes",
    label: "Write translation notes",
    description: "Translation notes (tn) for every verse in the chapter.",
    approxDuration: "~30–60 min",
  },
  {
    type: "tqs",
    label: "Write translation questions",
    description: "Translation questions (tq) aligned to the current ULT/UST.",
    approxDuration: "~30–60 min",
  },
];

// Internal 4-checkbox state for the generate dialog. Maps to the wire shape
// (contract §3) at submit time via buildGenerateOptions. We keep four
// checkboxes for clarity but the underlying pipeline doesn't support
// asymmetric alignment — when both content types are on, the alignment pair
// is linked.
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

// Translate the UI state to the on-the-wire options shape per the contract
// table. When both content types are selected, alignment is both-or-neither
// (asymmetric isn't supported in a single call); the UI links the two
// alignment checkboxes so this branch always sees a consistent value.
function buildGenerateOptions(g: GenUiState): PipelineRequestOptions | undefined {
  const bothContent = g.ult && g.ust;
  if (bothContent) {
    if (!g.ultAlignment) return { textOnly: true }; // generate both, push unaligned
    return undefined; // generate both, align (the default)
  }
  if (g.ult) {
    return g.ultAlignment
      ? { contentTypes: ["ult"] }
      : { contentTypes: ["ult"], textOnly: true };
  }
  if (g.ust) {
    return g.ustAlignment
      ? { contentTypes: ["ust"] }
      : { contentTypes: ["ust"], textOnly: true };
  }
  return undefined;
}

export function PipelineMenu({ book, chapter, onMessage }: Props) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<PipelineOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
  const [genOpts, setGenOpts] = useState<GenUiState>(() => loadGenOpts());

  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);

  // Re-load from localStorage whenever the dialog opens for a generate run, so
  // a change made in a different tab is reflected.
  useEffect(() => {
    if (confirm?.type === "generate") setGenOpts(loadGenOpts());
  }, [confirm]);

  const genNothingSelected = !genOpts.ult && !genOpts.ust;

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
    if (confirm.type === "generate" && genNothingSelected) return;
    setSubmitting(true);
    try {
      let options: PipelineRequestOptions | undefined;
      if (confirm.type === "generate") {
        options = buildGenerateOptions(genOpts);
        saveGenOpts(genOpts);
      }
      const res = await pipelineStore.start({
        pipelineType: confirm.type,
        book,
        startChapter: chapter,
        endChapter: chapter,
        sessionKey: getSessionKey(),
        ...(options ? { options } : {}),
      });
      const verb = res.status === "already_running" ? "Already running:" : "Started:";
      onMessage?.(`${verb} ${confirm.label} for ${book} ${chapter}`);
      setConfirm(null);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; jobId?: string } | undefined;
        if (e.status === 409 && body?.error === "conflict") {
          onMessage?.(`Another translator already started this pipeline (job ${body.jobId}).`);
          setConfirm(null);
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
              key={opt.type}
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
              ? `Run ${confirm.label} for ${book} ${chapter}? ${confirm.approxDuration} — you can keep working in other chapters while it runs.`
              : ""}
          </DialogContentText>
          {confirm?.type === "generate" ? (
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
                      // When both content types are selected, the pipeline
                      // aligns both-or-neither — keep the two alignment
                      // checkboxes in lockstep so the user can't pick an
                      // unsupported asymmetric combination.
                      onChange={(_, v) =>
                        setGenOpts((o) =>
                          o.ult && o.ust
                            ? { ...o, ultAlignment: v, ustAlignment: v }
                            : { ...o, ultAlignment: v },
                        )
                      }
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
                      onChange={(_, v) =>
                        setGenOpts((o) =>
                          o.ult && o.ust
                            ? { ...o, ultAlignment: v, ustAlignment: v }
                            : { ...o, ustAlignment: v },
                        )
                      }
                      disabled={submitting || !genOpts.ust}
                    />
                  }
                  label="UST alignment"
                  sx={{ ml: 3 }}
                />
              </FormGroup>
              {genOpts.ult && genOpts.ust ? (
                <DialogContentText sx={{ mt: 1, fontSize: "0.75rem", fontStyle: "italic" }}>
                  Alignment runs for both or neither when generating both ULT and UST.
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
              submitting || (confirm?.type === "generate" && genNothingSelected)
            }
            startIcon={submitting ? <CircularProgress size={14} /> : undefined}
          >
            Start
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

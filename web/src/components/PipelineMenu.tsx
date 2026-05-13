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
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { ApiError } from "../sync/api";
import type { PipelineType } from "../sync/api";
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

export function PipelineMenu({ book, chapter, onMessage }: Props) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<PipelineOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);

  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);

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
    setSubmitting(true);
    try {
      const res = await pipelineStore.start({
        pipelineType: confirm.type,
        book,
        startChapter: chapter,
        endChapter: chapter,
        sessionKey: getSessionKey(),
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={start}
            variant="contained"
            disabled={submitting}
            startIcon={submitting ? <CircularProgress size={14} /> : undefined}
          >
            Start
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

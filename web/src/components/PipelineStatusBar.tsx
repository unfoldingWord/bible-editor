// Bottom-area pill summarizing active AI pipeline runs. Sits to the left of
// SyncStatusBar so they don't overlap. Click expands to list each job with
// its state, current skill, and (for resumable failures) a Retry button.

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Popover,
  Typography,
  Button,
  Divider,
  CircularProgress,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import RefreshIcon from "@mui/icons-material/Refresh";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import { ApiError } from "../sync/api";
import type { PipelineErrorKind, PipelineJobRow, PipelineState } from "../sync/api";
import { getSessionKey, pipelineStore } from "../sync/pipelineStore";

const RESUMABLE_ERROR_KINDS = new Set<PipelineErrorKind>([
  "transient_outage",
  "usage_limit",
  "interrupted",
  "sdk_error",
]);

const TYPE_LABEL: Record<PipelineJobRow["pipeline_type"], string> = {
  generate: "Generate ULT + UST",
  notes: "Translation notes",
  tqs: "Translation questions",
};

// Coarse stage milestones reported via current.skill. For generate, the
// contract documents the 3 transitions explicitly. For notes/tqs the
// skill name comes through directly; we list the ones we expect so the
// stepper has something to anchor to. Unknown skills fall through and
// the bar still shows the pipeline as "running" without a position.
const STAGES: Record<PipelineJobRow["pipeline_type"], string[]> = {
  generate: ["initial-pipeline", "align-all-parallel", "door43-push"],
  notes: ["tn-writer", "parallel-batch", "repo-insert"],
  tqs: ["tq-writer", "repo-insert"],
};

const STAGE_LABEL: Record<string, string> = {
  "initial-pipeline": "Draft",
  "align-all-parallel": "Align",
  "door43-push": "Push",
  "tn-writer": "Draft",
  "parallel-batch": "Batch",
  "tq-writer": "Draft",
  "repo-insert": "Push",
};

function StageBar({
  pipelineType,
  currentSkill,
  state,
}: {
  pipelineType: PipelineJobRow["pipeline_type"];
  currentSkill: string | null;
  state: PipelineState;
}) {
  const stages = STAGES[pipelineType];
  if (!stages || stages.length === 0) return null;
  const currentIdx = currentSkill ? stages.indexOf(currentSkill) : -1;
  // Treat "done" as all stages complete; unknown current_skill while
  // running falls through to "no stage highlighted" (-1) without making
  // the bar lie.
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5, ml: 3 }}>
      {stages.map((skill, i) => {
        const isDone = state === "done" || (currentIdx >= 0 && i < currentIdx);
        const isCurrent = state !== "done" && i === currentIdx;
        return (
          <Stack key={skill} direction="row" alignItems="center" spacing={0.5}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                bgcolor: isDone
                  ? "success.main"
                  : isCurrent
                    ? "primary.main"
                    : "transparent",
                border: 1,
                borderColor: isDone
                  ? "success.main"
                  : isCurrent
                    ? "primary.main"
                    : "divider",
              }}
            />
            <Typography
              variant="caption"
              sx={{
                fontSize: 10,
                fontFamily: "monospace",
                color: isCurrent
                  ? "primary.main"
                  : isDone
                    ? "success.main"
                    : "text.disabled",
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              {STAGE_LABEL[skill] ?? skill}
            </Typography>
            {i < stages.length - 1 && (
              <Box
                sx={{
                  width: 10,
                  height: 1,
                  bgcolor: isDone ? "success.main" : "divider",
                }}
              />
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

function relativeTime(seconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - seconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function stateLabel(state: PipelineState): string {
  switch (state) {
    case "running":
      return "running";
    case "paused_for_outage":
      return "paused (outage)";
    case "paused_for_usage_limit":
      return "paused (daily budget)";
    case "failed":
      return "failed";
    case "done":
      return "done";
  }
}

function StateIcon({ state }: { state: PipelineState }) {
  if (state === "running") return <CircularProgress size={14} />;
  if (state === "done") return <CheckCircleOutlineIcon fontSize="small" color="success" />;
  if (state === "failed") return <ErrorOutlineIcon fontSize="small" color="error" />;
  return <PauseCircleOutlineIcon fontSize="small" color="warning" />;
}

interface ToastMsg {
  id: number;
  text: string;
  kind: "success" | "error" | "info";
}

interface Props {
  toast?: ToastMsg | null;
  onToastClear?: () => void;
}

export function PipelineStatusBar({ toast, onToastClear }: Props = {}) {
  const [jobs, setJobs] = useState<PipelineJobRow[]>([]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => pipelineStore.subscribe(setJobs), []);

  const { active, doneRecent, failed } = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      active: jobs.filter(
        (j) =>
          j.state === "running" ||
          j.state === "paused_for_outage" ||
          j.state === "paused_for_usage_limit",
      ),
      doneRecent: jobs.filter((j) => j.state === "done" && nowSec - j.updated_at < 24 * 3600),
      failed: jobs.filter((j) => j.state === "failed"),
    };
  }, [jobs]);

  const hasAnything = active.length + doneRecent.length + failed.length > 0;

  const retry = async (job: PipelineJobRow) => {
    setRetrying(job.job_id);
    try {
      await pipelineStore.start({
        pipelineType: job.pipeline_type,
        book: job.book,
        startChapter: job.start_chapter,
        endChapter: job.end_chapter,
        sessionKey: job.session_key || getSessionKey(),
      });
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string } | undefined;
        // The store seeds the row again; surfacing the error to the user
        // here is optional. Leave a console crumb.
        console.warn("pipeline retry failed", body?.error ?? e.message);
      }
    } finally {
      setRetrying(null);
    }
  };

  if (!hasAnything && !toast) return null;

  return (
    <>
      <Box
        sx={{
          position: "fixed",
          right: 160,
          bottom: 12,
          zIndex: (t) => t.zIndex.snackbar,
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          {toast && (
            <Tooltip title="dismiss">
              <Chip
                size="small"
                color={toast.kind === "error" ? "error" : toast.kind === "success" ? "success" : "default"}
                label={toast.text}
                onDelete={onToastClear}
              />
            </Tooltip>
          )}
          {hasAnything && (
            <Chip
              icon={<AutoAwesomeIcon />}
              label={
                active.length > 0
                  ? `${active.length} pipeline${active.length === 1 ? "" : "s"} running`
                  : failed.length > 0
                    ? `${failed.length} failed`
                    : "AI ready to review"
              }
              size="small"
              variant="outlined"
              color={active.length > 0 ? "primary" : failed.length > 0 ? "error" : "success"}
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ bgcolor: "background.paper", boxShadow: 2 }}
            />
          )}
        </Stack>
      </Box>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Box sx={{ p: 1.5, minWidth: 320, maxWidth: 420 }}>
          <Typography variant="caption" color="text.secondary">
            AI pipelines
          </Typography>
          <Stack spacing={1} sx={{ mt: 1 }}>
            {jobs.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No pipelines running.
              </Typography>
            )}
            {jobs.map((job, i) => (
              <Box key={job.job_id}>
                {i > 0 && <Divider sx={{ my: 1 }} />}
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Box sx={{ pt: 0.5 }}>
                    <StateIcon state={job.state} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {TYPE_LABEL[job.pipeline_type]} — {job.book} {job.start_chapter}
                      {job.end_chapter !== job.start_chapter ? `–${job.end_chapter}` : ""}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {stateLabel(job.state)}
                      {job.current_skill && !STAGES[job.pipeline_type]?.includes(job.current_skill)
                        ? ` · ${job.current_skill}`
                        : ""}
                      {` · updated ${relativeTime(job.updated_at)}`}
                    </Typography>
                    {job.error_message && (
                      <Typography variant="caption" color="error" display="block">
                        {job.error_message}
                      </Typography>
                    )}
                  </Box>
                  {job.state === "failed" && job.error_kind && RESUMABLE_ERROR_KINDS.has(job.error_kind) && (
                    <Tooltip title="re-POST the start request; the server resumes from its checkpoint">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => void retry(job)}
                          disabled={retrying === job.job_id}
                        >
                          {retrying === job.job_id ? <CircularProgress size={14} /> : <RefreshIcon fontSize="small" />}
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Stack>
                <StageBar
                  pipelineType={job.pipeline_type}
                  currentSkill={job.current_skill}
                  state={job.state}
                />
                {job.state === "done" && (
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 3, mt: 0.5 }} display="block">
                    AI output applied to {job.book} {job.start_chapter}.
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
          <Button
            size="small"
            sx={{ mt: 1 }}
            onClick={() => {
              for (const j of jobs) void pipelineStore.refresh(j.job_id);
            }}
          >
            Refresh
          </Button>
        </Box>
      </Popover>
    </>
  );
}

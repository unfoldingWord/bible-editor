// Pill summarizing active AI pipeline runs. Rendered inline in the TopBar's
// status cluster (via the `pipelineStatus` prop) so it sits in normal flow
// instead of floating over the resource-column tab strip; the popover opens
// downward from the chip. Click expands to list each job with its state,
// current skill, and (for paused runs) Resume / Cancel buttons. The transient
// start/complete toast rides a bottom-center Snackbar, matching the import
// toasts in TopBar.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Chip,
  Stack,
  Tooltip,
  Popover,
  Typography,
  Button,
  Divider,
  CircularProgress,
  Snackbar,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import BlockIcon from "@mui/icons-material/Block";
import type { PipelineJobRow, PipelineState } from "../sync/api";
import { pipelineStore } from "../sync/pipelineStore";
import { currentPipelineUserId } from "../sync/pipelineSession";

// A job requested by another user. The shared queue shows everyone's active /
// queued runs, but only the owner can cancel one, and its requester is
// attributed in the row. Nothing is foreign until the user id is bound.
function isForeign(job: PipelineJobRow): boolean {
  const me = currentPipelineUserId();
  return me != null && job.user_id !== me;
}

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

// Upstream jobIds are UUIDs (~36 chars); a short tail is plenty to
// distinguish two sibling jobs without bloating the panel.
function shortJobId(jobId: string): string {
  return jobId.length > 8 ? `…${jobId.slice(-6)}` : jobId;
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
    case "queued":
      return "queued";
    case "dispatching":
      return "starting…";
    case "running":
      return "running";
    case "paused_for_outage":
      return "paused (outage)";
    case "paused_for_usage_limit":
      return "paused (daily budget)";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "done":
      return "done";
  }
}

function StateIcon({ state }: { state: PipelineState }) {
  if (state === "queued") return <HourglassEmptyIcon fontSize="small" color="disabled" />;
  if (state === "dispatching" || state === "running") return <CircularProgress size={14} />;
  if (state === "done") return <CheckCircleOutlineIcon fontSize="small" color="success" />;
  if (state === "failed") return <ErrorOutlineIcon fontSize="small" color="error" />;
  if (state === "cancelled") return <BlockIcon fontSize="small" color="disabled" />;
  return <PauseCircleOutlineIcon fontSize="small" color="warning" />;
}

// Human age for the stale-pause confirmation. The bot reports pausedAgeSeconds
// with its 409; if it ever doesn't, say so plainly rather than showing "0m" —
// the whole point of the prompt is that the user knows how old the content is.
function describeAge(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "an unknown time";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)} days`;
}

// Client-side mirror of `forceStopPhrase` in api/src/pipelines.ts. This copy
// exists ONLY to render the phrase in the dialog and gate the confirm button
// without a round trip — the server independently derives and checks its own
// copy from the job row, and that server check is the one that actually
// matters. The two formulas MUST change in lockstep: if they drift, this
// dialog shows a phrase the server will reject, and every force-stop attempt
// 400s with confirm_mismatch.
function forceStopPhrase(job: PipelineJobRow): string {
  const range =
    job.start_chapter === job.end_chapter
      ? `${job.start_chapter}`
      : `${job.start_chapter}-${job.end_chapter}`;
  return `STOP THE AI FOR ${job.book} ${range}`;
}

interface ToastMsg {
  id: number;
  text: string;
  kind: "success" | "error" | "info";
  // Optional inline button (e.g. "Save & refresh" after an AI apply lands new
  // rows in the open chapter). When present, the toast stays until dismissed or
  // the action is taken rather than auto-expiring.
  action?: { label: string; onClick: () => void };
}

interface Props {
  toast?: ToastMsg | null;
  onToastClear?: () => void;
}

export function PipelineStatusBar({ toast, onToastClear }: Props = {}) {
  const [jobs, setJobs] = useState<PipelineJobRow[]>([]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  // Per-job resume failure text. The row already renders job.error_message from
  // the server; this covers the request itself failing (the row's own state
  // doesn't change on a refused resume).
  const [resumeError, setResumeError] = useState<{ jobId: string; text: string } | null>(null);
  // Second step of the two-step force-resume. The bot refuses a pause older than
  // its 90-minute box with 409 'stale_pause'; we never force on the first click,
  // because a forced resume republishes output generated before any edits made
  // since. So we surface the age here and only force once the user confirms.
  const [staleConfirm, setStaleConfirm] = useState<{ jobId: string; text: string } | null>(null);
  // Force-stop dialog: the job being targeted (null = closed), the user's
  // typed text, whether a request is in flight, and a failure message from
  // the request itself (the row's own error_message covers the successful
  // "force-stopped by user N" case once it re-polls).
  const [forceFailTarget, setForceFailTarget] = useState<PipelineJobRow | null>(null);
  const [forceFailText, setForceFailText] = useState("");
  const [forceFailing, setForceFailing] = useState(false);
  const [forceFailError, setForceFailError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // When pipelineStore.requestFocus(jobId) fires (e.g. on already_running),
  // we stash the request and let the next render — once hasAnything flips
  // true and the chip mounts — anchor the popover to the chip.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => pipelineStore.subscribe(setJobs), []);
  useEffect(
    () =>
      pipelineStore.onFocusRequest((jobId) => {
        setPendingFocus(jobId);
      }),
    [],
  );

  const { active, queued, doneRecent, failed } = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      // 'dispatching' counts as active — it's claimed the bot slot and locks
      // the chapter, same as running.
      active: jobs.filter(
        (j) =>
          j.state === "running" ||
          j.state === "dispatching" ||
          j.state === "paused_for_outage" ||
          j.state === "paused_for_usage_limit",
      ),
      queued: jobs.filter((j) => j.state === "queued"),
      doneRecent: jobs.filter((j) => j.state === "done" && nowSec - j.updated_at < 24 * 3600),
      failed: jobs.filter((j) => j.state === "failed"),
    };
  }, [jobs]);

  const hasAnything = active.length + queued.length + doneRecent.length + failed.length > 0;

  // The user's own in-flight work, used to gate dismissal: another user's run
  // being active shouldn't stop you from clearing your own finished items.
  const ownActive = active.filter((j) => !isForeign(j));
  const ownQueued = queued.filter((j) => !isForeign(j));
  const canDismissResolved =
    ownActive.length === 0 && ownQueued.length === 0 && doneRecent.length + failed.length > 0;

  // Global queue context (the single running job, possibly another user's),
  // refreshed by the store on load/visibility. Drives the "running ahead" note
  // shown when the user has something waiting in line.
  const queueSummary = pipelineStore.getQueueSummary();

  // Map child job_id -> parent job_id. Used to render the reciprocal "after
  // <parent>" line under follow-up rows; the data is in place because the
  // parent row already carries follow_up_job_id pointing at the child.
  const parentByChildId = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jobs) {
      if (j.follow_up_job_id) m.set(j.follow_up_job_id, j.job_id);
    }
    return m;
  }, [jobs]);

  // Resolve a pending focus request once the chip mounts. We can't anchor
  // earlier — Popover needs a real DOM node — and a pending focus from
  // PipelineMenu.start() races with React committing the new jobs state.
  useEffect(() => {
    if (!pendingFocus) return;
    if (!chipRef.current) return;
    if (!anchorEl) setAnchorEl(chipRef.current);
    setPendingFocus(null);
  }, [pendingFocus, hasAnything, anchorEl]);

  const cancel = async (job: PipelineJobRow) => {
    setCancelling(job.job_id);
    try {
      await pipelineStore.cancel(job.job_id);
    } catch {
      // The store re-polls on a 409 (already started) so the row reflects its
      // real state; other failures are transient — leave the row as-is.
    } finally {
      setCancelling(null);
    }
  };

  // force=false on every first click. A 'stale_pause' refusal is expected, not an
  // error: it means the pause is old enough that resuming would republish
  // pre-edit content, so we ask before calling again with force=true.
  const resume = async (job: PipelineJobRow, force = false) => {
    setResuming(job.job_id);
    setResumeError(null);
    setStaleConfirm(null);
    try {
      const res = await pipelineStore.resume(job.job_id, force);
      if (!res.ok && res.reason === "stale_pause") {
        setStaleConfirm({
          jobId: job.job_id,
          text: `This run paused ${describeAge(res.pausedAgeSeconds)} ago. Resuming will publish text generated before any edits made since. Resume anyway?`,
        });
      } else if (!res.ok) {
        // Prefer the bot's own explanation when it sent one — for a
        // session-mismatch refusal it names the actual next step ("resume it
        // from Zulip instead"), which the bare state never conveys.
        setResumeError({
          jobId: job.job_id,
          text: res.detail
            ? `Could not resume — ${res.detail}`
            : `Could not resume — the run is now ${res.state ?? "in another state"}.`,
        });
      }
    } catch {
      setResumeError({ jobId: job.job_id, text: "Resume failed — try again." });
    } finally {
      setResuming(null);
    }
  };

  const openForceFail = (job: PipelineJobRow) => {
    setForceFailTarget(job);
    setForceFailText("");
    setForceFailError(null);
  };

  const closeForceFail = () => {
    if (forceFailing) return; // don't yank the dialog out from under an in-flight request
    setForceFailTarget(null);
    setForceFailText("");
    setForceFailError(null);
  };

  const confirmForceFail = async () => {
    if (!forceFailTarget) return;
    setForceFailing(true);
    setForceFailError(null);
    try {
      const res = await pipelineStore.forceFail(forceFailTarget.job_id, forceFailText);
      if (!res.ok) {
        setForceFailError(
          res.reason === "confirm_mismatch"
            ? "That doesn't match the phrase above — check for typos and try again."
            : `Could not force-stop — the run is now ${res.state ?? "in another state"}.`,
        );
        return;
      }
      setForceFailTarget(null);
      setForceFailText("");
    } catch {
      setForceFailError("Force-stop failed — try again.");
    } finally {
      setForceFailing(false);
    }
  };

  if (!hasAnything && !toast) return null;

  return (
    <>
      {hasAnything && (
        <Box ref={chipRef} sx={{ display: "inline-flex" }}>
          <Chip
            icon={<AutoAwesomeIcon />}
            label={
              active.length > 0
                ? `${active.length} pipeline${active.length === 1 ? "" : "s"} running${
                    queued.length > 0 ? ` · ${queued.length} queued` : ""
                  }`
                : queued.length > 0
                  ? `${queued.length} queued`
                  : failed.length > 0
                    ? `${failed.length} failed`
                    : "AI ready to review"
            }
            size="small"
            variant="outlined"
            color={
              active.length > 0
                ? "primary"
                : queued.length > 0
                  ? "default"
                  : failed.length > 0
                    ? "error"
                    : "success"
            }
            onClick={(e) => setAnchorEl(e.currentTarget)}
            // Dismissable once nothing is in flight — done and failed runs can
            // both be marked as seen. Running / queued states still need user
            // attention, so no delete icon there.
            onDelete={
              canDismissResolved
                ? () => {
                    pipelineStore.dismissResolved();
                    setAnchorEl(null);
                  }
                : undefined
            }
          />
        </Box>
      )}
      <Snackbar
        open={Boolean(toast)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        // Lifecycle is owned by Shell's 8s timer; only dismiss on the explicit
        // close action, not on click-away.
        onClose={(_, reason) => reason !== "clickaway" && onToastClear?.()}
      >
        {toast ? (
          <Alert
            severity={toast.kind}
            variant="filled"
            onClose={onToastClear}
            action={
              toast.action ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    toast.action?.onClick();
                    onToastClear?.();
                  }}
                >
                  {toast.action.label}
                </Button>
              ) : undefined
            }
          >
            {toast.text}
          </Alert>
        ) : undefined}
      </Snackbar>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ p: 1.5, minWidth: 320, maxWidth: 420 }}>
          <Typography variant="caption" color="text.secondary">
            AI pipelines
          </Typography>
          {queued.length > 0 && queueSummary?.activeJob && (
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.5, fontStyle: "italic" }}
            >
              Only one runs at a time. Running now:{" "}
              {queueSummary.activeJob.started_by_username ?? "someone"} ·{" "}
              {TYPE_LABEL[queueSummary.activeJob.pipeline_type]}{" "}
              {queueSummary.activeJob.book} {queueSummary.activeJob.start_chapter}
              {` (${relativeTime(queueSummary.activeJob.updated_at)})`}
            </Typography>
          )}
          <Stack spacing={1} sx={{ mt: 1 }}>
            {jobs.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No pipelines running.
              </Typography>
            )}
            {jobs.map((job, i) => {
              const parentId = parentByChildId.get(job.job_id);
              const childId = job.follow_up_job_id;
              // A paused run holds the single bot slot without progressing, so
              // its owner gets both escapes: ask the bot to pick it back up, or
              // give up on it and let the queue move.
              const isPaused =
                job.state === "paused_for_outage" || job.state === "paused_for_usage_limit";
              const canAct = (job.state === "queued" || isPaused) && !isForeign(job);
              return (
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
                      {job.state === "queued" && job.queue_position
                        ? ` · #${job.queue_position} in line`
                        : ""}
                      {job.current_skill && !STAGES[job.pipeline_type]?.includes(job.current_skill)
                        ? ` · ${job.current_skill}`
                        : ""}
                      {` · updated ${relativeTime(job.updated_at)}`}
                    </Typography>
                    {isForeign(job) && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontStyle: "italic" }}>
                        requested by {job.started_by_username ?? "another user"}
                      </Typography>
                    )}
                    {parentId && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontStyle: "italic" }}>
                        Step 2 of 2 · after {shortJobId(parentId)}
                      </Typography>
                    )}
                    {childId && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontStyle: "italic" }}>
                        Step 1 of 2 · follow-up {shortJobId(childId)}
                      </Typography>
                    )}
                    {job.error_message && (
                      <Typography variant="caption" color="error" display="block">
                        {job.error_message}
                      </Typography>
                    )}
                    {resumeError?.jobId === job.job_id && (
                      <Typography variant="caption" color="error" display="block">
                        {resumeError.text}
                      </Typography>
                    )}
                    {staleConfirm?.jobId === job.job_id && (
                      <>
                        <Typography variant="caption" color="warning.main" display="block">
                          {staleConfirm.text}
                        </Typography>
                        <Button
                          size="small"
                          color="warning"
                          onClick={() => void resume(job, true)}
                          disabled={resuming === job.job_id}
                          startIcon={
                            resuming === job.job_id ? <CircularProgress size={12} /> : undefined
                          }
                        >
                          Resume anyway
                        </Button>
                        <Button size="small" color="inherit" onClick={() => setStaleConfirm(null)}>
                          Cancel
                        </Button>
                      </>
                    )}
                  </Box>
                  {isPaused && !isForeign(job) && (
                    <Tooltip
                      title={
                        job.state === "paused_for_usage_limit"
                          ? "Ask the bot to pick this run back up (the daily AI budget must have reset)"
                          : "Ask the bot to pick this run back up from where the outage stopped it. If the pause is old you'll be asked to confirm first, because resuming republishes the text it had already generated."
                      }
                    >
                      <span>
                        <Button
                          size="small"
                          color="inherit"
                          onClick={() => void resume(job)}
                          disabled={resuming === job.job_id || cancelling === job.job_id}
                          startIcon={resuming === job.job_id ? <CircularProgress size={12} /> : undefined}
                        >
                          Resume
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                  {canAct && (
                    <Tooltip
                      title={
                        isPaused
                          ? "Give up on this paused run and free the queue"
                          : "Remove from the queue (only possible before it starts)"
                      }
                    >
                      <span>
                        <Button
                          size="small"
                          color="inherit"
                          onClick={() => void cancel(job)}
                          disabled={cancelling === job.job_id || resuming === job.job_id}
                          startIcon={cancelling === job.job_id ? <CircularProgress size={12} /> : undefined}
                        >
                          Cancel
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                  {(job.state === "running" || job.state === "dispatching") &&
                    !isForeign(job) && (
                      <Tooltip title="Stop this run immediately and discard its in-flight AI work — for a wedged run that isn't making progress">
                        <span>
                          <Button
                            size="small"
                            color="error"
                            onClick={() => openForceFail(job)}
                          >
                            Force stop
                          </Button>
                        </span>
                      </Tooltip>
                    )}
                  {(job.state === "failed" || job.state === "cancelled") && (
                    <Tooltip title="Mark as seen — hides this run from the list">
                      <Button size="small" color="inherit" onClick={() => pipelineStore.dismiss(job.job_id)}>
                        Dismiss
                      </Button>
                    </Tooltip>
                  )}
                </Stack>
                {job.state !== "queued" && job.state !== "dispatching" && job.state !== "cancelled" && (
                  <StageBar
                    pipelineType={job.pipeline_type}
                    currentSkill={job.current_skill}
                    state={job.state}
                  />
                )}
                {job.state === "done" && (
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 3, mt: 0.5 }} display="block">
                    AI output applied to {job.book} {job.start_chapter}.
                  </Typography>
                )}
              </Box>
              );
            })}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
            <Button
              size="small"
              disabled={refreshing || jobs.length === 0}
              startIcon={refreshing ? <CircularProgress size={12} /> : undefined}
              onClick={async () => {
                setRefreshing(true);
                try {
                  // Reconcile the whole shared queue (own + others' jobs);
                  // per-id refresh can't touch other users' runs.
                  await pipelineStore.reload();
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            {canDismissResolved && (
              <Button
                size="small"
                color="inherit"
                onClick={() => {
                  pipelineStore.dismissResolved();
                  setAnchorEl(null);
                }}
              >
                Dismiss all
              </Button>
            )}
          </Stack>
        </Box>
      </Popover>
      {/* Force-stop confirmation. Deliberately heavier than the inline
          force-resume confirm above (a plain inline warning + button): this
          discards in-flight AI work rather than just re-trying an already-
          paused run, so it gets a modal, a typed phrase, and an explicit list
          of consequences instead of one line of text. */}
      <Dialog open={Boolean(forceFailTarget)} onClose={closeForceFail} maxWidth="xs" fullWidth>
        {forceFailTarget && (
          <>
            <DialogTitle sx={{ color: "error.main" }}>Force stop this run?</DialogTitle>
            <DialogContent>
              <DialogContentText component="div">
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {TYPE_LABEL[forceFailTarget.pipeline_type]} — {forceFailTarget.book}{" "}
                  {forceFailTarget.start_chapter}
                  {forceFailTarget.end_chapter !== forceFailTarget.start_chapter
                    ? `–${forceFailTarget.end_chapter}`
                    : ""}
                </Typography>
                <Typography variant="body2" component="div" sx={{ mb: 1 }}>
                  This will:
                  <ul style={{ margin: "4px 0 0 0", paddingLeft: 20 }}>
                    <li>stop tracking this run here</li>
                    <li>unlock the chapter for editing again</li>
                    <li>let the next queued run start right away</li>
                  </ul>
                  The AI may keep working on its side for a while after this — don't assume
                  it stops right away. Because the next queued run starts immediately, the
                  two may briefly overlap.
                </Typography>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Type the phrase below exactly to confirm:
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    fontWeight: 700,
                    bgcolor: "action.hover",
                    p: 1,
                    borderRadius: 1,
                    mb: 1,
                    userSelect: "all",
                  }}
                >
                  {forceStopPhrase(forceFailTarget)}
                </Typography>
                <TextField
                  autoFocus
                  fullWidth
                  size="small"
                  value={forceFailText}
                  onChange={(e) => setForceFailText(e.target.value)}
                  placeholder={forceStopPhrase(forceFailTarget)}
                  disabled={forceFailing}
                />
                {forceFailError && (
                  <Typography variant="caption" color="error" display="block" sx={{ mt: 1 }}>
                    {forceFailError}
                  </Typography>
                )}
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={closeForceFail} disabled={forceFailing} color="inherit">
                Cancel
              </Button>
              <Button
                onClick={() => void confirmForceFail()}
                color="error"
                variant="contained"
                disabled={forceFailing || forceFailText.trim() !== forceStopPhrase(forceFailTarget)}
                startIcon={forceFailing ? <CircularProgress size={14} color="inherit" /> : undefined}
              >
                Force stop
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </>
  );
}

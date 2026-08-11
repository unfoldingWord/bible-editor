// Internal admin tool (two users, not a product surface). Four tabs:
// sync status, run (push/pull), pull requests, users. See task spec in the
// PR description / CLAUDE.md session notes for the full API contract this
// codes against — the backend is built to the same contract in parallel.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteIcon from "@mui/icons-material/Delete";
import {
  api,
  ApiError,
  type AdminBookSyncStatus,
  type AdminImportResponse,
  type AdminImportResult,
  type AdminPr,
  type AdminResourceSyncStatus,
  type AdminUser,
  type ExportSnapshotRow,
  type ExportInstanceStatus,
  type Resource,
} from "../sync/api";
import { bookName } from "../lib/bookNames";

const RESOURCES: Resource[] = ["ult", "ust", "tn", "tq", "twl"];
const RESOURCE_LABELS: Record<Resource, string> = {
  ult: "ULT",
  ust: "UST",
  tn: "tN",
  tq: "tQ",
  twl: "tWL",
};

// ── plain-English error mapping (shared by the sync-status cells and the
// recent-runs table) ─────────────────────────────────────────────────────
const ERROR_PREFIX_MAP: [string, string][] = [
  ["stale_master:", "Door43 moved ahead of us — pull first"],
  ["shrink_guard:", "Blocked: this export would delete rows"],
  ["hard_reject_guard:", "Blocked: Door43 would reject this file"],
  ["align_shrink_guard:", "Blocked: alignment loss"],
  ["usfm_invalid_guard:", "Blocked: invalid USFM"],
];
const ERROR_EXACT_MAP: Record<string, string> = {
  no_rows: "Nothing to export",
  unchanged: "No change",
  dry_run: "Dry run (not pushed)",
  no_service_token: "Not configured",
};
function plainExportError(raw: string): string {
  if (ERROR_EXACT_MAP[raw]) return ERROR_EXACT_MAP[raw];
  for (const [prefix, msg] of ERROR_PREFIX_MAP) {
    if (raw.startsWith(prefix)) return msg;
  }
  return raw;
}

// `export_snapshots.error` doubles as the skip-reason channel, so a non-null
// value does NOT mean something went wrong — `unchanged` is the single most
// common value on a healthy night. Labelling these "blocked" sends a
// maintainer hunting for a failure that never happened, so benign outcomes get
// their own neutral chip. Anything not listed here is treated as a real block.
const BENIGN_EXPORT_OUTCOMES: Record<string, string> = {
  unchanged: "no change",
  no_rows: "nothing to export",
  dry_run: "dry run",
  no_service_token: "not configured",
};

const USER_ERROR_MAP: Record<string, string> = {
  cannot_demote_self: "You can't remove your own admin access",
  last_admin: "There must be at least one admin",
  cannot_remove_self: "You can't remove yourself",
  not_found: "No such user",
  invalid_body: "That username/role isn't valid",
};
function errorReason(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    const code = body?.error;
    if (code && USER_ERROR_MAP[code]) return USER_ERROR_MAP[code];
    if (code) return code;
  }
  return String(err);
}

function fmtTime(epochSec: number | null): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString();
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "—";
}

// Small reusable "are you sure" gate for destructive/outward-facing actions.
function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{description}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" color="warning" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Tab 1: Sync status ───────────────────────────────────────────────────

function ResourceCell({ rs, resource }: { rs: AdminResourceSyncStatus | null; resource: Resource }) {
  if (!rs) {
    return (
      <Typography variant="caption" color="text.disabled">
        —
      </Typography>
    );
  }

  const inSync = !!rs.pulledSha && !!rs.lastExportSha && rs.pulledSha === rs.lastExportSha;
  let label: string;
  let color: "success" | "warning" | "default";
  let plainReason: string | null = null;
  if (rs.lastExportError && BENIGN_EXPORT_OUTCOMES[rs.lastExportError]) {
    label = BENIGN_EXPORT_OUTCOMES[rs.lastExportError];
    color = "default";
    plainReason = plainExportError(rs.lastExportError);
  } else if (rs.lastExportError) {
    label = "blocked";
    color = "warning";
    plainReason = plainExportError(rs.lastExportError);
  } else if (inSync) {
    label = "in sync";
    color = "success";
  } else if (!rs.lastExportSha) {
    label = "not exported";
    color = "default";
  } else {
    label = "diverged";
    color = "warning";
    plainReason = "Door43's copy differs from what we last exported";
  }

  const tooltip = (
    <Stack spacing={0.5} sx={{ maxWidth: 320 }}>
      {plainReason && (
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {plainReason}
        </Typography>
      )}
      {rs.lastExportError && (
        <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
          {rs.lastExportError}
        </Typography>
      )}
      <Typography variant="caption">pulled: {fmtTime(rs.pulledAt)} ({shortSha(rs.pulledSha)})</Typography>
      <Typography variant="caption">exported: {fmtTime(rs.lastExportAt)} ({shortSha(rs.lastExportSha)})</Typography>
      {rs.pullOrigin && <Typography variant="caption">origin: {rs.pullOrigin}</Typography>}
      {rs.branch && <Typography variant="caption">branch: {rs.branch}</Typography>}
      {rs.lastExportRows != null && (
        <Typography variant="caption">rows: {rs.lastExportRows}</Typography>
      )}
    </Stack>
  );

  return (
    <Tooltip title={tooltip} placement="top">
      <Stack spacing={0.25} alignItems="flex-start">
        <Chip label={label} size="small" color={color === "default" ? undefined : color} variant="outlined" />
        {rs.prNumber != null && (
          <Typography
            component="a"
            href={`https://git.door43.org/unfoldingWord/en_${resource}/pulls/${rs.prNumber}`}
            target="_blank"
            rel="noopener"
            variant="caption"
            sx={{ textDecoration: "none" }}
          >
            PR #{rs.prNumber}
          </Typography>
        )}
      </Stack>
    </Tooltip>
  );
}

function SyncStatusTab() {
  const [books, setBooks] = useState<AdminBookSyncStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getAdminSyncStatus()
      .then((res) => setBooks(res.books))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return books;
    return books.filter(
      (b) => b.book.toLowerCase().includes(f) || bookName(b.book).toLowerCase().includes(f),
    );
  }, [books, filter]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <TextField
          size="small"
          label="Filter by book"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <IconButton onClick={load} title="Refresh">
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Stack>
      {error && <Alert severity="error">Failed to load sync status: {error}</Alert>}
      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress size={24} />
        </Box>
      ) : filtered.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No books match.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Book</TableCell>
                {RESOURCES.map((r) => (
                  <TableCell key={r}>{RESOURCE_LABELS[r]}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((b) => (
                <TableRow key={b.book}>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {b.book}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {bookName(b.book)}
                    </Typography>
                  </TableCell>
                  {RESOURCES.map((r) => (
                    <TableCell key={r}>
                      <ResourceCell rs={b.resources[r]} resource={r} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

// ── Tab 2: Run (push / pull) ─────────────────────────────────────────────

// Terminal Workflow instance statuses — anything else keeps the poll alive.
const TERMINAL_STATUSES = new Set(["complete", "errored", "terminated", "failed", "done"]);

function useInstancePoll(id: string | null) {
  const [status, setStatus] = useState<ExportInstanceStatus | null>(null);

  useEffect(() => {
    if (!id) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = () => {
      api
        .getExportInstance(id)
        .then((res) => {
          if (cancelled) return;
          setStatus(res);
          // The state string is nested (`status.status`). Testing the object
          // itself never matches a terminal state, which left this polling
          // every 3s forever for the life of the panel.
          if (!TERMINAL_STATUSES.has(res.status?.status)) {
            timer = setTimeout(poll, 3000);
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setStatus({ id, status: { status: "errored", error: String(e) } });
        });
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return status;
}

function InstanceStatusView({ id, status }: { id: string; status: ReturnType<typeof useInstancePoll> }) {
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary">
        run id: {id}
      </Typography>
      {!status ? (
        <CircularProgress size={16} />
      ) : (
        (() => {
          // `status` is the Workflow instance object, so the state string is
          // nested one level down. Rendering the object itself throws
          // "Objects are not valid as a React child" and takes out the whole
          // panel via the error boundary, so coerce defensively.
          const state = String(status.status?.status ?? "unknown");
          const err = status.status?.error;
          const output = status.status?.output;
          return (
            <>
              <Chip
                size="small"
                label={state}
                color={
                  state === "complete" || state === "done"
                    ? "success"
                    : state === "errored" || state === "failed" || state === "terminated"
                      ? "error"
                      : "default"
                }
              />
              {err != null && (
                <Alert severity="error">
                  {typeof err === "string" ? err : JSON.stringify(err)}
                </Alert>
              )}
              {output != null && (
                <Typography
                  variant="caption"
                  component="pre"
                  sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}
                >
                  {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
                </Typography>
              )}
            </>
          );
        })()
      )}
    </Stack>
  );
}

function nonZeroCounts(counts: AdminImportResult["totals"]): [string, number][] {
  return Object.entries(counts).filter(
    ([k, v]) => k !== "errors" && k !== "counts_incomplete" && typeof v === "number" && v !== 0,
  ) as [string, number][];
}

function ImportResultView({ result }: { result: AdminImportResult }) {
  const rows: [Resource, [string, number][]][] = (Object.keys(result.perResource) as Resource[]).map((r) => [
    r,
    nonZeroCounts(result.perResource[r]),
  ]);
  const totals = nonZeroCounts(result.totals);
  const allErrors = [
    ...result.totals.errors,
    ...(Object.keys(result.perResource) as Resource[]).flatMap((r) => result.perResource[r].errors),
  ];
  return (
    <Stack spacing={1.5} sx={{ mt: 1 }}>
      {result.totals.counts_incomplete && (
        <Alert severity="warning">Counts are incomplete — the import may have stopped early.</Alert>
      )}
      {allErrors.length > 0 && (
        <Alert severity="error">
          {allErrors.length} error(s): {allErrors.join("; ")}
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary">
        totals: {totals.length === 0 ? "no changes" : totals.map(([k, v]) => `${k}=${v}`).join(", ")}
      </Typography>
      {rows.map(
        ([r, counts]) =>
          counts.length > 0 && (
            <Typography key={r} variant="caption">
              <strong>{RESOURCE_LABELS[r]}</strong>: {counts.map(([k, v]) => `${k}=${v}`).join(", ")}
            </Typography>
          ),
      )}
    </Stack>
  );
}

function PushCard({ bookOptions }: { bookOptions: string[] }) {
  const [book, setBook] = useState("");
  const [resource, setResource] = useState<Resource | "">("");
  const [dryDcs, setDryDcs] = useState(true);
  const [allowShrink, setAllowShrink] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useInstancePoll(runId);

  const needsConfirm = !dryDcs || allowShrink;

  const doPush = useCallback(() => {
    setError(null);
    api
      .runExport({
        book: book || undefined,
        resource: resource || undefined,
        dryDcs,
        allowShrink,
      })
      .then((res) => setRunId(res.id))
      .catch((e) => setError(String(e)));
  }, [book, resource, dryDcs, allowShrink]);

  const handlePushClick = () => {
    if (needsConfirm) setConfirmOpen(true);
    else doPush();
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
      <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
        Push to Door43
      </Typography>
      <Stack spacing={1.5}>
        <Select size="small" displayEmpty value={book} onChange={(e) => setBook(e.target.value)}>
          <MenuItem value="">(all books)</MenuItem>
          {bookOptions.map((b) => (
            <MenuItem key={b} value={b}>
              {b} — {bookName(b)}
            </MenuItem>
          ))}
        </Select>
        <Select
          size="small"
          displayEmpty
          value={resource}
          onChange={(e) => setResource(e.target.value as Resource | "")}
        >
          <MenuItem value="">(all resources)</MenuItem>
          {RESOURCES.map((r) => (
            <MenuItem key={r} value={r}>
              {RESOURCE_LABELS[r]}
            </MenuItem>
          ))}
        </Select>
        <FormControlLabel
          control={<Checkbox checked={dryDcs} onChange={(e) => setDryDcs(e.target.checked)} />}
          label="Render only, don't write to Door43"
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={allowShrink}
              disabled={!book || !resource}
              onChange={(e) => setAllowShrink(e.target.checked)}
            />
          }
          label="Override the row-deletion guard"
        />
        <Button variant="contained" onClick={handlePushClick}>
          Push
        </Button>
        {error && <Alert severity="error">{error}</Alert>}
        {runId && <InstanceStatusView id={runId} status={status} />}
      </Stack>
      <ConfirmDialog
        open={confirmOpen}
        title="Push to Door43?"
        description={
          !dryDcs && allowShrink
            ? `This will write ${resource ? RESOURCE_LABELS[resource] : "all resources"} for ${book || "all books"} to Door43 and skip the row-deletion guard, so rows can be deleted on the far side.`
            : !dryDcs
              ? `This will write ${resource ? RESOURCE_LABELS[resource] : "all resources"} for ${book || "all books"} to Door43.`
              : `This will render (but not push) with the row-deletion guard overridden for ${book || "all books"} / ${resource ? RESOURCE_LABELS[resource] : "all resources"}.`
        }
        confirmLabel="Push"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          doPush();
        }}
      />
    </Paper>
  );
}

function parseChapters(text: string): number[] | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const out = new Set<number>();
  for (const part of t.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) out.add(i);
    } else if (/^\d+$/.test(p)) {
      out.add(parseInt(p, 10));
    }
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : undefined;
}

function PullCard({ bookOptions }: { bookOptions: string[] }) {
  const [book, setBook] = useState("");
  const [resources, setResources] = useState<Resource[]>([]);
  const [chaptersText, setChaptersText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminImportResponse | null>(null);
  const status = useInstancePoll(result?.mode === "workflow" ? result.id : null);

  const canPull = !!book && resources.length > 0;

  const doPull = useCallback(() => {
    if (!canPull) return;
    setError(null);
    setResult(null);
    api
      .adminImport({ book, resources, chapters: parseChapters(chaptersText) })
      .then((res) => setResult(res))
      .catch((e) => setError(String(e)));
  }, [book, resources, chaptersText, canPull]);

  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
      <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
        Pull from Door43
      </Typography>
      <Stack spacing={1.5}>
        <Select size="small" displayEmpty value={book} onChange={(e) => setBook(e.target.value)}>
          <MenuItem value="">(choose a book)</MenuItem>
          {bookOptions.map((b) => (
            <MenuItem key={b} value={b}>
              {b} — {bookName(b)}
            </MenuItem>
          ))}
        </Select>
        <Select
          size="small"
          multiple
          displayEmpty
          value={resources}
          renderValue={(v) => (v.length === 0 ? "(choose resources)" : v.map((r) => RESOURCE_LABELS[r]).join(", "))}
          onChange={(e) => setResources(e.target.value as Resource[])}
        >
          {RESOURCES.map((r) => (
            <MenuItem key={r} value={r}>
              {RESOURCE_LABELS[r]}
            </MenuItem>
          ))}
        </Select>
        <TextField
          size="small"
          label="Chapters (optional, e.g. 1,3,5-7)"
          value={chaptersText}
          onChange={(e) => setChaptersText(e.target.value)}
          helperText="Empty = whole book"
        />
        <Button variant="contained" disabled={!canPull} onClick={doPull}>
          Pull
        </Button>
        {error && <Alert severity="error">{error}</Alert>}
        {result?.mode === "inline" && <ImportResultView result={result.result} />}
        {result?.mode === "workflow" && <InstanceStatusView id={result.id} status={status} />}
      </Stack>
    </Paper>
  );
}

function RecentRuns() {
  const [rows, setRows] = useState<ExportSnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getExports(undefined, 50)
      .then((res) => setRows(res.snapshots ?? []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <Stack spacing={1}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle2">Recent runs</Typography>
        <IconButton size="small" onClick={load} title="Refresh">
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {loading ? (
        <CircularProgress size={20} />
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No runs yet.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Book</TableCell>
                <TableCell>Resource</TableCell>
                <TableCell>When</TableCell>
                <TableCell>Outcome</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.book}</TableCell>
                  <TableCell>{RESOURCE_LABELS[row.resource]}</TableCell>
                  <TableCell>{fmtTime(row.committed_at)}</TableCell>
                  <TableCell>
                    {row.error ? plainExportError(row.error) : shortSha(row.commit_sha)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

function RunTab() {
  const [books, setBooks] = useState<string[]>([]);

  useEffect(() => {
    api
      .getAdminSyncStatus()
      .then((res) => setBooks(res.books.map((b) => b.book)))
      .catch(() => setBooks([]));
  }, []);

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2}>
        <PushCard bookOptions={books} />
        <PullCard bookOptions={books} />
      </Stack>
      <RecentRuns />
    </Stack>
  );
}

// ── Tab 3: Pull requests ─────────────────────────────────────────────────

function CheckStateChip({ state }: { state: AdminPr["checkState"] }) {
  if (state === "success") return <Chip label="success" size="small" color="success" />;
  if (state === "failure") return <Chip label="failure" size="small" color="error" />;
  if (state === "pending") return <Chip label="pending" size="small" color="warning" />;
  return <Chip label="unknown" size="small" />;
}

function PrsTab() {
  const [prs, setPrs] = useState<AdminPr[] | null>(null);
  const [errors, setErrors] = useState<{ repo: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skipChecks, setSkipChecks] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api
      .getAdminPrs({ checks: !skipChecks })
      .then((res) => {
        setPrs(res.prs);
        setErrors(res.errors);
      })
      .catch((e) => setLoadError(String(e)))
      .finally(() => setLoading(false));
  }, [skipChecks]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button variant="contained" onClick={load} disabled={loading}>
          {prs === null ? "Load" : "Refresh"}
        </Button>
        <FormControlLabel
          control={<Checkbox checked={skipChecks} onChange={(e) => setSkipChecks(e.target.checked)} />}
          label="Skip check status (faster)"
        />
        {loading && <CircularProgress size={20} />}
      </Stack>
      {loadError && <Alert severity="error">{loadError}</Alert>}
      {errors.map((e) => (
        <Alert severity="warning" key={e.repo}>
          {e.repo}: {e.message}
        </Alert>
      ))}
      {prs === null ? (
        <Typography variant="body2" color="text.secondary">
          Not loaded yet — this hits Door43, so it's on demand.
        </Typography>
      ) : prs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No open PRs.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Book</TableCell>
                <TableCell>Resource</TableCell>
                <TableCell>PR</TableCell>
                <TableCell>Title</TableCell>
                <TableCell>Mergeable</TableCell>
                <TableCell>Checks</TableCell>
                <TableCell>Updated</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {prs.map((pr) => (
                <TableRow key={`${pr.repo}-${pr.number}`}>
                  <TableCell>{pr.book}</TableCell>
                  <TableCell>{RESOURCE_LABELS[pr.resource]}</TableCell>
                  <TableCell>
                    <Typography component="a" href={pr.url} target="_blank" rel="noopener" variant="body2">
                      #{pr.number}
                    </Typography>
                  </TableCell>
                  <TableCell>{pr.title}</TableCell>
                  <TableCell>
                    {pr.mergeable === null ? "unknown" : pr.mergeable ? "yes" : "no"}
                  </TableCell>
                  <TableCell>
                    <CheckStateChip state={pr.checkState} />
                  </TableCell>
                  <TableCell>{new Date(pr.updatedAt * 1000).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

// ── Tab 4: Users ─────────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "editor">("editor");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getAdminUsers()
      .then((res) => setUsers(res.users))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const changeRole = (username: string, role: "admin" | "editor") => {
    setActionError(null);
    api
      .addAdminUser(username, role)
      .then(() => load())
      .catch((e) => setActionError(errorReason(e)));
  };

  const addUser = () => {
    if (!newUsername.trim()) return;
    setActionError(null);
    api
      .addAdminUser(newUsername.trim(), newRole)
      .then(() => {
        setNewUsername("");
        setNewRole("editor");
        load();
      })
      .catch((e) => setActionError(errorReason(e)));
  };

  const doDelete = (username: string) => {
    setActionError(null);
    api
      .removeAdminUser(username)
      .then(() => load())
      .catch((e) => setActionError(errorReason(e)))
      .finally(() => setPendingDelete(null));
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Roles here are <strong>admin</strong> and <strong>editor</strong> only. Read-only "viewer"
        access is granted automatically to unfoldingWord DCS org members and isn't managed here.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {actionError && <Alert severity="error">{actionError}</Alert>}
      {loading ? (
        <CircularProgress size={20} />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Username</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Added</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.username}>
                  <TableCell>{u.username}</TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      value={u.role}
                      onChange={(e) => changeRole(u.username, e.target.value as "admin" | "editor")}
                    >
                      <MenuItem value="admin">admin</MenuItem>
                      <MenuItem value="editor">editor</MenuItem>
                    </Select>
                  </TableCell>
                  <TableCell>{fmtTime(u.addedAt)}</TableCell>
                  <TableCell>
                    <IconButton size="small" onClick={() => setPendingDelete(u.username)} title="Remove">
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell>
                  <TextField
                    size="small"
                    placeholder="username"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                  />
                </TableCell>
                <TableCell>
                  <Select size="small" value={newRole} onChange={(e) => setNewRole(e.target.value as "admin" | "editor")}>
                    <MenuItem value="admin">admin</MenuItem>
                    <MenuItem value="editor">editor</MenuItem>
                  </Select>
                </TableCell>
                <TableCell colSpan={2}>
                  <Button size="small" variant="contained" onClick={addUser} disabled={!newUsername.trim()}>
                    Add
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove user?"
        description={`This removes ${pendingDelete} from the admin/editor list. They'll drop to read-only (or no access, if they're not an unfoldingWord DCS org member).`}
        confirmLabel="Remove"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && doDelete(pendingDelete)}
      />
    </Stack>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState(0);

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider" }}>
        <IconButton onClick={onClose} title="Back to the editor">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="h6">Admin</Typography>
        <Box sx={{ flex: 1 }} />
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Sync status" />
          <Tab label="Run" />
          <Tab label="Pull requests" />
          <Tab label="Users" />
        </Tabs>
      </Stack>
      <Box sx={{ flex: 1, overflowY: "auto", p: 3 }}>
        {tab === 0 && <SyncStatusTab />}
        {tab === 1 && <RunTab />}
        {tab === 2 && <PrsTab />}
        {tab === 3 && <UsersTab />}
      </Box>
    </Box>
  );
}

import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SaveIcon from "@mui/icons-material/Save";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import DownloadIcon from "@mui/icons-material/Download";
import UploadIcon from "@mui/icons-material/Upload";
import VisibilityIcon from "@mui/icons-material/Visibility";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  type Register,
  type Term,
  type TermInput,
  type TermStatus,
  type TranslationPrefs,
} from "../sync/api";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { useTranslationPrefs, useTerms, useExamples } from "../hooks/useTranslationMemory";
import { MarkdownView } from "./MarkdownView";

type Section = "brief" | "instructions" | "terminology" | "examples";
const SECTIONS: Section[] = ["brief", "instructions", "terminology", "examples"];

const REGISTERS: Register[] = ["default", "formal", "informal"];
const TERM_STATUSES: TermStatus[] = ["preferred", "admitted", "deprecated", "forbidden", "do_not_translate"];

// Term-status → semantic palette (design §10). Not the violet AI identity —
// status is not an AI-draft state.
function statusColor(status: TermStatus): string {
  switch (status) {
    case "preferred":
      return "success.main";
    case "admitted":
      return "info.main";
    case "forbidden":
      return "error.main";
    case "do_not_translate":
      return "text.primary";
    default:
      return "text.secondary"; // deprecated
  }
}

interface Props {
  onNavigate: (section: Section) => void;
  section: Section;
}

export function PreferencesWorkspace({ onNavigate, section }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);

  if (!isTranslation) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }} spacing={1}>
        <Typography variant="h6">{t("preferences.title")}</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 420 }}>
          {t("preferences.glOnly")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      {/* ── Left rail ── */}
      <Box
        sx={{
          width: 240,
          flexShrink: 0,
          borderInlineEnd: "1px solid",
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <Stack spacing={1} sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Tooltip title={t("preferences.backToScripture")}>
              <IconButton
                size="small"
                onClick={() => {
                  location.hash = "#/";
                }}
                sx={{ ml: -0.5 }}
              >
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("preferences.title")}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {cfg?.languageTitle ?? cfg?.languageName ?? cfg?.languageCode}
          </Typography>
        </Stack>
        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0, py: 0.5 }}>
          {SECTIONS.map((s) => {
            const selected = s === section;
            return (
              <Box
                key={s}
                onClick={() => onNavigate(s)}
                sx={{
                  px: 1.5,
                  py: 0.9,
                  cursor: "pointer",
                  borderInlineStart: "3px solid",
                  borderColor: selected ? "primary.main" : "transparent",
                  bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: selected ? 700 : 400 }}>
                  {t(`preferences.section.${s}`)}
                </Typography>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* ── Main pane ── */}
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <Box sx={{ maxWidth: 900, mx: "auto", p: 3 }}>
          {section === "brief" && <BriefSection />}
          {section === "instructions" && <InstructionsSection />}
          {section === "terminology" && <TerminologySection direction={cfg?.direction ?? "ltr"} />}
          {section === "examples" && <ExamplesSection />}
        </Box>
      </Box>
    </Box>
  );
}

// ── Shared save-state helper ───────────────────────────────────────────────
function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return { saving, setSaving, msg, setMsg, clear: () => setMsg(null) };
}

// ── Brief ──────────────────────────────────────────────────────────────────
function BriefSection() {
  const { t } = useTranslation();
  const { prefs, loading, refetch } = useTranslationPrefs(true);
  const [draft, setDraft] = useState<TranslationPrefs | null>(null);
  const save = useSaveState();

  useEffect(() => {
    if (prefs) setDraft(prefs);
  }, [prefs]);

  const onSave = async () => {
    if (!draft || !prefs) return;
    save.setSaving(true);
    try {
      await api.putTranslationPrefs(prefs.version, {
        audience: draft.audience,
        purpose: draft.purpose,
        register: draft.register,
        script_notes: draft.script_notes,
        notes: draft.notes,
        // brief section doesn't own instructions/assisted — omit so the server
        // merges the existing values.
      });
      save.setMsg(t("preferences.saved"));
      refetch();
    } catch (e) {
      save.setMsg(e instanceof ApiError && e.status === 409 ? t("preferences.conflict") : t("preferences.saveFailed"));
      refetch();
    } finally {
      save.setSaving(false);
    }
  };

  if (loading && !draft) return <CircularProgress size={22} />;
  if (!draft) return null;

  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("preferences.section.brief")}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.briefIntro")}
      </Typography>
      <TextField
        label={t("preferences.audience")}
        value={draft.audience ?? ""}
        onChange={(e) => setDraft({ ...draft, audience: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <TextField
        label={t("preferences.purpose")}
        value={draft.purpose ?? ""}
        onChange={(e) => setDraft({ ...draft, purpose: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <TextField
        select
        label={t("preferences.register")}
        value={draft.register}
        onChange={(e) => setDraft({ ...draft, register: e.target.value as Register })}
        sx={{ maxWidth: 240 }}
        size="small"
        helperText={t("preferences.registerHelp")}
      >
        {REGISTERS.map((r) => (
          <MenuItem key={r} value={r}>
            {t(`preferences.register.${r}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={t("preferences.scriptNotes")}
        value={draft.script_notes ?? ""}
        onChange={(e) => setDraft({ ...draft, script_notes: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <Box>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={save.saving}>
          {t("preferences.save")}
        </Button>
      </Box>
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

// ── Instructions ─────────────────────────────────────────────────────────────
function InstructionsSection() {
  const { t } = useTranslation();
  const { prefs, loading, refetch } = useTranslationPrefs(true);
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState(false);
  const save = useSaveState();

  useEffect(() => {
    if (prefs) setValue(prefs.instructions_md ?? "");
  }, [prefs]);

  const onSave = async () => {
    if (!prefs) return;
    save.setSaving(true);
    try {
      await api.putTranslationPrefs(prefs.version, { instructions_md: value || null });
      save.setMsg(t("preferences.saved"));
      refetch();
    } catch (e) {
      save.setMsg(e instanceof ApiError && e.status === 409 ? t("preferences.conflict") : t("preferences.saveFailed"));
      refetch();
    } finally {
      save.setSaving(false);
    }
  };

  if (loading && !prefs) return <CircularProgress size={22} />;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">{t("preferences.section.instructions")}</Typography>
        <ToggleButton
          size="small"
          value="preview"
          selected={preview}
          onChange={() => setPreview((p) => !p)}
          sx={{ textTransform: "none", py: 0.25 }}
        >
          <VisibilityIcon fontSize="small" sx={{ mr: 0.5 }} />
          {t("preferences.preview")}
        </ToggleButton>
      </Stack>
      <Alert severity="info" variant="outlined" sx={{ py: 0.25 }}>
        {t("preferences.instructionsIntro")}
      </Alert>
      {preview ? (
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, minHeight: 200 }}>
          <MarkdownView markdown={value || "_" + t("preferences.empty") + "_"} />
        </Box>
      ) : (
        <TextField
          value={value}
          onChange={(e) => setValue(e.target.value)}
          multiline
          minRows={10}
          fullWidth
          placeholder={t("preferences.instructionsPlaceholder")}
          slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
        />
      )}
      <Box>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={save.saving}>
          {t("preferences.save")}
        </Button>
      </Box>
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

// ── Terminology ──────────────────────────────────────────────────────────────
function StatusChip({ status }: { status: TermStatus }) {
  const { t } = useTranslation();
  const color = statusColor(status);
  return (
    <Chip
      label={t(`preferences.status.${status}`)}
      size="small"
      variant="outlined"
      sx={{ height: 18, fontSize: 10, fontWeight: 600, color, borderColor: color }}
    />
  );
}

function TerminologySection({ direction }: { direction: "ltr" | "rtl" }) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { terms, loading, refetch } = useTerms(true, {
    status: statusFilter || undefined,
    q: debouncedQ || undefined,
  });
  const [importOpen, setImportOpen] = useState(false);
  const save = useSaveState();

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  const onExport = () => {
    const a = document.createElement("a");
    a.href = api.termsExportPath();
    a.download = "terminology.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Typography variant="h6">{t("preferences.section.terminology")}</Typography>
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<UploadIcon />} onClick={() => setImportOpen((v) => !v)}>
            {t("preferences.import")}
          </Button>
          <Button size="small" startIcon={<DownloadIcon />} onClick={onExport}>
            {t("preferences.export")}
          </Button>
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.terminologyIntro")}
      </Typography>

      {importOpen && <ImportPanel onDone={() => { setImportOpen(false); refetch(); }} />}

      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
        <TextField
          size="small"
          placeholder={t("preferences.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.statusFilter")}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t("preferences.allStatuses")}</MenuItem>
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <NewTermRow direction={direction} onCreated={refetch} onError={() => save.setMsg(t("preferences.saveFailed"))} />

      {loading && terms.length === 0 ? (
        <CircularProgress size={22} />
      ) : terms.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("preferences.noTerms")}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {terms.map((term) => (
            <TermRow key={term.id} term={term} direction={direction} onChanged={refetch} />
          ))}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

function NewTermRow({
  direction,
  onCreated,
  onError,
}: {
  direction: "ltr" | "rtl";
  onCreated: () => void;
  onError: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TermInput>({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
  const [busy, setBusy] = useState(false);
  const canAdd = draft.concept_id.trim() && draft.source_term.trim();

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await api.createTerm({
        concept_id: draft.concept_id.trim(),
        source_term: draft.source_term.trim(),
        target_term: draft.target_term?.trim() || null,
        status: draft.status,
        replacement: draft.replacement?.trim() || null,
      });
      setDraft({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
      onCreated();
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} alignItems="flex-start">
        <TextField
          size="small"
          label={t("preferences.conceptId")}
          value={draft.concept_id}
          onChange={(e) => setDraft({ ...draft, concept_id: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.sourceTerm")}
          value={draft.source_term}
          onChange={(e) => setDraft({ ...draft, source_term: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.targetTerm")}
          value={draft.target_term ?? ""}
          onChange={(e) => setDraft({ ...draft, target_term: e.target.value })}
          sx={{ width: 160 }}
          slotProps={{ htmlInput: { dir: direction } }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.termStatus")}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
          sx={{ width: 160 }}
        >
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
        {draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            sx={{ width: 160 }}
            slotProps={{ htmlInput: { dir: direction } }}
          />
        )}
        <Button variant="outlined" startIcon={<AddIcon />} onClick={add} disabled={!canAdd || busy}>
          {t("preferences.addTerm")}
        </Button>
      </Stack>
    </Box>
  );
}

function TermRow({ term, direction, onChanged }: { term: Term; direction: "ltr" | "rtl"; onChanged: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Term>(term);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(term), [term]);

  const saveEdit = async () => {
    setBusy(true);
    try {
      await api.patchTerm(term.id, term.version, {
        target_term: draft.target_term,
        status: draft.status,
        replacement: draft.replacement,
        comment: draft.comment,
        tw_link: draft.tw_link,
      });
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.deleteTerm(term.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        p: 1.25,
        bgcolor: (theme) =>
          term.status === "forbidden" ? alpha(theme.palette.error.main, 0.05) : "transparent",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" gap={0.5}>
        <Chip label={term.concept_id} size="small" variant="outlined" sx={{ height: 20, fontFamily: "monospace", fontSize: 11 }} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {term.source_term}
        </Typography>
        <Typography variant="body2" color="text.disabled">
          →
        </Typography>
        {editing ? (
          <TextField
            size="small"
            value={draft.target_term ?? ""}
            onChange={(e) => setDraft({ ...draft, target_term: e.target.value || null })}
            slotProps={{ htmlInput: { dir: direction } }}
            sx={{ width: 180 }}
          />
        ) : (
          <Typography variant="body2" dir={direction} sx={{ fontWeight: 600 }}>
            {term.target_term ?? "—"}
          </Typography>
        )}
        {editing ? (
          <TextField
            select
            size="small"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
            sx={{ width: 150 }}
          >
            {TERM_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {t(`preferences.status.${s}`)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <StatusChip status={term.status} />
        )}
        {term.status === "forbidden" && !editing && term.replacement && (
          <Typography variant="caption" color="error.main">
            {t("preferences.useInstead", { term: term.replacement })}
          </Typography>
        )}
        {editing && draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value || null })}
            slotProps={{ htmlInput: { dir: direction } }}
            sx={{ width: 150 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {editing ? (
          <>
            <Button size="small" onClick={saveEdit} disabled={busy}>
              {t("preferences.save")}
            </Button>
            <Button size="small" color="inherit" onClick={() => { setEditing(false); setDraft(term); }}>
              {t("preferences.cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button size="small" onClick={() => setEditing(true)}>
              {t("preferences.edit")}
            </Button>
            <Tooltip title={t("preferences.delete")}>
              <IconButton size="small" onClick={del} disabled={busy}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      {term.tw_link && !editing && (
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {term.tw_link}
        </Typography>
      )}
    </Box>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ added: number; updated: number; total: number; errors: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await api.importTerms(text, dryRun);
      setResult({ added: res.added, updated: res.updated, total: res.total, errors: res.parseErrors.length });
      if (!dryRun) onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {t("preferences.importTitle")}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t("preferences.importHelp")}
      </Typography>
      <TextField
        value={text}
        onChange={(e) => setText(e.target.value)}
        multiline
        minRows={5}
        fullWidth
        placeholder={"concept_id,source_term,target_term,status,replacement,comment,tw_link"}
        sx={{ mt: 1 }}
        slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 12 } } }}
      />
      {result && (
        <Alert severity={result.errors ? "warning" : "success"} sx={{ mt: 1, py: 0.25 }}>
          {t("preferences.importResult", { added: result.added, updated: result.updated, errors: result.errors })}
        </Alert>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" onClick={() => run(true)} disabled={busy || !text.trim()}>
          {t("preferences.dryRun")}
        </Button>
        <Button size="small" variant="contained" onClick={() => run(false)} disabled={busy || !text.trim()}>
          {t("preferences.applyImport")}
        </Button>
      </Stack>
    </Box>
  );
}

// ── Examples ─────────────────────────────────────────────────────────────────
function ExamplesSection() {
  const { t } = useTranslation();
  const [resource, setResource] = useState<"tn" | "tq">("tn");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { examples, loading, refetch } = useExamples(true, { resource, q: debouncedQ || undefined, limit: 200 });
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  const revoke = async (id: string, book: string) => {
    setBusyId(id);
    try {
      if (resource === "tn") await api.validateNote(id, book, false);
      else await api.validateQuestion(id, book, false);
      refetch();
    } finally {
      setBusyId(null);
    }
  };

  const count = examples.length;

  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("preferences.section.examples")}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.examplesIntro")}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={resource}
          onChange={(_, v) => v && setResource(v)}
        >
          <ToggleButton value="tn" sx={{ textTransform: "none", py: 0.25 }}>
            {t("preferences.notes")}
          </ToggleButton>
          <ToggleButton value="tq" sx={{ textTransform: "none", py: 0.25 }}>
            {t("preferences.questions")}
          </ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder={t("preferences.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <Typography variant="caption" color="text.secondary">
          {t("preferences.examplesCount", { n: count })}
        </Typography>
      </Stack>

      {loading && examples.length === 0 ? (
        <CircularProgress size={22} />
      ) : examples.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("preferences.noExamples")}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {examples.map((ex) => (
            <Box
              key={ex.id}
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                p: 1.25,
                borderInlineStart: "3px solid",
                borderInlineStartColor: "success.main",
                bgcolor: (theme) => alpha(theme.palette.success.main, 0.05),
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <Chip
                  label={`${ex.book} ${ex.ref_raw}`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: 11 }}
                />
                {ex.support_reference && (
                  <Chip label={ex.support_reference} size="small" sx={{ height: 20, fontSize: 10 }} />
                )}
                <Box sx={{ flex: 1 }} />
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => revoke(ex.id, ex.book)}
                  disabled={busyId === ex.id}
                >
                  {t("preferences.revoke")}
                </Button>
              </Stack>
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: "pre-wrap" }}>
                {resource === "tn" ? ex.note : `${ex.question ?? ""}\n${ex.response ?? ""}`}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

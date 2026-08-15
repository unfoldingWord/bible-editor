import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Stack,
  Typography,
  IconButton,
  Tooltip,
  FormControl,
  Box,
  Divider,
  Autocomplete,
  TextField,
  InputAdornment,
  Snackbar,
  Alert,
  CircularProgress,
  Popover,
  Button,
} from "@mui/material";
import FormatSizeIcon from "@mui/icons-material/FormatSize";
import RemoveIcon from "@mui/icons-material/Remove";
import AddIcon from "@mui/icons-material/Add";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";
import MenuIcon from "@mui/icons-material/Menu";
import Brightness4Icon from "@mui/icons-material/Brightness4";
import Brightness7Icon from "@mui/icons-material/Brightness7";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import LogoutIcon from "@mui/icons-material/Logout";
import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import { api, getRole, type BookListEntry, type BookSummary } from "../sync/api";
import { SyncStatusBar } from "./SyncStatusBar";
import { VersionIndicator } from "./VersionIndicator";
import { BOOKS, bookName, resolveBook } from "../lib/bookNames";
import { parseReference } from "../lib/referenceParser";
import {
  ThemeModeContext,
  FontScaleContext,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  FONT_SCALE_STEP,
  FONT_SCALE_DEFAULT,
} from "../theme";

// Compact "Aa" control for the reading-text font scale. Lives beside the
// theme toggle; opens a small popover with −/＋ and a reset. Scales the ULT/UST
// editors and note bodies via the `--be-reading-scale` CSS var.
function FontSizeControl() {
  const { scale, setScale } = useContext(FontScaleContext);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pct = Math.round(scale * 100);

  return (
    <>
      <Tooltip title="reading text size">
        <IconButton
          ref={anchorRef}
          size="small"
          onClick={() => setOpen(true)}
          aria-label="adjust reading text size"
        >
          <FormatSizeIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        open={open}
        anchorEl={anchorRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Box sx={{ px: 1.5, py: 1, minWidth: 200 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.75 }}>
            Reading text size
          </Typography>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Tooltip title="smaller">
              <span>
                <IconButton
                  size="small"
                  onClick={() => setScale(scale - FONT_SCALE_STEP)}
                  disabled={scale <= FONT_SCALE_MIN + 1e-6}
                  aria-label="decrease reading text size"
                >
                  <RemoveIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography
              variant="body2"
              sx={{ flex: 1, textAlign: "center", fontVariantNumeric: "tabular-nums" }}
            >
              {pct}%
            </Typography>
            <Tooltip title="larger">
              <span>
                <IconButton
                  size="small"
                  onClick={() => setScale(scale + FONT_SCALE_STEP)}
                  disabled={scale >= FONT_SCALE_MAX - 1e-6}
                  aria-label="increase reading text size"
                >
                  <AddIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <Button
            size="small"
            fullWidth
            onClick={() => setScale(FONT_SCALE_DEFAULT)}
            disabled={Math.abs(scale - FONT_SCALE_DEFAULT) < 1e-6}
            sx={{ mt: 0.75, textTransform: "none" }}
          >
            Reset to 100%
          </Button>
        </Box>
      </Popover>
    </>
  );
}

interface Props {
  book: string;
  chapter: number;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
  pipelineMenu?: ReactNode;
  pipelineStatus?: ReactNode;
  logosSyncToggle?: ReactNode;
  syncWarnings?: ReactNode;
  lintIndicator?: ReactNode;
  alignIndicator?: ReactNode;
  notesIndicator?: ReactNode;
  notificationsMenu?: ReactNode;
  exportMenu?: ReactNode;
  bookLocksButton?: ReactNode;
  railCollapsed?: boolean;
  onToggleRail?: () => void;
  onRequestReload?: () => void;
  onLogout?: () => void;
}

export function TopBar({
  book,
  chapter,
  onNavigate,
  pipelineMenu,
  pipelineStatus,
  logosSyncToggle,
  syncWarnings,
  lintIndicator,
  alignIndicator,
  notesIndicator,
  notificationsMenu,
  exportMenu,
  bookLocksButton,
  railCollapsed,
  onToggleRail,
  onRequestReload,
  onLogout,
}: Props) {
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [refInput, setRefInput] = useState("");
  const [refError, setRefError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const { mode, toggle } = useContext(ThemeModeContext);

  useEffect(() => {
    api.getBooks().then((r) => setBooks(r.books)).catch(() => setBooks([]));
  }, []);

  useEffect(() => {
    setSummary(null);
    api.getBookSummary(book).then(setSummary).catch(() => setSummary(null));
  }, [book]);

  // Trigger a DCS import for an unfetched book, then refresh the books list
  // and navigate. The caller's onChange short-circuits if the book is
  // already imported, so this is the cold path only.
  const importAndNavigate = async (
    code: string,
    targetChapter: number = 1,
    verse?: number,
  ) => {
    setImporting(code);
    setImportError(null);
    try {
      await api.importBook(code);
      const r = await api.getBooks();
      setBooks(r.books);
      onNavigate(code, targetChapter, verse);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportError(`Couldn't import ${bookName(code)}: ${msg}`);
    } finally {
      setImporting(null);
    }
  };

  const chapterList = (summary?.chapters ?? []).map((c) => c.chapter);
  const idx = chapterList.indexOf(chapter);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < chapterList.length - 1;

  // Canonical 66-book list — unimported books surface in the dropdown with
  // a "+" hint, and selecting one kicks off importAndNavigate. Keeping the
  // canonical order means books always land in their familiar slot.
  const importedSet = useMemo(() => new Set(books.map((b) => b.book)), [books]);
  const bookOptions = useMemo(() => BOOKS.map((b) => b.code), []);

  const chapterOptions = useMemo(
    () => (chapterList.length > 0 ? chapterList.map(String) : [String(chapter)]),
    [chapterList, chapter],
  );

  const submitRef = () => {
    const result = parseReference(refInput);
    if (!result.ok) {
      setRefError(result.error);
      return;
    }
    const { book: refBook, chapter: refChapter, verse } = result.ref;
    const targetBook = refBook ?? book;
    const targetChapter = refChapter ?? chapter;
    setRefError(null);
    setRefInput("");
    if (importedSet.has(targetBook)) {
      onNavigate(targetBook, targetChapter, verse);
    } else {
      void importAndNavigate(targetBook, targetChapter, verse);
    }
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={{ xs: 0.75, md: 1.5 }}
      sx={{
        px: { xs: 1, md: 2 },
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexWrap: "wrap",
        rowGap: 0.5,
      }}
    >
      {onToggleRail && (
        <Tooltip title={railCollapsed ? "show verse list" : "hide verse list"}>
          <IconButton size="small" onClick={onToggleRail} sx={{ ml: -0.5 }}>
            {railCollapsed ? <MenuIcon fontSize="small" /> : <MenuOpenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      <FormControl size="small">
        <Autocomplete<string, false, true, false>
          size="small"
          value={book}
          options={bookOptions.includes(book) ? bookOptions : [book, ...bookOptions]}
          disableClearable
          disabled={importing !== null}
          onChange={(_, v) => {
            if (!v || v === book) return;
            if (importedSet.has(v)) {
              onNavigate(v, 1);
            } else {
              void importAndNavigate(v);
            }
          }}
          selectOnFocus
          openOnFocus
          filterOptions={(options, state) => {
            const q = state.inputValue.trim().toLowerCase();
            // When the input is empty OR still matches the current value
            // (user just opened the dropdown without typing), show every
            // book so they can pick a new one. Filtering only kicks in
            // once they actually type something else.
            if (!q || q === book.toLowerCase()) return options;
            const resolved = resolveBook(q);
            return options.filter((opt) => {
              if (opt.toLowerCase().startsWith(q)) return true;
              if (resolved && opt === resolved) return true;
              return bookName(opt).toLowerCase().includes(q);
            });
          }}
          getOptionLabel={(opt) => opt}
          renderOption={(props, opt) => {
            const isImported = importedSet.has(opt);
            return (
              <li
                {...props}
                key={opt}
                style={{ fontFamily: "monospace", opacity: isImported ? 1 : 0.6 }}
              >
                <span style={{ minWidth: 40, display: "inline-block" }}>{opt}</span>
                <Box
                  component="span"
                  sx={{ color: "text.secondary", fontSize: 12, ml: 1, flex: 1 }}
                >
                  {bookName(opt)}
                </Box>
                {!isImported && (
                  <Tooltip title="not imported — selecting will fetch from DCS">
                    <CloudDownloadIcon
                      fontSize="inherit"
                      sx={{ ml: 1, color: "text.disabled", fontSize: 14 }}
                    />
                  </Tooltip>
                )}
              </li>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              inputProps={{
                ...params.inputProps,
                style: { fontFamily: "monospace", textTransform: "uppercase" },
              }}
              InputProps={{
                ...params.InputProps,
                endAdornment: importing ? (
                  <InputAdornment position="end">
                    <CircularProgress size={14} />
                  </InputAdornment>
                ) : params.InputProps.endAdornment,
              }}
            />
          )}
          sx={{ width: 112 }}
        />
      </FormControl>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Tooltip title="previous chapter">
          <span>
            <IconButton
              size="small"
              disabled={!canPrev}
              onClick={() => canPrev && onNavigate(book, chapterList[idx - 1])}
            >
              <NavigateBeforeIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", color: "text.secondary", userSelect: "none" }}
        >
          ch
        </Typography>
        <FormControl size="small">
          <Autocomplete<string, false, true, false>
            size="small"
            value={String(chapter)}
            options={chapterOptions}
            disableClearable
            onChange={(_, v) => {
              if (v) onNavigate(book, parseInt(v, 10));
            }}
            getOptionLabel={(opt) => (opt === "0" ? "intro" : opt)}
            filterOptions={(options, state) => {
              const q = state.inputValue.trim();
              if (!q) return options;
              return options.filter((opt) =>
                opt === "0" ? "intro".startsWith(q.toLowerCase()) : opt.startsWith(q),
              );
            }}
            renderOption={(props, opt) => (
              <li {...props} key={opt} style={{ fontFamily: "monospace" }}>
                {opt === "0" ? "intro" : opt}
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                inputProps={{
                  ...params.inputProps,
                  style: { fontFamily: "monospace", textAlign: "center" },
                }}
              />
            )}
            sx={{ width: 76 }}
          />
        </FormControl>
        <Tooltip title="next chapter">
          <span>
            <IconButton
              size="small"
              disabled={!canNext}
              onClick={() => canNext && onNavigate(book, chapterList[idx + 1])}
            >
              <NavigateNextIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Box sx={{ display: { xs: "none", md: "block" } }}>
        <Tooltip
          title={refError ?? "go to: 5 · 5:5 · zec 5:5 · ps 1:4 (Enter)"}
          open={refError ? true : undefined}
        >
          <TextField
            size="small"
            placeholder="go to ref"
            value={refInput}
            onChange={(e) => {
              setRefInput(e.target.value);
              if (refError) setRefError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitRef();
              } else if (e.key === "Escape") {
                setRefInput("");
                setRefError(null);
              }
            }}
            error={Boolean(refError)}
            inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="go">
                    <span>
                      <IconButton
                        size="small"
                        onClick={submitRef}
                        disabled={!refInput.trim()}
                        edge="end"
                      >
                        <ArrowForwardIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </InputAdornment>
              ),
            }}
            sx={{ width: 170 }}
          />
        </Tooltip>
      </Box>
      <Box sx={{ display: { xs: "none", md: "flex" }, alignItems: "center" }}>
        {logosSyncToggle}
      </Box>
      <Box sx={{ flex: 1 }} />
      {summary?.chapters && (
        <Box sx={{ display: { xs: "none", lg: "flex" }, alignItems: "center", gap: 1.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
            {summary.chapters.reduce((a, c) => a + c.tn, 0)} notes · {summary.chapters.reduce((a, c) => a + c.twl, 0)} words · {summary.chapters.reduce((a, c) => a + c.tq, 0)} questions
          </Typography>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
        </Box>
      )}
      {syncWarnings}
      {lintIndicator}
      {alignIndicator}
      {notesIndicator}
      {notificationsMenu}
      <VersionIndicator onRequestReload={onRequestReload} />
      <SyncStatusBar onNavigate={onNavigate} />
      {exportMenu}
      <FontSizeControl />
      <Tooltip title={mode === "dark" ? "switch to light mode" : "switch to dark mode"}>
        <IconButton size="small" onClick={toggle} aria-label="toggle color mode">
          {mode === "dark" ? <Brightness7Icon fontSize="small" /> : <Brightness4Icon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
      {pipelineMenu}
      {pipelineStatus}
      {bookLocksButton}
      {getRole() === "admin" && (
        <Tooltip title="Admin">
          <IconButton
            size="small"
            onClick={() => { window.location.hash = "#/admin"; }}
            aria-label="Admin"
          >
            <AdminPanelSettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {onLogout && (
        <>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
          <Tooltip title="Sign out">
            <IconButton
              size="small"
              onClick={onLogout}
              aria-label="sign out"
              sx={{ color: "text.disabled", "&:hover": { color: "text.secondary" } }}
            >
              <LogoutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </>
      )}
      <Snackbar
        open={importing !== null}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" icon={<CircularProgress size={16} />}>
          Importing {importing ? bookName(importing) : ""} from DCS…
        </Alert>
      </Snackbar>
      <Snackbar
        open={importError !== null}
        autoHideDuration={6000}
        onClose={() => setImportError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setImportError(null)}>
          {importError}
        </Alert>
      </Snackbar>
    </Stack>
  );
}

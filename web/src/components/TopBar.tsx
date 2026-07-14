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
import LanguageIcon from "@mui/icons-material/Language";
import CheckIcon from "@mui/icons-material/Check";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import TuneIcon from "@mui/icons-material/Tune";
import { Menu, MenuItem, ListItemIcon, ListItemText } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { UI_LANGUAGES } from "../i18n";
import { UiLangContext } from "../i18n/UiLangContext";
import { api, type BookListEntry, type BookSummary } from "../sync/api";
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
  const { t } = useTranslation();
  const { scale, setScale } = useContext(FontScaleContext);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pct = Math.round(scale * 100);

  return (
    <>
      <Tooltip title={t("topbar.readingTextSizeTooltip")}>
        <IconButton
          ref={anchorRef}
          size="small"
          onClick={() => setOpen(true)}
          aria-label={t("topbar.adjustReadingTextSize")}
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
            {t("topbar.readingTextSize")}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Tooltip title={t("topbar.smaller")}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => setScale(scale - FONT_SCALE_STEP)}
                  disabled={scale <= FONT_SCALE_MIN + 1e-6}
                  aria-label={t("topbar.decreaseReadingTextSize")}
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
            <Tooltip title={t("topbar.larger")}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => setScale(scale + FONT_SCALE_STEP)}
                  disabled={scale >= FONT_SCALE_MAX - 1e-6}
                  aria-label={t("topbar.increaseReadingTextSize")}
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
            {t("topbar.resetTo100")}
          </Button>
        </Box>
      </Popover>
    </>
  );
}

// UI-chrome language switcher. Changing the language re-renders every t()
// string AND flips the whole chrome's direction when the language is RTL
// (document.dir + MUI theme.direction + the emotion RTL cache — see main.tsx).
function UiLanguageControl() {
  const { t } = useTranslation();
  const { lang, setLang } = useContext(UiLangContext);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip title={t("topbar.uiLanguage")}>
        <IconButton
          ref={anchorRef}
          size="small"
          onClick={() => setOpen(true)}
          aria-label={t("topbar.uiLanguage")}
        >
          <LanguageIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu open={open} anchorEl={anchorRef.current} onClose={() => setOpen(false)}>
        {UI_LANGUAGES.map((l) => (
          <MenuItem
            key={l.code}
            selected={l.code === lang}
            onClick={() => {
              setLang(l.code);
              setOpen(false);
            }}
          >
            <ListItemIcon sx={{ visibility: l.code === lang ? "visible" : "hidden" }}>
              <CheckIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{l.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
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
  lintIndicator?: ReactNode;
  exportMenu?: ReactNode;
  railCollapsed?: boolean;
  onToggleRail?: () => void;
  onRequestReload?: () => void;
}

export function TopBar({
  book,
  chapter,
  onNavigate,
  pipelineMenu,
  pipelineStatus,
  logosSyncToggle,
  lintIndicator,
  exportMenu,
  railCollapsed,
  onToggleRail,
  onRequestReload,
}: Props) {
  const { t } = useTranslation();
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [refInput, setRefInput] = useState("");
  const [refError, setRefError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const { mode, toggle } = useContext(ThemeModeContext);
  const projectConfig = useProjectConfig();
  const showArticles = isTranslationProject(projectConfig);

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
      setImportError(t("topbar.couldntImport", { book: bookName(code), message: msg }));
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
        <Tooltip title={railCollapsed ? t("topbar.showVerseList") : t("topbar.hideVerseList")}>
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
                  <Tooltip title={t("topbar.notImportedHint")}>
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
        <Tooltip title={t("topbar.previousChapter")}>
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
          {t("topbar.chapterAbbrev")}
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
            getOptionLabel={(opt) => (opt === "0" ? t("topbar.intro") : opt)}
            filterOptions={(options, state) => {
              const q = state.inputValue.trim();
              if (!q) return options;
              return options.filter((opt) =>
                opt === "0" ? "intro".startsWith(q.toLowerCase()) : opt.startsWith(q),
              );
            }}
            renderOption={(props, opt) => (
              <li {...props} key={opt} style={{ fontFamily: "monospace" }}>
                {opt === "0" ? t("topbar.intro") : opt}
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
        <Tooltip title={t("topbar.nextChapter")}>
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
          title={refError ?? t("topbar.goToRefHint")}
          open={refError ? true : undefined}
        >
          <TextField
            size="small"
            placeholder={t("topbar.goToRefPlaceholder")}
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
                  <Tooltip title={t("common.go")}>
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
            {t("topbar.stats", {
              notes: summary.chapters.reduce((a, c) => a + c.tn, 0),
              words: summary.chapters.reduce((a, c) => a + c.twl, 0),
              questions: summary.chapters.reduce((a, c) => a + c.tq, 0),
            })}
          </Typography>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
        </Box>
      )}
      {showArticles && (
        <Tooltip title={t("articles.title")}>
          <Button
            size="small"
            variant="text"
            color="inherit"
            startIcon={<ArticleOutlinedIcon fontSize="small" />}
            onClick={() => {
              location.hash = "#/articles/tw";
            }}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            {t("articles.title")}
          </Button>
        </Tooltip>
      )}
      {showArticles && (
        <Tooltip title={t("preferences.title")}>
          <Button
            size="small"
            variant="text"
            color="inherit"
            startIcon={<TuneIcon fontSize="small" />}
            onClick={() => {
              location.hash = "#/preferences";
            }}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            {t("preferences.title")}
          </Button>
        </Tooltip>
      )}
      {lintIndicator}
      <VersionIndicator onRequestReload={onRequestReload} />
      <SyncStatusBar onNavigate={onNavigate} />
      {exportMenu}
      <FontSizeControl />
      <UiLanguageControl />
      <Tooltip title={mode === "dark" ? t("topbar.switchToLight") : t("topbar.switchToDark")}>
        <IconButton size="small" onClick={toggle} aria-label={t("topbar.toggleColorMode")}>
          {mode === "dark" ? <Brightness7Icon fontSize="small" /> : <Brightness4Icon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
      {pipelineMenu}
      {pipelineStatus}
      <Snackbar
        open={importing !== null}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" icon={<CircularProgress size={16} />}>
          {t("topbar.importingFromDcs", { book: importing ? bookName(importing) : "" })}
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

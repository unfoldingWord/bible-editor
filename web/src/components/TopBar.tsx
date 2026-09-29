import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import MoreVertIcon from "@mui/icons-material/MoreVert";
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

// Items that move into the overflow menu when the bar runs out of width, in
// the order they leave the bar (issue #1024): the first key collapses first.
const COLLAPSE_ORDER = [
  "totals",
  "logos",
  "version",
  "admin",
  "dark",
  "logout",
  "font",
  "download",
  "print",
] as const;
type CollapseKey = (typeof COLLAPSE_ORDER)[number];

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
  trashIndicator?: ReactNode;
  notificationsMenu?: ReactNode;
  exportMenu?: ReactNode;
  printPreview?: ReactNode;
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
  trashIndicator,
  notificationsMenu,
  exportMenu,
  printPreview,
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
  const barRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // How many of the present COLLAPSE_ORDER items currently live in the menu.
  const [collapsedCount, setCollapsedCount] = useState(0);
  // Last measured width (incl. left margin) of each collapsible slot while it
  // sat in the bar; 0 = rendered nothing (e.g. version unknown).
  const slotWidths = useRef<Partial<Record<CollapseKey, number>>>({});
  const moreWidth = useRef(0);
  const lastSig = useRef("");
  const [, setTick] = useState(0);

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

  const isAdmin = getRole() === "admin";
  const totals = summary?.chapters
    ? `${summary.chapters.reduce((a, c) => a + c.tn, 0)} notes · ${summary.chapters.reduce((a, c) => a + c.twl, 0)} words · ${summary.chapters.reduce((a, c) => a + c.tq, 0)} questions`
    : null;

  const nodes: Partial<Record<CollapseKey, ReactNode>> = {
    totals: totals ? (
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
        {totals}
      </Typography>
    ) : null,
    logos: logosSyncToggle ?? null,
    version: <VersionIndicator onRequestReload={onRequestReload} />,
    admin:
      isAdmin || bookLocksButton ? (
        <>
          {bookLocksButton}
          {isAdmin && (
            <Tooltip title="Admin">
              <IconButton
                size="small"
                onClick={() => { setMoreOpen(false); window.location.hash = "#/admin"; }}
                aria-label="Admin"
              >
                <AdminPanelSettingsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </>
      ) : null,
    dark: (
      <Tooltip title={mode === "dark" ? "switch to light mode" : "switch to dark mode"}>
        <IconButton size="small" onClick={toggle} aria-label="toggle color mode">
          {mode === "dark" ? <Brightness7Icon fontSize="small" /> : <Brightness4Icon fontSize="small" />}
        </IconButton>
      </Tooltip>
    ),
    logout: onLogout ? (
      <Tooltip title="Sign out">
        <IconButton
          size="small"
          onClick={() => { setMoreOpen(false); onLogout(); }}
          aria-label="sign out"
          sx={{ color: "text.disabled", "&:hover": { color: "text.secondary" } }}
        >
          <LogoutIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    ) : null,
    font: <FontSizeControl />,
    download: exportMenu,
    print: printPreview,
  };
  const isPresent = (k: CollapseKey) => Boolean(nodes[k]) && slotWidths.current[k] !== 0;
  const present = COLLAPSE_ORDER.filter(isPresent);
  const collapsed = new Set<CollapseKey>(present.slice(0, collapsedCount));
  // Every collapsible item sits in a slot wrapper so its width can be measured;
  // an empty slot (component rendered null) hides itself.
  const slotSx = {
    display: "flex",
    alignItems: "center",
    gap: { xs: 0.75, md: 1.5 },
    "&:empty": { display: "none" },
  } as const;
  const inBar = (k: CollapseKey) =>
    collapsed.has(k) || !nodes[k] ? null : (
      <Box data-slot={k} sx={slotSx}>
        {k === "logout" && <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />}
        {nodes[k]}
        {k === "totals" && <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />}
      </Box>
    );
  const allCollapsed = collapsedCount >= present.length;

  // Keep the bar to one row. The bar is nowrap; each pass measures how much
  // room is left (bar width minus the natural width of every child) and picks
  // the smallest number of collapsed items that fits, using the last measured
  // width of each item, so nothing depends on a stale threshold. Runs before
  // paint, and again whenever any child or the bar changes size (see below).
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    let emptyChanged = false;
    for (const k of COLLAPSE_ORDER) {
      const slot = el.querySelector(`:scope > [data-slot="${k}"]`) as HTMLElement | null;
      if (!slot) continue;
      const w = slot.offsetWidth > 0 ? slot.offsetWidth + (parseFloat(getComputedStyle(slot).marginLeft) || 0) : 0;
      if ((w === 0) !== (slotWidths.current[k] === 0)) emptyChanged = true;
      slotWidths.current[k] = w;
    }
    if (emptyChanged) {
      setTick((t) => t + 1);
      return;
    }
    const cs = getComputedStyle(el);
    let natural = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const c = getComputedStyle(child);
      // A fixed child (an open Snackbar) takes no room in the row.
      if (c.display === "none" || c.position === "fixed") continue;
      // The spacer stretches to fill leftover room, so only its margin counts.
      const own = child.hasAttribute("data-spacer") ? 0 : child.offsetWidth;
      natural += own + (parseFloat(c.marginLeft) || 0);
    }
    const free = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - natural;
    const items = COLLAPSE_ORDER.filter(isPresent);
    const cur = Math.min(collapsedCount, items.length);
    const more = moreWidth.current || 46;
    const freeAt = (n: number) => {
      let f = free + (cur > 0 ? more : 0) - (n > 0 ? more : 0);
      items.forEach((k, i) => {
        const w = slotWidths.current[k] ?? 0;
        if (i >= cur && i < n) f += w;
        if (i >= n && i < cur) f -= w;
      });
      return f;
    };
    let n = 0;
    while (n < items.length && freeAt(n) < -0.5) n++;
    if (moreOpen && n < cur) n = cur; // don't pull items out from under an open menu
    if (n !== collapsedCount) setCollapsedCount(n);
    const mb = moreRef.current;
    if (mb) moreWidth.current = mb.offsetWidth + (parseFloat(getComputedStyle(mb).marginLeft) || 0);
  });
  // Re-render when the bar or any child changes size (e.g. the sync chip going
  // from "saved" to "3 unsaved") or the window resizes; the layout effect above
  // does the real work. The signature check stops re-observe loops.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const sig = () =>
      [el.clientWidth, ...Array.from(el.children).map((c) => (c as HTMLElement).offsetWidth)].join(",");
    lastSig.current = sig();
    const onChange = () => {
      const next = sig();
      if (next === lastSig.current) return;
      lastSig.current = next;
      setTick((t) => t + 1);
    };
    window.addEventListener("resize", onChange);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onChange);
      ro.observe(el);
      Array.from(el.children).forEach((c) => ro!.observe(c));
    }
    return () => {
      window.removeEventListener("resize", onChange);
      ro?.disconnect();
    };
  });
  // The menu has nothing left to show once every item is back in the bar.
  useEffect(() => {
    if (collapsed.size === 0 && moreOpen) setMoreOpen(false);
  }, [collapsed.size, moreOpen]);

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={{ xs: 0.75, md: 1.5 }}
      ref={barRef}
      sx={{
        px: { xs: 1, md: 2 },
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        // One row (issue #1024). Only if every collapsible item is already in
        // the menu and it still overflows do we fall back to wrapping.
        flexWrap: allCollapsed ? "wrap" : "nowrap",
        rowGap: 0.5,
        "& > *": { flexShrink: 0 },
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
      {inBar("logos")}
      <Box data-spacer sx={{ flex: 1 }} />
      {inBar("totals")}
      {syncWarnings}
      {lintIndicator}
      {alignIndicator}
      {notesIndicator}
      {trashIndicator}
      {notificationsMenu}
      {inBar("version")}
      <SyncStatusBar onNavigate={onNavigate} />
      {inBar("download")}
      {inBar("print")}
      {inBar("font")}
      {inBar("dark")}
      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
      {pipelineMenu}
      {pipelineStatus}
      {inBar("admin")}
      {inBar("logout")}
      {collapsed.size > 0 && (
        <>
          <Tooltip title="more">
            <IconButton
              ref={moreRef}
              size="small"
              onClick={() => setMoreOpen(true)}
              aria-label="more options"
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Popover
            open={moreOpen}
            // Collapsed items stay mounted while the menu is closed, so
            // background work (Logos auto-follow, version polling) keeps running.
            keepMounted
            anchorEl={moreRef.current}
            onClose={() => setMoreOpen(false)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <Stack spacing={1} sx={{ p: 1.5, maxWidth: 300 }} data-testid="topbar-overflow">
              {COLLAPSE_ORDER.filter((k) => collapsed.has(k) && k !== "totals").length > 0 && (
                <Stack direction="row" alignItems="center" flexWrap="wrap" gap={0.5}>
                  {COLLAPSE_ORDER.filter((k) => collapsed.has(k) && k !== "totals").map((k) => (
                    <Box key={k} sx={{ display: "flex", alignItems: "center" }}>
                      {nodes[k]}
                    </Box>
                  ))}
                </Stack>
              )}
              {collapsed.has("totals") && nodes.totals}
            </Stack>
          </Popover>
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

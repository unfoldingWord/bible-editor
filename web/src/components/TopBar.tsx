import { useEffect, useMemo, useState, type ReactNode } from "react";
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
} from "@mui/material";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";
import MenuIcon from "@mui/icons-material/Menu";
import { api, type BookListEntry, type BookSummary } from "../sync/api";
import { SyncStatusBar } from "./SyncStatusBar";
import { bookName, resolveBook } from "../lib/bookNames";
import { parseReference } from "../lib/referenceParser";

interface Props {
  book: string;
  chapter: number;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
  pipelineMenu?: ReactNode;
  logosSyncToggle?: ReactNode;
  railCollapsed?: boolean;
  onToggleRail?: () => void;
}

export function TopBar({
  book,
  chapter,
  onNavigate,
  pipelineMenu,
  logosSyncToggle,
  railCollapsed,
  onToggleRail,
}: Props) {
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [refInput, setRefInput] = useState("");
  const [refError, setRefError] = useState<string | null>(null);

  useEffect(() => {
    api.getBooks().then((r) => setBooks(r.books)).catch(() => setBooks([]));
  }, []);

  useEffect(() => {
    setSummary(null);
    api.getBookSummary(book).then(setSummary).catch(() => setSummary(null));
  }, [book]);

  const chapterList = (summary?.chapters ?? []).map((c) => c.chapter);
  const idx = chapterList.indexOf(chapter);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < chapterList.length - 1;

  const bookOptions = useMemo(() => books.map((b) => b.book), [books]);

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
    onNavigate(targetBook, targetChapter, verse);
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      sx={{
        px: 2,
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      {onToggleRail && (
        <Tooltip title={railCollapsed ? "show verse list" : "hide verse list"}>
          <IconButton size="small" onClick={onToggleRail} sx={{ ml: -0.5 }}>
            {railCollapsed ? <MenuIcon fontSize="small" /> : <MenuOpenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      <Typography variant="h6" sx={{ fontWeight: 500, mr: 1 }}>
        Bible Editor
      </Typography>
      <FormControl size="small">
        <Autocomplete<string, false, true, false>
          size="small"
          value={book}
          options={bookOptions.includes(book) ? bookOptions : [book, ...bookOptions]}
          disableClearable
          onChange={(_, v) => {
            if (v && v !== book) onNavigate(v, 1);
          }}
          filterOptions={(options, state) => {
            const q = state.inputValue.trim().toLowerCase();
            if (!q) return options;
            const resolved = resolveBook(q);
            return options.filter((opt) => {
              if (opt.toLowerCase().startsWith(q)) return true;
              if (resolved && opt === resolved) return true;
              return bookName(opt).toLowerCase().includes(q);
            });
          }}
          getOptionLabel={(opt) => opt}
          renderOption={(props, opt) => (
            <li {...props} key={opt} style={{ fontFamily: "monospace" }}>
              <span style={{ minWidth: 40, display: "inline-block" }}>{opt}</span>
              <span style={{ color: "rgba(0,0,0,0.55)", fontSize: 12, marginLeft: 8 }}>
                {bookName(opt)}
              </span>
            </li>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              inputProps={{
                ...params.inputProps,
                style: { fontFamily: "monospace", textTransform: "uppercase" },
              }}
            />
          )}
          sx={{ width: 96 }}
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
      {logosSyncToggle}
      <Box sx={{ flex: 1 }} />
      {summary?.chapters && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
            {summary.chapters.reduce((a, c) => a + c.tn, 0)} notes · {summary.chapters.reduce((a, c) => a + c.twl, 0)} words · {summary.chapters.reduce((a, c) => a + c.tq, 0)} questions
          </Typography>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
        </>
      )}
      <SyncStatusBar />
      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
      {pipelineMenu}
    </Stack>
  );
}

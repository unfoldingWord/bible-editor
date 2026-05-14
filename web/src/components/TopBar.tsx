import { useEffect, useState, type ReactNode } from "react";
import {
  Stack,
  Typography,
  IconButton,
  Tooltip,
  Select,
  MenuItem,
  FormControl,
  Box,
  Divider,
} from "@mui/material";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import { api, type BookListEntry, type BookSummary } from "../sync/api";
import { SyncStatusBar } from "./SyncStatusBar";

interface Props {
  book: string;
  chapter: number;
  onNavigate: (book: string, chapter: number) => void;
  pipelineMenu?: ReactNode;
  logosSyncToggle?: ReactNode;
}

export function TopBar({ book, chapter, onNavigate, pipelineMenu, logosSyncToggle }: Props) {
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [summary, setSummary] = useState<BookSummary | null>(null);

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
      <Typography variant="h6" sx={{ fontWeight: 500, mr: 1 }}>
        Bible Editor
      </Typography>
      <FormControl size="small">
        <Select
          value={book}
          onChange={(e) => {
            const nextBook = e.target.value as string;
            onNavigate(nextBook, 1);
          }}
          sx={{ fontFamily: "monospace", minWidth: 80 }}
        >
          {books.map((b) => (
            <MenuItem key={b.book} value={b.book} sx={{ fontFamily: "monospace" }}>
              {b.book}
            </MenuItem>
          ))}
          {!books.find((b) => b.book === book) && (
            <MenuItem value={book} sx={{ fontFamily: "monospace" }}>
              {book}
            </MenuItem>
          )}
        </Select>
      </FormControl>
      <Stack direction="row" alignItems="center" spacing={0}>
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
        <FormControl size="small">
          <Select
            value={String(chapter)}
            onChange={(e) => onNavigate(book, parseInt(e.target.value, 10))}
            sx={{ fontFamily: "monospace", minWidth: 76 }}
          >
            {chapterList.map((c) => (
              <MenuItem key={c} value={String(c)} sx={{ fontFamily: "monospace" }}>
                {c === 0 ? "intro" : `ch ${c}`}
              </MenuItem>
            ))}
            {chapterList.length === 0 && (
              <MenuItem value={String(chapter)} sx={{ fontFamily: "monospace" }}>
                ch {chapter}
              </MenuItem>
            )}
          </Select>
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
      <Box sx={{ flex: 1 }} />
      {summary?.chapters && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
            {summary.chapters.reduce((a, c) => a + c.tn, 0)} notes · {summary.chapters.reduce((a, c) => a + c.twl, 0)} words · {summary.chapters.reduce((a, c) => a + c.tq, 0)} questions
          </Typography>
          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
        </>
      )}
      {logosSyncToggle}
      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
      <SyncStatusBar />
      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
      {pipelineMenu}
    </Stack>
  );
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Stack, Typography, Paper, IconButton, Tooltip, ToggleButton, ToggleButtonGroup, Button } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import SearchIcon from "@mui/icons-material/Search";
import UndoIcon from "@mui/icons-material/Undo";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { ChapterPayload, VerseDto } from "../sync/api";
import { drafts, verseKey } from "../sync/drafts";
import { DocColumn } from "./DocColumn";
import type { FindMatch } from "./FindReplaceOverlay";
import { HebrewLine } from "./HebrewLine";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { ChapterState } from "../hooks/useBook";
import { highlightsFor, renderEditableHTML, renderHighlightedHTML, type HighlightKey } from "../lib/highlight";
import { markHighlightSx } from "../lib/highlightStyles";
import { extractEditableText, extractTrailingMarkers, splitSectionHeaders, type SectionHeader } from "../lib/usfm";
import { SectionHeaderBand } from "./SectionHeaderBand";
import { buildVerseIndex, formatVerseLabel, isFirstOfRange, isRangeRow } from "../lib/verseRange";
import {
  classifySourceQuery,
  matchSourceVerse,
  renderFindMatchesByOffsets,
  type SourceQueryKind,
  type SourceTokenMatch,
} from "../lib/sourceSearch";

interface SearchState {
  re: RegExp | null;
  sourceQuery: SourceQueryKind;
}

export interface FindQuery {
  find: string;
  regex: boolean;
  caseSensitive: boolean;
  // User has opted in to interpreting bare-digit queries as Strong's numbers
  // (toggle in the find overlay). Has no effect on H/G-prefixed or non-digit
  // queries — those classify unambiguously.
  strongs: boolean;
}

export type ScriptureMode = "stacked" | "columns" | "book";

interface Props {
  book: string;
  chapter: number;
  versesByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  mode: ScriptureMode;
  enabledVersions: string[];
  availableVersions: string[];
  // Book-mode props: present only when mode === 'book'. The book view drives
  // (chapter, verse) navigation, so its callbacks carry the chapter.
  bookChapterList?: number[];
  bookChapters?: Map<number, ChapterState>;
  onLoadBookChapter?: (ch: number) => void;
  onSelectBookVerse?: (chapter: number, verse: number) => void;
  onEditBookVerse?: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Per-verse save callback for book mode. Same semantics as onSaveVerse but
  // chapter is variable (book view spans the whole book).
  onSaveBookVerse?: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onOpenBookAligner?: (chapter: number, verse: number, bibleVersion: string) => void;
  // Find/replace target. Used in all three modes — book mode passes a
  // chapter from the book cache; stacked/columns always pass the current
  // chapter. Shell dual-applies to useChapter when the chapter is loaded.
  onReplaceVerse: (chapter: number, verse: number, bibleVersion: string, newContent: unknown, newPlainText: string, base: VerseDto) => void;
  // Shared with the rest of the shell — bumped here on the "go to active"
  // click, and shipped to ResourceColumn so it can scroll the active
  // note/word/verse-group into view alongside the scripture.
  scrollNonce: number;
  onRequestScrollToActive: () => void;
  // Pre-loaded UHB strong → entry map (Shell collects from useChapter +
  // useBook) so per-word hover tooltips don't shimmer.
  lexiconMap: Map<string, LexiconEntry | null>;
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
  onModeChange: (mode: ScriptureMode) => void;
  onEnabledVersionsChange: (versions: string[]) => void;
  onEditVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Persist a draft to outbox: takes the row's current local plain text,
  // runs it through smartEditVerse, and enqueues. Shell wires this; both
  // stacked rows and the column-style modes call it on Save click.
  onSaveVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Section-band edit / delete. Splice the new (tag, text) into the
  // verse's verseObjects.sections (filtered by splitSectionHeaders) and
  // save via outbox. tag === null deletes the band entirely.
  onEditSection?: (
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  // Chapter is mid-flight for an AI pipeline. Renders all editable bibles
  // (ULT/UST) as read-only too — UHB/UGNT already are by virtue of
  // READ_ONLY_VERSIONS. The banner above the column tells the user why.
  locked?: boolean;
}

const VERSION_LABEL: Record<string, string> = {
  ULT: "ULT",
  UST: "UST",
  UHB: "UHB",
  UGNT: "UGNT",
};

const READ_ONLY_VERSIONS = new Set(["UHB", "UGNT"]);

const BookView = lazy(() =>
  import("./BookView").then((m) => ({ default: m.BookView })),
);
const FindReplaceOverlay = lazy(() =>
  import("./FindReplaceOverlay").then((m) => ({ default: m.FindReplaceOverlay })),
);

export function ScriptureColumn({
  book,
  chapter,
  versesByVersion,
  verseNumbers,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  mode,
  enabledVersions,
  availableVersions,
  bookChapterList,
  bookChapters,
  onLoadBookChapter,
  onSelectBookVerse,
  onEditBookVerse,
  onSaveBookVerse,
  onOpenBookAligner,
  onReplaceVerse,
  scrollNonce,
  onRequestScrollToActive,
  lexiconMap,
  onSelectVerse,
  onOpenAligner,
  onModeChange,
  onEnabledVersionsChange,
  onEditVerse,
  onSaveVerse,
  onEditSection,
  locked = false,
}: Props) {
  const activeRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState<FindQuery | null>(null);
  // Set only when the overlay reports a user-initiated scroll target; the
  // BookView's scroll effect (book mode) and the bodyRef scroll effect
  // (stacked/columns) key off this so external content changes don't yank
  // the user to the next match.
  const [findScrollTarget, setFindScrollTarget] = useState<FindMatch | null>(null);

  // Ctrl/Cmd+F opens the find overlay in any mode. Esc inside the
  // overlay closes it via the overlay's own handler.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Closing the overlay should drop the query so cells stop painting find
  // marks (otherwise the previous query lingers as highlights).
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery(null);
    setFindScrollTarget(null);
  }, []);

  // Stable callback identities so the overlay's effect deps don't churn.
  const onFindQueryChange = useCallback((q: FindQuery | null) => setFindQuery(q), []);
  const onFindScrollToMatch = useCallback((m: FindMatch | null) => setFindScrollTarget(m), []);

  // Synthesize a one-chapter cache for stacked/columns modes so the
  // overlay's existing collectMatches logic works without bookHook. Only
  // `verses` is consulted — the row stubs satisfy the ChapterPayload type.
  const singleChapterCache = useMemo<Map<number, ChapterState>>(() => {
    const m = new Map<number, ChapterState>();
    m.set(chapter, {
      kind: "ready",
      data: {
        book,
        chapter,
        verses: versesByVersion,
        tn: [],
        tq: [],
        twl: [],
        verseStatuses: [],
      } as ChapterPayload,
    });
    return m;
  }, [book, chapter, versesByVersion]);

  const overlayChapters = mode === "book" && bookChapters ? bookChapters : singleChapterCache;
  const overlayChapterList = mode === "book" && bookChapterList ? bookChapterList : [chapter];
  const overlayLoadChapter = useCallback(
    (ch: number) => {
      if (mode === "book" && onLoadBookChapter) onLoadBookChapter(ch);
    },
    [mode, onLoadBookChapter],
  );

  // Compile the regex + classify the source-language query once and feed both
  // to stacked/columns cells for in-line mark painting. Book mode rebuilds
  // its own copy inside BookView.
  const search = useMemo<SearchState | null>(() => {
    if (!findQuery) return null;
    const sourceQuery: SourceQueryKind = findQuery.regex
      ? { kind: "english" }
      : classifySourceQuery(findQuery.find, book, findQuery.strongs);
    try {
      const pattern = findQuery.regex
        ? findQuery.find
        : findQuery.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(pattern, findQuery.caseSensitive ? "g" : "gi");
      return { re, sourceQuery };
    } catch {
      return { re: null, sourceQuery };
    }
  }, [findQuery, book]);

  // Stacked/columns scroll-to-match: BookView handles book mode internally.
  // In stacked mode also promote the match verse to "active" so its full card
  // expands (otherwise non-active rows collapse to a one-line grid). The
  // active-verse useEffect below handles the scroll once expansion lands.
  useEffect(() => {
    if (!findScrollTarget || mode === "book") return;
    if (findScrollTarget.chapter !== chapter) return;
    if (mode === "stacked" && findScrollTarget.verse !== activeVerse) {
      onSelectVerse(findScrollTarget.verse);
      return;
    }
    const sel = `[data-find-cell="${findScrollTarget.chapter}-${findScrollTarget.verse}-${findScrollTarget.bibleVersion}"]`;
    const el = bodyRef.current?.querySelector<HTMLElement>(sel);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [findScrollTarget, mode, chapter, activeVerse, onSelectVerse]);

  useEffect(() => {
    if (mode === "stacked") {
      activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeVerse, mode]);

  // Stacked mode does its own activeRef scroll; columns/book modes react to
  // the shared scrollNonce. The button asks the shell to bump the nonce, and
  // we mirror that here for stacked so all three modes behave the same.
  const prevNonceRef = useRef(scrollNonce);
  useEffect(() => {
    if (prevNonceRef.current === scrollNonce) return;
    prevNonceRef.current = scrollNonce;
    if (mode === "stacked") {
      activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [scrollNonce, mode]);

  const isHebrew = !!versesByVersion["UHB"];

  // Per-version expansion: verses[bv][7] resolves to the 6-9 range row when
  // the user navigates to verse 7 inside a UST multi-verse block. The wire
  // shape (versesByVersion) keys only on the start of a range; this index
  // makes lookups by-any-verse-in-range work. See web/src/lib/verseRange.ts.
  const indexByVersion = useMemo(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    for (const bv of Object.keys(versesByVersion)) {
      out[bv] = buildVerseIndex(versesByVersion[bv]);
    }
    return out;
  }, [versesByVersion]);

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 2,
          py: 0.75,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="subtitle2" sx={{ mr: 1 }}>
          Scripture
        </Typography>
        <Tooltip title="verse-by-verse stacked card (default)">
          <Button
            size="small"
            variant={mode === "stacked" ? "contained" : "outlined"}
            startIcon={<ViewStreamIcon fontSize="small" />}
            onClick={() => onModeChange("stacked")}
            sx={{ textTransform: "none" }}
          >
            rows
          </Button>
        </Tooltip>
        <Tooltip title="parallel-column doc view of the current chapter">
          <Button
            size="small"
            variant={mode === "columns" ? "contained" : "outlined"}
            startIcon={<ViewColumnIcon fontSize="small" />}
            onClick={() => onModeChange("columns")}
            sx={{ textTransform: "none" }}
          >
            {mode === "columns" ? `${enabledVersions.length} col${enabledVersions.length === 1 ? "" : "s"}` : "columns"}
          </Button>
        </Tooltip>
        <Tooltip title="whole-book scroll across all enabled versions (lazy loads as you scroll)">
          <Button
            size="small"
            variant={mode === "book" ? "contained" : "outlined"}
            startIcon={<MenuBookIcon fontSize="small" />}
            onClick={() => onModeChange("book")}
            sx={{ textTransform: "none" }}
          >
            book
          </Button>
        </Tooltip>
        <Tooltip
          title={
            mode === "book"
              ? "find / replace across loaded chapters (Ctrl+F)"
              : "find / replace in this chapter (Ctrl+F)"
          }
        >
          <Button
            size="small"
            variant={findOpen ? "contained" : "outlined"}
            startIcon={<SearchIcon fontSize="small" />}
            onClick={() => {
              if (findOpen) closeFind();
              else setFindOpen(true);
            }}
            sx={{ textTransform: "none" }}
          >
            find
          </Button>
        </Tooltip>
        {(mode === "columns" || mode === "book") && (
          <ToggleButtonGroup
            size="small"
            value={enabledVersions}
            onChange={(_e, next) => {
              if (Array.isArray(next) && next.length > 0 && next.length <= 3) {
                onEnabledVersionsChange(next);
              }
            }}
            aria-label="visible versions"
          >
            {availableVersions.map((v) => (
              <ToggleButton key={v} value={v} sx={{ px: 1, py: 0.25, textTransform: "none", fontSize: 11 }}>
                {VERSION_LABEL[v] ?? v}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="scroll the active verse + its resources back into view">
          <Button
            size="small"
            startIcon={<UndoIcon fontSize="small" />}
            onClick={onRequestScrollToActive}
            sx={{ textTransform: "none" }}
          >
            go to active
          </Button>
        </Tooltip>
        <Typography variant="caption" color="text.secondary">
          {book} {chapter}:{activeVerse === 0 ? "intro" : activeVerse}
        </Typography>
      </Stack>
      <Box ref={bodyRef} sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {findOpen && (
          <Suspense fallback={null}>
            <FindReplaceOverlay
              open
              onClose={closeFind}
              book={book}
              chapters={overlayChapters}
              chapterList={overlayChapterList}
              onLoadChapter={overlayLoadChapter}
              enabledVersions={enabledVersions}
              onReplaceVerse={onReplaceVerse}
              onScrollToMatch={onFindScrollToMatch}
              onQueryChange={onFindQueryChange}
            />
          </Suspense>
        )}
        {mode === "stacked" ? (
          <StackedBody
            book={book}
            indexByVersion={indexByVersion}
            verseNumbers={verseNumbers}
            activeVerse={activeVerse}
            activeRef={activeRef}
            chapter={chapter}
            isHebrew={isHebrew}
            activeNoteQuote={activeNoteQuote}
            activeNoteOccurrence={activeNoteOccurrence}
            lexiconMap={lexiconMap}
            search={search}
            findActiveMatch={findScrollTarget}
            onSelectVerse={onSelectVerse}
            onOpenAligner={onOpenAligner}
            onEditVerse={onEditVerse}
            onSaveVerse={onSaveVerse}
            onEditSection={onEditSection}
            locked={locked}
          />
        ) : mode === "book" && bookChapterList && bookChapters && onLoadBookChapter && onSelectBookVerse && onEditBookVerse && onSaveBookVerse && onOpenBookAligner ? (
          <Suspense fallback={null}>
            <BookView
              book={book}
              chapterList={bookChapterList}
              chapters={bookChapters}
              enabledVersions={enabledVersions}
              activeChapter={chapter}
              activeVerse={activeVerse}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              scrollNonce={scrollNonce}
              findQuery={findQuery}
              findActiveMatch={findScrollTarget}
              lexiconMap={lexiconMap}
              onLoadChapter={onLoadBookChapter}
              onSelectVerse={onSelectBookVerse}
              onEditVerse={onEditBookVerse}
              onSaveColumn={(bv, payload) => {
                for (const item of payload) {
                  onSaveBookVerse(item.chapter, item.verse, bv, item.plain, item.base);
                }
              }}
              onOpenAligner={onOpenBookAligner}
              locked={locked}
            />
          </Suspense>
        ) : (
          <Box sx={{ flex: 1, display: "flex", gap: 1, p: 1, overflow: "hidden" }}>
            {enabledVersions.map((v) => (
              <DocColumn
                key={v}
                book={book}
                bibleVersion={v}
                versesByVerseNum={indexByVersion[v] ?? {}}
                verseNumbers={verseNumbers}
                chapter={chapter}
                activeVerse={activeVerse}
                readOnly={READ_ONLY_VERSIONS.has(v) || locked}
                rtl={v === "UHB"}
                activeNoteQuote={activeNoteQuote}
                activeNoteOccurrence={activeNoteOccurrence}
                scrollNonce={scrollNonce}
                lexiconMap={v === "UHB" ? lexiconMap : undefined}
                search={search}
                findActiveMatch={findScrollTarget}
                onSelectVerse={onSelectVerse}
                onEditVerse={(verseNum, plain, base) => onEditVerse(verseNum, v, plain, base)}
                onSaveColumn={(payload) => {
                  for (const item of payload) {
                    onSaveVerse(item.verseNum, v, item.plain, item.base);
                  }
                }}
                onOpenAligner={(verseNum) => onOpenAligner(verseNum, v)}
              />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// Find the row immediately preceding `verseNum` in this version's verse
// map. Multi-verse rows live at their verse_start in the index, so we
// scan back looking for the first row whose end-of-range is < verseNum.
function findPrevRowInColumn(
  column: Record<number, VerseDto>,
  verseNum: number,
): VerseDto | null {
  for (let v = verseNum - 1; v >= 0; v--) {
    const dto = column[v];
    if (!dto) continue;
    if ((dto.verse_end ?? dto.verse) < verseNum) return dto;
  }
  return null;
}

function StackedBody({
  book,
  indexByVersion,
  verseNumbers,
  activeVerse,
  activeRef,
  chapter,
  isHebrew,
  activeNoteQuote,
  activeNoteOccurrence,
  lexiconMap,
  search,
  findActiveMatch,
  onSelectVerse,
  onOpenAligner,
  onEditVerse,
  onSaveVerse,
  onEditSection,
  locked,
}: {
  book: string;
  indexByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  activeRef: React.MutableRefObject<HTMLDivElement | null>;
  chapter: number;
  isHebrew: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
  onEditVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onSaveVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onEditSection?: (
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  locked: boolean;
}) {
  const ult = indexByVersion["ULT"] ?? {};
  const ust = indexByVersion["UST"] ?? {};
  const uhb = indexByVersion["UHB"] ?? indexByVersion["UGNT"] ?? {};
  const uhbLabel = isHebrew ? "UHB" : "UGNT";
  return (
    <Box
      sx={(theme) => ({
        flex: 1,
        overflowY: "auto",
        px: 2,
        py: 1,
        ...markHighlightSx(theme.palette.mode),
      })}
    >
      {verseNumbers.map((v) => {
        const isActive = v === activeVerse;
        const ultV = ult[v];
        const ustV = ust[v];
        const uhbV = uhb[v];
        if (isActive) {
          const ultHL = highlightsFor("ULT", ultV?.content, activeNoteQuote, activeNoteOccurrence);
          const ustHL = highlightsFor("UST", ustV?.content, activeNoteQuote, activeNoteOccurrence);
          const uhbHL = highlightsFor(uhbLabel, uhbV?.content, activeNoteQuote, activeNoteOccurrence);
          // For multi-verse blocks, PATCH and find/replace target the canonical
          // row at verse_start (e.g. 6 for a 6-9 range), not the active integer.
          const ultStart = ultV?.verse ?? v;
          const ustStart = ustV?.verse ?? v;
          const uhbStart = uhbV?.verse ?? v;
          // Find the predecessor row in each column so its trailing
          // markers can drift down to lead this verse visually.
          const ultPrev = findPrevRowInColumn(ult, ultStart);
          const ustPrev = findPrevRowInColumn(ust, ustStart);
          const uhbPrev = findPrevRowInColumn(uhb, uhbStart);
          return (
            <Paper
              ref={activeRef}
              key={v}
              elevation={0}
              sx={{
                p: 1.5,
                my: 1,
                border: "1.5px solid",
                borderColor: "primary.main",
                bgcolor: "primary.50",
                borderRadius: 1,
              }}
            >
              <Typography
                variant="caption"
                sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700, mr: 1 }}
              >
                {v === 0 ? "intro" : `${chapter}:${v}`}
              </Typography>
              <ActiveLine
                book={book}
                bibleVersion="ULT"
                label={ultV && isRangeRow(ultV) ? `ULT ${formatVerseLabel(ultV)}` : "ULT"}
                chapter={chapter}
                verseNum={ultStart}
                text={ultV?.plain_text ?? ""}
                content={ultV?.content}
                prevContent={ultPrev?.content}
                highlights={ultHL}
                search={search}
                findActiveMatch={findActiveMatch}
                editable={!locked}
                onOpenAligner={() => onOpenAligner(ultStart, "ULT")}
                onEditPlain={
                  ultV ? (plain) => onEditVerse(ultStart, "ULT", plain, ultV) : undefined
                }
                onSave={
                  ultV ? (plain) => onSaveVerse(ultStart, "ULT", plain, ultV) : undefined
                }
                onEditSection={
                  ultV && onEditSection
                    ? (change) => onEditSection(ultStart, "ULT", change, ultV)
                    : undefined
                }
              />
              <ActiveLine
                book={book}
                bibleVersion="UST"
                label={ustV && isRangeRow(ustV) ? `UST ${formatVerseLabel(ustV)}` : "UST"}
                chapter={chapter}
                verseNum={ustStart}
                text={ustV?.plain_text ?? ""}
                content={ustV?.content}
                prevContent={ustPrev?.content}
                highlights={ustHL}
                search={search}
                findActiveMatch={findActiveMatch}
                editable
                onOpenAligner={() => onOpenAligner(ustStart, "UST")}
                onEditPlain={
                  ustV ? (plain) => onEditVerse(ustStart, "UST", plain, ustV) : undefined
                }
                onSave={
                  ustV ? (plain) => onSaveVerse(ustStart, "UST", plain, ustV) : undefined
                }
                onEditSection={
                  ustV && onEditSection
                    ? (change) => onEditSection(ustStart, "UST", change, ustV)
                    : undefined
                }
              />
              {uhbV && (
                <ActiveLine
                  book={book}
                  bibleVersion={uhbLabel}
                  label={isRangeRow(uhbV) ? `${uhbLabel} ${formatVerseLabel(uhbV)}` : uhbLabel}
                  chapter={chapter}
                  verseNum={uhbStart}
                  text={uhbV.plain_text ?? ""}
                  content={uhbV.content}
                  prevContent={uhbPrev?.content}
                  highlights={uhbHL}
                  search={search}
                  findActiveMatch={findActiveMatch}
                  rtl={isHebrew}
                  readOnly
                  lexiconMap={lexiconMap}
                />
              )}
            </Paper>
          );
        }
        // Only render this version's cell when it's the start of its row's
        // span — keeps a UST 6-9 block from re-rendering on every verse 7,8,9
        // row underneath it. For singletons, dto.verse === v always, so the
        // first-of-range check passes naturally.
        const showUlt = ultV && isFirstOfRange(ultV, v);
        const showUst = ustV && isFirstOfRange(ustV, v);
        return (
          <Box
            key={v}
            onClick={() => onSelectVerse(v)}
            sx={{
              display: "grid",
              // Narrow gutter for ULT/UST labels (right-aligned) + the
              // wide text column. Verse-number gets its own row spanning
              // both columns so it doesn't compete with the version
              // labels for vertical space — the resulting extra row is
              // tiny (10 px-ish) and pays for clean label/text baselines.
              gridTemplateColumns: "28px 1fr",
              columnGap: 0.75,
              rowGap: 0,
              alignItems: "baseline",
              px: 1,
              py: 0.5,
              my: 0.25,
              borderRadius: 1,
              cursor: "pointer",
              color: "text.secondary",
              fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
              fontSize: 14.5,
              lineHeight: 1.45,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Typography
              component="span"
              variant="caption"
              sx={{
                gridColumn: "1 / -1",
                gridRow: 1,
                fontFamily: "monospace",
                color: "text.disabled",
                fontSize: 10,
                lineHeight: 1.2,
                mb: 0.25,
              }}
            >
              {v === 0 ? "intro" : `${chapter}:${v}`}
            </Typography>
            {showUlt && (
              <>
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    gridColumn: 1,
                    gridRow: 2,
                    fontFamily: "monospace",
                    color: "text.disabled",
                    fontWeight: 600,
                    fontSize: 10,
                    textAlign: "right",
                  }}
                >
                  {isRangeRow(ultV) ? `ULT ${formatVerseLabel(ultV)}` : "ULT"}
                </Typography>
                <Box
                  data-find-cell={`${chapter}-${ultV.verse}-ULT`}
                  sx={(theme) => ({
                    gridColumn: 2,
                    gridRow: 2,
                    minWidth: 0,
                    ...markHighlightSx(theme.palette.mode),
                  })}
                >
                  <StackedRowBody
                    dto={ultV}
                    prevDto={findPrevRowInColumn(ult, ultV.verse)}
                    search={search}
                    activeRange={
                      findActiveMatch &&
                      findActiveMatch.chapter === chapter &&
                      findActiveMatch.verse === ultV.verse &&
                      findActiveMatch.bibleVersion === "ULT"
                        ? { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex }
                        : null
                    }
                  />
                </Box>
              </>
            )}
            {showUst && (
              <>
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    gridColumn: 1,
                    gridRow: 3,
                    fontFamily: "monospace",
                    color: "text.disabled",
                    fontWeight: 600,
                    fontSize: 10,
                    textAlign: "right",
                  }}
                >
                  {isRangeRow(ustV) ? `UST ${formatVerseLabel(ustV)}` : "UST"}
                </Typography>
                <Box
                  data-find-cell={`${chapter}-${ustV.verse}-UST`}
                  sx={(theme) => ({
                    gridColumn: 2,
                    gridRow: 3,
                    minWidth: 0,
                    ...markHighlightSx(theme.palette.mode),
                  })}
                >
                  <StackedRowBody
                    dto={ustV}
                    prevDto={findPrevRowInColumn(ust, ustV.verse)}
                    search={search}
                    activeRange={
                      findActiveMatch &&
                      findActiveMatch.chapter === chapter &&
                      findActiveMatch.verse === ustV.verse &&
                      findActiveMatch.bibleVersion === "UST"
                        ? { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex }
                        : null
                    }
                  />
                </Box>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function ActiveLine({
  book,
  bibleVersion,
  label,
  chapter,
  verseNum,
  text,
  content,
  prevContent,
  highlights,
  search,
  findActiveMatch,
  rtl,
  readOnly,
  editable,
  onOpenAligner,
  onEditPlain,
  onSave,
  onEditSection,
  lexiconMap,
}: {
  // book + bibleVersion identify the verse for draft keying.
  // bibleVersion is the bare code ("ULT") not the rendered label ("ULT 6-9").
  book?: string;
  bibleVersion?: string;
  label: string;
  chapter: number;
  verseNum: number;
  text: string;
  content?: unknown;
  // Previous verse's content_json. Its trailing in-flow markers (\q1,
  // \p ...) are surfaced as read-only chip bands above this verse's
  // editable area — usfm-js stores those markers on the prior verse
  // because USFM places them before \v, but they conceptually
  // introduce THIS verse. To edit them, navigate to the prior verse.
  prevContent?: unknown;
  highlights?: Set<HighlightKey>;
  search?: SearchState | null;
  findActiveMatch?: FindMatch | null;
  rtl?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  onOpenAligner?: () => void;
  // Called on every keystroke. Implementation stashes a draft; no
  // PATCH fires until onSave is invoked.
  onEditPlain?: (plain: string) => void;
  // Click-to-save. Shell consumes the current plain text, runs smartEditVerse,
  // and enqueues. Only rendered when editable && draft exists.
  onSave?: (plain: string) => void;
  // Section header band edited / removed. Index is the position in
  // splitSectionHeaders(verseObjects).sections at render time. tag === null
  // means delete the section header at that index. Shell mutates the
  // verseObjects tree directly and re-saves.
  onEditSection?: (change: { index: number; tag: string | null; text: string }) => void;
  lexiconMap?: Map<string, LexiconEntry | null>;
}) {
  const isSource = label === "UHB" || label === "UGNT";
  const draftKey = useMemo(
    () =>
      book && bibleVersion ? verseKey(book, chapter, verseNum, bibleVersion) : null,
    [book, bibleVersion, chapter, verseNum],
  );
  const activeRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!findActiveMatch) return null;
    if (findActiveMatch.chapter !== chapter) return null;
    if (findActiveMatch.verse !== verseNum) return null;
    if (findActiveMatch.bibleVersion !== label) return null;
    return { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex };
  }, [findActiveMatch, chapter, verseNum, label]);
  const elRef = useRef<HTMLDivElement | null>(null);
  // Tracks the last value we wrote into the contenteditable DOM. The DOM
  // reset effect (further down) skips when its target string matches this,
  // so a parent re-render with the same text doesn't blow away the caret.
  // Hoisted above the draft subscription so the hydration path can update
  // it in lockstep with the DOM write.
  const lastSetRef = useRef<string | null>(null);
  // Subscribe to the draft store so the row knows whether it's dirty and
  // hydrates from any saved draft on mount. The subscription fires once
  // immediately with the current list, and again on each set/clear.
  const [hasDraft, setHasDraft] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (!draftKey) {
      setHasDraft(false);
      return;
    }
    return drafts.subscribe((all) => {
      const rec = all.find((d) => d.key === draftKey);
      setHasDraft(!!rec);
      if (
        !hydratedFromDraftRef.current &&
        rec &&
        typeof (rec.payload as { plainText?: unknown }).plainText === "string" &&
        elRef.current
      ) {
        const plain = (rec.payload as { plainText: string }).plainText;
        if (elRef.current.textContent !== plain) {
          elRef.current.textContent = plain;
          lastSetRef.current = plain;
        }
        hydratedFromDraftRef.current = true;
      }
    });
  }, [draftKey]);

  // Source-language token matches for this line. Only meaningful for UHB/
  // UGNT lines in non-english find modes. Drives the offset painter (UGNT)
  // and the HebrewLine findHighlights set (UHB).
  const sourceHits = useMemo<SourceTokenMatch[] | null>(() => {
    if (!isSource || !search || search.sourceQuery.kind === "english") return null;
    const vo = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(vo)) return null;
    return matchSourceVerse(vo, search.sourceQuery);
  }, [isSource, search, content]);

  const findHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (!sourceHits || sourceHits.length === 0) return null;
    const set = new Set<HighlightKey>();
    for (const h of sourceHits) set.add(`${h.text}|${h.occurrence}`);
    return set;
  }, [sourceHits]);

  const activeFindKey = useMemo<HighlightKey | null>(() => {
    if (!activeRange || !sourceHits) return null;
    const hit = sourceHits.find((h) => h.start === activeRange.start && h.end === activeRange.end);
    return hit ? `${hit.text}|${hit.occurrence}` : null;
  }, [activeRange, sourceHits]);

  // Find marks override note highlights while the overlay is active —
  // matches BookView's behaviour so users see search results cleanly.
  const findHTML = useMemo(() => {
    if (!text) return null;
    // Source-language query: ULT/UST cells stay clean; source cells use the
    // offset painter (UHB renders via HebrewLine and ignores findHTML).
    if (search && search.sourceQuery.kind !== "english") {
      if (!isSource || !sourceHits || sourceHits.length === 0) return null;
      return renderFindMatchesByOffsets(text, sourceHits, activeRange);
    }
    if (!search?.re) return null;
    const out = renderFindMatchesHTML(text, search.re, activeRange);
    return out.includes("be-find") ? out : null;
  }, [search, sourceHits, text, isSource, activeRange]);

  // Editable representation: paragraph / poetry / blank markers surfaced
  // as literal "\p" / "\q1" tokens inline. Used as the contentEditable's
  // textContent target so when the user types, the markers appear as
  // visible chips (via renderEditableHTML) and the diff in saveVerseDraft
  // can see / preserve them. Falls back to plain `text` for source rows
  // (Hebrew/Greek) or rows with no verseObjects tree.
  const verseObjects = useMemo(
    () => (content as { verseObjects?: unknown[] } | null)?.verseObjects,
    [content],
  );
  const editableText = useMemo(() => {
    if (!Array.isArray(verseObjects)) return text;
    return extractEditableText(verseObjects);
  }, [verseObjects, text]);
  const sections = useMemo<SectionHeader[]>(() => {
    if (!Array.isArray(verseObjects)) return [];
    return splitSectionHeaders(verseObjects).sections;
  }, [verseObjects]);
  // Markers attached to the previous verse that visually introduce
  // THIS verse — usfm-js stores `\q1 \v N+1` markers on verse N. We
  // render them as read-only chip bands above the editable area so
  // users see the correct paragraph / poetry structure. Editing them
  // requires navigating to the previous verse (where the data lives).
  const driftedMarkers = useMemo<Array<{ tag: string }>>(() => {
    const prevVo = (prevContent as { verseObjects?: unknown[] } | null)?.verseObjects;
    return extractTrailingMarkers(prevVo).map((n) => ({
      tag: String((n as Record<string, unknown>)["tag"] ?? ""),
    }));
  }, [prevContent]);

  const noteHTML = useMemo(() => {
    if (findHTML) return null;
    if (!Array.isArray(verseObjects)) return null;
    const hlSet = highlights ?? (new Set() as Set<HighlightKey>);
    // When edit mode is on, render with visible chips so paragraph /
    // poetry markers can be seen and adjusted in place. Otherwise emit
    // the read-only display (no chips, just block layout).
    if (editable && !readOnly) {
      return renderEditableHTML(verseObjects, hlSet);
    }
    if (!highlights || highlights.size === 0) {
      // Same code path used by columns/book views — also runs even without
      // active highlights so paragraph markers render as visual breaks.
      // For pure read-only inactive rows, the parent uses FindAwareText
      // (plain text) instead of this `html`, so this branch only matters
      // when the active line has no quote highlight.
      return renderHighlightedHTML(verseObjects, new Set());
    }
    return renderHighlightedHTML(verseObjects, highlights);
  }, [findHTML, verseObjects, highlights, editable, readOnly]);
  const html = findHTML ?? noteHTML;

  // Only resync the DOM when the highlight/content state actually changes —
  // not on every keystroke. This lets the user type freely; clicking a
  // different note triggers a re-set that includes the new highlights.
  // Setting lastSetRef before flushing an edit keeps this effect from
  // resetting textContent (and the caret with it) when the parent
  // applyLocalVerse round-trips back as the new `text` prop.
  const domBaseline = editable && !readOnly ? editableText : text;
  useEffect(() => {
    if (!elRef.current) return;
    // If the user has unsaved typing in here, leave their text alone —
    // a parent re-render (e.g. notes panel reflow re-passes `text` from
    // server state) must not stomp the draft.
    if (hasDraft) return;
    const next = html ?? domBaseline;
    if (next === lastSetRef.current) return;
    if (html === null) {
      elRef.current.textContent = domBaseline;
    } else {
      elRef.current.innerHTML = html;
    }
    lastSetRef.current = next;
  }, [html, domBaseline]);

  return (
    <Box sx={{ py: 0.5 }}>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ mb: 0.25, minHeight: 18 }}
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: "text.secondary",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {VERSION_LABEL[label] ?? label}
        </Typography>
        {onOpenAligner && (
          <Tooltip title={`align ${label}`}>
            <IconButton size="small" onClick={onOpenAligner} sx={{ color: "success.main", p: 0.25 }}>
              <LinkIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        {editable && !readOnly && onSave && (
          <Tooltip title={hasDraft ? "save edits" : "no unsaved edits"}>
            <span>
              <IconButton
                size="small"
                disabled={!hasDraft}
                onClick={() => onSave(elRef.current?.textContent ?? "")}
                sx={{
                  p: 0.25,
                  color: hasDraft ? "primary.main" : "action.disabled",
                }}
              >
                {hasDraft ? (
                  <SaveIcon sx={{ fontSize: 14 }} />
                ) : (
                  <SaveOutlinedIcon sx={{ fontSize: 14 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
        )}
        {editable && !readOnly && hasDraft && draftKey && (
          <Tooltip title="undo edits to this verse">
            <IconButton
              size="small"
              onClick={() => {
                void drafts.clear(draftKey);
                hydratedFromDraftRef.current = false;
                if (elRef.current) {
                  // Re-render from the editable baseline so chips are
                  // restored, not just plain text.
                  elRef.current.innerHTML = html ?? "";
                  if (!html) elRef.current.textContent = editableText;
                  lastSetRef.current = html ?? editableText;
                }
              }}
              sx={{ p: 0.25, color: "warning.main" }}
            >
              <UndoIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {sections.length > 0 && (
        <Stack spacing={0.25} sx={{ mb: 0.5 }}>
          {sections.map((s, i) => (
            <SectionHeaderBand
              key={`${s.tag}-${i}`}
              tag={s.tag}
              text={s.text}
              editable={!!editable && !readOnly}
              onChange={(next) => {
                // Splice the updated/removed section back into verseObjects
                // and let Shell handle the smart save via onEditContent.
                // Wire-up handled in the parent Shell; this component just
                // surfaces edits. For v1 we mutate textContent inline via
                // a side channel — see Shell's onEditSection handler.
                onEditSection?.({ index: i, tag: next.tag, text: next.text });
              }}
            />
          ))}
        </Stack>
      )}
      {editable && !readOnly && !rtl && (
        <ParagraphToolbar elRef={elRef} onEditPlain={onEditPlain} />
      )}
      {driftedMarkers.length > 0 && !rtl && (
        <Stack spacing={0} sx={{ mb: 0.25 }}>
          {driftedMarkers.map((m, i) => (
            <Tooltip
              key={`drift-${i}`}
              title={`from previous verse — edit there`}
              placement="left"
            >
              <Box
                sx={{
                  display: "block",
                  pl: m.tag === "q2" ? "2.5em" : m.tag === "q3" ? "3.75em" : m.tag === "q4" ? "5em" : m.tag.startsWith("q") ? "1.25em" : 0,
                  fontSize: 11,
                  opacity: 0.55,
                  fontFamily: "Consolas, Menlo, monospace",
                  color: "primary.main",
                }}
              >
                <Box
                  component="span"
                  sx={{
                    display: "inline-block",
                    px: 0.5,
                    border: "1px dashed",
                    borderColor: "primary.main",
                    borderRadius: 0.5,
                    bgcolor: "rgba(49, 173, 227, 0.06)",
                  }}
                >
                  {m.tag === "ts" ? "\\ts\\*" : `\\${m.tag}`}
                </Box>
              </Box>
            </Tooltip>
          ))}
        </Stack>
      )}
      {rtl && lexiconMap ? (
        <Box
          data-find-cell={`${chapter}-${verseNum}-${label}`}
          sx={{
            flex: 1,
            bgcolor: "grey.100",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 0.5,
            px: 1,
            py: 0.5,
            fontSize: 20,
            lineHeight: 1.5,
            direction: "rtl",
            textAlign: "right",
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
          }}
        >
          <HebrewLine
            verseObjects={(content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            highlights={highlights}
            findHighlights={findHighlights}
            activeFindKey={activeFindKey}
            fallbackText={text}
          />
        </Box>
      ) : (
        <Box
          ref={elRef}
          data-find-cell={`${chapter}-${verseNum}-${label}`}
          data-dirty={hasDraft ? "true" : undefined}
          contentEditable={editable && !readOnly}
          suppressContentEditableWarning
          spellCheck={!rtl}
          onInput={(e) => {
            if (readOnly || !editable || !onEditPlain) return;
            const value = (e.currentTarget as HTMLDivElement).textContent ?? "";
            // Record what we'd write back if the parent passes the same value
            // as the next `text` prop — keeps the DOM reset effect quiet.
            lastSetRef.current = value;
            onEditPlain(value);
          }}
          sx={(theme) => ({
            flex: 1,
            bgcolor: readOnly ? "grey.100" : "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 0.5,
            px: 1,
            py: 0.5,
            fontSize: rtl ? 20 : 14.5,
            lineHeight: 1.5,
            direction: rtl ? "rtl" : "ltr",
            textAlign: rtl ? "right" : "left",
            fontFamily: rtl
              ? '"Times New Roman","SBL Hebrew","Cardo",serif'
              : '"Source Serif Pro","Cambria","Times New Roman",serif',
            outline: "none",
            ...markHighlightSx(theme.palette.mode),
            // Orange border when this row has unsaved typing and isn't
            // currently focused — quiet while typing, loud after you click
            // away. Inset box-shadow so the layout doesn't shift.
            "&[data-dirty='true']:not(:focus)": {
              boxShadow: `inset 0 0 0 2px ${theme.palette.warning.main}`,
            },
            "&:focus": readOnly
              ? {}
              : {
                  borderColor: "primary.main",
                  boxShadow: "0 0 0 2px rgba(49,173,227,0.2)",
                },
          })}
        />
      )}
    </Box>
  );
}

// Small toolbar above the active editable verse with one button per
// common paragraph / poetry marker. Clicking inserts a literal-USFM
// chip (`<span class="be-tok" contenteditable="false">\p</span>` plus
// a trailing space) at the current selection inside elRef. After the
// chip is inserted we manually call onEditPlain with the updated
// textContent so the draft fires — the synthetic edit doesn't trigger
// a normal `input` event.
const TOOLBAR_MARKERS: Array<{ tag: string; label: string; title: string }> = [
  { tag: "p", label: "\\p", title: "paragraph" },
  { tag: "m", label: "\\m", title: "margin paragraph" },
  { tag: "q1", label: "\\q1", title: "poetry indent 1" },
  { tag: "q2", label: "\\q2", title: "poetry indent 2" },
  { tag: "q3", label: "\\q3", title: "poetry indent 3" },
  { tag: "b", label: "\\b", title: "blank line" },
  { tag: "ts", label: "\\ts\\*", title: "chunk divider" },
];

function ParagraphToolbar({
  elRef,
  onEditPlain,
}: {
  elRef: React.RefObject<HTMLDivElement | null>;
  onEditPlain?: (plain: string) => void;
}) {
  const insert = useCallback(
    (tag: string) => {
      const el = elRef.current;
      if (!el) return;
      const chipText = tag === "ts" ? "\\ts\\*" : `\\${tag}`;
      const chipHtml = `<span class="be-tok be-tok-${tag}" data-tag="${tag}">${chipText}</span>&nbsp;`;
      el.focus();
      const sel = window.getSelection();
      // If the caret isn't already in this contenteditable, place it at
      // the end before inserting — feels less surprising than nothing
      // happening when the user clicks the toolbar without first clicking
      // into the verse.
      if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      const ok = document.execCommand("insertHTML", false, chipHtml);
      if (!ok) {
        // execCommand is deprecated; the Selection API fallback inserts
        // the chip as DOM nodes instead. Same end result.
        const range = window.getSelection()?.getRangeAt(0);
        if (range) {
          const tmpl = document.createElement("template");
          tmpl.innerHTML = chipHtml;
          range.deleteContents();
          const frag = tmpl.content;
          range.insertNode(frag);
          range.collapse(false);
        }
      }
      // Fire the same path as a real keystroke so the draft captures.
      onEditPlain?.(el.textContent ?? "");
    },
    [elRef, onEditPlain],
  );
  return (
    <Stack direction="row" spacing={0.25} sx={{ mb: 0.5, flexWrap: "wrap" }}>
      {TOOLBAR_MARKERS.map((m) => (
        <Tooltip key={m.tag} title={m.title}>
          <Button
            size="small"
            variant="outlined"
            onMouseDown={(e) => {
              // Prevent the editor losing focus when clicking the toolbar.
              e.preventDefault();
            }}
            onClick={() => insert(m.tag)}
            sx={{
              minWidth: 0,
              px: 0.75,
              py: 0.1,
              fontFamily: "Consolas, Menlo, monospace",
              fontSize: 11,
              textTransform: "none",
              color: "primary.main",
              borderColor: "divider",
            }}
          >
            {m.label}
          </Button>
        </Tooltip>
      ))}
    </Stack>
  );
}

// Inactive stacked rows: render paragraph / poetry layout (block-level
// `\q1` indents etc.) when the verse has markers, with drifted leading
// markers from the previous verse composed at the front. Falls back to
// plain text + find marks via FindAwareText when there's nothing
// marker-worthy to show — that path preserves find/replace highlighting
// for normal prose verses.
function StackedRowBody({
  dto,
  prevDto,
  search,
  activeRange,
}: {
  dto: VerseDto;
  prevDto: VerseDto | null;
  search: SearchState | null;
  activeRange?: { start: number; end: number } | null;
}) {
  const verseObjects = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  const drift = useMemo(
    () =>
      extractTrailingMarkers(
        (prevDto?.content as { verseObjects?: unknown[] } | null)?.verseObjects,
      ),
    [prevDto?.content],
  );
  const html = useMemo(() => {
    if (!Array.isArray(verseObjects)) return null;
    const composed = drift.length > 0 ? [...drift, ...verseObjects] : verseObjects;
    // Skip the marker renderer if there's no structure to show — the
    // FindAwareText fallback below paints find marks for plain prose.
    const hasStructure =
      drift.length > 0 ||
      verseObjects.some((n) => {
        const o = n as Record<string, unknown> | null;
        if (!o) return false;
        const t = o["type"];
        return t === "paragraph" || t === "quote" || t === "section";
      });
    if (!hasStructure) return null;
    return renderHighlightedHTML(composed, new Set());
  }, [verseObjects, drift]);

  if (html !== null) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <FindAwareText text={dto.plain_text ?? ""} search={search} activeRange={activeRange} />;
}

// Render plain text with find-match marks for non-active stacked rows. We
// use innerHTML when there are matches so the <mark> tags paint; otherwise
// render the raw string so React handles escaping the normal way.
function FindAwareText({
  text,
  search,
  activeRange,
}: {
  text: string;
  search: SearchState | null;
  activeRange?: { start: number; end: number } | null;
}) {
  const html = useMemo(() => {
    if (!text || !search?.re) return null;
    // Source-language queries don't match ULT/UST cells — return null so the
    // non-active stacked rows stay clean.
    if (search.sourceQuery.kind !== "english") return null;
    const out = renderFindMatchesHTML(text, search.re, activeRange);
    return out.includes("be-find") ? out : null;
  }, [search, text, activeRange]);
  if (html === null) return <>{text}</>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderFindMatchesHTML(
  plainText: string,
  re: RegExp,
  activeRange?: { start: number; end: number } | null,
): string {
  let html = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const local = new RegExp(re.source, re.flags);
  while ((m = local.exec(plainText)) !== null) {
    const isActive = !!activeRange && m.index === activeRange.start && m.index + m[0].length === activeRange.end;
    const cls = isActive ? "be-find be-find-active" : "be-find";
    html += escapeHtml(plainText.slice(lastIdx, m.index));
    html += `<mark class="${cls}">${escapeHtml(m[0])}</mark>`;
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) local.lastIndex++;
  }
  html += escapeHtml(plainText.slice(lastIdx));
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

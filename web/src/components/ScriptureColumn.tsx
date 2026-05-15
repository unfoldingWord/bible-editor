import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Stack, Typography, Paper, IconButton, Tooltip, ToggleButton, ToggleButtonGroup, Button } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import SearchIcon from "@mui/icons-material/Search";
import UndoIcon from "@mui/icons-material/Undo";
import type { ChapterPayload, VerseDto } from "../sync/api";
import { DocColumn } from "./DocColumn";
import type { FindMatch } from "./FindReplaceOverlay";
import { HebrewLine } from "./HebrewLine";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { ChapterState } from "../hooks/useBook";
import { highlightsFor, renderHighlightedHTML, type HighlightKey } from "../lib/highlight";
import { markHighlightSx } from "../lib/highlightStyles";
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
            versesByVersion={versesByVersion}
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
            locked={locked}
          />
        ) : mode === "book" && bookChapterList && bookChapters && onLoadBookChapter && onSelectBookVerse && onEditBookVerse && onOpenBookAligner ? (
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
              onOpenAligner={onOpenBookAligner}
              locked={locked}
            />
          </Suspense>
        ) : (
          <Box sx={{ flex: 1, display: "flex", gap: 1, p: 1, overflow: "hidden" }}>
            {enabledVersions.map((v) => (
              <DocColumn
                key={v}
                bibleVersion={v}
                versesByVerseNum={versesByVersion[v] ?? {}}
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
                onOpenAligner={(verseNum) => onOpenAligner(verseNum, v)}
              />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function StackedBody({
  versesByVersion,
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
  locked,
}: {
  versesByVersion: Record<string, Record<number, VerseDto>>;
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
  locked: boolean;
}) {
  const ult = versesByVersion["ULT"] ?? {};
  const ust = versesByVersion["UST"] ?? {};
  const uhb = versesByVersion["UHB"] ?? versesByVersion["UGNT"] ?? {};
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
                label="ULT"
                chapter={chapter}
                verseNum={v}
                text={ultV?.plain_text ?? ""}
                content={ultV?.content}
                highlights={ultHL}
                search={search}
                findActiveMatch={findActiveMatch}
                editable={!locked}
                onOpenAligner={() => onOpenAligner(v, "ULT")}
                onEditPlain={
                  ultV ? (plain) => onEditVerse(v, "ULT", plain, ultV) : undefined
                }
              />
              <ActiveLine
                label="UST"
                chapter={chapter}
                verseNum={v}
                text={ustV?.plain_text ?? ""}
                content={ustV?.content}
                highlights={ustHL}
                search={search}
                findActiveMatch={findActiveMatch}
                editable
                onOpenAligner={() => onOpenAligner(v, "UST")}
                onEditPlain={
                  ustV ? (plain) => onEditVerse(v, "UST", plain, ustV) : undefined
                }
              />
              {uhbV && (
                <ActiveLine
                  label={uhbLabel}
                  chapter={chapter}
                  verseNum={v}
                  text={uhbV.plain_text ?? ""}
                  content={uhbV.content}
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
              ULT
            </Typography>
            <Box
              data-find-cell={`${chapter}-${v}-ULT`}
              sx={{ gridColumn: 2, gridRow: 2, minWidth: 0 }}
            >
              <FindAwareText
                text={ultV?.plain_text ?? ""}
                search={search}
                activeRange={
                  findActiveMatch &&
                  findActiveMatch.chapter === chapter &&
                  findActiveMatch.verse === v &&
                  findActiveMatch.bibleVersion === "ULT"
                    ? { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex }
                    : null
                }
              />
            </Box>
            {ustV && (
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
                  UST
                </Typography>
                <Box
                  data-find-cell={`${chapter}-${v}-UST`}
                  sx={{ gridColumn: 2, gridRow: 3, minWidth: 0 }}
                >
                  <FindAwareText
                    text={ustV.plain_text ?? ""}
                    search={search}
                    activeRange={
                      findActiveMatch &&
                      findActiveMatch.chapter === chapter &&
                      findActiveMatch.verse === v &&
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
  label,
  chapter,
  verseNum,
  text,
  content,
  highlights,
  search,
  findActiveMatch,
  rtl,
  readOnly,
  editable,
  onOpenAligner,
  onEditPlain,
  lexiconMap,
}: {
  label: string;
  chapter: number;
  verseNum: number;
  text: string;
  content?: unknown;
  highlights?: Set<HighlightKey>;
  search?: SearchState | null;
  findActiveMatch?: FindMatch | null;
  rtl?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  onOpenAligner?: () => void;
  onEditPlain?: (plain: string) => void;
  lexiconMap?: Map<string, LexiconEntry | null>;
}) {
  const isSource = label === "UHB" || label === "UGNT";
  const activeRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!findActiveMatch) return null;
    if (findActiveMatch.chapter !== chapter) return null;
    if (findActiveMatch.verse !== verseNum) return null;
    if (findActiveMatch.bibleVersion !== label) return null;
    return { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex };
  }, [findActiveMatch, chapter, verseNum, label]);
  const elRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest onEditPlain reachable from the timer/unmount paths without
  // restarting the debounce when the parent re-renders.
  const onEditPlainRef = useRef(onEditPlain);
  useEffect(() => {
    onEditPlainRef.current = onEditPlain;
  }, [onEditPlain]);
  // Flush any pending edit before the line unmounts (e.g. user navigates
  // away mid-type). Without this, the trailing keystroke is silently lost.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (!debounceRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const handler = onEditPlainRef.current;
    const node = elRef.current;
    if (handler && node) handler(node.textContent ?? "");
  };
  useEffect(() => {
    return () => flushRef.current();
  }, []);

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

  const noteHTML = useMemo(() => {
    if (findHTML) return null;
    if (!content || !highlights || highlights.size === 0) return null;
    const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    return renderHighlightedHTML(verseObjects, highlights);
  }, [findHTML, content, highlights]);
  const html = findHTML ?? noteHTML;

  // Only resync the DOM when the highlight/content state actually changes —
  // not on every keystroke. This lets the user type freely; clicking a
  // different note triggers a re-set that includes the new highlights.
  // Setting lastSetRef before flushing an edit keeps this effect from
  // resetting textContent (and the caret with it) when the parent
  // applyLocalVerse round-trips back as the new `text` prop.
  const lastSetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!elRef.current) return;
    const next = html ?? text;
    if (next === lastSetRef.current) return;
    if (html === null) {
      elRef.current.textContent = text;
    } else {
      elRef.current.innerHTML = html;
    }
    lastSetRef.current = next;
  }, [html, text]);

  return (
    <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ py: 0.5 }}>
      <Stack
        direction="column"
        alignItems="center"
        spacing={0.25}
        sx={{ minWidth: 36, pt: 0.5, flexShrink: 0 }}
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: "text.secondary",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {VERSION_LABEL[label] ?? label}
        </Typography>
        {onOpenAligner && (
          <Tooltip title={`align ${label}`} placement="left">
            <IconButton size="small" onClick={onOpenAligner} sx={{ color: "success.main", p: 0.25 }}>
              <LinkIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
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
          contentEditable={editable && !readOnly}
          suppressContentEditableWarning
          spellCheck={!rtl}
          onInput={(e) => {
            if (readOnly || !editable || !onEditPlain) return;
            const value = (e.currentTarget as HTMLDivElement).textContent ?? "";
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
              debounceRef.current = null;
              lastSetRef.current = value;
              onEditPlainRef.current?.(value);
            }, 350);
          }}
          onBlur={() => {
            if (readOnly || !editable || !onEditPlain) return;
            if (!debounceRef.current) return;
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
            const value = elRef.current?.textContent ?? "";
            lastSetRef.current = value;
            onEditPlainRef.current?.(value);
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
            "&:focus": readOnly
              ? {}
              : {
                  borderColor: "primary.main",
                  boxShadow: "0 0 0 2px rgba(49,173,227,0.2)",
                },
          })}
        />
      )}
    </Stack>
  );
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

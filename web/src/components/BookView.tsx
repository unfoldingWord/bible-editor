// BookView — whole-book scroll, multi-version columns aligned per verse.
// Lazy-loads chapters via IntersectionObserver: a placeholder row for each
// unloaded chapter, and when it scrolls within ~one viewport of view we ask
// useBook to fetch it. Once loaded, the placeholder is replaced with the
// rendered verse rows.
//
// Layout uses CSS grid so a verse row stays aligned across the N enabled
// versions; this trades off the "doc-flow" feel of DocColumn for tight
// column alignment, which is what makes find/replace and side-by-side
// comparison readable when the scroll spans an entire book.

import { Fragment, useEffect, useMemo, useRef } from "react";
import { Box, Stack, Typography, IconButton, Tooltip, CircularProgress } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import type { VerseDto } from "../sync/api";
import type { ChapterState } from "../hooks/useBook";
import { highlightsFor, renderHighlightedHTML, type HighlightKey } from "../lib/highlight";

const READ_ONLY = new Set(["UHB", "UGNT"]);

interface Props {
  book: string;
  chapterList: number[];
  chapters: Map<number, ChapterState>;
  enabledVersions: string[];
  activeChapter: number;
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  scrollNonce?: number;
  onLoadChapter: (ch: number) => void;
  onSelectVerse: (chapter: number, verse: number) => void;
  onEditVerse: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onOpenAligner: (chapter: number, verse: number, bibleVersion: string) => void;
}

export function BookView({
  book,
  chapterList,
  chapters,
  enabledVersions,
  activeChapter,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  scrollNonce,
  onLoadChapter,
  onSelectVerse,
  onEditVerse,
  onOpenAligner,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeChapter, activeVerse, scrollNonce]);

  const cols = enabledVersions.length;
  const gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1.5,
          py: 0.5,
          bgcolor: "primary.50",
          borderBottom: "1px dashed",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography variant="caption" sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700 }}>
          {book} · book
        </Typography>
        {enabledVersions.map((v) => (
          <Typography
            key={v}
            variant="caption"
            sx={{ fontFamily: "monospace", color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            {v}{READ_ONLY.has(v) ? " (ro)" : ""}
          </Typography>
        ))}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.disabled">
          {chapterList.length} ch · loaded {countLoaded(chapters)}
        </Typography>
      </Stack>
      <Box ref={containerRef} sx={{ flex: 1, overflowY: "auto" }}>
        <Box sx={{ display: "grid", gridTemplateColumns, gap: 1, px: 1.5, py: 1 }}>
          {chapterList.map((ch) => (
            <ChapterBlock
              key={ch}
              book={book}
              chapter={ch}
              state={chapters.get(ch) ?? { kind: "unloaded" }}
              enabledVersions={enabledVersions}
              cols={cols}
              activeChapter={activeChapter}
              activeVerse={activeVerse}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              activeRowRef={activeRowRef}
              onLoadChapter={onLoadChapter}
              onSelectVerse={onSelectVerse}
              onEditVerse={onEditVerse}
              onOpenAligner={onOpenAligner}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function countLoaded(chapters: Map<number, ChapterState>): number {
  let n = 0;
  for (const s of chapters.values()) if (s.kind === "ready") n++;
  return n;
}

function ChapterBlock({
  book,
  chapter,
  state,
  enabledVersions,
  cols,
  activeChapter,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  activeRowRef,
  onLoadChapter,
  onSelectVerse,
  onEditVerse,
  onOpenAligner,
}: {
  book: string;
  chapter: number;
  state: ChapterState;
  enabledVersions: string[];
  cols: number;
  activeChapter: number;
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  activeRowRef: React.MutableRefObject<HTMLDivElement | null>;
  onLoadChapter: (ch: number) => void;
  onSelectVerse: (chapter: number, verse: number) => void;
  onEditVerse: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onOpenAligner: (chapter: number, verse: number, bibleVersion: string) => void;
}) {
  // Sentinel observed by IntersectionObserver — fires loadChapter when the
  // chapter is near (within ~one viewport of) the visible area.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isUnloaded = state.kind === "unloaded";
  useEffect(() => {
    if (!isUnloaded) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            onLoadChapter(chapter);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "800px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [isUnloaded, chapter, onLoadChapter]);

  // Verse-number list pulled from the ready payload — unconditional so the
  // hook count stays stable across loading/error/ready transitions.
  const readyData = state.kind === "ready" ? state.data : null;
  const verseNums = useMemo(() => {
    if (!readyData) return [] as number[];
    const set = new Set<number>();
    for (const v of enabledVersions) {
      const m = readyData.verses[v];
      if (!m) continue;
      for (const k of Object.keys(m)) set.add(parseInt(k, 10));
    }
    return [...set].sort((a, b) => a - b);
  }, [readyData, enabledVersions]);

  if (state.kind === "unloaded" || state.kind === "loading") {
    return (
      <Box
        ref={sentinelRef}
        sx={{
          gridColumn: `1 / span ${cols}`,
          py: 4,
          textAlign: "center",
          color: "text.disabled",
          borderTop: "1px dashed",
          borderBottom: "1px dashed",
          borderColor: "divider",
          my: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
        }}
      >
        {state.kind === "loading" ? <CircularProgress size={14} /> : null}
        <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
          chapter {chapter} {state.kind === "loading" ? "loading…" : "(scroll to load)"}
        </Typography>
      </Box>
    );
  }
  if (state.kind === "error") {
    return (
      <Box
        sx={{
          gridColumn: `1 / span ${cols}`,
          py: 1,
          px: 2,
          bgcolor: "error.50",
          color: "error.dark",
          borderRadius: 0.5,
          my: 1,
        }}
      >
        <Typography variant="caption">chapter {chapter} failed to load: {state.error}</Typography>
      </Box>
    );
  }

  const data = state.data;

  return (
    <Fragment>
      <Box
        sx={{
          gridColumn: `1 / span ${cols}`,
          mt: 2,
          mb: 0.5,
          py: 0.75,
          px: 1.5,
          bgcolor: "primary.50",
          borderRadius: 0.5,
          borderBottom: "1px solid",
          borderColor: "primary.main",
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700, letterSpacing: 0.5 }}
        >
          {book} {chapter === 0 ? "front" : `chapter ${chapter}`}
        </Typography>
      </Box>
      {verseNums.map((v) => {
        const isActive = chapter === activeChapter && v === activeVerse;
        return (
          <VerseRow
            key={`${chapter}-${v}`}
            book={book}
            chapter={chapter}
            verseNum={v}
            enabledVersions={enabledVersions}
            versesByVersion={data.verses}
            isActive={isActive}
            activeNoteQuote={isActive ? activeNoteQuote : null}
            activeNoteOccurrence={isActive ? activeNoteOccurrence : null}
            rowRef={isActive ? activeRowRef : null}
            onSelectVerse={() => onSelectVerse(chapter, v)}
            onEditVerse={(bv, plain, base) => onEditVerse(chapter, v, bv, plain, base)}
            onOpenAligner={(bv) => onOpenAligner(chapter, v, bv)}
          />
        );
      })}
    </Fragment>
  );
}

function VerseRow({
  book: _book,
  chapter,
  verseNum,
  enabledVersions,
  versesByVersion,
  isActive,
  activeNoteQuote,
  activeNoteOccurrence,
  rowRef,
  onSelectVerse,
  onEditVerse,
  onOpenAligner,
}: {
  book: string;
  chapter: number;
  verseNum: number;
  enabledVersions: string[];
  versesByVersion: Record<string, Record<number, VerseDto>>;
  isActive: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  rowRef: React.MutableRefObject<HTMLDivElement | null> | null;
  onSelectVerse: () => void;
  onEditVerse: (bv: string, plain: string, base: VerseDto) => void;
  onOpenAligner: (bv: string) => void;
}) {
  // Render is intentionally a row of N independent cells driven by the same
  // grid container above — placement is via CSS grid auto-flow.
  return (
    <Fragment>
      {enabledVersions.map((bv, colIdx) => {
        const dto = versesByVersion[bv]?.[verseNum];
        return (
          <Box
            key={bv}
            ref={colIdx === 0 ? rowRef : null}
            onClick={onSelectVerse}
            sx={{
              p: 0.5,
              borderRadius: 0.5,
              cursor: "pointer",
              bgcolor: isActive ? "rgba(25,118,210,0.08)" : "transparent",
              boxShadow: isActive && colIdx === 0 ? "inset 2px 0 0 0 #1976d2" : "none",
            }}
          >
            <VerseCell
              chapter={chapter}
              verseNum={verseNum}
              bibleVersion={bv}
              dto={dto}
              isActive={isActive}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              onAlign={() => onOpenAligner(bv)}
              onEdit={(plain) => dto && onEditVerse(bv, plain, dto)}
            />
          </Box>
        );
      })}
    </Fragment>
  );
}

function VerseCell({
  chapter,
  verseNum,
  bibleVersion,
  dto,
  isActive,
  activeNoteQuote,
  activeNoteOccurrence,
  onAlign,
  onEdit,
}: {
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  dto: VerseDto | undefined;
  isActive: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  onAlign: () => void;
  onEdit: (plain: string) => void;
}) {
  const readOnly = READ_ONLY.has(bibleVersion);
  const rtl = bibleVersion === "UHB";
  const elRef = useRef<HTMLSpanElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTextRef = useRef(dto?.plain_text ?? "");
  const lastSetRef = useRef<string | null>(null);

  const highlights = useMemo<Set<HighlightKey> | null>(() => {
    if (!isActive || !activeNoteQuote || !dto?.content) return null;
    return highlightsFor(bibleVersion, dto.content, activeNoteQuote, activeNoteOccurrence);
  }, [isActive, activeNoteQuote, activeNoteOccurrence, bibleVersion, dto?.content]);

  const html = useMemo(() => {
    if (!highlights || highlights.size === 0) return null;
    const verseObjects = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    return renderHighlightedHTML(verseObjects, highlights);
  }, [dto?.content, highlights]);

  useEffect(() => {
    if (!elRef.current) return;
    const text = dto?.plain_text ?? "";
    const dom = elRef.current.innerText;
    if (html !== null) {
      if (html !== lastSetRef.current) {
        elRef.current.innerHTML = html;
        lastSetRef.current = html;
        lastTextRef.current = text;
      }
      return;
    }
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      elRef.current.innerText = text;
      lastSetRef.current = text;
    }
    lastTextRef.current = text;
  }, [dto?.plain_text, html]);

  if (!dto) {
    return (
      <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>
        —
      </Typography>
    );
  }

  return (
    <Box sx={{ lineHeight: 1.6 }}>
      <Typography
        component="span"
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: 600,
          color: "#9aa0a6",
          mr: 0.5,
        }}
      >
        {verseNum === 0 ? "intro" : `${chapter}:${verseNum}`}
      </Typography>
      {!readOnly && (
        <Tooltip title={`align verse ${verseNum}`}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onAlign();
            }}
            size="small"
            sx={{ color: "success.main", p: 0.25, verticalAlign: "-3px" }}
          >
            <LinkIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}{" "}
      <span
        ref={(node) => {
          elRef.current = node;
        }}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={!rtl}
        dir={rtl ? "rtl" : "ltr"}
        onInput={(e) => {
          if (readOnly) return;
          const value = (e.currentTarget as HTMLSpanElement).innerText;
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            onEdit(value);
            lastTextRef.current = value;
            debounceRef.current = null;
          }, 350);
        }}
        style={{
          outline: "none",
          background: "transparent",
          fontSize: rtl ? 18 : 14.5,
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
        }}
        className="be-verse-span"
      />
    </Box>
  );
}

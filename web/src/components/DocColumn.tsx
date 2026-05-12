import { useEffect, useMemo, useRef } from "react";
import { Box, Stack, Typography, IconButton, Tooltip } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import type { VerseDto } from "../sync/api";
import { highlightsFor, renderHighlightedHTML } from "../lib/highlight";
import { HebrewLine } from "./HebrewLine";
import type { LexiconEntry } from "../hooks/useLexicon";

interface Props {
  bibleVersion: string;
  versesByVerseNum: Record<number, VerseDto>;
  verseNumbers: number[];
  chapter: number;
  activeVerse: number;
  readOnly?: boolean;
  rtl?: boolean;
  activeNoteQuote?: string | null;
  activeNoteOccurrence?: number | null;
  // Increment to request a scroll-to-active even when activeVerse hasn't
  // changed — used by ScriptureColumn's "go to active" button in columns mode.
  scrollNonce?: number;
  // Present only when this column is UHB — caller pre-loads the lexicon
  // and we render each \w with a hover tooltip.
  lexiconMap?: Map<string, LexiconEntry | null>;
  // Active find regex from the overlay; paints <mark.be-find> on every
  // match in this column. Note highlights step aside while a query is
  // active to keep the search results visually clean.
  findRe?: RegExp | null;
  onSelectVerse: (v: number) => void;
  onEditVerse: (verseNum: number, plain: string, base: VerseDto) => void;
  onOpenAligner: (verseNum: number) => void;
}

// Continuous Word-style editor for one bible_version. Each verse is its
// own contenteditable block so debounced changes can flow to the outbox
// at verse granularity. Active verse gets a halo; clicking a non-active
// verse promotes it to active. Editing happens in plain text — the full
// content_json tree is replaced server-side with a single-text-token
// representation, which DOES invalidate the existing alignment for that
// verse. Phase 3 (alignment editor) restores it.

export function DocColumn({
  bibleVersion,
  versesByVerseNum,
  verseNumbers,
  chapter,
  activeVerse,
  readOnly,
  rtl,
  activeNoteQuote,
  activeNoteOccurrence,
  scrollNonce,
  lexiconMap,
  findRe,
  onSelectVerse,
  onEditVerse,
  onOpenAligner,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeVerse, scrollNonce]);

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: readOnly ? "grey.100" : "background.paper",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          bgcolor: readOnly ? "grey.100" : "primary.50",
          borderBottom: "1px dashed",
          borderColor: "divider",
        }}
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: readOnly ? "text.secondary" : "primary.main",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {bibleVersion} · {readOnly ? "read-only" : "editing"}
        </Typography>
      </Stack>
      <Box
        sx={{
          flex: 1,
          overflowY: "auto",
          px: 1.5,
          py: 1,
          lineHeight: 1.7,
          fontSize: rtl ? 20 : 15,
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          direction: rtl ? "rtl" : "ltr",
          textAlign: rtl ? "right" : "left",
          "& mark.be-hl": {
            backgroundColor: "#fff48a",
            padding: "0 2px",
            borderRadius: 0.5,
            color: "inherit",
          },
          "& mark.be-find": {
            backgroundColor: "#ffd966",
            outline: "1px solid #d97706",
            padding: "0 1px",
            borderRadius: 0.5,
            color: "inherit",
          },
        }}
      >
        {verseNumbers.map((v) => {
          const dto = versesByVerseNum[v];
          if (!dto) return null;
          const isActive = v === activeVerse;
          const highlights = isActive
            ? highlightsFor(bibleVersion, dto.content, activeNoteQuote, activeNoteOccurrence)
            : null;
          return (
            <VerseSpan
              key={v}
              chapter={chapter}
              verseNum={v}
              bibleVersion={bibleVersion}
              text={dto.plain_text ?? ""}
              content={dto.content}
              highlights={highlights}
              isActive={isActive}
              readOnly={!!readOnly}
              rtl={!!rtl}
              lexiconMap={lexiconMap}
              findRe={findRe ?? null}
              spanRef={isActive ? activeRef : null}
              onClick={() => onSelectVerse(v)}
              onAlign={() => onOpenAligner(v)}
              onEdit={(plain) => onEditVerse(v, plain, dto)}
            />
          );
        })}
      </Box>
    </Box>
  );
}

function VerseSpan({
  chapter,
  verseNum,
  bibleVersion,
  text,
  content,
  highlights,
  isActive,
  readOnly,
  rtl,
  lexiconMap,
  findRe,
  spanRef,
  onClick,
  onAlign,
  onEdit,
}: {
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  text: string;
  content?: unknown;
  highlights?: Set<string> | null;
  isActive: boolean;
  readOnly: boolean;
  rtl: boolean;
  lexiconMap?: Map<string, LexiconEntry | null>;
  findRe: RegExp | null;
  spanRef: React.MutableRefObject<HTMLSpanElement | null> | null;
  onClick: () => void;
  onAlign: () => void;
  onEdit: (plain: string) => void;
}) {
  const elRef = useRef<HTMLSpanElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTextRef = useRef(text);

  // Find marks override note highlights — same precedence as BookView.
  const findHTML = useMemo(() => {
    if (!findRe || !text) return null;
    const out = renderFindMatchesHTML(text, findRe);
    return out.includes("be-find") ? out : null;
  }, [findRe, text]);

  const html = useMemo(() => {
    if (findHTML) return findHTML;
    if (!content || !highlights || highlights.size === 0) return null;
    const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    return renderHighlightedHTML(verseObjects, highlights);
  }, [findHTML, content, highlights]);

  // Resync the editable span when (a) text changes from outside and the user
  // hasn't been typing since, or (b) highlights change. We let the user type
  // freely between resyncs. On first render `lastSetRef.current` is null —
  // treat that as "always write" so the verse paints at mount time.
  const lastSetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!elRef.current) return;
    const dom = elRef.current.innerText;
    if (html !== null) {
      if (html !== lastSetRef.current) {
        elRef.current.innerHTML = html;
        lastSetRef.current = html;
        lastTextRef.current = text;
      }
      return;
    }
    // Plain-text mode.
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      elRef.current.innerText = text;
      lastSetRef.current = text;
    }
    lastTextRef.current = text;
  }, [text, html]);

  const setMarkerRef = (node: HTMLSpanElement | null) => {
    if (spanRef) spanRef.current = node;
  };

  return (
    <span
      data-find-cell={`${chapter}-${verseNum}-${bibleVersion}`}
      onClick={onClick}
      style={{
        display: "inline",
        borderRadius: 4,
        padding: isActive ? "1px 2px" : 0,
        backgroundColor: isActive ? "rgba(49,173,227,0.14)" : "transparent",
        boxShadow: isActive ? "0 0 0 1.5px #31ADE3" : undefined,
      }}
    >
      <span
        ref={setMarkerRef}
        style={{
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: 600,
          color: "#9aa0a6",
          verticalAlign: "1px",
          marginRight: 4,
        }}
      >
        {verseNum === 0 ? "intro" : `${chapter}:${verseNum}`}
      </span>
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
      {rtl && lexiconMap ? (
        <span
          style={{
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
            fontSize: 20,
            direction: "rtl",
            unicodeBidi: "isolate",
          }}
        >
          <HebrewLine
            verseObjects={(content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            highlights={highlights ?? undefined}
            fallbackText={text}
          />
        </span>
      ) : (
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
        }}
        className="be-verse-span"
      />
      )}{" "}
    </span>
  );
}

function renderFindMatchesHTML(plainText: string, re: RegExp): string {
  let html = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const local = new RegExp(re.source, re.flags);
  while ((m = local.exec(plainText)) !== null) {
    html += escapeHtml(plainText.slice(lastIdx, m.index));
    html += `<mark class="be-find">${escapeHtml(m[0])}</mark>`;
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) local.lastIndex++;
  }
  html += escapeHtml(plainText.slice(lastIdx));
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

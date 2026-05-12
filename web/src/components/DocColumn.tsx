import { useEffect, useRef } from "react";
import { Box, Stack, Typography, IconButton, Tooltip } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import type { VerseDto } from "../sync/api";

interface Props {
  bibleVersion: string;
  versesByVerseNum: Record<number, VerseDto>;
  verseNumbers: number[];
  chapter: number;
  activeVerse: number;
  readOnly?: boolean;
  rtl?: boolean;
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
  onSelectVerse,
  onEditVerse,
  onOpenAligner,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeVerse]);

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
        bgcolor: readOnly ? "rgba(0,0,0,0.025)" : "background.paper",
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
          lineHeight: 1.6,
          fontSize: 14.5,
          direction: rtl ? "rtl" : "ltr",
          textAlign: rtl ? "right" : "left",
        }}
      >
        {verseNumbers.map((v) => {
          const dto = versesByVerseNum[v];
          if (!dto) return null;
          const isActive = v === activeVerse;
          return (
            <VerseSpan
              key={v}
              chapter={chapter}
              verseNum={v}
              text={dto.plain_text ?? ""}
              isActive={isActive}
              readOnly={!!readOnly}
              rtl={!!rtl}
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
  text,
  isActive,
  readOnly,
  rtl,
  spanRef,
  onClick,
  onAlign,
  onEdit,
}: {
  chapter: number;
  verseNum: number;
  text: string;
  isActive: boolean;
  readOnly: boolean;
  rtl: boolean;
  spanRef: React.MutableRefObject<HTMLSpanElement | null> | null;
  onClick: () => void;
  onAlign: () => void;
  onEdit: (plain: string) => void;
}) {
  const elRef = useRef<HTMLSpanElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTextRef = useRef(text);

  // Keep DOM text in sync with prop when the prop changes from outside
  // (e.g. server-confirmed update). Avoid clobbering during live edits —
  // only resync when the DOM text matches the previous prop value.
  useEffect(() => {
    if (!elRef.current) return;
    const dom = elRef.current.innerText;
    if (dom === lastTextRef.current) {
      elRef.current.innerText = text;
    }
    lastTextRef.current = text;
  }, [text]);

  const setMarkerRef = (node: HTMLSpanElement | null) => {
    if (spanRef) spanRef.current = node;
  };

  return (
    <span
      onClick={onClick}
      style={{
        display: "inline",
        borderRadius: 4,
        padding: isActive ? "1px 2px" : 0,
        backgroundColor: isActive ? "rgba(25,118,210,0.12)" : "transparent",
        boxShadow: isActive ? "0 0 0 1.5px #1976d2" : undefined,
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
      </Tooltip>{" "}
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
      >
        {text}
      </span>{" "}
    </span>
  );
}

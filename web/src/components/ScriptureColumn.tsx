import { useEffect, useMemo, useRef } from "react";
import { Box, Stack, Typography, Paper, IconButton, Tooltip, ToggleButton, ToggleButtonGroup, Button } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import UndoIcon from "@mui/icons-material/Undo";
import type { VerseDto } from "../sync/api";
import { DocColumn } from "./DocColumn";
import { highlightsFor, renderHighlightedHTML, type HighlightKey } from "../lib/highlight";

export type ScriptureMode = "stacked" | "columns";

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
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
  onModeChange: (mode: ScriptureMode) => void;
  onEnabledVersionsChange: (versions: string[]) => void;
  onEditVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
}

const VERSION_LABEL: Record<string, string> = {
  ULT: "ULT",
  UST: "UST",
  UHB: "UHB",
  UGNT: "UGNT",
};

const READ_ONLY_VERSIONS = new Set(["UHB", "UGNT"]);

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
  onSelectVerse,
  onOpenAligner,
  onModeChange,
  onEnabledVersionsChange,
  onEditVerse,
}: Props) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (mode === "stacked") {
      activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeVerse, mode]);

  const isHebrew = !!versesByVersion["UHB"];

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px dashed",
        borderColor: "divider",
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
        <Button
          size="small"
          variant={mode === "columns" ? "contained" : "outlined"}
          startIcon={<ViewColumnIcon fontSize="small" />}
          onClick={() => onModeChange(mode === "columns" ? "stacked" : "columns")}
          sx={{ textTransform: "none" }}
        >
          {mode === "columns" ? `${enabledVersions.length} col${enabledVersions.length === 1 ? "" : "s"}` : "columns"}
        </Button>
        {mode === "columns" && (
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
        <Tooltip title="scroll the active verse back into view if you've scrolled away">
          <Button
            size="small"
            startIcon={<UndoIcon fontSize="small" />}
            onClick={() => activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
            sx={{ textTransform: "none" }}
          >
            go to active
          </Button>
        </Tooltip>
        <Typography variant="caption" color="text.secondary">
          {book} {chapter}:{activeVerse === 0 ? "intro" : activeVerse}
        </Typography>
      </Stack>
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
          onSelectVerse={onSelectVerse}
          onOpenAligner={onOpenAligner}
        />
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
              readOnly={READ_ONLY_VERSIONS.has(v)}
              rtl={v === "UHB"}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              onSelectVerse={onSelectVerse}
              onEditVerse={(verseNum, plain, base) => onEditVerse(verseNum, v, plain, base)}
              onOpenAligner={(verseNum) => onOpenAligner(verseNum, v)}
            />
          ))}
        </Box>
      )}
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
  onSelectVerse,
  onOpenAligner,
}: {
  versesByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  activeRef: React.MutableRefObject<HTMLDivElement | null>;
  chapter: number;
  isHebrew: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
}) {
  const ult = versesByVersion["ULT"] ?? {};
  const ust = versesByVersion["UST"] ?? {};
  const uhb = versesByVersion["UHB"] ?? versesByVersion["UGNT"] ?? {};
  return (
    <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 1 }}>
      {verseNumbers.map((v) => {
        const isActive = v === activeVerse;
        const ultV = ult[v];
        const ustV = ust[v];
        const uhbV = uhb[v];
        if (isActive) {
          const ultHL = highlightsFor("ULT", ultV?.content, activeNoteQuote, activeNoteOccurrence);
          const ustHL = highlightsFor("UST", ustV?.content, activeNoteQuote, activeNoteOccurrence);
          const uhbHL = highlightsFor(isHebrew ? "UHB" : "UGNT", uhbV?.content, activeNoteQuote, activeNoteOccurrence);
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
              <ActiveLine label="ULT" text={ultV?.plain_text ?? ""} content={ultV?.content} highlights={ultHL} editable onOpenAligner={() => onOpenAligner(v, "ULT")} />
              <ActiveLine label="UST" text={ustV?.plain_text ?? ""} content={ustV?.content} highlights={ustHL} editable onOpenAligner={() => onOpenAligner(v, "UST")} />
              {uhbV && (
                <ActiveLine label={isHebrew ? "UHB" : "UGNT"} text={uhbV.plain_text ?? ""} content={uhbV.content} highlights={uhbHL} rtl={isHebrew} readOnly />
              )}
            </Paper>
          );
        }
        return (
          <Box
            key={v}
            onClick={() => onSelectVerse(v)}
            sx={{
              p: 1,
              my: 0.5,
              borderRadius: 1,
              cursor: "pointer",
              color: "text.secondary",
              fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
              lineHeight: 1.5,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Typography
              component="span"
              variant="caption"
              sx={{ fontFamily: "monospace", mr: 0.5, color: "text.disabled" }}
            >
              {v === 0 ? "intro" : `${chapter}:${v}`}
            </Typography>
            <Typography
              component="span"
              variant="caption"
              sx={{ fontFamily: "monospace", mr: 0.5, textTransform: "uppercase" }}
            >
              ULT
            </Typography>
            <span>{ultV?.plain_text ?? ""}</span>
            {ustV && (
              <Box sx={{ pl: 2, mt: 0.25 }}>
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ fontFamily: "monospace", mr: 0.5, textTransform: "uppercase" }}
                >
                  UST
                </Typography>
                <span>{ustV.plain_text ?? ""}</span>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function ActiveLine({
  label,
  text,
  content,
  highlights,
  rtl,
  readOnly,
  editable,
  onOpenAligner,
}: {
  label: string;
  text: string;
  content?: unknown;
  highlights?: Set<HighlightKey>;
  rtl?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  onOpenAligner?: () => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => {
    if (!content || !highlights || highlights.size === 0) return null;
    const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    return renderHighlightedHTML(verseObjects, highlights);
  }, [content, highlights]);
  // Only resync the DOM when the highlight/content state actually changes —
  // not on every keystroke. This lets the user type freely; clicking a
  // different note triggers a re-set that includes the new highlights.
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
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          color: "text.secondary",
          textTransform: "uppercase",
          minWidth: 32,
          pt: 0.5,
          flexShrink: 0,
        }}
      >
        {VERSION_LABEL[label] ?? label}
      </Typography>
      {onOpenAligner && (
        <Tooltip title={`align ${label}`}>
          <IconButton size="small" onClick={onOpenAligner} sx={{ color: "success.main", mt: 0.25 }}>
            <LinkIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      )}
      <Box
        ref={elRef}
        contentEditable={editable && !readOnly}
        suppressContentEditableWarning
        spellCheck={!rtl}
        sx={{
          flex: 1,
          bgcolor: readOnly ? "rgba(0,0,0,0.03)" : "background.paper",
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
          "& mark.be-hl": {
            backgroundColor: "#fff48a",
            padding: "0 2px",
            borderRadius: 0.5,
            color: "inherit",
          },
          "&:focus": readOnly
            ? {}
            : {
                borderColor: "primary.main",
                boxShadow: "0 0 0 2px rgba(25,118,210,0.2)",
              },
        }}
      />
    </Stack>
  );
}

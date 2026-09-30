// The pinned lexical box: double-clicking a Hebrew/Greek source word opens this
// panel with the same lexical info as the hover Tooltip, but with
// selectable/copyable text (the hover Tooltip is pointerEvents:none and can't
// be). A copy button lifts the lexical form (lemma) to the clipboard; an X
// (or Esc) closes it.
//
// It used to be a Popover anchored to the clicked word, which jumped whenever
// the word moved or re-rendered and closed on any outside click (#1053). Now
// there is ONE non-modal panel for the whole app, mounted by <PinnedLexHost/>,
// at a fixed screen spot the user can drag; its position is remembered per
// browser. Double-clicking another word just swaps its contents. Words call
// pinLex() — used by the scripture-column source line (HebrewLine) and the
// aligner's UHB strip (UhbStrip).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Paper, Portal, IconButton, Tooltip, Box } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import type { SourceWord } from "../lib/alignment";
import type { LexiconEntry } from "../hooks/useLexicon";
import { SourceTooltipBody } from "./SourceTooltipBody";

type Pinned = { source: SourceWord; lex: LexiconEntry | null; twHint: string | null };

let pinned: Pinned | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function pinLex(source: SourceWord, lex: LexiconEntry | null, twHint: string | null) {
  pinned = { source, lex, twHint };
  emit();
}

function unpinLex() {
  pinned = null;
  emit();
}

const POS_KEY = "bible-editor.lexbox.pos";
const WIDTH = 360;

type Pos = { x: number; y: number };

function loadPos(): Pos | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    if (p && typeof p.x === "number" && typeof p.y === "number") return p;
  } catch {
    // storage blocked or bad JSON — use the default spot
  }
  return null;
}

// Keep the panel's header on screen after a drag or a window resize.
function clamp(p: Pos): Pos {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - WIDTH)),
    y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40)),
  };
}

export function PinnedLexHost() {
  const current = useSyncExternalStore(subscribe, () => pinned);
  // null = default spot (bottom-right corner, anchored by right/bottom).
  const [pos, setPos] = useState<Pos | null>(loadPos);
  const paperRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") unpinLex();
    };
    const onResize = () => setPos((p) => (p ? clamp(p) : p));
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [current]);

  if (!current) return null;
  const { source, lex, twHint } = current;
  const lemma = lex?.lemma || source.lemma || "";

  const copy = async () => {
    if (!lemma) return;
    try {
      await navigator.clipboard.writeText(lemma);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked (insecure context / permissions) — no-op
    }
  };

  const startDrag = (e: React.PointerEvent) => {
    const rect = paperRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    let last: Pos = { x: rect.left, y: rect.top };
    const move = (ev: PointerEvent) => {
      last = clamp({ x: ev.clientX - dx, y: ev.clientY - dy });
      setPos(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(last));
      } catch {
        // storage blocked — position just isn't remembered
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const iconSx = { color: "rgba(255,255,255,0.7)" };
  return (
    <Portal>
      <Paper
        ref={paperRef}
        role="dialog"
        aria-label="lexical information"
        elevation={8}
        sx={(theme) => ({
          position: "fixed",
          zIndex: theme.zIndex.tooltip,
          ...(pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 }),
          width: WIDTH,
          maxWidth: "calc(100vw - 16px)",
          maxHeight: "60vh",
          overflow: "auto",
          bgcolor: "rgba(33,33,33,0.97)",
          color: "#fff",
          p: 1,
          pt: 0,
        })}
      >
        <Box
          onPointerDown={startDrag}
          sx={{ display: "flex", alignItems: "center", cursor: "move", mx: -0.5, userSelect: "none" }}
        >
          <DragIndicatorIcon sx={{ fontSize: 16, ...iconSx }} />
          {lemma && (
            <Tooltip title={copied ? "copied" : "copy lexical form"}>
              <IconButton
                size="small"
                aria-label="copy lexical form"
                onClick={copy}
                onPointerDown={(e) => e.stopPropagation()}
                sx={iconSx}
              >
                {copied ? <CheckIcon sx={{ fontSize: 15 }} /> : <ContentCopyIcon sx={{ fontSize: 15 }} />}
              </IconButton>
            </Tooltip>
          )}
          <Box sx={{ flex: 1 }} />
          <IconButton
            size="small"
            aria-label="close"
            onClick={unpinLex}
            onPointerDown={(e) => e.stopPropagation()}
            sx={iconSx}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
        <SourceTooltipBody source={source} lex={lex} twHint={twHint} />
      </Paper>
    </Portal>
  );
}

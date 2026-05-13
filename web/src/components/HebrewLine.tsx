// Renders a Hebrew (UHB) or Greek (UGNT) verse one \w token at a time so
// each carries a lexicon Tooltip on hover, while still respecting the
// note-quote highlight set from highlight.ts. Used by the main scripture
// column in stacked, columns, and book modes — these versions are
// read-only, so we don't have to maintain a contentEditable cursor.

import { Tooltip, Box } from "@mui/material";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { SourceWord } from "../lib/alignment";
import type { HighlightKey } from "../lib/highlight";
import { SourceTooltipBody } from "./SourceTooltipBody";

interface Props {
  verseObjects: unknown[] | undefined | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  highlights?: Set<HighlightKey> | null;
  // Find-overlay matches that should paint orange (be-find), overriding
  // any yellow note highlight on the same token. Keyed `${text}|${occ}`.
  findHighlights?: Set<HighlightKey> | null;
  // Used when the parent supplies a flat fallback string (e.g. when the
  // verseObjects tree is missing or invalid).
  fallbackText?: string;
}

export function HebrewLine({ verseObjects, lexiconMap, highlights, findHighlights, fallbackText }: Props) {
  if (!Array.isArray(verseObjects)) {
    return <>{fallbackText ?? ""}</>;
  }
  const items: React.ReactNode[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "text") {
        items.push(
          <span key={`t${items.length}`}>{String(o["text"] ?? "")}</span>,
        );
      } else if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const strong = String(o["strong"] ?? "");
        const occ = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const key: HighlightKey = `${text}|${occ}`;
        const isFindHit = !!findHighlights && findHighlights.has(key);
        const isHighlighted = !!highlights && highlights.has(key);
        const src: SourceWord = {
          id: "",
          strong,
          lemma: String(o["lemma"] ?? ""),
          morph: String(o["morph"] ?? ""),
          occurrence: String(occ),
          occurrences: String(o["occurrences"] ?? "1"),
          content: text,
        };
        const wordSpan = (
          <Box
            component="span"
            sx={{
              cursor: "help",
              ...(isFindHit
                ? {
                    backgroundColor: "#ffd966",
                    outline: "1px solid #d97706",
                    padding: "0 1px",
                    borderRadius: 0.5,
                  }
                : isHighlighted
                  ? {
                      backgroundColor: "#fff48a",
                      padding: "0 2px",
                      borderRadius: 0.5,
                    }
                  : {}),
            }}
          >
            {text}
          </Box>
        );
        items.push(
          <Tooltip
            key={`w${items.length}`}
            title={<SourceTooltipBody source={src} lex={lexiconMap.get(strong) ?? null} />}
            slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
          >
            {wordSpan}
          </Tooltip>,
        );
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return <>{items}</>;
}

// Collect every \w token's raw Strong's from a verseObjects tree. Used by
// callers that want to pre-load lexicon entries for a chapter at a time.
export function collectStrongs(verseObjects: unknown[] | null | undefined): string[] {
  if (!Array.isArray(verseObjects)) return [];
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const s = String(o["strong"] ?? "");
        if (s) out.push(s);
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return out;
}

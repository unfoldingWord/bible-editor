// Shared tooltip body for hovering Hebrew/Greek source words. Used by both
// the aligner (verse strip + alignment-card source rows) and the main
// scripture UHB display. Falls back to lemma/POS from the USFM \w
// attributes when the UHAL/UGL row is missing a gloss/definition; says so
// explicitly when we have no entry at all.

import { Box, Divider } from "@mui/material";
import type { SourceWord } from "../lib/alignment";
import type { LexiconEntry } from "../hooks/useLexicon";

interface Props {
  source: SourceWord;
  lex: LexiconEntry | null;
  twHint?: string | null;
}

// UHAL/UGL `definition` ships as a single text blob with inline "Meaning:",
// "Usage:", "Source:", and sometimes "Compare ..." markers. Splitting them
// into labeled sections is the whole point of the tooltip redesign — the raw
// blob is dense and hard to scan.
function parseDefinition(raw: string | null | undefined): Array<{ label: string; body: string }> {
  if (!raw) return [];
  const text = raw.trim();
  const pattern = /\b(Meaning|Usage|Source|Compare)\b:?\s+/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return [{ label: "", body: text }];
  const out: Array<{ label: string; body: string }> = [];
  const first = matches[0].index ?? 0;
  if (first > 0) {
    const pre = text.slice(0, first).trim();
    if (pre) out.push({ label: "", body: pre });
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const body = text.slice(start, end).trim().replace(/[;,]\s*$/, "");
    if (body) out.push({ label: m[1], body });
  }
  return out;
}

export function SourceTooltipBody({ source, lex, twHint }: Props) {
  const lemma = lex?.lemma || source.lemma || "—";
  const pos = lex?.part_of_speech || source.morph || "—";
  const sections = parseDefinition(lex?.definition);
  const hasEntry = !!(lex?.gloss || lex?.definition);

  return (
    <Box sx={{ fontSize: 12, maxWidth: 340, lineHeight: 1.5, p: 0.25 }}>
      <Box sx={{ textAlign: "center", mb: 0.75 }}>
        <Box
          sx={{
            fontFamily: '"Times New Roman","SBL Hebrew",serif',
            fontSize: 22,
            lineHeight: 1.1,
            mb: 0.5,
          }}
        >
          {lemma}
        </Box>
        <Box
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            fontSize: 11,
          }}
        >
          {source.strong && (
            <Box
              component="span"
              sx={{
                fontFamily: "monospace",
                px: 0.75,
                py: 0.125,
                borderRadius: 0.75,
                bgcolor: "rgba(102, 188, 231, 0.22)",
                color: "#a8dcf5",
                fontWeight: 600,
                letterSpacing: 0.25,
              }}
            >
              {source.strong}
            </Box>
          )}
          <Box component="span" sx={{ opacity: 0.7 }}>{pos}</Box>
        </Box>
      </Box>

      {lex?.gloss && (
        <Box
          sx={{
            textAlign: "center",
            fontWeight: 700,
            fontSize: 14,
            color: "#a8dcf5",
            mb: 0.5,
          }}
        >
          {lex.gloss}
        </Box>
      )}

      {sections.length > 0 && (
        <>
          <Divider sx={{ my: 0.75, borderColor: "rgba(255,255,255,0.18)" }} />
          {sections.map((s, i) => (
            <Box key={i} sx={{ mb: 0.5, "&:last-of-type": { mb: 0 } }}>
              {s.label && (
                <Box
                  component="span"
                  sx={{
                    fontWeight: 700,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    opacity: 0.65,
                    mr: 0.75,
                  }}
                >
                  {s.label}
                </Box>
              )}
              <Box component="span" sx={{ opacity: 0.92 }}>{s.body}</Box>
            </Box>
          ))}
        </>
      )}

      {!hasEntry && (
        <Box sx={{ mt: 0.5, opacity: 0.55, fontStyle: "italic", textAlign: "center" }}>
          no lexicon entry — stub in source resource
        </Box>
      )}

      {twHint && (
        <>
          <Divider sx={{ my: 0.75, borderColor: "rgba(255,255,255,0.18)" }} />
          <Box sx={{ fontSize: 11 }}>
            <Box
              component="span"
              sx={{
                fontWeight: 700,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                opacity: 0.65,
                mr: 0.75,
              }}
            >
              tW
            </Box>
            <Box component="span" sx={{ opacity: 0.92 }}>{twHint}</Box>
          </Box>
        </>
      )}
    </Box>
  );
}

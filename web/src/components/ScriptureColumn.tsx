import { useEffect, useRef } from "react";
import { Box, Stack, Typography, Paper, IconButton, Tooltip } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import type { VerseDto } from "../sync/api";

interface Props {
  book: string;
  chapter: number;
  versesByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
}

const VERSION_LABEL: Record<string, string> = {
  ULT: "ULT",
  UST: "UST",
  UHB: "UHB",
  UGNT: "UGNT",
};

export function ScriptureColumn({
  book,
  chapter,
  versesByVersion,
  verseNumbers,
  activeVerse,
  onSelectVerse,
  onOpenAligner,
}: Props) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeVerse]);

  const ult = versesByVersion["ULT"] ?? {};
  const ust = versesByVersion["UST"] ?? {};
  const uhb = versesByVersion["UHB"] ?? versesByVersion["UGNT"] ?? {};
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
      <Box
        sx={{
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        <Typography variant="subtitle2">Scripture</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {book} {chapter}:{activeVerse === 0 ? "intro" : activeVerse}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 1 }}>
        {verseNumbers.map((v) => {
          const isActive = v === activeVerse;
          const ultV = ult[v];
          const ustV = ust[v];
          const uhbV = uhb[v];
          if (isActive) {
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
                  text={ultV?.plain_text ?? ""}
                  editable
                  onOpenAligner={() => onOpenAligner(v, "ULT")}
                />
                <ActiveLine
                  label="UST"
                  text={ustV?.plain_text ?? ""}
                  editable
                  onOpenAligner={() => onOpenAligner(v, "UST")}
                />
                {uhbV && (
                  <ActiveLine
                    label={isHebrew ? "UHB" : "UGNT"}
                    text={uhbV.plain_text ?? ""}
                    rtl={isHebrew}
                    readOnly
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
                p: 1,
                my: 0.5,
                borderRadius: 1,
                cursor: "pointer",
                color: "text.secondary",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography
                variant="caption"
                sx={{ fontFamily: "monospace", mr: 0.5, color: "text.disabled" }}
              >
                {v === 0 ? "intro" : `${chapter}:${v}`}
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: "monospace", mr: 0.5, textTransform: "uppercase" }}>
                ULT
              </Typography>
              <span>{ultV?.plain_text ?? ""}</span>
              {ustV && (
                <Box sx={{ pl: 2, mt: 0.25 }}>
                  <Typography
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
    </Box>
  );
}

function ActiveLine({
  label,
  text,
  rtl,
  readOnly,
  editable,
  onOpenAligner,
}: {
  label: string;
  text: string;
  rtl?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  onOpenAligner?: () => void;
}) {
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
          fontSize: 14,
          lineHeight: 1.4,
          direction: rtl ? "rtl" : "ltr",
          textAlign: rtl ? "right" : "left",
          outline: "none",
          "&:focus": readOnly
            ? {}
            : {
                borderColor: "primary.main",
                boxShadow: "0 0 0 2px rgba(25,118,210,0.2)",
              },
        }}
      >
        {text}
      </Box>
    </Stack>
  );
}

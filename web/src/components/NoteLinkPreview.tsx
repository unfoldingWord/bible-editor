// Hover preview for a "see how you translated this" note link (issue #934):
// shows the note the link points back to plus the target verse's ULT and UST,
// so the translator can compare without navigating away. Clicking the link
// still navigates (the caller owns that); this only wraps it in a tooltip.
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Box, CircularProgress, Tooltip, Typography } from "@mui/material";
import { api } from "../sync/api";
import type { ChapterPayload } from "../sync/api";
import { pickLinkedNotes } from "../lib/noteLinks";
import type { NoteLinkTarget } from "../lib/noteLinks";
import { buildVerseIndex } from "../lib/verseRange";
import { shortSupport } from "../lib/supportReference";

// One fetch per chapter per short window: hovering several links into the
// same chapter shouldn't refetch, but a preview opened a minute later should
// see edits made since. Failed fetches are dropped so the next hover retries.
const CACHE_TTL_MS = 60_000;
const chapterCache = new Map<string, { at: number; promise: Promise<ChapterPayload> }>();

function loadChapter(book: string, chapter: number): Promise<ChapterPayload> {
  const key = `${book}/${chapter}`;
  const hit = chapterCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = api.getChapter(book, chapter);
  chapterCache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (chapterCache.get(key)?.promise === promise) chapterCache.delete(key);
  });
  return promise;
}

function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

function PreviewBody({ target, supportRef }: { target: NoteLinkTarget; supportRef: string | null }) {
  const [data, setData] = useState<ChapterPayload | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    loadChapter(target.book, target.chapter).then(
      (d) => {
        if (!cancelled) setData(d);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target.book, target.chapter]);

  const ref = `${target.book} ${target.chapter}:${target.verse}`;
  if (error) {
    return <Typography variant="body2" color="error">Couldn't load {ref}.</Typography>;
  }
  if (!data) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary">Loading {ref}…</Typography>
      </Box>
    );
  }

  const ult = buildVerseIndex(data.verses["ULT"])[target.verse]?.plain_text ?? null;
  const ust = buildVerseIndex(data.verses["UST"])[target.verse]?.plain_text ?? null;
  const { notes, matchedSupport } = pickLinkedNotes(data.tn, target.verse, supportRef);

  const label = { fontWeight: 600, fontSize: 11, letterSpacing: 0.4, color: "text.secondary", textTransform: "uppercase" } as const;
  const scripture = { fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif', fontSize: 14, lineHeight: 1.45 } as const;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 13 }}>{ref}</Typography>
      <Box>
        <Typography sx={label}>ULT</Typography>
        <Typography sx={scripture}>{ult || "—"}</Typography>
      </Box>
      <Box>
        <Typography sx={label}>UST</Typography>
        <Typography sx={scripture}>{ust || "—"}</Typography>
      </Box>
      <Box>
        <Typography sx={label}>
          {matchedSupport || notes.length <= 1 ? "Note" : `Notes on this verse (${notes.length})`}
        </Typography>
        {notes.length === 0 ? (
          <Typography variant="body2" color="text.secondary">No notes on this verse.</Typography>
        ) : (
          notes.map((n) => (
            <Box
              key={n.id}
              sx={{ mt: 0.5, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}
            >
              {(n.quote || n.support_reference) && (
                <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                  {n.quote && <Box component="span" dir="auto" sx={{ fontWeight: 600 }}>{n.quote}</Box>}
                  {n.quote && n.support_reference && " · "}
                  {n.support_reference && shortSupport(n.support_reference)}
                </Typography>
              )}
              <Typography sx={{ ...scripture, whiteSpace: "pre-wrap" }}>{tsvToDisplay(n.note) || "—"}</Typography>
            </Box>
          ))
        )}
      </Box>
      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>Click the link to go there.</Typography>
    </Box>
  );
}

export function NoteLinkPreview({
  target,
  supportRef,
  children,
}: {
  target: NoteLinkTarget;
  supportRef: string | null;
  children: ReactElement;
}) {
  return (
    <Tooltip
      enterDelay={350}
      enterNextDelay={350}
      leaveDelay={150}
      placement="bottom-start"
      // MUI only mounts `title` while open, so the chapter fetch happens on
      // hover, never for links nobody points at.
      title={
        // React events bubble through the portal to the note card; stop them
        // so selecting text in the preview doesn't flip the card into edit
        // mode or navigate.
        <Box
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          <PreviewBody target={target} supportRef={supportRef} />
        </Box>
      }
      slotProps={{
        tooltip: {
          sx: {
            bgcolor: "background.paper",
            color: "text.primary",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: 3,
            // Fixed width: Popper positions against the small loading state,
            // so a width that grows once the chapter arrives would overflow
            // the viewport edge instead of being shifted back inside it.
            width: 440,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: 420,
            overflowY: "auto",
            p: 1.5,
          },
        },
      }}
    >
      {children}
    </Tooltip>
  );
}

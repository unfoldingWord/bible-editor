// Hover preview for a "see how you translated this" note link (issue #934):
// shows the note the link points back to plus the target verse's ULT and UST,
// so the translator can compare without navigating away. Clicking the link
// still navigates (the caller owns that); this only wraps it in a tooltip.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Instance } from "@popperjs/core";
import { Box, CircularProgress, Tooltip, Typography } from "@mui/material";
import { api } from "../sync/api";
import type { ChapterPayload } from "../sync/api";
import { onOutboxResult } from "../sync/outbox";
import { savedChapter } from "../lib/savedChapter";
import { pickLinkedNotes } from "../lib/noteLinks";
import type { NoteLinkTarget } from "../lib/noteLinks";
import { buildVerseIndex } from "../lib/verseRange";
import { shortSupport } from "../lib/supportReference";

// The chapter Shell has open, as useChapter holds it. A link into that
// chapter previews this rather than a server copy, so saved edits show at once
// even before the server round-trip (and there is no extra fetch). A note body
// still being typed is not here: it lives in the card's draft until Save.
const OpenChapterContext = createContext<ChapterPayload | null>(null);

export function OpenChapterProvider({ data, children }: { data: ChapterPayload | null; children: ReactNode }) {
  // Once a chapter is open its server copy in the cache is stale by
  // definition; drop it so a preview after navigating away refetches.
  useEffect(() => {
    if (data) chapterCache.delete(cacheKey(data.book, data.chapter));
  }, [data]);
  return <OpenChapterContext.Provider value={data}>{children}</OpenChapterContext.Provider>;
}

// Other chapters: one fetch per chapter per short window, so hovering several
// links into the same chapter doesn't refetch but a preview opened a minute
// later sees edits made since. Failed fetches are dropped so the next hover
// retries. `value` is kept once resolved so a re-hover renders at once
// instead of flashing the spinner for a microtask.
const CACHE_TTL_MS = 60_000;
const chapterCache = new Map<string, { at: number; promise: Promise<ChapterPayload>; value?: ChapterPayload }>();

// This client's own confirmed saves make that chapter's cached copy stale at
// once, even when the chapter isn't open (book-view find/replace writes into
// any loaded chapter, #936). Dropping it on the 200, not at enqueue, means
// the refetch sees the save. Other people's edits keep the TTL bound.
onOutboxResult((op, result) => {
  const hit = savedChapter(op, result);
  if (hit) chapterCache.delete(cacheKey(hit.book, hit.chapter));
});

function cacheKey(book: string, chapter: number): string {
  return `${book.toUpperCase()}/${chapter}`;
}

function freshEntry(book: string, chapter: number) {
  const hit = chapterCache.get(cacheKey(book, chapter));
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit : null;
}

function loadChapter(book: string, chapter: number): Promise<ChapterPayload> {
  const hit = freshEntry(book, chapter);
  if (hit) return hit.promise;
  const key = cacheKey(book, chapter);
  const promise = api.getChapter(book, chapter);
  const entry: { at: number; promise: Promise<ChapterPayload>; value?: ChapterPayload } = { at: Date.now(), promise };
  chapterCache.set(key, entry);
  promise.then(
    (d) => {
      entry.value = d;
    },
    () => {
      if (chapterCache.get(key) === entry) chapterCache.delete(key);
    },
  );
  return promise;
}

const PREVIEW_WIDTH = 440;

// Popper anchor for the preview: the hovered link's vertical extent, but its
// note card's horizontal extent, so "left"/"right" placement puts the preview
// beside the card instead of on top of it (#1026). contextElement lets Popper
// find the link's scroll parents and follow it when the column scrolls.
function besideCard(el: Element) {
  return {
    contextElement: el,
    getBoundingClientRect: () => {
      const link = el.getBoundingClientRect();
      const card = el.closest("[data-note-id]")?.getBoundingClientRect() ?? link;
      return new DOMRect(card.left, link.top, card.width, link.height);
    },
  };
}

// Picked once per open instead of by Popper's flip: flipping resizes the popper
// (MUI's tooltip margin follows the placement), and at widths where no side
// fits that fed back into the next flip and looped until React gave up.
// Beside the card when a side has room for the whole preview, else above or
// below, whichever has more space; preventOverflow then keeps it on screen.
function choosePlacement(el: Element): "left" | "right" | "top" | "bottom" {
  const card = (el.closest("[data-note-id]") ?? el).getBoundingClientRect();
  const need = Math.min(PREVIEW_WIDTH, window.innerWidth - 32) + 14 + 8; // + MUI's gap + edge padding
  if (card.left >= need) return "left";
  if (window.innerWidth - card.right >= need) return "right";
  return card.top > window.innerHeight - card.bottom ? "top" : "bottom";
}

// Module-level so the Tooltip's memoized popperOptions stay stable.
const POPPER_OPTIONS = {
  modifiers: [
    { name: "flip", enabled: false },
    { name: "preventOverflow", options: { padding: 8, tether: false, altAxis: true } },
  ],
};

// Popper positions once, often against the short "Loading…" state; when the
// chapter arrives the preview grows and would run off the bottom of the screen
// until the next hover. Re-run placement whenever the content changes size.
function RepositionOnResize({ popper, children }: { popper: React.RefObject<Instance | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => popper.current?.update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [popper]);
  return <div ref={ref}>{children}</div>;
}

function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

function PreviewBody({ target, supportRef }: { target: NoteLinkTarget; supportRef: string | null }) {
  const open = useContext(OpenChapterContext);
  const isTarget = (d: ChapterPayload | null) =>
    d != null && d.book.toUpperCase() === target.book.toUpperCase() && d.chapter === target.chapter;
  const live = isTarget(open) ? open : null;
  const [fetched, setFetched] = useState<ChapterPayload | null>(
    () => freshEntry(target.book, target.chapter)?.value ?? null,
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    if (live) return;
    let cancelled = false;
    setFetched(freshEntry(target.book, target.chapter)?.value ?? null);
    setError(false);
    loadChapter(target.book, target.chapter).then(
      (d) => {
        if (!cancelled) setFetched(d);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // `live` is a new object on every local edit; only whether there is one matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.book, target.chapter, live == null]);

  // `fetched` can still hold the previous target's chapter for the one render
  // before the effect resets it (a reused tooltip whose link changed); never
  // show it under the new reference.
  const data = live ?? (isTarget(fetched) ? fetched : null);
  const ref = `${target.book} ${target.chapter}:${target.verse}`;
  if (error && !data) {
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
          {notes.length === 0 ? "Notes" : notes.length === 1 ? "Note" : matchedSupport ? `Notes (${notes.length})` : `Notes on this verse (${notes.length})`}
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
      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>Click to go there.</Typography>
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
  const [anchor, setAnchor] = useState<ReturnType<typeof besideCard> | null>(null);
  // Replaces the Tooltip's own popperRef, which it only uses for followCursor.
  const popperRef = useRef<Instance>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof choosePlacement>>("left");
  return (
    <Tooltip
      enterDelay={350}
      enterNextDelay={350}
      // Longer than MUI's default: beside the card, the preview can sit a
      // card's width away from the link, and the pointer has to cross that
      // gap to reach it.
      leaveDelay={300}
      placement={placement}
      onOpen={(e) => {
        // MUI calls onOpen from the enterDelay timer, after React has cleared
        // currentTarget; target (the link or something inside it) survives.
        const el = e.target as Element | null;
        if (!el) return;
        setAnchor(besideCard(el));
        setPlacement(choosePlacement(el));
      }}
      // MUI only mounts `title` while open, so the chapter fetch happens on
      // hover, never for links nobody points at.
      title={
        <RepositionOnResize popper={popperRef}>
          <PreviewBody target={target} supportRef={supportRef} />
        </RepositionOnResize>
      }
      slotProps={{
        // React events bubble through the portal to the note card; stop them on
        // the popper, the outermost element, so a click anywhere in the preview
        // (its padding, its scrollbar, the gap MUI leaves between link and
        // tooltip) can't flip the card into edit mode or navigate either.
        popper: {
          // Only once opened: an explicit undefined would override the
          // Tooltip's own anchor (the link) rather than fall back to it.
          ...(anchor ? { anchorEl: anchor } : null),
          popperOptions: POPPER_OPTIONS,
          popperRef,
          onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
        },
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
            width: PREVIEW_WIDTH,
            maxWidth: "calc(100vw - 32px)",
            // Never taller than the viewport, so preventOverflow can always
            // fit all of it on screen.
            maxHeight: "min(420px, calc(100vh - 16px))",
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

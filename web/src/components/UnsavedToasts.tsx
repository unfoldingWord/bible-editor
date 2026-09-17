// Corner stack of "save Num 20:1 ULT?" reminders for verse drafts whose
// editor is currently off-screen (different chapter, scrolled away, or
// never mounted in this mode). Subscribes to the drafts store and uses
// IntersectionObserver against the editor's `data-find-cell` attribute
// to decide what's visible.
//
// Lives bottom-left to leave bottom-right free for SyncStatusBar /
// AiCompletionToasts. Aggregates above 3 entries.

import { useEffect, useMemo, useState } from "react";
import { Alert, IconButton, Stack, Button, Box, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { drafts, type DraftRecord } from "../sync/drafts";
import { outbox, type OutboxOp } from "../sync/outbox";
import { verseDraftHasActiveSave } from "../sync/draftSaveState";

const AGGREGATE_THRESHOLD = 3;

interface Props {
  // Current book. Cross-book drafts (rare) are filtered out so the toast
  // never asks the user to save a verse from a book that isn't loaded —
  // the resolution path would need the book's verse cache, which we
  // don't carry around.
  book: string;
  // Persist/save a verse draft. Shell wires this to saveVerseDraft.
  onSaveVerseDraft: (
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
  ) => void;
  // Optional: scroll/navigate the user to a specific draft. Stub-friendly.
  onJumpTo?: (book: string, chapter: number, verse: number, bibleVersion: string) => void;
}

export function UnsavedToasts({ book, onSaveVerseDraft, onJumpTo }: Props) {
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  const [ops, setOps] = useState<OutboxOp[]>([]);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => drafts.subscribe(setDraftList), []);
  useEffect(() => outbox.subscribe(setOps), []);

  // Payload/generation changes on every keystroke, but observer targets do not.
  const visibilityTargets = JSON.stringify(draftList
    .filter((d) => d.meta.kind === "verse" && d.meta.book === book)
    .map((d) => [d.key, `${d.meta.chapter}-${d.meta.verse}-${d.meta.kind === "verse" ? d.meta.bibleVersion : ""}`])
    .sort(([a], [b]) => a.localeCompare(b)));
  useEffect(() => {
    const targets = JSON.parse(visibilityTargets) as [string, string][];
    if (!targets.length) {
      setVisibleKeys((prev) => prev.size ? new Set() : prev);
      return;
    }
    const observed = new Map<Element, string>();
    const observer = new IntersectionObserver((entries) => {
      setVisibleKeys((prev) => {
        const next = new Set(prev);
        for (const entry of entries) {
          const key = observed.get(entry.target);
          if (!key) continue;
          if (entry.isIntersecting) next.add(key);
          else next.delete(key);
        }
        return next.size === prev.size && [...next].every((key) => prev.has(key)) ? prev : next;
      });
    }, { threshold: 0.05 });
    const reconcile = () => {
      const current = new Map<Element, string>();
      for (const [key, cell] of targets) {
        const element = document.querySelector(`[data-find-cell="${cell}"]`);
        if (element) current.set(element, key);
      }
      for (const element of observed.keys()) {
        if (!current.has(element)) { observer.unobserve(element); observed.delete(element); }
      }
      const added: string[] = [];
      for (const [element, key] of current) {
        if (observed.has(element)) continue;
        observed.set(element, key);
        added.push(key);
        observer.observe(element);
      }
      setVisibleKeys((prev) => {
        const mounted = new Set(current.values());
        const next = new Set([...prev].filter((key) => mounted.has(key)));
        // Avoid a flash while the first intersection measurement is pending.
        for (const key of added) next.add(key);
        return next.size === prev.size && [...next].every((key) => prev.has(key)) ? prev : next;
      });
    };
    reconcile();
    // Mode/chapter changes may replace editor nodes without changing drafts.
    // Ignore text mutations from ordinary typing.
    const domObserver = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes]
        .some((node) => node instanceof Element &&
          (node.matches("[data-find-cell]") || node.querySelector("[data-find-cell]"))))) reconcile();
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); domObserver.disconnect(); };
  }, [visibilityTargets]);

  const offscreenDrafts = useMemo(() => {
    return draftList.filter(
      (d) =>
        d.meta.kind === "verse" &&
        d.meta.book === book &&
        !verseDraftHasActiveSave(d, ops) &&
        !visibleKeys.has(d.key) &&
        !dismissed.has(d.key),
    );
  }, [draftList, ops, visibleKeys, dismissed, book]);

  if (offscreenDrafts.length === 0) return null;

  // Aggregated chip — single toast that expands the list on click.
  if (offscreenDrafts.length > AGGREGATE_THRESHOLD && !expanded) {
    return (
      <Box
        sx={{
          position: "fixed",
          left: 12,
          bottom: 12,
          zIndex: (t) => t.zIndex.snackbar,
          maxWidth: 360,
        }}
      >
        <Alert
          severity="warning"
          variant="filled"
          sx={{ boxShadow: 3, alignItems: "center" }}
          action={
            <Button color="inherit" size="small" onClick={() => setExpanded(true)}>
              Review
            </Button>
          }
        >
          {offscreenDrafts.length} unsaved edits off-screen
        </Alert>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: (t) => t.zIndex.snackbar,
        maxWidth: 360,
        pointerEvents: "none",
      }}
    >
      <Stack spacing={1} sx={{ pointerEvents: "auto" }}>
        {expanded && offscreenDrafts.length > AGGREGATE_THRESHOLD && (
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={() => setExpanded(false)}
            sx={{ alignSelf: "flex-start", bgcolor: "background.paper" }}
          >
            collapse
          </Button>
        )}
        {offscreenDrafts.map((d) => {
          if (d.meta.kind !== "verse") return null;
          const { book, chapter, verse, bibleVersion } = d.meta;
          return (
            <Alert
              key={d.key}
              severity="warning"
              variant="filled"
              sx={{ boxShadow: 3, alignItems: "center" }}
              action={
                <>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => onSaveVerseDraft(book, chapter, verse, bibleVersion)}
                    sx={{ fontWeight: 600 }}
                  >
                    Save
                  </Button>
                  <IconButton
                    size="small"
                    color="inherit"
                    onClick={() =>
                      setDismissed((prev) => {
                        const next = new Set(prev);
                        next.add(d.key);
                        return next;
                      })
                    }
                    aria-label="dismiss"
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </>
              }
            >
              <Typography
                component="span"
                onClick={() => onJumpTo?.(book, chapter, verse, bibleVersion)}
                sx={{
                  cursor: onJumpTo ? "pointer" : "default",
                  fontFamily: "monospace",
                  fontSize: 13,
                }}
              >
                Save {book} {chapter}:{verse} {bibleVersion}?
              </Typography>
            </Alert>
          );
        })}
      </Stack>
    </Box>
  );
}

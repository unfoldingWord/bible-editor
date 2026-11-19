// TopBar "print preview" control. Opens a dialog that typesets the current
// chapter or the whole book for one bible version the way the Door43 preview
// app will show it after the nightly export — continuous paragraphs,
// superscript verse numbers, poetry indents, blank lines before stanzas — so a
// translator can check formatting without waiting a day for DCS. Chapter scope
// renders from data already in hand; book scope fetches every chapter
// client-side (web/src/lib/bookVerses.ts). "Print" / "Open in tab" hand the
// same HTML to a new window (web/src/lib/printPreview.ts).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import PrintIcon from "@mui/icons-material/Print";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import CloseIcon from "@mui/icons-material/Close";
import type { VerseDto } from "../sync/api";
import { fetchBookVerses } from "../lib/bookVerses";
import { PRINT_PREVIEW_CSS, buildPrintPreviewDocument, renderPrintPreviewHtml } from "../lib/printPreview";
import { annotateQuotes, quoteSummaryHtml, type QuoteSummaryContext } from "../lib/quoteMatch";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Props {
  book: string;
  chapter: number;
  enabledVersions: string[];
  // Verses for the current chapter, keyed by version. Sourced from useChapter in
  // Shell so chapter scope needs no fetch.
  chapterVersesFor: (version: string) => VerseDto[];
}

type Scope = "chapter" | "book";

// Original-language source texts are upstream, read-only resources — not
// translation output anyone is formatting here.
const SOURCE_VERSIONS = new Set(["UHB", "UGNT", "T4T"]);

export function PrintPreviewButton({ book, chapter, enabledVersions, chapterVersesFor }: Props) {
  const [open, setOpen] = useState(false);
  const versions = enabledVersions.filter((v) => !SOURCE_VERSIONS.has(v.toUpperCase()));
  return (
    <>
      <Tooltip title="Print preview (how it will look on Door43)">
        <span>
          <IconButton size="small" onClick={() => setOpen(true)} disabled={versions.length === 0} aria-label="print preview">
            <PrintIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {open && (
        <PrintPreviewDialog
          book={book}
          chapter={chapter}
          versions={versions}
          chapterVersesFor={chapterVersesFor}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface DialogProps {
  book: string;
  chapter: number;
  versions: string[];
  chapterVersesFor: (version: string) => VerseDto[];
  onClose: () => void;
}

function PrintPreviewDialog({ book, chapter, versions, chapterVersesFor, onClose }: DialogProps) {
  const [version, setVersion] = useState(versions[0]);
  const [scope, setScope] = useState<Scope>("chapter");
  // Paratext-style "standard" view: tiny grey USFM markers inline.
  const [showMarkers, setShowMarkers] = useState(false);
  // Quote matching: colour every quote mark by nesting level and flag the
  // unbalanced ones (web/src/lib/quoteMatch.ts).
  const [showQuotes, setShowQuotes] = useState(false);
  // Quote-check box expanded or collapsed in the dialog. Applied to the DOM
  // after each render rather than baked into the HTML, so toggling never
  // re-annotates the text and Print / Open in tab always get the box open.
  const [quotesOpen, setQuotesOpen] = useState(true);
  const previewRef = useRef<HTMLDivElement>(null);
  // Whole-book verses, fetched once per book+version while the dialog is open.
  const [bookVerses, setBookVerses] = useState<Record<string, VerseDto[]>>({});
  const bookKey = `${book}:${version}`;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The book fetch's own failure, kept apart from `error` (which the popup
  // message also uses) so the quote summary can say "could not load".
  const [bookFailed, setBookFailed] = useState(false);

  // Chapter scope with Quotes on still needs the earlier chapters: a quote
  // opened in chapter 3 may still be open in chapter 16.
  const needBook = scope === "book" || (showQuotes && chapter > 1);
  useEffect(() => {
    if (!needBook || bookVerses[bookKey]) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBookFailed(false);
    fetchBookVerses(book, version)
      .then((verses) => {
        if (!cancelled) setBookVerses((prev) => ({ ...prev, [bookKey]: verses }));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(`Could not load ${book}: ${e instanceof Error ? e.message : String(e)}`);
        setBookFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      // Leaving book scope mid-fetch must also drop the spinner — nothing else
      // will, since no new effect run follows for chapter scope.
      cancelled = true;
      setLoading(false);
    };
  }, [needBook, scope, version, book, bookKey, bookVerses]);

  const verses = scope === "chapter" ? chapterVersesFor(version) : (bookVerses[bookKey] ?? null);
  const baseHtml = useMemo(
    () => (verses ? renderPrintPreviewHtml({ book, bibleVersion: version, verses }) : null),
    [verses, book, version],
  );
  // Quotes still open when the current chapter starts, from chapters 1..n-1 of
  // the fetched book. The current chapter itself is rendered from the live
  // chapter data, so unsaved-to-book edits there still count.
  const allBookVerses = bookVerses[bookKey];
  const carry = useMemo(() => {
    if (!showQuotes || scope !== "chapter") return null;
    if (chapter <= 1) return { open: [], earlierErrors: 0 };
    if (!allBookVerses) return null;
    const before = allBookVerses.filter((v) => v.chapter < chapter);
    const r = annotateQuotes(renderPrintPreviewHtml({ book, bibleVersion: version, verses: before }));
    return { open: r.openAtEnd, earlierErrors: r.problems.filter((p) => p.severity === "error").length };
  }, [showQuotes, scope, chapter, allBookVerses, book, version]);
  const html = useMemo(() => {
    if (baseHtml === null || !showQuotes) return baseHtml;
    const ctx: QuoteSummaryContext["carry"] =
      scope === "book"
        ? { state: "book" }
        : carry
          ? { state: "ready", earlierErrors: carry.earlierErrors }
          : bookFailed
            ? { state: "failed" }
            : { state: "loading" };
    // Until the earlier chapters arrive, a closer for a quote they opened
    // would read as "closes nothing": show the plain text meanwhile.
    if (ctx.state === "loading") return quoteSummaryHtml(null, { carry: ctx }) + baseHtml;
    const r = annotateQuotes(baseHtml, { carryIn: carry?.open ?? [], atBookEnd: scope === "book" });
    return quoteSummaryHtml(r, { carry: ctx }) + r.html;
  }, [baseHtml, showQuotes, scope, carry, bookFailed]);
  useLayoutEffect(() => {
    const box = previewRef.current?.querySelector<HTMLDetailsElement>("details.qm-summary");
    if (box) box.open = quotesOpen;
  }, [html, quotesOpen]);

  // Clicks inside the preview: a problem link scrolls to its mark and flashes
  // it (its `#id` href would otherwise hit the app's hash router), and the
  // quote-check head toggles the box through state.
  function onPreviewClick(e: MouseEvent<HTMLDivElement>): void {
    const el = e.target as HTMLElement;
    const link = el.closest<HTMLElement>("[data-qm-target]");
    if (link) {
      e.preventDefault();
      const id = link.dataset.qmTarget ?? "";
      const mark = e.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (!mark) return;
      // Scroll the dialog body so the mark lands a third of the way down the
      // part not covered by the sticky quote-check box. (scrollIntoView would
      // centre it under the box.)
      const scroller = e.currentTarget.closest<HTMLElement>(".MuiDialogContent-root");
      const box = e.currentTarget.querySelector<HTMLElement>(".qm-summary");
      if (scroller) {
        const area = scroller.getBoundingClientRect();
        const top = Math.max(area.top, box?.getBoundingClientRect().bottom ?? area.top);
        const delta = mark.getBoundingClientRect().top - (top + (area.bottom - top) / 3);
        scroller.scrollBy({ top: delta, behavior: "smooth" });
      } else {
        mark.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      mark.classList.remove("qm-flash");
      void mark.offsetWidth; // restart the flash animation on a repeat click
      mark.classList.add("qm-flash");
      // Only the latest jump stays highlighted, and only briefly.
      setTimeout(() => mark.classList.remove("qm-flash"), 2000);
      return;
    }
    const summary = el.closest(".qm-summary > summary");
    if (summary) {
      // Toggle through state, not natively: React flushes this click's update
      // before the browser's own toggle would run, so the two would cancel.
      e.preventDefault();
      setQuotesOpen(!(summary.parentElement as HTMLDetailsElement).open);
    }
  }
  const title = scope === "chapter" ? `${book} ${chapter} · ${version}` : `${book} · ${version}`;

  // Hand the rendered page to a new window: the print dialog can't target a
  // scrollable MUI dialog, and a plain tab is also the easiest thing to put
  // side by side with the Door43 preview.
  function openWindow(print: boolean): void {
    if (html === null) return;
    const w = window.open("", "_blank");
    if (!w) {
      setError("The browser blocked the preview window — allow pop-ups for this site and try again.");
      return;
    }
    w.document.open();
    setError(null);
    w.document.write(buildPrintPreviewDocument(title, html, showMarkers));
    w.document.close();
    w.focus();
    // document.write'd pages don't reliably fire `load`; give fonts a beat.
    if (print) setTimeout(() => w.print(), 300);
  }

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { height: "90vh" } }}>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", py: 1.5 }}>
        <span>Print preview</span>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={version}
          onChange={(_e, v: string | null) => {
            if (v) {
              setVersion(v);
              setError(null);
            }
          }}
        >
          {versions.map((v) => (
            <ToggleButton key={v} value={v}>
              {v}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={scope}
          onChange={(_e, s: Scope | null) => {
            if (s) {
              setScope(s);
              setError(null);
            }
          }}
        >
          <ToggleButton value="chapter">Chapter {chapter}</ToggleButton>
          <ToggleButton value="book">Whole book</ToggleButton>
        </ToggleButtonGroup>
        <Tooltip title="Show USFM markers inline (Paratext standard view)">
          <ToggleButton size="small" value="markers" selected={showMarkers} onChange={() => setShowMarkers((m) => !m)}>
            Markers
          </ToggleButton>
        </Tooltip>
        <Tooltip title="Match quote marks: colour each “ ‘ by nesting level and flag unbalanced ones, counting quotes still open from earlier chapters">
          <ToggleButton size="small" value="quotes" selected={showQuotes} onChange={() => setShowQuotes((q) => !q)}>
            Quotes
          </ToggleButton>
        </Tooltip>
        <Stack direction="row" spacing={1} sx={{ ml: "auto", alignItems: "center" }}>
          <Button size="small" startIcon={<OpenInNewIcon />} onClick={() => openWindow(false)} disabled={html === null}>
            Open in tab
          </Button>
          <Button size="small" variant="contained" startIcon={<PrintIcon />} onClick={() => openWindow(true)} disabled={html === null}>
            Print
          </Button>
          <IconButton size="small" onClick={onClose} aria-label="close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      </DialogTitle>
      {/* Preview is always a white page, in both color modes: it shows paper. */}
      <DialogContent dividers sx={{ p: 0, bgcolor: "#e9e9e9" }}>
        <style>{PRINT_PREVIEW_CSS}</style>
        {error && (
          <Alert severity="error" sx={{ m: 2 }}>
            {error}
          </Alert>
        )}
        {loading && (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress size={28} />
          </Box>
        )}
        {html !== null && (
          <Box sx={{ my: 2 }}>
            <div
              className={showMarkers ? "print-preview show-markers" : "print-preview"}
              ref={previewRef}
              onClick={onPreviewClick}
              dangerouslySetInnerHTML={{ __html: `<h2 class="print-preview-title">${escapeHtml(title)}</h2>${html}` }}
            />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

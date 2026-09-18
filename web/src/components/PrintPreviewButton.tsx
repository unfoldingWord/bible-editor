// TopBar "print preview" control. Opens a dialog that typesets the current
// chapter or the whole book for one bible version the way the Door43 preview
// app will show it after the nightly export — continuous paragraphs,
// superscript verse numbers, poetry indents, blank lines before stanzas — so a
// translator can check formatting without waiting a day for DCS. Chapter scope
// renders from data already in hand; book scope fetches every chapter
// client-side (web/src/lib/bookVerses.ts). "Print" / "Open in tab" hand the
// same HTML to a new window (web/src/lib/printPreview.ts).

import { useEffect, useMemo, useState } from "react";
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
const SOURCE_VERSIONS = new Set(["UHB", "UGNT"]);

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
  // Whole-book verses, fetched once per version while the dialog is open.
  const [bookVerses, setBookVerses] = useState<Record<string, VerseDto[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scope !== "book" || bookVerses[version]) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchBookVerses(book, version)
      .then((verses) => {
        if (!cancelled) setBookVerses((prev) => ({ ...prev, [version]: verses }));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`Could not load ${book}: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, version, book, bookVerses]);

  const verses = scope === "chapter" ? chapterVersesFor(version) : (bookVerses[version] ?? null);
  const html = useMemo(
    () => (verses ? renderPrintPreviewHtml({ book, bibleVersion: version, verses }) : null),
    [verses, book, version],
  );
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
    w.document.write(buildPrintPreviewDocument(title, html));
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
            if (v) setVersion(v);
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
            if (s) setScope(s);
          }}
        >
          <ToggleButton value="chapter">Chapter {chapter}</ToggleButton>
          <ToggleButton value="book">Whole book</ToggleButton>
        </ToggleButtonGroup>
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
            <div className="print-preview" dangerouslySetInnerHTML={{ __html: `<h2 class="print-preview-title">${title}</h2>${html}` }} />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

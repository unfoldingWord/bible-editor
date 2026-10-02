// TopBar "download USFM" control. Exports the current chapter or the whole book
// for any enabled bible version, in an aligned (\zaln/\w kept) or plain
// (alignment stripped) variant. Chapter export renders from data already in
// hand; book export fetches every chapter for the chosen version client-side
// (no export API endpoint; see web/src/lib/bookVerses.ts). See
// web/src/lib/exportUsfm.ts for the renderer.

import { useState } from "react";
import {
  Alert,
  CircularProgress,
  Divider,
  IconButton,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import type { VerseDto } from "../sync/api";
import { fetchBookVerses } from "../lib/bookVerses";

interface Props {
  book: string;
  chapter: number;
  enabledVersions: string[];
  // Verses for the current chapter, keyed by version. Sourced from useChapter in
  // Shell so chapter export needs no fetch.
  chapterVersesFor: (version: string) => VerseDto[];
}

type Scope = "chapter" | "book";

// Original-language source texts are not offered for USFM export — they're
// upstream, read-only resources, not translation output the user edits here.
const SOURCE_VERSIONS = new Set(["UHB", "UGNT"]);

function download(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportUsfmButton({ book, chapter, enabledVersions, chapterVersesFor }: Props) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(anchor);

  // Exclude original-language source texts (Hebrew/Greek) from export.
  const exportableVersions = enabledVersions.filter((v) => !SOURCE_VERSIONS.has(v.toUpperCase()));

  const close = () => setAnchor(null);

  async function versesFor(scope: Scope, version: string): Promise<VerseDto[]> {
    if (scope === "chapter") return chapterVersesFor(version);
    return fetchBookVerses(book, version);
  }

  async function handleExport(scope: Scope, version: string, aligned: boolean): Promise<void> {
    close();
    setBusy(true);
    try {
      const [verses, { buildUsfmFromVerses }] = await Promise.all([
        versesFor(scope, version),
        import("../lib/exportUsfm"),
      ]);
      if (verses.length === 0) {
        setError(`No ${version} text to export for ${scope === "chapter" ? `${book} ${chapter}` : book}.`);
        return;
      }
      const usfm = buildUsfmFromVerses(book, version, verses, { aligned });
      const suffix = aligned ? "" : "-unaligned";
      const name =
        scope === "chapter"
          ? `${book}-${version}-${chapter}${suffix}.usfm`
          : `${book}-${version}${suffix}.usfm`;
      download(name, usfm);
    } catch (e) {
      setError(`USFM export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const scopes: Array<{ scope: Scope; label: string }> = [
    { scope: "chapter", label: `Chapter ${chapter}` },
    { scope: "book", label: `Whole book (${book})` },
  ];

  return (
    <>
      <Tooltip title="Download USFM">
        <span>
          <IconButton
            size="small"
            onClick={(e) => setAnchor(e.currentTarget)}
            disabled={busy || exportableVersions.length === 0}
          >
            {busy ? <CircularProgress size={18} /> : <DownloadIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={open} onClose={close}>
        {scopes.flatMap(({ scope, label }, si) => {
          const items = [
            <ListSubheader key={`${scope}-h`} sx={{ lineHeight: "2em", bgcolor: "transparent" }}>
              {label}
            </ListSubheader>,
            ...exportableVersions.flatMap((v) => [
              <MenuItem key={`${scope}-${v}-a`} onClick={() => void handleExport(scope, v, true)}>
                {v} — aligned
              </MenuItem>,
              <MenuItem key={`${scope}-${v}-u`} onClick={() => void handleExport(scope, v, false)}>
                {v} — plain text (no alignment)
              </MenuItem>,
            ]),
          ];
          if (si < scopes.length - 1) items.push(<Divider key={`${scope}-d`} />);
          return items;
        })}
      </Menu>
      <Snackbar
        open={error !== null}
        autoHideDuration={6000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}

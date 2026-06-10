import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Box, Stack, Typography, IconButton, Tooltip } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import type { VerseDto } from "../sync/api";
import { highlightsFor, renderHighlightedHTML, type HighlightKey } from "../lib/highlight";
import { markHighlightSx } from "../lib/highlightStyles";
import { extractTrailingMarkers, splitSectionHeaders, type SectionHeader } from "../lib/usfm";
import { SectionHeaderBand } from "./SectionHeaderBand";
import { drafts, verseKey, draftDirtyBorderSx } from "../sync/drafts";
import { HebrewLine } from "./HebrewLine";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { FindMatch } from "./FindReplaceOverlay";
import { formatVerseLabel, isFirstOfRange, isRangeRow } from "../lib/verseRange";
import {
  matchSourceVerse,
  renderFindMatchesByOffsets,
  type SourceQueryKind,
  type SourceTokenMatch,
} from "../lib/sourceSearch";

interface SearchState {
  re: RegExp | null;
  sourceQuery: SourceQueryKind;
}

interface Props {
  book: string;
  bibleVersion: string;
  // Pre-expanded per-version index: verses[7] returns the 6-9 range row when
  // verse 7 is inside a UST multi-verse block. ScriptureColumn builds this
  // via buildVerseIndex; the wire shape (keyed by verse_start) stays in
  // versesByVersion at the Shell level.
  versesByVerseNum: Record<number, VerseDto>;
  verseNumbers: number[];
  chapter: number;
  activeVerse: number;
  readOnly?: boolean;
  rtl?: boolean;
  activeNoteQuote?: string | null;
  activeNoteOccurrence?: number | null;
  // Active verse's UHB/UGNT verse content — lets ULT/UST columns OL-anchor the
  // note highlight (resolve the OL quote against the source, then map via
  // alignment) instead of guessing from milestone order. Ignored for UHB/UGNT.
  activeSourceContent?: unknown;
  // Increment to request a scroll-to-active even when activeVerse hasn't
  // changed — used by ScriptureColumn's "go to active" button in columns mode.
  scrollNonce?: number;
  // Present only when this column is UHB — caller pre-loads the lexicon
  // and we render each \w with a hover tooltip.
  lexiconMap?: Map<string, LexiconEntry | null>;
  // Compiled find state from the overlay: English regex + classified source-
  // language query. Paints <mark.be-find> on plain_text for English mode,
  // and on token offsets / HebrewLine highlights for source-language mode.
  // Note highlights step aside while a query is active.
  search?: SearchState | null;
  // The single active find match (the one prev/next navigates to). The cell
  // containing it paints with the stronger be-find-active style.
  findActiveMatch?: FindMatch | null;
  onSelectVerse: (v: number) => void;
  onEditVerse: (verseNum: number, plain: string, base: VerseDto) => void;
  // Save every dirty draft in this column (one PATCH per verse). The
  // header button calls this; per-verse undo handles single-verse rollback.
  onSaveColumn: (drafts: Array<{ verseNum: number; plain: string; base: VerseDto }>) => void;
  onOpenAligner: (verseNum: number) => void;
  // Section-band edit/delete for this column's bibleVersion. Shell's
  // saveSectionEdit splices verseObjects and enqueues. Omitted on read-
  // only columns (UHB/UGNT) and locked chapters → band stays read-only.
  onEditSection?: (
    verseNum: number,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
}

// Continuous Word-style editor for one bible_version. Each verse is its
// own contenteditable block so debounced changes can flow to the outbox
// at verse granularity. Active verse gets a halo; clicking a non-active
// verse promotes it to active. Editing happens in plain text — the full
// content_json tree is replaced server-side with a single-text-token
// representation, which DOES invalidate the existing alignment for that
// verse. Phase 3 (alignment editor) restores it.

export function DocColumn({
  book,
  bibleVersion,
  versesByVerseNum,
  verseNumbers,
  chapter,
  activeVerse,
  readOnly,
  rtl,
  activeNoteQuote,
  activeNoteOccurrence,
  activeSourceContent,
  scrollNonce,
  lexiconMap,
  search,
  findActiveMatch,
  onSelectVerse,
  onEditVerse,
  onSaveColumn,
  onOpenAligner,
  onEditSection,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);

  // Track per-verse drafts in this column so the header save button knows
  // what's dirty and how many. Keyed by verseNum so the click handler can
  // produce the {verseNum, plain, base} list onSaveColumn expects.
  const [dirtyVerses, setDirtyVerses] = useState<Map<number, string>>(() => new Map());
  useEffect(() => {
    if (readOnly) {
      setDirtyVerses(new Map());
      return;
    }
    return drafts.subscribe((all) => {
      const next = new Map<number, string>();
      for (const d of all) {
        if (d.meta.kind !== "verse") continue;
        if (
          d.meta.book !== book ||
          d.meta.chapter !== chapter ||
          d.meta.bibleVersion !== bibleVersion
        ) {
          continue;
        }
        const plain = (d.payload as { plainText?: unknown }).plainText;
        if (typeof plain === "string") next.set(d.meta.verse, plain);
      }
      setDirtyVerses(next);
    });
  }, [book, chapter, bibleVersion, readOnly]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeVerse, scrollNonce]);

  const handleSaveColumn = () => {
    const payload: Array<{ verseNum: number; plain: string; base: VerseDto }> = [];
    for (const [verseNum, plain] of dirtyVerses) {
      const base = versesByVerseNum[verseNum];
      if (!base) continue;
      payload.push({ verseNum, plain, base });
    }
    if (payload.length === 0) return;
    onSaveColumn(payload);
  };

  const dirtyCount = dirtyVerses.size;

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: readOnly ? "grey.100" : "background.paper",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          bgcolor: readOnly ? "grey.100" : "primary.50",
          borderBottom: "1px dashed",
          borderColor: "divider",
        }}
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: readOnly ? "text.secondary" : "primary.main",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            flex: 1,
          }}
        >
          {bibleVersion} · {readOnly ? "read-only" : "editing"}
        </Typography>
        {!readOnly && (
          <Tooltip
            title={
              dirtyCount === 0
                ? "no unsaved edits in this column"
                : `save ${dirtyCount} unsaved verse${dirtyCount === 1 ? "" : "s"} in ${bibleVersion}`
            }
          >
            <span>
              <IconButton
                size="small"
                disabled={dirtyCount === 0}
                onClick={handleSaveColumn}
                sx={{
                  p: 0.25,
                  color: dirtyCount > 0 ? "primary.main" : "action.disabled",
                }}
              >
                {dirtyCount > 0 ? (
                  <SaveIcon fontSize="inherit" />
                ) : (
                  <SaveOutlinedIcon fontSize="inherit" />
                )}
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
      <Box
        sx={(theme) => ({
          flex: 1,
          overflowY: "auto",
          px: 1.5,
          py: 1,
          lineHeight: 1.7,
          fontSize: rtl ? 20 : 15,
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          direction: rtl ? "rtl" : "ltr",
          textAlign: rtl ? "right" : "left",
          ...markHighlightSx(theme.palette.mode),
          ...draftDirtyBorderSx(),
        })}
      >
        {verseNumbers.map((v) => {
          const dto = versesByVerseNum[v];
          if (!dto) return null;
          // Multi-verse rows are emitted once at the start of their span;
          // verses inside the range (e.g. 7, 8, 9 of a UST 6-9 block) point
          // at the same DTO via the index but skip rendering here.
          if (!isFirstOfRange(dto, v)) return null;
          // "Active" if the user's navigated verse is inside this DTO's
          // range. For singletons this reduces to v === activeVerse.
          const isActive = activeVerse >= dto.verse && activeVerse <= (dto.verse_end ?? dto.verse);
          const highlights = isActive
            ? highlightsFor(bibleVersion, dto.content, activeNoteQuote, activeNoteOccurrence, activeSourceContent)
            : null;
          // Lift any \s1/\s2/\s3 section headers in this verse's content
          // up into block-level bands above the inline verse span. The
          // remaining body still has them filtered by the renderer.
          const verseObjects = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
          const sections: SectionHeader[] = Array.isArray(verseObjects)
            ? splitSectionHeaders(verseObjects).sections
            : [];
          // Drift trailing \q1/\p etc. from the previous verse into the
          // leading position of THIS verse — usfm-js attaches them to
          // the prior verse (per `\q1 \v N+1`) but visually they introduce
          // this verse. Composed into the rendered content here; storage
          // stays untouched.
          const prevDto = findPreviousVerse(versesByVerseNum, dto.verse);
          const drift = prevDto
            ? extractTrailingMarkers(
                (prevDto.content as { verseObjects?: unknown[] } | null)?.verseObjects,
              )
            : [];
          return (
            <Fragment key={dto.verse}>
              {sections.map((s, i) => (
                <SectionHeaderBand
                  key={`sec-${dto.verse}-${i}`}
                  tag={s.tag}
                  text={s.text}
                  editable={!readOnly && !!onEditSection}
                  onChange={
                    onEditSection
                      ? (next) =>
                          onEditSection(dto.verse, { index: i, tag: next.tag, text: next.text }, dto)
                      : undefined
                  }
                />
              ))}
              <VerseSpan
                book={book}
                chapter={chapter}
                verseNum={dto.verse}
                verseLabel={formatVerseLabel(dto)}
                isRange={isRangeRow(dto)}
                bibleVersion={bibleVersion}
                text={dto.plain_text ?? ""}
                content={dto.content}
                precedingMarkers={drift}
                highlights={highlights}
                isActive={isActive}
                readOnly={!!readOnly}
                rtl={!!rtl}
                lexiconMap={lexiconMap}
                search={search ?? null}
                findActiveMatch={findActiveMatch ?? null}
                spanRef={isActive ? activeRef : null}
                onClick={() => onSelectVerse(dto.verse)}
                onAlign={() => onOpenAligner(dto.verse)}
                onEdit={(plain) => onEditVerse(dto.verse, plain, dto)}
              />
            </Fragment>
          );
        })}
      </Box>
    </Box>
  );
}

// Locate the verse row immediately preceding `verse` in this column's
// versesByVerseNum map. We can't just lookup [verse - 1] because the
// prior row might be a multi-verse range (e.g. 6-9) — we look for the
// row whose [verse, verseEnd] window ends at verse - 1. Returns null
// when there is no prior verse in this chapter (verse 1, or front).
function findPreviousVerse(
  versesByVerseNum: Record<number, VerseDto>,
  verse: number,
): VerseDto | null {
  for (let v = verse - 1; v >= 0; v--) {
    const dto = versesByVerseNum[v];
    if (!dto) continue;
    // The first row whose end-of-range is < verse — that's the predecessor.
    if ((dto.verse_end ?? dto.verse) < verse) return dto;
  }
  return null;
}

function VerseSpan({
  book,
  chapter,
  verseNum,
  verseLabel,
  isRange,
  bibleVersion,
  text,
  content,
  precedingMarkers,
  highlights,
  isActive,
  readOnly,
  rtl,
  lexiconMap,
  search,
  findActiveMatch,
  spanRef,
  onClick,
  onAlign,
  onEdit,
}: {
  book: string;
  chapter: number;
  // Canonical verse_start for this row (used for find-cell keys + alignment).
  verseNum: number;
  // Display label — "6-9" for ranges, "7" for singletons. See formatVerseLabel.
  verseLabel: string;
  // True when verseNum is a range row (verse_end > verse). Used to style the
  // verse marker so users can tell the block spans multiple Bible verses.
  isRange: boolean;
  bibleVersion: string;
  text: string;
  content?: unknown;
  // Trailing markers drifted from the previous verse — composed at the
  // start of the rendered verseObjects so visual paragraph / poetry
  // breaks introduce this verse correctly.
  precedingMarkers?: unknown[];
  highlights?: Set<string> | null;
  isActive: boolean;
  readOnly: boolean;
  rtl: boolean;
  lexiconMap?: Map<string, LexiconEntry | null>;
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  spanRef: React.MutableRefObject<HTMLSpanElement | null> | null;
  onClick: () => void;
  onAlign: () => void;
  onEdit: (plain: string) => void;
}) {
  const isSource = bibleVersion === "UHB" || bibleVersion === "UGNT";
  const activeRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!findActiveMatch) return null;
    if (findActiveMatch.chapter !== chapter) return null;
    if (findActiveMatch.verse !== verseNum) return null;
    if (findActiveMatch.bibleVersion !== bibleVersion) return null;
    return { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex };
  }, [findActiveMatch, chapter, verseNum, bibleVersion]);
  const elRef = useRef<HTMLSpanElement | null>(null);
  const lastTextRef = useRef(text);
  // Resync tracker for the editable span. lastSetRef.current is the most
  // recent string we wrote to .textContent / .innerHTML; the reset effect
  // skips when its target matches, preserving the caret during typing.
  // Hoisted so the draft-hydration path can mark it in lockstep.
  const lastSetRef = useRef<string | null>(null);
  const draftKey = useMemo(
    () => verseKey(book, chapter, verseNum, bibleVersion),
    [book, chapter, verseNum, bibleVersion],
  );
  const [hasDraft, setHasDraft] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (readOnly) {
      setHasDraft(false);
      return;
    }
    return drafts.subscribe((all) => {
      const rec = all.find((d) => d.key === draftKey);
      setHasDraft(!!rec);
      // Hydrate from a PRE-EXISTING draft exactly once, on the first
      // (mount-snapshot) callback — never from a draft the user is creating
      // by typing right now. Writing to the live element mid-input resets the
      // caret, and in Firefox `textContent` set here would clobber the verse
      // the user is editing. Restore-on-mount (reload / chapter nav) is the
      // only legitimate reason to push draft text into the DOM.
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      if (
        rec &&
        typeof (rec.payload as { plainText?: unknown }).plainText === "string" &&
        elRef.current
      ) {
        const plain = (rec.payload as { plainText: string }).plainText;
        if (elRef.current.textContent !== plain) {
          elRef.current.textContent = plain;
          lastSetRef.current = plain;
          lastTextRef.current = plain;
        }
      }
    });
  }, [draftKey, readOnly]);

  // Source-language token hits for this verse (only meaningful for UHB/UGNT
  // in non-english find modes). Drives the offset painter for UGNT and the
  // HebrewLine findHighlights set for UHB.
  const sourceHits = useMemo<SourceTokenMatch[] | null>(() => {
    if (!isSource || !search || search.sourceQuery.kind === "english") return null;
    const vo = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(vo)) return null;
    return matchSourceVerse(vo, search.sourceQuery);
  }, [isSource, search, content]);

  const findHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (!sourceHits || sourceHits.length === 0) return null;
    const set = new Set<HighlightKey>();
    for (const h of sourceHits) set.add(`${h.text}|${h.occurrence}`);
    return set;
  }, [sourceHits]);

  const activeFindKey = useMemo<HighlightKey | null>(() => {
    if (!activeRange || !sourceHits) return null;
    const hit = sourceHits.find((h) => h.start === activeRange.start && h.end === activeRange.end);
    return hit ? `${hit.text}|${hit.occurrence}` : null;
  }, [activeRange, sourceHits]);

  // Find marks override note highlights — same precedence as BookView.
  const findHTML = useMemo(() => {
    if (!text) return null;
    // Source-language query: ULT/UST stay clean; UGNT uses offset painter
    // (UHB renders via HebrewLine and ignores findHTML).
    if (search && search.sourceQuery.kind !== "english") {
      if (!isSource || !sourceHits || sourceHits.length === 0) return null;
      return renderFindMatchesByOffsets(text, sourceHits, activeRange);
    }
    if (!search?.re) return null;
    const out = renderFindMatchesHTML(text, search.re, activeRange);
    return out.includes("be-find") ? out : null;
  }, [search, sourceHits, text, isSource, activeRange]);

  const html = useMemo(() => {
    if (findHTML) return findHTML;
    if (!content) return null;
    const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return null;
    // Compose any drifted-down markers (from the previous verse's
    // trailing `\q1`/`\p` etc.) at the front so the visual break
    // introduces this verse, matching USFM intent.
    const drifted = precedingMarkers && precedingMarkers.length > 0
      ? [...precedingMarkers, ...verseObjects]
      : verseObjects;
    // Render unconditionally so paragraph / poetry markers turn into
    // visual breaks / indents even without an active highlight set.
    return renderHighlightedHTML(drifted, highlights ?? new Set());
  }, [findHTML, content, highlights, precedingMarkers]);

  // Resync the editable span when (a) text changes from outside and the user
  // hasn't been typing since, or (b) highlights change. We let the user type
  // freely between resyncs. On first render `lastSetRef.current` is null —
  // treat that as "always write" so the verse paints at mount time. If a
  // draft exists, leave the user's typing alone — only the save flow ever
  // overwrites the DOM during a draft session.
  useEffect(() => {
    if (!elRef.current) return;
    if (hasDraft) return;
    const dom = elRef.current.textContent;
    if (html !== null) {
      if (html !== lastSetRef.current) {
        elRef.current.innerHTML = html;
        lastSetRef.current = html;
        lastTextRef.current = text;
      }
      return;
    }
    // Plain-text mode.
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      elRef.current.textContent = text;
      lastSetRef.current = text;
    }
    lastTextRef.current = text;
  }, [text, html, hasDraft]);

  const setMarkerRef = (node: HTMLSpanElement | null) => {
    if (spanRef) spanRef.current = node;
  };

  return (
    <>
    <span
      data-find-cell={`${chapter}-${verseNum}-${bibleVersion}`}
      onClick={onClick}
      style={{
        display: "inline",
        borderRadius: 4,
        padding: isActive ? "1px 2px" : 0,
        backgroundColor: isActive ? "rgba(49,173,227,0.14)" : "transparent",
      }}
    >
      <span
        ref={setMarkerRef}
        style={{
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: isRange ? 700 : 600,
          color: isRange ? "#014263" : "#9aa0a6",
          verticalAlign: "1px",
          marginRight: 4,
        }}
      >
        {verseNum === 0 ? "intro" : `${chapter}:${verseLabel}`}
      </span>
      {!readOnly && (
        <Tooltip title={`align verse ${verseNum}`}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onAlign();
            }}
            size="small"
            sx={{ color: "success.main", p: 0.25, verticalAlign: "-3px" }}
          >
            <LinkIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      {!readOnly && hasDraft && (
        <Tooltip title={`undo edits to verse ${verseNum}`}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              // Drop the draft and force the DOM back to server text. Leave
              // the hydration guard set — hydration is a mount-only concern
              // (a fresh mount gets a fresh ref); re-arming it here would let
              // the next keystroke's draft stomp the live DOM again.
              void drafts.clear(draftKey);
              if (elRef.current) {
                elRef.current.textContent = text;
                lastSetRef.current = text;
                lastTextRef.current = text;
              }
            }}
            size="small"
            sx={{ color: "warning.main", p: 0.25, verticalAlign: "-3px" }}
          >
            <UndoIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}{" "}
      {rtl && lexiconMap ? (
        <span
          style={{
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
            fontSize: 20,
            direction: "rtl",
            unicodeBidi: "isolate",
          }}
        >
          <HebrewLine
            verseObjects={(content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            highlights={highlights ?? undefined}
            findHighlights={findHighlights}
            activeFindKey={activeFindKey}
            fallbackText={text}
          />
        </span>
      ) : (
      <span
        ref={(node) => {
          elRef.current = node;
        }}
        data-dirty={hasDraft ? "true" : undefined}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={!rtl}
        dir={rtl ? "rtl" : "ltr"}
        onInput={(e) => {
          if (readOnly) return;
          // textContent, not innerText: in Firefox `innerText` read inside the
          // input handler returns a stale/truncated value (layout not flushed),
          // which then corrupts the stored draft and the verse. textContent is
          // synchronous and reliable in both browsers (matches the rows editor).
          const value = (e.currentTarget as HTMLSpanElement).textContent ?? "";
          onEdit(value);
          lastTextRef.current = value;
          lastSetRef.current = value;
        }}
        style={{
          outline: "none",
          background: "transparent",
        }}
        className="be-verse-span"
      />
      )}
    </span>
    {" "}
    </>
  );
}

function renderFindMatchesHTML(
  plainText: string,
  re: RegExp,
  activeRange?: { start: number; end: number } | null,
): string {
  let html = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const local = new RegExp(re.source, re.flags);
  while ((m = local.exec(plainText)) !== null) {
    const isActive = !!activeRange && m.index === activeRange.start && m.index + m[0].length === activeRange.end;
    const cls = isActive ? "be-find be-find-active" : "be-find";
    html += escapeHtml(plainText.slice(lastIdx, m.index));
    html += `<mark class="${cls}">${escapeHtml(m[0])}</mark>`;
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) local.lastIndex++;
  }
  html += escapeHtml(plainText.slice(lastIdx));
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

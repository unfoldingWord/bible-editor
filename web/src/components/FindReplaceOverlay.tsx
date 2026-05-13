// Find/replace overlay used by ScriptureColumn's book mode. Scope is the
// loaded chapter cache from useBook — chapters that haven't been pulled in
// by IntersectionObserver yet are invisible to the search until they load,
// which we surface in the result count.
//
// The regex builder escapes special characters when not in regex mode so
// "1:1" finds "1:1" literally; in regex mode we trust the user. Invalid
// patterns produce no matches and a red border on the input.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Stack,
  TextField,
  IconButton,
  Tooltip,
  Typography,
  ToggleButton,
  Button,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import type { ChapterState } from "../hooks/useBook";
import type { VerseDto } from "../sync/api";
import { smartReplaceVerse } from "../lib/replace";
import {
  classifySourceQuery,
  describeSourceMode,
  isBareNumberQuery,
  matchSourceVerse,
  type SourceQueryKind,
} from "../lib/sourceSearch";

// UHB / UGNT are upstream source texts — the worker returns 403 on PATCH.
// Filtering replace matches here keeps the outbox from queueing ops that
// will fatally fail.
const READ_ONLY_VERSIONS = new Set(["UHB", "UGNT"]);

export interface FindMatch {
  chapter: number;
  verse: number;
  bibleVersion: string;
  startIndex: number;
  endIndex: number;
  matchText: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Active book code (e.g. "ZEC" / "MAT"). Used to disambiguate bare
  // Strong's queries — "559" in an OT book → H559, in an NT book → G559.
  book: string;
  chapters: Map<number, ChapterState>;
  chapterList: number[];
  onLoadChapter: (ch: number) => void;
  enabledVersions: string[];
  // Replace target: caller persists the rewritten content. The overlay
  // builds the new verseObjects + plain text via smartReplaceVerse so
  // alignment is preserved whenever the find/replace word counts line up.
  onReplaceVerse: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    newContent: unknown,
    newPlainText: string,
    base: VerseDto,
  ) => void;
  // Fires only on user-initiated navigation (find/regex/case change, prev,
  // next, replace-this). Typing in a verse cell while the overlay is open
  // reshapes the match list but should NOT pull the user away — those
  // reshapes only update the internal "X of Y" label.
  onScrollToMatch: (match: FindMatch | null) => void;
  // Lift the query state up so VerseCell can paint inline marks alongside the
  // existing note-quote highlights.
  onQueryChange: (
    query: { find: string; regex: boolean; caseSensitive: boolean; strongs: boolean } | null,
  ) => void;
}

export function FindReplaceOverlay({
  open,
  onClose,
  book,
  chapters,
  chapterList,
  onLoadChapter,
  enabledVersions,
  onReplaceVerse,
  onScrollToMatch,
  onQueryChange,
}: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  // Opt-in: interpret bare-digit queries as Strong's numbers. Off by default
  // because bible text has lots of numbers ("eighth month", "1:1") and the
  // user would expect those to hit. Toggle only appears when relevant.
  const [strongs, setStrongs] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const showStrongsToggle = isBareNumberQuery(find) && !regex;
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  // Set right before any user action that should pull the active match
  // into view (prev/next, replace-this, find query change). The next
  // matches-reshape effect consumes the flag and fires onScrollToMatch.
  // External content edits never set this, so the user isn't yanked away
  // while they're typing.
  const wantsScrollRef = useRef(false);

  // Focus the find input when the overlay opens (Ctrl/Cmd+F flow).
  useEffect(() => {
    if (open) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [open]);

  // Push query down to the caller so verse cells can paint match marks.
  // Any change to the search inputs counts as user navigation — once the
  // new matches settle, scroll to the first hit.
  useEffect(() => {
    if (!open || !find) {
      onQueryChange(null);
      return;
    }
    wantsScrollRef.current = true;
    onQueryChange({ find, regex, caseSensitive, strongs });
  }, [open, find, regex, caseSensitive, strongs, onQueryChange]);

  const compiled = useMemo(() => buildSearchRegex(find, regex, caseSensitive), [find, regex, caseSensitive]);
  const regexInvalid = !!find && compiled.error;
  // In regex mode the user wants a literal JS regex against plain_text — skip
  // source-language classification so a Hebrew query in regex mode goes through
  // the existing path unmodified.
  const sourceQuery = useMemo<SourceQueryKind>(
    () => (regex ? { kind: "english" } : classifySourceQuery(find, book, strongs)),
    [find, regex, book, strongs],
  );

  const matches = useMemo<FindMatch[]>(() => {
    if (!open) return [];
    if (sourceQuery.kind === "english" && !compiled.re) return [];
    return collectMatches(chapters, enabledVersions, compiled.re, sourceQuery);
  }, [open, compiled.re, sourceQuery, chapters, enabledVersions]);

  // Clamp activeIdx whenever the match list reshapes. Only fire
  // onScrollToMatch if a user action flagged that they want the scroll —
  // ambient reshapes (external typing) clamp silently.
  useEffect(() => {
    if (matches.length === 0) {
      setActiveIdx(0);
      if (wantsScrollRef.current) {
        wantsScrollRef.current = false;
        onScrollToMatch(null);
      }
      return;
    }
    const idx = Math.min(activeIdx, matches.length - 1);
    if (idx !== activeIdx) setActiveIdx(idx);
    if (wantsScrollRef.current) {
      wantsScrollRef.current = false;
      onScrollToMatch(matches[idx]);
    }
  }, [matches, activeIdx, onScrollToMatch]);

  const goPrev = () => {
    if (matches.length === 0) return;
    const next = (activeIdx - 1 + matches.length) % matches.length;
    setActiveIdx(next);
    onScrollToMatch(matches[next]);
  };
  const goNext = () => {
    if (matches.length === 0) return;
    const next = (activeIdx + 1) % matches.length;
    setActiveIdx(next);
    onScrollToMatch(matches[next]);
  };

  // Status surfaced after a replace-all so the user sees when alignment
  // milestones were destroyed (no inline indicator otherwise — the verse
  // looks the same except for missing \zaln-s tags). Cleared on the next
  // find-query change.
  const [replaceSummary, setReplaceSummary] = useState<
    | null
    | { versesReplaced: number; alignmentLost: number; readOnlySkipped: number }
  >(null);
  useEffect(() => {
    setReplaceSummary(null);
  }, [find, regex, caseSensitive]);

  const doReplaceMatch = (m: FindMatch) => {
    if (READ_ONLY_VERSIONS.has(m.bibleVersion)) return;
    const state = chapters.get(m.chapter);
    if (!state || state.kind !== "ready") return;
    const verse = state.data.verses[m.bibleVersion]?.[m.verse];
    if (!verse) return;
    if (!compiled.re) return;
    const text = verse.plain_text ?? "";
    const result = smartReplaceVerse(
      verse.content,
      text,
      compiled.re,
      m.startIndex,
      m.endIndex - m.startIndex,
      replace,
    );
    if (result.plainText === text) return;
    if (!result.preservedAlignment) {
      setReplaceSummary({ versesReplaced: 1, alignmentLost: 1, readOnlySkipped: 0 });
    } else {
      setReplaceSummary({ versesReplaced: 1, alignmentLost: 0, readOnlySkipped: 0 });
    }
    // The replace will trigger a matches reshape (the current match is
    // gone); flag the upcoming reshape so we scroll to whatever's next.
    wantsScrollRef.current = true;
    onReplaceVerse(m.chapter, m.verse, m.bibleVersion, result.content, result.plainText, verse);
  };

  const doReplaceAll = () => {
    if (!compiled.re || matches.length === 0) return;
    // Group matches by verse. Re-derive matches in the *current* plain text
    // for each iteration instead of trusting `startIndex` from the original
    // collection — normalize() inside smartReplaceVerse can collapse
    // whitespace and shift the indices of every later match. The original
    // reverse-sort approach was correct only when normalize was a no-op.
    const byVerse = new Map<string, FindMatch[]>();
    let readOnlySkipped = 0;
    for (const m of matches) {
      if (READ_ONLY_VERSIONS.has(m.bibleVersion)) {
        readOnlySkipped += 1;
        continue;
      }
      const key = `${m.chapter}|${m.verse}|${m.bibleVersion}`;
      const list = byVerse.get(key) ?? [];
      list.push(m);
      byVerse.set(key, list);
    }
    let versesReplaced = 0;
    let alignmentLost = 0;
    for (const [key, list] of byVerse) {
      const [chStr, vStr, bv] = key.split("|");
      const ch = parseInt(chStr, 10);
      const v = parseInt(vStr, 10);
      const state = chapters.get(ch);
      if (!state || state.kind !== "ready") continue;
      const verse = state.data.verses[bv]?.[v];
      if (!verse) continue;
      let content: unknown = verse.content;
      let plainText = verse.plain_text ?? "";
      // Replace one occurrence at a time, re-scanning the current plain
      // text. Cap iterations at the original match count so a runaway
      // replace pattern (where the result keeps matching the regex) can't
      // loop forever — same safety the per-verse counter gives us.
      const maxIters = list.length;
      let preservedThisVerse = true;
      for (let i = 0; i < maxIters; i++) {
        const localRe = new RegExp(compiled.re.source, compiled.re.flags);
        const next = localRe.exec(plainText);
        if (!next) break;
        const result = smartReplaceVerse(
          content,
          plainText,
          compiled.re,
          next.index,
          next[0].length,
          replace,
        );
        if (result.plainText === plainText) break;
        if (!result.preservedAlignment) preservedThisVerse = false;
        content = result.content;
        plainText = result.plainText;
      }
      if (plainText === verse.plain_text) continue;
      versesReplaced += 1;
      if (!preservedThisVerse) alignmentLost += 1;
      onReplaceVerse(ch, v, bv, content, plainText, verse);
    }
    setReplaceSummary({ versesReplaced, alignmentLost, readOnlySkipped });
  };

  if (!open) return null;

  const counts = countChapterStates(chapters);

  return (
    <Box
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        bgcolor: "background.paper",
        borderBottom: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
        px: 1.5,
        py: 1,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <TextField
          inputRef={findInputRef}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab" && !e.shiftKey) {
              // Skip the toggles/buttons in between so Tab lands directly
              // on the replace input, matching VS Code's behaviour.
              e.preventDefault();
              replaceInputRef.current?.focus();
              replaceInputRef.current?.select();
            }
          }}
          size="small"
          placeholder="find"
          error={regexInvalid}
          helperText={
            regexInvalid
              ? "invalid regex"
              : sourceQuery.kind !== "english"
                ? describeSourceMode(sourceQuery)
                : undefined
          }
          sx={{ minWidth: 240, "& .MuiFormHelperText-root": { m: 0, lineHeight: 1.2, fontFamily: "monospace", fontSize: 11 } }}
          inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
        />
        <Tooltip title="use the input as a JavaScript regex">
          <ToggleButton
            value="regex"
            size="small"
            selected={regex}
            onChange={() => setRegex((r) => !r)}
            sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
          >
            .*
          </ToggleButton>
        </Tooltip>
        <Tooltip title="case-sensitive">
          <ToggleButton
            value="case"
            size="small"
            selected={caseSensitive}
            onChange={() => setCaseSensitive((c) => !c)}
            sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
          >
            Aa
          </ToggleButton>
        </Tooltip>
        {showStrongsToggle && (
          <Tooltip title="treat this number as a Strong's number — search Hebrew/Greek tokens instead of bible text">
            <ToggleButton
              value="strongs"
              size="small"
              selected={strongs}
              onChange={() => setStrongs((s) => !s)}
              sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
            >
              H#
            </ToggleButton>
          </Tooltip>
        )}
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", minWidth: 72, textAlign: "center", color: "text.secondary" }}
        >
          {matches.length === 0 ? "no results" : `${activeIdx + 1} / ${matches.length}`}
        </Typography>
        <Tooltip title="previous match (Shift+Enter)">
          <span>
            <IconButton size="small" onClick={goPrev} disabled={matches.length === 0}>
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="next match (Enter)">
          <span>
            <IconButton size="small" onClick={goNext} disabled={matches.length === 0}>
              <ArrowDownwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        {chapterList.length > 1 && (
          <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
            scope: {counts.ready}/{chapterList.length} ch loaded
          </Typography>
        )}
        {chapterList.length > 1 && counts.ready < chapterList.length && (
          <Tooltip title="fetch every chapter of this book now so search covers the whole book — only useful once per session">
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                for (const ch of chapterList) {
                  const cur = chapters.get(ch);
                  if (!cur || cur.kind === "unloaded") onLoadChapter(ch);
                }
              }}
              sx={{ textTransform: "none", fontSize: 11 }}
            >
              load full book
            </Button>
          </Tooltip>
        )}
        <Tooltip title="close (Esc)">
          <IconButton size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.75 }}>
        <TextField
          inputRef={replaceInputRef}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              findInputRef.current?.focus();
              findInputRef.current?.select();
            }
          }}
          size="small"
          placeholder="replace"
          sx={{ minWidth: 240 }}
          inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
        />
        <Tooltip title="replace the active match (this verse only, overwrites alignment for it)">
          <span>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                const m = matches[activeIdx];
                if (m) doReplaceMatch(m);
              }}
              disabled={matches.length === 0}
              sx={{ textTransform: "none" }}
            >
              replace
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="replace every match in every loaded chapter (one PATCH per affected verse; alignment is overwritten where it lands)">
          <span>
            <Button
              size="small"
              variant="contained"
              color="warning"
              onClick={doReplaceAll}
              disabled={matches.length === 0}
              sx={{ textTransform: "none" }}
            >
              replace all
            </Button>
          </span>
        </Tooltip>
      </Stack>
      {replaceSummary && (replaceSummary.versesReplaced > 0 || replaceSummary.readOnlySkipped > 0) && (
        <Alert
          severity={replaceSummary.alignmentLost > 0 ? "warning" : "success"}
          sx={{ mt: 0.75, py: 0.25, "& .MuiAlert-message": { py: 0.5, fontSize: 12 } }}
          onClose={() => setReplaceSummary(null)}
        >
          replaced {replaceSummary.versesReplaced} verse
          {replaceSummary.versesReplaced === 1 ? "" : "s"}
          {replaceSummary.alignmentLost > 0 &&
            ` — alignment milestones destroyed in ${replaceSummary.alignmentLost}`}
          {replaceSummary.readOnlySkipped > 0 &&
            ` — ${replaceSummary.readOnlySkipped} match${
              replaceSummary.readOnlySkipped === 1 ? "" : "es"
            } in UHB/UGNT skipped (read-only)`}
        </Alert>
      )}
    </Box>
  );
}

// ---------- helpers ----------

function buildSearchRegex(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): { re: RegExp | null; error: boolean } {
  if (!query) return { re: null, error: false };
  try {
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    return { re: new RegExp(pattern, flags), error: false };
  } catch {
    return { re: null, error: true };
  }
}

function collectMatches(
  chapters: Map<number, ChapterState>,
  enabledVersions: string[],
  re: RegExp | null,
  sourceQuery: SourceQueryKind,
): FindMatch[] {
  const out: FindMatch[] = [];
  const sourceMode = sourceQuery.kind !== "english";
  // In source mode we want to search UHB/UGNT even if the user hasn't
  // ticked them in the version toggles (in stacked mode they aren't toggle-
  // able at all, but the active verse's source row is still shown).
  const versionsToScan = sourceMode
    ? Array.from(new Set([...enabledVersions, "UHB", "UGNT"]))
    : enabledVersions;
  const chList = [...chapters.keys()].sort((a, b) => a - b);
  for (const ch of chList) {
    const state = chapters.get(ch);
    if (!state || state.kind !== "ready") continue;
    for (const bv of versionsToScan) {
      const byVerse = state.data.verses[bv];
      if (!byVerse) continue;
      const isSource = bv === "UHB" || bv === "UGNT";
      // Source-language query: only run on UHB/UGNT, skip ULT/UST entirely.
      // English query: run regex on every version's plain_text as before.
      if (sourceMode && !isSource) continue;
      const verseNums = Object.keys(byVerse).map(Number).sort((a, b) => a - b);
      for (const v of verseNums) {
        const dto = byVerse[v];
        if (sourceMode && isSource) {
          const vo = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
          if (!Array.isArray(vo)) continue;
          for (const m of matchSourceVerse(vo, sourceQuery as Exclude<SourceQueryKind, { kind: "english" }>)) {
            out.push({
              chapter: ch,
              verse: v,
              bibleVersion: bv,
              startIndex: m.start,
              endIndex: m.end,
              matchText: m.text,
            });
          }
          continue;
        }
        if (!re) continue;
        const text = dto.plain_text ?? "";
        if (!text) continue;
        // Use a fresh regex per verse so lastIndex doesn't bleed.
        const localRe = new RegExp(re.source, re.flags);
        let m: RegExpExecArray | null;
        while ((m = localRe.exec(text)) !== null) {
          out.push({
            chapter: ch,
            verse: v,
            bibleVersion: bv,
            startIndex: m.index,
            endIndex: m.index + m[0].length,
            matchText: m[0],
          });
          if (m[0].length === 0) localRe.lastIndex++;
        }
      }
    }
  }
  return out;
}

function countChapterStates(chapters: Map<number, ChapterState>): {
  ready: number;
  total: number;
} {
  let ready = 0;
  for (const s of chapters.values()) if (s.kind === "ready") ready++;
  return { ready, total: chapters.size };
}

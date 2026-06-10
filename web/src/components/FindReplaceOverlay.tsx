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
  Checkbox,
  FormControlLabel,
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
import type { TnRow, VerseDto } from "../sync/api";
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

// A translation-note hit. The TN checkbox folds the note body, support
// reference, and note id into one searchable corpus — each is distinct
// enough that a single query against all three rarely collides.
export interface NoteMatch {
  chapter: number;
  verse: number;
  noteId: string;
  field: "note" | "support_reference" | "id";
  matchText: string;
}

// Unified nav result: scripture (bible) hit or translation-note hit. The
// "X / Y" counter and prev/next walk this combined, chapter/verse-ordered
// list so the two scopes interleave naturally.
type SearchResult =
  | { kind: "bible"; chapter: number; verse: number; match: FindMatch }
  | { kind: "note"; chapter: number; verse: number; match: NoteMatch };

// Which corpora the find box searches. Persisted so the choice sticks across
// sessions. At least one scope is always on (toggling the last one off is a
// no-op) so the box never silently searches nothing.
const SCOPE_KEY = "be:find-scope";
type FindScope = { bible: boolean; tn: boolean };

function loadScope(): FindScope {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<FindScope>;
      const bible = p.bible !== false;
      const tn = !!p.tn;
      return bible || tn ? { bible, tn } : { bible: true, tn: false };
    }
  } catch {
    /* ignore */
  }
  return { bible: true, tn: false };
}

function saveScope(s: FindScope) {
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
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
  // Live accessor for the translation notes in scope — the current chapter in
  // stacked/columns mode, every loaded chapter in book mode. A getter (not a
  // prop array) so the overlay reads fresh notes on each search without
  // forcing the memoized ScriptureColumn to re-render on every note keystroke.
  searchNotes: () => TnRow[];
  // Navigate to + activate a TN match: focus its verse and note so the
  // resource column scrolls it into view.
  onScrollToNoteMatch: (chapter: number, verse: number, noteId: string) => void;
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
  searchNotes,
  onScrollToNoteMatch,
}: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<FindScope>(() => loadScope());
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

  // Flip a scope checkbox. Refuse to turn the last one off (the box would
  // search nothing). Treat a scope change as user navigation so results settle
  // and we scroll to the first hit.
  const updateScope = (next: FindScope) => {
    if (!next.bible && !next.tn) return;
    setScope(next);
    saveScope(next);
    wantsScrollRef.current = true;
  };

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
    // A new query is user navigation regardless of scope — flag the scroll
    // BEFORE the Bible-scope early return so a TN-only search (Bible unchecked,
    // TN checked) still auto-jumps to its first note hit. Only suppress when
    // there's nothing to search.
    if (open && find && (scope.bible || scope.tn)) {
      wantsScrollRef.current = true;
    }
    // Only paint scripture cells when the Bible scope is on — TN-only searches
    // shouldn't light up verse text.
    if (!open || !find || !scope.bible) {
      onQueryChange(null);
      return;
    }
    onQueryChange({ find, regex, caseSensitive, strongs });
  }, [open, find, regex, caseSensitive, strongs, scope.bible, scope.tn, onQueryChange]);

  const compiled = useMemo(() => buildSearchRegex(find, regex, caseSensitive), [find, regex, caseSensitive]);
  const regexInvalid = !!find && compiled.error;
  // In regex mode the user wants a literal JS regex against plain_text — skip
  // source-language classification so a Hebrew query in regex mode goes through
  // the existing path unmodified.
  const sourceQuery = useMemo<SourceQueryKind>(
    () => (regex ? { kind: "english" } : classifySourceQuery(find, book, strongs)),
    [find, regex, book, strongs],
  );

  const bibleMatches = useMemo<FindMatch[]>(() => {
    if (!open || !scope.bible) return [];
    if (sourceQuery.kind === "english" && !compiled.re) return [];
    return collectMatches(chapters, enabledVersions, compiled.re, sourceQuery);
  }, [open, scope.bible, compiled.re, sourceQuery, chapters, enabledVersions]);

  // Note matches re-read live notes via searchNotes() whenever the query
  // changes — `find`/`compiled.re` in the deps are the recompute signal.
  // `chapters` is also a dep: searchNotes() is a stable getter, so without it
  // a note mutation (delete / trash / AI-patch) wouldn't recompute and the
  // result list + "X / Y" count would go stale. Every note edit produces a new
  // ChapterPayload reference (see useChapter applyLocalRow*), so the `chapters`
  // map identity changes and this memo re-reads the fresh notes.
  const noteMatches = useMemo<NoteMatch[]>(() => {
    if (!open || !scope.tn || !find) return [];
    return collectNoteMatches(searchNotes(), compiled.re);
  }, [open, scope.tn, find, compiled.re, searchNotes, chapters]);

  // Merge + order both scopes by chapter then verse, bible before note within
  // the same verse, so prev/next walks the document top-to-bottom.
  const results = useMemo<SearchResult[]>(() => {
    const out: SearchResult[] = [];
    for (const m of bibleMatches)
      out.push({ kind: "bible", chapter: m.chapter, verse: m.verse, match: m });
    for (const m of noteMatches)
      out.push({ kind: "note", chapter: m.chapter, verse: m.verse, match: m });
    out.sort(
      (a, b) =>
        a.chapter - b.chapter ||
        a.verse - b.verse ||
        (a.kind === b.kind ? 0 : a.kind === "bible" ? -1 : 1),
    );
    return out;
  }, [bibleMatches, noteMatches]);

  // Active scripture match (when the current result is a bible hit) — replace
  // acts on this; null while sitting on a note result.
  const activeBibleMatch =
    results[activeIdx]?.kind === "bible"
      ? (results[activeIdx] as Extract<SearchResult, { kind: "bible" }>).match
      : null;

  // Route the active result to the right surface: scripture cells scroll +
  // highlight via onScrollToMatch; notes navigate + activate via
  // onScrollToNoteMatch (and clear any scripture active-mark).
  function navTo(idx: number) {
    const r = results[idx];
    if (!r) {
      onScrollToMatch(null);
      return;
    }
    if (r.kind === "bible") {
      onScrollToMatch(r.match);
    } else {
      onScrollToMatch(null);
      onScrollToNoteMatch(r.match.chapter, r.match.verse, r.match.noteId);
    }
  }

  // Clamp activeIdx whenever the result list reshapes. Only navigate if a user
  // action flagged that they want the scroll — ambient reshapes (external
  // typing) clamp silently.
  useEffect(() => {
    if (results.length === 0) {
      setActiveIdx(0);
      if (wantsScrollRef.current) {
        wantsScrollRef.current = false;
        onScrollToMatch(null);
      }
      return;
    }
    const idx = Math.min(activeIdx, results.length - 1);
    if (idx !== activeIdx) setActiveIdx(idx);
    if (wantsScrollRef.current) {
      wantsScrollRef.current = false;
      navTo(idx);
    }
    // navTo closes over the current results; onScrollToMatch is the stable
    // dep that matters here (mirrors the original effect's dep list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, activeIdx, onScrollToMatch]);

  const goPrev = () => {
    if (results.length === 0) return;
    const next = (activeIdx - 1 + results.length) % results.length;
    setActiveIdx(next);
    navTo(next);
  };
  const goNext = () => {
    if (results.length === 0) return;
    const next = (activeIdx + 1) % results.length;
    setActiveIdx(next);
    navTo(next);
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
    if (!compiled.re || bibleMatches.length === 0) return;
    // Replace only touches scripture (bible) matches — TN notes are never
    // rewritten by find/replace. Group matches by verse. Re-derive matches in
    // the *current* plain text for each iteration instead of trusting
    // `startIndex` from the original collection — normalize() inside
    // smartReplaceVerse can collapse whitespace and shift the indices of every
    // later match. The original reverse-sort approach was correct only when
    // normalize was a no-op.
    const byVerse = new Map<string, FindMatch[]>();
    let readOnlySkipped = 0;
    for (const m of bibleMatches) {
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
      <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap">
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
        <Tooltip title="search scripture text (ULT / UST / UHB / UGNT)">
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={scope.bible}
                onChange={(e) => updateScope({ ...scope, bible: e.target.checked })}
                sx={{ p: 0.25 }}
              />
            }
            label="Bible"
            sx={{ m: 0, "& .MuiFormControlLabel-label": { fontSize: 12 } }}
          />
        </Tooltip>
        <Tooltip title="search translation notes — note text, support reference (SR), and note id">
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={scope.tn}
                onChange={(e) => updateScope({ ...scope, tn: e.target.checked })}
                sx={{ p: 0.25 }}
              />
            }
            label="TN"
            sx={{ m: 0, "& .MuiFormControlLabel-label": { fontSize: 12 } }}
          />
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", minWidth: 72, textAlign: "center", color: "text.secondary" }}
        >
          {results.length === 0 ? "no results" : `${activeIdx + 1} / ${results.length}`}
        </Typography>
        <Tooltip title="previous match (Shift+Enter)">
          <span>
            <IconButton size="small" onClick={goPrev} disabled={results.length === 0}>
              <ArrowUpwardIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="next match (Enter)">
          <span>
            <IconButton size="small" onClick={goNext} disabled={results.length === 0}>
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
        <Tooltip title="replace the active match (scripture only, this verse, overwrites alignment for it)">
          <span>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                if (activeBibleMatch) doReplaceMatch(activeBibleMatch);
              }}
              disabled={!activeBibleMatch}
              sx={{ textTransform: "none" }}
            >
              replace
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="replace every scripture match in every loaded chapter (one PATCH per affected verse; alignment is overwritten where it lands; notes are never rewritten)">
          <span>
            <Button
              size="small"
              variant="contained"
              color="warning"
              onClick={doReplaceAll}
              disabled={bibleMatches.length === 0}
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

// Match a query against translation notes. The TN checkbox searches three
// fields per note — body, support reference, id — and emits at most one result
// per note (the first field that hits) so prev/next jumps note-to-note rather
// than field-to-field. Trashed / deleted notes are skipped: they aren't shown
// in the resource column, so there'd be nothing to scroll to.
function collectNoteMatches(notes: TnRow[], re: RegExp | null): NoteMatch[] {
  if (!re) return [];
  const out: NoteMatch[] = [];
  const fields: NoteMatch["field"][] = ["note", "support_reference", "id"];
  for (const n of notes) {
    if (n.trashed_at != null || n.deleted_at != null) continue;
    for (const field of fields) {
      const value = n[field];
      if (!value) continue;
      // Fresh regex per test so a stateful /g lastIndex doesn't carry over.
      const local = new RegExp(re.source, re.flags);
      if (local.test(value)) {
        out.push({
          chapter: n.chapter,
          verse: n.verse,
          noteId: n.id,
          field,
          matchText: value,
        });
        break;
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

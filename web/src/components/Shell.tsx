import { useCallback, useMemo, useState } from "react";
import { Box, Typography, CircularProgress, Alert } from "@mui/material";
import { useChapter } from "../hooks/useChapter";
import type { UseBookReturn } from "../hooks/useBook";
import { outbox } from "../sync/outbox";
import { api } from "../sync/api";
import type { TnRow, TqRow, TwlRow, VerseDto } from "../sync/api";
import { TimelineRail } from "./TimelineRail";
import { ScriptureColumn, type ScriptureMode } from "./ScriptureColumn";
import { ResourceColumn } from "./ResourceColumn";
import { AlignmentDialog } from "./AlignmentDialog";
import { TopBar } from "./TopBar";

interface AlignerTarget {
  chapter: number;
  verse: number;
  bibleVersion: string;
}

const SCRIPTURE_MODE_KEY = "be:scriptureMode";
const ENABLED_VERSIONS_KEY = "be:enabledVersions";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

interface Props {
  book: string;
  chapter: number;
  initialVerse?: number;
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
  bookHook?: UseBookReturn;
}

export function Shell({ book, chapter, initialVerse = 1, onNavigate, bookHook }: Props) {
  const {
    status,
    data,
    error,
    applyLocalRowPatch,
    applyLocalRowDelete,
    applyLocalRowInsert,
    applyLocalVerse,
    refetch,
  } = useChapter(book, chapter);
  const [activeVerse, setActiveVerse] = useState(initialVerse);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeWordId, setActiveWordId] = useState<string | null>(null);
  const [mode, setMode] = useState<ScriptureMode>(() =>
    loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"),
  );
  const [enabledVersions, setEnabledVersions] = useState<string[]>(() =>
    loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]),
  );
  const [alignerTarget, setAlignerTarget] = useState<AlignerTarget | null>(null);
  // Shared by the scripture + resource columns so a single "go to active"
  // click re-centers both. Bumped via requestScrollToActive (and elsewhere
  // when the active selection changes through other paths).
  const [scrollNonce, setScrollNonce] = useState(0);
  const requestScrollToActive = useCallback(() => setScrollNonce((n) => n + 1), []);

  const tileSet = useMemo(() => {
    if (!data) return [] as Array<{ verse: number; has: boolean; done?: boolean }>;
    const versesWithSomething = new Set<number>();
    Object.values(data.verses).forEach((byVerse) => {
      Object.keys(byVerse).forEach((v) => versesWithSomething.add(parseInt(v, 10)));
    });
    const hasResource = new Set<number>();
    for (const r of [...data.tn, ...data.tq, ...data.twl]) hasResource.add(r.verse);
    const doneMap = new Map<number, boolean>();
    for (const s of data.verseStatuses ?? []) doneMap.set(s.verse, !!s.done);
    const tiles: Array<{ verse: number; has: boolean; done?: boolean }> = [];
    if (hasResource.has(0)) tiles.push({ verse: 0, has: true, done: doneMap.get(0) });
    const verseNums = [...versesWithSomething].filter((v) => v > 0).sort((a, b) => a - b);
    for (const v of verseNums) tiles.push({ verse: v, has: hasResource.has(v), done: doneMap.get(v) });
    return tiles;
  }, [data]);

  const verseNumbers = useMemo(
    () => tileSet.map((t) => t.verse),
    [tileSet],
  );

  const availableVersions = useMemo(
    () => (data ? Object.keys(data.verses) : []),
    [data],
  );

  const visibleVersions = useMemo(
    () => enabledVersions.filter((v) => availableVersions.includes(v)),
    [enabledVersions, availableVersions],
  );

  // When a tn note OR a twl word row is "active", treat its quote as the
  // highlight source. Notes and words are mutually exclusive; clicking one
  // clears the other. Words use `orig_words` (Hebrew source words) which the
  // same matcher handles directly for UHB and via \zaln-s for ULT/UST.
  const { activeQuote, activeOccurrence } = useMemo(() => {
    if (!data) return { activeQuote: null, activeOccurrence: null };
    if (activeNoteId) {
      const r = data.tn.find((r) => r.id === activeNoteId);
      return { activeQuote: r?.quote ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    if (activeWordId) {
      const r = data.twl.find((r) => r.id === activeWordId);
      return { activeQuote: r?.orig_words ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    return { activeQuote: null, activeOccurrence: null };
  }, [activeNoteId, activeWordId, data]);

  if (status === "loading" || status === "idle") {
    return (
      <Box sx={{ p: 4, display: "flex", alignItems: "center", gap: 2 }}>
        <CircularProgress size={20} />
        <Typography variant="body2">loading {book} {chapter}…</Typography>
      </Box>
    );
  }
  if (status === "error" || !data) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">failed to load {book} {chapter}: {error}</Alert>
      </Box>
    );
  }

  const enqueueRow = <T extends TnRow | TqRow | TwlRow>(
    kind: "tn" | "tq" | "twl",
    row: T,
    patch: Partial<T>,
  ) => {
    applyLocalRowPatch(kind, row.id, patch as Partial<TnRow & TqRow & TwlRow>);
    void outbox.enqueueRow(kind, row.id, row.version, patch as Record<string, unknown>);
  };

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <TopBar
        book={book}
        chapter={chapter}
        onNavigate={(b, c) => {
          setActiveVerse(1);
          setActiveNoteId(null);
          setActiveWordId(null);
          onNavigate?.(b, c);
        }}
      />
      <Box sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <TimelineRail
          book={book}
          chapter={chapter}
          tiles={tileSet}
          activeVerse={activeVerse}
          onSelect={setActiveVerse}
          onToggleDone={async (v, done) => {
            await api.setVerseDone(book, chapter, v, done);
            await refetch();
          }}
        />
        <ScriptureColumn
          book={book}
          chapter={chapter}
          versesByVersion={data.verses}
          verseNumbers={verseNumbers}
          activeVerse={activeVerse}
          activeNoteQuote={activeQuote}
          activeNoteOccurrence={activeOccurrence}
          mode={mode}
          enabledVersions={visibleVersions.length > 0 ? visibleVersions : availableVersions.slice(0, 1)}
          availableVersions={availableVersions}
          bookChapterList={
            bookHook && mode === "book"
              ? (bookHook.summary?.chapters ?? []).map((c) => c.chapter)
              : undefined
          }
          bookChapters={bookHook && mode === "book" ? bookHook.chapters : undefined}
          onLoadBookChapter={bookHook ? bookHook.loadChapter : undefined}
          onSelectBookVerse={(ch, v) => {
            // Verse click in book mode navigates via URL so the chapter
            // payload + resources reload through the existing useChapter
            // flow. App.tsx lifts the useBook cache so this round-trip is
            // cheap.
            if (ch !== chapter) {
              onNavigate?.(book, ch, v);
            } else {
              setActiveVerse(v);
            }
          }}
          onEditBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            const newContent = { verseObjects: [{ type: "text", text: plain + " " }] };
            const newDto = {
              ...base,
              chapter: ch,
              verse: verseNum,
              bible_version: bibleVersion,
              plain_text: plain,
              content: newContent,
            } as VerseDto;
            bookHook?.applyLocalVerse(newDto);
            // Dual-apply to useChapter when the edited verse is in the
            // currently-loaded chapter, so the aligner (which pulls from
            // useChapter for sameChapter targets) doesn't see stale data
            // before the outbox round-trips.
            if (ch === chapter) applyLocalVerse(newDto);
            void outbox.enqueueVerse(
              book,
              ch,
              verseNum,
              bibleVersion,
              base.version,
              { content: newContent, plain_text: plain },
            );
          }}
          onOpenBookAligner={(ch, v, bv) =>
            setAlignerTarget({ chapter: ch, verse: v, bibleVersion: bv })
          }
          onReplaceBookVerse={(ch, verseNum, bibleVersion, newContent, newPlainText, base) => {
            // Find/replace ships pre-built content from smartReplaceVerse —
            // alignment is preserved when word counts match, fully
            // re-tokenized otherwise. Dual-apply to useChapter so opening
            // ⌭ right after a replace shows the new content instead of the
            // pre-replace cache.
            const newDto = {
              ...base,
              chapter: ch,
              verse: verseNum,
              bible_version: bibleVersion,
              plain_text: newPlainText,
              content: newContent,
            } as VerseDto;
            bookHook?.applyLocalVerse(newDto);
            if (ch === chapter) applyLocalVerse(newDto);
            void outbox.enqueueVerse(
              book,
              ch,
              verseNum,
              bibleVersion,
              base.version,
              { content: newContent, plain_text: newPlainText },
            );
          }}
          onSelectVerse={setActiveVerse}
          onModeChange={(m) => {
            setMode(m);
            saveToStorage(SCRIPTURE_MODE_KEY, m);
          }}
          onEnabledVersionsChange={(versions) => {
            setEnabledVersions(versions);
            saveToStorage(ENABLED_VERSIONS_KEY, versions);
          }}
          onEditVerse={(verseNum, bibleVersion, plain, base) => {
            // Edits replace the verse content with a single text token. This
            // intentionally invalidates any alignment markers for this verse
            // — re-align via the ⌭ icon (Phase 3).
            const newContent = {
              verseObjects: [{ type: "text", text: plain + " " }],
            };
            void outbox.enqueueVerse(
              book,
              chapter,
              verseNum,
              bibleVersion,
              base.version,
              { content: newContent, plain_text: plain },
            );
          }}
          onOpenAligner={(v, bv) =>
            setAlignerTarget({ chapter, verse: v, bibleVersion: bv })
          }
          scrollNonce={scrollNonce}
          onRequestScrollToActive={requestScrollToActive}
        />
        <ResourceColumn
          activeVerse={activeVerse}
          tn={data.tn}
          tq={data.tq}
          twl={data.twl}
          activeNoteId={activeNoteId}
          activeWordId={activeWordId}
          scrollNonce={scrollNonce}
          onNoteChange={(id, patch) => {
            applyLocalRowPatch("tn", id, patch);
          }}
          onNoteSave={(id, patch) => {
            const row = data.tn.find((r) => r.id === id);
            if (row) enqueueRow("tn", row, patch);
          }}
          onNoteFocus={(row) => {
            setActiveNoteId(row.id);
            setActiveWordId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onWordFocus={(row) => {
            setActiveWordId(row.id);
            setActiveNoteId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteCreate={async () => {
            const list = sortedForVerse(data.tn, activeVerse);
            const sort_order = pickSortOrder(list, null, "after");
            const created = (await api.createRow<TnRow>("tn", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              note: "",
              sort_order,
            }));
            applyLocalRowInsert("tn", created);
            setActiveNoteId(created.id);
            setActiveWordId(null);
          }}
          onNoteInsertAfter={async (refId) => {
            const ref = data.tn.find((r) => r.id === refId);
            if (!ref) return;
            const list = sortedForVerse(data.tn, ref.verse);
            const sort_order = pickSortOrder(list, refId, "after");
            const created = (await api.createRow<TnRow>("tn", {
              book,
              chapter,
              verse: ref.verse,
              ref_raw: ref.ref_raw,
              support_reference: ref.support_reference,
              note: "",
              sort_order,
            }));
            applyLocalRowInsert("tn", created, { afterId: refId });
            setActiveNoteId(created.id);
            setActiveWordId(null);
          }}
          onNoteReorder={(draggedId, refId, position) => {
            const dragged = data.tn.find((r) => r.id === draggedId);
            if (!dragged) return;
            const list = sortedForVerse(data.tn, dragged.verse);
            const sort_order = pickSortOrder(list, refId, position, draggedId);
            applyLocalRowPatch("tn", draggedId, { sort_order });
            void outbox.enqueueRow("tn", draggedId, dragged.version, { sort_order });
          }}
          onWordCreate={async () => {
            const list = sortedForVerse(data.twl, activeVerse);
            const sort_order = pickSortOrder(list, null, "after");
            const created = (await api.createRow<TwlRow>("twl", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              orig_words: "",
              tw_link: "",
              sort_order,
            }));
            applyLocalRowInsert("twl", created);
            setActiveWordId(created.id);
            setActiveNoteId(null);
          }}
          onWordReorder={(draggedId, refId, position) => {
            const dragged = data.twl.find((r) => r.id === draggedId);
            if (!dragged) return;
            const list = sortedForVerse(data.twl, dragged.verse);
            const sort_order = pickSortOrder(list, refId, position, draggedId);
            applyLocalRowPatch("twl", draggedId, { sort_order });
            void outbox.enqueueRow("twl", draggedId, dragged.version, { sort_order });
          }}
          onQuestionCreate={async () => {
            const created = (await api.createRow<TqRow>("tq", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              question: "",
              response: "",
            }));
            applyLocalRowInsert("tq", created);
          }}
          onNoteDelete={(id) => {
            const row = data.tn.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("tn", id);
            if (activeNoteId === id) setActiveNoteId(null);
            void outbox.enqueueDeleteRow("tn", id, row.version);
          }}
          onWordChange={(id, patch) => {
            const row = data.twl.find((r) => r.id === id);
            if (row) enqueueRow("twl", row, patch);
          }}
          onWordDelete={(id) => {
            const row = data.twl.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("twl", id);
            if (activeWordId === id) setActiveWordId(null);
            void outbox.enqueueDeleteRow("twl", id, row.version);
          }}
          onQuestionChange={(id, patch) => {
            const row = data.tq.find((r) => r.id === id);
            if (row) enqueueRow("tq", row, patch);
          }}
          onQuestionDelete={(id) => {
            const row = data.tq.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("tq", id);
            void outbox.enqueueDeleteRow("tq", id, row.version);
          }}
        />
      </Box>
      {alignerTarget && (() => {
        // Aligner data comes from the same chapter's payload — either the
        // active chapter via useChapter (chapter mode) or the loaded book
        // cache (book mode). We prefer useChapter when the target chapter
        // matches, since that data is always fresher.
        const sameChapter = alignerTarget.chapter === chapter;
        const bookData =
          !sameChapter && bookHook
            ? (() => {
                const cs = bookHook.chapters.get(alignerTarget.chapter);
                return cs?.kind === "ready" ? cs.data : null;
              })()
            : null;
        const sourceData = sameChapter ? data : bookData;
        if (!sourceData) {
          // Target chapter isn't loaded — drop silently; the user can click ⌭
          // again once the chapter pulls in. In practice BookView only renders
          // ⌭ for loaded chapters so this branch is defensive.
          return null;
        }
        const sourceLabel = sourceData.verses["UHB"] ? "UHB" : "UGNT";
        const sourceVerse =
          sourceData.verses[sourceLabel]?.[alignerTarget.verse] ?? null;
        const twlForVerse = sourceData.twl.filter((r) => r.verse === alignerTarget.verse);
        return (
          <AlignmentDialog
            open
            book={book}
            chapter={alignerTarget.chapter}
            verseNum={alignerTarget.verse}
            bibleVersion={alignerTarget.bibleVersion}
            verse={sourceData.verses[alignerTarget.bibleVersion]?.[alignerTarget.verse] ?? null}
            contextOther={
              sourceData.verses[alignerTarget.bibleVersion === "ULT" ? "UST" : "ULT"]?.[
                alignerTarget.verse
              ] ?? null
            }
            sourceVerse={sourceVerse}
            sourceLabel={sourceLabel}
            twlForVerse={twlForVerse}
            onClose={() => setAlignerTarget(null)}
            onSave={(content, plain, expectedVersion) => {
              void outbox.enqueueVerse(
                book,
                alignerTarget.chapter,
                alignerTarget.verse,
                alignerTarget.bibleVersion,
                expectedVersion,
                { content, plain_text: plain },
              );
            }}
            onSwitchVersion={(bv) => {
              setAlignerTarget((cur) => (cur ? { ...cur, bibleVersion: bv } : cur));
            }}
          />
        );
      })()}
    </Box>
  );
}

// ---------- sort_order helpers ----------

type Sortable = { id: string; verse: number; sort_order: number | null };

function sortedForVerse<T extends Sortable>(rows: T[], verse: number): T[] {
  return rows
    .filter((r) => r.verse === verse)
    .sort(
      (a, b) =>
        (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
}

// Pick a sort_order so the new/moved row lands at the requested slot. Falls
// back to step-of-100 gaps when neighbors lack a sort_order yet. `excludeId`
// is set when reordering an existing row — we don't want it in the list when
// computing midpoints, otherwise drop-after-self collapses to a no-op midpoint
// inside its own slot.
function pickSortOrder<T extends Sortable>(
  rows: T[],
  refId: string | null,
  position: "before" | "after",
  excludeId?: string,
): number {
  const list = excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
  if (list.length === 0) return 100;
  if (!refId) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const idx = list.findIndex((r) => r.id === refId);
  if (idx < 0) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const target = list[idx];
  const targetSort = target.sort_order ?? (idx + 1) * 100;
  if (position === "before") {
    const prev = list[idx - 1];
    const prevSort = prev?.sort_order ?? targetSort - 200;
    return (prevSort + targetSort) / 2;
  }
  const next = list[idx + 1];
  const nextSort = next?.sort_order ?? targetSort + 200;
  return (targetSort + nextSort) / 2;
}

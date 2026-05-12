import { useMemo, useState } from "react";
import { Box, Typography, CircularProgress, Alert } from "@mui/material";
import { useChapter } from "../hooks/useChapter";
import { outbox } from "../sync/outbox";
import { api } from "../sync/api";
import type { TnRow, TqRow, TwlRow } from "../sync/api";
import { TimelineRail } from "./TimelineRail";
import { ScriptureColumn, type ScriptureMode } from "./ScriptureColumn";
import { ResourceColumn } from "./ResourceColumn";
import { AlignmentDialog } from "./AlignmentDialog";
import { TopBar } from "./TopBar";

interface AlignerTarget {
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
  onNavigate?: (book: string, chapter: number) => void;
}

export function Shell({ book, chapter, initialVerse = 1, onNavigate }: Props) {
  const { status, data, error, applyLocalRowPatch, refetch } = useChapter(book, chapter);
  const [activeVerse, setActiveVerse] = useState(initialVerse);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [mode, setMode] = useState<ScriptureMode>(() =>
    loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"),
  );
  const [enabledVersions, setEnabledVersions] = useState<string[]>(() =>
    loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]),
  );
  const [alignerTarget, setAlignerTarget] = useState<AlignerTarget | null>(null);

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

  // When a note is "active" (focused or clicked), look up its quote +
  // occurrence so the scripture column can highlight aligned target words.
  const activeNote = useMemo(
    () => (activeNoteId && data ? data.tn.find((r) => r.id === activeNoteId) ?? null : null),
    [activeNoteId, data],
  );
  const activeNoteQuote = activeNote?.quote ?? null;
  const activeNoteOccurrence = activeNote?.occurrence ?? null;

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
          activeNoteQuote={activeNoteQuote}
          activeNoteOccurrence={activeNoteOccurrence}
          mode={mode}
          enabledVersions={visibleVersions.length > 0 ? visibleVersions : availableVersions.slice(0, 1)}
          availableVersions={availableVersions}
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
          onOpenAligner={(v, bv) => setAlignerTarget({ verse: v, bibleVersion: bv })}
        />
        <ResourceColumn
          activeVerse={activeVerse}
          tn={data.tn}
          tq={data.tq}
          twl={data.twl}
          activeNoteId={activeNoteId}
          onNoteChange={(id, patch) => {
            const row = data.tn.find((r) => r.id === id);
            if (row) enqueueRow("tn", row, patch);
          }}
          onNoteFocus={(row) => {
            setActiveNoteId(row.id);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteCreate={async () => {
            await api.createRow("tn", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              note: "",
            });
            await refetch();
          }}
          onNoteInsertAfter={async (refId) => {
            const ref = data.tn.find((r) => r.id === refId);
            if (!ref) return;
            await api.createRow("tn", {
              book,
              chapter,
              verse: ref.verse,
              ref_raw: ref.ref_raw,
              support_reference: ref.support_reference,
              note: "",
            });
            await refetch();
          }}
          onWordCreate={async () => {
            await api.createRow("twl", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              orig_words: "",
              tw_link: "",
            });
            await refetch();
          }}
          onQuestionCreate={async () => {
            await api.createRow("tq", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              question: "",
              response: "",
            });
            await refetch();
          }}
          onNoteDelete={(id) => {
            const row = data.tn.find((r) => r.id === id);
            if (row) void outbox.enqueueDeleteRow("tn", id, row.version);
          }}
          onWordChange={(id, patch) => {
            const row = data.twl.find((r) => r.id === id);
            if (row) enqueueRow("twl", row, patch);
          }}
          onWordDelete={(id) => {
            const row = data.twl.find((r) => r.id === id);
            if (row) void outbox.enqueueDeleteRow("twl", id, row.version);
          }}
          onQuestionChange={(id, patch) => {
            const row = data.tq.find((r) => r.id === id);
            if (row) enqueueRow("tq", row, patch);
          }}
          onQuestionDelete={(id) => {
            const row = data.tq.find((r) => r.id === id);
            if (row) void outbox.enqueueDeleteRow("tq", id, row.version);
          }}
        />
      </Box>
      {alignerTarget && (
        <AlignmentDialog
          open
          book={book}
          chapter={chapter}
          verseNum={alignerTarget.verse}
          bibleVersion={alignerTarget.bibleVersion}
          verse={data.verses[alignerTarget.bibleVersion]?.[alignerTarget.verse] ?? null}
          contextOther={
            data.verses[alignerTarget.bibleVersion === "ULT" ? "UST" : "ULT"]?.[
              alignerTarget.verse
            ] ?? null
          }
          onClose={() => setAlignerTarget(null)}
          onSave={(content, plain, expectedVersion) => {
            void outbox.enqueueVerse(
              book,
              chapter,
              alignerTarget.verse,
              alignerTarget.bibleVersion,
              expectedVersion,
              { content, plain_text: plain },
            );
          }}
        />
      )}
    </Box>
  );
}

import { useMemo, useState } from "react";
import { Box, Typography, CircularProgress, Alert } from "@mui/material";
import { useChapter } from "../hooks/useChapter";
import { outbox } from "../sync/outbox";
import type { TnRow, TqRow, TwlRow } from "../sync/api";
import { TimelineRail } from "./TimelineRail";
import { ScriptureColumn, type ScriptureMode } from "./ScriptureColumn";
import { ResourceColumn } from "./ResourceColumn";

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
}

export function Shell({ book, chapter, initialVerse = 1 }: Props) {
  const { status, data, error, applyLocalRowPatch } = useChapter(book, chapter);
  const [activeVerse, setActiveVerse] = useState(initialVerse);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [mode, setMode] = useState<ScriptureMode>(() =>
    loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"),
  );
  const [enabledVersions, setEnabledVersions] = useState<string[]>(() =>
    loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]),
  );

  const tileSet = useMemo(() => {
    if (!data) return [] as Array<{ verse: number; has: boolean }>;
    const versesWithSomething = new Set<number>();
    Object.values(data.verses).forEach((byVerse) => {
      Object.keys(byVerse).forEach((v) => versesWithSomething.add(parseInt(v, 10)));
    });
    const hasResource = new Set<number>();
    for (const r of [...data.tn, ...data.tq, ...data.twl]) hasResource.add(r.verse);
    const tiles: Array<{ verse: number; has: boolean }> = [];
    if (hasResource.has(0)) tiles.push({ verse: 0, has: true });
    const verseNums = [...versesWithSomething].filter((v) => v > 0).sort((a, b) => a - b);
    for (const v of verseNums) tiles.push({ verse: v, has: hasResource.has(v) });
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
      <Box
        sx={{
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 500 }}>
          Bible Editor · {book} {chapter}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <TimelineRail
          book={book}
          chapter={chapter}
          tiles={tileSet}
          activeVerse={activeVerse}
          onSelect={setActiveVerse}
        />
        <ScriptureColumn
          book={book}
          chapter={chapter}
          versesByVersion={data.verses}
          verseNumbers={verseNumbers}
          activeVerse={activeVerse}
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
          onOpenAligner={(_v, _bv) => {
            /* aligner deferred — see docs/plan.md "Phase 3" */
          }}
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
          onNoteFocus={setActiveNoteId}
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
    </Box>
  );
}

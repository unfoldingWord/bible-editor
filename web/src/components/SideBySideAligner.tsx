import {
  forwardRef,
  type Ref,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Typography, IconButton, Dialog, Tooltip, Button, useTheme } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import KeyboardArrowLeftIcon from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import { AlignmentPanel, type AlignmentPanelHandle } from "./AlignmentPanel";
import { UhbStrip } from "./UhbStrip";
import { type HoverHighlight, type HighlightCtx } from "../lib/highlightTypes";
import { LANE_FILL, type TextLaneCheck } from "../lib/laneChecks";
import type { TwlRow, VerseDto } from "../sync/api";
import type { LexiconEntry } from "../hooks/useLexicon";
import { extractEditableText, normalizeEditable } from "../lib/usfm";

// Separate key from the single-panel aligner's `be:alignmentHoverLink`
// (which defaults OFF). The side-by-side popup's whole point is the
// cross-highlight bridge ("hover Hebrew to bridge" in its titlebar), so it
// defaults ON — and a distinct key keeps that intentional default from
// colliding with (or being silently flipped by) the single-panel toggle,
// whose `readFlag` reads the same string with the opposite default.
const LS_HOVERLINK = "be:dualAlignmentHoverLink";
function readHoverLink(): boolean {
  try {
    const raw = localStorage.getItem(LS_HOVERLINK);
    return raw == null ? true : raw === "1";
  } catch {
    return true;
  }
}
function writeHoverLink(v: boolean) {
  try {
    localStorage.setItem(LS_HOVERLINK, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// ─── Resizable strip heights ────────────────────────────────────────────
// The reading (English) and source (Hebrew) strips sit above the aligners as
// fixed-height bands. Long verses used to be clipped by a hard 64px reading cap
// with no way to grow it. Each band now carries an explicit, drag-resizable
// pixel height that scrolls internally and persists per browser. The alignment
// cards below are the flex remainder, so shrinking a band hands that space to
// the cards; the unaligned-words tray keeps its own resize handle inside
// AlignmentPanel.
const LS_READING_HEIGHT = "be:dualReadingHeight";
const LS_SOURCE_HEIGHT = "be:dualSourceHeight";
const DEFAULT_READING_HEIGHT = 64; // matches the old hard cap
const DEFAULT_SOURCE_HEIGHT = 132; // ~3–4 lines of Hebrew at fontSize 22
const MIN_STRIP_HEIGHT = 40;
const MAX_STRIP_HEIGHT = 640;

function clampStripHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_READING_HEIGHT;
  return Math.max(MIN_STRIP_HEIGHT, Math.min(MAX_STRIP_HEIGHT, Math.round(n)));
}
function readStripHeight(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? clampStripHeight(n) : fallback;
  } catch {
    return fallback;
  }
}
function writeStripHeight(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

// A full-width drag bar that sits under a strip and resizes it. Dragging down
// grows the strip above; double-click resets to `defaultHeight`. Mirrors the
// ns-resize handle already used by the unaligned-words tray in AlignmentPanel.
function StripResizeHandle({
  height,
  setHeight,
  defaultHeight,
  label,
}: {
  height: number;
  setHeight: (h: number) => void;
  defaultHeight: number;
  label: string;
}) {
  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const onMove = (ev: MouseEvent) => {
        setHeight(clampStripHeight(startHeight + (ev.clientY - startY)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [height, setHeight],
  );
  return (
    <Box
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title="drag to resize · double-click to reset"
      onMouseDown={startResize}
      onDoubleClick={() => setHeight(defaultHeight)}
      sx={{
        flexShrink: 0,
        height: 8,
        cursor: "ns-resize",
        bgcolor: "background.paper",
        borderBottom: "1px solid",
        borderColor: "divider",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        "&:hover .be-grip": { bgcolor: "primary.main" },
        "& .be-grip": {
          width: 40,
          height: 3,
          borderRadius: 2,
          bgcolor: "divider",
          transition: "background-color 0.12s",
        },
      }}
    >
      <Box className="be-grip" />
    </Box>
  );
}

// One side of the popup: its target verse + the wiring to save it. Mirrors the
// per-version slice of Shell's alignmentTabProps, but two of them. Each slot
// carries its OWN source slice (the verses its target actually covers) — NOT
// the union span — so a single-verse panel never grows placeholder cards for
// Hebrew it can't legitimately align to (saving those would emit zaln
// milestones referencing words outside the verse). The union span exists only
// in the shared strip; `posOffset` translates this panel's positions into it.
export interface PanelSlot {
  bibleVersion: string;
  verse: VerseDto | null;
  sourceVerse: VerseDto | null;
  twlForVerse: TwlRow[];
  posOffset: number;
  // draftGeneration (#508): forwarded verbatim from AlignmentPanel's onSave —
  // see its doc comment and alignmentDrafts.ts.
  onSave: (
    newContent: unknown,
    plainText: string,
    expectedVersion: number,
    draftGeneration?: string,
  ) => void;
  onDirtyChange: (dirty: boolean) => void;
  // Confirm-before-save when this side's edit would unalign a previously aligned
  // word (forwarded to AlignmentPanel; see its onConfirmUnalign prop).
  onConfirmUnalign?: (lostWords: string[], commit: () => void) => void;
  // A ref OBJECT, not the wider Ref (which allows callbacks): this component
  // reads the handle itself — the shared strip asks each panel which Hebrew
  // groups together, and a callback ref exposes nothing to read.
  panelRef: MutableRefObject<AlignmentPanelHandle | null>;
  // Reading-line dirty mirror + imperative save/discard, so the close/verse-nav
  // gate can prompt before silently dropping an unsaved reading-text edit
  // (parallels onDirtyChange/panelRef for the alignment panel below).
  onReadingDirtyChange: (dirty: boolean) => void;
  readingRef: Ref<ReadingLineHandle>;
}

// Imperative surface the gate uses to flush or revert a reading line.
export interface ReadingLineHandle {
  // `afterCommit` mirrors AlignmentPanelHandle.save (#490): a reading-text
  // save is NOT unconditionally synchronous — it can trip the collateral-loss
  // guard (Shell's guardBlocksSave) and defer behind the "Words will be
  // unaligned" confirm. `afterCommit` runs only once the save actually lands
  // (immediately for a plain/no-op save, or after "Save anyway"); it never
  // runs if the user cancels. Callers that close/unmount the reading line
  // after saving MUST pass that as `afterCommit` rather than proceeding
  // right after calling `save`, or a pending confirm's Cancel silently
  // discards the edit (no enqueue, no draft, DOM already gone).
  save: (afterCommit?: () => void) => void;
  discard: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  book: string;
  chapter: number;
  verseNum: number;
  vref: string;
  sourceLabel: string;
  sourceVerse: VerseDto | null;
  twlForVerse: TwlRow[];
  lexiconMap: Map<string, LexiconEntry | null>;
  left: PanelSlot;
  right: PanelSlot;
  // Commit a reading-text edit (smart-edit + enqueue). Fired only by the
  // explicit Save button — the reading line no longer autosaves on blur.
  // Keyed by bibleVersion so the same callback serves both sides. `afterCommit`
  // (present when the gate/ReadingLineHandle.save passed one through) must be
  // invoked once the enqueue actually happens — synchronously for a plain
  // save, or from the collateral-loss confirm's "Save anyway" — and never on
  // Cancel (#490).
  onSaveReading: (
    bibleVersion: string,
    plain: string,
    base: VerseDto,
    afterCommit?: () => void,
  ) => void;
  // Verse nav (titlebar arrows). Undefined at the chapter's ends.
  onPrevVerse?: () => void;
  onNextVerse?: () => void;
  // Text-lane checkoff for the current verse — same control as the rail /
  // column verse markers, so translators can stamp "done" without leaving
  // the dual aligner (check sits next to the verse chip + next-arrow).
  textCheck?: TextLaneCheck;
}

// Text-lane checkoff for the dual-aligner titlebar — same 18×18 cell as the
// timeline rail (role=checkbox, Cultivate-teal fill), adapted for the dark bar.
function DualTextCheck({
  verseNum,
  textCheck,
}: {
  verseNum: number;
  textCheck: TextLaneCheck;
}) {
  const shade = textCheck.shade(verseNum);
  const filled = shade !== "open";
  const fill = filled ? LANE_FILL[shade] : null;
  const disabled = !textCheck.canCheck;
  const title = `Text — ${textCheck.attribution(verseNum)}`;
  const box = (
    <Box
      role="checkbox"
      aria-checked={filled}
      aria-disabled={disabled || undefined}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        textCheck.onToggle(verseNum);
      }}
      sx={{
        width: 18,
        height: 18,
        ml: 0.5,
        borderRadius: "4px",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: fill ? fill.bg : "transparent",
        color: fill ? fill.fg : "transparent",
        border: fill ? "none" : "1.5px solid",
        borderColor: fill ? "transparent" : "rgba(255,255,255,0.55)",
        opacity: disabled ? 0.5 : 1,
        transition: "background-color 120ms",
        "&:hover": disabled ? {} : { borderColor: fill ? "transparent" : "rgba(255,255,255,0.9)" },
      }}
    >
      {filled && <CheckIcon sx={{ fontSize: 13 }} />}
    </Box>
  );
  if (disabled) {
    return (
      <Tooltip title="Book is locked — checkoff is disabled" placement="bottom">
        {box}
      </Tooltip>
    );
  }
  // Unchecked: short discoverability tip (this surface is new). Checked: same
  // slow attribution tooltip as the rail.
  if (!filled) {
    return (
      <Tooltip title="Mark text done" placement="bottom">
        {box}
      </Tooltip>
    );
  }
  return (
    <Tooltip
      title={title}
      placement="bottom"
      enterDelay={1200}
      enterNextDelay={1200}
      leaveDelay={0}
      TransitionProps={{ timeout: { appear: 0, enter: 150, exit: 0 } }}
    >
      {box}
    </Tooltip>
  );
}

// Full-width popup hosting two AlignmentPanels (e.g. ULT + UST) that align to
// the SAME source (UHB/UGNT). It owns the lifted hover + hover-link state so the
// two panels cross-highlight the same Hebrew, and renders one shared source
// strip and a small editable reading strip above them.
export function SideBySideAligner({
  open,
  onClose,
  book,
  chapter,
  verseNum,
  vref,
  sourceLabel,
  sourceVerse,
  twlForVerse,
  lexiconMap,
  left,
  right,
  onSaveReading,
  onPrevVerse,
  onNextVerse,
  textCheck,
}: Props) {
  const [hover, setHover] = useState<HoverHighlight>(null);
  const [hoverLink, setHoverLink] = useState<boolean>(readHoverLink);
  // Hebrew lexicon tooltip on hover — default on; turn off to see only what's
  // aligned (the highlight bridge) without the popup covering the panels.
  const [lexInfo, setLexInfo] = useState(false);
  // Per-side panel dirty state, mirrored locally so we can lock that side's
  // reading line while alignment drags are pending. A ReadingLine blur saves
  // text → upstream swaps the verse prop → AlignmentPanel's reset effect
  // recomputes its baseline and silently drops the unsaved drags AND clears
  // `dirty` (so the close gate sees nothing to save). Disabling the reading
  // line while the panel is dirty makes a pending alignment save un-pre-emptable
  // by a same-side text edit. (Still forwards the upstream onDirtyChange.)
  const [leftDirty, setLeftDirty] = useState(false);
  const [rightDirty, setRightDirty] = useState(false);
  // Drag-resizable heights for the reading (English) and source (Hebrew) bands,
  // persisted per browser. See StripResizeHandle / clampStripHeight above.
  const [readingHeight, setReadingHeight] = useState(() =>
    readStripHeight(LS_READING_HEIGHT, DEFAULT_READING_HEIGHT),
  );
  const [sourceHeight, setSourceHeight] = useState(() =>
    readStripHeight(LS_SOURCE_HEIGHT, DEFAULT_SOURCE_HEIGHT),
  );
  useEffect(() => {
    writeStripHeight(LS_READING_HEIGHT, readingHeight);
  }, [readingHeight]);
  useEffect(() => {
    writeStripHeight(LS_SOURCE_HEIGHT, sourceHeight);
  }, [sourceHeight]);
  // Hover positions are verse-specific — a stale ring would attach to whatever
  // token happens to hold the same position after a verse nav.
  useEffect(() => {
    setHover(null);
  }, [verseNum, chapter]);
  const toggleHoverLink = () =>
    setHoverLink((cur) => {
      const next = !cur;
      writeHoverLink(next);
      if (!next) setHover(null);
      return next;
    });

  // Which Hebrew belongs together, asked of BOTH panels and unioned. The shared
  // strip has no grouping of its own, and the two panels' groupings can differ
  // for the same Hebrew (ULT may split what UST fuses), so "the group" is
  // ambiguous there — we light the union, which is the only answer consistent
  // with the cards, since on a Hebrew hover each panel already lights its own
  // group's siblings. Read from the refs at hover time (an event, not render),
  // so no panel grouping has to be mirrored into parent state.
  const groupPositionsFor = useCallback(
    (unionPos: number): number[] => {
      const out = new Set<number>([unionPos]);
      // Optional-CALL, not just optional ref: a stale bundle mid-HMR can leave a
      // mounted panel whose handle predates this method, and this runs inside a
      // mouse handler where a TypeError would kill hovering outright.
      for (const p of left.panelRef.current?.sourceGroupPositions?.(unionPos) ?? []) out.add(p);
      for (const p of right.panelRef.current?.sourceGroupPositions?.(unionPos) ?? []) out.add(p);
      return [...out];
    },
    [left.panelRef, right.panelRef],
  );

  const renderPanel = (slot: PanelSlot, setLocalDirty: (dirty: boolean) => void) => (
    <AlignmentPanel
      // Remount on verse change so the panel's internal state is seeded fresh
      // (useState(computedInitial)) instead of carrying the previous verse's
      // alignment across a dualNavTo until the passive reset effect runs — the
      // same stale-state race the single-panel aligner had. bibleVersion is
      // fixed per side (ULT left / UST right), so verseNum alone keys it.
      key={`${slot.bibleVersion}:${verseNum}`}
      ref={slot.panelRef}
      book={book}
      chapter={chapter}
      verseNum={verseNum}
      bibleVersion={slot.bibleVersion}
      verse={slot.verse}
      sourceVerse={slot.sourceVerse}
      sourceLabel={sourceLabel}
      twlForVerse={slot.twlForVerse}
      onSave={slot.onSave}
      onConfirmUnalign={slot.onConfirmUnalign}
      onCancel={onClose}
      hideCancel
      onDirtyChange={(dirty) => {
        setLocalDirty(dirty);
        slot.onDirtyChange(dirty);
      }}
      hover={hover}
      onHoverChange={setHover}
      hoverLink={hoverLink}
      onToggleHoverLink={toggleHoverLink}
      renderUhbStrip={false}
      showSourceInfo={lexInfo}
      posOffset={slot.posOffset}
    />
  );

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* titlebar */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            px: 2,
            py: 1,
            bgcolor: "primary.dark",
            color: "primary.contrastText",
            flexShrink: 0,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
            <Tooltip title="previous verse">
              <span>
                <IconButton
                  onClick={onPrevVerse}
                  disabled={!onPrevVerse}
                  size="small"
                  sx={{ color: "inherit", "&.Mui-disabled": { color: "rgba(255,255,255,0.3)" } }}
                >
                  <KeyboardArrowLeftIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Box
              sx={{
                fontFamily: "monospace",
                fontWeight: 700,
                fontSize: 12,
                bgcolor: "rgba(255,255,255,0.16)",
                px: 1,
                py: 0.5,
                borderRadius: 1,
                minWidth: 64,
                textAlign: "center",
              }}
            >
              {vref}
            </Box>
            {textCheck && <DualTextCheck verseNum={verseNum} textCheck={textCheck} />}
            <Tooltip title="next verse">
              <span>
                <IconButton
                  onClick={onNextVerse}
                  disabled={!onNextVerse}
                  size="small"
                  sx={{ color: "inherit", "&.Mui-disabled": { color: "rgba(255,255,255,0.3)" } }}
                >
                  <KeyboardArrowRightIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <Typography sx={{ fontWeight: 600, fontSize: 15 }}>Align side by side</Typography>
          <Typography sx={{ fontSize: 12, opacity: 0.82 }}>
            {left.bibleVersion} ↔ {right.bibleVersion} · both aligned to {sourceLabel} · hover Hebrew to bridge
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="show the Hebrew lexicon tooltip on hover — turn off to see only what's aligned, without the popup covering the panels">
            <Box
              component="label"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                fontSize: 12,
                cursor: "pointer",
                userSelect: "none",
                color: "inherit",
                mr: 0.5,
              }}
            >
              <input
                type="checkbox"
                checked={lexInfo}
                onChange={(e) => setLexInfo(e.target.checked)}
                style={{ accentColor: "#fff", cursor: "pointer", margin: 0 }}
              />
              Hebrew info
            </Box>
          </Tooltip>
          <Tooltip title="close">
            <IconButton onClick={onClose} size="small" sx={{ color: "inherit" }}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {/* small editable reading strip */}
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1px",
            bgcolor: "divider",
            borderBottom: "1px solid",
            borderColor: "divider",
            flexShrink: 0,
          }}
        >
          <ReadingLine
            ref={left.readingRef}
            slot={left}
            onSave={onSaveReading}
            onDirtyChange={left.onReadingDirtyChange}
            locked={leftDirty}
            bodyHeight={readingHeight}
          />
          <ReadingLine
            ref={right.readingRef}
            slot={right}
            onSave={onSaveReading}
            onDirtyChange={right.onReadingDirtyChange}
            locked={rightDirty}
            bodyHeight={readingHeight}
          />
        </Box>
        <StripResizeHandle
          height={readingHeight}
          setHeight={setReadingHeight}
          defaultHeight={DEFAULT_READING_HEIGHT}
          label="resize reading text"
        />

        {/* one shared source strip — both sides align to the same Hebrew/Greek */}
        <SharedUhbStrip
          sourceVerse={sourceVerse}
          sourceLabel={sourceLabel}
          lexiconMap={lexiconMap}
          twlForVerse={twlForVerse}
          verseNum={verseNum}
          hover={hover}
          onHover={setHover}
          hoverLink={hoverLink}
          showSourceInfo={lexInfo}
          groupPositionsFor={groupPositionsFor}
          bodyHeight={sourceHeight}
        />
        <StripResizeHandle
          height={sourceHeight}
          setHeight={setSourceHeight}
          defaultHeight={DEFAULT_SOURCE_HEIGHT}
          label="resize Hebrew source"
        />

        {/* the two aligners */}
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              borderRight: "1px solid",
              borderColor: "divider",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {renderPanel(left, setLeftDirty)}
          </Box>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {renderPanel(right, setRightDirty)}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}

// ─── shared UHB strip — builds a minimal HighlightCtx off the lifted hover ──
function SharedUhbStrip({
  sourceVerse,
  sourceLabel,
  lexiconMap,
  twlForVerse,
  verseNum,
  hover,
  onHover,
  hoverLink,
  showSourceInfo,
  groupPositionsFor,
  bodyHeight,
}: {
  sourceVerse: VerseDto | null;
  sourceLabel: string;
  lexiconMap: Map<string, LexiconEntry | null>;
  twlForVerse: TwlRow[];
  verseNum: number;
  bodyHeight: number;
  hover: HoverHighlight;
  onHover: (h: HoverHighlight) => void;
  hoverLink: boolean;
  showSourceInfo: boolean;
  // Union positions of the hovered token's group(s), across BOTH panels. The
  // strip cannot compute this (no grouping of its own) — see the parent.
  groupPositionsFor: (unionPos: number) => number[];
}) {
  const themeMode = useTheme().palette.mode;
  const [hidden, setHidden] = useState(false);
  // The strip renders the UNION span, so its walk positions ARE the
  // union-relative hover identity. It has no grouping of its own — hovering a
  // token seeds the lifted hover, which each panel resolves to its own groups.
  // It lights: exact (its own token hovered anywhere) and linked (a panel's
  // English hovered → that group's Hebrew positions ring here too; a strip
  // Hebrew hovered → its group's Hebrew siblings, unioned across both panels).
  //
  // Resolution here is POSITION-ONLY. That is deliberate, and adding a
  // `hover.groupId === myGroupId` term like AlignmentPanel's hebrewHighlight has
  // would accomplish nothing — it would be inert, not merely redundant:
  //   - That term serves the panel's CARD call site, which passes an explicit
  //     groupId override (SourceWordTypography → hebrewHighlight(pos, groupId),
  //     with pos = -1 when the source word didn't resolve) and can therefore
  //     still name its group. UhbStrip never passes an override — it calls
  //     hebrewHighlight(pos) — so the panel's own strip resolves by position
  //     too.
  //   - This strip holds no group ids of its own and seeds the lifted hover with
  //     `groupId: null`, so a strip-side comparison could only ever match
  //     nothing. Group ids are per-parse UUIDs (uid() in alignment.ts) and this
  //     strip is shared by BOTH panels, so they are not a shared identity even
  //     in principle. The union position is the shared identity on purpose —
  //     that is why both hover kinds carry `positions`.
  //
  // The Hebrew-sibling gap this comment used to describe as unfixed IS fixed:
  // the strip now asks each panel for the hovered position's group union
  // (groupPositionsFor → AlignmentPanelHandle.sourceGroupPositions) and seeds
  // the hover's `positions`. That was always the shape a fix had to take —
  // positions, not a group id. The original observation, kept because it is the
  // repro: on ISA 7:8 hovering strip שִשִּים (pos 8) lit its card sibling
  // וְחָמֵש in both panels while strip pos 9 stayed dark. Confirm the
  // grouping before reusing it — a version that split the pair would light
  // neither.
  //
  // One honest limit remains, and it is not an argument for a groupId term: a
  // group whose positions don't resolve stays dark here, and it is not provable
  // that no token OUGHT to light — only that none is IDENTIFIABLE. Each panel
  // resolves against its own slice's source (single-verse for a ULT row) while
  // this strip renders the union span, so a group referencing Hebrew outside its
  // own slice can yield pos = -1 even though the strip does render that token.
  // Worse, -1 is not the only outcome: resolveSourcePos's fallback chain can
  // MIS-resolve such a word onto a same-content/same-Strong token that is inside
  // the slice, lighting the wrong token rather than none. Either way the fix
  // belongs upstream in position resolution / the source span passed in, not in
  // this map. buildAlignerSlice (Shell.tsx) expands a target row to its full UHB
  // range only when the row DECLARES the bridge via verse_end — that is what
  // makes a UST bridge referencing the next verse's Hebrew resolve. A
  // single-verse row whose milestones happen to point at the next verse is not
  // expanded and will still fail. Corollary for anyone auditing this: pairing a
  // bridge row with only its start verse's UHB manufactures unresolved positions
  // that the app itself never sees.
  const hctx: HighlightCtx = useMemo(
    () => ({
      colorize: false,
      hoverLink,
      showSourceInfo,
      matchHues: new Map<string, number>(),
      themeMode,
      onEnglishEnter: () => {},
      onHebrewEnter: (pos: number) => {
        if (!hoverLink) return;
        // Carry the group's union positions (both panels) so the strip can light
        // the hovered token's Hebrew siblings — still positions, not group ids.
        onHover({ kind: "hebrew", pos, groupId: null, positions: groupPositionsFor(pos) });
      },
      onLeave: () => onHover(null),
      englishHighlight: () => null,
      hebrewHighlight: (pos: number) => {
        if (!hoverLink || !hover) return null;
        if (hover.kind === "hebrew" && hover.pos === pos) return "exact";
        // `positions` is absent on a hover seeded by a panel (card/chip), where
        // each panel resolves its own grouping; then only the exact token lights
        // here, as before.
        if (hover.kind === "hebrew") return hover.positions?.includes(pos) ? "linked" : null;
        if (hover.kind === "english" && hover.positions.includes(pos)) return "linked";
        return null;
      },
    }),
    [hoverLink, showSourceInfo, themeMode, hover, onHover, groupPositionsFor],
  );
  return (
    <UhbStrip
      sourceVerse={sourceVerse}
      sourceLabel={sourceLabel}
      lexiconMap={lexiconMap}
      twlForVerse={twlForVerse}
      verseNum={verseNum}
      hidden={hidden}
      onToggleHidden={() => setHidden((h) => !h)}
      hctx={hctx}
      bodyHeight={bodyHeight}
    />
  );
}

// ─── small editable reading line (explicit Save / Undo, no autosave) ────────
// Follows the DocColumn VerseSpan contract: write via textContent (Firefox-safe),
// seed the DOM once, and only resync from a prop change when the user isn't
// mid-edit. Edits live in the DOM until the translator clicks Save (smart-edit
// + enqueue) or Undo (revert to the last-saved text) — nothing autosaves.
const ReadingLine = forwardRef<ReadingLineHandle, {
  slot: PanelSlot;
  onSave: (bibleVersion: string, plain: string, base: VerseDto, afterCommit?: () => void) => void;
  onDirtyChange: (dirty: boolean) => void;
  // Locked while this side's AlignmentPanel has unsaved drags: a text edit
  // here would swap the verse prop and silently wipe those drags (see the
  // dirty-state note in SideBySideAligner). The translator saves/cancels the
  // alignment first, then the line unlocks.
  locked?: boolean;
  // Drag-resizable cap for the editable text box; it scrolls past this height.
  // Shared by both reading lines so the two-column grid stays even.
  bodyHeight?: number;
}>(function ReadingLine(
  { slot, onSave, onDirtyChange, locked = false, bodyHeight = DEFAULT_READING_HEIGHT },
  ref,
) {
  const { bibleVersion, verse } = slot;
  const editable = useMemo(() => (verse ? extractEditableText(verse.content) : ""), [verse]);
  const elRef = useRef<HTMLDivElement | null>(null);
  const lastTextRef = useRef("");
  const lastSetRef = useRef<string | null>(null);
  // Enables Save/Undo only when the DOM text actually differs from the saved
  // baseline — normalized so editor-emitted trailing whitespace doesn't arm the
  // buttons (and matches saveVerseDraft's no-op guard exactly). Mirrored up to
  // the parent so the close/nav gate can prompt before losing the edit.
  const [dirty, setDirty] = useState(false);
  const markDirty = (next: boolean) => {
    setDirty(next);
    onDirtyChange(next);
  };

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // Never resync under the user's caret: onInput updates lastTextRef, so the
    // tracker can't distinguish "user typed" from "still showing what we set" —
    // a refetch echo (e.g. the other panel's save landing) would overwrite
    // mid-edit text and drop the caret to the start. Focus is the mid-edit
    // signal (DocColumn's VerseSpan uses its draft for the same purpose).
    if (document.activeElement === el) return;
    const dom = el.textContent ?? "";
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      // Skip the DOM write when the content already matches — after an edit that
      // round-trips identically, replacing the text node would needlessly
      // repaint (flash) the line and drop the caret.
      if (dom !== editable) el.textContent = editable;
      lastSetRef.current = editable;
    }
    lastTextRef.current = editable;
    // Baseline moved (a Save landed, or a verse nav swapped the verse): the
    // line now matches saved text, so it's no longer dirty.
    markDirty(normalizeEditable(el.textContent ?? "") !== normalizeEditable(editable));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  // `afterCommit` mirrors AlignmentPanelHandle's handleSave (#490): `onSave`
  // (ultimately Shell's saveVerseDraft → enqueueVerseSafely) can defer this
  // save behind the collateral-loss confirm rather than enqueueing
  // synchronously. markDirty(false) — which is what lets a caller believe
  // there's nothing left to lose — must wait for onSave's own afterCommit,
  // not fire unconditionally right after calling it, or a still-open confirm
  // that the user then Cancels loses the edit with no trace (never enqueued,
  // no draft, and by then usually DOM-unmounted too).
  const handleSave = (afterCommit?: () => void) => {
    const el = elRef.current;
    if (!el || !verse) {
      afterCommit?.();
      return;
    }
    onSave(bibleVersion, el.textContent ?? "", verse, () => {
      markDirty(false);
      afterCommit?.();
    });
  };

  const handleUndo = () => {
    const el = elRef.current;
    if (!el) return;
    el.textContent = editable;
    lastTextRef.current = editable;
    lastSetRef.current = editable;
    markDirty(false);
  };

  // The gate (close / verse-nav) drives these: save flushes the edit, discard
  // reverts to the last-saved text — same as the Save / Undo buttons.
  useImperativeHandle(ref, () => ({ save: handleSave, discard: handleUndo }));

  return (
    <Box sx={{ bgcolor: "background.paper", px: 2, pt: 0.75, pb: 1, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5, minHeight: 26 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            fontSize: 9,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "text.secondary",
            fontWeight: 600,
          }}
        >
          {bibleVersion} · reading text{" "}
          <Box
            component="span"
            sx={{
              color: locked ? "text.disabled" : "primary.main",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {locked ? "🔒 save alignment first" : "✎ editable"}
          </Box>
        </Typography>
        <Box sx={{ flex: 1 }} />
        {verse && !locked && (
          <>
            <Button
              size="small"
              onClick={handleUndo}
              disabled={!dirty}
              sx={{
                color: "text.secondary",
                textTransform: "uppercase",
                fontSize: 11,
                letterSpacing: "0.06em",
                fontWeight: 600,
                minWidth: 0,
                py: 0.25,
              }}
            >
              Undo
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => handleSave()}
              disabled={!dirty}
              sx={{
                textTransform: "uppercase",
                fontSize: 11,
                letterSpacing: "0.06em",
                fontWeight: 700,
                px: 1.5,
                py: 0.25,
              }}
            >
              Save {bibleVersion}
            </Button>
          </>
        )}
      </Box>
      {verse ? (
        <Box
          ref={elRef}
          contentEditable={!locked}
          suppressContentEditableWarning
          spellCheck
          title={
            locked
              ? "save or cancel the pending alignment edits before editing the reading text"
              : undefined
          }
          onInput={(e) => {
            const value = (e.currentTarget as HTMLDivElement).textContent ?? "";
            lastTextRef.current = value;
            lastSetRef.current = value;
            markDirty(normalizeEditable(value) !== normalizeEditable(editable));
          }}
          sx={{
            maxHeight: bodyHeight,
            overflowY: "auto",
            fontFamily: '"Times New Roman", "Cardo", serif',
            fontSize: `calc(15px * var(--be-reading-scale, 1))`,
            lineHeight: 1.5,
            color: locked ? "text.disabled" : "text.primary",
            outline: "none",
            borderRadius: 1,
            px: 0.75,
            py: 0.25,
            border: "1px solid",
            borderColor: "divider",
            cursor: locked ? "not-allowed" : "text",
            opacity: locked ? 0.6 : 1,
            transition: "border-color 0.12s, opacity 0.12s",
            ...(locked
              ? {}
              : {
                  "&:hover": { borderColor: "primary.main" },
                  "&:focus": { borderColor: "primary.main", bgcolor: "action.hover" },
                }),
          }}
        />
      ) : (
        <Typography variant="body2" sx={{ color: "text.disabled", fontStyle: "italic", py: 0.5 }}>
          no {bibleVersion} text for this verse
        </Typography>
      )}
    </Box>
  );
});

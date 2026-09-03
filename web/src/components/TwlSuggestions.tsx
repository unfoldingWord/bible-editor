// Per-verse TWL "Suggestions" — links the matcher proposes for the verse(s) on
// screen that aren't already present. Additive by design (Rich's ask): the
// editor picks which to add; nothing is auto-deleted. Each suggestion shows the
// matched ULT English span and the proposed TW article; when a word maps to
// several articles a small dropdown disambiguates. "Add" hands the matched span
// (and the verse it came from) back to the Shell, which resolves it to an OL
// quote + occurrence (twlResolve) and creates the row.
//
// VERSE BRIDGES: the panel takes the full list of verses the display unit spans
// (`verses`), scans each one through the per-verse route, and tags every
// suggestion with the verse it belongs to. So in a bridge (e.g. 15–16) both
// verses' links surface here, each addable to its own verse — the fix for
// "Suggest gave me words that actually belong to the other verse." A singleton
// verse reduces to the old single-group behaviour with no per-verse header.

import { memo, useEffect, useRef, useState } from "react";
import {
  Box,
  Stack,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  Select,
  MenuItem,
  CircularProgress,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import BlockIcon from "@mui/icons-material/Block";
import ReplayIcon from "@mui/icons-material/Replay";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { api, type TwlSuggestion, type TwlVerseSuggestions } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { TwArticleDialog } from "./TwArticleDialog";

// rc://*/tw/dict/bible/names/moab → names/moab; bare id passes through.
function twShort(idOrLink: string): string {
  const m = idOrLink.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : idOrLink;
}

// Short id (kt/call-speakloudly) → full link, for catalog group lookups.
function twLinkOf(id: string): string {
  return id.startsWith("rc://") ? id : `rc://*/tw/dict/bible/${id}`;
}

interface Props {
  book: string;
  chapter: number;
  // The verses the on-screen unit spans — one entry for an ordinary verse, the
  // whole bridge for a verse bridge. Each is scanned independently.
  verses: number[];
  // Changes whenever any shown verse's existing TWL links change, so the list
  // refetches and drops anything just added (the server excludes existing links).
  refreshKey: string;
  onAdd: (suggestion: TwlSuggestion, chosenArticleId: string, verse: number) => void;
  // Drop suggestions already linked on their verse (resolved-OL identity,
  // computed by Shell against the live rows for that verse). Applied after fetch
  // so adds/deletes reflect without a server round-trip.
  isExcluded?: (suggestion: TwlSuggestion, verse: number) => boolean;
  // Report the raw (pre-exclusion) suggestions per verse up so the parent can
  // merge the matcher's candidates onto committed rows. Emits [] on unmount /
  // verse change.
  onSuggestions?: (groups: TwlVerseSuggestions[]) => void;
  // Article ids blocked by the unlinked deny-list for this suggestion's resolved
  // quote on its verse. Blocked ids are pruned from the picker; a suggestion
  // whose every article is blocked is dropped entirely.
  blockedArticleIds?: (suggestion: TwlSuggestion, verse: number, candidateIds?: string[]) => Set<string>;
  // Whether the deny-lists have settled (loaded or failed). The list holds off
  // rendering until then so a blocked suggestion can't show — or be added —
  // before isExcluded / blockedArticleIds have real data. Defaults to true so a
  // caller that doesn't wire filters is unaffected.
  filtersReady?: boolean;
  // When the Words lane is checked for the active verse, new suggestions are
  // paused (the editor has signed off on the words here). The list collapses to
  // a one-line "paused" strip; "reopen" peeks it without un-checking the lane.
  paused?: boolean;
}

function TwlSuggestionsInner({ book, chapter, verses, refreshKey, onAdd, isExcluded, onSuggestions, blockedArticleIds, filtersReady = true, paused = false }: Props) {
  // Stable, ascending, 0-free verse list + a location key derived from it, so a
  // reordered/duplicated `verses` prop doesn't churn the fetch. Recomputed each
  // render (cheap; usually 1–2 entries).
  const scanVerses = [...new Set(verses)].filter((v) => v > 0).sort((a, b) => a - b);
  const versesKey = scanVerses.join(",");

  const [peeked, setPeeked] = useState(false);
  // Re-collapse when the shown verses change or the lane is re-checked.
  useEffect(() => {
    setPeeked(false);
  }, [book, chapter, versesKey, paused]);
  // Raw suggestions grouped by verse, in `scanVerses` order.
  const [groups, setGroups] = useState<TwlVerseSuggestions[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Per-suggestion chosen article for disambiguation (keyed by verse+span+occ).
  const [chosen, setChosen] = useState<Record<string, string>>({});
  // Proofreader-rejected suggestions (keyed by verse+span+occ): crossed off in
  // place so reviewers can mark a verse as worked through. Local/session-only and
  // reversible — nothing is persisted or sent to the server.
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
  const [reloadNonce, setReloadNonce] = useState(0);
  // TW article shown in the in-app popup (null = closed).
  const [articleId, setArticleId] = useState<string | null>(null);
  const catalogs = useCatalogs();

  // The full sibling family for an article (kt/call-* ), as short ids — the same
  // global groups the committed-row badge uses. The matcher's per-match
  // disambiguation can collapse to one article when a specific phrase matched
  // ("Call out" → only kt/call-speakloudly); we still offer the family so the
  // editor can switch, consistent with the badge. Returns [] when not grouped.
  const familyOf = (id: string): string[] => {
    const idx = catalogs.disambiguationIndex?.[twLinkOf(id)];
    if (idx == null) return [];
    const group = catalogs.disambiguationGroups?.[idx];
    return group ? group.map((o) => twShort(o.link)) : [];
  };

  // Tracks the location the current `groups` belong to. A same-location refetch
  // (add/delete a link → refreshKey ticks) keeps the old list visible while the
  // new one loads — isExcluded already drops the just-added row, so the list
  // shrinks smoothly instead of collapsing and re-expanding. Only an actual
  // navigation blanks first, so we never flash the previous unit's suggestions.
  const locRef = useRef(`${book}|${chapter}|${versesKey}`);

  useEffect(() => {
    // Derive the verse list from the stable key so the effect depends only on
    // primitives (no array-identity churn, no exhaustive-deps escape hatch).
    const vs = versesKey ? versesKey.split(",").map(Number) : [];
    // Skip the scan entirely while paused (and not peeking), or when there is
    // nothing real to scan — the whole point of the pause is to stop proposing
    // once the editor has signed off on words here.
    if (vs.length === 0 || (paused && !peeked)) {
      setGroups([]);
      return;
    }
    const loc = `${book}|${chapter}|${versesKey}`;
    if (locRef.current !== loc) {
      locRef.current = loc;
      setGroups([]);
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    // One request per verse; combine into per-verse groups in verse order. A
    // single AbortController cancels the whole batch on unmount / verse change.
    Promise.all(
      vs.map((v) =>
        api
          .getTwlSuggestions(book, chapter, v, ctrl.signal)
          .then((r) => ({ verse: v, suggestions: r.suggestions })),
      ),
    )
      .then((next) => {
        if (ctrl.signal.aborted) return;
        setGroups(next);
        setChosen({});
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        // AbortError on unmount/verse-change is normal; only surface real failures.
        if (e?.name !== "AbortError") setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [book, chapter, versesKey, refreshKey, reloadNonce, paused, peeked]);

  // Clear rejections only when the shown verses themselves change — NOT on
  // refreshKey (which ticks whenever a link is added/deleted). Otherwise a normal
  // "reject A, add B" flow would refetch and un-reject A.
  useEffect(() => {
    setRejected({});
  }, [book, chapter, versesKey]);

  // Report the raw groups up (for committed-row alternative merging) whenever
  // they change, and clear on unmount so a stale list can't linger after the
  // panel hides (e.g. switching to the pinned multi-verse view).
  useEffect(() => {
    onSuggestions?.(groups);
  }, [groups, onSuggestions]);
  useEffect(() => () => onSuggestions?.([]), [onSuggestions]);

  const keyOf = (verse: number, s: TwlSuggestion) => `${verse}|${s.matchedText}|${s.glOccurrence}`;

  // Filter on each render — isExcluded / blockedArticleIds close over the live
  // verse rows + deny-lists, so adding/deleting a link or loading filters
  // updates the list immediately. Two passes per verse: drop already-linked
  // suggestions (isExcluded) and deleted-here ones, then prune unlinked-blocked
  // articles from each survivor's picker, dropping any whose every article is
  // blocked.
  const visibleGroups = groups.map(({ verse, suggestions }) => ({
    verse,
    items: suggestions
      .filter((s) => !(isExcluded?.(s, verse) ?? false))
      .map((s) => {
        // Union the per-match disambiguation with the article's global family so
        // a confidently-resolved single match still exposes its siblings.
        const family = familyOf(s.articleId);
        const merged = family.length
          ? [...s.disambiguation, ...family.filter((id) => !s.disambiguation.includes(id))]
          : s.disambiguation;
        // Block over the merged candidate set, so a family sibling on the
        // unlinked deny-list is pruned just like a server-disambiguation one.
        const blocked = blockedArticleIds?.(s, verse, merged);
        const allowed = blocked && blocked.size > 0 ? merged.filter((id) => !blocked.has(id)) : merged;
        return { s, allowed };
      })
      .filter(({ allowed }) => allowed.length > 0),
  }));
  const totalVisible = visibleGroups.reduce((n, g) => n + g.items.length, 0);
  const totalRaw = groups.reduce((n, g) => n + g.suggestions.length, 0);
  const multiVerse = scanVerses.length > 1;

  // Blank the body when EITHER:
  //  - the deny-list filters haven't settled — we can't tell which suggestions
  //    are blocked yet, so rendering would flash addable links the deny-list is
  //    about to remove (and let them be clicked before it arrives); or
  //  - it's a first load with nothing to show yet.
  // A same-location refetch (loading, filters already settled, list non-empty —
  // e.g. adding a link ticks refreshKey) keeps the current list rendered, so it
  // shrinks by one row in place instead of collapsing and re-expanding the box.
  // Crucially this only holds the list visible when the blank reason is
  // `loading`, never when it's `!filtersReady`.
  const showBlank = !filtersReady || (loading && totalRaw === 0);

  if (paused && !peeked) {
    return (
      <Box sx={{ mt: 1.5 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ px: 1, py: 0.75, border: "1px dashed", borderColor: "divider", borderRadius: 1 }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 16, color: "primary.main" }} />
          <Typography variant="caption" sx={{ flex: 1, color: "text.secondary" }}>
            Suggestions paused — Words checked here
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "primary.main", cursor: "pointer", whiteSpace: "nowrap" }}
            onClick={() => setPeeked(true)}
          >
            reopen
          </Typography>
        </Stack>
      </Box>
    );
  }

  // One suggestion row. Shared by the flat (single-verse) and grouped
  // (bridge) renders; `verse` is the verse the suggestion was scanned from.
  const renderSuggestion = (verse: number, s: TwlSuggestion, allowed: string[]) => {
    const k = keyOf(verse, s);
    // Keep `selected` within the allowed set: honor the user's pick if still
    // allowed, else the primary if allowed, else the first survivor.
    const selected =
      chosen[k] && allowed.includes(chosen[k])
        ? chosen[k]
        : allowed.includes(s.articleId)
          ? s.articleId
          : allowed[0];
    const ambiguous = allowed.length > 1;
    const isRejected = !!rejected[k];
    return (
      <Box
        key={k}
        sx={{
          display: "grid",
          gridTemplateColumns: "1fr auto 28px 28px 28px",
          alignItems: "center",
          gap: 0.5,
          px: 1,
          py: 0.5,
          border: "1px dashed",
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: isRejected ? "action.disabledBackground" : "primary.50",
          opacity: isRejected ? 0.55 : 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            sx={{
              fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
              fontSize: 14,
              lineHeight: 1.2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textDecoration: isRejected ? "line-through" : "none",
            }}
          >
            {s.matchedText}
            {s.glOccurrence > 1 && (
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                ·{s.glOccurrence}
              </Typography>
            )}
          </Typography>
        </Box>
        {ambiguous ? (
          <Select
            value={selected}
            onChange={(e) => setChosen((m) => ({ ...m, [k]: e.target.value }))}
            size="small"
            variant="standard"
            sx={{ fontSize: 11, maxWidth: 150, "& .MuiSelect-select": { py: 0.25 } }}
          >
            {allowed.map((id) => (
              <MenuItem key={id} value={id} sx={{ fontSize: 11 }}>
                {twShort(id)}
              </MenuItem>
            ))}
          </Select>
        ) : (
          <Chip label={twShort(selected)} size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} />
        )}
        <Tooltip title="add this link">
          <span>
            <IconButton
              size="small"
              color="success"
              disabled={isRejected}
              onClick={() => onAdd(s, selected, verse)}
              sx={{ p: 0.25 }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={isRejected ? "undo rejection" : "reject suggestion"}>
          <IconButton
            size="small"
            color={isRejected ? "default" : "error"}
            onClick={() => setRejected((m) => ({ ...m, [k]: !m[k] }))}
            sx={{ p: 0.25 }}
          >
            {isRejected ? <ReplayIcon fontSize="small" /> : <BlockIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <Tooltip title="read article">
          <IconButton
            size="small"
            onClick={() => setArticleId(selected)}
            sx={{ p: 0.25, color: "text.secondary" }}
          >
            <OpenInNewIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
    );
  };

  return (
    <Box sx={{ mt: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.5, pl: 0.5 }}>
        <AutoAwesomeIcon fontSize="inherit" sx={{ fontSize: 14, color: "primary.main" }} />
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "text.secondary" }}
        >
          Suggestions
        </Typography>
        <Chip
          label={showBlank ? "…" : totalVisible}
          size="small"
          variant="outlined"
          sx={{ height: 16, fontFamily: "monospace", fontSize: 10 }}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title={multiVerse ? "re-scan these verses" : "re-scan this verse"}>
          <span>
            <IconButton size="small" onClick={() => setReloadNonce((n) => n + 1)} disabled={loading} sx={{ p: 0.25 }}>
              {loading ? <CircularProgress size={14} /> : <RefreshIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error ? (
        <Typography variant="caption" color="error" sx={{ pl: 1 }}>
          couldn&rsquo;t load suggestions
        </Typography>
      ) : showBlank ? null : totalVisible === 0 ? (
        <Typography variant="caption" color="text.disabled" sx={{ pl: 1, fontStyle: "italic" }}>
          {multiVerse ? "no new links suggested for these verses" : "no new links suggested for this verse"}
        </Typography>
      ) : multiVerse ? (
        // Verse bridge: group under a small per-verse header so the editor can
        // see which verse each link will attach to. Empty groups are dropped.
        <Stack spacing={1}>
          {visibleGroups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <Box key={g.verse}>
                <Typography
                  variant="caption"
                  sx={{ pl: 0.5, fontWeight: 700, color: "text.secondary", fontFamily: "monospace" }}
                >
                  {`v${g.verse}`}
                </Typography>
                <Stack spacing={0.5} sx={{ mt: 0.25 }}>
                  {g.items.map(({ s, allowed }) => renderSuggestion(g.verse, s, allowed))}
                </Stack>
              </Box>
            ))}
        </Stack>
      ) : (
        <Stack spacing={0.5}>
          {visibleGroups[0]?.items.map(({ s, allowed }) => renderSuggestion(visibleGroups[0].verse, s, allowed))}
        </Stack>
      )}
      <TwArticleDialog articleId={articleId} onClose={() => setArticleId(null)} />
    </Box>
  );
}

export const TwlSuggestions = memo(TwlSuggestionsInner);

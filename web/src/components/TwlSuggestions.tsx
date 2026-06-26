// Per-verse TWL "Suggestions" — links the matcher proposes for the active verse
// that aren't already present. Additive by design (Rich's ask): the editor picks
// which to add; nothing is auto-deleted. Each suggestion shows the matched ULT
// English span and the proposed TW article; when a word maps to several articles
// a small dropdown disambiguates. "Add" hands the matched span back to the Shell,
// which resolves it to an OL quote + occurrence (twlResolve) and creates the row.

import { memo, useEffect, useState } from "react";
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
import { api, type TwlSuggestion } from "../sync/api";

// rc://*/tw/dict/bible/names/moab → names/moab; bare id passes through.
function twShort(idOrLink: string): string {
  const m = idOrLink.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : idOrLink;
}

// "kt/god" or "rc://*/tw/dict/bible/kt/god" → Door43 preview article URL.
function twArticleUrl(articleId: string): string {
  const m = articleId.match(/\/bible\/([^/]+)\/([^/]+)$/) ?? articleId.match(/^([^/]+)\/([^/]+)$/);
  if (!m) return "";
  return `https://preview.door43.org/u/unfoldingWord/en_tw/master#${m[1]}--${m[2]}`;
}

interface Props {
  book: string;
  chapter: number;
  verse: number;
  // Changes whenever the verse's existing TWL links change, so the list
  // refetches and drops anything just added (the server excludes existing links).
  refreshKey: string;
  onAdd: (suggestion: TwlSuggestion, chosenArticleId: string) => void;
  // Drop suggestions already linked on the verse (resolved-OL identity, computed
  // by Shell against the live rows). Applied after fetch so adds/deletes reflect
  // without a server round-trip.
  isExcluded?: (suggestion: TwlSuggestion) => boolean;
  // Article ids blocked by the unlinked deny-list for this suggestion's resolved
  // quote. Blocked ids are pruned from the picker; a suggestion whose every
  // article is blocked is dropped entirely.
  blockedArticleIds?: (suggestion: TwlSuggestion) => Set<string>;
  // Whether the deny-lists have settled (loaded or failed). The list holds off
  // rendering until then so a blocked suggestion can't show — or be added —
  // before isExcluded / blockedArticleIds have real data. Defaults to true so a
  // caller that doesn't wire filters is unaffected.
  filtersReady?: boolean;
  locked?: boolean;
  // When the Words lane is checked for this verse, new suggestions are paused
  // (the editor has signed off on the words here). The list collapses to a
  // one-line "paused" strip; "reopen" peeks it without un-checking the lane.
  paused?: boolean;
}

function TwlSuggestionsInner({ book, chapter, verse, refreshKey, onAdd, isExcluded, blockedArticleIds, filtersReady = true, locked = false, paused = false }: Props) {
  const [peeked, setPeeked] = useState(false);
  // Re-collapse when the verse changes or the lane is re-checked.
  useEffect(() => {
    setPeeked(false);
  }, [book, chapter, verse, paused]);
  const [suggestions, setSuggestions] = useState<TwlSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Per-suggestion chosen article for disambiguation (keyed by span+occurrence).
  const [chosen, setChosen] = useState<Record<string, string>>({});
  // Proofreader-rejected suggestions (keyed by span+occurrence): crossed off in
  // place so reviewers can mark a verse as worked through. Local/session-only and
  // reversible — nothing is persisted or sent to the server.
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    // Skip the scan entirely while paused (and not peeking) — the whole point
    // is to stop proposing once the editor has signed off on words here.
    if (verse === 0 || (paused && !peeked)) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    api
      .getTwlSuggestions(book, chapter, verse, ctrl.signal)
      .then((r) => {
        setSuggestions(r.suggestions);
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
  }, [book, chapter, verse, refreshKey, reloadNonce, paused, peeked]);

  // Clear rejections only when the verse itself changes — NOT on refreshKey
  // (which ticks whenever a link is added/deleted on this verse). Otherwise a
  // normal "reject A, add B" flow would refetch and un-reject A.
  useEffect(() => {
    setRejected({});
  }, [book, chapter, verse]);

  const keyOf = (s: TwlSuggestion) => `${s.matchedText}|${s.glOccurrence}`;
  // Filter on each render — isExcluded / blockedArticleIds close over the live
  // verse rows + deny-lists, so adding/deleting a link or loading filters
  // updates the list immediately. Two passes: drop already-linked suggestions
  // (isExcluded) and deleted-here ones, then prune unlinked-blocked articles
  // from each survivor's picker, dropping any whose every article is blocked.
  const visible = suggestions
    .filter((s) => !(isExcluded?.(s) ?? false))
    .map((s) => {
      const blocked = blockedArticleIds?.(s);
      const allowed =
        blocked && blocked.size > 0 ? s.disambiguation.filter((id) => !blocked.has(id)) : s.disambiguation;
      return { s, allowed };
    })
    .filter(({ allowed }) => allowed.length > 0);

  // Treat "filters not yet settled" as a loading state: until then we can't tell
  // which suggestions are blocked, so showing the list would flash addable links
  // the deny-list will remove a moment later.
  const showLoading = loading || !filtersReady;

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
          label={showLoading ? "…" : visible.length}
          size="small"
          variant="outlined"
          sx={{ height: 16, fontFamily: "monospace", fontSize: 10 }}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="re-scan this verse">
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
      ) : showLoading ? null : visible.length === 0 ? (
        <Typography variant="caption" color="text.disabled" sx={{ pl: 1, fontStyle: "italic" }}>
          no new links suggested for this verse
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {visible.map(({ s, allowed }) => {
            const k = keyOf(s);
            // Keep `selected` within the allowed set: honor the user's pick if
            // still allowed, else the primary if allowed, else the first survivor.
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
                <Tooltip title={locked ? "" : "add this link"}>
                  <span>
                    <IconButton
                      size="small"
                      color="success"
                      disabled={locked || isRejected}
                      onClick={() => onAdd(s, selected)}
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
                <Tooltip title="read article on Door43 (opens new tab)">
                  <IconButton
                    size="small"
                    component="a"
                    href={twArticleUrl(selected)}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ p: 0.25, color: "text.secondary" }}
                  >
                    <OpenInNewIcon sx={{ fontSize: 15 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}

export const TwlSuggestions = memo(TwlSuggestionsInner);

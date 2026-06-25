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
import { api, type TwlSuggestion } from "../sync/api";

// rc://*/tw/dict/bible/names/moab → names/moab; bare id passes through.
function twShort(idOrLink: string): string {
  const m = idOrLink.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : idOrLink;
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
  locked?: boolean;
}

function TwlSuggestionsInner({ book, chapter, verse, refreshKey, onAdd, isExcluded, locked = false }: Props) {
  const [suggestions, setSuggestions] = useState<TwlSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Per-suggestion chosen article for disambiguation (keyed by span+occurrence).
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (verse === 0) {
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
  }, [book, chapter, verse, refreshKey, reloadNonce]);

  const keyOf = (s: TwlSuggestion) => `${s.matchedText}|${s.glOccurrence}`;
  // Filter out already-linked suggestions on each render — isExcluded closes over
  // the live verse rows, so adding/deleting a link updates the list immediately.
  const visible = isExcluded ? suggestions.filter((s) => !isExcluded(s)) : suggestions;

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
          label={loading ? "…" : visible.length}
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
      ) : !loading && visible.length === 0 ? (
        <Typography variant="caption" color="text.disabled" sx={{ pl: 1, fontStyle: "italic" }}>
          no new links suggested for this verse
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {visible.map((s) => {
            const k = keyOf(s);
            const selected = chosen[k] ?? s.articleId;
            const ambiguous = s.disambiguation.length > 1;
            return (
              <Box
                key={k}
                sx={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto 28px",
                  alignItems: "center",
                  gap: 0.5,
                  px: 1,
                  py: 0.5,
                  border: "1px dashed",
                  borderColor: "divider",
                  borderRadius: 1,
                  bgcolor: "primary.50",
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
                    {s.disambiguation.map((id) => (
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
                      disabled={locked}
                      onClick={() => onAdd(s, selected)}
                      sx={{ p: 0.25 }}
                    >
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </span>
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

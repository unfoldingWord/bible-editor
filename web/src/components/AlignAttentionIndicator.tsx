// Topbar "alignment needs attention" badge. Sticky counterpart to the
// dismissible export banner: when the last nightly export found ULT/UST
// verses that lost word alignment, this badge shows the count and survives
// dismissal + reload (the banner does not). Clicking it lists each affected
// verse with a "go to" affordance. Hidden entirely once every flagged verse
// has been re-aligned locally (see `resolvedKeys`) — it's a nudge, not a
// permanent fixture.

import { useRef, useState } from "react";
import {
  Badge,
  Box,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import type { AlignAttentionRef } from "../sync/api";

interface Props {
  refs: AlignAttentionRef[];
  // Keys (`${resource}:${ref}`) of refs the translator has already fixed
  // since the export ran — filtered out so the badge doesn't nag about
  // verses that are already re-aligned.
  resolvedKeys?: Set<string>;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
  book: string;
}

const MAX_WORDS_SHOWN = 4;

function formatLostWords(words: string[]): string {
  const shown = words.slice(0, MAX_WORDS_SHOWN).map((w) => `"${w}"`);
  const remaining = words.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} +${remaining} more` : shown.join(", ");
}

export function AlignAttentionIndicator({ refs, resolvedKeys, onNavigate, book }: Props) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const pending = refs.filter((r) => !resolvedKeys?.has(`${r.resource}:${r.ref}`));

  // Nothing left to fix — stay out of the way.
  if (pending.length === 0) return null;

  // Count VERSES, not rows: a verse that lost alignment in both ULT and UST is
  // two rows but one verse, and the badge must not claim two. The list below
  // still shows every row, since each resource needs fixing separately.
  const verseCount = new Set(pending.map((r) => r.ref)).size;
  const tooltip = `${verseCount} verse${verseCount === 1 ? "" : "s"} in ${book} need${
    verseCount === 1 ? "s" : ""
  } alignment attention`;

  return (
    <Box component="span" sx={{ display: "inline-flex" }}>
      <Tooltip title={tooltip}>
        <IconButton
          ref={anchorRef}
          size="small"
          onClick={() => setOpen(true)}
          aria-label={tooltip}
        >
          <Badge badgeContent={verseCount} color="warning">
            <LinkOffIcon fontSize="small" sx={{ color: "warning.main" }} />
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        // Height cap + scroll: a book can come back from the export with
        // dozens of offending verses, and an uncapped Menu grows past the
        // viewport (MUI warns, and the tail of the list becomes unreachable).
        slotProps={{ paper: { sx: { maxWidth: 420, maxHeight: 480 } } }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">{book} — alignment needs attention</Typography>
          <Typography variant="caption" color="text.secondary">
            {verseCount} verse{verseCount === 1 ? "" : "s"} lost word alignment
          </Typography>
        </Box>
        <Divider />
        {pending.map((r, i) => (
          <MenuItem
            key={`${r.resource}-${r.ref}-${i}`}
            onClick={() => {
              setOpen(false);
              onNavigate(book, r.chapter, r.verse);
            }}
            sx={{ alignItems: "flex-start", whiteSpace: "normal", py: 1 }}
          >
            <ListItemText
              primary={
                <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                  >
                    {r.ref}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ textTransform: "uppercase" }}
                  >
                    {r.resource}
                  </Typography>
                </Box>
              }
              secondary={
                r.lostWords.length > 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    {formatLostWords(r.lostWords)}
                  </Typography>
                ) : undefined
              }
            />
          </MenuItem>
        ))}
        <Divider />
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="text.secondary">
            From the last nightly export — verses you fix disappear once you reload the
            chapter.
          </Typography>
        </Box>
      </Menu>
    </Box>
  );
}

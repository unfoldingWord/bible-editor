// The two verse-bridge toolbar buttons — "merge with next verse" (create a
// `\v a-b` bridge) and "break bridge" (split it back apart). Shared by both the
// columns-mode verse toolbar (VerseSpan) and the book-mode one (VerseCell) so
// the icons, tooltips, and click semantics stay identical between the two views.
//
// Rendered UST-only: the parent passes the callbacks only for the UST column
// (the reordering case the bridge exists for). The parent also decides whether
// there IS a next verse to merge with (hasNextVerse) so the merge button never
// appears on the last verse of a chapter where it could only fail.

import { IconButton, Tooltip } from "@mui/material";
import CallMergeIcon from "@mui/icons-material/CallMerge";
import CallSplitIcon from "@mui/icons-material/CallSplit";

interface Props {
  verse: number;
  verseEnd: number | null;
  // Whether a following verse row exists to merge into (parent-computed).
  hasNextVerse: boolean;
  // Create a bridge from this verse onward. Absent → button hidden.
  onMergeBridge?: (verse: number) => void;
  // Break this bridge. Absent, or this isn't a bridge → button hidden.
  onSplitBridge?: (verse: number) => void;
}

const BTN_SX = { p: 0.25, verticalAlign: "-3px", color: "#014263" } as const;

export function VerseBridgeButtons({ verse, verseEnd, hasNextVerse, onMergeBridge, onSplitBridge }: Props) {
  const bridge = verseEnd != null && verseEnd > verse;
  return (
    <>
      {onMergeBridge && hasNextVerse && (
        <Tooltip title={bridge ? `Extend bridge — merge verse ${(verseEnd ?? verse) + 1} in` : "Bridge with the next verse"}>
          <IconButton
            size="small"
            sx={BTN_SX}
            onClick={(e) => {
              e.stopPropagation();
              onMergeBridge(verse);
            }}
          >
            <CallMergeIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      {onSplitBridge && bridge && (
        <Tooltip title={`Break bridge ${verse}–${verseEnd}`}>
          <IconButton
            size="small"
            sx={BTN_SX}
            onClick={(e) => {
              e.stopPropagation();
              onSplitBridge(verse);
            }}
          >
            <CallSplitIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}

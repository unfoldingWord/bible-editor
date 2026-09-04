// The two verse-bridge toolbar buttons — "merge with next verse" (create a
// `\v a-b` bridge) and "break bridge" (split it back apart). Shared by both the
// columns-mode verse toolbar (VerseSpan) and the book-mode one (VerseCell) so
// the icons, tooltips, and click semantics stay identical between the two views.
//
// Rendered UST-only: the parent passes the callbacks only for the UST column
// (the reordering case the bridge exists for). The parent also decides whether
// there IS a next verse to merge with (hasNextVerse) so the merge button never
// appears on the last verse of a chapter where it could only fail.
//
// Guardrails (bridge create/break restructures the chapter and is easy to fire
// by accident): the buttons only render for the ACTIVE verse (`active`), sit in
// their own spaced-off group away from the other per-verse icons, and every
// action is gated behind a confirm dialog.

import { useState } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import CallMergeIcon from "@mui/icons-material/CallMerge";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  verse: number;
  verseEnd: number | null;
  // Only render while this verse is the active/selected one — keeps a big
  // structural action off every idle verse in the column.
  active: boolean;
  // Whether a following verse row exists to merge into (parent-computed).
  hasNextVerse: boolean;
  // Create a bridge from this verse onward. Absent → button hidden.
  onMergeBridge?: (verse: number) => void;
  // Break this bridge. Absent, or this isn't a bridge → button hidden.
  onSplitBridge?: (verse: number) => void;
}

const BTN_SX = { p: 0.25, verticalAlign: "-3px", color: "#014263" } as const;

export function VerseBridgeButtons({ verse, verseEnd, active, hasNextVerse, onMergeBridge, onSplitBridge }: Props) {
  const [confirm, setConfirm] = useState<null | "merge" | "split">(null);
  const bridge = verseEnd != null && verseEnd > verse;
  const mergeInto = (verseEnd ?? verse) + 1;
  // Verses that empty out when a bridge breaks — all text stays in `verse`.
  const emptied = verseEnd != null ? Array.from({ length: verseEnd - verse }, (_i, k) => verse + 1 + k).join(", ") : "";

  if (!active) return null;

  const showMerge = onMergeBridge && hasNextVerse;
  const showSplit = onSplitBridge && bridge;
  if (!showMerge && !showSplit) return null;

  return (
    <>
      {/* Spaced-off group: the ml gap separates these destructive controls from
          the align / text-check / undo icons so neither is a mis-click away. */}
      <Box component="span" sx={{ ml: 2, whiteSpace: "nowrap" }}>
        {showMerge && (
          <Tooltip title={bridge ? `Extend bridge — merge verse ${mergeInto} in` : "Bridge with the next verse"}>
            <IconButton
              size="small"
              sx={BTN_SX}
              onClick={(e) => {
                e.stopPropagation();
                setConfirm("merge");
              }}
            >
              <CallMergeIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        {showSplit && (
          <Tooltip title={`Break bridge ${verse}–${verseEnd}`}>
            <IconButton
              size="small"
              sx={BTN_SX}
              onClick={(e) => {
                e.stopPropagation();
                setConfirm("split");
              }}
            >
              <CallSplitIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <ConfirmDialog
        open={confirm === "merge"}
        title={bridge ? "Extend verse bridge?" : "Bridge with the next verse?"}
        description={
          bridge
            ? `This merges verse ${mergeInto} into the ${verse}–${verseEnd} bridge, restructuring the chapter.`
            : `This bridges verse ${verse} with verse ${mergeInto} into a single \\v ${verse}-${mergeInto} verse, restructuring the chapter.`
        }
        confirmLabel={bridge ? "extend bridge" : "bridge verses"}
        confirmColor="warning"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          onMergeBridge?.(verse);
        }}
      />
      <ConfirmDialog
        open={confirm === "split"}
        title="Break this verse bridge?"
        description={`This breaks the ${verse}–${verseEnd} bridge. All text stays in verse ${verse}; verse${emptied.includes(",") ? "s" : ""} ${emptied} become${emptied.includes(",") ? "" : "s"} empty for you to fill in.`}
        confirmLabel="break bridge"
        confirmColor="warning"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          onSplitBridge?.(verse);
        }}
      />
    </>
  );
}

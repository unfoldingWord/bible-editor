// Hover Tooltip for Hebrew/Greek source words. Same as MUI Tooltip, but it
// opens outside the block of source text around the word instead of right
// under the word, so it doesn't cover the line being read (#1055). The
// placement rule lives in lib/lexPlacement.ts.

import { useState } from "react";
import { Tooltip, type TooltipProps } from "@mui/material";
import { chooseLexPlacement, lexAnchorRect, type LexPlacement } from "../lib/lexPlacement";

function regionOf(word: HTMLElement): HTMLElement {
  return (
    word.closest<HTMLElement>("[data-lex-region]") ??
    word.closest<HTMLElement>("[data-lex-line]") ??
    word
  );
}

// Popper props that place the hover box for `word` outside its block. Also
// used by HebrewLine's one hover box per line (#899). Built once per open: a
// new anchorEl or popperOptions object makes the Popper rebuild, which shows
// as a flicker.
export function lexPopperPlacement(word: HTMLElement) {
  const placement: LexPlacement = chooseLexPlacement(
    regionOf(word).getBoundingClientRect(),
    window.innerWidth,
    window.innerHeight,
  );
  let last: DOMRect | null = null;
  return {
    placement,
    // Read live so a scroll while open keeps the box beside the block. A
    // word that re-mounted while open measures as zeros; keep the last rect.
    anchorEl: {
      getBoundingClientRect: () => {
        if (!word.isConnected && last) return last;
        const r = lexAnchorRect(
          placement,
          regionOf(word).getBoundingClientRect(),
          word.getBoundingClientRect(),
        );
        last = { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect;
        return last;
      },
    },
    // Flipping would put the box back over the block.
    popperOptions: { modifiers: [{ name: "flip", enabled: false }] },
  };
}

export function LexTooltip({ onOpen, slotProps, ...rest }: TooltipProps) {
  const [placed, setPlaced] = useState<ReturnType<typeof lexPopperPlacement> | null>(null);
  const handleOpen = (e: React.SyntheticEvent) => {
    const word = (e.currentTarget ?? e.target) as HTMLElement | null;
    if (word instanceof HTMLElement) setPlaced(lexPopperPlacement(word));
    onOpen?.(e);
  };
  const popper = slotProps?.popper;
  return (
    <Tooltip
      {...rest}
      onOpen={handleOpen}
      slotProps={{
        ...slotProps,
        popper: {
          ...(typeof popper === "object" ? popper : {}),
          ...(placed ?? {}),
        },
      }}
    />
  );
}

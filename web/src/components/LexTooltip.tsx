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

export function LexTooltip({ onOpen, slotProps, ...rest }: TooltipProps) {
  const [pos, setPos] = useState<{ placement: LexPlacement; word: HTMLElement } | null>(null);
  const handleOpen = (e: React.SyntheticEvent) => {
    const word = (e.currentTarget ?? e.target) as HTMLElement | null;
    if (word instanceof HTMLElement) {
      const region = regionOf(word).getBoundingClientRect();
      setPos({ placement: chooseLexPlacement(region, window.innerWidth, window.innerHeight), word });
    }
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
          ...(pos
            ? {
                placement: pos.placement,
                // Read live so a scroll while open keeps the box beside the block.
                anchorEl: {
                  getBoundingClientRect: () => {
                    const r = lexAnchorRect(
                      pos.placement,
                      regionOf(pos.word).getBoundingClientRect(),
                      pos.word.getBoundingClientRect(),
                    );
                    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect;
                  },
                },
                // Flipping would put the box back over the block.
                popperOptions: { modifiers: [{ name: "flip", enabled: false }] },
              }
            : {}),
        },
      }}
    />
  );
}

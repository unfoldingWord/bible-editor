// Where the Hebrew/Greek hover box goes (#1055). The box stays near the
// hovered word, but outside the whole block of source text around it, so it
// never covers the line being read. The block is the nearest
// [data-lex-region] ancestor (a UHB column, the aligner's source strip, an
// alignment card), else the verse's own source line ([data-lex-line]).
//
// Order of preference: below the block, above it, then beside it (for a
// block taller than the room above and below, like the columns-mode UHB
// column). Horizontally it is centered on the word; beside the block it is
// level with the word.

export type Rect = { top: number; bottom: number; left: number; right: number };
export type LexPlacement = "bottom" | "top" | "left" | "right";

// Height to reserve for the hover box: a gloss + grammar + definition box runs
// ~170-270px. A taller box still opens on the chosen side (it may run off
// that edge of the screen rather than back over the block).
export const LEX_BOX_HEIGHT = 280;
const LEX_BOX_WIDTH = 320;

export function chooseLexPlacement(region: Rect, viewportW: number, viewportH: number): LexPlacement {
  if (viewportH - region.bottom >= LEX_BOX_HEIGHT) return "bottom";
  if (region.top >= LEX_BOX_HEIGHT) return "top";
  const left = region.left;
  const right = viewportW - region.right;
  if (left >= LEX_BOX_WIDTH || right >= LEX_BOX_WIDTH) return left >= right ? "left" : "right";
  // No side fits cleanly; below still covers the least of the block itself.
  return viewportH - region.bottom >= region.top ? "bottom" : "top";
}

// The rectangle the box is positioned against: the block's edge on the chosen
// side, with the word's position along the other axis.
export function lexAnchorRect(placement: LexPlacement, region: Rect, word: Rect): Rect {
  if (placement === "bottom" || placement === "top") {
    const x = (word.left + word.right) / 2;
    return { top: region.top, bottom: region.bottom, left: x, right: x };
  }
  const y = (word.top + word.bottom) / 2;
  return { top: y, bottom: y, left: region.left, right: region.right };
}

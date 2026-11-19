// Click-to-jump for hover-link. While hover-link is on, clicking a word whose
// aligned partner is scrolled out of sight scrolls the pane holding that
// partner so it comes into view (UHB strip / word bank → groups pane, group →
// word bank, and across both panels in side-by-side).
//
// DOM-based on purpose: every highlightable word already renders its live
// hover tone as `data-hover-tone` (the same tone that draws the ring), so the
// "partners" are exactly the elements the user currently sees ringed. No second
// copy of the linking rules to keep in sync with alignmentHover.ts.
//
// Two rules keep double-click intact (dbl-click pins lexicon / splits / unaligns):
//   1. The pane the click came from is never scrolled — the clicked word stays
//      under the cursor, so the second click of a double-click lands on it.
//   2. A pane is only scrolled when none of its partners is already fully
//      visible, so a click with everything in view does nothing.

export const JUMP_ROOT_ATTR = "data-align-jump-root";
export const HOVER_TONE_ATTR = "data-hover-tone";

function isScroller(el: HTMLElement): boolean {
  const oy = getComputedStyle(el).overflowY;
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
}

// Nearest vertically-scrollable ancestor at or inside `root`, or null.
function scrollerOf(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  let cur = el.parentElement;
  while (cur && cur !== root.parentElement) {
    if (isScroller(cur)) return cur;
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return null;
}

// The OUTERMOST jump root, so side-by-side (whose dialog is a root, wrapping two
// panel roots) jumps across both panels and the shared strip.
function rootOf(el: HTMLElement): HTMLElement | null {
  let found: HTMLElement | null = null;
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.hasAttribute(JUMP_ROOT_ATTR)) found = cur;
    cur = cur.parentElement;
  }
  return found;
}

function fullyVisible(el: HTMLElement, scroller: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  return r.top >= s.top && r.bottom <= s.bottom;
}

// Scroll only `scroller` (not its ancestors, which scrollIntoView would also
// move) so `el` is centred, or top-aligned when taller than the pane.
function scrollWithin(el: HTMLElement, scroller: HTMLElement) {
  const r = el.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const offset =
    r.height >= s.height ? r.top - s.top : r.top - s.top - (s.height - r.height) / 2;
  scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: "smooth" });
}

export function jumpToLinked(clicked: HTMLElement) {
  // Next frame: on touch, the emulated mouseenter and the click land in the
  // same tick, before the hover tones have re-rendered.
  requestAnimationFrame(() => {
    const root = rootOf(clicked);
    if (!root) return;
    const own = scrollerOf(clicked, root);
    const byScroller = new Map<HTMLElement, { el: HTMLElement; target: HTMLElement }[]>();
    root.querySelectorAll<HTMLElement>(`[${HOVER_TONE_ATTR}]`).forEach((el) => {
      if (el === clicked || el.contains(clicked) || clicked.contains(el)) return;
      const sc = scrollerOf(el, root);
      if (!sc || sc === own || sc.contains(clicked)) return;
      // In the groups pane, aim for the whole card when it fits.
      const card = el.closest<HTMLElement>("[data-group-id]");
      const target = card && sc.contains(card) ? card : el;
      const list = byScroller.get(sc) ?? [];
      list.push({ el, target });
      byScroller.set(sc, list);
    });
    byScroller.forEach((hits, sc) => {
      // Visibility is judged on the ringed word itself, not its card: a card
      // taller than the pane is never "fully visible" but its word may be.
      if (hits.some((h) => fullyVisible(h.el, sc))) return;
      const { el, target } = hits[0];
      const s = sc.getBoundingClientRect();
      scrollWithin(target.getBoundingClientRect().height <= s.height ? target : el, sc);
    });
  });
}

// Tiny external store for the aligner's live hover-highlight state, used by
// AlignmentPanel.tsx and SideBySideAligner.tsx (#900).
//
// A word `mouseenter`/`mouseleave` fires constantly while sweeping the mouse
// across a verse. Keeping the hovered word in ordinary React state
// (`useState`) makes EVERY such event re-render whichever component owns that
// state — in side-by-side mode that's the dialog, so a hover in one panel
// re-rendered the dialog, BOTH AlignmentPanels, and SharedUhbStrip, even
// though only a handful of chips ever actually change highlight tone.
//
// The fix: hover lives here, outside React state entirely, as a plain
// subscribe/getSnapshot store. Each chip/card/token then reads only ITS OWN
// resolved tone via useSyncExternalStore (useEnglishHighlightTone /
// useHebrewHighlightTone below), so a hover event commits just the specific
// words whose tone actually changed — not the panel(s) around them.
//
// resolveEnglishHighlight/resolveHebrewHighlight (alignmentHover.ts) remain
// the single source of truth for tone resolution; this file only supplies the
// live hover value they get called with. It deliberately imports React (for
// useSyncExternalStore) so that alignmentHover.ts itself stays framework-free
// and runnable under plain Node — see alignmentHover.test.mjs.
import { useSyncExternalStore } from "react";
import { resolveEnglishHighlight, resolveHebrewHighlight, type HoverCtx } from "./alignmentHover";
import type { HighlightTone, HoverHighlight } from "./highlightTypes";

export interface HoverStore {
  getHover(): HoverHighlight;
  setHover(next: HoverHighlight): void;
  subscribe(listener: () => void): () => void;
}

export function createHoverStore(initial: HoverHighlight = null): HoverStore {
  let hover = initial;
  const listeners = new Set<() => void>();
  return {
    getHover: () => hover,
    setHover(next) {
      hover = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Generic building block: subscribes to `store` and re-resolves `resolve`
// against the CURRENT hover on every notification. `resolve` must return a
// primitive (HighlightTone is "exact" | "linked" | null) so React's default
// Object.is comparison bails the calling component out of committing when its
// own tone hasn't changed, even though a sibling word's tone just did.
// SharedUhbStrip (SideBySideAligner.tsx) has its own cross-panel resolution
// logic and calls this directly; the two alignment-panel-flavored wrappers
// below are the common case.
export function useHoverTone(
  store: HoverStore,
  resolve: (hover: HoverHighlight) => HighlightTone,
): HighlightTone {
  return useSyncExternalStore(store.subscribe, () => resolve(store.getHover()));
}

// Per-chip English hover tone, via the shared resolver in alignmentHover.ts.
export function useEnglishHighlightTone(
  ctx: HoverCtx,
  store: HoverStore,
  wordId: string,
  text: string,
  occurrence: string,
  groupIdOverride?: string,
): HighlightTone {
  return useHoverTone(store, (hover) =>
    resolveEnglishHighlight(ctx, hover, wordId, text, occurrence, groupIdOverride),
  );
}

// Per-token Hebrew hover tone, via the shared resolver in alignmentHover.ts.
export function useHebrewHighlightTone(
  ctx: HoverCtx,
  store: HoverStore,
  pos: number,
  groupIdOverride?: string,
): HighlightTone {
  return useHoverTone(store, (hover) => resolveHebrewHighlight(ctx, hover, pos, groupIdOverride));
}

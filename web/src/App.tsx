// NB: src/spikes/AlignerSmoke.tsx is intentionally NOT imported.
// Aligner integration is deferred to Phase 3 — see docs/plan.md.
import { Shell } from "./components/Shell";

export function App() {
  // Phase 1 boots straight into ZEC chapter 1. Routing/book picker arrives
  // when we wire DCS OAuth and per-user state.
  return <Shell book="ZEC" chapter={1} initialVerse={1} />;
}

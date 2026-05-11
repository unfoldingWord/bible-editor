// The aligner packages ship JS only — no .d.ts. Declare them as opaque
// modules so TS doesn't complain. We'll add narrower types if/when we
// hand-write a wrapper component in Phase 3.
declare module "enhanced-word-aligner-rcl";
declare module "word-aligner-rcl";

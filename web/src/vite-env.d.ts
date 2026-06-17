/// <reference types="vite/client" />

// Injected by `define` in vite.config.ts at build time. The git short SHA + ISO
// build timestamp of the bundle currently running in the tab.
declare const __APP_VERSION__: { commit: string; builtAt: string };

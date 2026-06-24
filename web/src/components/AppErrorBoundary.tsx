// Top-level error boundary. Before this, ANY uncaught render error unmounted
// the whole React tree and left a blank page with no way back — the app looked
// like it "crashed and bumped you out." Two failure classes land here:
//
//  1. Stale code-split chunks. BookView / FindReplaceOverlay (and the history
//     dialogs) are React.lazy dynamic imports. A tab left open across a deploy
//     requests a chunk hash that no longer exists, so the import rejects mid-
//     render. Suspense does NOT catch that — only an error boundary does. A
//     full reload fetches the fresh index.html + current chunk names and fixes
//     it, so we auto-reload once (guarded against a loop).
//  2. Any other render exception — show a recoverable "Reload" screen instead
//     of a blank page, and reassure that queued edits are safe in the outbox.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Stack, Typography } from "@mui/material";

// Vite/Rollup surface a dynamic-import failure as a TypeError whose message
// names the failed module URL; some browsers tag it "ChunkLoadError". Two
// distinct shapes show up after a deploy and BOTH must match:
//  - true 404 (chunk gone):       "Failed to fetch dynamically imported module: <url>"
//  - SPA fallback serves HTML:    "Failed to load module script: Expected a JavaScript
//    module script but the server responded with a MIME type of text/html…"
// The second is what Cloudflare's [assets] SPA fallback produces for a missing
// hashed chunk, so it's the common real-world case — don't miss it.
function isChunkLoadError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === "ChunkLoadError") return true;
  return /dynamically imported module|Importing a module script failed|Failed to fetch dynamically imported|error loading dynamically imported|Failed to load module script|module script but the server responded with/i.test(
    e.message ?? "",
  );
}

// One auto-reload per window. If reloading doesn't clear the chunk error (the
// chunk is genuinely gone — a bad deploy), we stop reloading and leave the
// manual fallback up rather than spinning in a reload loop.
const RELOAD_GUARD_KEY = "be:chunk-reload-at";
const RELOAD_GUARD_WINDOW_MS = 15_000;

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed:", error, info.componentStack);
    if (!isChunkLoadError(error)) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    } catch {
      /* private mode — fall through to reload */
    }
    if (Date.now() - last > RELOAD_GUARD_WINDOW_MS) {
      try {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
      location.reload();
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkLoadError(error);
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh", px: 4 }} spacing={2}>
        <Typography variant="h6">{chunk ? "Update needed" : "Something went wrong"}</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 480 }}>
          {chunk
            ? "A newer version of the editor has been deployed. Reload to load it — your queued edits are saved in this browser and will sync after reload."
            : "The editor hit an unexpected error. Your queued edits are saved in this browser. Reload to continue."}
        </Typography>
        <Button variant="contained" onClick={() => location.reload()}>
          Reload
        </Button>
      </Stack>
    );
  }
}

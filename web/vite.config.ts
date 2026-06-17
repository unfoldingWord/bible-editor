import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Build-time version stamp. Both the running bundle (via `define`) and a static
// /version.json (emitted into dist, served by the prod Worker's [assets]) carry
// the SAME value, so an open tab can poll /version.json and tell when prod has
// moved past the build it's running — that's what drives the "Update available"
// refresh prompt in the top bar. web + api deploy together, so one git SHA
// covers both. See web/src/hooks/useAppVersion.ts.
function resolveVersion(): { commit: string; builtAt: string } {
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    // CI may build without a .git dir — fall back to a deploy-provided SHA if
    // present, else leave "unknown" (the poller treats unknown as "never stale").
    const envSha =
      process.env.CF_PAGES_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      process.env.COMMIT_SHA;
    if (envSha) commit = envSha.slice(0, 7);
  }
  return { commit, builtAt: new Date().toISOString() };
}

const APP_VERSION = resolveVersion();

// Emit dist/version.json alongside the hashed bundle so it ships in [assets]
// and is reachable at /version.json on the deployed Worker.
function emitVersionJson(): Plugin {
  return {
    name: "emit-version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify(APP_VERSION),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), emitVersionJson()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        // Forward WebSocket upgrades (used by /api/ws/chapter/:book/:chapter
        // for live cross-tab note updates). Without this Vite returns 502
        // on the upgrade.
        ws: true,
      },
    },
  },
});

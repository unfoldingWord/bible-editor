import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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

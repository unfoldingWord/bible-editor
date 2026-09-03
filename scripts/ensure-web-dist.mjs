// `wrangler dev` refuses to boot when its `[assets]` directory (web/dist)
// doesn't exist, so `npm run test:e2e` fails cold in a fresh checkout/worktree
// until `npm run build` has been run once by hand. Wired as `pretest:e2e` in
// package.json (npm runs `pre<script>` automatically), this builds web the
// first time only — later runs see web/dist already present and no-op.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = resolve(repoRoot, "web/dist/index.html");

if (existsSync(distIndex)) {
  process.exit(0);
}

console.log("[test:e2e] web/dist is missing (wrangler dev requires it) — building web once…");
const result = spawnSync("npm", ["run", "build:web"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.status !== 0) {
  console.error(`[test:e2e] npm run build:web failed (exit ${result.status})`);
  process.exit(result.status ?? 1);
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs once before any test. Re-imports ZEC from docs/samples into the local
// D1 instance so every test starts against a known fixture. We pick ZEC
// because the sample bundle already has its full TN/TQ/TWL/USFM set, and the
// importer is idempotent (REPLACE INTO + DELETE WHERE book='ZEC') so re-runs
// are safe.
//
// The webServer (api + web) is started by Playwright *after* this finishes,
// so we're free to write the SQLite file directly via `wrangler d1 execute`.
export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const sqlPath = resolve(repoRoot, "scripts/out/import-ZEC.sql");

  if (!existsSync(sqlPath)) {
    console.log("[setup] generating ZEC import SQL…");
    const gen = spawnSync("node", ["scripts/import-book.mjs", "ZEC"], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
    });
    if (gen.status !== 0) {
      throw new Error(`import-book.mjs ZEC failed with exit ${gen.status}`);
    }
  }

  console.log("[setup] applying ZEC import to local D1…");
  // wrangler d1 execute on Windows needs the .cmd shim; spawnSync with
  // shell:true picks it up automatically and avoids ENOENT.
  const apply = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "bible_editor",
      "--local",
      `--file=${sqlPath}`,
    ],
    {
      cwd: resolve(repoRoot, "api"),
      stdio: "inherit",
      shell: true,
    },
  );
  if (apply.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (status ${apply.status}). ` +
        "Have migrations been applied? Try `npm --workspace api run db:migrate:local` first.",
    );
  }

  console.log("[setup] complete");
}

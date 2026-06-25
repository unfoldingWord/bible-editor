// One-shot importer for the unfoldingWord Translation Words (en_tw) article
// catalog. Populates the tw_articles table (migration 0032) that backs both the
// canonical TW-article picker and the per-verse TWL suggestion matcher.
//
// Mirrors scripts/import-lexicon.mjs: ONE archive download (no per-file fetch,
// no npm zip dependency — extraction shells out to the OS), parse, emit SQL.
//
// Run:
//   node scripts/import-tw.mjs
// Then apply (local dev):
//   (cd api && npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-tw.sql)
// Or prod:
//   (cd api && npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/out/import-tw.sql)
//
// Each row stores: id ("kt/god"), category ("kt"|"names"|"other"), title (the
// article's first markdown heading — the headword line, which may list synonyms),
// and tw_link ("rc://*/tw/dict/bible/kt/god"). last_synced defaults to
// unixepoch() at apply time. The matcher (api/src/twlMatcher.ts) derives terms
// + morphological variants from `title`, so we store the raw heading verbatim.

import { execSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const tmpDir = join(repoRoot, "scripts", "tmp");
const outDir = join(repoRoot, "scripts", "out");

mkdirSync(tmpDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const SOURCE = {
  url: "https://git.door43.org/unfoldingWord/en_tw/archive/master.zip",
  archiveRoot: "en_tw",
};

// The article categories under en_tw/bible/. Order is also the matcher's tag
// hint: kt -> "keyterm", names -> "name", other -> (none).
const CATEGORIES = ["kt", "names", "other"];

// Cross-platform zip extraction (same approach as import-lexicon.mjs):
// Expand-Archive on Windows, unzip elsewhere. Avoids any npm zip dependency.
function extractZip(zipPath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -oq "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  }
}

async function downloadAndExtract() {
  const zipPath = join(tmpDir, "en_tw.zip");
  if (!existsSync(zipPath)) {
    console.log(`  downloading ${SOURCE.url} ...`);
    const res = await fetch(SOURCE.url);
    if (!res.ok) throw new Error(`fetch ${SOURCE.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, buf);
  } else {
    console.log(`  reusing cached ${zipPath}`);
  }
  const extractDir = join(tmpDir, "en_tw");
  if (!existsSync(join(extractDir, SOURCE.archiveRoot))) {
    console.log(`  extracting ${zipPath} ...`);
    extractZip(zipPath, extractDir);
  } else {
    console.log(`  reusing extracted ${extractDir}`);
  }
  return join(extractDir, SOURCE.archiveRoot);
}

// First markdown heading = the article's headword line. Most are "# God"; some
// list synonyms ("# Yahweh, the LORD, the LORD God") — kept verbatim so the
// matcher can split them. Strip the leading "# " and any trailing whitespace.
function firstHeading(text) {
  const m = text.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function escapeSql(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

(async () => {
  const root = await downloadAndExtract();
  const bibleDir = join(root, "bible");
  if (!existsSync(bibleDir)) {
    throw new Error(`expected ${bibleDir} in the en_tw archive`);
  }

  const articles = []; // { id, category, title, tw_link }
  let skippedNoHeading = 0;
  for (const category of CATEGORIES) {
    const dir = join(bibleDir, category);
    if (!existsSync(dir)) {
      console.warn(`  (no ${category}/ directory — skipping)`);
      continue;
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const slug = f.replace(/\.md$/, "");
      const text = readFileSync(join(dir, f), "utf-8");
      const title = firstHeading(text);
      if (!title) {
        skippedNoHeading++;
        continue;
      }
      articles.push({
        id: `${category}/${slug}`,
        category,
        title,
        tw_link: `rc://*/tw/dict/bible/${category}/${slug}`,
      });
    }
    console.log(`  ${category}: ${files.length} files`);
  }

  articles.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`total articles: ${articles.length} (skipped ${skippedNoHeading} with no heading)`);
  if (articles.length === 0) throw new Error("no articles parsed — aborting");

  const sqlPath = join(outDir, "import-tw.sql");
  const lines = ["DELETE FROM tw_articles;"];
  const BATCH = 100;
  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    lines.push(
      "INSERT OR REPLACE INTO tw_articles (id, category, title, tw_link) VALUES",
    );
    lines.push(
      batch
        .map(
          (a) =>
            `(${escapeSql(a.id)}, ${escapeSql(a.category)}, ${escapeSql(a.title)}, ${escapeSql(a.tw_link)})`,
        )
        .join(",\n") + ";",
    );
  }
  writeFileSync(sqlPath, lines.join("\n") + "\n");
  console.log(`wrote ${sqlPath} (${(lines.join("\n").length / 1024).toFixed(0)} KB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

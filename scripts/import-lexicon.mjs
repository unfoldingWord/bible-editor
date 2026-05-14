// One-shot importer for UHAL (Unlocked Hebrew/Aramaic Lexicon) and UGL
// (Unlocked Greek Lexicon) from Door43 Content Service.
//
// Two-phase: a Strong's Dictionary baseline (bundled from translationCore
// at scripts/lexicon-data/, public domain, near-complete coverage) is
// loaded first, then unfoldingWord UHAL/UGL is overlaid on top — uW lemma
// and part_of_speech always win; uW gloss/definition wins when present,
// falls back to Strong's brief/long otherwise.
//
// Run:
//   node scripts/import-lexicon.mjs
// Then apply:
//   (cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/import-lexicon.sql)
//
// Each entry stores: strong (e.g. "H2320"), resource ("uhal" / "ugl"),
// lemma (Hebrew/Greek wordform), part_of_speech, gloss (terse, shown in
// tooltip), and definition (longer paragraph). uW source format is
// documented at https://ugl-info.readthedocs.io/en/latest/markdown.html.

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
const dataDir = join(repoRoot, "scripts", "lexicon-data");

mkdirSync(tmpDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const SOURCES = [
  {
    resource: "uhal",
    url: "https://git.door43.org/unfoldingWord/en_uhal/archive/master.zip",
    archiveRoot: "en_uhal",
  },
  {
    resource: "ugl",
    url: "https://git.door43.org/unfoldingWord/en_ugl/archive/master.zip",
    archiveRoot: "en_ugl",
  },
];

// Pull translationCore's bundled Strong's data (public domain classic
// Strong's Dictionary). Provides ~14,000 H/G entries with brief + long
// definitions — the only surviving copy now that Door43-Catalog/{uhl,ugl}
// have been removed from DCS. See scripts/lexicon-data/README.md.
const BASELINE_SOURCES = [
  { resource: "uhal", prefix: "H", zip: join(dataDir, "uhl-contents.zip") },
  { resource: "ugl", prefix: "G", zip: join(dataDir, "ugl-contents.zip") },
];
const UHL_INDEX_PATH = join(dataDir, "uhl-index.json");

// Cross-platform zip extraction. The bundled contents.zip files use a
// format that bsdtar (the default `tar` on Windows) chokes on with
// "Inconsistent CRC32 values" — PowerShell's Expand-Archive handles them
// fine. On macOS/Linux we use `unzip`, which is universally available.
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

// Load the bundled Strong's-keyed JSON files into a Map<strong, {gloss,
// definition}>. Each `content/{n}.json` is `{brief, long}` where `brief`
// is a short gloss and `long` is the full Strong's entry (with inline HTML
// tags <i>/<br/> we strip on the way in).
function loadBaseline({ resource, prefix, zip }) {
  const extractDir = join(tmpDir, `baseline-${resource}`);
  if (!existsSync(zip)) {
    throw new Error(`baseline zip not found: ${zip}`);
  }
  console.log(`  extracting baseline ${zip} ...`);
  extractZip(zip, extractDir);
  const contentDir = join(extractDir, "content");
  const map = new Map();
  for (const f of readdirSync(contentDir).filter((f) => /^\d+\.json$/.test(f))) {
    const num = parseInt(f, 10);
    const strong = `${prefix}${num}`;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(contentDir, f), "utf-8"));
    } catch {
      continue;
    }
    const gloss = cleanStrongsText(parsed.brief, 200);
    const definition = cleanStrongsText(parsed.long, 600);
    map.set(strong, { gloss, definition });
  }
  console.log(`  baseline ${resource}: ${map.size} entries`);
  return map;
}

// The bundled long-form text carries HTML markup (<i>, <br/>) and label
// prefixes like "<i>Meaning:</i>". Normalize to a single clean line that
// fits the tooltip + transport payload constraints, matching how senseOne
// shapes uW entries.
function cleanStrongsText(value, max) {
  if (typeof value !== "string") return null;
  let v = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return null;
  if (v.length > max) v = v.slice(0, max - 1) + "…";
  return v;
}

function loadUhlLemmaIndex() {
  if (!existsSync(UHL_INDEX_PATH)) return new Map();
  const list = JSON.parse(readFileSync(UHL_INDEX_PATH, "utf-8"));
  const map = new Map();
  for (const e of list) {
    if (e?.id && e?.name) map.set(String(e.id).toUpperCase(), String(e.name));
  }
  return map;
}

async function downloadAndExtract(url, archiveRoot, resource) {
  const zipPath = join(tmpDir, `${resource}.zip`);
  if (!existsSync(zipPath)) {
    console.log(`  downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(zipPath, buf);
  } else {
    console.log(`  reusing cached ${zipPath}`);
  }
  const extractDir = join(tmpDir, resource);
  if (!existsSync(join(extractDir, archiveRoot))) {
    mkdirSync(extractDir, { recursive: true });
    console.log(`  extracting ${zipPath} ...`);
    execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { stdio: "inherit" });
  } else {
    console.log(`  reusing extracted ${extractDir}`);
  }
  return join(extractDir, archiveRoot);
}

// --- markdown parser shared by UHAL and UGL ----------------------------------

// Pull a `* Field: value` bullet whose value sits either inline or on the
// following indented line(s). Returns the first non-empty line of value.
function bulletValue(text, field) {
  const lineMatch = text.match(
    new RegExp(`^\\*\\s+${field}\\s*:\\s*(.*)$`, "im"),
  );
  if (!lineMatch) return null;
  const inline = (lineMatch[1] ?? "").trim();
  if (inline) return inline;
  // Spec puts some values on the next line(s). Look ahead for the next
  // non-blank non-bullet line.
  const start = (lineMatch.index ?? 0) + lineMatch[0].length;
  const rest = text.slice(start);
  const next = rest.match(/\n+([^\n*#][^\n]*)/);
  return next ? next[1].trim() : null;
}

// Lift the first Sense's Glosses + Definition + Explanation. We squash to
// single lines, strip markdown links, and clamp lengths so the tooltip and
// transport payload stay compact.
function senseOne(text) {
  const m = text.match(/###\s+Sense\s+1\.0:?([\s\S]*?)(?=###\s+Sense|\Z)/i);
  if (!m) return { gloss: null, definition: null };
  const body = m[1];
  const grab = (name, max) => {
    const r = new RegExp(
      `####\\s+${name}\\s*:?\\s*([\\s\\S]*?)(?=^####|\\Z)`,
      "im",
    );
    const mm = body.match(r);
    if (!mm) return null;
    let v = mm[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!v) return null;
    if (v.length > max) v = v.slice(0, max - 1) + "…";
    return v;
  };
  return {
    gloss: grab("Glosses", 200),
    definition: grab("Definition", 600) || grab("Explanation", 600),
  };
}

function parseEntry(text, fallbackStrong) {
  const lemmaM = text.match(/^#\s+(.+?)\s*$/m);
  const lemma = lemmaM ? lemmaM[1].trim() : null;
  let strong = bulletValue(text, "Strongs?");
  if (strong) strong = strong.replace(/[.,;]$/, "");
  if (!strong || !/^[HG]\d+/i.test(strong)) strong = fallbackStrong;
  let pos = bulletValue(text, "Part of Speech");
  // Strip markdown links and dot-trailing.
  if (pos) {
    pos = pos.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[.,;]+$/, "").trim();
  }
  const { gloss, definition } = senseOne(text);
  return { strong, lemma, part_of_speech: pos, gloss, definition };
}

function walkUhal(rootDir) {
  const contentDir = join(rootDir, "content");
  const out = [];
  const files = readdirSync(contentDir).filter((f) => /^H\d+\.md$/i.test(f));
  for (const f of files) {
    const fileStrong = `H${parseInt(f.slice(1), 10)}`; // H0001.md → H1
    const text = readFileSync(join(contentDir, f), "utf-8");
    const e = parseEntry(text, fileStrong);
    // Normalize the parsed strong too (drop leading zeros / prefix).
    if (e.strong) {
      const m = e.strong.match(/[HG]\d+/i);
      if (m) e.strong = m[0].toUpperCase().replace(/^H0+/, "H").replace(/^G0+/, "G");
    }
    if (!e.strong) e.strong = fileStrong;
    e.resource = "uhal";
    out.push(e);
  }
  return out;
}

function walkUgl(rootDir) {
  const contentDir = join(rootDir, "content");
  const out = [];
  const dirs = readdirSync(contentDir).filter((d) => /^G\d+$/i.test(d));
  for (const d of dirs) {
    const dirPath = join(contentDir, d);
    const file = join(dirPath, "01.md");
    if (!existsSync(file)) continue;
    // UGL "Strong's-Plus" id: directory is the classic Strong's * 10, zero
    // padded to 5 digits. So G00010 = G1, G25600 = G2560. The bullet inside
    // each file also uses the Strong's-Plus form, but our USFM source words
    // carry classic Strong's — derive that from the dirname and ignore the
    // in-file value.
    const num = parseInt(d.slice(1), 10);
    const fileStrong = Number.isFinite(num) ? `G${Math.floor(num / 10)}` : d;
    const text = readFileSync(file, "utf-8");
    const e = parseEntry(text, fileStrong);
    e.strong = fileStrong;
    e.resource = "ugl";
    out.push(e);
  }
  return out;
}

function escapeSql(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}

(async () => {
  // Phase 1: Strong's baseline (bundled).
  const baselines = new Map(); // strong → { resource, gloss, definition }
  for (const src of BASELINE_SOURCES) {
    console.log(`loading baseline ${src.resource}`);
    const m = loadBaseline(src);
    for (const [strong, val] of m) {
      baselines.set(strong, { resource: src.resource, ...val });
    }
  }
  const uhlLemmas = loadUhlLemmaIndex();
  if (uhlLemmas.size > 0) console.log(`  uhl-index.json: ${uhlLemmas.size} lemmas`);

  // Phase 2: unfoldingWord overlay (markdown).
  const uwEntries = [];
  for (const src of SOURCES) {
    console.log(`processing ${src.resource}`);
    const dir = await downloadAndExtract(src.url, src.archiveRoot, src.resource);
    const entries = src.resource === "uhal" ? walkUhal(dir) : walkUgl(dir);
    console.log(`  parsed ${entries.length} uW entries`);
    uwEntries.push(...entries);
  }

  // Phase 3: merge. One row per Strong's. uW wins for lemma/POS always,
  // and for gloss/definition when uW value is non-empty; otherwise the
  // Strong's baseline fills in.
  const merged = new Map(); // strong → final row
  // Seed from baseline so Strong's-only entries still land in the table.
  for (const [strong, base] of baselines) {
    merged.set(strong, {
      strong,
      resource: base.resource,
      lemma: uhlLemmas.get(strong) ?? null,
      part_of_speech: null,
      gloss: base.gloss,
      definition: base.definition,
    });
  }
  // Overlay uW.
  for (const e of uwEntries) {
    const base = baselines.get(e.strong);
    const existing = merged.get(e.strong);
    merged.set(e.strong, {
      strong: e.strong,
      resource: e.resource,
      lemma: e.lemma ?? existing?.lemma ?? null,
      part_of_speech: e.part_of_speech ?? existing?.part_of_speech ?? null,
      gloss: e.gloss ?? base?.gloss ?? existing?.gloss ?? null,
      definition: e.definition ?? base?.definition ?? existing?.definition ?? null,
    });
  }

  const all = [...merged.values()];
  const withGloss = all.filter((e) => e.gloss);
  const withDefinition = all.filter((e) => e.definition);
  const withAnyProse = all.filter((e) => e.gloss || e.definition);
  console.log(`total merged entries: ${all.length}`);
  console.log(`  with gloss: ${withGloss.length} (${((100 * withGloss.length) / all.length).toFixed(0)}%)`);
  console.log(`  with definition: ${withDefinition.length} (${((100 * withDefinition.length) / all.length).toFixed(0)}%)`);
  console.log(`  with any prose (gloss or definition): ${withAnyProse.length} (${((100 * withAnyProse.length) / all.length).toFixed(0)}%)`);

  const sqlPath = join(outDir, "import-lexicon.sql");
  const lines = [];
  lines.push("DELETE FROM lexicon_entries;");
  const BATCH = 100;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    lines.push(
      "INSERT OR REPLACE INTO lexicon_entries (strong, resource, lemma, part_of_speech, gloss, definition) VALUES",
    );
    const values = batch.map(
      (e) =>
        `(${escapeSql(e.strong)}, ${escapeSql(e.resource)}, ${escapeSql(e.lemma)}, ${escapeSql(e.part_of_speech)}, ${escapeSql(e.gloss)}, ${escapeSql(e.definition)})`,
    );
    lines.push(values.join(",\n") + ";");
  }
  writeFileSync(sqlPath, lines.join("\n") + "\n");
  console.log(`wrote ${sqlPath} (${(lines.join("\n").length / 1024 / 1024).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

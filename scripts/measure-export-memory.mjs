#!/usr/bin/env node
// Measure the memory each suspect step of a ULT/UST nightly export needs on a
// real book (issue #1182: JER UST runs out of the Worker's 128 MB isolate).
//
// Node and the Worker share the V8 engine, but this is a Node measurement,
// not the Worker limit itself. The number that matters is the "min heap"
// column: the smallest --max-old-space-size (MB) under which the step still
// completes. That is a direct peak measurement, since V8 kills the process
// as soon as live old-space objects exceed the cap. Each run is a fresh
// child process; the "noop" step (load the file, import export.ts) is the
// baseline to subtract.
//
// Usage (from repo root):
//   curl -s -o scripts/out/24-JER-ust.usfm https://git.door43.org/unfoldingWord/en_ust/raw/branch/master/24-JER.usfm
//   node scripts/measure-export-memory.mjs scripts/out/24-JER-ust.usfm [step ...]
// Steps: noop enc-old enc-new shrink revert commit (default: all).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const exportTs = pathToFileURL(resolve(here, "../api/src/export.ts")).href;
const ALL_STEPS = ["noop", "enc-old", "enc-new", "shrink", "revert", "commit"];

// The encoder export.ts used before #1182, kept here so the harness can show
// the before number after the fix has landed.
function oldUtf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// A master that differs by one word, so the shrink guard and revert report
// compare (and commitToDcs takes the full reset + branch lookup + PUT path)
// instead of short-circuiting on equality.
function masterVariant(text) {
  const i = text.indexOf(" the ", text.length >> 1);
  if (i === -1) throw new Error(`masterVariant: no " the " in the second half of the book to edit`);
  return text.slice(0, i) + " a " + text.slice(i + 5);
}

async function runStep(step, file) {
  const text = readFileSync(file, "utf8");
  const mod = await import(exportTs);
  const master = masterVariant(text);
  globalThis.gc?.();
  const before = process.memoryUsage();
  let summary = "";
  if (step === "noop") {
    summary = `chars=${text.length}`;
  } else if (step === "enc-old") {
    summary = `b64len=${oldUtf8ToBase64(text).length}`;
  } else if (step === "enc-new") {
    summary = `b64len=${mod.utf8ToBase64(text).length}`;
  } else if (step === "shrink") {
    const r = mod.usfmAlignmentShrinkRefused(text, master);
    summary = `refused=${r.refused} offenders=${r.offenders.length}`;
  } else if (step === "revert") {
    const r = mod.usfmRevertReport(text, master, text);
    summary = `entries=${r.entries.length} totalVerses=${r.totalVerses}`;
  } else if (step === "commit") {
    const masterB64 = Buffer.from(master, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method ?? "GET";
      if (u.includes("/git/refs/heads/") && method === "GET") return json({ object: { sha: "master-sha" } });
      if (u.includes("/git/refs/heads/") && method === "PATCH") return json({ object: { sha: "master-sha" } });
      if (u.includes("/contents/") && method === "GET") return json({ sha: "old-sha", encoding: "base64", content: masterB64 });
      if (u.includes("/contents/")) return json({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
      return json({ name: "branch" });
    };
    const r = await mod.commitToDcs({ baseUrl: "https://dcs.invalid", token: "t", owner: "o", repo: "r", branch: "JER-be" }, "24-JER.usfm", text, "nightly");
    summary = `changed=${r.changed}`;
  }
  globalThis.gc?.();
  const after = process.memoryUsage();
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`${step}: ${summary} retainedHeapMB=${mb(after.heapUsed - before.heapUsed)} externalMB=${mb(after.external)} arrayBuffersMB=${mb(after.arrayBuffers)}`);
}

function tryRun(step, file, mb) {
  const r = spawnSync(process.execPath, [
    `--max-old-space-size=${mb}`, "--max-semi-space-size=1", "--expose-gc",
    "--experimental-strip-types", "--no-warnings",
    fileURLToPath(import.meta.url), "--child", step, file,
  ], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout.trim() };
}

// Smallest old-space cap (MB, 1 MB resolution) under which the step completes.
function minHeap(step, file) {
  let lo = 4, hi = 1024;
  const top = tryRun(step, file, hi);
  if (!top.ok) return { mb: `>${hi}`, out: top.out };
  let out = top.out;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const r = tryRun(step, file, mid);
    if (r.ok) { hi = mid; out = r.out; } else lo = mid;
  }
  return { mb: hi, out };
}

const args = process.argv.slice(2);
if (args[0] === "--child") {
  await runStep(args[1], args[2]);
} else {
  const [file, ...steps] = args;
  if (!file) {
    console.error("usage: node scripts/measure-export-memory.mjs <book.usfm> [step ...]");
    process.exit(2);
  }
  for (const step of steps.length ? steps : ALL_STEPS) {
    const { mb, out } = minHeap(step, file);
    console.log(`min heap ${String(mb).padStart(5)} MB  | ${out}`);
  }
}

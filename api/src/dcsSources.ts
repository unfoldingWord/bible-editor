// Shared DCS-source helpers. The first-time book import (bookImport.ts) and
// the per-chapter re-import (bookReimport.ts) both read the same set of raw
// USFM / TSV files from git.door43.org — keep the URL shape and book-prefix
// table in one place so they can't drift.

import type { Env } from "./index";

// Standard unfoldingWord book number prefixes for USFM filenames. Mirror of
// the BOOK_NUMBERS map in scripts/import-book.mjs and api/src/export.ts.
export const BOOK_NUMBERS: Record<string, string> = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19",
  PRO: "20", ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25",
  EZK: "26", DAN: "27", HOS: "28", JOL: "29", AMO: "30", OBA: "31",
  JON: "32", MIC: "33", NAM: "34", HAB: "35", ZEP: "36", HAG: "37",
  ZEC: "38", MAL: "39",
  MAT: "41", MRK: "42", LUK: "43", JHN: "44", ACT: "45",
  ROM: "46", "1CO": "47", "2CO": "48", GAL: "49", EPH: "50",
  PHP: "51", COL: "52", "1TH": "53", "2TH": "54", "1TI": "55",
  "2TI": "56", TIT: "57", PHM: "58", HEB: "59", JAS: "60",
  "1PE": "61", "2PE": "62", "1JN": "63", "2JN": "64", "3JN": "65",
  JUD: "66", REV: "67",
};

export const NT_BOOKS = new Set([
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
  "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
  "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]);

export interface DcsUrlSet {
  ult: string;
  ust: string;
  orig: string;        // hbo_uhb for OT, el-x-koine_ugnt for NT
  origVersion: "UHB" | "UGNT";
  tn: string;
  tq: string;
  twl: string;
}

// Build the set of DCS raw-content URLs for a given book. `book` is the
// uppercase 3-char canonical id (e.g. "ZEC", "1CO"). Returns null if the
// book id isn't in BOOK_NUMBERS (unknown book).
export function dcsUrls(env: Env, book: string): DcsUrlSet | null {
  const num = BOOK_NUMBERS[book];
  if (!num) return null;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const usfmName = `${num}-${book}.usfm`;
  const isNt = NT_BOOKS.has(book);
  const origRepo = isNt ? "el-x-koine_ugnt" : "hbo_uhb";
  return {
    ult: `${base}/unfoldingWord/en_ult/raw/branch/master/${usfmName}`,
    ust: `${base}/unfoldingWord/en_ust/raw/branch/master/${usfmName}`,
    orig: `${base}/unfoldingWord/${origRepo}/raw/branch/master/${usfmName}`,
    origVersion: isNt ? "UGNT" : "UHB",
    tn: `${base}/unfoldingWord/en_tn/raw/branch/master/tn_${book}.tsv`,
    tq: `${base}/unfoldingWord/en_tq/raw/branch/master/tq_${book}.tsv`,
    twl: `${base}/unfoldingWord/en_twl/raw/branch/master/twl_${book}.tsv`,
  };
}

// Best-effort text fetch. 404 / network failure → null, so callers can warn
// and continue when a single file is missing (matches the "incomplete sample
// dir" behaviour of scripts/import-book.mjs).
//
// Completeness-checked: a SHORT body (fewer bytes than the declared
// Content-Length) is a truncated fetch and is rejected, not silently accepted.
// This is the root-cause guard for the twl_PSA data-loss incident — a partial
// ~350KB read of a ~547KB file loaded 4880 of 7776 rows into D1, the watermark
// certified it "in sync", and the nightly export then shipped the partial over
// master (deleting 2,896 rows). Accepting half a file as if it were whole is
// never the right answer, so we treat it as a fetch failure: the bootstrap
// throws + retries, the reimport skips (and never stamps a false watermark).
// One retry, since the truncation is transient (not a deterministic size cap —
// larger files like tn_PSA / ISA tn fetch fine).
//
// We reject only SHORT bodies, never LONGER-than-declared ones: transparent
// gzip makes the decoded length exceed the (compressed) Content-Length, which
// is not a truncation.
//
// BLIND SPOT (the HAB tn incident, 2026-06-23/24): this declared-length check
// is BYPASSED when the response carries no Content-Length at all — HAB's raw
// endpoint apparently omits it, so a partial body slipped through twice, the
// reimport stamped the master commit SHA onto it, and the nightly prune then
// soft-deleted 559 pristine rows (twl_PSA pattern, recurring). Transport here
// cannot verify completeness without a declared length, so we at least SURFACE
// the condition (warn) — the real backstop is the reimport's row-count gate
// (tsvFetchLooksTruncated in bookReimport.ts), which rejects a body that parses
// to drastically fewer rows than the book already holds in D1. The EXPORT
// shrink guard cannot use that same D1-row-count trick (it's comparing D1
// against master, so a D1 that is itself partial from a correlated
// truncation hides rather than exposes the shrink — issue #494), so its two
// master fetches go through fetchDcsMasterText below instead of this
// function: that helper closes the same blind spot with an independent
// check (the Gitea contents API's own recorded file size) rather than
// relying on Content-Length at all.
export async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const cl = r.headers.get("content-length");
      const expected = cl == null ? null : Number(cl);
      if (expected != null && Number.isFinite(expected) && buf.byteLength < expected) {
        console.error("fetchText: short read (truncated fetch); retrying", {
          url,
          expectedBytes: expected,
          gotBytes: buf.byteLength,
          attempt,
        });
        continue;
      }
      if (expected == null) {
        // No declared length → completeness unverifiable at this layer. Log so
        // the condition that hid the HAB truncation is visible; downstream
        // callers must apply their own sanity check (see tsvFetchLooksTruncated).
        console.warn("fetchText: response has no content-length; completeness unverified", {
          url,
          gotBytes: buf.byteLength,
        });
      }
      return new TextDecoder("utf-8").decode(buf);
    } catch {
      // network error → retry once, then null
    }
  }
  return null;
}

// ── Per-resource repo/path + git-SHA helpers (incremental self-heal reimport) ──
// The reimport reads the canonical unfoldingWord source on master — the same
// org dcsUrls() hardcodes. The SHA check below MUST agree with the raw fetch on
// owner/repo/path/ref, so both derive from this one mapping.
const DCS_OWNER = "unfoldingWord";

export type ReimportResource = "ult" | "ust" | "tn" | "tq" | "twl";

// {repo, in-repo path} for a (book, resource). Mirror of dcsUrls()'s shape; null
// for an unknown book. Keep in sync with dcsUrls — the path formulas are
// identical (USFM `${num}-${BOOK}.usfm`, TSV `${res}_${BOOK}.tsv`).
export function dcsResourceFile(
  book: string,
  resource: ReimportResource,
): { repo: string; path: string } | null {
  const num = BOOK_NUMBERS[book];
  if (!num) return null;
  switch (resource) {
    case "ult": return { repo: "en_ult", path: `${num}-${book}.usfm` };
    case "ust": return { repo: "en_ust", path: `${num}-${book}.usfm` };
    case "tn":  return { repo: "en_tn",  path: `tn_${book}.tsv` };
    case "tq":  return { repo: "en_tq",  path: `tq_${book}.tsv` };
    case "twl": return { repo: "en_twl", path: `twl_${book}.tsv` };
  }
}

// Raw master-branch content URL for a repo/path (same shape dcsUrls builds).
export function dcsRawUrl(env: Env, repo: string, path: string): string {
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  return `${base}/${DCS_OWNER}/${repo}/raw/branch/master/${path}`;
}

// Latest commit SHA on master that touched `path` in `repo`, or null on
// 404 / empty history / network error. Used as the change-detection watermark
// for the incremental reimport (skip a (book,resource) whose file SHA matches
// what we last synced). Sends the service token when present so private repos
// and rate limits are handled the same way the export path is.
export async function fileCommitSha(env: Env, repo: string, path: string): Promise<string | null> {
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const url =
    `${base}/api/v1/repos/${DCS_OWNER}/${encodeURIComponent(repo)}` +
    `/commits?sha=master&path=${encodeURIComponent(path)}&limit=1&stat=false&verification=false&files=false`;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const commits = (await r.json()) as Array<{ sha?: string }>;
    return commits[0]?.sha ?? null;
  } catch {
    return null;
  }
}

// ── Independent completeness check for the EXPORT shrink guards (issue #494) ──
//
// fetchText's Content-Length check goes blind exactly when the raw endpoint
// omits the header (the HAB tn incident, documented on fetchText above). The
// reimport has its own backstop for that blind spot — tsvFetchLooksTruncated
// in bookReimport.ts, which compares the parsed row count against what D1
// already holds LIVE. The export shrink guard (exportWorkflow.ts's
// checkTsvShrink / checkUsfmAlignmentShrink) cannot reuse that same trick: it
// is comparing D1's render AGAINST master, so a D1 that is itself partial —
// e.g. from the exact same reimport truncation, which stamped a watermark
// anyway because the freshness gate only checks the commit SHA, not row
// completeness — makes the two truncated reads agree with each other and the
// shrink disappears instead of surfacing. Two correlated truncations of the
// same misbehaving endpoint, not two independent ones — see issue #494.
//
// dcsFileSize asks a SEPARATE DCS endpoint (the contents API, already used
// elsewhere in the export flow — see fetchDcsContentsNames in
// exportWorkflow.ts) for the byte size Gitea's git backend actually has on
// record for the file at `ref`. That size has nothing to do with whatever
// Content-Length (if any) the raw endpoint decided to send, so it is a
// genuinely independent source of truth fetchDcsMasterText can cross-check
// the downloaded bytes against — including in the no-Content-Length case.
export async function dcsFileSize(
  env: Env,
  repo: string,
  path: string,
  ref = "master",
): Promise<number | null> {
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const url =
    `${base}/api/v1/repos/${DCS_OWNER}/${encodeURIComponent(repo)}` +
    `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const data = (await r.json()) as { size?: number };
    return typeof data.size === "number" && Number.isFinite(data.size) ? data.size : null;
  } catch {
    return null;
  }
}

// Master-file fetch for the export shrink guards, verified against
// dcsFileSize as well as (when present) Content-Length. Same retry-once,
// null-on-failure shape as fetchText — callers already treat a null master
// fetch as `master_unreadable` and fail closed, so routing a short read
// through the SAME return value (rather than returning the truncated text) is
// what actually closes the blind spot: no new "detail" branch is needed, the
// existing fail-closed path just fires more often.
//
// Deliberately independent of fetchText rather than layered on top of it:
// fetchText only exposes the decoded string, not the raw byte length, and
// re-encoding a decoded string to recover a byte count is lossy in edge cases
// (e.g. a stripped BOM) that would make this comparison unreliable. Fetching
// once here and checking both the header and the API size against the same
// ArrayBuffer keeps the byte count exact.
export async function fetchDcsMasterText(
  env: Env,
  repo: string,
  path: string,
  ref = "master",
): Promise<string | null> {
  const url = dcsRawUrl(env, repo, path);
  const apiSize = await dcsFileSize(env, repo, path, ref);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const cl = r.headers.get("content-length");
      const expectedCl = cl == null ? null : Number(cl);
      if (expectedCl != null && Number.isFinite(expectedCl) && buf.byteLength < expectedCl) {
        console.error("fetchDcsMasterText: short read vs Content-Length; retrying", {
          url,
          expectedBytes: expectedCl,
          gotBytes: buf.byteLength,
          attempt,
        });
        continue;
      }
      // The independent check: fires whether or not Content-Length was even
      // present, so it is the part that actually covers the HAB-shaped case.
      if (apiSize != null && buf.byteLength < apiSize) {
        console.error(
          "fetchDcsMasterText: short read vs Gitea contents-API size; retrying",
          { url, apiSize, gotBytes: buf.byteLength, attempt },
        );
        continue;
      }
      if (expectedCl == null && apiSize == null) {
        // Neither independent size source was available — completeness is
        // genuinely unverifiable here. Surface it (mirrors fetchText's own
        // no-Content-Length warning) so the condition stays visible even
        // though we cannot act on it further.
        console.warn("fetchDcsMasterText: no Content-Length and no contents-API size; completeness unverified", {
          url,
          gotBytes: buf.byteLength,
        });
      }
      return new TextDecoder("utf-8").decode(buf);
    } catch {
      // network error → retry once, then null
    }
  }
  return null;
}

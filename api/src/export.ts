// Pure builders for the nightly export, plus the Gitea commit primitive.
// No D1 or Workflow knowledge lives here — exportWorkflow.ts orchestrates,
// this module just turns rows into bytes and posts bytes to DCS.

import usfm from "usfm-js";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";

export type Resource = "tn" | "tq" | "twl" | "ult" | "ust";

export const ALL_RESOURCES: Resource[] = ["tn", "tq", "twl", "ult", "ust"];

// Standard unfoldingWord USFM filename prefix.
const BOOK_NUMBERS: Record<string, string> = {
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

export function usfmFilename(book: string): string {
  const num = BOOK_NUMBERS[book] ?? "00";
  return `${num}-${book}.usfm`;
}

// ── TSV builders ─────────────────────────────────────────────────────────────
// Column order matches docs/samples/*.tsv exactly. Downstream tooling is
// positional; reorder and consumers break.

const TN_HEADERS = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence", "Note"];
const TQ_HEADERS = ["Reference", "ID", "Tags", "Quote", "Occurrence", "Question", "Response"];
const TWL_HEADERS = ["Reference", "ID", "Tags", "OrigWords", "Occurrence", "TWLink"];

// Cell escape: TSV is line-oriented, so tab/newline in a cell would corrupt
// the row. unfoldingWord convention encodes real newlines inside a Note as
// the two-character literal "\n" (already how notes are stored in D1).
function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\r\n/g, "\n").replace(/\n/g, "\\n").replace(/\t/g, " ");
}

function tsvLine(cells: unknown[]): string {
  return cells.map(tsvCell).join("\t");
}

export function buildTnTsv(rows: TnRow[]): string {
  const body = rows.map((r) =>
    tsvLine([r.ref_raw, r.id, r.tags, r.support_reference, r.quote, r.occurrence, r.note]),
  );
  return [TN_HEADERS.join("\t"), ...body].join("\n") + "\n";
}

export function buildTqTsv(rows: TqRow[]): string {
  const body = rows.map((r) =>
    tsvLine([r.ref_raw, r.id, r.tags, r.quote, r.occurrence, r.question, r.response]),
  );
  return [TQ_HEADERS.join("\t"), ...body].join("\n") + "\n";
}

export function buildTwlTsv(rows: TwlRow[]): string {
  const body = rows.map((r) =>
    tsvLine([r.ref_raw, r.id, r.tags, r.orig_words, r.occurrence, r.tw_link]),
  );
  return [TWL_HEADERS.join("\t"), ...body].join("\n") + "\n";
}

// ── USFM rebuilder ───────────────────────────────────────────────────────────

export interface UsfmInputs {
  book: string;
  bibleVersion: string;
  headers: unknown[] | null;   // usfm-js headers array, or null to synthesize
  verses: VerseRow[];
}

export function buildUsfm(input: UsfmInputs): string {
  // Group verses by chapter, parsing the stored JSON. Unreadable verses are
  // skipped rather than failing the whole book — better to ship 99% than 0%.
  const chapters: Record<string, Record<string, unknown>> = {};
  for (const v of input.verses) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(v.content_json);
    } catch {
      continue;
    }
    const ch = String(v.chapter);
    if (!chapters[ch]) chapters[ch] = {};
    // verse 0 stores the chapter-front pseudo-verse (e.g. `\d` Psalm
    // titles). usfm-js's emitter expects the literal key "front" there;
    // a numeric "0" key wouldn't be recognised and the content would
    // emit incorrectly. See importParsers.ts:extractVersesForRange.
    const verseKey = v.verse === 0 ? "front" : String(v.verse);
    chapters[ch][verseKey] = parsed;
  }

  const headers = input.headers ?? synthesizeHeaders(input.book, input.bibleVersion);
  // usfm-js wants { headers, chapters } where chapters is keyed by string and
  // each chapter's verses are keyed by string. We built it that way above.
  const usfmInput = { headers, chapters };
  return usfm.toUSFM(usfmInput as unknown as { chapters: Record<string, unknown> }, {
    forcedNewLines: true,
  });
}

function synthesizeHeaders(book: string, bibleVersion: string): unknown[] {
  return [
    { tag: "id", content: `${book} ${bibleVersion} — bible-editor export` },
    { tag: "usfm", content: "3.0" },
    { tag: "ide", content: "UTF-8" },
    { tag: "h", content: book },
    { tag: "toc1", content: book },
    { tag: "toc2", content: book },
    { tag: "toc3", content: book.toLowerCase() },
    { tag: "mt1", content: book },
  ];
}

// ── Resource → repo + path conventions ───────────────────────────────────────
// unfoldingWord splits each resource into its own repo. The exporter assumes
// the same convention; if a deploy ever needs different repo names, the names
// can be overridden via env (see exportWorkflow.ts).

export interface ResourceTarget {
  repo: string;
  path: (book: string) => string;
  bibleVersion?: string;
}

export const RESOURCE_TARGETS: Record<Resource, ResourceTarget> = {
  tn:  { repo: "en_tn",  path: (b) => `tn_${b}.tsv` },
  tq:  { repo: "en_tq",  path: (b) => `tq_${b}.tsv` },
  twl: { repo: "en_twl", path: (b) => `twl_${b}.tsv` },
  ult: { repo: "en_ult", path: usfmFilename, bibleVersion: "ULT" },
  ust: { repo: "en_ust", path: usfmFilename, bibleVersion: "UST" },
};

// ── Gitea contents API ───────────────────────────────────────────────────────

export interface DcsCommitConfig {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface DcsCommitResult {
  contentSha: string;
  commitSha: string;
  changed: boolean;       // false when the file is already at this content
}

// Encode a UTF-8 string as base64 (the Gitea contents API expects base64).
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// PUT /api/v1/repos/:owner/:repo/contents/:path
// - GET first to discover any existing SHA. 404 = new file.
// - PUT if SHA exists (update), POST if not (create).
// - Returns the new content SHA + the resulting commit SHA so the caller can
//   record both for traceability.
export async function commitToDcs(
  config: DcsCommitConfig,
  path: string,
  content: string,
  message: string,
): Promise<DcsCommitResult> {
  const headers: Record<string, string> = {
    Authorization: `token ${config.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const base = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  // Lookup existing SHA for this path on this branch.
  let existingSha: string | null = null;
  let existingContent: string | null = null;
  const getRes = await fetch(`${base}?ref=${encodeURIComponent(config.branch)}`, {
    method: "GET",
    headers,
  });
  if (getRes.ok) {
    const data = (await getRes.json()) as { sha?: string; content?: string; encoding?: string };
    existingSha = data.sha ?? null;
    if (data.encoding === "base64" && typeof data.content === "string") {
      try {
        existingContent = atob(data.content.replace(/\s+/g, ""));
      } catch {
        existingContent = null;
      }
    }
  } else if (getRes.status !== 404) {
    throw new Error(`dcs_lookup_failed: ${getRes.status} ${await getRes.text()}`);
  }

  // No-op when the file already matches. Saves a commit per nightly run for
  // resources nobody touched.
  if (existingContent !== null && existingContent === content) {
    return { contentSha: existingSha ?? "", commitSha: "", changed: false };
  }

  const body: Record<string, unknown> = {
    message,
    branch: config.branch,
    content: utf8ToBase64(content),
  };
  if (existingSha) body.sha = existingSha;

  const method = existingSha ? "PUT" : "POST";
  const res = await fetch(base, { method, headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`dcs_commit_failed: ${method} ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content?: { sha?: string };
    commit?: { sha?: string };
  };
  return {
    contentSha: data.content?.sha ?? "",
    commitSha: data.commit?.sha ?? "",
    changed: true,
  };
}

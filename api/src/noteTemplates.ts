import { Hono } from "hono";
import type { Env } from "./index";

// Curated per-support-reference note templates live in a Google Sheet the
// translation team edits (irregularly, ~weekly). We proxy + parse the sheet's
// CSV export and serve it as JSON keyed by short support reference
// (e.g. "figs-metaphor"). The result is cached at the Cloudflare edge in
// "buckets" aligned to 08:00 / 12:00 / 16:00 America/New_York, so a sheet edit
// goes live shortly after the next boundary without a redeploy, while between
// boundaries every request is served from cache. Cloudflare cron is UTC-only
// and can't express Eastern across DST, which is why this is a lazy time-keyed
// edge cache rather than a scheduled refresh.
export const noteTemplates = new Hono<{ Bindings: Env }>();

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1ot6A7RxcsxM_Wv94sauoTAaRPO5Q-gynFqMHeldnM64/export?format=csv&gid=1419396008";

// ET wall-clock hours at which the cache rolls over to a fresh fetch.
const BOUNDARY_HOURS_ET = [8, 12, 16];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NoteTemplate {
  type: string;
  body: string;
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields containing commas,
// newlines, and "" escapes. Sufficient for the sheet export. Returns rows of
// string cells.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") {
      cur += ch;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// Build the ref -> [{type, body}] map. Assumes a header row
// (support reference, type, note template). Trims the key + type (one sheet
// row carries a trailing space in the ref) and trims outer whitespace on the
// body; skips rows with a blank ref or blank body. Preserves sheet order.
function buildTemplates(rows: string[][]): Record<string, NoteTemplate[]> {
  const out: Record<string, NoteTemplate[]> = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ref = (r[0] ?? "").trim();
    const body = (r[2] ?? "").trim();
    if (!ref || !body) continue;
    const type = (r[1] ?? "").trim();
    (out[ref] ??= []).push({ type, body });
  }
  return out;
}

// Minutes east of UTC for America/New_York at `at` (negative in the Americas).
// Parses Intl's "shortOffset" zone name, e.g. "GMT-4" / "GMT-5".
function easternOffsetMinutes(at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = name.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!m) return -300;
  const hours = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -mins : mins);
}

// UTC epoch (ms) of a given ET wall-clock hour on the ET calendar day that
// contains `at`. DST-correct to within the (rare) hour around a transition,
// since the offset is sampled at `at`.
function etBoundaryUtcMs(at: Date, hourET: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const mo = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const offsetMs = easternOffsetMinutes(at) * 60_000;
  // ET wall time -> UTC: subtract the signed offset.
  return Date.UTC(y, mo - 1, d, hourET, 0, 0) - offsetMs;
}

// The active cache bucket (start of the current ET window) and the next
// boundary (for max-age). Before today's first boundary the bucket reaches
// back to yesterday's last boundary.
function currentBucket(nowMs: number): { bucketMs: number; nextMs: number } {
  const now = new Date(nowMs);
  const today = BOUNDARY_HOURS_ET.map((h) => etBoundaryUtcMs(now, h));
  const passed = today.filter((b) => b <= nowMs);
  const lastHour = BOUNDARY_HOURS_ET[BOUNDARY_HOURS_ET.length - 1];
  if (passed.length === 0) {
    const yesterday = new Date(nowMs - DAY_MS);
    return { bucketMs: etBoundaryUtcMs(yesterday, lastHour), nextMs: today[0] };
  }
  const bucketMs = passed[passed.length - 1];
  const future = today.find((b) => b > nowMs);
  const nextMs = future ?? etBoundaryUtcMs(new Date(nowMs + DAY_MS), BOUNDARY_HOURS_ET[0]);
  return { bucketMs, nextMs };
}

// Isolate-global memo: the Cache API (caches.default) is a no-op on
// *.workers.dev domains, and prod is bible-editor-api.unfoldingword.workers.dev,
// so without this every request to this UNAUTHENTICATED route would live-fetch
// the Google Sheet (and could be hammered into rate-limiting it). Module-scope
// state survives across requests in a warm isolate; keyed on the time bucket so
// it self-invalidates at each ET boundary. The Cache API stays as a second
// layer (harmless where it works, e.g. custom domains).
let memo: { bucketMs: number; body: string } | null = null;

noteTemplates.get("/", async (c) => {
  const nowMs = Date.now();
  const { bucketMs, nextMs } = currentBucket(nowMs);

  if (memo && memo.bucketMs === bucketMs) {
    const maxAge = Math.max(60, Math.floor((nextMs - nowMs) / 1000));
    return new Response(memo.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${maxAge}`,
      },
    });
  }

  // Synthetic key (never fetched) — changes only when the bucket rolls over.
  const cacheKey = new Request(`https://note-templates.internal/v1?bucket=${bucketMs}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let csv: string;
  try {
    const upstream = await fetch(SHEET_CSV_URL, { headers: { accept: "text/csv" } });
    if (!upstream.ok) return c.json({ error: "templates_unavailable" }, 502);
    csv = await upstream.text();
  } catch {
    return c.json({ error: "templates_unavailable" }, 502);
  }

  const templates = buildTemplates(parseCsv(csv));
  const body = JSON.stringify({ templates });
  memo = { bucketMs, body };
  const maxAge = Math.max(60, Math.floor((nextMs - nowMs) / 1000));
  const response = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
});

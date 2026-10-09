// Which tn notes an AI notes run must leave in place (issue #1152), and the
// `options.kept` list that tells the bot so.
//
// The bot (bp-assistant, KeptSchema in src/api/pipeline.js) cannot learn this
// from the TSV: the export always blanks the Tags column, so a note a
// translator kept shows up in master looking like any other. Without the list,
// every notes run deleted the kept notes from en_tn, let the AI write
// duplicates, and the next export put the originals back (EZK 40, 2026-10-06).
//
// A note is "kept" when it is worth defending against an AI re-run:
//   - the translator marked it preserve;
//   - a person really edited it (content, verse/reference or occurrence
//     differs from what the AI last wrote);
//   - it came from the 2 Kings -> Isaiah migration (decision D4);
//   - the AI expanded it from a translator's hint (decision D5).
// Pristine rows (updated_by NULL) are never kept.
//
// "Really edited" is the hard part: `updated_by` is set by reorders,
// whitespace-only saves, edits reverted to the AI text, and repair scripts, so
// it over-reports by ~9% (research on #1152). classifyKept replays the row's
// edit_log content forward and compares the live content to the AI baseline.

import type { Env } from "./index.ts";

const AI_SOURCE = "ai_pipeline";
const MIGRATION_SOURCE = "parallel_migration";
const HINT_SOURCE = "hint_expansion";
// Scripts that rewrite quotes in bulk; their edit_log rows must never look
// like a person's edit (scan-tn-quotes / rollback-tn-quotes, see PR C).
const REPAIR_SOURCES = new Set(["quote_repair"]);
// The one scan-tn-quotes burst from before those scripts labelled their rows:
// user 2, source NULL, 37 rows across 7 books, all written in the same second
// (2026-09-11 02:04:25 UTC). Looked up in prod with scripts/d1-select.mjs.
const REPAIR_USER_ID = 2;
const REPAIR_BATCH_TIMESTAMPS = new Set([1789092265]);

const FIELDS = ["quote", "note", "support_reference"] as const;
type Field = (typeof FIELDS)[number];
type Content = Record<Field, string>;
const EMPTY: Content = { quote: "", note: "", support_reference: "" };

// Where the note sits (#1180): a person's verse move (PATCH verse + ref_raw)
// or occurrence fix is an edit too. Compared only on the replayed edit_log,
// never on the live row: the Door43 reimport rewrites ref_raw/verse/occurrence
// without always logging them (its creates log `refRaw`, some of its updates
// log no payload), so live position can drift with no person involved.
// undefined = no logged write has set the field yet; an unknown value on
// either side is never a difference.
const POSITION = ["verse", "ref_raw", "occurrence"] as const;
type PositionField = (typeof POSITION)[number];
type Position = Record<PositionField, string | undefined>;
type State = Content & Position;
const EMPTY_STATE: State = { ...EMPTY, verse: undefined, ref_raw: undefined, occurrence: undefined };

export interface KeptRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  quote: string | null;
  note: string | null;
  support_reference: string | null;
  preserve: number;
}

export interface KeptLogEntry {
  action: string; // create | update | restore (others are ignored)
  source: string | null;
  user_id: number | null;
  created_at: number;
  payload_json: string | null;
}

export type KeptReason =
  | "preserve"
  | "migration"
  | "hint"
  | "edited"
  | "unexplained"
  | "fallback"
  | null;

// Comparison only; never stored or sent. Folds the differences that make two
// texts "the same note" to a translator: literal "\n" escapes vs newlines,
// Unicode composition order, curly vs straight quotes, dash and ellipsis
// variants, and whitespace runs.
export function normalizeForCompare(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\\n/g, "\n")
    .normalize("NFC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function contentOf(row: Pick<KeptRow, Field>): Content {
  return {
    quote: normalizeForCompare(row.quote),
    note: normalizeForCompare(row.note),
    support_reference: normalizeForCompare(row.support_reference),
  };
}

function sameContent(a: Content, b: Content): boolean {
  return FIELDS.every((f) => a[f] === b[f]);
}

function parsePayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function samePosition(a: Position, b: Position): boolean {
  return POSITION.every((f) => a[f] === undefined || b[f] === undefined || a[f] === b[f]);
}

function applyPayload(state: State, raw: Record<string, unknown>): State {
  // The Door43 reimport logs its parsed row, whose reference is `refRaw`.
  const payload =
    "refRaw" in raw && !("ref_raw" in raw) ? { ...raw, ref_raw: raw.refRaw } : raw;
  const next = { ...state };
  for (const f of FIELDS) {
    if (f in payload) {
      const v = payload[f];
      next[f] = normalizeForCompare(typeof v === "string" ? v : null);
    }
  }
  for (const f of POSITION) {
    if (f in payload) {
      const v = payload[f];
      next[f] = v == null ? "" : String(v).trim();
    }
  }
  // The reimport logs chapter/verse but not the ref_raw it also wrote, so
  // after such a write the replayed ref_raw is no longer known, unless it
  // still starts at the logged chapter:verse (the torn-row heal, #672, sets
  // chapter/verse from the row's own ref_raw and leaves ref_raw alone).
  if (("chapter" in payload || "verse" in payload) && !("ref_raw" in payload)) {
    const m = next.ref_raw?.match(/^(\d+):(\d+)/);
    const fits =
      m != null &&
      (!("chapter" in payload) || String(payload.chapter).trim() === String(Number(m[1]))) &&
      next.verse === String(Number(m[2]));
    if (!fits) next.ref_raw = undefined;
  }
  return next;
}

function isRepair(e: KeptLogEntry): boolean {
  if (e.source != null) return REPAIR_SOURCES.has(e.source);
  return e.user_id === REPAIR_USER_ID && REPAIR_BATCH_TIMESTAMPS.has(e.created_at);
}

// A person's content change: source NULL with a user, not a known repair, and
// either a create with an empty note (a person started the note) or an
// update/restore whose payload changes quote, note or support_reference after
// normalizing, or moves the note (verse, ref_raw) or changes its occurrence
// (#1180). AI Suggest output a person saves arrives as an ordinary save
// and counts (D3). Reorders (payload only sort_order), whitespace-only saves
// and tag-only saves change nothing after normalizing, so they do not count.
function isHumanEvent(e: KeptLogEntry, before: State, after: State): boolean {
  if (e.source != null || e.user_id == null || isRepair(e)) return false;
  if (e.action === "create") return after.note === "";
  return !sameContent(before, after) || !samePosition(before, after);
}

export function classifyKept(
  row: KeptRow,
  allEntries: KeptLogEntry[],
): { kept: boolean; reason: KeptReason } {
  if (row.preserve === 1) return { kept: true, reason: "preserve" };

  const content = allEntries.filter(
    (e) => e.action === "create" || e.action === "update" || e.action === "restore",
  );
  // A later create means the id was reclaimed; only the last life counts
  // (same bound as rowHistoryBoundary.ts).
  let start = 0;
  content.forEach((e, i) => {
    if (e.action === "create") start = i;
  });
  const entries = content.slice(start);

  let lastAi = -1;
  let lastMigration = -1;
  entries.forEach((e, i) => {
    if (e.source === AI_SOURCE) lastAi = i;
    if (e.source === MIGRATION_SOURCE) lastMigration = i;
  });
  if (lastMigration > lastAi) return { kept: true, reason: "migration" };
  if (entries.length > 0 && entries[entries.length - 1].source === HINT_SOURCE) {
    return { kept: true, reason: "hint" };
  }

  // No create in the log (history pruned after 180 days, or an imported row):
  // there is no full-row baseline to replay, so fall back to the coarse rule
  // that keeps whenever the latest content write was not the AI's. Conservative:
  // it errs toward keeping.
  if (entries.length === 0 || entries[0].action !== "create") {
    const latest = entries[entries.length - 1];
    return latest?.source === AI_SOURCE
      ? { kept: false, reason: null }
      : { kept: true, reason: "fallback" };
  }

  // states[i] is the normalized content and position right after entries[i].
  const states: State[] = [];
  const human: boolean[] = [];
  let state = EMPTY_STATE;
  for (const e of entries) {
    const next = applyPayload(state, parsePayload(e.payload_json));
    human.push(isHumanEvent(e, state, next));
    states.push(next);
    state = next;
  }

  let baseline: State;
  let firstHuman = -1;
  if (lastAi >= 0) {
    baseline = states[lastAi];
    firstHuman = human.findIndex((h, i) => h && i > lastAi);
  } else {
    firstHuman = human.findIndex((h) => h);
    baseline = firstHuman <= 0 ? EMPTY_STATE : states[firstHuman - 1];
  }
  // Live content the log cannot explain: an update aged out of edit_log (the
  // 180-day sweep) after a person made it. Someone changed the note, so keep.
  // Content only: live position can drift unlogged (see POSITION).
  const live = contentOf(row);
  const last = states[states.length - 1];
  if (!sameContent(live, last)) {
    return { kept: true, reason: "unexplained" };
  }
  if (firstHuman < 0) return { kept: false, reason: null };
  return sameContent(live, baseline) && samePosition(last, baseline)
    ? { kept: false, reason: null }
    : { kept: true, reason: "edited" };
}

// ── The bot's wire format ────────────────────────────────────────────────

export interface KeptOption {
  rowId: string;
  ref: string;
  supportReference: string;
  quote: string;
}

const ROW_ID_RE = /^[a-z][a-z0-9]{3}$/;
const REF_RE = /^\d+:(\d+(-\d+(:\d+)?)?|intro|front)$/;
const MAX_REF = 20;
const MAX_SUPPORT_REFERENCE = 100;
const MAX_QUOTE = 500;
export const MAX_KEPT = 3000;

function refRunsBackwards(ref: string): boolean {
  const m = ref.match(/^(\d+):(\d+)-(?:(\d+):)?(\d+)$/);
  if (!m) return false;
  const c1 = Number(m[1]);
  const c2 = m[3] ? Number(m[3]) : c1;
  return !(c1 < c2 || (c1 === c2 && Number(m[2]) <= Number(m[4])));
}

// One bad entry makes the bot 400 the whole run, so every entry is checked
// against its schema here. Returns null for a row the bot would reject (it
// stays safe in D1; it just is not protected from the AI). The note is not
// sent: the bot does not use it. An over-long quote is sent empty: an empty
// quote still protects by id and by support reference.
export function toKeptOption(row: KeptRow): KeptOption | null {
  let ref = row.ref_raw;
  // A comma list ("40:2,4", "1:1,3-5") has no form in the bot's schema; send
  // the leading verse so the row is still kept by id.
  if (ref && ref.includes(",") && /^\d+:\d+[\d,\-]*$/.test(ref) && row.chapter > 0 && row.verse > 0) {
    ref = `${row.chapter}:${row.verse}`;
  }
  if (!ROW_ID_RE.test(row.id)) return null;
  if (!ref || ref.length > MAX_REF || !REF_RE.test(ref) || refRunsBackwards(ref)) return null;
  const quote = row.quote ?? "";
  return {
    rowId: row.id,
    ref,
    supportReference: (row.support_reference ?? "").slice(0, MAX_SUPPORT_REFERENCE),
    quote: quote.length > MAX_QUOTE ? "" : quote,
  };
}

// ── D1 loading ───────────────────────────────────────────────────────────

// D1 caps bound parameters at 100 per statement; 1 fixed (book) + 90 ids.
const ID_CHUNK = 90;

export interface KeptLoad {
  rows: { row: KeptRow; reason: Exclude<KeptReason, null> }[];
  candidates: number;
}

// The create/update/restore history of each id, in log order. Shared with the
// import sweep (deleteUnkeptTns) so it replays the same history the kept list
// was built from.
export async function loadEditLogs(
  env: Env,
  book: string,
  ids: string[],
): Promise<Map<string, KeptLogEntry[]>> {
  const logs = new Map<string, KeptLogEntry[]>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK);
    const placeholders = slice.map((_, idx) => `?${idx + 2}`).join(", ");
    const el = await env.DB.prepare(
      `SELECT row_key, action, source, user_id, created_at, payload_json
         FROM edit_log
        WHERE kind = 'tn' AND (book = ?1 OR book IS NULL)
          AND action IN ('create', 'update', 'restore')
          AND row_key IN (${placeholders})
        ORDER BY id`,
    )
      .bind(book, ...slice)
      .all<KeptLogEntry & { row_key: string }>();
    for (const e of el.results ?? []) {
      const list = logs.get(e.row_key);
      if (list) list.push(e);
      else logs.set(e.row_key, [e]);
    }
  }
  return logs;
}

// The kept notes among the live, non-hint, non-trashed rows of the chapter
// range. Pristine rows (updated_by NULL) are never candidates, except that a
// preserve row always is.
export async function loadKeptTns(
  env: Env,
  book: string,
  startChapter: number,
  endChapter: number,
): Promise<KeptLoad> {
  const rs = await env.DB.prepare(
    `SELECT id, book, chapter, verse, ref_raw, quote, note, support_reference, preserve
       FROM tn_rows
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3
        AND deleted_at IS NULL AND trashed_at IS NULL AND hint = 0
        AND (preserve = 1 OR updated_by IS NOT NULL)
      ORDER BY chapter, verse, sort_order, id`,
  )
    .bind(book, startChapter, endChapter)
    .all<KeptRow>();
  const candidates = rs.results ?? [];

  const logs = await loadEditLogs(
    env,
    book,
    candidates.filter((r) => r.preserve !== 1).map((r) => r.id),
  );

  const rows: KeptLoad["rows"] = [];
  for (const row of candidates) {
    const verdict = classifyKept(row, logs.get(row.id) ?? []);
    if (verdict.kept && verdict.reason) rows.push({ row, reason: verdict.reason });
  }
  return { rows, candidates: candidates.length };
}

export class TooManyKeptError extends Error {
  count: number;
  constructor(count: number) {
    super(`too many kept notes for one run (${count}, limit ${MAX_KEPT}); run fewer chapters`);
    this.count = count;
  }
}

// What dispatchNext sends as options.kept. Throws TooManyKeptError rather
// than truncating: a silently dropped kept note is a deleted note.
export async function buildKeptOption(
  env: Env,
  book: string,
  startChapter: number,
  endChapter: number,
  hintRowIds: ReadonlySet<string> = new Set(),
): Promise<KeptOption[]> {
  const { rows } = await loadKeptTns(env, book, startChapter, endChapter);
  const out: KeptOption[] = [];
  let skipped = 0;
  for (const { row } of rows) {
    if (hintRowIds.has(row.id)) continue; // a row is a hint or kept, never both
    const opt = toKeptOption(row);
    if (opt) out.push(opt);
    else skipped++;
  }
  if (skipped > 0) {
    console.warn(
      `[kept] ${book} ${startChapter}-${endChapter}: ${skipped} kept note(s) not sent (id or ref outside the bot's format)`,
    );
  }
  if (out.length > MAX_KEPT) throw new TooManyKeptError(out.length);
  return out;
}

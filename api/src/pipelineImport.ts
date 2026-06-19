// Pulls a done pipeline_jobs row's output[] from Door43, parses each file,
// and stages the rows into pending_imports for translator review (Phase 2).
//
// Called from the GET /api/pipelines/:jobId handler when the upstream poll
// surfaces state='done' for the first time. Idempotent on re-poll: a complete-
// staging marker (pipeline_jobs.staged_at) short-circuits the parse once the
// full proposal set has landed; an incomplete prior attempt is restaged.

import type { Env } from "./index";
import {
  collectSourceWords,
  extractVersesForRange,
  healReplacementChars,
  normalizeNoteWhitespace,
  parseTsv,
  recomputeTargetOccurrences,
  refParts,
  stripOrphanAlignmentMarkers,
  type VerseExtract,
} from "./importParsers";
import { NT_BOOKS } from "./dcsSources";
import { newRowId, isValidRowId } from "./rowId";

interface OutputEntry {
  type?: string;
  repo?: string;
  branch?: string;
  path?: string;
  rawUrl?: string;
  prNumber?: number;
  mergedAt?: string;
  commitSha?: string;
}

interface ImportContext {
  jobId: string;
  pipelineType: "generate" | "notes" | "tqs" | string;
  book: string;
  startChapter: number;
  endChapter: number;
}

export interface ImportResult {
  inserted: number;
  byKind: { tn: number; tq: number; verse: number };
  skipped: string[];           // human-readable reasons (one per output entry skipped)
  applied?: ApplyResult;
}

// Classify a single output[] entry into the resource kind we know how to
// parse. Returns null for entries we don't recognize — those get surfaced
// in result.skipped and the job is otherwise marked imported.
type Classification =
  | { kind: "verse"; bibleVersion: "ULT" | "UST"; format: "usfm" }
  | { kind: "tn"; format: "tsv" }
  | { kind: "tq"; format: "tsv" }
  | { kind: "unknown" };

function classify(entry: OutputEntry): Classification {
  const repo = (entry.repo ?? "").toLowerCase();
  // Trailing match — repo strings look like "unfoldingWord/en_ult" or sometimes
  // just "en_ult"; either way the last path segment is what we want.
  const tail = repo.split("/").pop() ?? "";
  if (tail.endsWith("en_ult")) return { kind: "verse", bibleVersion: "ULT", format: "usfm" };
  if (tail.endsWith("en_ust")) return { kind: "verse", bibleVersion: "UST", format: "usfm" };
  if (tail.endsWith("en_tn")) return { kind: "tn", format: "tsv" };
  if (tail.endsWith("en_tq")) return { kind: "tq", format: "tsv" };
  return { kind: "unknown" };
}

async function fetchText(rawUrl: string): Promise<string> {
  const r = await fetch(rawUrl);
  if (!r.ok) {
    throw new Error(`fetch ${rawUrl} -> ${r.status}`);
  }
  return await r.text();
}

interface StagedRow {
  kind: "tn" | "tq" | "verse";
  chapter: number;
  verse: number;
  bibleVersion: string | null;
  payload: Record<string, unknown>;
}

function tnPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  return {
    chapter: ch,
    verse: v,
    payload: {
      id: row["ID"] || null,
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: row["Tags"] || null,
      support_reference: row["SupportReference"] || null,
      quote: row["Quote"] || null,
      occurrence,
      // Collapse bp-assistant's double-space-after-punctuation artifact so the
      // stored note matches DCS master's normalized form (see
      // normalizeNoteWhitespace) — both apply paths (applyTnInsert and the hint
      // expansion) and the edit_log audit read this same staged note.
      note: row["Note"] ? normalizeNoteWhitespace(row["Note"]) : null,
    },
  };
}

function tqPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  return {
    chapter: ch,
    verse: v,
    payload: {
      id: row["ID"] || null,
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: row["Tags"] || null,
      quote: row["Quote"] || null,
      occurrence,
      question: row["Question"] || null,
      response: row["Response"] || null,
    },
  };
}

function versePayload(book: string, bibleVersion: "ULT" | "UST", v: VerseExtract) {
  return {
    book,
    chapter: v.chapter,
    verse: v.verse,
    verse_end: v.verseEnd,
    bible_version: bibleVersion,
    content_json: v.contentJson,
    plain_text: v.plainText,
  };
}

async function parseOutputEntry(
  ctx: ImportContext,
  entry: OutputEntry,
): Promise<{ staged: StagedRow[]; skipReason?: string }> {
  if (!entry.rawUrl) return { staged: [], skipReason: "missing rawUrl" };
  const cls = classify(entry);
  if (cls.kind === "unknown") {
    return { staged: [], skipReason: `unrecognized repo: ${entry.repo ?? "(none)"}` };
  }

  const raw = await fetchText(entry.rawUrl);
  const staged: StagedRow[] = [];

  if (cls.format === "tsv") {
    const { rows } = parseTsv(raw);
    for (const row of rows) {
      const refRaw = row["Reference"];
      if (!refRaw) continue;
      const [ch] = refParts(refRaw);
      if (ch < ctx.startChapter || ch > ctx.endChapter) continue;
      const built = cls.kind === "tn"
        ? tnPayload(ctx.book, refRaw, row)
        : tqPayload(ctx.book, refRaw, row);
      staged.push({
        kind: cls.kind,
        chapter: built.chapter,
        verse: built.verse,
        bibleVersion: null,
        payload: built.payload,
      });
    }
    return { staged };
  }

  // USFM
  const verses = extractVersesForRange(raw, ctx.startChapter, ctx.endChapter);
  for (const v of verses) {
    staged.push({
      kind: "verse",
      chapter: v.chapter,
      verse: v.verse,
      bibleVersion: cls.bibleVersion,
      payload: versePayload(ctx.book, cls.bibleVersion, v),
    });
  }
  return { staged };
}

// Top-level entry. Two phases:
//   1. STAGE — fetch each rawUrl, parse, INSERT into pending_imports.
//      Idempotent on the pipeline_jobs.staged_at marker, written only after
//      the last chunk commits; a partial prior stage is dropped and redone.
//   2. APPLY — for every unresolved pending_imports row, mutate the live
//      tn_rows / tq_rows / verses tables and mark accepted_at.
//      Idempotent at the per-row level (accepted_at IS NULL filter) plus
//      the TN-delete phase, which only targets unkept rows.
//
// Throws on hard errors (Door43 fetch failure, malformed input, batch error).
// Callers should NOT mark output_json in pipeline_jobs unless this resolves
// successfully — that's how the next poll re-runs apply after a partial
// failure.
export async function importJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
): Promise<ImportResult> {
  const stageResult = await stageJobOutput(env, job, outputs);
  const applyResult = await applyJobOutput(env, job);
  return { ...stageResult, applied: applyResult };
}

async function stageJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
): Promise<ImportResult> {
  // Idempotency guard: staged_at is written ONLY after the final chunk below
  // commits, so it — not the mere existence of a pending_imports row — is the
  // authoritative "full proposal set is present" signal. Staging spans many
  // D1 batch() calls (each atomic, the whole loop is not), so a mid-chunk
  // crash leaves a PARTIAL set; keying idempotency on row-existence would let
  // the retry apply that partial set and mark the job imported. See migration
  // 0030. With the marker set, apply picks up any still-unresolved rows.
  const marker = await env.DB.prepare(
    `SELECT staged_at FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{ staged_at: number | null }>();
  if (marker?.staged_at != null) {
    return { inserted: 0, byKind: { tn: 0, tq: 0, verse: 0 }, skipped: ["already staged"] };
  }

  // No complete-staging marker: either this is the first run, or a prior
  // attempt died mid-chunk. Drop any partial, still-unresolved rows from that
  // dead attempt and restage from scratch so apply never runs against a
  // partial set. (Apply runs AFTER staging in importJobOutput, so for this job
  // nothing is accepted yet; the accepted/rejected filter is belt-and-
  // suspenders against a translator resolving a partial row in the retry gap.)
  await env.DB.prepare(
    `DELETE FROM pending_imports
      WHERE job_id = ?1 AND accepted_at IS NULL AND rejected_at IS NULL`,
  )
    .bind(job.jobId)
    .run();

  const skipped: string[] = [];
  const allStaged: StagedRow[] = [];
  for (const entry of outputs) {
    const { staged, skipReason } = await parseOutputEntry(job, entry);
    if (skipReason) skipped.push(skipReason);
    allStaged.push(...staged);
  }

  // Batch insert in chunks. D1 batch() caps at 100 statements per call.
  const stmt = env.DB.prepare(
    `INSERT INTO pending_imports
       (job_id, kind, book, chapter, verse, bible_version, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );

  const CHUNK = 100;
  let inserted = 0;
  const byKind = { tn: 0, tq: 0, verse: 0 };
  for (let i = 0; i < allStaged.length; i += CHUNK) {
    const chunk = allStaged.slice(i, i + CHUNK);
    await env.DB.batch(
      chunk.map((s) =>
        stmt.bind(
          job.jobId,
          s.kind,
          job.book,
          s.chapter,
          s.verse,
          s.bibleVersion,
          JSON.stringify(s.payload),
        ),
      ),
    );
    inserted += chunk.length;
    for (const s of chunk) byKind[s.kind] += 1;
  }

  // Mark staging complete only after the last chunk committed (also covers the
  // zero-row case — staging is then vacuously complete). Any throw above leaves
  // staged_at NULL; importJobOutput's caller leaves output_json NULL on throw,
  // so the next poll re-enters here and restages cleanly.
  await env.DB.prepare(
    `UPDATE pipeline_jobs SET staged_at = unixepoch() WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .run();

  return { inserted, byKind, skipped };
}

// ── Apply phase ───────────────────────────────────────────────────────────

export interface ApplyResult {
  tnDeleted: number;
  tnCreated: number;
  tnHintExpanded: number;
  tqCreated: number;
  tqUpdated: number;
  verseUpdated: number;
}

interface PendingImportRow {
  id: number;
  kind: "tn" | "tq" | "verse";
  book: string;
  chapter: number;
  verse: number;
  bible_version: string | null;
  payload_json: string;
}

const AI_SOURCE = "ai_pipeline";

// Row-id grammar + validation now live in rowId.ts (ROW_ID_RE / isValidRowId),
// shared with the reimport's coerceRowId guard. bp-assistant normally emits a
// valid id for every TN row (hinted or not), and it's what gets pushed to
// master; preserving it keeps D1 and master ids in lockstep. Only a malformed id
// (the occasional incomplete emit) is replaced with a freshly minted one below.

async function applyJobOutput(env: Env, job: ImportContext): Promise<ApplyResult> {
  // Look up the pipeline-starter's user id — every audit and updated_by
  // write is attributed to them, matching the contract that says the run
  // was triggered on their behalf.
  const starter = await env.DB.prepare(
    `SELECT user_id FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{ user_id: number }>();
  if (!starter) throw new Error(`apply: pipeline_jobs row not found for ${job.jobId}`);
  const userId = starter.user_id;

  // All unresolved proposals for this job, in stable order so retries do
  // the same work in the same sequence.
  const rs = await env.DB.prepare(
    `SELECT id, kind, book, chapter, verse, bible_version, payload_json
       FROM pending_imports
      WHERE job_id = ?1
        AND accepted_at IS NULL AND rejected_at IS NULL
      ORDER BY kind, chapter, verse, id`,
  )
    .bind(job.jobId)
    .all<PendingImportRow>();
  const rows = rs.results ?? [];

  const tnProposals = rows.filter((r) => r.kind === "tn");
  const tqProposals = rows.filter((r) => r.kind === "tq");
  const verseProposals = rows.filter((r) => r.kind === "verse");

  const result: ApplyResult = {
    tnDeleted: 0,
    tnCreated: 0,
    tnHintExpanded: 0,
    tqCreated: 0,
    tqUpdated: 0,
    verseUpdated: 0,
  };

  // TN delete phase: only fires when this job produced TN proposals AND
  // there are unkept TNs in scope. Idempotent — re-running finds none left.
  if (tnProposals.length > 0) {
    result.tnDeleted = await deleteUnkeptTns(env, job, userId);
  }

  // sort_order assignment. Proposals arrive ordered (chapter, verse, id) where
  // id is the staging order = the AI file's row order, so a per-verse counter
  // reproduces the source file order on export. For TN we seed each verse's
  // counter from the MAX sort_order of the rows that SURVIVED the delete phase
  // (preserve=1 / hint=1 / translator-edited), so freshly minted AI notes
  // append after the translator's kept notes rather than colliding with them.
  // For TQ there's no delete/preserve concept — every run fully reorders the
  // verse to match the file — so its counters start from zero.
  const tnBases = await maxSortOrderPerVerse(env, "tn_rows", job);
  const tnCounters = new Map<number, number>();
  const tqCounters = new Map<number, number>();
  const verseKey = (p: PendingImportRow) => p.chapter * 100000 + p.verse;

  for (const p of tnProposals) {
    // Hint expansion: if the AI's proposed id matches a queued hint stub in
    // this job's scope, UPDATE that row in place instead of minting a new
    // one. The hint's rowId round-trips through bp-assistant as the TSV ID
    // column — see docs/bp-assistant-tn-hints-contract.md. The stub keeps the
    // sort_order it was created with (it's a surviving row, already folded
    // into tnBases), so we don't consume a counter slot for it.
    const expanded = await applyTnHintExpansionIfMatch(env, p, job, userId);
    if (expanded) {
      result.tnHintExpanded += 1;
      continue;
    }
    const k = verseKey(p);
    const sortOrder = (tnCounters.get(k) ?? tnBases.get(k) ?? 0) + 100;
    tnCounters.set(k, sortOrder);
    await applyTnInsert(env, p, userId, sortOrder);
    result.tnCreated += 1;
  }

  for (const p of tqProposals) {
    const k = verseKey(p);
    const sortOrder = (tqCounters.get(k) ?? 0) + 100;
    tqCounters.set(k, sortOrder);
    const action = await applyTqUpsert(env, p, userId, sortOrder);
    if (action === "created") result.tqCreated += 1;
    else result.tqUpdated += 1;
  }

  for (const p of verseProposals) {
    await applyVerseUpdate(env, p, userId);
    result.verseUpdated += 1;
  }

  return result;
}

// Highest sort_order currently stored per (chapter, verse) in scope. Used to
// seed AI insert counters so new rows append after surviving rows in a verse.
// Run AFTER the TN delete phase so swept rows don't inflate the base.
async function maxSortOrderPerVerse(
  env: Env,
  table: "tn_rows" | "tq_rows",
  job: ImportContext,
): Promise<Map<number, number>> {
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, MAX(sort_order) AS mx FROM ${table}
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND deleted_at IS NULL
      GROUP BY chapter, verse`,
  )
    .bind(job.book, job.startChapter, job.endChapter)
    .all<{ chapter: number; verse: number; mx: number | null }>();
  const m = new Map<number, number>();
  for (const r of rs.results ?? []) {
    if (r.mx != null) m.set(r.chapter * 100000 + r.verse, r.mx);
  }
  return m;
}

async function deleteUnkeptTns(
  env: Env,
  job: ImportContext,
  userId: number,
): Promise<number> {
  // Identify which rows we're about to delete so the audit row can carry
  // the right pre-deletion version. A bulk UPDATE would lose that fidelity.
  // preserve=1 rows are translator-marked "keep through AI runs"; hint=1
  // rows are stubs queued for in-place expansion by the AI — both must
  // survive the sweep.
  const targets = await env.DB.prepare(
    `SELECT id, version FROM tn_rows
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3
        AND updated_by IS NULL AND deleted_at IS NULL
        AND preserve = 0 AND hint = 0`,
  )
    .bind(job.book, job.startChapter, job.endChapter)
    .all<{ id: string; version: number }>();
  const list = targets.results ?? [];
  if (list.length === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  const CHUNK = 25; // 2 statements per row + headroom
  let deleted = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const stmts = [];
    for (const t of slice) {
      stmts.push(
        env.DB
          .prepare(
            // Re-assert the pristine predicate at write time, not just in the
            // SELECT above: TN edits are allowed mid-pipeline (rows.ts), so a
            // translator content edit (sets updated_by + bumps version) or a
            // preserve/hint toggle that lands between the SELECT and this
            // UPDATE must ABORT the delete. Without these clauses the sweep
            // deletes a row the user just claimed. Composite-key scoped so a
            // colliding-id row in another book is never touched.
            `UPDATE tn_rows
               SET deleted_at = ?1, version = version + 1,
                   updated_at = ?1, updated_by = ?2
             WHERE id = ?3 AND book = ?4 AND deleted_at IS NULL
               AND updated_by IS NULL AND preserve = 0 AND hint = 0`,
          )
          .bind(now, userId, t.id, job.book),
        env.DB
          .prepare(
            // Audit only if the UPDATE above actually tombstoned this row in
            // THIS batch (D1 runs batch statements sequentially on one
            // connection, so this SELECT sees the prior UPDATE's effect). A
            // delete the pristine guard aborted writes no edit_log row.
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, source)
             SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'delete', ?6
              WHERE EXISTS (
                SELECT 1 FROM tn_rows
                 WHERE id = ?1 AND book = ?2
                   AND deleted_at = ?7 AND updated_by = ?3
              )`,
          )
          .bind(t.id, job.book, userId, t.version, t.version + 1, AI_SOURCE, now),
      );
    }
    const res = await env.DB.batch(stmts);
    // UPDATE results sit at even indices (update, audit, update, audit, ...).
    // Count only rows the guard actually deleted.
    for (let j = 0; j < res.length; j += 2) {
      deleted += res[j]?.meta?.changes ?? 0;
    }
  }
  return deleted;
}

// Per-revision source label for hint expansions. Distinct from AI_SOURCE so
// the row's AI chip (keyed on latest_source === 'ai_pipeline' in chapters.ts)
// stays off — standing authorship of a hinted note's existence is the human
// who created the stub, even though this specific revision was written by
// the AI. The history dialog can render this label however it likes.
const HINT_EXPANSION_SOURCE = "hint_expansion";

// Returns true if the proposal was applied as a hint expansion (UPDATE in
// place against an existing hint=1 stub), false if there's no match and the
// caller should fall through to applyTnInsert. Scoped to the job's chapter
// range so an id collision outside that range (vanishingly rare with 4-char
// random ids, but possible) doesn't accidentally clobber an unrelated row.
async function applyTnHintExpansionIfMatch(
  env: Env,
  p: PendingImportRow,
  job: ImportContext,
  userId: number,
): Promise<boolean> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" ? payload.id : null;
  if (!proposedId) return false;

  const stub = await env.DB.prepare(
    `SELECT id, version FROM tn_rows
      WHERE id = ?1 AND hint = 1 AND deleted_at IS NULL
        AND book = ?2 AND chapter BETWEEN ?3 AND ?4`,
  )
    .bind(proposedId, job.book, job.startChapter, job.endChapter)
    .first<{ id: string; version: number }>();
  if (!stub) return false;

  const now = Math.floor(Date.now() / 1000);
  const newVersion = stub.version + 1;
  const res = await env.DB.batch([
    env.DB
      .prepare(
        // Update content; clear hint so the row stops being queued for
        // future runs. Leave preserve and updated_by alone — the row's
        // standing authorship stays with whoever created the stub, and
        // any prior preserve intent survives the expansion.
        //
        // CAS-guarded: `hint = 1` and `version = ?` must STILL hold at write
        // time. TN edits are allowed mid-pipeline (rows.ts), so between the
        // SELECT above and here a translator may (a) un-queue the hint
        // (hint -> 0, which does NOT bump version — caught by `hint = 1`) or
        // (b) edit the stub's content (bumps version + sets updated_by —
        // caught by `version = stub.version`). Either way the expansion must
        // abort rather than clobber the user's change. NOTE: we deliberately
        // do NOT guard on `updated_by IS NULL` — a human-created hint stub
        // already carries the creator's id (createRow sets updated_by), so
        // that predicate would abort every legitimate expansion.
        // book-scoped so a colliding stub id in another book isn't clobbered.
        `UPDATE tn_rows
            SET quote = ?1,
                support_reference = ?2,
                note = ?3,
                occurrence = ?4,
                ref_raw = COALESCE(?5, ref_raw),
                tags = ?6,
                hint = 0,
                version = version + 1,
                updated_at = ?7
          WHERE id = ?8 AND book = ?9 AND deleted_at IS NULL
            AND hint = 1 AND version = ?10`,
      )
      .bind(
        (payload.quote as string | null | undefined) ?? null,
        (payload.support_reference as string | null | undefined) ?? null,
        (payload.note as string | null | undefined) ?? null,
        (payload.occurrence as number | null | undefined) ?? null,
        (payload.ref_raw as string | null | undefined) ?? null,
        (payload.tags as string | null | undefined) ?? null,
        now,
        stub.id,
        job.book,
        stub.version,
      ),
    env.DB
      .prepare(
        // Audit row, gated on the CAS having WON: the post-update fingerprint
        // (new version + hint cleared + our updated_at) is present only if the
        // UPDATE above actually fired. A lost CAS writes neither audit nor
        // accept. AI wrote this revision, but with the hint_expansion label so
        // the row-level AI chip stays off.
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?1 AND book = ?2
               AND version = ?5 AND hint = 0 AND updated_at = ?8
          )`,
      )
      .bind(
        stub.id,
        job.book,
        userId,
        stub.version,
        newVersion,
        JSON.stringify(payload),
        HINT_EXPANSION_SOURCE,
        now,
      ),
    env.DB
      .prepare(
        // Mark the proposal accepted only if the CAS won (same fingerprint).
        // On a lost CAS this stays unresolved and the caller falls through to
        // applyTnInsert below, materializing the AI note as a fresh row
        // instead of dropping it.
        `UPDATE pending_imports
            SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?3 AND book = ?4
               AND version = ?5 AND hint = 0 AND updated_at = ?6
          )`,
      )
      .bind(p.id, userId, stub.id, job.book, newVersion, now),
  ]);
  // CAS won iff the UPDATE changed a row. On a lost CAS return false so the
  // caller materializes the proposal via applyTnInsert (its proposed id now
  // PK-collides with the concurrently-edited stub, so it retries to a fresh
  // id) — the translator's edit survives and the AI note isn't lost.
  return (res[0]?.meta?.changes ?? 0) > 0;
}

async function applyTnInsert(
  env: Env,
  p: PendingImportRow,
  userId: number,
  sortOrder: number,
): Promise<void> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const insertCols = [
    "id",
    "book",
    "chapter",
    "verse",
    "ref_raw",
    "tags",
    "support_reference",
    "quote",
    "occurrence",
    "note",
    "updated_by",
    "sort_order",
  ];

  // PRESERVE bp-assistant's proposed id. It's the SAME id that lands on master,
  // so keeping it lets the nightly reimport recognize this row instead of
  // re-adding a divergent-id copy of the same note — the TN duplication bug
  // (each AI-generated note ending up doubled). Only mint a fresh id when the
  // proposed one is malformed (bp-assistant occasionally emits an id that fails
  // the 4-char [a-z][a-z0-9]{3} format — usually a first char that isn't [a-z])
  // or when it actually PK-collides; attempt 0 uses the proposed id, later
  // attempts mint. TQ already preserves its proposed id (insertTqAtId).
  const proposedId =
    typeof payload.id === "string" && isValidRowId(payload.id) ? payload.id : null;
  let id = "";
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    id = attempt === 0 && proposedId ? proposedId : newRowId();
    const values: unknown[] = [
      id,
      payload.book ?? null,
      payload.chapter ?? null,
      payload.verse ?? null,
      payload.ref_raw ?? null,
      payload.tags ?? null,
      payload.support_reference ?? null,
      payload.quote ?? null,
      payload.occurrence ?? null,
      payload.note ?? null,
      userId,
      sortOrder,
    ];
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO tn_rows (${insertCols.join(", ")})
             VALUES (${insertCols.map((_, i) => `?${i + 1}`).join(", ")})`,
          )
          .bind(...values),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             VALUES ('tn', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
          )
          .bind(id, p.book, userId, JSON.stringify(payload), AI_SOURCE),
        env.DB
          .prepare(
            `UPDATE pending_imports
                SET accepted_at = unixepoch(), accepted_by = ?2
              WHERE id = ?1`,
          )
          .bind(p.id, userId),
      ]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  if (lastErr) throw new Error(`tn id collision exhausted after 8 attempts`);
}

async function applyTqUpsert(
  env: Env,
  p: PendingImportRow,
  userId: number,
  sortOrder: number,
): Promise<"created" | "updated"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;

  if (proposedId) {
    // Try update first. Book-scoped to match the composite PK — a colliding
    // proposed id in another book is a "not found here", not a stale match.
    const existing = await env.DB.prepare(
      `SELECT version FROM tq_rows WHERE id = ?1 AND book = ?2 AND deleted_at IS NULL`,
    )
      .bind(proposedId, p.book)
      .first<{ version: number }>();
    if (existing) {
      const newVersion = existing.version + 1;
      const now = Math.floor(Date.now() / 1000);
      const patch = {
        ref_raw: payload.ref_raw ?? null,
        tags: payload.tags ?? null,
        quote: payload.quote ?? null,
        occurrence: payload.occurrence ?? null,
        question: payload.question ?? null,
        response: payload.response ?? null,
      };
      await env.DB.batch([
        env.DB
          .prepare(
            // sort_order is refreshed too: TQ has no preserve/keep semantics —
            // each run fully reorders the verse to match the incoming file.
            `UPDATE tq_rows
                SET ref_raw = ?1, tags = ?2, quote = ?3, occurrence = ?4,
                    question = ?5, response = ?6, sort_order = ?7,
                    version = version + 1, updated_at = ?8, updated_by = ?9
              WHERE id = ?10 AND book = ?11 AND deleted_at IS NULL`,
          )
          .bind(
            patch.ref_raw,
            patch.tags,
            patch.quote,
            patch.occurrence,
            patch.question,
            patch.response,
            sortOrder,
            now,
            userId,
            proposedId,
            p.book,
          ),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             VALUES ('tq', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7)`,
          )
          .bind(proposedId, p.book, userId, existing.version, newVersion, JSON.stringify(patch), AI_SOURCE),
        env.DB
          .prepare(
            `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
          )
          .bind(p.id, userId),
      ]);
      return "updated";
    }
  }

  // New row — proposedId either absent or not in tq_rows. Use it as the
  // sticky id when present (preserves AI-side correlation); otherwise mint
  // a fresh id with the same retry pattern as TN insert.
  if (proposedId) {
    await insertTqAtId(env, p, payload, proposedId, userId, sortOrder);
  } else {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const fresh = newRowId();
      try {
        await insertTqAtId(env, p, payload, fresh, userId, sortOrder);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
      }
    }
    if (lastErr) throw new Error(`tq id collision exhausted after 8 attempts`);
  }
  return "created";
}

async function insertTqAtId(
  env: Env,
  p: PendingImportRow,
  payload: Record<string, unknown>,
  id: string,
  userId: number,
  sortOrder: number,
): Promise<void> {
  const cols = ["id", "book", "chapter", "verse", "ref_raw", "tags", "quote", "occurrence", "question", "response", "updated_by", "sort_order"];
  const values = [
    id,
    payload.book ?? null,
    payload.chapter ?? null,
    payload.verse ?? null,
    payload.ref_raw ?? null,
    payload.tags ?? null,
    payload.quote ?? null,
    payload.occurrence ?? null,
    payload.question ?? null,
    payload.response ?? null,
    userId,
    sortOrder,
  ];
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO tq_rows (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`,
      )
      .bind(...values),
    env.DB
      .prepare(
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         VALUES ('tq', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
      )
      .bind(id, p.book, userId, JSON.stringify(payload), AI_SOURCE),
    env.DB
      .prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
      .bind(p.id, userId),
  ]);
}

async function applyVerseUpdate(
  env: Env,
  p: PendingImportRow,
  userId: number,
): Promise<void> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const book = String(payload.book ?? p.book);
  const chapter = Number(payload.chapter ?? p.chapter);
  const verse = Number(payload.verse ?? p.verse);
  const verseEndRaw = payload.verse_end;
  const verseEnd =
    typeof verseEndRaw === "number" && Number.isFinite(verseEndRaw) ? verseEndRaw : null;
  const bibleVersion = String(payload.bible_version ?? p.bible_version ?? "");
  let contentJson = String(payload.content_json ?? "");
  const plainText = (payload.plain_text as string | null) ?? null;
  const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;

  // Self-heal target `\w` occurrence numbering before the AI-applied alignment
  // lands in D1. The bot can emit colliding/`occurrences="1"` data; recomputing
  // from document position keeps note-highlight / colors / quote-builder correct
  // and the DCS export valid. No-op on clean output; source text left untouched.
  if (bibleVersion === "ULT" || bibleVersion === "UST") {
    try {
      const parsed = JSON.parse(contentJson) as { verseObjects?: unknown[] };
      if (Array.isArray(parsed?.verseObjects)) {
        // Drop AI-mangled orphan `\zaln-e` end-markers / bare "-e" junk before
        // recompute, so the cleaned tree lands in D1 (and exports clean). See
        // stripOrphanAlignmentMarkers — MIC 6:10 UST.
        parsed.verseObjects = stripOrphanAlignmentMarkers(parsed.verseObjects);
        recomputeTargetOccurrences(parsed.verseObjects);
        contentJson = JSON.stringify(parsed);
      }
    } catch {
      /* leave contentJson as-is if it isn't parseable JSON */
    }
  }

  // Heal AI-mangled U+FFFD in `\zaln-s` source attributes (the generator can emit
  // garbled multi-byte Hebrew, e.g. וּזְה❖❖בָם for "gold") before it lands in D1
  // — otherwise it shows as a broken aligner card and exports the garble to DCS.
  // Reconstruct from the parallel UHB/UGNT row; gated on the rare defect, and
  // structure-preserving so no word unaligns. See healReplacementChars.
  if ((bibleVersion === "ULT" || bibleVersion === "UST") && contentJson.includes("�")) {
    try {
      const parsed = JSON.parse(contentJson) as { verseObjects?: unknown[] };
      const srcVersion = NT_BOOKS.has(book) ? "UGNT" : "UHB";
      const src = await env.DB.prepare(
        `SELECT content_json FROM verses
          WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
      )
        .bind(book, chapter, verse, srcVersion)
        .first<{ content_json: string }>();
      const srcWords = src
        ? collectSourceWords((JSON.parse(src.content_json) as { verseObjects?: unknown[] }).verseObjects ?? [])
        : [];
      const report = healReplacementChars(parsed.verseObjects ?? [], srcWords);
      if (report.repaired.length > 0) contentJson = JSON.stringify(parsed);
      if (report.unrepaired.length > 0) {
        console.warn("pipeline apply: unrepaired U+FFFD in alignment source attrs", {
          book,
          chapter,
          verse,
          bibleVersion,
          unrepaired: report.unrepaired,
        });
      }
    } catch {
      /* leave contentJson as-is if anything is unparseable */
    }
  }

  const existing = await env.DB.prepare(
    `SELECT version FROM verses
      WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book, chapter, verse, bibleVersion)
    .first<{ version: number }>();

  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    const newVersion = existing.version + 1;
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE verses
              SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                  version = version + 1, updated_at = ?4, updated_by = ?5
            WHERE book = ?6 AND chapter = ?7 AND verse = ?8 AND bible_version = ?9`,
        )
        .bind(contentJson, plainText, verseEnd, now, userId, book, chapter, verse, bibleVersion),
      env.DB
        .prepare(
          `INSERT INTO edit_log
             (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
           VALUES ('verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7)`,
        )
        .bind(rowKey, book, userId, existing.version, newVersion, JSON.stringify({ plain_text: plainText }), AI_SOURCE),
      env.DB
        .prepare(
          `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
        )
        .bind(p.id, userId),
    ]);
    return;
  }

  // The verse should exist from the initial book import; this branch is the
  // defensive case where the seed missed something. Insert as a brand-new row.
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(book, chapter, verse, verseEnd, bibleVersion, contentJson, plainText, userId),
    env.DB
      .prepare(
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         VALUES ('verse', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
      )
      .bind(rowKey, book, userId, JSON.stringify({ plain_text: plainText }), AI_SOURCE),
    env.DB
      .prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
      .bind(p.id, userId),
  ]);
}

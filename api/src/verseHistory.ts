// Pure builder for ULT/UST verse version history. Mirrors the audit-replay in
// rows.ts, but verse edit_log payloads are FULL snapshots, not patches — each
// `kind='verse'` entry's payload carries the entire verse state (content and/or
// plain_text) as of its new_version, so there is no forward-merge to do. We map
// each log row to a version, prefer the content-bearing entry when several land
// on one version, and always anchor "current" with the LIVE row content.
//
// Restore coverage follows what was logged: manual edits + aligner saves store
// full alignment-bearing `content` (verses.ts PATCH); AI-apply / re-import store
// content too once they're enriched (see pipelineImport.ts / bookReimport.ts).
// An entry whose payload carries no parseable content is shown in the timeline
// but NOT restorable — its alignment was never recorded.
//
// Kept as a dependency-free leaf so it unit-tests like rowId.ts / tnDedup.ts.

export interface VerseHistoryLogRow {
  version: number | null; // edit_log.new_version
  action: string;
  source: string | null; // 'ai_pipeline' | 'dcs_reimport' | 'hint_expansion' | null
  created_at: number;
  payload_json: string | null;
  user_id: number | null;
  username: string | null;
  full_name: string | null;
}

export interface VerseCurrent {
  version: number;
  content: unknown; // parsed content_json of the live row (authoritative)
  plain_text: string | null;
  updated_at: number;
}

export interface VerseHistoryUser {
  id: number;
  username: string | null;
  full_name: string | null;
}

export interface VerseHistoryVersion {
  version: number;
  action: string;
  source: string | null;
  created_at: number;
  user: VerseHistoryUser | null;
  plain_text: string | null;
  // The full verse-objects tree at this version, or null when only plain_text
  // was logged (older AI / re-import entries). null ⇒ not restorable.
  content: unknown | null;
  restorable: boolean;
  current: boolean;
}

// Accept either an object (manual PATCH stores content as an object) or a JSON
// string (AI / re-import may store the raw content_json string to avoid a
// parse+restringify in the write path). Returns the object only if it looks
// like a real verse-objects wrapper; otherwise null (⇒ not restorable).
function normalizeContent(raw: unknown): unknown | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (
    obj &&
    typeof obj === "object" &&
    Array.isArray((obj as { verseObjects?: unknown }).verseObjects)
  ) {
    return obj;
  }
  return null;
}

// The verse content_json recorded in an edit_log payload, or null if
// absent/unparseable. Reuses normalizeContent so the two writer shapes
// (bookReimport/pipelineImport store payload.content as a JSON STRING;
// verses.ts PATCH stores it as an OBJECT via JSON.stringify(parsed.data),
// which also carries plain_text/alignment_intent alongside content) are
// absorbed identically here as they are for the version-history timeline.
// Used by the nightly sync's verseMerge ancestor recovery (bookReimport.ts) —
// see verseMerge.ts's header for why the ancestor comes from edit_log at all.
export function verseContentJsonFromPayload(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const content = normalizeContent(payload["content"]);
  return content != null ? JSON.stringify(content) : null;
}

export function buildVerseHistory(
  rows: VerseHistoryLogRow[],
  current: VerseCurrent,
): VerseHistoryVersion[] {
  const byVersion = new Map<number, VerseHistoryVersion>();
  for (const r of rows) {
    if (r.version == null) continue;
    // Ignore any "future" entry beyond the live version — version is monotonic,
    // so the current row's version is the max; anything higher is a phantom.
    if (r.version > current.version) continue;
    let payload: Record<string, unknown> = {};
    if (r.payload_json) {
      try {
        payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    const content = normalizeContent(payload["content"]);
    const plain_text =
      typeof payload["plain_text"] === "string"
        ? (payload["plain_text"] as string)
        : null;
    const mapped: VerseHistoryVersion = {
      version: r.version,
      action: r.action,
      source: r.source ?? null,
      created_at: r.created_at,
      user: r.user_id
        ? { id: r.user_id, username: r.username, full_name: r.full_name }
        : null,
      plain_text,
      content,
      restorable: content != null,
      current: false,
    };
    const existing = byVersion.get(r.version);
    if (!existing) {
      byVersion.set(r.version, mapped);
      continue;
    }
    // Two entries on one version (e.g. a pre-AI baseline + a plain-text-only AI
    // update both landing at the same number). Prefer the content-bearing one;
    // if both/neither carry content, prefer the later-created (newer audit).
    const sameContentState =
      (mapped.content != null) === (existing.content != null);
    const preferNew =
      (mapped.content != null && existing.content == null) ||
      (sameContentState && mapped.created_at >= existing.created_at);
    if (preferNew) byVersion.set(r.version, mapped);
  }

  // Anchor the current version with the LIVE row content — authoritative
  // regardless of how it was written, so pre-enrichment AI rows (whose log
  // carried only plain_text) are still restorable AS current. Keep real audit
  // metadata (action/source/user/time) when a log entry exists for it.
  const liveContent = normalizeContent(current.content);
  const cur = byVersion.get(current.version);
  byVersion.set(current.version, {
    version: current.version,
    action: cur?.action ?? "imported",
    source: cur?.source ?? null,
    created_at: cur?.created_at ?? current.updated_at,
    user: cur?.user ?? null,
    plain_text: current.plain_text,
    content: liveContent,
    restorable: liveContent != null,
    current: true,
  });

  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

// A verse-range job's range, as stored in pipeline_jobs.options_json (issue
// #1160). Every reader of a job's range goes through here: dispatch (top-level
// verseStart/verseEnd for the bot), the /start duplicate check, and the import
// (ImportContext.verseRange — without it the #1151 chapter-wide sweep would
// retire AI notes outside the range), and the edit lock (chapterLock.ts
// tnLockVerseRange, issue #1165).
//
// Fails CLOSED: `range: null` (a whole-chapter run) only when options_json is
// absent or is an object with no verseRange key. Unparseable JSON, a non-object,
// or a verseRange that is not 1 <= start <= end <= 200 is an error, because
// reading any of those as "whole chapter" is the direction that deletes notes.
export type StoredVerseRange =
  | { ok: true; range: { start: number; end: number } | null }
  | { ok: false; error: string };

export function storedVerseRange(optionsJson: string | null): StoredVerseRange {
  if (!optionsJson) return { ok: true, range: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return { ok: false, error: "verse_range_invalid: options_json is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "verse_range_invalid: options_json is not an object" };
  }
  if (!("verseRange" in parsed)) return { ok: true, range: null };
  const vr = (parsed as { verseRange: unknown }).verseRange as { start?: unknown; end?: unknown } | null;
  const start = vr && typeof vr === "object" && !Array.isArray(vr) ? vr.start : undefined;
  const end = vr && typeof vr === "object" && !Array.isArray(vr) ? vr.end : undefined;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 1 ||
    (end as number) < (start as number) ||
    (end as number) > 200
  ) {
    return { ok: false, error: `verse_range_invalid: ${JSON.stringify(vr)}` };
  }
  return { ok: true, range: { start: start as number, end: end as number } };
}

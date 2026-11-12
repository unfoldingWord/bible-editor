// Find/replace on a verse, as the Find/replace overlay saves it.
//
// Verse text saves store curly quotes (#1273), and find/replace follows the
// same rule (#1276): the engine's RESULT tree is curled, never the typed
// replacement string. Curling the tree only rewrites `.text`, so word counts
// and alignment are unchanged (see STATE.md, "Curl a verse's straight quotes
// on the engine's RESULT tree").
//
// Without this, a replacement with ' or " was stored straight, and a ’ → '
// replace was saved straight on the normal path but adopted as "no change"
// when the op was rebased after a 409 (verseRebase.ts curls both sides), so
// the outcome depended on timing.
//
// The curl runs once per verse save, after every replace step, never between
// steps: a step the curl undoes would look like "no change" and stop a
// replace all early, and curling between steps turns the verse's other
// straight quotes curly so a find for ' stops matching them.

import { smartReplaceVerse, type SmartReplaceResult } from "./replace.ts";
import { curlifyVerseContent } from "./curlyVerse.ts";
import { extractPlainText, isHeaderLabelNode } from "./usfm.ts";

// A find/replace result. `staleRefused`: the verse was left as it is because
// its stored plain text is out of step with its tree beside a header label and
// the match could not be placed in the tree's own text (#1339). The overlay
// says so instead of dropping the click silently.
export type FindReplaceResult = SmartReplaceResult & { staleRefused?: true };

// A stored plain text out of step with the verse's tree, in a verse that has a
// header label (#1339). Before #711 the extractor kept a `\sp` label's text
// inline, so such a row reads `said The man speaking the man` where the tree's
// own text reads `said the man`. The engine's position walk misses on it and
// its occurrence count runs, which could land on another word, in the label,
// or write the label's text into the body. Returns the tree's own plain text
// when the stored one is stale this way, otherwise null (main's path).
function staleBesideLabel(content: unknown, plainText: string): string | null {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(vos)) return null;
  const hasLabel = (nodes: unknown[]): boolean =>
    nodes.some((n) => isHeaderLabelNode(n) || (Array.isArray((n as { children?: unknown[] } | null)?.children) && hasLabel((n as { children: unknown[] }).children)));
  if (!hasLabel(vos)) return null;
  const fresh = extractPlainText(content);
  return plainText.replace(/\s+/g, " ").trim() === fresh ? null : fresh;
}

// Place a match of the stale stored text in the tree's own text, or null.
// Only by position, never by counting occurrences: the match must lie wholly
// in the text the two share at the start or at the end. When those two runs
// overlap (the label text repeats the text beside it), the overlapping part
// could belong to either side, so a match there is not placed. Then the regex
// must match the tree's text at exactly that spot with the same length, so a
// `\W+` or `\S+` run that touched the label text, and is longer once the label
// text is gone, is not placed either.
function placeInFresh(stale: string, fresh: string, regex: RegExp, start: number, len: number): number | null {
  if (len <= 0) return null;
  const n = Math.min(stale.length, fresh.length);
  let head = 0;
  while (head < n && stale[head] === fresh[head]) head++;
  let tail = 0;
  while (tail < n && stale[stale.length - 1 - tail] === fresh[fresh.length - 1 - tail]) tail++;
  const overlap = Math.max(0, head + tail - n);
  head -= overlap;
  tail -= overlap;
  let at: number;
  if (start + len <= head) at = start;
  else if (start >= stale.length - tail) at = start - stale.length + fresh.length;
  else return null;
  const m = freshMatches(fresh, regex).find((x) => x.index >= at);
  return m && m.index === at && m.length === len ? at : null;
}

// Every match of `regex` in `text`, as the overlay lists them.
function freshMatches(text: string, regex: RegExp): { index: number; length: number }[] {
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  const out: { index: number; length: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ index: m.index, length: m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

const staleRefusal = (content: unknown, plainText: string): FindReplaceResult => ({
  content,
  plainText,
  preservedAlignment: true,
  staleRefused: true,
});

// Turn the engine's result for `content` (the verse as saved, with its stored
// `plainText`) into what gets saved: the curled tree and its plain text. When
// there is nothing to save, the returned plainText equals `plainText`, which
// is the overlay's no-op check.
export function finalizeFindReplace(
  content: unknown,
  plainText: string,
  result: SmartReplaceResult,
): SmartReplaceResult {
  // The engine changed nothing (`toy` → `toy`): stay a no-op, even when the
  // verse holds a legacy straight quote the curl would otherwise rewrite.
  if (result.plainText === plainText) return result;
  // The same, judged on the tree's own plain text: beside a line marker with
  // no text node on either side, the engine's plainText reads `namethis`
  // while the stored one reads `name this`, so the check above missed a
  // same-text replace there and the curl queued a save of an unrelated quote
  // (#1311). Checked before the curl, so the curl can't make it a change.
  const contentPlain = extractPlainText(content);
  if (extractPlainText(result.content) === contentPlain) {
    return { ...result, content, plainText, preservedAlignment: true };
  }
  const curled = curlifyVerseContent(result.content);
  // The saved plain text is the tree's, as every other verse save stores it.
  // The engine's own plainText adds nothing at a line marker, so with no text
  // node either side of it (`name \q1 this`) it read `namethis` (#1305).
  const curledPlain = extractPlainText(curled);
  // No visible change: the curl undid the whole change (a ’ → ' replace), or
  // the engine's plain text differed from the stored one only at such a
  // marker (a same-text replace). Hand back the verse and the caller's own
  // plain text, so nothing is queued (no version bump).
  if (curledPlain === contentPlain) {
    return { ...result, content, plainText, preservedAlignment: true };
  }
  return { ...result, content: curled, plainText: curledPlain };
}

// Replace one match (the overlay's "replace" button).
export function findReplaceVerse(
  content: unknown,
  plainText: string,
  regex: RegExp,
  matchStartInPlain: number,
  matchLenInPlain: number,
  replaceText: string,
): FindReplaceResult {
  // A stale stored text beside a header label: run the engine on the tree's own
  // text at the placed match, or refuse (#1339). The stored text is still what
  // finalizeFindReplace compares against, so a no-op stays a no-op.
  const fresh = staleBesideLabel(content, plainText);
  if (fresh !== null) {
    const at = placeInFresh(plainText, fresh, regex, matchStartInPlain, matchLenInPlain);
    if (at === null) return staleRefusal(content, plainText);
    const result = smartReplaceVerse(content, fresh, regex, at, matchLenInPlain, replaceText, { findReplace: true });
    return finalizeFindReplace(content, plainText, result);
  }
  const result = smartReplaceVerse(content, plainText, regex, matchStartInPlain, matchLenInPlain, replaceText, { findReplace: true });
  return finalizeFindReplace(content, plainText, result);
}

// Replace-all within one verse: replace one occurrence at a time with the
// uncurled engine, re-scanning the current plain text (normalize() inside
// smartReplaceVerse can collapse whitespace and shift later match indices),
// then curl once. `maxIters` (the verse's original match count) stops a
// replacement that keeps matching the regex from looping forever.
// `preservedAlignment` is false when any step lost alignment.
export function replaceAllInVerse(
  content: unknown,
  plainText: string,
  regex: RegExp,
  maxIters: number,
  replaceText: string,
): FindReplaceResult {
  let curContent = content;
  let curPlain = plainText;
  // A stale stored text beside a header label (#1339): replace in the tree's
  // own text, but only when each of its matches is a match the stored text
  // shows at a placed position. Matches only the stored text has (in the
  // label's text) are not verse text and are left out. Any match that can't be
  // placed refuses the whole verse, so replace all never edits a match the
  // user wasn't shown. So does a verse left unchanged while the stored text
  // had matches that weren't placed (only in the label's text), or the
  // overlay would show nothing at all.
  const fresh = staleBesideLabel(content, plainText);
  let unplaced = false;
  if (fresh !== null) {
    const placedAt = freshMatches(plainText, regex).map((m) => placeInFresh(plainText, fresh, regex, m.index, m.length));
    const placed = new Set(placedAt);
    if (!freshMatches(fresh, regex).every((m) => placed.has(m.index))) return staleRefusal(content, plainText);
    unplaced = placedAt.includes(null);
    curPlain = fresh;
  }
  let preserved = true;
  // Where the next search starts. A step with no visible change is skipped
  // (not applied) and the search moves past its match, so a later match still
  // gets replaced; only applied steps count toward `maxIters`. Every pass
  // either applies a step or moves `from` forward, so the loop ends.
  let from = 0;
  const globalFlags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  for (let applied = 0; applied < maxIters; ) {
    const localRe = new RegExp(regex.source, globalFlags);
    localRe.lastIndex = from;
    const next = localRe.exec(curPlain);
    if (!next) break;
    const result = smartReplaceVerse(curContent, curPlain, regex, next.index, next[0].length, replaceText, { findReplace: true });
    // Re-scan the tree's own plain text, as the first step scanned the stored
    // one. The engine's plainText adds nothing at a line marker with no text
    // node beside it (`namethis` for `name \q1 this`), so the next step's
    // search matched across the line break (#1307).
    const nextPlain = extractPlainText(result.content);
    // No visible change: the engine changed nothing, or only the tree beside
    // such a marker (removing the space leaf before it, which the marker
    // still stands in for). Skip this match.
    if (result.plainText === curPlain || nextPlain === extractPlainText(curContent)) {
      from = next.index + Math.max(1, next[0].length);
      continue;
    }
    if (!result.preservedAlignment) preserved = false;
    curContent = result.content;
    curPlain = nextPlain;
    from = 0;
    applied++;
  }
  const out = finalizeFindReplace(content, plainText, {
    content: curContent,
    plainText: curPlain,
    preservedAlignment: preserved,
  });
  return unplaced && out.plainText === plainText ? staleRefusal(content, plainText) : out;
}

// The overlay's scripture summary line after a replace. Counts come from the
// save path, not the engine: `versesReplaced` is verses queued for save, and
// `alignmentRefused` is verses the save's alignment guard refused (it shows
// its own toast; nothing is saved), so a refused replace is never reported as
// replaced (#1285). With nothing replaced and a refusal, the line leads with
// the refusal instead of "replaced 0 verses". `staleRefused` is verses the
// engine left alone because their stored text is out of date beside a header
// label (#1339).
export interface BibleReplaceCounts {
  versesReplaced: number;
  alignmentLost: number;
  readOnlySkipped: number;
  alignmentRefused: number;
  staleRefused?: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function bibleReplaceSummaryText(s: BibleReplaceCounts): string {
  const parts: string[] = [];
  const staleRefused = s.staleRefused ?? 0;
  if (s.versesReplaced > 0 || (s.alignmentRefused === 0 && staleRefused === 0)) {
    parts.push(`replaced ${plural(s.versesReplaced, "verse", "verses")}`);
  }
  if (s.alignmentLost > 0) parts.push(`alignment milestones destroyed in ${s.alignmentLost}`);
  if (s.alignmentRefused > 0) {
    parts.push(
      `${plural(s.alignmentRefused, "verse", "verses")} not replaced: ${s.alignmentRefused === 1 ? "it" : "they"} would lose word alignment`,
    );
  }
  if (staleRefused > 0) {
    parts.push(
      `${plural(staleRefused, "verse", "verses")} not replaced: ${staleRefused === 1 ? "its" : "their"} saved search text is out of date, so the match could not be placed`,
    );
  }
  if (s.readOnlySkipped > 0) {
    parts.push(`${plural(s.readOnlySkipped, "match", "matches")} in UHB/UGNT skipped (read-only)`);
  }
  return parts.join(" — ");
}

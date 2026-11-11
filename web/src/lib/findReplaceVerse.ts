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
import { extractPlainText } from "./usfm.ts";

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
  const curled = curlifyVerseContent(result.content);
  // Nothing to curl: the engine's result, byte for byte.
  if (curled === result.content) return result;
  const curledPlain = extractPlainText(curled);
  // The curl undid the whole change (a ’ → ' replace): hand back the verse
  // and the caller's own plain text, so nothing is queued (no version bump).
  if (curledPlain === extractPlainText(content)) {
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
): SmartReplaceResult {
  const result = smartReplaceVerse(content, plainText, regex, matchStartInPlain, matchLenInPlain, replaceText);
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
): SmartReplaceResult {
  let curContent = content;
  let curPlain = plainText;
  let preserved = true;
  for (let i = 0; i < maxIters; i++) {
    const localRe = new RegExp(regex.source, regex.flags);
    const next = localRe.exec(curPlain);
    if (!next) break;
    const result = smartReplaceVerse(curContent, curPlain, regex, next.index, next[0].length, replaceText);
    if (result.plainText === curPlain) break;
    if (!result.preservedAlignment) preserved = false;
    curContent = result.content;
    curPlain = result.plainText;
  }
  return finalizeFindReplace(content, plainText, {
    content: curContent,
    plainText: curPlain,
    preservedAlignment: preserved,
  });
}

// The overlay's scripture summary line after a replace. Counts come from the
// save path, not the engine: `versesReplaced` is verses queued for save, and
// `alignmentRefused` is verses the save's alignment guard refused (it shows
// its own toast; nothing is saved), so a refused replace is never reported as
// replaced (#1285). With nothing replaced and a refusal, the line leads with
// the refusal instead of "replaced 0 verses".
export interface BibleReplaceCounts {
  versesReplaced: number;
  alignmentLost: number;
  readOnlySkipped: number;
  alignmentRefused: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function bibleReplaceSummaryText(s: BibleReplaceCounts): string {
  const parts: string[] = [];
  if (s.versesReplaced > 0 || s.alignmentRefused === 0) {
    parts.push(`replaced ${plural(s.versesReplaced, "verse", "verses")}`);
  }
  if (s.alignmentLost > 0) parts.push(`alignment milestones destroyed in ${s.alignmentLost}`);
  if (s.alignmentRefused > 0) {
    parts.push(`${plural(s.alignmentRefused, "verse", "verses")} not replaced: it would lose word alignment`);
  }
  if (s.readOnlySkipped > 0) {
    parts.push(`${plural(s.readOnlySkipped, "match", "matches")} in UHB/UGNT skipped (read-only)`);
  }
  return parts.join(" — ");
}

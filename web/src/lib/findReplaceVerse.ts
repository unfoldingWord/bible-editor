// One find/replace step on a verse, as the Find/replace overlay saves it.
//
// Verse text saves store curly quotes (#1273), and find/replace follows the
// same rule (#1276): the engine's RESULT tree is curled, never the typed
// replacement string. Curling the replacement first would turn an untouched
// aligned `baby's` the match touches into a changed word and drop its
// alignment (see STATE.md, "Curl a verse's straight quotes on the engine's
// RESULT tree"). Curling the tree only rewrites `.text`, so word counts and
// alignment are unchanged.
//
// Without this, a replacement with ' or " was stored straight, and a ’ → '
// replace was saved straight on the normal path but adopted as "no change"
// when the op was rebased after a 409 (verseRebase.ts curls both sides), so
// the outcome depended on timing.

import { smartReplaceVerse, type SmartReplaceResult } from "./replace.ts";
import { curlifyVerseContent } from "./curlyVerse.ts";
import { extractPlainText } from "./usfm.ts";

export function findReplaceVerse(
  content: unknown,
  plainText: string,
  regex: RegExp,
  matchStartInPlain: number,
  matchLenInPlain: number,
  replaceText: string,
): SmartReplaceResult {
  const result = smartReplaceVerse(content, plainText, regex, matchStartInPlain, matchLenInPlain, replaceText);
  // The engine changed nothing (`toy` → `toy`): stay a no-op, even when the
  // verse holds a legacy straight quote the curl would otherwise rewrite.
  if (result.plainText === plainText) return result;
  const curled = curlifyVerseContent(result.content);
  // Nothing to curl: today's result, byte for byte.
  if (curled === result.content) return result;
  const curledPlain = extractPlainText(curled);
  // The curl undid the whole change (a ’ → ' replace): hand back the verse
  // and the caller's own plain text, so the overlay's `plainText === text`
  // check sees no change and nothing is queued (no version bump).
  if (curledPlain === extractPlainText(content)) {
    return { ...result, content, plainText, preservedAlignment: true };
  }
  return { ...result, content: curled, plainText: curledPlain };
}

// Replace-all within one verse: replace one occurrence at a time, re-scanning
// the current plain text (normalize() inside smartReplaceVerse can collapse
// whitespace and shift later match indices). `maxIters` (the verse's original
// match count) stops a replacement that keeps matching the regex from looping
// forever. `preservedAlignment` is false when any step lost alignment.
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
    const result = findReplaceVerse(curContent, curPlain, regex, next.index, next[0].length, replaceText);
    if (result.plainText === curPlain) break;
    if (!result.preservedAlignment) preserved = false;
    curContent = result.content;
    curPlain = result.plainText;
  }
  return { content: curContent, plainText: curPlain, preservedAlignment: preserved };
}

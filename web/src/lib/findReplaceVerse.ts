// One find/replace step on a verse, as the Find/replace overlay saves it.

import { smartReplaceVerse, type SmartReplaceResult } from "./replace.ts";

export function findReplaceVerse(
  content: unknown,
  plainText: string,
  regex: RegExp,
  matchStartInPlain: number,
  matchLenInPlain: number,
  replaceText: string,
): SmartReplaceResult {
  return smartReplaceVerse(content, plainText, regex, matchStartInPlain, matchLenInPlain, replaceText);
}

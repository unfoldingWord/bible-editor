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
import { extractPlainText, isHeaderLabelNode, isSpeakerLabelNode } from "./usfm.ts";

// A find/replace result. `staleRefused`: the verse was left as it is because
// it has a header label and its stored plain text is out of step with its
// tree (#1339). The overlay says so instead of dropping the click silently.
// `labelRefusals`: how many matches the engine refused because the replace
// would move a `\sp` speaker label written as words (#1350; see
// withWordLabelsAsText); those matches are left as they are, and the overlay says so too.
// `labelShapeRefusals`: how many of those were refused because the verse's
// label has no line break after it (#1354), which the overlay words differently.
export type FindReplaceResult = SmartReplaceResult & { staleRefused?: true; labelRefusals?: number; labelShapeRefusals?: number };

// A verse with a header label whose stored plain text is not its tree's own
// (#1339). The server's extractor once kept a `\sp` label's text in the stored
// plain text while the editor's left it out, so such a row reads
// `said The man speaking the man` where the tree reads `said the man`. The
// overlay's matches come from the stored text, and the engine's position walk
// misses on it: its occurrence count then lands on another word, in the label,
// or writes the label's text into the body. Guessing where the match sits in
// the tree's text failed review twice (a pick in the label edited a body
// word), so such a verse is refused. A stale verse with no header label takes
// main's path unchanged.
function staleBesideLabel(content: unknown, plainText: string): boolean {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(vos)) return false;
  const hasLabel = (nodes: unknown[]): boolean =>
    nodes.some((n) => isHeaderLabelNode(n) || (Array.isArray((n as { children?: unknown[] } | null)?.children) && hasLabel((n as { children: unknown[] }).children)));
  if (!hasLabel(vos)) return false;
  return plainText.replace(/\s+/g, " ").trim() !== extractPlainText(content);
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
  // A stale stored text beside a header label: refuse, visibly (#1339).
  if (staleBesideLabel(content, plainText)) return staleRefusal(content, plainText);
  const result = smartReplaceVerse(content, plainText, regex, matchStartInPlain, matchLenInPlain, replaceText, { findReplace: true });
  const out: FindReplaceResult = finalizeFindReplace(content, plainText, result);
  return withLabelCounts(out, result.labelRefused ? 1 : 0, result.labelRefusedReason === "label-shape" ? 1 : 0);
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
  // A stale stored text beside a header label: refuse the verse (#1339).
  if (staleBesideLabel(content, plainText)) return staleRefusal(content, plainText);
  let curContent = content;
  let curPlain = plainText;
  let preserved = true;
  // Matches refused across a word label (#1350), counted in the current pass
  // only: an applied step rescans from 0 and meets them again.
  let labelRefusals = 0;
  // Of those, the ones refused because the verse's label has no line break
  // after it (label-shape, #1354): the summary gives them their own reason.
  let labelShapeRefusals = 0;
  // Where the next search starts. A step with no visible change is skipped
  // (not applied) and the search moves past its match, so a later match still
  // gets replaced; only applied steps count toward `maxIters`. Every pass
  // either applies a step or moves `from` forward, so the loop ends.
  let from = 0;
  const globalFlags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  let applied = 0;
  while (applied < maxIters) {
    const localRe = new RegExp(regex.source, globalFlags);
    localRe.lastIndex = from;
    const next = localRe.exec(curPlain);
    if (!next) break;
    const result = smartReplaceVerse(curContent, curPlain, regex, next.index, next[0].length, replaceText, { findReplace: true });
    // Refused across a word label (#1350): count it, leave it, move on.
    if (result.labelRefused) {
      labelRefusals++;
      if (result.labelRefusedReason === "label-shape") labelShapeRefusals++;
      from = next.index + Math.max(1, next[0].length);
      continue;
    }
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
    labelRefusals = 0;
    labelShapeRefusals = 0;
    applied++;
  }
  // The cap ended the loop right after an applied step, so the last pass never
  // met the refused matches again (a replacement that re-matches the pattern
  // uses up the cap): count them on the final tree, applying nothing.
  const vo = (curContent as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (applied >= maxIters && Array.isArray(vo) && vo.some(isSpeakerLabelNode)) {
    const countRe = new RegExp(regex.source, globalFlags);
    for (let m = countRe.exec(curPlain); m; m = countRe.exec(curPlain)) {
      const r = smartReplaceVerse(curContent, curPlain, regex, m.index, m[0].length, replaceText, { findReplace: true });
      if (r.labelRefused) labelRefusals++;
      if (r.labelRefusedReason === "label-shape") labelShapeRefusals++;
      if (m[0].length === 0) countRe.lastIndex++;
    }
  }
  const out: FindReplaceResult = finalizeFindReplace(content, plainText, {
    content: curContent,
    plainText: curPlain,
    preservedAlignment: preserved,
  });
  return withLabelCounts(out, labelRefusals, labelShapeRefusals);
}

const withLabelCounts = (out: FindReplaceResult, refusals: number, shape: number): FindReplaceResult =>
  refusals > 0 ? { ...out, labelRefusals: refusals, ...(shape > 0 ? { labelShapeRefusals: shape } : {}) } : out;

// The overlay's scripture summary line after a replace. Counts come from the
// save path, not the engine: `versesReplaced` is verses queued for save, and
// `alignmentRefused` is verses the save's alignment guard refused (it shows
// its own toast; nothing is saved), so a refused replace is never reported as
// replaced (#1285). With nothing replaced and a refusal, the line leads with
// the refusal instead of "replaced 0 verses". `staleRefused` is verses the
// engine left alone because their stored text is out of date beside a header
// label (#1339). `labelRefused` is MATCHES the engine left alone because the
// replace would move a `\sp` speaker label written as words (#1350);
// `labelShapeRefused` is how many of those were refused because the verse's
// label has no line break after it (#1354), which gets its own reason.
export interface BibleReplaceCounts {
  versesReplaced: number;
  alignmentLost: number;
  readOnlySkipped: number;
  alignmentRefused: number;
  staleRefused?: number;
  labelRefused?: number;
  labelShapeRefused?: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function bibleReplaceSummaryText(s: BibleReplaceCounts): string {
  const parts: string[] = [];
  const staleRefused = s.staleRefused ?? 0;
  const labelRefused = s.labelRefused ?? 0;
  if (s.versesReplaced > 0 || (s.alignmentRefused === 0 && staleRefused === 0 && labelRefused === 0)) {
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
      `${plural(staleRefused, "verse", "verses")} not replaced: ${staleRefused === 1 ? "its" : "their"} saved search text is out of date`,
    );
  }
  const labelShapeRefused = Math.min(s.labelShapeRefused ?? 0, labelRefused);
  const labelMoveRefused = labelRefused - labelShapeRefused;
  if (labelMoveRefused > 0) {
    parts.push(
      `${plural(labelMoveRefused, "match", "matches")} not replaced: ${labelMoveRefused === 1 ? "it" : "they"} would move a speaker label`,
    );
  }
  if (labelShapeRefused > 0) {
    parts.push(
      `${plural(labelShapeRefused, "match", "matches")} not replaced: ${labelShapeRefused === 1 ? "its verse has" : "their verse has"} a speaker label with no line break after it`,
    );
  }
  if (s.readOnlySkipped > 0) {
    parts.push(`${plural(s.readOnlySkipped, "match", "matches")} in UHB/UGNT skipped (read-only)`);
  }
  return parts.join(" — ");
}

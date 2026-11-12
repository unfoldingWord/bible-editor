// Client copy of api/src/twLinkShape.ts (web does not import from api/). Keep
// the two in step: the server refuses a save with a 400 when this check fails,
// and the Words link picker uses it to refuse the typed text before it gets
// that far (issue #1316).
//
// Door43's validate_twl_files.py: TWLINK_RE = ^rc://[^/]+/[^/]+/[^/]+/[^ \\]+$,
// a HARD error for any non-blank TWLink that fails it.
export const TW_LINK_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;

// True for a non-blank link Door43 would reject. Blank is not malformed: it is
// still saved, and lint flags it as "Empty TWLink".
export function isMalformedTwLink(link: string | null | undefined): boolean {
  if (link == null || link.trim() === "") return false;
  return !TW_LINK_RE.test(link);
}

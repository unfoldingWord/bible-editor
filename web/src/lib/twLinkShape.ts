// Client copy of api/src/twLinkShape.ts (web does not import from api/). Keep
// the two in step: the server refuses a save with a 400 when this check fails,
// and the Words link picker uses it to refuse the typed text before it gets
// that far (issue #1316). The api copy explains each rule in full.
//
// Door43's validate_twl_files.py line 44, kept identical:
// TWLINK_RE = ^rc://[^/]+/[^/]+/[^/]+/[^ \\]+$, a HARD error for any TWLink
// other than "" that fails it.
export const TW_LINK_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;

// The export rewrites these (newline -> literal backslash-n, TAB -> space), and
// the rewritten cell then fails TW_LINK_RE.
const TSV_REWRITTEN_RE = /[\r\n\t]/;

// True for a link Door43 would reject once exported. Only null/undefined and
// exactly "" are blank (still saved; lint flags "Empty TWLink"); whitespace-only
// is malformed, as in Door43.
export function isMalformedTwLink(link: string | null | undefined): boolean {
  if (link == null || link === "") return false;
  return TSV_REWRITTEN_RE.test(link) || !TW_LINK_RE.test(link);
}

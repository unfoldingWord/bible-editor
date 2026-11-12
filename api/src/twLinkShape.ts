// The shape Door43 requires of a TWL row's TWLink (issue #1316).
//
// Ported verbatim from unfoldingWord/en_twl `.gitea/workflows/validate_twl_files.py`
// line 44:
//   TWLINK_RE = re.compile(r"^rc://[^/]+/[^/]+/[^/]+/[^ \\]+$")
// checked with `fullmatch` on the raw (unstripped) cell. Its blank test is
// `if not twlink`, so only "" is blank (a warning); every other value, including
// whitespace-only, must match TWLINK_RE or it is a HARD error, and one bad link
// fails push validation and blocks the whole book's TWL export.
//
// Deliberately Door43's own rule, not the stricter
// `rc://*/tw/dict/bible/{kt|names|other}/<slug>` every live link happens to
// follow: anything stricter could refuse a link Door43 accepts. Whether the link
// names a real article is a separate question this does not ask — the picker
// allows links outside the tw catalog on purpose.
//
// TW_LINK_RE stays identical to Door43's line so the two can be compared by eye.
// Door43 validates the exported TSV cell, not our stored value, and the export's
// tsvCell (export.ts) rewrites a newline / carriage return as a literal
// backslash-n and a TAB as a space — both of which then fail TWLINK_RE
// (`[^ \\]` excludes the space and the backslash). isMalformedTwLink therefore
// rejects those characters itself rather than widening the shared regex.
//
// The web client keeps its own copy in web/src/lib/twLinkShape.ts (web does not
// import from api/). Change both together.
export const TW_LINK_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;

// Characters tsvCell rewrites on export (see above).
const TSV_REWRITTEN_RE = /[\r\n\t]/;

// True for a link Door43 would reject once exported. Only null/undefined and
// exactly "" are blank: those stay a lint "Empty TWLink" flag and are still
// accepted on save, as before #1316. Whitespace-only is malformed, as in Door43.
export function isMalformedTwLink(link: string | null | undefined): boolean {
  if (link == null || link === "") return false;
  return TSV_REWRITTEN_RE.test(link) || !TW_LINK_RE.test(link);
}

// One sentence a translator can act on, shared by the lint flag and the 400.
export const MALFORMED_TW_LINK_HINT =
  "A translationWords link must be a full rc:// link, for example rc://*/tw/dict/bible/kt/god. Pick the article from the list.";

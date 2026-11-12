// The shape Door43 requires of a TWL row's TWLink (issue #1316).
//
// Ported verbatim from unfoldingWord/en_twl `.gitea/workflows/validate_twl_files.py`:
//   TWLINK_RE = re.compile(r"^rc://[^/]+/[^/]+/[^/]+/[^ \\]+$")
// checked with `fullmatch` on the raw (unstripped) cell. A non-blank link that
// fails it is a HARD error there, unlike a blank one (a warning), so one bad link
// fails push validation and blocks the whole book's TWL export.
//
// Deliberately Door43's own rule, not the stricter
// `rc://*/tw/dict/bible/{kt|names|other}/<slug>` every live link happens to
// follow: anything stricter could refuse a link Door43 accepts. Whether the link
// names a real article is a separate question this does not ask — the picker
// allows links outside the tw catalog on purpose.
//
// The web client keeps its own copy in web/src/lib/twLinkShape.ts (web does not
// import from api/). Change both together.
export const TW_LINK_RE = /^rc:\/\/[^/]+\/[^/]+\/[^/]+\/[^ \\]+$/;

// True for a non-blank link Door43 would reject. Blank (null, "", whitespace
// only) is NOT malformed here: it stays a lint "Empty TWLink" flag and is still
// accepted on save, as before #1316.
export function isMalformedTwLink(link: string | null | undefined): boolean {
  if (link == null || link.trim() === "") return false;
  return !TW_LINK_RE.test(link);
}

// One sentence a translator can act on, shared by the lint flag and the 400.
export const MALFORMED_TW_LINK_HINT =
  "A translationWords link must be a full rc:// link, for example rc://*/tw/dict/bible/kt/god. Pick the article from the list.";

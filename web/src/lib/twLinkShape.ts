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

// Door43's _flag_straight_quotes is an error-severity check on any row holding
// a straight ' or " (issue #1327), though TW_LINK_RE accepts both.
export const STRAIGHT_QUOTE_RE = /['"]/;

// True for a link Door43 would reject once exported. Only null/undefined and
// exactly "" are blank (still saved; lint flags "Empty TWLink"); whitespace-only
// is malformed, as in Door43.
export function isMalformedTwLink(link: string | null | undefined): boolean {
  if (link == null || link === "") return false;
  return TSV_REWRITTEN_RE.test(link) || STRAIGHT_QUOTE_RE.test(link) || !TW_LINK_RE.test(link);
}

// Issue #1334: one sentence naming the fault when it is only blank space, a
// straight quote, or a line break / tab; null when the link is fine or its
// shape is wrong too. Must return the same sentence as the api copy (the
// test compares them), since the picker and the 400 name the same fault.
export function twLinkCharacterProblem(link: string | null | undefined): string | null {
  if (typeof link !== "string" || !isMalformedTwLink(link)) return null;
  if (link.trim() === "") {
    return "A translationWords link cannot be only blank space. Clear it, or pick the article from the list (a full link looks like rc://*/tw/dict/bible/kt/god).";
  }
  if (!TW_LINK_RE.test(link.replace(/['"\r\n\t]/g, ""))) return null;
  const quotes = ["'", '"'].filter((q) => link.includes(q));
  const faults: string[] = [];
  if (quotes.length > 0) faults.push(`a straight quote (${quotes.join(" and ")})`);
  if (TSV_REWRITTEN_RE.test(link)) faults.push("a line break or tab");
  return `A translationWords link cannot contain ${faults.join(" or ")}. Remove it${quotes.length > 0 ? ", or use a curly quote (’ “ ”) instead" : ""}.`;
}

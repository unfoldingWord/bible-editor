// glOccurrence for TWL suggestions (api/src/twlSuggest.ts). Kept out of the
// route file because that one imports hono, which a plain-node unit test cannot
// load.
//
// The number means what the client's run picker reads it as (`pickRun` in
// web/src/lib/twlResolve.ts): the Nth contiguous run of the span's words among
// the verse's words, in document order, overlapping runs included. Counting
// matched strings instead (the route did until #1436) drifts whenever the same
// word also sits inside another match: "Solomon's" is one match here but the
// tokens "Solomon" + "s" there, and "Yahweh of Armies" hides its "Yahweh".
// After either, the next bare word got a number one too low and resolved to
// the wrong Hebrew word.
//
// Words are folded the way `spanWords` folds them on the client (markers out,
// lowercase, every run of letters/digits is a word); keep the two in sync.
// The route reads plain_text while the client walks `\w` tokens. Measured on
// the docs/samples ULT (ZEC, OBA, 2CH 9:10-12) the two word lists differ in 4
// of 1,000+ verses, each a `\w` holding punctuation between letters
// ("twenty-fourth" is one token there, two words here). A `\w` written as
// one possessive token (`\w Jerusalem’s\w*`, seen in LAM UST, not in these
// ULT samples) or plain-text words that are not `\w` tokens (LAM UST's
// acrostic letters) would drift the same way.

const MARKER = /\\[a-z]+\d*\*?/gi;
const WORD = /[\p{L}\p{N}]+/gu;

function words(s: string): { word: string; at: number }[] {
  const masked = s.replace(MARKER, (m) => " ".repeat(m.length));
  return [...masked.matchAll(WORD)].map((m) => ({ word: m[0].toLowerCase(), at: m.index ?? 0 }));
}

/**
 * The glOccurrence of each match: 1 + the number of runs of the match's words
 * that start before it in `text`. `start` is the match's offset in `text`.
 */
export function glOccurrences(text: string, matches: { matchedText: string; start: number }[]): number[] {
  const verse = words(text);
  return matches.map((m) => {
    const want = words(m.matchedText).map((x) => x.word);
    if (want.length === 0) return 1;
    let before = 0;
    for (let i = 0; i + want.length <= verse.length && verse[i].at < m.start; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (verse[i + j].word !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) before++;
    }
    return before + 1;
  });
}

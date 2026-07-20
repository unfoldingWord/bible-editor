// Shared "does this English word correspond to this TW article headword" logic,
// factored out of twlMatcher.ts so both the TWL suggestion matcher
// (twlMatcher.ts) and TWL ordering code can share ONE definition. Source of
// truth; web/src/lib/twHeadword.ts is a VERBATIM MIRROR — keep both in sync.
//
// Ported (near-verbatim) from Rich Mahn's node-twl-generator, same lineage as
// twlMatcher.ts. See that file's header for the fuller pipeline context.

// Curated irregular forms, weighted to OT-prophet vocabulary (where most of the
// remaining TWL work is). The rule-based logic below only covers REGULAR
// morphology (s/es/ies plurals, -ed/-ing verbs); these are the irregular
// lexemes it can't derive. Each row groups every surface form of one lexeme, so
// the expansion is bidirectional — it fires whether the TW headword is the lemma
// or an inflection. A group only ever enters the trie when its lemma is an
// actual TW article headword, which bounds false matches to real terms (e.g.
// "found"/"left"/"bound" only over-match if "find"/"leave"/"bind" are headwords).
const IRREGULAR_GROUPS: string[][] = [
  // ── irregular plurals ──
  ["man", "men"],
  ["woman", "women"],
  ["child", "children"],
  ["foot", "feet"],
  ["tooth", "teeth"],
  ["ox", "oxen"],
  ["mouse", "mice"],
  ["life", "lives"],
  ["wife", "wives"],
  ["knife", "knives"],
  ["leaf", "leaves"],
  ["loaf", "loaves"],
  ["calf", "calves"],
  ["self", "selves"],
  ["sheaf", "sheaves"],
  ["person", "people"],
  ["brother", "brothers", "brethren"],
  ["cherub", "cherubs", "cherubim"],
  ["seraph", "seraphs", "seraphim"],
  // ── irregular verbs (lemma + irregular inflections; -ing/-s stay regular) ──
  ["go", "went", "gone"],
  ["come", "came"],
  ["give", "gave", "given"],
  ["take", "took", "taken"],
  ["see", "saw", "seen"],
  ["eat", "ate", "eaten"],
  ["speak", "spoke", "spoken"],
  ["fall", "fell", "fallen"],
  ["send", "sent"],
  ["bring", "brought"],
  ["seek", "sought"],
  ["teach", "taught"],
  ["think", "thought"],
  ["drink", "drank", "drunk"],
  ["swear", "swore", "sworn"],
  ["slay", "slew", "slain"],
  ["smite", "smote", "smitten"],
  ["stand", "stood"],
  ["know", "knew", "known"],
  ["grow", "grew", "grown"],
  ["throw", "threw", "thrown"],
  ["forsake", "forsook", "forsaken"],
  ["break", "broke", "broken"],
  ["choose", "chose", "chosen"],
  ["hold", "held"],
  ["hear", "heard"],
  ["make", "made"],
  ["say", "said"],
  ["lay", "laid"],
  ["rise", "rose", "risen"],
  ["write", "wrote", "written"],
  ["bear", "bore", "borne", "born"],
  ["tear", "tore", "torn"],
  ["draw", "drew", "drawn"],
  ["bind", "bound"],
  ["find", "found"],
  ["sit", "sat"],
  ["hide", "hid", "hidden"],
  ["arise", "arose", "arisen"],
  ["shake", "shook", "shaken"],
  ["weep", "wept"],
  ["keep", "kept"],
  ["leave", "left"],
  ["flee", "fled"],
  ["feed", "fed"],
  ["lead", "led"],
  ["build", "built"],
  ["tread", "trod", "trodden"],
];

// term (any form) → all forms of its lexeme, for O(1) bidirectional lookup.
const IRREGULAR_FORM_INDEX: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const group of IRREGULAR_GROUPS) {
    for (const form of group) index.set(form, group);
  }
  return index;
})();

/**
 * Generate morphological variants of a term. Ported from node-twl-generator
 * generateVariants (commented-out blocks dropped), extended with a curated
 * irregular-forms table and a -y verb fix (carry -> carried) the upstream
 * README flags as a known gap ("Better morphological variants").
 */
export function generateVariants(term: string, isName = false): string[] {
  const variants = new Set<string>([term]);

  const isNoun =
    ["horn", "mare", "steed", "horse", "doe", "deer", "father", "Father", "cross", "well"].includes(
      term,
    ) || isName;
  const doNotPluralize = ["doe"].includes(term);
  const doNotDepluralize = ["kids"].includes(term) || isName;

  // Pluralization — simple 's' removal (but not for words ending in 'ss').
  if (
    term.endsWith("s") &&
    term.length > 2 &&
    !term.endsWith("ss") &&
    !term.endsWith("es") &&
    !doNotDepluralize
  ) {
    variants.add(term.slice(0, -1)); // dogs -> dog (but not does -> doe)
  } else if (!doNotPluralize) {
    variants.add(term + "s"); // dog -> dogs
  }

  // 'es' endings — only for legitimate plural patterns.
  if (term.endsWith("es") && term.length > 4 && !doNotDepluralize) {
    const base = term.slice(0, -2);
    if (/[sxz]$|[cs]h$/.test(base)) {
      variants.add(base); // horses -> horse, churches -> church
    }
  } else if (term.endsWith("e") && !doNotPluralize) {
    variants.add(term + "s"); // horse -> horses
  } else if (/[sxz]$|[cs]h$/.test(term) && !doNotPluralize) {
    variants.add(term + "es"); // church -> churches
  }

  // 'ies' endings for words ending in 'y'.
  if (term.endsWith("ies") && term.length > 4 && !doNotDepluralize) {
    variants.add(term.slice(0, -3) + "y"); // cities -> city
  } else if (term.endsWith("y") && term.length > 2 && !/[aeiou]y$/.test(term) && !doNotPluralize) {
    variants.add(term.slice(0, -1) + "ies"); // city -> cities
  }

  if (!isNoun) {
    // Double-consonant handling for -ed/-ing.
    if (/[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghjklmnpqrstvwxyz]$/.test(term)) {
      variants.add(term + term.slice(-1) + "ed"); // stop -> stopped
      variants.add(term + term.slice(-1) + "ing"); // stop -> stopping
    }
    // -y verbs: consonant + 'y' -> -ied (the -ing form keeps the y).
    if (term.endsWith("y") && term.length > 2 && !/[aeiou]y$/.test(term)) {
      variants.add(term.slice(0, -1) + "ied"); // prophesy -> prophesied, carry -> carried
      variants.add(term + "ing"); // prophesy -> prophesying
    } else if (!term.endsWith("e")) {
      // Regular -ed/-ing addition.
      variants.add(term + "ed");
      variants.add(term + "ing");
    } else {
      variants.add(term.slice(0, -1) + "ed"); // love -> loved
      variants.add(term.slice(0, -1) + "ing"); // love -> loving
    }
  }

  // Curated irregular forms (bidirectional via the lexeme group). Applies to
  // nouns too — irregular plurals like man/men aren't derivable by the rules above.
  const irregular = IRREGULAR_FORM_INDEX.get(term.toLowerCase());
  if (irregular) for (const form of irregular) variants.add(form);

  // Title-case each lowercase-initial variant.
  for (const variant of Array.from(variants)) {
    if (variant.length > 0 && variant[0] === variant[0].toLowerCase() && /[a-z]/.test(variant[0])) {
      variants.add(variant[0].toUpperCase() + variant.slice(1));
    }
  }

  return Array.from(variants);
}

/**
 * Extract + normalize the term list from a TW article's markdown heading
 * (first line), replicating node-twl-generator zipProcessor's heading
 * parsing: split on commas, strip a trailing parenthetical, strip leading
 * articles/demonstratives/possessives, dedup (order preserved). CASE-PRESERVING
 * — capitalization is load-bearing for callers like buildTermMapFromArticles,
 * which key "God" (kt/god) and "god" (kt/falsegod) as distinct terms. De-dupe
 * is case-sensitive so both survive. Case-insensitive matching, where wanted,
 * is the job of matchesHeadword/isFunctionWord below, not this function.
 */
export function headwordTermsFromTitle(title: string | null | undefined): string[] {
  const prefixRegex = /^(?:(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their)\s+)+/i;

  const firstLine = (title ?? "").split("\n")[0];
  const rawTerms = firstLine
    .replace(/^#/, "")
    .trim()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of rawTerms) {
    let normalizedTerm = term.replace(/\s+\([^)]*\)$/, "").trim();
    let cleaned = normalizedTerm.trim();
    while (prefixRegex.test(cleaned)) cleaned = cleaned.replace(prefixRegex, "").trim();
    normalizedTerm = cleaned;
    if (!normalizedTerm) continue;

    if (seen.has(normalizedTerm)) continue;
    seen.add(normalizedTerm);
    result.push(normalizedTerm);
  }
  return result;
}

// Strip leading/trailing punctuation (but not intra-word apostrophes/hyphens)
// and normalize case/form for single-word matching.
function normalizeWord(word: string): string {
  return word
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * True when a single English `word` corresponds to any of `terms` (TW
 * headword terms, e.g. from `headwordTermsFromTitle`). Matches on exact
 * equality (after normalization) or via `generateVariants`. Case-insensitive:
 * both `word` and each `term`/variant are lowercased before comparing, since
 * `terms` may carry the case-preserved form from headwordTermsFromTitle. A
 * single word can't match a multi-word term.
 */
export function matchesHeadword(word: string, terms: string[], isName = false): boolean {
  const normalized = normalizeWord(word);
  if (!normalized) return false;

  for (const term of terms) {
    if (term.includes(" ")) continue; // multi-word terms can't match a single word
    if (normalized === term.toLowerCase()) return true;
    if (generateVariants(term, isName).some((v) => v.toLowerCase() === normalized)) return true;
  }
  return false;
}

// English conjunctions, prepositions, articles/determiners, pronouns, and
// auxiliary/copular verbs — the words a TWL link should not be ordered by when
// its span has a content word available (twlCanonicalOrder.ts tier 2).
//
// Pronouns and auxiliaries are here after an audit of all 953 en_tw articles
// (1941 headword terms): exactly five terms touch this list. "might"
// (other/mighty) is an EXACT headword, so tier 1 matches it before tier 2 can
// ever skip it — no exposure. Three multi-word terms improve by being skipped
// ("I am Yahweh" → Yahweh, "who talk with spirits" → talk, "be subject to" →
// subject). One regresses mildly: "will of God" (kt/willofgod, 17 rows) anchors
// on "God" rather than "will", because a multi-word term can't be matched by a
// lone word in tier 1. Accepted deliberately as the cheapest correct trade.
//
// Deliberately NOT included: lexical verbs that look auxiliary-ish ("make",
// "made", "let"). They carry meaning, and skipping them would step over the
// content word tier 2 exists to find.
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "nor",
  "for",
  "yet",
  "so",
  "of",
  "in",
  "on",
  "at",
  "to",
  "from",
  "with",
  "by",
  "as",
  "into",
  "unto",
  "upon",
  "over",
  "under",
  "through",
  "against",
  "between",
  "among",
  "before",
  "after",
  "about",
  "above",
  "below",
  "down",
  "up",
  "out",
  "off",
  "than",
  "that",
  "this",
  "these",
  "those",
  "there",
  "then",
  "when",
  "while",
  "because",
  "if",
  "though",
  "although",
  "since",
  "until",
  "till",
  "within",
  "without",
  "toward",
  "towards",
  "throughout",
  "concerning",
  "according",
  "behind",
  "beside",
  "beneath",
  "beyond",
  "during",
  "except",
  "per",
  "via",
  // pronouns
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "mine",
  "yours",
  "hers",
  "ours",
  "theirs",
  "myself",
  "yourself",
  "himself",
  "herself",
  "itself",
  "ourselves",
  "yourselves",
  "themselves",
  "who",
  "whom",
  "whose",
  "which",
  "what",
  // auxiliary / copular verbs
  "be",
  "am",
  "is",
  "are",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
]);

export function isFunctionWord(word: string): boolean {
  return FUNCTION_WORDS.has(normalizeWord(word));
}

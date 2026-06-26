// English-first TWL matcher — ported (near-verbatim) from Rich Mahn's
// node-twl-generator (src/utils/twl-matcher.js + the term-extraction half of
// src/utils/zipProcessor.js) so the Bible Editor can suggest Translation Word
// Links per verse without depending on the npm package (which is network- and
// JSZip-bound and oriented to Node/browser, not a Worker).
//
// Pipeline: build a case-insensitive prefix trie of TW article headwords +
// morphological variants, then scan a verse's ULT English left-to-right picking
// the longest / highest-priority match at each position. The original-language
// quote + occurrence are NOT computed here — the editor resolves the matched
// English span against the verse alignment in the browser (web/src/lib/twlResolve.ts),
// which is the in-app equivalent of the lib's tsv-quote-converters step.
//
// Keep this faithful to upstream: the behaviour (variant generation, brace /
// possessive handling, God/falsegod capitalization rule) is what makes the
// suggestions match what Rich's tool produces. twlMatcher.test.mjs locks the key
// behaviours so a future edit can't silently drift.

/** A trie node: single-char keys → child nodes, plus an optional `_terms` list. */
interface TrieNode {
  [char: string]: TrieNode | TermData[] | undefined;
  _terms?: TermData[];
}

interface TermData {
  term: string;
  articles: string[];
  matchedText: string;
  priority: number; // 0 = original term, 1 = generated variant
}

export interface VerseMatch {
  term: string;
  articles: string[];
  preferredArticle?: string;
  matchedText: string;
  /** Verse text with the matched span wrapped in [brackets] — handy for debugging. */
  context: string;
  priority: number;
}

// One TW article as needed to build the term map: the id is "<category>/<slug>"
// (e.g. "kt/god"), which is exactly node-twl-generator's article path. title is
// the raw first markdown heading (may list comma-separated synonyms).
export interface TwArticleLite {
  id: string;
  title: string;
}

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
function generateVariants(term: string, isName = false): string[] {
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

/** Case-insensitive prefix trie. Ported from node-twl-generator PrefixTrie. */
class PrefixTrie {
  root: TrieNode = {};

  insert(term: string, originalTerm: string, articles: string[], isOriginal = true): void {
    this._insertIntoTree(this.root, term.toLowerCase(), originalTerm, articles, isOriginal);
  }

  private _insertIntoTree(
    root: TrieNode,
    term: string,
    originalTerm: string,
    articles: string[],
    isOriginal: boolean,
  ): void {
    let node = root;
    for (const char of term) {
      if (!node[char]) node[char] = {} as TrieNode;
      node = node[char] as TrieNode;
    }
    if (!node._terms) node._terms = [];
    node._terms.push({
      term: originalTerm,
      articles,
      matchedText: term,
      priority: isOriginal ? 0 : 1,
    });
  }

  findMatches(text: string, startPos: number) {
    return this._findMatchesInTree(this.root, text.toLowerCase(), startPos, text);
  }

  private _findMatchesInTree(root: TrieNode, searchText: string, startPos: number, originalText: string) {
    const matches: Array<{
      term: string;
      articles: string[];
      matchedText: string;
      length: number;
      originalLength: number;
      priority: number;
    }> = [];
    let node = root;
    let currentPos = startPos;

    while (currentPos < searchText.length) {
      const char = searchText[currentPos];

      // Curly braces wrap "supplied" words in the ULT (e.g. "creature{s}").
      // Match through them transparently; re-include them when extracting below.
      if ((char === "{" || char === "}") && currentPos > startPos) {
        currentPos++;
        continue;
      }

      if (!node[char]) break;

      node = node[char] as TrieNode;
      currentPos++;

      if (node._terms) {
        const matchLength = currentPos - startPos;
        let originalMatchedText = originalText.substring(startPos, currentPos);

        // Extend backwards over a leading possessive apostrophe + word chars.
        let extendedStartPos = startPos;
        if (extendedStartPos > 0 && /['’]/.test(originalText[extendedStartPos - 1])) {
          let apostrophePos = extendedStartPos - 1;
          apostrophePos--;
          if (apostrophePos >= 0 && /[\w]/.test(originalText[apostrophePos])) {
            while (apostrophePos >= 0 && /[\w]/.test(originalText[apostrophePos])) apostrophePos--;
            extendedStartPos = apostrophePos + 1;
          }
        }

        // Extend forwards over a trailing possessive apostrophe (+ word chars).
        let extendedEndPos = currentPos;
        if (extendedEndPos < originalText.length && /['’]/.test(originalText[extendedEndPos])) {
          let apostrophePos = extendedEndPos;
          apostrophePos++;
          if (apostrophePos < originalText.length && /[\w]/.test(originalText[apostrophePos])) {
            while (apostrophePos < originalText.length && /[\w]/.test(originalText[apostrophePos]))
              apostrophePos++;
            extendedEndPos = apostrophePos;
          } else {
            extendedEndPos = apostrophePos;
          }
        }

        if (extendedStartPos < startPos || extendedEndPos > currentPos) {
          originalMatchedText = originalText.substring(extendedStartPos, extendedEndPos);
        }

        // Balance curly braces split across the match boundary.
        let open = 0;
        let close = 0;
        for (const ch of originalText.substring(extendedStartPos, extendedEndPos)) {
          if (ch === "{") open++;
          else if (ch === "}") close++;
        }
        while (open > close && extendedEndPos < originalText.length && originalText[extendedEndPos] === "}") {
          extendedEndPos++;
          close++;
        }
        while (close > open && extendedStartPos > 0 && originalText[extendedStartPos - 1] === "{") {
          extendedStartPos--;
          open++;
        }
        if (extendedStartPos < startPos || extendedEndPos > currentPos) {
          originalMatchedText = originalText.substring(extendedStartPos, extendedEndPos);
        }

        // Word-boundary check, skipping braces when locating the neighbour char.
        let beforePos = extendedStartPos - 1;
        while (beforePos >= 0 && (originalText[beforePos] === "{" || originalText[beforePos] === "}"))
          beforePos--;
        let afterPos = extendedEndPos;
        while (
          afterPos < originalText.length &&
          (originalText[afterPos] === "{" || originalText[afterPos] === "}")
        )
          afterPos++;

        const isStartBoundary =
          beforePos < 0 ||
          /[\s\p{P}]/u.test(originalText[beforePos]) ||
          !/[\w]/.test(originalText[beforePos]);
        const isEndBoundary =
          afterPos >= originalText.length ||
          /[\s\p{P}]/u.test(originalText[afterPos]) ||
          !/[\w]/.test(originalText[afterPos]);

        if (isStartBoundary && isEndBoundary) {
          for (const termData of node._terms) {
            matches.push({
              term: termData.term,
              articles: termData.articles,
              matchedText: originalMatchedText,
              length: originalMatchedText.length,
              originalLength: matchLength,
              priority: termData.priority,
            });
          }
        }
      }
    }

    // Longest first, then originals before variants.
    return matches.sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return 0;
    });
  }
}

/**
 * Build the term → [articleId] map from TW articles, replicating
 * node-twl-generator zipProcessor's heading parsing + normalization: split the
 * heading on commas, strip a trailing parenthetical, strip leading
 * articles/demonstratives/possessives. articleId is the "<category>/<slug>" path.
 */
export function buildTermMapFromArticles(articles: TwArticleLite[]): Record<string, string[]> {
  const termMap: Record<string, string[]> = {};
  const prefixRegex = /^(?:(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their)\s+)+/i;

  // Sort by id for deterministic article-array ordering (matches upstream's
  // entry-name sort), so disambiguation order is stable.
  const sorted = [...articles].sort((a, b) => a.id.localeCompare(b.id));

  for (const { id, title } of sorted) {
    const firstLine = (title ?? "").split("\n")[0];
    const terms = firstLine
      .replace(/^#/, "")
      .trim()
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    for (const term of terms) {
      let normalizedTerm = term.replace(/\s+\([^)]*\)$/, "").trim();
      let cleaned = normalizedTerm.trim();
      while (prefixRegex.test(cleaned)) cleaned = cleaned.replace(prefixRegex, "").trim();
      normalizedTerm = cleaned;
      if (!normalizedTerm) continue;

      if (!termMap[normalizedTerm]) termMap[normalizedTerm] = [];
      if (!termMap[normalizedTerm].includes(id)) termMap[normalizedTerm].push(id);
    }
  }

  for (const term in termMap) termMap[term].sort();
  return termMap;
}

/** Build a matching trie from a term → [articleId] map. */
export function buildTermTrie(twTerms: Record<string, string[]>): PrefixTrie {
  const trie = new PrefixTrie();
  for (const [originalTerm, articles] of Object.entries(twTerms)) {
    trie.insert(originalTerm, originalTerm, articles, true);
    // Variants for single-word terms only (avoids exponential explosion).
    if (!originalTerm.includes(" ")) {
      const isName = articles[0]?.startsWith("names/") || articles[1]?.startsWith("names/") || false;
      for (const variant of generateVariants(originalTerm, isName)) {
        if (variant !== originalTerm) trie.insert(variant, originalTerm, articles, false);
      }
    }
  }
  return trie;
}

/** Scan a verse's English text for TW matches. Ported from findMatches. */
export function scanVerseMatches(verseText: string, termTrie: PrefixTrie): VerseMatch[] {
  const matches: VerseMatch[] = [];
  let currentPos = 0;
  let processedText = "";

  const normalizedText = verseText
    .replace(/[–—―]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  while (currentPos < normalizedText.length) {
    // Skip leading whitespace/punctuation, but keep apostrophes (don't).
    while (
      currentPos < normalizedText.length &&
      /[\s\p{P}]/u.test(normalizedText[currentPos]) &&
      !/['’]/.test(normalizedText[currentPos])
    ) {
      processedText += normalizedText[currentPos];
      currentPos++;
    }
    if (currentPos >= normalizedText.length) break;

    const candidateMatches = termTrie.findMatches(normalizedText, currentPos);
    let bestMatch = candidateMatches[0] ?? null;

    if (bestMatch) {
      // Merge articles from all matches of the same length + priority.
      const allArticles = new Set<string>();
      for (const match of candidateMatches) {
        if (match.length === bestMatch.length && match.priority === bestMatch.priority) {
          match.articles.forEach((a) => allArticles.add(a));
        }
      }
      bestMatch.articles = Array.from(allArticles);

      // God / falsegod disambiguation by capitalization.
      let preferredArticle: string | undefined;
      if (bestMatch.matchedText.toLowerCase() === "god" && bestMatch.articles.length > 1) {
        const originalMatchedText = normalizedText.substring(currentPos, currentPos + bestMatch.length);
        const hasGod = bestMatch.articles.includes("kt/god");
        const hasFalseGod = bestMatch.articles.includes("kt/falsegod");
        if (hasGod && hasFalseGod) {
          preferredArticle =
            originalMatchedText === "God" || originalMatchedText.charAt(0) === "G"
              ? "kt/god"
              : "kt/falsegod";
        }
      }

      const matchedText = bestMatch.matchedText;
      const context =
        processedText + "[" + matchedText + "]" + normalizedText.substring(currentPos + bestMatch.length);
      matches.push({
        term: bestMatch.term,
        articles: bestMatch.articles,
        preferredArticle,
        matchedText,
        context,
        priority: bestMatch.priority,
      });

      // Advance past only the original match (not possessive/brace extension).
      const advanceBy = bestMatch.originalLength || bestMatch.length;
      processedText += normalizedText.substring(currentPos, currentPos + advanceBy);
      currentPos += advanceBy;
    } else {
      const nextWordBoundary = normalizedText.substring(currentPos).search(/[\s\p{P}]/u);
      const moveDistance = nextWordBoundary === -1 ? 1 : Math.max(1, nextWordBoundary);
      processedText += normalizedText.substring(currentPos, currentPos + moveDistance);
      currentPos += moveDistance;
    }
  }

  return matches;
}

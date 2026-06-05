// Plain-English decoder for the x-morph codes our USFM carries on every source
// word (UHB Hebrew/Aramaic + UGNT Greek). The lexicon tooltip otherwise shows
// only the *lemma's* general part of speech ("Noun Feminine") and discards the
// in-context morphology — which is where the interesting grammar lives. Most
// importantly for Hebrew, a word like ZEC 5:6 עֵינָם carries `He,Ncbsc:Sp3mp`,
// whose `:Sp3mp` morpheme is an attached pronominal suffix ("their") that has no
// other surface in the UI.
//
// The term tables and decode logic are ported from bibletags-ui-helper's
// hebrewMorph.js / greekMorph.js (MIT). Our USFM uses the identical morph
// format those decoders were written for: Hebrew/Aramaic split their morphemes
// on ':' after the `He,`/`Ar,` prefix; Greek is a fixed positional code after
// `Gr,` where the literal commas double as null-fillers for absent features.

export interface Morpheme {
  pos: string; // plain-English part of speech, e.g. "noun", "conjunction" ("" if unknown)
  features: string[]; // e.g. ["singular", "construct"] or ["aorist", "active"]
  kind: "prefix" | "main" | "suffix";
  pronoun?: string; // possessive/object gloss for a pronominal suffix, e.g. "their"
  raw: string; // original morpheme code, e.g. "Ncbsc"
}

export interface DecodedMorph {
  lang: "He" | "Ar" | "Gr" | string;
  morphemes: Morpheme[]; // in word order: prefixes, main word, then suffixes
  // Convenience: the attached pronominal suffix, if any (Hebrew/Aramaic only).
  pronounSuffix: { gloss: string; parse: string } | null;
}

// ── Hebrew / Aramaic term tables ────────────────────────────────────────────

const HE_POS: Record<string, string> = {
  A: "adjective", C: "conjunction", D: "adverb", N: "noun",
  P: "pronoun", R: "preposition", S: "suffix", T: "particle", V: "verb",
};
const PERSON: Record<string, string> = { 1: "1st person", 2: "2nd person", 3: "3rd person" };
const HE_GENDER: Record<string, string> = { m: "masculine", f: "feminine", b: "both genders", c: "common" };
const HE_NUMBER: Record<string, string> = { s: "singular", p: "plural", d: "dual" };
const HE_STATE: Record<string, string> = { a: "absolute", c: "construct", d: "determined" };
const ADJ_TYPE: Record<string, string> = { c: "cardinal number", o: "ordinal number" };
const NOUN_TYPE: Record<string, string> = { g: "gentilic", p: "proper name" };
const PRONOUN_TYPE: Record<string, string> = {
  d: "demonstrative", f: "indefinite", i: "interrogative", p: "personal", r: "relative",
};
const PREP_TYPE: Record<string, string> = { d: "definite article" };
const SUFFIX_TYPE: Record<string, string> = { d: "directional", h: "paragogic", n: "paragogic" };
const PARTICLE_TYPE: Record<string, string> = {
  a: "affirmation", d: "definite article", e: "exhortation", i: "interrogative",
  j: "interjection", m: "demonstrative", n: "negative", o: "direct object marker", r: "relative",
};
const ASPECT: Record<string, string> = {
  p: "perfect", q: "sequential perfect", i: "imperfect", w: "sequential imperfect",
  h: "cohortative", j: "jussive", v: "imperative", r: "participle",
  s: "passive participle", a: "infinitive absolute", c: "infinitive construct",
};
const STEM_HE: Record<string, string> = {
  q: "qal", N: "niphal", p: "piel", P: "pual", h: "hiphil", H: "hophal", t: "hithpael",
  o: "polel", O: "polal", r: "hithpolel", m: "poel", M: "poal", k: "palel", K: "pulal",
  Q: "qal passive", l: "pilpel", L: "polpal", f: "hithpalpel", D: "nithpael", j: "pealal",
  i: "pilel", u: "hothpaal", c: "tiphil", v: "hishtaphel", w: "nithpalel", y: "nithpoel", z: "hithpoel",
};
const STEM_AR: Record<string, string> = {
  q: "peal", Q: "peil", u: "hithpeel", N: "niphal", p: "pael", P: "ithpaal", M: "hithpaal",
  a: "aphel", h: "haphel", s: "saphel", e: "shaphel", H: "hophal", i: "ithpeel", t: "hishtaphel",
  v: "ishtaphel", w: "hithaphel", o: "polel", z: "ithpoel", r: "hithpolel", f: "hithpalpel",
  b: "hephal", c: "tiphel", m: "poel", l: "palpel", L: "ithpalpel", O: "ithpolel", G: "ittaphal",
};

const push = (out: string[], term: string | undefined) => { if (term) out.push(term); };
const pushGNS = (out: string[], l: string[]) => {
  push(out, HE_GENDER[l[0]]); push(out, HE_NUMBER[l[1]]); push(out, HE_STATE[l[2]]);
};
const pushPGN = (out: string[], l: string[]) => {
  push(out, PERSON[l[0]]); push(out, HE_GENDER[l[1]]); push(out, HE_NUMBER[l[2]]);
};

// Possessive ("their eye") when the suffix rides a noun/preposition; object
// ("saw them") when it rides a verb. The morph code alone can't tell us — the
// host part of speech does.
function pronounGloss(person: string, gender: string, number: string, object: boolean): string {
  if (person === "1") return number === "s" ? (object ? "me" : "my") : (object ? "us" : "our");
  if (person === "2") return object ? "you" : "your";
  // 3rd person
  if (number === "s") {
    if (gender === "m") return object ? "him" : "his";
    if (gender === "f") return object ? "her" : "her";
    return object ? "it" : "its";
  }
  return object ? "them" : "their";
}

function decodeHebrewMorpheme(lang: string, code: string, kind: Morpheme["kind"]): Morpheme {
  const l = code.split("");
  const pos = HE_POS[l[0]] || "";
  const features: string[] = [];
  let pronoun: string | undefined;

  switch (l[0]) {
    case "A":
      push(features, ADJ_TYPE[l[1]]); pushGNS(features, l.slice(2)); break;
    case "N":
      push(features, NOUN_TYPE[l[1]]); pushGNS(features, l.slice(2)); break;
    case "P":
      push(features, PRONOUN_TYPE[l[1]]); pushPGN(features, l.slice(2)); break;
    case "R":
      push(features, PREP_TYPE[l[1]]); break;
    case "T":
      push(features, PARTICLE_TYPE[l[1]]); break;
    case "S":
      push(features, SUFFIX_TYPE[l[1]]);
      if (l[1] === "p") pushPGN(features, l.slice(2, 5));
      break;
    case "V": {
      push(features, (lang === "Ar" ? STEM_AR : STEM_HE)[l[1]]);
      const aspect = l[2];
      push(features, ASPECT[aspect]);
      if (aspect === "r" || aspect === "s") pushGNS(features, l.slice(3));
      else if (aspect !== "a" && aspect !== "c") pushPGN(features, l.slice(3));
      break;
    }
    default:
      break;
  }

  return { pos, features, kind, raw: code, pronoun };
}

function decodeHebrew(lang: string, morph: string): DecodedMorph {
  const codes = morph.slice(3).split(":"); // drop "He,"/"Ar," then split morphemes
  // The main word is the last morpheme that isn't a suffix (mirrors bibletags'
  // getMainWordPartIndex). Earlier morphemes are prefixes (conjunction, article,
  // preposition); later ones are suffixes (pronominal, directional, paragogic).
  let mainIdx = codes.length - 1;
  for (let i = codes.length - 1; i >= 0; i--) {
    if (codes[i][0] !== "S") { mainIdx = i; break; }
  }

  const morphemes = codes.map((code, i) => {
    const kind: Morpheme["kind"] = i < mainIdx ? "prefix" : i === mainIdx ? "main" : "suffix";
    return decodeHebrewMorpheme(lang, code, kind);
  });

  let pronounSuffix: DecodedMorph["pronounSuffix"] = null;
  const hostIsVerb = morphemes[mainIdx]?.pos === "verb";
  for (let i = mainIdx + 1; i < codes.length; i++) {
    const l = codes[i].split("");
    if (l[0] === "S" && l[1] === "p") {
      const gloss = pronounGloss(l[2], l[3], l[4], hostIsVerb);
      const parse = [PERSON[l[2]], HE_GENDER[l[3]], HE_NUMBER[l[4]]].filter(Boolean).join(" ");
      morphemes[i].pronoun = gloss;
      pronounSuffix = { gloss, parse };
      break;
    }
  }

  return { lang, morphemes, pronounSuffix };
}

// ── Greek term tables ─────────────────────────────────────────────────────────

const GR_POS: Record<string, string> = {
  N: "noun", A: "adjective", NS: "adjective", NP: "adjective", E: "determiner",
  R: "pronoun", V: "verb", I: "interjection", P: "preposition", D: "adverb",
  PI: "adverb", C: "conjunction", T: "particle", TF: "foreign word",
};
const GR_POS_TYPE: Record<string, string> = {
  NS: "substantive", NP: "predicate", AA: "ascriptive", AR: "restrictive",
  EA: "article", ED: "demonstrative", EF: "differential", EP: "possessive",
  EQ: "quantifier", EN: "number", EO: "ordinal", ER: "relative", ET: "interrogative",
  RD: "demonstrative", RP: "personal", RE: "reflexive", RC: "reciprocal",
  RI: "indefinite", RR: "relative", RT: "interrogative", IE: "exclamation",
  ID: "directive", IR: "response", PI: "improper preposition", DO: "correlative",
  CC: "coordinating", CS: "subordinating", CO: "correlative",
};
// Positional categories of the code after the 2-char role: each character maps
// through its category in this fixed order; commas in the source land on
// undefined keys and drop out.
const GR_CATEGORIES: Record<string, string>[] = [
  { I: "indicative", M: "imperative", S: "subjunctive", O: "optative", N: "infinitive", P: "participle" }, // mood
  { P: "present", I: "imperfect", F: "future", A: "aorist", E: "perfect", L: "pluperfect" }, // tense
  { A: "active", M: "middle", P: "passive" }, // voice
  { 1: "1st person", 2: "2nd person", 3: "3rd person" }, // person
  { N: "nominative", G: "genitive", D: "dative", A: "accusative", V: "vocative" }, // case
  { M: "masculine", F: "feminine", N: "neuter" }, // gender
  { S: "singular", P: "plural" }, // number
  { C: "comparative", S: "superlative", D: "diminutive", I: "indeclinable" }, // other
];

function decodeGreek(morph: string): DecodedMorph {
  const body = morph.slice(3); // after "Gr,"
  const roleCode = body.slice(0, 2); // e.g. "AA", or "N," for single-char roles
  const pos = GR_POS[roleCode] ?? GR_POS[roleCode[0]] ?? "";
  const features: string[] = [];
  push(features, GR_POS_TYPE[roleCode]);
  const chars = body.slice(2).split("");
  GR_CATEGORIES.forEach((cat, i) => push(features, cat[chars[i]]));
  return { lang: "Gr", morphemes: [{ pos, features, kind: "main", raw: body }], pronounSuffix: null };
}

/**
 * Decode a raw x-morph string into a plain-English structure. Returns null for
 * empty/unrecognized input so callers can fall back silently.
 */
export function decodeMorph(morph: string | null | undefined): DecodedMorph | null {
  if (!morph) return null;
  const lang = morph.slice(0, 2);
  if (lang === "He" || lang === "Ar") return decodeHebrew(lang, morph);
  if (lang === "Gr") return decodeGreek(morph);
  return null;
}

/** Render one morpheme as "pos · feature · feature" (POS omitted if unknown). */
export function morphemeText(m: Morpheme): string {
  return [m.pos, ...m.features].filter(Boolean).join(" · ");
}

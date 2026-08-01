// Canonical list of valid translationAcademy support-reference links for
// translationNotes. Served by GET /api/catalogs as `supportReferences` and used
// to restrict the SupportReference picker in the notes UI (NoteCard).
//
// Full `rc://*/ta/man/translate/<id>` links — this is the format stored in
// tn_rows.support_reference and the tN TSV SupportReference column, and the only
// form the export lint (SUPPORT_REFERENCE_RE in lint.ts) accepts. The notes UI
// shortens these to the bare id for display via shortSupport(). Curated list
// (source: the uW TA translate manual); update TA_SUPPORT_REFERENCE_IDS below
// when the canonical set changes.
// Exported so `taSupportReferences.check.mjs` can assert every id still
// resolves to a real `translate/<id>/01.md` article in unfoldingWord/en_ta.
export const TA_SUPPORT_REFERENCE_IDS: string[] = [
  "figs-123person",
  "figs-abstractnouns",
  "figs-activepassive",
  "figs-apostrophe",
  "figs-aside",
  "figs-declarative",
  "figs-distinguish",
  "figs-doublenegatives",
  "figs-doublet",
  "figs-ellipsis",
  "figs-euphemism",
  "figs-events",
  "figs-exclamations",
  "figs-exclusive",
  "figs-explicit",
  "figs-explicitinfo",
  "figs-extrainfo",
  "figs-gendernotations",
  "figs-genericnoun",
  "figs-go",
  "figs-hendiadys",
  "figs-hyperbole",
  "figs-hypo",
  "figs-idiom",
  "figs-imperative",
  "figs-imperative3p",
  "figs-infostructure",
  "figs-irony",
  "figs-litany",
  "figs-litotes",
  "figs-merism",
  "figs-metaphor",
  "figs-metonymy",
  "figs-nominaladj",
  "figs-parables",
  "figs-parallelism",
  "figs-pastforfuture",
  "figs-personification",
  "figs-possession",
  "figs-quotations",
  "figs-quotemarks",
  "figs-quotesinquotes",
  "figs-rpronouns",
  "figs-rquestion",
  "figs-simile",
  "figs-synecdoche",
  "figs-youcrowd",
  "figs-youdual",
  "figs-youformal",
  "figs-yousingular",
  "grammar-collectivenouns",
  "grammar-connect-condition-contrary",
  "grammar-connect-condition-fact",
  "grammar-connect-condition-hypothetical",
  "grammar-connect-exceptions",
  "grammar-connect-logic-contrast",
  "grammar-connect-logic-goal",
  // NOTE: there is no `grammar-connect-logic-reason` article in en_ta — the
  // single article `grammar-connect-logic-result` ("Connect — Reason-and-Result
  // Relationship") covers BOTH sides of the relationship. The bad id used to
  // sit here and shipped to translators for selection; removed 2026-07-31.
  // `taSupportReferences.check.mjs` now fails if it (or any other dead id)
  // comes back.
  "grammar-connect-logic-result",
  "grammar-connect-time-background",
  "grammar-connect-time-sequential",
  "grammar-connect-time-simultaneous",
  "grammar-connect-words-phrases",
  "translate-bdistance",
  "translate-blessing",
  "translate-bmoney",
  "translate-bvolume",
  "translate-bweight",
  "translate-fraction",
  "translate-hebrewmonths",
  "translate-kinship",
  "translate-names",
  "translate-numbers",
  "translate-ordinal",
  "translate-symaction",
  "translate-textvariants",
  "translate-transliterate",
  "translate-unknown",
  "translate-versebridge",
  "writing-background",
  "writing-endofstory",
  "writing-newevent",
  "writing-oathformula",
  "writing-participants",
  "writing-poetry",
  "writing-pronouns",
  "writing-proverbs",
  "writing-quotations",
  "writing-symlanguage",
  "writing-politeness",
  "translate-tense",
  "figs-reduplication",
  "translate-alternativereadings",
  "writing-foreground",
  "translate-plural",
];

const TA_LINK_PREFIX = "rc://*/ta/man/translate/";

export const TA_SUPPORT_REFERENCES: string[] = TA_SUPPORT_REFERENCE_IDS.map(
  (id) => `${TA_LINK_PREFIX}${id}`,
);

-- Translation preferences & memory (design in docs/preferences-panel-design.md).
-- Two tables backing the GL team's governance panel:
--   translation_prefs  — singleton brief + standing instructions + register +
--                        assisted-mode flag (mirrors project_config's id=1 shape).
--   terminology        — concept-oriented termbase: preferred / admitted /
--                        deprecated / forbidden(+replacement) / do-not-translate,
--                        with a tW-article backlink (the key-term backbone).
-- Validated EXAMPLES need no table — they are tn_rows/tq_rows/article_units
-- WHERE translation_state='validated' (browsed read-only via the examples route).
--
-- All values NULL/absent for the English root project, so the English authoring
-- workflow is untouched; the panel only renders when isTranslationProject(cfg).

-- Singleton (one project = one D1 = one brief), version column for If-Match CAS.
CREATE TABLE translation_prefs (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  audience TEXT,                       -- who this translation is for
  purpose TEXT,                        -- why (inform / instruct / comply)
  register TEXT NOT NULL DEFAULT 'default',  -- closed enum: default | formal | informal
  script_notes TEXT,                   -- script / orthography / RTL notes
  instructions_md TEXT,                -- standing guidance injected into every AI draft
  notes TEXT,                          -- catch-all markdown
  assisted_mode INTEGER NOT NULL DEFAULT 0,  -- 1 → send translate.contextRef (assisted); 0 → raw baseline
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER REFERENCES users(id)
);

-- Concept-oriented termbase. Many rows can share concept_id (one concept, N
-- valid renderings — TBX / Paratext multi-rendering model). status is a closed
-- picklist; a 'forbidden' row carries `replacement` (the use-instead pointer).
CREATE TABLE terminology (
  id INTEGER PRIMARY KEY,
  concept_id TEXT NOT NULL,            -- groups renderings of one concept
  source_term TEXT NOT NULL,           -- the source-language lemma
  target_term TEXT,                    -- the GL rendering (NULL for a pure DNT/forbidden marker)
  status TEXT NOT NULL DEFAULT 'preferred',  -- preferred|admitted|deprecated|forbidden|do_not_translate
  replacement TEXT,                    -- for status='forbidden': what to use instead
  comment TEXT,                        -- rendering rationale (Paratext-style, ignored by matching)
  tw_link TEXT,                        -- rc:// link to the tW article (key-term backbone)
  source_status TEXT NOT NULL DEFAULT 'manual',  -- provenance: manual | imported | candidate_approved
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER REFERENCES users(id),
  deleted_at INTEGER
);
CREATE INDEX terminology_concept ON terminology(concept_id) WHERE deleted_at IS NULL;
CREATE INDEX terminology_status ON terminology(status) WHERE deleted_at IS NULL;
CREATE INDEX terminology_source ON terminology(source_term) WHERE deleted_at IS NULL;

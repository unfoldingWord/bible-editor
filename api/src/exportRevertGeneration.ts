export const CLAIM_EXPORT_REVERT_GENERATION_SQL = `INSERT INTO export_revert_generations
    (book, resource, generation, observed_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (book, resource) DO UPDATE SET
    generation = excluded.generation,
    observed_at = excluded.observed_at,
    updated_at = unixepoch()
  WHERE export_revert_generations.observed_at < excluded.observed_at
     OR (export_revert_generations.observed_at = excluded.observed_at
         AND export_revert_generations.generation <= excluded.generation)`;

export const DELETE_EXPORT_REVERTS_FOR_GENERATION_SQL = `DELETE FROM export_reverts
  WHERE book = ?1 AND resource = ?2
    AND EXISTS (SELECT 1 FROM export_revert_generations
                 WHERE book = ?1 AND resource = ?2 AND generation = ?3 AND observed_at = ?4)`;

export const INSERT_EXPORT_REVERT_FOR_GENERATION_SQL = `INSERT OR REPLACE INTO export_reverts
    (book, resource, ref, class, fields)
  SELECT ?1, ?2, ?3, ?4, ?5
   WHERE EXISTS (SELECT 1 FROM export_revert_generations
                  WHERE book = ?1 AND resource = ?2 AND generation = ?6 AND observed_at = ?7)`;

export const SELECT_EXPORT_REVERT_GENERATION_SQL = `SELECT 1 AS ok FROM export_revert_generations
  WHERE book = ?1 AND resource = ?2 AND generation = ?3 AND observed_at = ?4`;

export const RESOLVE_EXPORT_REVERT_PERSISTENCE_FOR_GENERATION_SQL = `UPDATE system_alerts
  SET resolved_at = unixepoch()
  WHERE username = ?1 AND source = ?2 AND kind = 'review' AND resolved_at IS NULL
    AND (condition_observed_at IS NULL OR condition_observed_at <= ?3)
    AND EXISTS (SELECT 1 FROM export_revert_generations
                 WHERE book = ?4 AND resource = ?5 AND generation = ?6 AND observed_at = ?3)`;

export const INSERT_EXPORT_RECORD_FOR_GENERATION_SQL = `INSERT OR IGNORE INTO system_alerts
    (username, severity, source, message, link_url, kind, event_key)
  SELECT ?1, ?2, ?3, ?4, ?5, 'record', ?6
   WHERE EXISTS (SELECT 1 FROM export_revert_generations
                  WHERE book = ?7 AND resource = ?8 AND generation = ?9 AND observed_at = ?10)`;

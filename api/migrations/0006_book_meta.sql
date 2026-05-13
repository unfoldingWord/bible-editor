-- USFM headers (the marker lines that sit above \c 1 in every book —
-- \id, \h, \toc1/2/3, \mt1, etc.). The importer drops these into here so the
-- nightly export can rebuild a USFM string that round-trips against the
-- original. Stored as the usfm-js headers array JSON.
--
-- Books imported before this migration won't have rows here; the exporter
-- synthesizes a minimal header set in that case so the output still parses.
CREATE TABLE book_usfm_meta (
  book TEXT NOT NULL,
  bible_version TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  PRIMARY KEY (book, bible_version)
);
